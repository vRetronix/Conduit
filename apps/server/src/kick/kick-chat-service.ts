/**
 * Kick live chat: receiving the main channel's messages (official webhooks) and sending messages as the chatbot
 * account (official POST /chat). One instance owns the single chat subscription and the webhook receiver, so
 * reconnects can never stack subscriptions or listeners.
 *
 * Receiving (docs.kick.com/events): Kick delivers `chat.message.sent` (v1) only by webhook to the public URL set in
 * the user's Kick app. CONDUIT subscribes with the main account's token (events:subscribe), runs a signature-checking
 * receiver on loopback, and the user exposes only that receiver through a tunnel. "Connected" means Kick confirmed the
 * subscription and the receiver is open; `delivery` becomes 'confirmed' when the first signed message arrives.
 *
 * Sending (docs.kick.com/apis/chat): as the selected chatbot account (bot account, or the main account), type 'user',
 * to the main account's channel, with chat:write. Never retried automatically (it could post twice), except after a
 * 401, which means Kick rejected the token and posted nothing.
 *
 * Messages are kept in memory only (the last few, for the status view) and handed to subscribers (future commands).
 */
import { connectionsRepo, type ConnectionRecord, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  sendKickChatSchema,
  type KickChatMessageView,
  type KickChatReceiveStatus,
  type KickChatState,
  type KickSendResult,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import {
  BAN_EVENT,
  CHAT_EVENT,
  KickApiError,
  REDEMPTION_EVENT,
  type KickChannelInfo,
  type KickChatApi,
  type KickRedemption,
  type KickRewardInput,
} from './kick-chat-api';
import type { KickCredentials } from './kick-credentials';
import { KICK_WEBHOOK_PATH, KickWebhookServer, type KickWebhookEvent } from './kick-webhook-server';
import { parseInput } from '../validation';
import type { ConnectionService } from '../app/connection-service';

const RECENT_LIMIT = 25;
const RETRY_DELAYS_S = [30, 120, 600];
/** Re-check the subscription this often while connected (Kick may drop it, or the user may revoke access). */
const RECHECK_MS = 15 * 60_000;
/** Kick documents no chat rate limit; space out manual sends so a double click can't post twice. */
const MIN_SEND_INTERVAL_MS = 2000;

/** The outcome of a send, for callers that must not throw (e.g. command replies from the chat handler). */
export type KickSendOutcome =
  | { ok: true; result: KickSendResult }
  | { ok: false; outcome: 'failed' | 'unconfirmed'; message: string; locallyThrottled: boolean };

/** Errors after which Kick may or may not have posted the message (network failure, 5xx while sending). */
const unconfirmedErrors = new WeakSet<AppError>();

export interface KickChatMessage extends KickChatMessageView {
  broadcasterUserId: string;
  /** Kick badge types from the verified event (e.g. "moderator", "subscriber"); used for command permissions. */
  badgeTypes: string[];
  /** Subscriber months from the sender's subscriber badge (its count), when they have one. */
  subscriberMonths: number | null;
  repliesTo: { messageId: string; content: string; senderUsername: string } | null;
  emotes: Array<{ emoteId: string; positions: Array<{ s: number; e: number }> }>;
}

export interface KickChatServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  connections: ConnectionService;
  credentials: KickCredentials;
  api: KickChatApi;
  webhookPort: number;
}

export class KickChatService {
  private readonly server: KickWebhookServer;
  private status: KickChatReceiveStatus = 'disconnected';
  private problem: string | null = null;
  private subscriptionId: string | null = null;
  private delivery: 'unconfirmed' | 'confirmed' = 'unconfirmed';
  private lastEventAt: string | null = null;
  private received = 0;
  private rejected = 0;
  private readonly recent: KickChatMessage[] = [];
  private readonly listeners = new Set<(m: KickChatMessage) => void>();
  private readonly redemptionListeners = new Set<(r: KickRedemptionEvent) => void>();
  /** Why reward redemption events aren't subscribed, if they aren't (chat keeps working either way). */
  private redemptionProblem: string | null = null;
  private redemptionSubscriptionId: string | null = null;
  private readonly banListeners = new Set<(b: KickBanEvent) => void>();
  private banProblem: string | null = 'Not subscribed yet.';
  private banSubscriptionId: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private nextRetryAt: number | null = null;
  private retries = 0;
  private lastSendAt = 0;
  /** Text this service posted recently (for loop protection when the chatbot is the main account itself). */
  private readonly recentlySentText = new Map<string, number>();
  private closed = false;
  /** Nothing touches Kick's subscription API before start() (backend start-up). */
  private started = false;

  constructor(private readonly o: KickChatServiceOptions) {
    this.server = new KickWebhookServer({
      port: o.webhookPort,
      logger: o.logger.child({ module: 'kick-webhook' }),
      fetchPublicKey: () => o.api.publicKey(),
      onEvent: (e) => this.handleEvent(e),
      onRejected: () => {
        this.rejected++;
      },
    });
    // Subscribe as soon as the main account is (re)authorized; clean up before it is disconnected.
    o.connections.onAfterConnect((record) => {
      if (record.platform === 'kick' && record.role === 'primary') void this.ensure();
    });
    o.connections.onBeforeDisconnect((record, token) => this.beforeDisconnect(record, token));
  }

  /** Future features (commands) receive each new chat message here. Returns an unsubscribe function. */
  onMessage(listener: (m: KickChatMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Verified moderation.banned events (bans and timeouts) for the main channel. Returns an unsubscribe function. */
  onBan(listener: (b: KickBanEvent) => void): () => void {
    this.banListeners.add(listener);
    return () => this.banListeners.delete(listener);
  }

  /** Whether bans and timeouts done on Kick reach CONDUIT, and why not. */
  banEvents(): { ok: boolean; problem: string | null } {
    return { ok: this.banSubscriptionId !== null, problem: this.banSubscriptionId ? null : this.banProblem };
  }

  /** Verified channel.reward.redemption.updated events for the main channel. Returns an unsubscribe function. */
  onRedemption(listener: (r: KickRedemptionEvent) => void): () => void {
    this.redemptionListeners.add(listener);
    return () => this.redemptionListeners.delete(listener);
  }

  // ── channel rewards (main account, channel:rewards:write) ──────────────────

  /** Whether CONDUIT can manage Channel Points rewards on the main channel now, and why not. */
  rewardsAccess(): { ok: boolean; problem: string | null } {
    const primary = this.primaryRecord();
    if (!primary) return { ok: false, problem: 'Connect your main Kick account first.' };
    if (!scopesOf(primary).includes('channel:rewards:write'))
      return {
        ok: false,
        problem: 'Kick Channel Points need the "channel:rewards:write" permission. Select Reauthorize main account (Dashboard → Kick → Manage).',
      };
    return { ok: true, problem: this.redemptionProblem };
  }

  createReward(reward: KickRewardInput): Promise<string> {
    return this.withPrimaryToken((t) => this.o.api.createReward(t, reward));
  }

  updateReward(rewardId: string, patch: Partial<KickRewardInput>): Promise<void> {
    return this.withPrimaryToken((t) => this.o.api.updateReward(t, rewardId, patch));
  }

  deleteReward(rewardId: string): Promise<void> {
    return this.withPrimaryToken((t) => this.o.api.deleteReward(t, rewardId));
  }

  rewardRedemptions(rewardId: string, status: 'pending' | 'accepted' | 'rejected' = 'pending'): Promise<KickRedemption[]> {
    return this.withPrimaryToken((t) => this.o.api.redemptions(t, rewardId, status));
  }

  decideRedemptions(decision: 'accept' | 'reject', ids: string[]): Promise<Array<{ id: string; reason: string }>> {
    return this.withPrimaryToken((t) => this.o.api.decideRedemptions(t, decision, ids));
  }

  // ── moderation (main account = channel owner; moderation:ban, moderation:chat_message:manage) ──

  /** The main account, as moderation acts with it: its user id (= the channel's broadcaster id), name and scopes. */
  moderator(): { userId: string; name: string; channel: string; scopes: string[] } | null {
    const primary = this.primaryRecord();
    if (!primary) return null;
    return {
      userId: primary.externalAccountId,
      name: primary.accountName,
      channel: primary.accountHandle ?? primary.accountName,
      scopes: scopesOf(primary),
    };
  }

  /** Bans (durationMinutes null) or times out a user in the main channel. */
  moderationBan(userId: string, durationMinutes: number | null, reason: string | null): Promise<void> {
    return this.withPrimaryToken(async (t) => {
      const me = this.moderator();
      if (!me) throw new KickApiError('unauthorized', 'The main Kick account is not connected');
      await this.o.api.ban(t, me.userId, userId, durationMinutes, reason);
    });
  }

  moderationUnban(userId: string): Promise<void> {
    return this.withPrimaryToken(async (t) => {
      const me = this.moderator();
      if (!me) throw new KickApiError('unauthorized', 'The main Kick account is not connected');
      await this.o.api.unban(t, me.userId, userId);
    });
  }

  moderationDeleteMessage(messageId: string): Promise<void> {
    return this.withPrimaryToken((t) => this.o.api.deleteChatMessage(t, messageId));
  }

  channelBySlug(slug: string): Promise<{ broadcasterUserId: string; slug: string } | null> {
    return this.withPrimaryToken((t) => this.o.api.channelBySlug(t, slug));
  }

  /** A channel's public info by slug (title, category, live), for !so. */
  async channelInfo(slug: string): Promise<KickChannelInfo | null> {
    return (await this.withPrimaryToken((t) => this.o.api.channelsBySlugs(t, [slug])))[0] ?? null;
  }

  /** Changes the main channel's stream title and/or category (scope channel:write). */
  updateStreamInfo(patch: { streamTitle?: string; categoryId?: number }): Promise<void> {
    return this.withPrimaryToken((t) => this.o.api.updateChannel(t, patch));
  }

  findCategory(name: string): Promise<{ id: number; name: string } | null> {
    return this.withPrimaryToken((t) => this.o.api.findCategory(t, name));
  }

  /** Runs a Kick API call with the main account's token, refreshing it once if Kick rejects it. */
  private async withPrimaryToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let auth = await this.o.connections.accessToken('kick', 'primary');
    for (let attempt = 0; ; attempt++) {
      if (!auth) throw new KickApiError('unauthorized', 'The main Kick account is not connected');
      try {
        return await fn(auth.token);
      } catch (err) {
        if (err instanceof KickApiError && err.kind === 'unauthorized' && attempt === 0) {
          auth = await this.o.connections.accessToken('kick', 'primary', { forceRefresh: true });
          continue;
        }
        throw err;
      }
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Opens the webhook receiver and makes sure the chat subscription exists. Never sends anything to chat. */
  async start(): Promise<void> {
    this.closed = false;
    this.started = true;
    try {
      await this.server.start();
    } catch (err) {
      this.set('error', err instanceof Error ? err.message : 'Could not open the Kick webhook receiver.');
      return;
    }
    await this.ensure();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimers();
    await this.server.close();
  }

  /** The Retry action, and the reaction to (re)authorization. One pass at a time; a request during a pass reruns it. */
  ensure(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.subscribe().catch((err) => {
          this.o.logger.error('kick chat subscription failed', { err });
          this.set('error', "CONDUIT couldn't set up Kick chat. Select Retry.");
        });
      } while (this.again && !this.closed);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async subscribe(): Promise<void> {
    this.clearTimers();
    const primary = this.primaryRecord();
    if (!primary) {
      this.subscriptionId = null;
      return this.set('disconnected', primaryProblem(this.o.db));
    }
    if (!scopesOf(primary).includes('events:subscribe')) {
      this.subscriptionId = null;
      return this.set(
        'permission_required',
        `Kick needs your permission to send ${primary.accountName}'s chat to CONDUIT. Select Reauthorize main account (adds the "events:subscribe" permission).`,
      );
    }
    this.set(this.status === 'connected' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting', null);

    let auth = await this.o.connections.accessToken('kick', 'primary');
    for (let attempt = 0; ; attempt++) {
      if (!auth) {
        this.subscriptionId = null;
        return this.set('error', `Kick no longer accepts ${primary.accountName}'s authorization. Reconnect the main account.`);
      }
      try {
        const existing = (await this.o.api.listSubscriptions(auth.token)).filter(
          (s) =>
            s.event === CHAT_EVENT.name &&
            s.version === CHAT_EVENT.version &&
            (s.broadcasterUserId === null || s.broadcasterUserId === primary.externalAccountId),
        );
        let id = existing[0]?.id ?? null;
        // Never keep duplicates (e.g. from an earlier run): one subscription delivers each message once.
        if (existing.length > 1)
          await this.o.api
            .deleteSubscriptions(
              auth.token,
              existing.slice(1).map((s) => s.id),
            )
            .catch(() => undefined);
        if (!id) id = await this.o.api.subscribeToChat(auth.token);
        this.subscriptionId = id;
        await this.ensureRedemptionSubscription(auth.token, primary);
        await this.ensureBanSubscription(auth.token, primary);
        this.retries = 0;
        this.set('connected', null);
        this.o.logger.info('kick chat subscription active', { reused: existing.length > 0 });
        this.recheckTimer = setTimeout(() => void this.ensure(), RECHECK_MS);
        this.recheckTimer.unref();
        return;
      } catch (err) {
        if (err instanceof KickApiError && err.kind === 'unauthorized' && attempt === 0) {
          auth = await this.o.connections.accessToken('kick', 'primary', { forceRefresh: true });
          continue;
        }
        return this.fail(err, primary);
      }
    }
  }

  /**
   * Reward redemption events (for giveaway bonus tickets) use the same webhook. Best effort: if Kick refuses, chat keeps
   * working, and giveaways still pick up redemptions by asking Kick for pending ones.
   */
  private async ensureRedemptionSubscription(token: string, primary: ConnectionRecord): Promise<void> {
    try {
      const all = await this.o.api.listSubscriptions(token);
      const existing = all.filter(
        (s) =>
          s.event === REDEMPTION_EVENT.name &&
          s.version === REDEMPTION_EVENT.version &&
          (s.broadcasterUserId === null || s.broadcasterUserId === primary.externalAccountId),
      );
      // Never keep duplicates: one subscription delivers each redemption once.
      if (existing.length > 1) await this.o.api.deleteSubscriptions(token, existing.slice(1).map((s) => s.id)).catch(() => undefined);
      this.redemptionSubscriptionId = existing[0]?.id ?? (await this.o.api.subscribeTo(token, REDEMPTION_EVENT));
      this.redemptionProblem = null;
    } catch (err) {
      this.o.logger.warn('kick redemption subscription failed', { kind: err instanceof KickApiError ? err.kind : 'unknown' });
      this.redemptionProblem = 'Kick didn’t accept the reward redemption subscription; redemptions are picked up a little later instead.';
    }
  }

  /** Ban and timeout events (for Kick Moderation's Logs) use the same webhook. Best effort: chat works either way. */
  private async ensureBanSubscription(token: string, primary: ConnectionRecord): Promise<void> {
    try {
      const all = await this.o.api.listSubscriptions(token);
      const existing = all.filter(
        (s) => s.event === BAN_EVENT.name && s.version === BAN_EVENT.version && (s.broadcasterUserId === null || s.broadcasterUserId === primary.externalAccountId),
      );
      // Never keep duplicates: one subscription delivers each ban once.
      if (existing.length > 1) await this.o.api.deleteSubscriptions(token, existing.slice(1).map((s) => s.id)).catch(() => undefined);
      this.banSubscriptionId = existing[0]?.id ?? (await this.o.api.subscribeTo(token, BAN_EVENT));
      this.banProblem = null;
    } catch (err) {
      this.o.logger.warn('kick ban subscription failed', { kind: err instanceof KickApiError ? err.kind : 'unknown' });
      this.banSubscriptionId = null;
      this.banProblem = 'Kick didn’t accept the ban and timeout subscription, so moderation done on Kick itself isn’t in the Logs.';
    }
  }

  private fail(err: unknown, primary: ConnectionRecord): void {
    const kind = err instanceof KickApiError ? err.kind : 'unknown';
    // The message names the request and quotes Kick's explanation (no tokens), which is what diagnoses a rejection.
    this.o.logger.warn('kick chat subscription failed', { kind, detail: err instanceof KickApiError ? err.message : undefined });
    this.subscriptionId = null;
    if (kind === 'unauthorized')
      return this.set('error', `Kick no longer accepts ${primary.accountName}'s authorization. Reconnect the main account.`);
    if (kind === 'forbidden') {
      return this.set(
        'permission_required',
        `Kick refused the chat subscription. Select Reauthorize main account to grant "events:subscribe".`,
      );
    }
    if (kind === 'bad_request' && err instanceof Error && err.message.includes('/events/subscriptions')) {
      // Kick's documentation lists no causes for this 400; the likely one is webhooks not yet enabled for the app.
      return this.set(
        'error',
        `${err.message}. Kick doesn't say why. The likely cause is that webhooks aren't enabled for your Kick app yet: set up the tunnel and turn on "Enable Webhooks" with the URL (steps below), then select Retry.`,
      );
    }
    const transient = kind === 'rate_limited' || kind === 'server_error' || kind === 'network';
    const reason =
      kind === 'rate_limited'
        ? 'Kick is rate limiting requests.'
        : kind === 'network'
          ? "CONDUIT couldn't reach Kick."
          : kind === 'server_error'
            ? 'Kick is having problems right now.'
            : err instanceof Error
              ? `${err.message}.`
              : "Kick didn't accept the chat subscription.";
    if (!transient || this.retries >= RETRY_DELAYS_S.length) return this.set('error', `${reason} Select Retry.`);
    const delayS = Math.max(RETRY_DELAYS_S[this.retries]!, err instanceof KickApiError ? (err.retryAfterSeconds ?? 0) : 0);
    this.retries++;
    this.nextRetryAt = this.o.now().getTime() + delayS * 1000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.ensure();
    }, delayS * 1000);
    this.retryTimer.unref();
    this.set('reconnecting', `${reason} Retrying in ${delayS} seconds.`);
  }

  /** Before the main account is disconnected: remove its chat subscription while its token still works. */
  private async beforeDisconnect(record: ConnectionRecord, token: string | null): Promise<void> {
    if (record.platform !== 'kick' || record.role !== 'primary') return;
    this.clearTimers();
    const ids = [this.subscriptionId, this.redemptionSubscriptionId, this.banSubscriptionId].filter((x): x is string => x !== null);
    if (token && ids.length > 0) await this.o.api.deleteSubscriptions(token, ids).catch(() => undefined);
    this.subscriptionId = null;
    this.redemptionSubscriptionId = null;
    this.banSubscriptionId = null;
    this.set('disconnected', 'Connect your main Kick account to receive its chat.');
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.retryTimer = null;
    this.recheckTimer = null;
    this.nextRetryAt = null;
  }

  private set(status: KickChatReceiveStatus, problem: string | null): void {
    this.status = status;
    this.problem = problem;
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  private handleEvent(e: KickWebhookEvent): void {
    if (e.type === REDEMPTION_EVENT.name && e.version === String(REDEMPTION_EVENT.version)) return this.handleRedemption(e);
    if (e.type === BAN_EVENT.name && e.version === String(BAN_EVENT.version)) return this.handleBan(e);
    if (e.type !== CHAT_EVENT.name || e.version !== String(CHAT_EVENT.version)) {
      this.o.logger.info('kick event ignored', { reason: 'not a chat message event', type: e.type, version: e.version });
      return;
    }
    const primary = this.primaryRecord();
    const message = parseChatMessage(e.payload, e.messageId, this.o.now().toISOString());
    if (!message) return void this.o.logger.warn('kick chat message ignored', { reason: 'payload did not match chat.message.sent v1' });
    // Only the main channel's chat is CONDUIT's business.
    if (!primary || message.broadcasterUserId !== primary.externalAccountId) {
      return void this.o.logger.warn('kick chat message ignored', { reason: 'not the main channel' });
    }
    if (this.recent.some((m) => m.messageId === message.messageId)) return;
    this.o.logger.info('kick chat message received', { fromBot: message.senderUserId === this.botUserId() });
    this.recent.push(message);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    this.received++;
    this.lastEventAt = message.receivedAt;
    this.delivery = 'confirmed';
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        this.o.logger.error('kick chat listener failed', { err });
      }
    }
  }

  /** A signed ban or timeout in the main channel → the ban listeners (Kick Moderation's Logs). */
  private handleBan(e: KickWebhookEvent): void {
    const b = parseBan(e.payload, e.messageId);
    const primary = this.primaryRecord();
    if (!b) return void this.o.logger.warn('kick ban event ignored', { reason: 'payload did not match moderation.banned v1' });
    if (!primary || b.broadcasterUserId !== primary.externalAccountId) return void this.o.logger.warn('kick ban event ignored', { reason: 'not the main channel' });
    this.lastEventAt = this.o.now().toISOString();
    this.delivery = 'confirmed';
    for (const listener of this.banListeners) {
      try {
        listener(b);
      } catch (err) {
        this.o.logger.error('kick ban listener failed', { err });
      }
    }
  }

  /** A signed redemption event for the main channel → the redemption listeners (giveaways). */
  private handleRedemption(e: KickWebhookEvent): void {
    const r = parseRedemption(e.payload);
    const primary = this.primaryRecord();
    if (!r) return void this.o.logger.warn('kick redemption ignored', { reason: 'payload did not match channel.reward.redemption.updated v1' });
    if (!primary || r.broadcasterUserId !== primary.externalAccountId) {
      return void this.o.logger.warn('kick redemption ignored', { reason: 'not the main channel' });
    }
    this.lastEventAt = this.o.now().toISOString();
    this.delivery = 'confirmed';
    for (const listener of this.redemptionListeners) {
      try {
        listener(r);
      } catch (err) {
        this.o.logger.error('kick redemption listener failed', { err });
      }
    }
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /** Sends a message as the selected chatbot account to the main channel. Resolves only when Kick confirms it. */
  async send(raw: unknown): Promise<KickSendResult> {
    const { content } = parseInput(sendKickChatSchema, raw);
    const sender = this.sender();
    if (!sender.record || !sender.channel) throw new AppError('conflict', sender.problem ?? 'Kick chat is not set up.');
    if (!scopesOf(sender.record).includes('chat:write')) {
      throw new AppError(
        'forbidden',
        `${sender.record.accountName} isn't allowed to send chat messages yet. Reauthorize it to grant Kick's "chat:write" permission.`,
      );
    }
    const since = this.o.now().getTime() - this.lastSendAt;
    if (since < MIN_SEND_INTERVAL_MS)
      throw new AppError('rate_limited', 'Wait a moment before sending another message.', { retryAfterSeconds: 2 });
    this.lastSendAt = this.o.now().getTime();

    const as = sender.record.accountName;
    const channel = sender.channel.accountHandle ?? sender.channel.accountName;
    let auth = await this.o.connections.accessToken('kick', sender.role);
    for (let attempt = 0; ; attempt++) {
      if (!auth) throw new AppError('conflict', `Kick no longer accepts ${as}'s authorization. Reconnect it, then try again.`);
      try {
        const { messageId } = await this.o.api.sendMessage(auth.token, sender.channel.externalAccountId, content);
        this.rememberSent(content);
        this.audit('success', sender.role);
        this.o.logger.info('kick chat message sent', { as: sender.role });
        return { sent: true, messageId, as, channel };
      } catch (err) {
        // 401: Kick rejected the token, so nothing was posted; refreshing and trying once more can't duplicate it.
        if (err instanceof KickApiError && err.kind === 'unauthorized' && attempt === 0) {
          auth = await this.o.connections.accessToken('kick', sender.role, { forceRefresh: true });
          continue;
        }
        this.audit('failure', sender.role);
        const failure = this.describeSendFailure(err, as, channel);
        if (!(err instanceof KickApiError) || err.outcomeUnknown) unconfirmedErrors.add(failure);
        throw failure;
      }
    }
  }

  /** send(), reporting the outcome instead of throwing. Uses exactly the same validation, throttle and account choice. */
  async sendResult(content: string): Promise<KickSendOutcome> {
    try {
      return { ok: true, result: await this.send({ content }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const unconfirmed = err instanceof AppError && unconfirmedErrors.has(err);
      const locallyThrottled = err instanceof AppError && err.code === 'rate_limited' && message.startsWith('Wait a moment');
      return { ok: false, outcome: unconfirmed ? 'unconfirmed' : 'failed', message, locallyThrottled };
    }
  }

  /** How long until the send spacing allows another message (0 = now). */
  msUntilNextSend(): number {
    return Math.max(0, MIN_SEND_INTERVAL_MS - (this.o.now().getTime() - this.lastSendAt));
  }

  /** Whether a message could be posted now (account, channel and scope), without contacting Kick. */
  sendReadiness(): { ready: boolean; problem: string | null } {
    const { send } = this.state();
    return { ready: send.ready, problem: send.problem };
  }

  /** Whether chat messages are arriving through the verified webhook subscription. */
  receiving(): boolean {
    return this.state().receive.status === 'connected';
  }

  /** The Kick user id the chatbot sends as, and whether that is the main account itself. */
  chatbotIdentity(): { userId: string | null; isMainAccount: boolean } {
    const s = this.sender();
    return { userId: s.record?.externalAccountId ?? null, isMainAccount: s.role === 'primary' };
  }

  /** The main channel's name for {channel}: its slug (e.g. retronix), else the account name. */
  mainChannelName(): string | null {
    const p = this.primaryRecord();
    return p ? (p.accountHandle ?? p.accountName) : null;
  }

  /** The main Kick channel: its slug (kick.com/<slug>) and display name, when the main account is connected. */
  mainChannel(): { slug: string | null; name: string | null } | null {
    const p = this.primaryRecord();
    return p ? { slug: p.accountHandle ?? null, name: p.accountName ?? p.accountHandle ?? null } : null;
  }

  /** Whether this exact text was posted by CONDUIT in the last minute. */
  wasRecentlySent(text: string): boolean {
    const at = this.recentlySentText.get(text.trim());
    return at !== undefined && this.o.now().getTime() - at < 60_000;
  }

  private rememberSent(text: string): void {
    const now = this.o.now().getTime();
    this.recentlySentText.set(text.trim(), now);
    for (const [t, at] of this.recentlySentText) if (now - at >= 60_000) this.recentlySentText.delete(t);
    if (this.recentlySentText.size > 200) this.recentlySentText.delete(this.recentlySentText.keys().next().value!);
  }

  private describeSendFailure(err: unknown, as: string, channel: string): AppError {
    if (!(err instanceof KickApiError)) {
      this.o.logger.error('kick chat send failed', { err });
      return new AppError(
        'service_unavailable',
        `CONDUIT couldn't confirm the message was posted. Check ${channel}'s chat before sending again.`,
      );
    }
    // err.message names the request and quotes Kick's reason; it never contains the token or the message text.
    this.o.logger.warn('kick chat send failed', { kind: err.kind, detail: err.message });
    switch (err.kind) {
      case 'unauthorized':
        return new AppError('conflict', `Kick no longer accepts ${as}'s authorization. Reconnect it, then try again.`);
      case 'forbidden':
        return new AppError(
          'forbidden',
          `Kick refused to post as ${as} in ${channel}'s chat. ${as} may be banned or timed out there, the chat may be restricted (followers-, subscribers- or verified-only), or the permission is missing.`,
        );
      case 'rate_limited':
        return new AppError('rate_limited', 'Kick is rate limiting messages. Wait a moment, then try again.', {
          retryAfterSeconds: err.retryAfterSeconds ?? 10,
        });
      case 'bad_request':
        return new AppError('bad_request', `Kick rejected the message (${err.message}). Check its length and content.`);
      case 'not_found':
        return new AppError('conflict', `Kick couldn't find ${channel}'s channel.`);
      default:
        return err.outcomeUnknown
          ? new AppError(
              'service_unavailable',
              `CONDUIT couldn't confirm whether Kick posted the message. Check ${channel}'s chat before sending again.`,
            )
          : new AppError(
              'service_unavailable',
              `Kick didn't post the message (${err.kind === 'server_error' ? 'Kick is having problems' : 'unexpected response'}). Try again later.`,
            );
    }
  }

  private audit(outcome: 'success' | 'failure', role: 'primary' | 'bot'): void {
    writeAudit(this.o.db, { action: 'kick.chat.sent', outcome, actorUserId: null, metadata: { as: role } }, this.o.now());
  }

  /** Who sends (the chatbot selection) and to which channel (always the main account's). */
  private sender(): { role: 'primary' | 'bot'; record: ConnectionRecord | null; channel: ConnectionRecord | null; problem: string | null } {
    const role = this.o.credentials.chatbotMode() === 'separate' ? 'bot' : 'primary';
    const channel = this.primaryRecord();
    const record =
      role === 'bot' ? (connectionsRepo.listForRole(this.o.db, 'kick', 'bot').find((r) => r.status === 'connected') ?? null) : channel;
    let problem: string | null = null;
    if (!channel) problem = 'Connect your main Kick account first; messages go to its channel.';
    else if (!record) problem = role === 'bot' ? 'Add or reconnect the bot account to send as it.' : null;
    return { role, record, channel, problem };
  }

  // ── status ────────────────────────────────────────────────────────────────

  state(): KickChatState {
    // Status reads never contact Kick (a poll must not become a retry loop). Re-authorization triggers ensure() through
    // ConnectionService.onAfterConnect; only a main account that disappeared is reflected here.
    const primary = this.primaryRecord();
    if (!this.running && !this.closed && this.status !== 'disconnected' && !primary) this.set('disconnected', primaryProblem(this.o.db));

    const sender = this.sender();
    const missingScope = sender.record && !scopesOf(sender.record).includes('chat:write') ? 'chat:write' : null;
    return {
      receive: {
        status: this.status,
        delivery: this.delivery,
        problem: this.problem,
        localTarget: `http://127.0.0.1:${this.server.port}`,
        webhookPath: KICK_WEBHOOK_PATH,
        lastEventAt: this.lastEventAt,
        messagesReceived: this.received,
        rejected: this.rejected,
        nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
      },
      send: {
        account: sender.record ? sender.role : null,
        accountName: sender.record?.accountName ?? null,
        channel: sender.channel ? (sender.channel.accountHandle ?? sender.channel.accountName) : null,
        ready: Boolean(sender.record && sender.channel && !missingScope),
        missingScope,
        problem:
          sender.problem ??
          (missingScope
            ? `${sender.record!.accountName} needs Kick's "chat:write" permission to send messages. Select Reauthorize ${sender.role === 'bot' ? 'bot account' : 'main account'}.`
            : null),
      },
      recent: this.recent.map(({ messageId, content, senderUserId, senderUsername, senderColor, badges, createdAt, receivedAt }) => ({
        messageId,
        content,
        senderUserId,
        senderUsername,
        senderColor,
        badges,
        createdAt,
        receivedAt,
      })),
    };
  }

  private botUserId(): string | null {
    return connectionsRepo.listForRole(this.o.db, 'kick', 'bot').find((r) => r.status === 'connected')?.externalAccountId ?? null;
  }

  private primaryRecord(): ConnectionRecord | null {
    return connectionsRepo.listForRole(this.o.db, 'kick', 'primary').find((r) => r.status === 'connected') ?? null;
  }
}

function primaryProblem(db: Database): string {
  const any = connectionsRepo.listForRole(db, 'kick', 'primary')[0];
  return any ? 'Reconnect your main Kick account to receive its chat.' : 'Connect your main Kick account to receive its chat.';
}

function scopesOf(record: ConnectionRecord): string[] {
  try {
    const v = JSON.parse(record.grantedScopes) as unknown;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const id = (v: unknown): string | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null;

/**
 * chat.message.sent v1 → a message, defensively: unknown fields are ignored, optional ones may be missing, and the
 * required ones (message id, content, sender, broadcaster) must be present and well-formed.
 */
export function parseChatMessage(payload: unknown, deliveryId: string, receivedAt: string): KickChatMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const sender = (p.sender ?? null) as Record<string, unknown> | null;
  const broadcaster = (p.broadcaster ?? null) as Record<string, unknown> | null;
  const messageId = str(p.message_id, 100) ?? deliveryId;
  const content = str(p.content, 2000);
  const senderUserId = id(sender?.user_id);
  const senderUsername = str(sender?.username, 64);
  const broadcasterUserId = id(broadcaster?.user_id);
  if (!content || !senderUserId || !senderUsername || !broadcasterUserId || !/^[A-Za-z0-9_-]{1,100}$/.test(messageId)) return null;

  const identity = (sender?.identity ?? null) as Record<string, unknown> | null;
  const color = str(identity?.username_color, 9);
  const badges = Array.isArray(identity?.badges)
    ? (identity!.badges as unknown[])
        .map((b) => str((b as { text?: unknown })?.text, 40))
        .filter((b): b is string => Boolean(b))
        .slice(0, 10)
    : [];
  // Badge types decide permissions; only short lower-case identifiers are kept.
  const badgeTypes = Array.isArray(identity?.badges)
    ? (identity!.badges as unknown[])
        .map((b) => str((b as { type?: unknown })?.type, 40))
        .filter((t): t is string => Boolean(t) && /^[a-z0-9_]{1,40}$/.test(t!))
        .slice(0, 20)
    : [];
  const subBadge = Array.isArray(identity?.badges)
    ? (identity!.badges as Array<{ type?: unknown; count?: unknown }>).find((b) => b?.type === 'subscriber')
    : undefined;
  const subscriberMonths = Number.isInteger(subBadge?.count) && (subBadge!.count as number) > 0 ? Math.min(subBadge!.count as number, 1200) : null;
  const created = str(p.created_at, 40);
  const reply = (p.replies_to ?? null) as Record<string, unknown> | null;
  const replySender = (reply?.sender ?? null) as Record<string, unknown> | null;
  const emotes = Array.isArray(p.emotes)
    ? (p.emotes as unknown[]).slice(0, 50).flatMap((e) => {
        const em = e as { emote_id?: unknown; positions?: unknown };
        const emoteId = id(em?.emote_id) ?? str(em?.emote_id, 40);
        const positions = Array.isArray(em?.positions)
          ? (em.positions as unknown[])
              .map((pos) => pos as { s?: unknown; e?: unknown })
              .filter((pos) => Number.isInteger(pos?.s) && Number.isInteger(pos?.e))
              .map((pos) => ({ s: pos.s as number, e: pos.e as number }))
          : [];
        return emoteId ? [{ emoteId, positions }] : [];
      })
    : [];

  return {
    messageId,
    content,
    senderUserId,
    senderUsername,
    senderColor: color && /^#[0-9A-Fa-f]{3,8}$/.test(color) ? color : null,
    badges,
    createdAt: created && Number.isFinite(Date.parse(created)) ? created : null,
    receivedAt,
    broadcasterUserId,
    badgeTypes,
    subscriberMonths,
    repliesTo:
      reply && str(reply.message_id, 100) && typeof reply.content === 'string'
        ? {
            messageId: str(reply.message_id, 100)!,
            content: reply.content.slice(0, 500),
            senderUsername: str(replySender?.username, 64) ?? '',
          }
        : null,
    emotes,
  };
}

/** A verified reward redemption (channel.reward.redemption.updated v1). */
export interface KickRedemptionEvent {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  redeemedAt: string;
  rewardId: string;
  redeemerUserId: string;
  redeemerUsername: string | null;
  broadcasterUserId: string;
}

/** channel.reward.redemption.updated v1 → a redemption; null if anything required is missing or malformed. */
/** A ban or timeout in the channel (moderation.banned v1). A timeout is a ban with an end. */
export interface KickBanEvent {
  /** Kick's delivery id (a redelivery has the same one). */
  id: string;
  broadcasterUserId: string;
  moderatorUserId: string | null;
  moderatorName: string | null;
  userId: string;
  userName: string | null;
  reason: string | null;
  at: string;
  /** When a timeout ends; null for a permanent ban. */
  expiresAt: string | null;
}

/** moderation.banned v1 → a ban, defensively (unknown fields ignored, ids must look like Kick's). */
export function parseBan(payload: unknown, deliveryId: string): KickBanEvent | null {
  const p = payload as {
    broadcaster?: { user_id?: unknown };
    moderator?: { user_id?: unknown; username?: unknown };
    banned_user?: { user_id?: unknown; username?: unknown };
    metadata?: { reason?: unknown; created_at?: unknown; expires_at?: unknown };
  } | null;
  const id = (v: unknown) => ((typeof v === 'number' || typeof v === 'string') && /^\d{1,20}$/.test(String(v)) ? String(v) : null);
  const time = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const name = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);
  const broadcaster = id(p?.broadcaster?.user_id);
  const user = id(p?.banned_user?.user_id);
  if (!p || !broadcaster || !user) return null;
  return {
    id: deliveryId,
    broadcasterUserId: broadcaster,
    moderatorUserId: id(p.moderator?.user_id),
    moderatorName: name(p.moderator?.username),
    userId: user,
    userName: name(p.banned_user?.username),
    reason: typeof p.metadata?.reason === 'string' && p.metadata.reason.trim() ? p.metadata.reason.trim().slice(0, 200) : null,
    at: time(p.metadata?.created_at) ?? new Date().toISOString(),
    expiresAt: time(p.metadata?.expires_at),
  };
}

export function parseRedemption(payload: unknown): KickRedemptionEvent | null {
  const p = payload as {
    id?: unknown;
    status?: unknown;
    redeemed_at?: unknown;
    reward?: { id?: unknown };
    redeemer?: { user_id?: unknown; username?: unknown };
    broadcaster?: { user_id?: unknown };
  } | null;
  if (!p || typeof p.id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(p.id)) return null;
  if (p.status !== 'pending' && p.status !== 'accepted' && p.status !== 'rejected') return null;
  if (typeof p.reward?.id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(p.reward.id)) return null;
  const redeemer = p.redeemer?.user_id;
  const broadcaster = p.broadcaster?.user_id;
  if ((typeof redeemer !== 'number' && typeof redeemer !== 'string') || !/^\d{1,20}$/.test(String(redeemer))) return null;
  if ((typeof broadcaster !== 'number' && typeof broadcaster !== 'string') || !/^\d{1,20}$/.test(String(broadcaster))) return null;
  const redeemedAt = typeof p.redeemed_at === 'string' && !Number.isNaN(Date.parse(p.redeemed_at)) ? new Date(p.redeemed_at).toISOString() : null;
  if (!redeemedAt) return null;
  return {
    id: p.id,
    status: p.status,
    redeemedAt,
    rewardId: p.reward.id,
    redeemerUserId: String(redeemer),
    redeemerUsername: typeof p.redeemer?.username === 'string' ? p.redeemer.username.slice(0, 100) : null,
    broadcasterUserId: String(broadcaster),
  };
}
