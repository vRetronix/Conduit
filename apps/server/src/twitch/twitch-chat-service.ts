/**
 * Twitch live chat: receiving the main channel's messages (EventSub over a WebSocket) and sending messages as the
 * chatbot account (Helix POST /chat/messages). One instance owns the single EventSub session and its subscription, so
 * reconnects can never stack sessions or listeners.
 *
 * Receiving (dev.twitch.tv/docs/eventsub): CONDUIT opens Twitch's EventSub WebSocket and, once welcomed, subscribes it
 * to channel.chat.message for the main channel, read as the main account itself (its token, user:read:chat). Unlike
 * Kick's webhooks, nothing has to reach this PC from outside, so no tunnel is needed. "Connected" means Twitch confirmed
 * the subscription on a live session. A lost session is re-opened on its own, with growing waits.
 *
 * Sending (dev.twitch.tv/docs/api/reference/#send-chat-message): as the selected chatbot account (bot account, or the
 * main account), to the main account's channel, with user:write:chat. Never retried automatically (it could post
 * twice), except after a 401, which means Twitch rejected the token and posted nothing.
 *
 * Messages are kept in memory only (the last few, for the status view) and handed to subscribers (commands, timed
 * messages).
 */
import { connectionsRepo, type ConnectionRecord, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  sendTwitchChatSchema,
  type TwitchChatMessageView,
  type TwitchChatReceiveStatus,
  type TwitchChatState,
  type TwitchSendResult,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { parseInput } from '../validation';
import type { ConnectionService } from '../app/connection-service';
import { CHAT_MESSAGE_EVENT, TwitchChatApiError, type TwitchChatApi } from './twitch-chat-api';
import type { TwitchCredentials } from './twitch-credentials';
import { TwitchEventSubSession, type EventSubNotification } from './twitch-eventsub';

const RECENT_LIMIT = 25;
/** Waits before re-opening a lost or failed session; the last one repeats. */
const RETRY_DELAYS_S = [5, 30, 120, 300];
/** Twitch allows 20 messages per 30 seconds for a chatter who isn't a moderator; this stays well inside it. */
const MIN_SEND_INTERVAL_MS = 2000;
export const READ_SCOPE = 'user:read:chat';
export const WRITE_SCOPE = 'user:write:chat';

/** The outcome of a send, for callers that must not throw (e.g. command replies from the chat handler). */
export type TwitchSendOutcome =
  | { ok: true; result: TwitchSendResult }
  | { ok: false; outcome: 'failed' | 'unconfirmed'; message: string; locallyThrottled: boolean };

/** Errors after which Twitch may or may not have posted the message (network failure, 5xx while sending). */
const unconfirmedErrors = new WeakSet<AppError>();

export interface TwitchChatMessage extends TwitchChatMessageView {
  broadcasterUserId: string;
  /** Twitch badge set ids from the event (e.g. "moderator", "subscriber"); used for command permissions. */
  badgeTypes: string[];
  /** Subscriber months from the sender's subscriber badge, when they have one. */
  subscriberMonths: number | null;
}

export interface TwitchChatServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  connections: ConnectionService;
  credentials: TwitchCredentials;
  api: TwitchChatApi;
  /** Twitch's EventSub WebSocket URL (tests use a local one). */
  eventSubUrl?: string;
}

export class TwitchChatService {
  private status: TwitchChatReceiveStatus = 'disconnected';
  private problem: string | null = null;
  private lastEventAt: string | null = null;
  private received = 0;
  private readonly recent: TwitchChatMessage[] = [];
  private readonly listeners = new Set<(m: TwitchChatMessage) => void>();
  private session: TwitchEventSubSession | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private nextRetryAt: number | null = null;
  private retries = 0;
  private lastSendAt = 0;
  /** Text this service posted recently (for loop protection when the chatbot is the main account itself). */
  private readonly recentlySentText = new Map<string, number>();
  private closed = false;
  /** Nothing connects to Twitch before start() (backend start-up). */
  private started = false;

  constructor(private readonly o: TwitchChatServiceOptions) {
    // Connect as soon as the main account is (re)authorized; let go of the session before it is disconnected.
    o.connections.onAfterConnect((record) => {
      if (record.platform === 'twitch' && record.role === 'primary') void this.ensure();
    });
    o.connections.onBeforeDisconnect(async (record) => {
      if (record.platform !== 'twitch' || record.role !== 'primary') return;
      this.clearRetry();
      this.dropSession();
      this.set('disconnected', 'Connect your main Twitch account to receive its chat.');
    });
  }

  /** Commands and timed messages receive each new chat message here. Returns an unsubscribe function. */
  onMessage(listener: (m: TwitchChatMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Opens the EventSub session and subscribes it to the main channel's chat. Never sends anything to chat. */
  async start(): Promise<void> {
    this.closed = false;
    this.started = true;
    await this.ensure();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearRetry();
    this.dropSession();
    await this.running?.catch(() => undefined);
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
        await this.connect().catch((err) => {
          this.o.logger.error('twitch chat connection failed', { err });
          this.set('error', "CONDUIT couldn't set up Twitch chat. Select Retry.");
        });
      } while (this.again && !this.closed);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async connect(): Promise<void> {
    this.clearRetry();
    this.dropSession();
    const primary = this.primaryRecord();
    if (!primary) return this.set('disconnected', primaryProblem(this.o.db));
    if (!scopesOf(primary).includes(READ_SCOPE)) {
      return this.set(
        'permission_required',
        `CONDUIT needs Twitch's "${READ_SCOPE}" permission to read ${primary.accountName}'s chat. Select Reconnect on your main Twitch account to grant it.`,
      );
    }
    const clientId = this.o.credentials.clientId();
    if (!clientId) return this.set('disconnected', 'Set up your Twitch app first.');
    this.set(this.retries > 0 ? 'reconnecting' : 'connecting', null);

    const session: TwitchEventSubSession = new TwitchEventSubSession({
      logger: this.o.logger.child({ module: 'twitch-eventsub' }),
      now: this.o.now,
      url: this.o.eventSubUrl,
      onNotification: (n) => this.handleNotification(n),
      onRevocation: (type, status) => this.onRevoked(session, type, status),
      onLost: (r) => this.onLost(session, r.detail),
    });
    this.session = session;
    let sessionId: string;
    try {
      sessionId = await session.open();
    } catch (err) {
      if (this.session === session) this.session = null;
      return this.fail(new TwitchChatApiError('network', err instanceof Error ? err.message : "CONDUIT couldn't reach Twitch."), primary);
    }
    if (this.session !== session || this.closed) return session.close();
    try {
      // Within Twitch's 10 seconds: the main account reads its own channel's chat.
      await this.withPrimaryToken((token) =>
        this.o.api.subscribeChat({ token, clientId }, { sessionId, broadcasterUserId: primary.externalAccountId, userId: primary.externalAccountId }),
      );
    } catch (err) {
      session.close();
      if (this.session === session) this.session = null;
      return this.fail(err, primary);
    }
    if (this.session !== session) return;
    this.retries = 0;
    this.set('connected', null);
    this.o.logger.info('twitch chat connected');
  }

  /** Runs a Twitch API call with the main account's token, refreshing it once if Twitch rejects it. */
  private async withPrimaryToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let auth = await this.o.connections.accessToken('twitch', 'primary');
    for (let attempt = 0; ; attempt++) {
      if (!auth) throw new TwitchChatApiError('unauthorized', 'The main Twitch account is not connected');
      try {
        return await fn(auth.token);
      } catch (err) {
        if (err instanceof TwitchChatApiError && err.kind === 'unauthorized' && attempt === 0) {
          auth = await this.o.connections.accessToken('twitch', 'primary', { forceRefresh: true });
          continue;
        }
        throw err;
      }
    }
  }

  private fail(err: unknown, primary: ConnectionRecord): void {
    const kind = err instanceof TwitchChatApiError ? err.kind : 'unknown';
    this.o.logger.warn('twitch chat subscription failed', { kind, detail: err instanceof TwitchChatApiError ? err.message : undefined });
    if (kind === 'unauthorized') return this.set('error', `Twitch no longer accepts ${primary.accountName}'s authorization. Reconnect the main account.`);
    if (kind === 'forbidden') {
      return this.set(
        'permission_required',
        `Twitch refused to share ${primary.accountName}'s chat. Select Reconnect on your main Twitch account to grant "${READ_SCOPE}".`,
      );
    }
    const transient = kind === 'network' || kind === 'rate_limited' || kind === 'server_error';
    const reason =
      kind === 'rate_limited'
        ? 'Twitch is rate limiting requests.'
        : kind === 'network'
          ? err instanceof Error && err.message
            ? err.message
            : "CONDUIT couldn't reach Twitch."
          : kind === 'server_error'
            ? 'Twitch is having problems right now.'
            : err instanceof Error
              ? `${err.message}.`
              : "Twitch didn't accept the chat subscription.";
    if (!transient) return this.set('error', `${reason} Select Retry.`);
    const retryAfter = err instanceof TwitchChatApiError ? (err.retryAfterSeconds ?? 0) : 0;
    this.scheduleRetry(reason, retryAfter);
  }

  /** The session ended on its own (network, Twitch closed it, keepalives stopped): open a new one after a wait. */
  private onLost(session: TwitchEventSubSession, detail: string): void {
    if (this.session !== session) return;
    this.session = null;
    if (this.closed) return;
    this.o.logger.warn('twitch chat session lost', { detail });
    this.scheduleRetry(detail, 0);
  }

  /** Twitch ended the subscription itself: access was revoked, or the account is gone. Not retried automatically. */
  private onRevoked(session: TwitchEventSubSession, type: string, status: string): void {
    if (this.session !== session || type !== CHAT_MESSAGE_EVENT.type) return;
    this.o.logger.warn('twitch chat subscription revoked', { status });
    this.dropSession();
    this.set(
      'error',
      status === 'authorization_revoked'
        ? 'Twitch ended chat access because the authorization was revoked. Reconnect your main Twitch account.'
        : `Twitch ended the chat subscription (${status}). Select Retry.`,
    );
  }

  private scheduleRetry(reason: string, minSeconds: number): void {
    this.clearRetry();
    const delayS = Math.max(RETRY_DELAYS_S[Math.min(this.retries, RETRY_DELAYS_S.length - 1)]!, minSeconds);
    this.retries++;
    this.nextRetryAt = this.o.now().getTime() + delayS * 1000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.ensure();
    }, delayS * 1000);
    this.retryTimer.unref();
    this.set('reconnecting', `${reason.replace(/\.?$/, '.')} Retrying in ${delayS} seconds.`);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private dropSession(): void {
    const s = this.session;
    this.session = null;
    s?.close();
  }

  private set(status: TwitchChatReceiveStatus, problem: string | null): void {
    this.status = status;
    this.problem = problem;
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  private handleNotification(n: EventSubNotification): void {
    if (n.type !== CHAT_MESSAGE_EVENT.type || n.version !== CHAT_MESSAGE_EVENT.version) return;
    const receivedAt = this.o.now().toISOString();
    const m = parseTwitchChatMessage(n.event, receivedAt);
    const primary = this.primaryRecord();
    if (!m || !primary || m.broadcasterUserId !== primary.externalAccountId) {
      this.o.logger.info('twitch chat event ignored', { reason: m ? 'another channel' : 'malformed' });
      return;
    }
    this.lastEventAt = receivedAt;
    this.received++;
    this.recent.push(m);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    for (const listener of this.listeners) {
      try {
        listener(m);
      } catch (err) {
        this.o.logger.error('twitch chat listener failed', { err });
      }
    }
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /** Sends a message as the selected chatbot account to the main channel. Resolves only when Twitch confirms it. */
  async send(raw: unknown): Promise<TwitchSendResult> {
    const { content } = parseInput(sendTwitchChatSchema, raw);
    const sender = this.sender();
    if (!sender.record || !sender.channel) throw new AppError('conflict', sender.problem ?? 'Twitch chat is not set up.');
    if (!scopesOf(sender.record).includes(WRITE_SCOPE)) {
      throw new AppError(
        'forbidden',
        `${sender.record.accountName} isn't allowed to send chat messages yet. Reconnect it to grant Twitch's "${WRITE_SCOPE}" permission.`,
      );
    }
    const clientId = this.o.credentials.clientId();
    if (!clientId) throw new AppError('conflict', 'Set up your Twitch app first.');
    const since = this.o.now().getTime() - this.lastSendAt;
    if (since < MIN_SEND_INTERVAL_MS) throw new AppError('rate_limited', 'Wait a moment before sending another message.', { retryAfterSeconds: 2 });
    this.lastSendAt = this.o.now().getTime();

    const as = sender.record.accountName;
    const channel = sender.channel.accountHandle ?? sender.channel.accountName;
    let auth = await this.o.connections.accessToken('twitch', sender.role);
    for (let attempt = 0; ; attempt++) {
      if (!auth) throw new AppError('conflict', `Twitch no longer accepts ${as}'s authorization. Reconnect it, then try again.`);
      try {
        const { messageId } = await this.o.api.sendMessage(
          { token: auth.token, clientId },
          { broadcasterUserId: sender.channel.externalAccountId, senderId: sender.record.externalAccountId, message: content },
        );
        this.rememberSent(content);
        this.audit('success', sender.role);
        this.o.logger.info('twitch chat message sent', { as: sender.role });
        return { sent: true, messageId, as, channel };
      } catch (err) {
        // 401: Twitch rejected the token, so nothing was posted; refreshing and trying once more can't duplicate it.
        if (err instanceof TwitchChatApiError && err.kind === 'unauthorized' && attempt === 0) {
          auth = await this.o.connections.accessToken('twitch', sender.role, { forceRefresh: true });
          continue;
        }
        this.audit('failure', sender.role);
        const failure = this.describeSendFailure(err, as, channel);
        if (!(err instanceof TwitchChatApiError) || err.outcomeUnknown) unconfirmedErrors.add(failure);
        throw failure;
      }
    }
  }

  /** send(), reporting the outcome instead of throwing. Uses exactly the same validation, throttle and account choice. */
  async sendResult(content: string): Promise<TwitchSendOutcome> {
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

  /** Whether a message could be posted now (account, channel and scope), without contacting Twitch. */
  sendReadiness(): { ready: boolean; problem: string | null } {
    const { send } = this.state();
    return { ready: send.ready, problem: send.problem };
  }

  /** Whether chat messages are arriving through the EventSub subscription. */
  receiving(): boolean {
    return this.status === 'connected';
  }

  /** The Twitch user id the chatbot sends as, and whether that is the main account itself. */
  chatbotIdentity(): { userId: string | null; isMainAccount: boolean } {
    const s = this.sender();
    return { userId: s.record?.externalAccountId ?? null, isMainAccount: s.role === 'primary' };
  }

  /** The main channel's name for {channel}: its login (e.g. retronix), else the account name. */
  mainChannelName(): string | null {
    const p = this.primaryRecord();
    return p ? (p.accountHandle ?? p.accountName) : null;
  }

  /** The main Twitch channel: its login (twitch.tv/<login>) and display name, when the main account is connected. */
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
    if (!(err instanceof TwitchChatApiError)) {
      this.o.logger.error('twitch chat send failed', { err });
      return new AppError('service_unavailable', `CONDUIT couldn't confirm the message was posted. Check ${channel}'s chat before sending again.`);
    }
    // err.message names the request and quotes Twitch's reason; it never contains the token or the message text.
    this.o.logger.warn('twitch chat send failed', { kind: err.kind, detail: err.message });
    switch (err.kind) {
      case 'unauthorized':
        return new AppError('conflict', `Twitch no longer accepts ${as}'s authorization. Reconnect it, then try again.`);
      case 'forbidden':
        return new AppError('forbidden', `Twitch refused to post as ${as} in ${channel}'s chat. ${as} may be banned or timed out there, or the permission is missing.`);
      case 'dropped':
        return new AppError('conflict', `Twitch didn't post the message: ${err.message.replace(/\.?$/, '.')}`);
      case 'rate_limited':
        return new AppError('rate_limited', 'Twitch is rate limiting messages. Wait a moment, then try again.', { retryAfterSeconds: err.retryAfterSeconds ?? 10 });
      case 'bad_request':
        return new AppError('bad_request', `Twitch rejected the message (${err.message}). Check its length and content.`);
      default:
        return err.outcomeUnknown
          ? new AppError('service_unavailable', `CONDUIT couldn't confirm whether Twitch posted the message. Check ${channel}'s chat before sending again.`)
          : new AppError('service_unavailable', `Twitch didn't post the message (${err.kind === 'server_error' ? 'Twitch is having problems' : 'unexpected response'}). Try again later.`);
    }
  }

  private audit(outcome: 'success' | 'failure', role: 'primary' | 'bot'): void {
    writeAudit(this.o.db, { action: 'twitch.chat.sent', outcome, actorUserId: null, metadata: { as: role } }, this.o.now());
  }

  /** Who sends (the chatbot selection) and to which channel (always the main account's). */
  private sender(): { role: 'primary' | 'bot'; record: ConnectionRecord | null; channel: ConnectionRecord | null; problem: string | null } {
    const role = this.o.credentials.chatbotMode() === 'separate' ? 'bot' : 'primary';
    const channel = this.primaryRecord();
    const record = role === 'bot' ? (connectionsRepo.listForRole(this.o.db, 'twitch', 'bot').find((r) => r.status === 'connected') ?? null) : channel;
    let problem: string | null = null;
    if (!channel) problem = 'Connect your main Twitch account first; messages go to its channel.';
    else if (!record) problem = role === 'bot' ? 'Add or reconnect the bot account to send as it.' : null;
    return { role, record, channel, problem };
  }

  // ── status ────────────────────────────────────────────────────────────────

  state(): TwitchChatState {
    // Status reads never contact Twitch. Re-authorization reconnects through ConnectionService.onAfterConnect; only a
    // main account that disappeared (disconnected, or marked for reconnecting) is reflected here.
    if (!this.running && !this.closed && this.status !== 'disconnected' && !this.primaryRecord()) {
      this.clearRetry();
      this.dropSession();
      this.set('disconnected', primaryProblem(this.o.db));
    }
    const sender = this.sender();
    const missingScope = sender.record && !scopesOf(sender.record).includes(WRITE_SCOPE) ? WRITE_SCOPE : null;
    return {
      receive: {
        status: this.status,
        problem: this.problem,
        lastEventAt: this.lastEventAt,
        messagesReceived: this.received,
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
            ? `${sender.record!.accountName} needs Twitch's "${WRITE_SCOPE}" permission to send messages. Select Reconnect on the ${sender.role === 'bot' ? 'bot account' : 'main account'}.`
            : null),
      },
      recent: this.recent.map(({ messageId, content, senderUserId, senderUsername, senderColor, badges, receivedAt }) => ({
        messageId,
        content,
        senderUserId,
        senderUsername,
        senderColor,
        badges,
        receivedAt,
      })),
    };
  }

  private primaryRecord(): ConnectionRecord | null {
    return connectionsRepo.listForRole(this.o.db, 'twitch', 'primary').find((r) => r.status === 'connected') ?? null;
  }
}

function primaryProblem(db: Database): string {
  const any = connectionsRepo.listForRole(db, 'twitch', 'primary')[0];
  return any ? 'Reconnect your main Twitch account to receive its chat.' : 'Connect your main Twitch account to receive its chat.';
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
const numericId = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null);

/**
 * channel.chat.message v1 → a message, defensively: unknown fields are ignored, and the required ones (message id,
 * text, chatter, broadcaster) must be present and well-formed. In a shared chat session Twitch also delivers messages
 * sent in the other channels (source_broadcaster_user_id is then another channel); those are dropped, so commands and
 * counts only react to this channel's own chat.
 */
export function parseTwitchChatMessage(payload: unknown, receivedAt: string): TwitchChatMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const message = (p.message ?? null) as Record<string, unknown> | null;
  const messageId = str(p.message_id, 100);
  const content = str(message?.text, 2000);
  const senderUserId = numericId(p.chatter_user_id);
  const senderUsername = str(p.chatter_user_name, 64) || str(p.chatter_user_login, 64);
  const broadcasterUserId = numericId(p.broadcaster_user_id);
  if (!messageId || !/^[A-Za-z0-9_-]{1,100}$/.test(messageId) || !content || !senderUserId || !senderUsername || !broadcasterUserId) return null;
  const source = p.source_broadcaster_user_id;
  if (source !== undefined && source !== null && source !== broadcasterUserId) return null;

  const badges = Array.isArray(p.badges) ? (p.badges as Array<{ set_id?: unknown; info?: unknown }>).slice(0, 20) : [];
  // Badge set ids decide permissions; only short lower-case identifiers are kept.
  const badgeTypes = badges.map((b) => str(b?.set_id, 40)).filter((t): t is string => Boolean(t) && /^[a-z0-9_-]{1,40}$/.test(t!));
  const sub = badges.find((b) => b?.set_id === 'subscriber' || b?.set_id === 'founder');
  const months = Number(sub?.info);
  const color = str(p.color, 9);
  return {
    messageId,
    content,
    senderUserId,
    senderUsername,
    senderColor: color && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null,
    badges: badgeTypes,
    receivedAt,
    broadcasterUserId,
    badgeTypes,
    subscriberMonths: Number.isInteger(months) && months > 0 ? Math.min(months, 1200) : null,
  };
}
