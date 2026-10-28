/**
 * Giveaways: lifecycle, entries, tickets, weighted winner drawing and announcements. Shared by both platforms; the
 * platform parts are thin: Kick entries come from the verified chat feed (!enter, handled here) and bonus tickets from
 * verified Channel Points reward redemptions; Discord entries only from the Enter Giveaway button on the giveaway's
 * embed (button interactions, onDiscordButton; entering is one-way), answered privately. Management happens only through
 * the local API.
 *
 * Lifecycle: Start Giveaway validates everything and opens the giveaway at once (no drafts). It then sets up the Kick
 * reward and posts the Discord embed; if either fails, the giveaway is removed again and the error is reported, so a
 * half-started giveaway never stays active. End closes entries (also automatically at the end time), Draw picks the
 * winners, Redraw replaces one. Cancel deletes the giveaway and everything that belongs to it.
 *
 * Tickets (see shared/giveaways.ts): weight = (1 + bonus tickets from accepted redemptions) × (verified active Kick
 * subscriber ? multiplier : 1). Ticket counts and odds are private: they are shown only in the local dashboard, never
 * in any public Kick message or Discord embed.
 *
 * Reliability:
 * - The database is the authority. At most one giveaway is open (partial unique index); entries are unique per
 *   (giveaway, platform, platform user id); redemptions are keyed by Kick's redemption id, so repeated or concurrent
 *   events never add a second entry or grant tickets twice.
 * - Entries and redemptions are refused once the end time has passed, even before the background check closes the
 *   giveaway; that check runs at startup and every few seconds, so restarts and overdue giveaways are handled by the
 *   backend, never by a dashboard timer. Tickets are frozen when entries close.
 * - A drawing runs in one IMMEDIATE transaction that also moves the giveaway to 'drawn', so it can't happen twice.
 *   Winners are picked with crypto.randomInt, proportionally to their tickets, distinct within a drawing; the ticket
 *   calculation of the whole pool is stored with the draw.
 * - Announcements go out after the change is committed; a failure is recorded and shown and never undoes a result.
 *
 * Logs hold ids, counts and outcomes — never chat text, tokens or entrant names.
 */
import crypto from 'node:crypto';
import {
  connectionsRepo,
  giveawaysRepo,
  SETTING_KEYS,
  settingsRepo,
  withTransaction,
  type Database,
  type GiveawayEntryRecord,
  type GiveawayRecord,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  createGiveawaySchema,
  DISCORD_BUTTON_REPLIES,
  EDITABLE_FIELDS,
  GIVEAWAY_BUTTONS,
  GIVEAWAY_ENTER,
  KICK_CHAT_MAX_CHARS,
  KICK_GIVEAWAY_MESSAGE_DEFAULTS,
  KICK_GIVEAWAY_MESSAGE_KINDS,
  kickGiveawayMessageSchema,
  redrawSchema,
  renderKickGiveawayMessage,
  setKickGiveawayMessagesSchema,
  updateGiveawaySchema,
  type CreateGiveawayInput,
  type DiscordChannelRef,
  type DiscordChannelsState,
  type EntryResult,
  type GiveawayAnnouncementView,
  type GiveawayPlatform,
  type GiveawaysState,
  type GiveawayView,
  type KickGiveawayMessageKind,
  type KickGiveawayMessages,
} from '@conduit/shared';
import { writeAudit, type AuditAction } from '../audit';
import { AppError, conflict, notFound } from '../errors';
import type { IncomingButton } from '../discord/discord-bot';
import type { KickRedemption, KickRewardInput } from '../kick/kick-chat-api';
import { parseInput } from '../validation';
import { giveawayMessage, parseGiveawayButtonId, type DiscordGiveaways } from '../discord/discord-giveaways';
import type { KickChatMessage, KickRedemptionEvent, KickSendOutcome } from '../kick/kick-chat-service';

type EntrySource = NonNullable<GiveawayEntryRecord['source']>;
/** Kick "{username} has entered the giveaway!" messages waiting at most; beyond this, new ones are skipped (bursts). */
const MAX_PENDING_ENTRY_ANNOUNCEMENTS = 10;
/** Button interactions remembered, so a duplicated event is answered once. */
const REMEMBERED_INTERACTIONS = 1000;
/** How often overdue giveaways are closed. Entries are also checked against the end time on every attempt. */
const CHECK_INTERVAL_MS = 5000;
/** How often pending Kick redemptions are fetched (in case a webhook was missed) while a reward is active. */
const REWARD_POLL_MS = 30_000;
/**
 * Kick's reasons for not deciding a redemption that still mean it's settled: NOT_PENDING (Kick already has a final
 * status; a webhook tells us which), NOT_FOUND / NOT_OWNED (nothing to decide). Anything else is tried again.
 */
const SETTLED_ON_KICK = new Set(['NOT_PENDING', 'NOT_FOUND', 'NOT_OWNED']);
/** An automatic close is announced only if noticed this soon after the end time (not after a long downtime). */
const CLOSE_ANNOUNCE_WINDOW_MS = 60_000;
/** "Entries are closed" in Kick chat at most this often, and only this soon after a giveaway closed. */
const CLOSED_REPLY_COOLDOWN_MS = 60_000;
const CLOSED_REPLY_WINDOW_MS = 30 * 60_000;
const MAX_SPACING_WAIT_MS = 10_000;
const REMEMBERED_MESSAGES = 1000;

/** Kick's channel points reward operations, on the main channel (KickChatService). */
export interface GiveawayKickRewards {
  rewardsAccess(): { ok: boolean; problem: string | null };
  onRedemption(listener: (r: KickRedemptionEvent) => void): () => void;
  createReward(reward: KickRewardInput): Promise<string>;
  updateReward(rewardId: string, patch: Partial<KickRewardInput>): Promise<void>;
  deleteReward(rewardId: string): Promise<void>;
  rewardRedemptions(rewardId: string, status?: 'pending' | 'accepted' | 'rejected'): Promise<KickRedemption[]>;
  decideRedemptions(decision: 'accept' | 'reject', ids: string[]): Promise<Array<{ id: string; reason: string }>>;
}

/** The parts of KickChatService giveaways use (narrow, so tests can substitute it). */
export interface GiveawayKickChat {
  onMessage(listener: (m: KickChatMessage) => void): () => void;
  sendResult(content: string): Promise<KickSendOutcome>;
  msUntilNextSend(): number;
  chatbotIdentity(): { userId: string | null; isMainAccount: boolean };
  /** Whether chat messages can be posted right now, and why not. */
  sendReadiness(): { ready: boolean; problem: string | null };
  /** Whether entries can arrive (the webhook subscription is active). */
  receiving(): boolean;
}

export interface GiveawayServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  kick: GiveawayKickChat;
  /** Kick Channel Points rewards (absent: bonus tickets unavailable, e.g. in unit tests of the core). */
  kickRewards?: GiveawayKickRewards;
  /** Whether the Discord bot is connected (its buttons respond), and why not. */
  discordReadiness: () => Promise<{ ready: boolean; note: string | null }>;
  sleep?: (ms: number) => Promise<void>;
  /** Random integer in [0, max) — crypto.randomInt by default; tests may substitute a deterministic one. */
  randomInt?: (max: number) => number;
  /** Discord announcements (absent: none, e.g. in unit tests of the core). */
  discord?: DiscordGiveaways;
  /** The configured Discord application; button clicks for any other application are refused. */
  discordApplicationId?: () => string | null;
  /** Kept for compatibility with callers; the embed no longer shows counts, so nothing is throttled any more. */
  discordEditIntervalMs?: number;
  /** How often pending redemptions are fetched from Kick (default 30 s). */
  rewardPollMs?: number;
}

/** One entry's ticket calculation (stored with each draw; private). */
export interface TicketLine {
  entryId: number;
  platform: GiveawayPlatform;
  platformUserId: string;
  base: 1;
  bonus: number;
  subscriber: boolean;
  multiplier: number;
  weight: number;
}

export class GiveawayService {
  private timer: NodeJS.Timeout | null = null;
  private rewardTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly randomInt: (max: number) => number;
  /** Kick chat messages are posted one at a time, in order. */
  private announcing: Promise<void> = Promise.resolve();
  /** Discord posts and edits run one at a time, in order. */
  private discordWork: Promise<void> = Promise.resolve();
  /** Kick reward calls (create, pause, delete, accept, reject) run one at a time, in order. */
  private rewardWork: Promise<void> = Promise.resolve();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenInteractions = new Set<string>();
  private pendingEntryAnnouncements = 0;
  private lastClosedReplyAt = 0;
  private readonly unsubscribe: Array<() => void> = [];

  private readonly lifecycleListeners = new Set<(e: GiveawayLifecycleEvent) => void>();

  /** Giveaway lifecycle events (after the change is committed): started, entries closed, winners drawn, redrawn. */
  onLifecycle(listener: (e: GiveawayLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private lifecycle(kind: GiveawayLifecycleEvent['kind'], g: GiveawayRecord, winners: ReadonlyArray<Pick<GiveawayEntryRecord, 'platform' | 'displayName'>> = []): void {
    const event: GiveawayLifecycleEvent = {
      kind,
      giveawayId: g.id,
      prize: g.prize,
      winnerCount: g.winnerCount,
      platforms: [...(g.allowKick ? (['kick'] as const) : []), ...(g.allowDiscord ? (['discord'] as const) : [])],
      winners: winners.map(entrantLabel),
    };
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        this.o.logger.error('giveaway lifecycle listener failed', { err });
      }
    }
  }

  constructor(private readonly o: GiveawayServiceOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.randomInt = o.randomInt ?? ((max) => crypto.randomInt(max));
    this.unsubscribe.push(o.kick.onMessage((m) => this.onKickMessage(m)));
    if (o.kickRewards) this.unsubscribe.push(o.kickRewards.onRedemption((r) => this.onKickRedemption(r)));
  }

  /** Closes overdue giveaways now and then every few seconds (also after a restart); keeps Kick rewards in sync. */
  start(): void {
    this.closeOverdue();
    if (this.timer) return;
    this.timer = setInterval(() => this.closeOverdue(), CHECK_INTERVAL_MS);
    this.timer.unref();
    if (this.o.kickRewards) {
      void this.syncRewards();
      this.rewardTimer = setInterval(() => void this.syncRewards(), this.o.rewardPollMs ?? REWARD_POLL_MS);
      this.rewardTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.rewardTimer) clearInterval(this.rewardTimer);
    this.timer = null;
    this.rewardTimer = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const u of this.unsubscribe.splice(0)) u();
    await this.idle();
  }

  /** Resolves when queued work (Kick chat, Discord, Kick rewards) has finished (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const kick = this.announcing;
      const discord = this.discordWork;
      const rewards = this.rewardWork;
      await Promise.all([kick, discord, rewards]);
      if (kick === this.announcing && discord === this.discordWork && rewards === this.rewardWork) return;
    }
  }

  // ── state ──

  async state(): Promise<GiveawaysState> {
    this.closeOverdue();
    const counts = new Map<string, Record<GiveawayPlatform, number>>();
    for (const c of giveawaysRepo.entryCounts(this.o.db)) {
      const entry = counts.get(c.giveawayId) ?? { kick: 0, discord: 0 };
      entry[c.platform] = c.n;
      counts.set(c.giveawayId, entry);
    }
    const kickSend = this.o.kick.sendReadiness();
    const receiving = this.o.kick.receiving();
    const discord = await this.o.discordReadiness().catch(() => ({ ready: false, note: 'Discord status is unavailable.' }));
    const all = giveawaysRepo.list(this.o.db);
    const rewards = this.o.kickRewards?.rewardsAccess() ?? { ok: false, problem: 'Kick Channel Points aren’t available.' };
    return {
      // Cancelled giveaways from before cancelling deleted them aren't shown.
      giveaways: all.filter((g) => g.status !== 'cancelled').map((g) => this.view(g, counts.get(g.id) ?? { kick: 0, discord: 0 })),
      entry: {
        kick: {
          command: GIVEAWAY_ENTER.kick,
          ready: receiving,
          note: receiving
            ? kickSend.ready
              ? null
              : `Entries work, but chat messages can't be posted: ${kickSend.problem ?? 'the chatbot account can’t send messages.'}`
            : 'Kick entries need Kick chat to be connected (Dashboard → Kick → Manage → 4. Live chat).',
        },
        discord: { command: `${GIVEAWAY_BUTTONS.enter.emoji} ${GIVEAWAY_BUTTONS.enter.label} button`, ready: discord.ready, note: discord.note },
      },
      discordChannelDefault: this.defaultChannel(),
      kickRewards: { available: rewards.ok, problem: rewards.problem },
      kickMessages: this.kickMessages(),
      hiddenCancelled: all.length - all.filter((g) => g.status !== 'cancelled').length,
    };
  }

  // ── Kick chat messages (editable) ──

  /** The Kick messages as they will be posted: each saved (still valid) text, or its default. */
  kickMessages(): KickGiveawayMessages {
    const saved = this.savedKickMessages();
    const out = { ...KICK_GIVEAWAY_MESSAGE_DEFAULTS };
    for (const kind of KICK_GIVEAWAY_MESSAGE_KINDS) {
      const checked = kickGiveawayMessageSchema(kind).safeParse(saved[kind]);
      if (checked.success) out[kind] = checked.data;
    }
    return out;
  }

  /**
   * Saves edited Kick messages (null restores a default). Everything is checked before anything is saved, and nothing is
   * sent: the saved text is exactly what is posted later, with its variables filled in.
   */
  async setKickMessages(raw: unknown): Promise<GiveawaysState> {
    const input = parseInput(setKickGiveawayMessagesSchema, raw);
    const saved = this.savedKickMessages();
    const changed: KickGiveawayMessageKind[] = [];
    for (const kind of KICK_GIVEAWAY_MESSAGE_KINDS) {
      const value = input[kind];
      if (value === undefined) continue;
      changed.push(kind);
      if (value === null || value === KICK_GIVEAWAY_MESSAGE_DEFAULTS[kind]) delete saved[kind];
      else saved[kind] = value;
    }
    settingsRepo.set(this.o.db, SETTING_KEYS.giveawayKickMessages, JSON.stringify(saved), this.iso());
    writeAudit(this.o.db, { action: 'giveaway.messages_updated', outcome: 'success', actorUserId: null, metadata: { messages: changed } }, this.o.now());
    this.o.logger.info('kick giveaway messages saved', { messages: changed });
    return this.state();
  }

  private savedKickMessages(): Partial<Record<KickGiveawayMessageKind, string>> {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.giveawayKickMessages);
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      const out: Partial<Record<KickGiveawayMessageKind, string>> = {};
      for (const kind of KICK_GIVEAWAY_MESSAGE_KINDS) {
        const value = v[kind];
        if (typeof value === 'string') out[kind] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private kickText(kind: KickGiveawayMessageKind, vars: Record<string, string>): string {
    return renderKickGiveawayMessage(kind, this.kickMessages()[kind], vars);
  }

  get(id: string): GiveawayView {
    return this.view(this.require(id));
  }

  // ── Start Giveaway ──

  /**
   * Start Giveaway (the API's create): checks everything first — fields, the one-open rule, platform connections, the
   * Discord channel's permissions, Kick Channel Points access — then opens the giveaway, creates the Kick reward and
   * posts the Discord embed. If the reward or the embed can't be set up, the giveaway is removed again and nothing
   * stays active; the error says why.
   */
  async createAndStart(raw: unknown): Promise<GiveawayView> {
    const input = this.parseCreate(raw);
    this.closeOverdue();
    const open = giveawaysRepo.findOpen(this.o.db);
    if (open) throw conflict(`“${open.prize}” is still running. End or cancel it before starting another giveaway.`);
    let channelName: string | null = null;
    if (input.platforms.includes('kick') && !connectionsRepo.listForRole(this.o.db, 'kick', 'primary').some((r) => r.status === 'connected'))
      throw new AppError('bad_request', 'Not started: connect your main Kick account (Dashboard → Kick) or turn off Kick entry.');
    if (input.platforms.includes('discord') && this.o.discord) {
      if (!input.discordChannel)
        throw new AppError('bad_request', 'Not started: choose the Discord channel for the giveaway embed, or turn off Discord entry.');
      const check = await this.o.discord.check(input.discordChannel);
      if (!check.ok) throw new AppError('bad_request', `Not started: ${check.problem}`);
      channelName = check.channelName;
    }
    if (input.kickReward) {
      const access = this.o.kickRewards?.rewardsAccess();
      if (!access?.ok) throw new AppError('bad_request', `Not started: ${access?.problem ?? 'Kick Channel Points aren’t available.'}`);
    }

    const g = this.createOpen(input, channelName, false);
    try {
      if (input.kickReward) await this.setUpReward(g);
      if (g.allowDiscord && g.discordChannelId && this.o.discord) {
        await this.enqueueDiscord(g.id, false);
        const after = giveawaysRepo.get(this.o.db, g.id);
        if (!after?.discordMessageId) throw new AppError('bad_request', `Not started: ${after?.discordDetail ?? 'the Discord announcement couldn’t be posted.'}`);
      }
    } catch (err) {
      await this.rollBackStart(g.id);
      if (err instanceof AppError) throw err;
      throw new AppError('bad_request', `Not started: ${err instanceof Error ? err.message : 'the giveaway couldn’t be set up.'}`);
    }
    const started = this.require(g.id);
    this.announce(started, 'started', startedMessage(started, this.kickMessages().started));
    this.lifecycle('started', started);
    await this.idle();
    return this.get(g.id);
  }

  /**
   * Opens a giveaway right away, without the platform checks of createAndStart (used by it, and by the core's tests).
   * Announces in Kick chat and posts the Discord embed in the background.
   */
  create(raw: unknown): GiveawayView {
    const g = this.createOpen(this.parseCreate(raw), null, true);
    return this.get(g.id);
  }

  private parseCreate(raw: unknown): CreateGiveawayInput {
    const input = parseInput(createGiveawaySchema, raw);
    assertChannelNeedsDiscord(input.discordChannel, input.platforms);
    return input;
  }

  private createOpen(input: CreateGiveawayInput, channelName: string | null, announce: boolean): GiveawayRecord {
    const now = this.o.now();
    const at = now.toISOString();
    const id = crypto.randomUUID();
    const endsAt = input.durationMinutes === null ? null : new Date(now.getTime() + input.durationMinutes * 60_000).toISOString();
    try {
      withTransaction(this.o.db, () => {
        giveawaysRepo.insertOpen(this.o.db, {
          id,
          prize: input.prize,
          description: input.description,
          winnerCount: input.winnerCount,
          durationMinutes: input.durationMinutes,
          allowKick: input.platforms.includes('kick'),
          allowDiscord: input.platforms.includes('discord'),
          createdAt: at,
          endsAt,
          discordGuildId: input.discordChannel?.guildId ?? null,
          discordChannelId: input.discordChannel?.channelId ?? null,
          discordChannelName: channelName,
          kickRewardCost: input.kickReward?.cost ?? null,
          kickRewardTickets: input.kickReward?.tickets ?? null,
          kickRewardTitle: input.kickReward?.title ?? null,
          subscriberMultiplier: input.subscriberMultiplier,
        });
        this.audit('giveaway.started', id, { reward: input.kickReward !== null, multiplier: input.subscriberMultiplier });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Another giveaway is already running. End or cancel it before starting this one.');
      throw err;
    }
    this.o.logger.info('giveaway started', { giveawayId: id, endsAt });
    this.rememberChannel(input.discordChannel);
    const g = this.require(id);
    if (announce) {
      this.announce(g, 'started', startedMessage(g, this.kickMessages().started));
      this.scheduleDiscord(id);
    }
    this.lifecycle('started', g);
    return g;
  }

  /** Undoes a start whose setup failed: the Kick reward (if created) and the giveaway are deleted. */
  private async rollBackStart(id: string): Promise<void> {
    const g = giveawaysRepo.get(this.o.db, id);
    withTransaction(this.o.db, () => {
      giveawaysRepo.remove(this.o.db, id);
      this.audit('giveaway.cancelled', id, { reason: 'start failed' });
    });
    if (g?.kickRewardId && this.o.kickRewards) await this.o.kickRewards.deleteReward(g.kickRewardId).catch(() => undefined);
    this.o.logger.warn('giveaway start rolled back', { giveawayId: id });
  }

  update(id: string, raw: unknown): GiveawayView {
    const existing = this.require(id);
    const input = parseInput(updateGiveawaySchema, raw);
    const allowed = EDITABLE_FIELDS[existing.status];
    const blocked = (Object.keys(input) as Array<keyof typeof input>).filter((k) => input[k] !== undefined && !allowed.includes(k));
    if (blocked.length > 0) {
      throw new AppError('validation_error', 'Some fields can’t be changed now', {
        issues: blocked.map((path) => ({ path, message: `Can’t be changed once the giveaway is ${existing.status}` })),
      });
    }
    const platforms = input.platforms;
    const allowDiscord = platforms ? platforms.includes('discord') : existing.allowDiscord;
    const current: DiscordChannelRef =
      existing.discordGuildId && existing.discordChannelId ? { guildId: existing.discordGuildId, channelId: existing.discordChannelId } : null;
    let channel: DiscordChannelRef = !allowDiscord ? null : input.discordChannel === undefined ? current : input.discordChannel;
    assertChannelNeedsDiscord(input.discordChannel ?? null, platforms ?? platformsOf(existing));
    const channelChanged = channel?.guildId !== current?.guildId || channel?.channelId !== current?.channelId;
    if (channelChanged && existing.discordMessageId) {
      // The posted announcement stays where it is; only one that was deleted in Discord can be replaced.
      if (existing.discordStatus !== 'missing' || !giveawaysRepo.forgetMissingDiscordMessage(this.o.db, id))
        throw conflict('The Discord announcement is already posted in its channel, so the channel can’t change.');
    }
    if (!channelChanged) channel = current;
    const ok = giveawaysRepo.updateDetails(this.o.db, id, existing.status, {
      prize: input.prize ?? existing.prize,
      description: input.description === undefined ? existing.description : input.description,
      winnerCount: input.winnerCount ?? existing.winnerCount,
      durationMinutes: input.durationMinutes === undefined ? existing.durationMinutes : input.durationMinutes,
      allowKick: platforms ? platforms.includes('kick') : existing.allowKick,
      allowDiscord,
      updatedAt: this.iso(),
      discordGuildId: channel?.guildId ?? null,
      discordChannelId: channel?.channelId ?? null,
      discordChannelName: channelChanged ? null : existing.discordChannelName,
    });
    if (!ok) throw conflict('The giveaway changed meanwhile. Reload and try again.');
    this.o.logger.info('giveaway updated', { giveawayId: id });
    if (channelChanged) this.rememberChannel(channel);
    if (existing.status !== 'draft') this.scheduleDiscord(id);
    return this.get(id);
  }

  /** Starts a giveaway left as a draft by an earlier version (drafts can't be created any more). */
  async startAndAnnounce(id: string): Promise<GiveawayView> {
    const g = this.require(id);
    if (g.status === 'draft' && g.allowDiscord && this.o.discord && (!g.discordGuildId || !g.discordChannelId)) {
      throw new AppError('bad_request', 'Not started: choose a Discord announcement channel (Edit), or turn off Discord entry.');
    }
    if (g.status === 'draft' && g.allowDiscord && g.discordGuildId && g.discordChannelId && this.o.discord) {
      const check = await this.o.discord.check({ guildId: g.discordGuildId, channelId: g.discordChannelId });
      if (!check.ok) throw new AppError('bad_request', `Not started: ${check.problem}`);
      giveawaysRepo.setDiscordChannelName(this.o.db, id, check.channelName);
    }
    this.startGiveaway(id);
    await this.idle();
    return this.get(id);
  }

  startGiveaway(id: string): GiveawayView {
    const g = this.require(id);
    if (g.status !== 'draft') throw conflict(`Only a draft can be started; this giveaway is ${g.status}.`);
    this.closeOverdue();
    const open = giveawaysRepo.findOpen(this.o.db);
    if (open) throw conflict(`“${open.prize}” is still running. End or cancel it before starting another giveaway.`);
    const now = this.o.now();
    const endsAt = g.durationMinutes === null ? null : new Date(now.getTime() + g.durationMinutes * 60_000).toISOString();
    try {
      withTransaction(this.o.db, () => {
        if (!giveawaysRepo.start(this.o.db, id, now.toISOString(), endsAt)) throw conflict('The giveaway changed meanwhile.');
        this.audit('giveaway.started', id);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Another giveaway is already running. End or cancel it before starting this one.');
      throw err;
    }
    this.o.logger.info('giveaway started', { giveawayId: id, endsAt });
    const started = this.require(id);
    this.announce(started, 'started', startedMessage(started, this.kickMessages().started));
    this.scheduleDiscord(id);
    this.lifecycle('started', started);
    return this.get(id);
  }

  end(id: string): GiveawayView {
    const g = this.require(id);
    if (g.status !== 'open') throw conflict(`Only a running giveaway can be ended; this one is ${g.status}.`);
    this.closeGiveaway(g, true);
    return this.get(id);
  }

  /**
   * Cancel: deletes the giveaway and everything that belongs to it (entries, draws, winners, redemptions). A completed
   * giveaway stays as a record and can't be cancelled. Afterwards, best effort: the Discord embed says the giveaway was
   * cancelled (buttons disabled), and the Kick reward is removed with its pending redemptions rejected.
   */
  async cancel(id: string): Promise<{ id: string; deleted: true }> {
    const g = this.require(id);
    if (g.status === 'drawn') throw conflict('Winners were already drawn; a completed giveaway can’t be cancelled.');
    const entries = giveawaysRepo.entryCount(this.o.db, id);
    withTransaction(this.o.db, () => {
      if (!giveawaysRepo.remove(this.o.db, id)) throw conflict('The giveaway changed meanwhile. Reload and try again.');
      this.audit('giveaway.cancelled', id, { entries });
    });
    this.o.logger.info('giveaway cancelled and deleted', { giveawayId: id });
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
    // The giveaway is gone; the outside world is told from the snapshot taken before deleting.
    if (this.o.discord && g.discordMessageId && g.discordStatus !== 'missing') {
      const discord = this.o.discord;
      const cancelled: GiveawayRecord = { ...g, status: 'cancelled' };
      this.discordWork = this.discordWork
        .then(async () => {
          const r = await discord.edit(cancelled, giveawayMessage(cancelled, { winners: [] }));
          if (!r.ok) this.o.logger.warn('discord embed of a cancelled giveaway not updated', { giveawayId: id });
        })
        .catch(() => undefined);
    }
    if (g.kickRewardId) this.retireReward(g.kickRewardId, 'delete', id);
    await this.idle();
    return { id, deleted: true };
  }

  /**
   * Deletes a completed giveaway and everything that belongs to it (entries, draws, winners, redemptions). Only
   * completed ones: a giveaway that hasn't been drawn is cancelled instead. The Discord post with its winners stays.
   */
  deleteCompleted(id: string): { id: string; deleted: true } {
    const g = this.require(id);
    if (g.status !== 'drawn') throw conflict('Only a completed giveaway can be deleted; cancel one that hasn’t been drawn.');
    const entries = giveawaysRepo.entryCount(this.o.db, id);
    withTransaction(this.o.db, () => {
      if (!giveawaysRepo.remove(this.o.db, id)) throw conflict('The giveaway changed meanwhile. Reload and try again.');
      this.audit('giveaway.deleted', id, { entries });
    });
    this.o.logger.info('completed giveaway deleted', { giveawayId: id });
    // Normally already removed from Kick when it was drawn; best effort in case it wasn't.
    if (g.kickRewardId) this.retireReward(g.kickRewardId, 'delete', id);
    return { id, deleted: true };
  }

  /**
   * Draws the winners (closing entries first if still open), proportionally to tickets. One transaction: the status
   * change to 'drawn' is the guard, so a second draw — a double click, two windows, a retried request — is refused.
   */
  draw(id: string): GiveawayView {
    const result = withTransaction(this.o.db, () => {
      const g = this.require(id);
      if (g.status === 'drawn') throw conflict('Winners were already drawn. Use Redraw to replace a winner.');
      if (g.status !== 'open' && g.status !== 'closed') throw conflict(`A ${g.status} giveaway can’t be drawn.`);
      const lines = this.ticketLines(g);
      if (lines.length === 0) throw conflict('Nobody has entered, so there is nothing to draw. Cancel the giveaway instead.');
      if (lines.length < g.winnerCount) {
        throw conflict(
          `Only ${lines.length} eligible ${lines.length === 1 ? 'entrant' : 'entrants'} for ${g.winnerCount} winners. Lower the number of winners (Edit) and draw again.`,
        );
      }
      const at = this.iso();
      const picks = this.pickWeighted(lines, g.winnerCount);
      const drawId = crypto.randomUUID();
      giveawaysRepo.insertDraw(this.o.db, {
        id: drawId,
        giveawayId: id,
        kind: 'initial',
        drawnAt: at,
        poolSize: lines.length,
        replacedWinnerId: null,
        reason: null,
        ticketSnapshot: JSON.stringify(lines),
      });
      picks.forEach((line, i) =>
        giveawaysRepo.insertWinner(this.o.db, { id: crypto.randomUUID(), giveawayId: id, drawId, entryId: line.entryId, position: i + 1, selectedAt: at }),
      );
      if (!giveawaysRepo.markDrawn(this.o.db, id, at)) throw conflict('The giveaway changed meanwhile. Reload and try again.');
      this.audit('giveaway.drawn', id, { winners: picks.length, pool: lines.length });
      return picks;
    });
    this.o.logger.info('giveaway drawn', { giveawayId: id, winners: result.length });
    const g = this.require(id);
    const entries = new Map(giveawaysRepo.entries(this.o.db, id).map((e) => [e.id, e]));
    this.announce(g, 'winners', winnersMessage(g.prize, result.map((l) => entries.get(l.entryId)!), this.kickMessages().winners));
    this.scheduleDiscord(id);
    this.lifecycle('drawn', g, result.map((l) => entries.get(l.entryId)!));
    if (g.kickRewardId) this.retireReward(g.kickRewardId, 'delete', id);
    return this.get(id);
  }

  /**
   * Replaces one current winner with a new pick, proportional to tickets, among entries that have never been selected
   * in this giveaway (current or replaced winners can't be picked again). Nothing is deleted: the replaced winner is
   * kept as 'replaced' and the redraw is its own draw record with its ticket snapshot.
   */
  redraw(id: string, raw: unknown): GiveawayView {
    const input = parseInput(redrawSchema, raw);
    const picked = withTransaction(this.o.db, () => {
      const g = this.require(id);
      if (g.status !== 'drawn') throw conflict('Only a completed giveaway can be redrawn.');
      const winners = giveawaysRepo.winners(this.o.db, id);
      const replaced = winners.find((w) => w.id === input.winnerId);
      if (!replaced) throw notFound('Winner');
      if (replaced.status !== 'won') throw conflict('That winner was already replaced.');
      const previouslySelected = new Set(winners.map((w) => w.entryId));
      const lines = this.ticketLines(g).filter((l) => !previouslySelected.has(l.entryId));
      if (lines.length === 0) throw conflict('Every entrant has already been drawn; there is nobody left to redraw.');
      const at = this.iso();
      const [line] = this.pickWeighted(lines, 1);
      const drawId = crypto.randomUUID();
      giveawaysRepo.insertDraw(this.o.db, {
        id: drawId,
        giveawayId: id,
        kind: 'redraw',
        drawnAt: at,
        poolSize: lines.length,
        replacedWinnerId: replaced.id,
        reason: input.reason,
        ticketSnapshot: JSON.stringify(lines),
      });
      if (!giveawaysRepo.markReplaced(this.o.db, id, replaced.id, at)) throw conflict('That winner was already replaced.');
      giveawaysRepo.insertWinner(this.o.db, { id: crypto.randomUUID(), giveawayId: id, drawId, entryId: line!.entryId, position: replaced.position, selectedAt: at });
      this.audit('giveaway.redrawn', id, { position: replaced.position, pool: lines.length });
      return line!;
    });
    this.o.logger.info('giveaway redrawn', { giveawayId: id });
    const g = this.require(id);
    const entry = giveawaysRepo.entries(this.o.db, id).find((e) => e.id === picked.entryId)!;
    this.announce(g, 'redraw', redrawMessage(g.prize, entry, this.kickMessages().redraw));
    this.scheduleDiscord(id);
    this.lifecycle('redrawn', g, [entry]);
    return this.get(id);
  }

  // ── tickets ──

  /** Every entry's tickets: (1 + bonus from accepted redemptions) × (verified subscriber ? multiplier : 1). */
  ticketLines(g: GiveawayRecord): TicketLine[] {
    const bonus = giveawaysRepo.bonusTickets(this.o.db, g.id);
    return giveawaysRepo.entries(this.o.db, g.id).map((e) => {
      const extra = e.platform === 'kick' ? (bonus.get(e.platformUserId) ?? 0) : 0;
      const subscriber = e.platform === 'kick' && e.subscriberVerified;
      const multiplier = subscriber ? g.subscriberMultiplier : 1;
      return {
        entryId: e.id,
        platform: e.platform,
        platformUserId: e.platformUserId,
        base: 1,
        bonus: extra,
        subscriber,
        multiplier,
        weight: (1 + extra) * multiplier,
      };
    });
  }

  /** `count` distinct lines, each pick with probability proportional to its weight (crypto.randomInt). */
  private pickWeighted(lines: TicketLine[], count: number): TicketLine[] {
    const pool = [...lines];
    const picks: TicketLine[] = [];
    for (let k = 0; k < count && pool.length > 0; k++) {
      const total = pool.reduce((sum, l) => sum + l.weight, 0);
      let r = this.randomInt(total);
      let i = 0;
      while (r >= pool[i]!.weight) {
        r -= pool[i]!.weight;
        i++;
      }
      picks.push(pool[i]!);
      pool.splice(i, 1);
    }
    return picks;
  }

  // ── entries ──

  /**
   * One entry attempt from a platform. The caller has verified the user's identity with the platform (signed Kick
   * event, Discord interaction). Idempotent: entering again changes nothing. `subscriber`: evidence from the signed
   * Kick chat event that the entrant is an active subscriber right now (evaluated once, at entry).
   */
  enter(
    platform: GiveawayPlatform,
    user: { id: string; name: string },
    source: EntrySource = platform === 'kick' ? 'chat' : 'command',
    subscriber: { messageId: string } | null = null,
  ): EntryResult {
    this.closeOverdue();
    const g = giveawaysRepo.findOpen(this.o.db);
    if (!g) return { outcome: 'no_giveaway' };
    if (g.endsAt !== null && Date.parse(g.endsAt) <= this.o.now().getTime()) return { outcome: 'closed', prize: g.prize };
    const platforms = platformsOf(g);
    if (!platforms.includes(platform)) return { outcome: 'platform_not_allowed', prize: g.prize, platforms };
    const ineligible = this.ineligibility(platform, user.id);
    if (ineligible) return { outcome: 'not_eligible', prize: g.prize, reason: ineligible };
    const id = user.id.trim();
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(id)) return { outcome: 'not_eligible', prize: g.prize, reason: 'Your account couldn’t be identified.' };
    const at = this.iso();
    const verified = platform === 'kick' && subscriber !== null;
    const added = giveawaysRepo.addEntry(this.o.db, {
      giveawayId: g.id,
      platform,
      platformUserId: id,
      displayName: displayName(user.name, id),
      enteredAt: at,
      source,
      subscriberVerified: verified,
      subscriberEvidence: verified
        ? JSON.stringify({ kind: 'kick_chat_subscriber_badge', messageId: subscriber!.messageId.slice(0, 100), at })
        : null,
    });
    if (!added) return { outcome: 'already_entered', prize: g.prize };
    this.o.logger.info('giveaway entry added', { giveawayId: g.id, platform, source });
    return { outcome: 'entered', prize: g.prize, entryCount: giveawaysRepo.entryCount(this.o.db, g.id) };
  }

  /** Kick: "!enter" as the first word of a chat message from the main channel (already signature-checked). */
  private onKickMessage(m: KickChatMessage): void {
    try {
      if (this.seen.has(m.messageId)) return;
      this.seen.add(m.messageId);
      if (this.seen.size > REMEMBERED_MESSAGES) this.seen.delete(this.seen.values().next().value!);
      const first = m.content.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (first !== GIVEAWAY_ENTER.kick) return;
      // The channel owner (from the verified event) can't enter their own giveaway; neither can the chatbot account.
      if (m.senderUserId === m.broadcasterUserId) return;
      // Subscriber status: Kick's "subscriber" badge on this signed chat event, i.e. at the moment of entering.
      const subscriber = m.badgeTypes.includes('subscriber') ? { messageId: m.messageId } : null;
      const result = this.enter('kick', { id: m.senderUserId, name: m.senderUsername }, 'chat', subscriber);
      // Only a new entry is announced (repeats and ineligible accounts stay silent). Never tickets, totals or odds.
      if (result.outcome === 'entered') this.say(this.kickText('entered', { user: displayName(m.senderUsername, m.senderUserId), prize: result.prize }), true);
      else if (result.outcome === 'closed' || (result.outcome === 'no_giveaway' && this.recentlyClosed())) this.replyClosed();
      else if (result.outcome !== 'already_entered' && result.outcome !== 'no_giveaway')
        this.o.logger.info('kick giveaway entry not added', { outcome: result.outcome });
    } catch (err) {
      this.o.logger.error('kick giveaway entry failed', { err });
    }
  }

  /** Whether a giveaway closed recently (so "!enter" gets a short "closed" answer instead of silence). */
  private recentlyClosed(): boolean {
    const cutoff = this.o.now().getTime() - CLOSED_REPLY_WINDOW_MS;
    return giveawaysRepo
      .list(this.o.db)
      .some((g) => g.allowKick && (g.status === 'closed' || g.status === 'drawn') && g.closedAt !== null && Date.parse(g.closedAt) >= cutoff);
  }

  private replyClosed(): void {
    const now = this.o.now().getTime();
    if (now - this.lastClosedReplyAt < CLOSED_REPLY_COOLDOWN_MS) return;
    this.lastClosedReplyAt = now;
    this.say(this.kickText('closedReply', {}), false);
  }

  /** Who can't enter, from verified platform data: the streamer's own accounts and the chatbot. */
  private ineligibility(platform: GiveawayPlatform, userId: string): string | null {
    if (platform === 'kick') {
      const own = connectionsRepo.listForRole(this.o.db, 'kick', 'primary').some((r) => r.externalAccountId === userId);
      if (own) return 'The channel owner can’t enter their own giveaway.';
      const bot = this.o.kick.chatbotIdentity().userId;
      const botAccount = connectionsRepo.listForRole(this.o.db, 'kick', 'bot').some((r) => r.externalAccountId === userId);
      if (botAccount || (bot !== null && bot === userId)) return 'The chatbot account can’t enter.';
      return null;
    }
    const own = connectionsRepo.listForRole(this.o.db, 'discord', 'primary').some((r) => r.externalAccountId === userId);
    return own ? 'The streamer’s own Discord account can’t enter.' : null;
  }

  // ── Kick Channel Points bonus tickets ──

  /** Creates the giveaway's dedicated reward on Kick (redemptions wait in Kick's queue until accepted or rejected). */
  private async setUpReward(g: GiveawayRecord): Promise<void> {
    const rewards = this.o.kickRewards!;
    let rewardId: string;
    try {
      rewardId = await rewards.createReward({
        title: g.kickRewardTitle!,
        description: `Bonus tickets for the giveaway: ${g.prize}. Type ${GIVEAWAY_ENTER.kick} in chat first.`.slice(0, 200),
        cost: g.kickRewardCost!,
        is_enabled: true,
        should_redemptions_skip_request_queue: false,
      });
    } catch (err) {
      throw new AppError('bad_request', `Not started: Kick couldn’t create the Channel Points reward (${err instanceof Error ? err.message : 'unknown error'}).`);
    }
    giveawaysRepo.setKickReward(this.o.db, g.id, { rewardId, status: 'active', detail: null });
    this.o.logger.info('kick giveaway reward created', { giveawayId: g.id });
  }

  /** A verified redemption event from Kick's webhook. */
  private onKickRedemption(r: KickRedemptionEvent): void {
    try {
      this.processRedemption({ ...r, redeemerUsername: r.redeemerUsername });
    } catch (err) {
      this.o.logger.error('kick redemption handling failed', { err });
    }
  }

  /**
   * Decides one redemption of a giveaway's reward, at most once per redemption id:
   * - accepted (bonus tickets) only if the giveaway is running, the redemption happened before the end time, and the
   *   redeemer already has an eligible Kick entry ("!enter" first);
   * - otherwise rejected, with the reason (Kick documents accept/reject only; whether a rejection returns the points
   *   is Kick's behaviour).
   * A redemption accepted here and later rejected on Kick loses its tickets while entries are open; tickets are frozen
   * when entries close. Kick is told the decision afterwards (retried until it succeeds).
   */
  processRedemption(r: { id: string; status: 'pending' | 'accepted' | 'rejected'; redeemedAt: string; rewardId: string; redeemerUserId: string; redeemerUsername?: string | null }): void {
    const g = giveawaysRepo.list(this.o.db).find((x) => x.kickRewardId === r.rewardId);
    if (!g) return; // not a giveaway reward: leave it to the streamer
    this.closeOverdue();
    const at = this.iso();
    const decision = withTransaction(this.o.db, () => {
      const current = giveawaysRepo.get(this.o.db, g.id)!;
      const existing = giveawaysRepo.getRedemption(this.o.db, r.id);
      const running = current.status === 'open' && (current.endsAt === null || Date.parse(current.endsAt) > this.o.now().getTime());
      if (existing) {
        if (r.status === 'rejected' && existing.status === 'accepted') {
          if (running) giveawaysRepo.revokeRedemption(this.o.db, r.id, 'Rejected on Kick', at);
          return null;
        }
        if (r.status !== 'pending' && !existing.kickSynced) giveawaysRepo.markRedemptionSynced(this.o.db, r.id);
        return null;
      }
      const base = { id: r.id, giveawayId: g.id, rewardId: r.rewardId, redeemerUserId: r.redeemerUserId, redeemerName: r.redeemerUsername ?? null, redeemedAt: r.redeemedAt, processedAt: at };
      if (r.status === 'rejected') {
        giveawaysRepo.insertRedemption(this.o.db, { ...base, status: 'rejected', reason: 'Rejected on Kick', tickets: 0, kickSynced: true });
        return null;
      }
      let reason: string | null = null;
      if (!running) reason = 'Entries were closed';
      else if (current.endsAt !== null && Date.parse(r.redeemedAt) > Date.parse(current.endsAt)) reason = 'Redeemed after the end time';
      else if (Date.parse(r.redeemedAt) < Date.parse(current.startedAt ?? current.createdAt) - 60_000) reason = 'Redeemed before the giveaway started';
      else if (!giveawaysRepo.findEntry(this.o.db, g.id, 'kick', r.redeemerUserId)) reason = `No giveaway entry (type ${GIVEAWAY_ENTER.kick} first)`;
      else if (this.ineligibility('kick', r.redeemerUserId)) reason = 'Not eligible';
      const accept = reason === null;
      // Already accepted on Kick (e.g. by the streamer): there is nothing left to tell Kick, whatever we decide.
      const synced = r.status === 'accepted';
      giveawaysRepo.insertRedemption(this.o.db, {
        ...base,
        status: accept ? 'accepted' : 'rejected',
        reason,
        tickets: accept ? current.kickRewardTickets! : 0,
        kickSynced: synced,
      });
      return synced ? null : (accept ? 'accept' : 'reject');
    });
    this.o.logger.info('kick redemption processed', { giveawayId: g.id, decision: decision ?? 'recorded' });
    if (decision) this.tellKick(decision, r.id);
  }

  /** Tells Kick an accept/reject decision; on failure it stays unsynced and is retried by syncRewards. */
  private tellKick(decision: 'accept' | 'reject', redemptionId: string): void {
    const rewards = this.o.kickRewards;
    if (!rewards) return;
    this.rewardWork = this.rewardWork
      .then(async () => {
        const failed = await rewards.decideRedemptions(decision, [redemptionId]);
        const f = failed.find((x) => x.id === redemptionId);
        if (!f || SETTLED_ON_KICK.has(f.reason)) giveawaysRepo.markRedemptionSynced(this.o.db, redemptionId);
      })
      .catch((err) => this.o.logger.warn('kick redemption decision not delivered', { kind: (err as { kind?: string })?.kind ?? 'unknown' }));
  }

  /**
   * Keeps rewards in sync with the giveaways (every few seconds, and at start): processes pending redemptions of the
   * running giveaway's reward (in case a webhook was missed), retries decisions Kick hasn't received, pauses a closed
   * giveaway's reward and deletes a finished one's.
   */
  async syncRewards(): Promise<void> {
    const rewards = this.o.kickRewards;
    if (!rewards || !rewards.rewardsAccess().ok) return;
    try {
      this.closeOverdue();
      for (const g of giveawaysRepo.list(this.o.db)) {
        if (!g.kickRewardId || g.kickRewardStatus === 'removed') continue;
        if (g.status === 'open') {
          const pending = await rewards.rewardRedemptions(g.kickRewardId, 'pending');
          for (const r of pending) this.processRedemption({ ...r, redeemerUsername: null });
        } else if (g.status === 'closed' && g.kickRewardStatus === 'active') {
          this.retireReward(g.kickRewardId, 'pause', g.id);
        } else if (g.status === 'drawn' || g.status === 'cancelled') {
          this.retireReward(g.kickRewardId, 'delete', g.id);
        }
      }
      for (const r of giveawaysRepo.unsyncedRedemptions(this.o.db)) this.tellKick(r.status === 'accepted' ? 'accept' : 'reject', r.id);
    } catch (err) {
      this.o.logger.warn('kick reward sync failed', { kind: (err as { kind?: string })?.kind ?? 'unknown' });
    }
  }

  /**
   * When entries close: the reward is paused and its pending redemptions rejected. When the giveaway is finished or
   * deleted: pending redemptions are rejected and the reward is deleted from Kick.
   */
  private retireReward(rewardId: string, how: 'pause' | 'delete', giveawayId: string): void {
    const rewards = this.o.kickRewards;
    if (!rewards) return;
    this.rewardWork = this.rewardWork
      .then(async () => {
        const pending = await rewards.rewardRedemptions(rewardId, 'pending').catch((err: unknown) => {
          // Tried again on the next sync while the giveaway exists; a deleted giveaway's reward is still removed.
          if (giveawaysRepo.get(this.o.db, giveawayId)) throw err;
          this.o.logger.warn('pending kick redemptions not listed', { giveawayId, kind: (err as { kind?: string })?.kind ?? 'unknown' });
          return [];
        });
        for (const r of pending) {
          if (giveawaysRepo.get(this.o.db, giveawayId)) this.processRedemption({ ...r, redeemerUsername: null });
        }
        // Only rejections Kick received (or that are settled there) count as delivered; the rest stay unsynced and are
        // retried by syncRewards.
        const ids = pending.map((r) => r.id);
        const undelivered = new Set<string>();
        for (let i = 0; i < ids.length; i += 25) {
          const batch = ids.slice(i, i + 25);
          const failed = await rewards.decideRedemptions('reject', batch).catch(() => batch.map((id) => ({ id, reason: 'UNDELIVERED' })));
          for (const f of failed) if (!SETTLED_ON_KICK.has(f.reason)) undelivered.add(f.id);
        }
        for (const id of ids) if (!undelivered.has(id) && giveawaysRepo.getRedemption(this.o.db, id)) giveawaysRepo.markRedemptionSynced(this.o.db, id);
        if (undelivered.size) this.o.logger.warn('kick redemptions not rejected yet; retrying later', { giveawayId, count: undelivered.size });
        if (how === 'pause') await rewards.updateReward(rewardId, { is_paused: true });
        else await rewards.deleteReward(rewardId);
        if (giveawaysRepo.get(this.o.db, giveawayId))
          giveawaysRepo.setKickReward(this.o.db, giveawayId, { status: how === 'pause' ? 'paused' : 'removed', detail: null });
        this.o.logger.info('kick giveaway reward retired', { giveawayId, how });
      })
      .catch((err) => {
        this.o.logger.warn('kick giveaway reward not retired', { giveawayId, how, kind: (err as { kind?: string })?.kind ?? 'unknown' });
        if (giveawaysRepo.get(this.o.db, giveawayId)) {
          const g = giveawaysRepo.get(this.o.db, giveawayId)!;
          giveawaysRepo.setKickReward(this.o.db, giveawayId, {
            status: g.kickRewardStatus,
            detail: `Kick couldn’t ${how} the reward yet; CONDUIT will try again. You can also ${how === 'pause' ? 'pause' : 'delete'} it on Kick.`,
          });
        }
      });
  }

  // ── background ──

  /** Closes open giveaways whose end time has passed. Safe to call any time (also from request handlers). */
  closeOverdue(): void {
    try {
      for (const g of giveawaysRepo.listOverdue(this.o.db, this.iso())) {
        const late = this.o.now().getTime() - Date.parse(g.endsAt!);
        this.closeGiveaway(g, late <= CLOSE_ANNOUNCE_WINDOW_MS);
      }
    } catch (err) {
      this.o.logger.error('closing overdue giveaways failed', { err });
    }
  }

  private closeGiveaway(g: GiveawayRecord, announce: boolean): void {
    const closed = withTransaction(this.o.db, () => {
      if (!giveawaysRepo.close(this.o.db, g.id, this.iso())) return false;
      this.audit('giveaway.ended', g.id, { entries: giveawaysRepo.entryCount(this.o.db, g.id) });
      return true;
    });
    if (!closed) return;
    this.o.logger.info('giveaway entries closed', { giveawayId: g.id });
    this.scheduleDiscord(g.id);
    if (g.kickRewardId) this.retireReward(g.kickRewardId, 'pause', g.id);
    if (announce) this.announce(g, 'closed', this.kickText('closed', { prize: g.prize }));
    this.lifecycle('closed', g);
  }

  // ── announcements (Kick chat) ──

  /**
   * A short public Kick chat message (entry confirmations, "entries are closed"), through the same queue, spacing and
   * send path as the other announcements. Entry confirmations are bounded during bursts (everyone is still entered).
   */
  private say(text: string, entry: boolean): void {
    if (!text) return; // an edited message that is empty once its variables are filled in
    if (entry && this.pendingEntryAnnouncements >= MAX_PENDING_ENTRY_ANNOUNCEMENTS) {
      this.o.logger.info('kick entry announcement skipped (busy)');
      return;
    }
    if (entry) this.pendingEntryAnnouncements++;
    this.announcing = this.announcing.then(async () => {
      try {
        if (!this.o.kick.sendReadiness().ready) return;
        for (let attempt = 0; ; attempt++) {
          const wait = this.o.kick.msUntilNextSend();
          if (wait > 0) await this.sleep(Math.min(wait, MAX_SPACING_WAIT_MS));
          const outcome = await this.o.kick.sendResult(fitKick(text));
          if (outcome.ok || !outcome.locallyThrottled || attempt > 0) {
            if (!outcome.ok) this.o.logger.info('kick giveaway message not posted', { outcome: outcome.outcome });
            return;
          }
        }
      } catch (err) {
        this.o.logger.error('kick giveaway message failed', { err });
      } finally {
        if (entry) this.pendingEntryAnnouncements--;
      }
    });
  }

  private announce(g: GiveawayRecord, kind: GiveawayAnnouncementView['kind'], text: string): void {
    if (!g.allowKick) return;
    this.announcing = this.announcing.then(async () => {
      const record = (outcome: GiveawayAnnouncementView['outcome'], detail: string | null) => {
        if (!giveawaysRepo.get(this.o.db, g.id)) return; // cancelled meanwhile
        giveawaysRepo.recordAnnouncement(this.o.db, g.id, { at: this.iso(), kind, outcome, detail });
        this.o.logger.info('giveaway announcement', { giveawayId: g.id, kind, outcome });
      };
      try {
        if (!text) return record('skipped', 'The message is empty once its variables are filled in.');
        const readiness = this.o.kick.sendReadiness();
        if (!readiness.ready) return record('skipped', readiness.problem ?? 'Kick chat isn’t ready.');
        for (let attempt = 0; ; attempt++) {
          const wait = this.o.kick.msUntilNextSend();
          if (wait > 0) await this.sleep(Math.min(wait, MAX_SPACING_WAIT_MS));
          const outcome = await this.o.kick.sendResult(fitKick(text));
          if (outcome.ok) return record('sent', null);
          if (outcome.locallyThrottled && attempt === 0) continue;
          return record(outcome.outcome, outcome.message);
        }
      } catch (err) {
        this.o.logger.error('giveaway announcement failed', { giveawayId: g.id, kind, err });
        try {
          record('failed', 'The announcement couldn’t be sent.');
        } catch {
          // The giveaway result is already saved; only the announcement note is lost.
        }
      }
    });
  }

  // ── Discord: buttons and the embed ──

  /** Channels the bot could announce in (for choosing one). */
  async discordChannels(): Promise<DiscordChannelsState> {
    if (!this.o.discord) return { guilds: [], problem: 'Discord announcements aren’t available.' };
    return this.o.discord.channels();
  }

  /**
   * A click on a giveaway's Enter Giveaway button (a component interaction on the bot's gateway). Everything is
   * resolved from the database — the custom_id names the giveaway and the click must come from its stored message,
   * channel and server — so buttons keep working after a restart. The answer is always private (ephemeral), sent as
   * the interaction's own response straight away, and a duplicated event is answered once.
   */
  async onDiscordButton(i: IncomingButton): Promise<void> {
    if (!/^\d{1,25}$/.test(i.id) || this.seenInteractions.has(i.id)) return;
    this.seenInteractions.add(i.id);
    if (this.seenInteractions.size > REMEMBERED_INTERACTIONS) this.seenInteractions.delete(this.seenInteractions.values().next().value!);
    let reply: string;
    try {
      reply = this.buttonOutcome(i);
    } catch (err) {
      this.o.logger.error('giveaway button failed', { err });
      reply = DISCORD_BUTTON_REPLIES.failed;
    }
    await i.reply(reply).catch((err) => this.o.logger.warn('could not answer giveaway button', { err }));
  }

  private buttonOutcome(i: IncomingButton): string {
    const R = DISCORD_BUTTON_REPLIES;
    const button = parseGiveawayButtonId(i.customId);
    const appId = this.o.discordApplicationId?.() ?? null;
    if (!button || (appId !== null && i.applicationId !== appId) || !/^\d{1,25}$/.test(i.userId)) return R.unavailable;
    const g = giveawaysRepo.get(this.o.db, button.giveawayId);
    // Only this giveaway's own (current) announcement message: not another message, channel or server.
    if (!g || !g.allowDiscord || !g.discordMessageId || g.discordMessageId !== i.messageId || g.discordChannelId !== i.channelId || g.discordGuildId !== i.guildId)
      return R.unavailable;
    this.closeOverdue();
    const current = giveawaysRepo.get(this.o.db, g.id);
    if (!current || current.status !== 'open' || (current.endsAt !== null && Date.parse(current.endsAt) <= this.o.now().getTime()))
      return R.closed;

    const result = this.enter('discord', { id: i.userId, name: i.userName }, 'command');
    this.o.logger.info('giveaway button', { giveawayId: g.id, outcome: result.outcome });
    switch (result.outcome) {
      case 'entered':
        return R.entered;
      case 'already_entered':
        return R.alreadyEntered;
      case 'not_eligible':
        return result.reason;
      default:
        return R.closed;
    }
  }

  /**
   * After the bot connects (start-up or reconnect): running giveaways' embeds are refreshed (an announcement posted
   * before buttons existed gets them), and announcements whose last update failed are updated again.
   */
  async onDiscordReady(): Promise<void> {
    if (!this.o.discord) return;
    this.closeOverdue();
    for (const g of giveawaysRepo.listWithDiscordMessage(this.o.db, ['open', 'closed', 'drawn'])) {
      if (g.discordStatus === 'missing') continue;
      if (g.status === 'open' || g.discordStatus === 'failed') this.scheduleDiscord(g.id);
    }
    await this.idle();
  }

  /**
   * Retries the Discord announcement: posts it if it isn't up yet (or reposts one deleted in Discord), otherwise updates
   * it. Checks the bot's access first, so a missing permission is reported instead of failing again.
   */
  async retryDiscord(id: string): Promise<GiveawayView> {
    const g = this.require(id);
    const discord = this.o.discord;
    if (!discord) throw conflict('Discord announcements aren’t available.');
    if (!g.allowDiscord || !g.discordGuildId || !g.discordChannelId) throw conflict('Choose a Discord channel for this giveaway first (Edit).');
    if (g.status === 'draft') throw conflict('The announcement is posted when the giveaway starts.');
    const repost = !g.discordMessageId || g.discordStatus === 'missing';
    if (repost) {
      const check = await discord.check({ guildId: g.discordGuildId, channelId: g.discordChannelId });
      if (!check.ok) {
        giveawaysRepo.recordDiscord(this.o.db, id, { status: 'failed', detail: check.problem, at: this.iso() });
        return this.get(id);
      }
      giveawaysRepo.setDiscordChannelName(this.o.db, id, check.channelName);
    }
    await this.enqueueDiscord(id, repost);
    return this.get(id);
  }

  /** Brings the Discord embed up to date (state changes only: the embed shows no counts). */
  private scheduleDiscord(id: string): void {
    if (!this.o.discord) return;
    const g = giveawaysRepo.get(this.o.db, id);
    if (!g || !g.allowDiscord || !g.discordChannelId) return;
    void this.enqueueDiscord(id, false);
  }

  private enqueueDiscord(id: string, repost: boolean): Promise<void> {
    const run = this.discordWork
      .then(() => this.syncDiscord(id, repost))
      .catch((err) => this.o.logger.error('discord giveaway announcement failed', { giveawayId: id, err }));
    this.discordWork = run;
    return run;
  }

  private async syncDiscord(id: string, repost: boolean): Promise<void> {
    const discord = this.o.discord!;
    const g = giveawaysRepo.get(this.o.db, id);
    if (!g || !g.allowDiscord || !g.discordChannelId || g.status === 'draft') return;
    const message = giveawayMessage(g, { winners: giveawaysRepo.winners(this.o.db, id) });
    const record = (status: 'posted' | 'failed' | 'missing', detail: string | null) => {
      if (giveawaysRepo.get(this.o.db, id)) giveawaysRepo.recordDiscord(this.o.db, id, { status, detail, at: this.iso() });
    };

    if (g.discordMessageId && !repost) {
      if (g.discordStatus === 'missing') return; // waits for Repost (or a new channel)
      const r = await discord.edit(g, message);
      if (r.ok) {
        record('posted', null);
        this.o.logger.info('discord giveaway updated', { giveawayId: id, status: g.status });
        return;
      }
      record(r.status, r.detail);
      if (r.retryAfterSeconds) this.retryLater(id, r.retryAfterSeconds);
      return;
    }
    if (g.status === 'cancelled') return;
    const r = await discord.post(g, message);
    if (!r.ok) {
      record(r.status, r.detail);
      if (r.retryAfterSeconds) this.retryLater(id, r.retryAfterSeconds);
      return;
    }
    if (!giveawaysRepo.setDiscordMessage(this.o.db, id, r.messageId, g.discordMessageId, this.iso())) {
      this.o.logger.warn('discord giveaway message not stored (changed meanwhile)', { giveawayId: id });
      return;
    }
    this.o.logger.info('discord giveaway posted', { giveawayId: id, status: g.status });
  }

  private retryLater(id: string, seconds: number): void {
    if (this.retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void this.enqueueDiscord(id, false);
    }, Math.min(Math.max(seconds, 1), 60) * 1000);
    timer.unref();
    this.retryTimers.set(id, timer);
  }

  private defaultChannel(): DiscordChannelRef {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.giveawayDiscordChannel);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { guildId?: unknown; channelId?: unknown };
      return typeof v.guildId === 'string' && /^\d{1,25}$/.test(v.guildId) && typeof v.channelId === 'string' && /^\d{1,25}$/.test(v.channelId)
        ? { guildId: v.guildId, channelId: v.channelId }
        : null;
    } catch {
      return null;
    }
  }

  private rememberChannel(ref: DiscordChannelRef): void {
    if (ref) settingsRepo.set(this.o.db, SETTING_KEYS.giveawayDiscordChannel, JSON.stringify(ref), this.iso());
  }

  // ── helpers ──

  private view(g: GiveawayRecord, counts?: Record<GiveawayPlatform, number>): GiveawayView {
    let byPlatform = counts;
    if (!byPlatform) {
      byPlatform = { kick: 0, discord: 0 };
      for (const c of giveawaysRepo.entryCounts(this.o.db)) if (c.giveawayId === g.id) byPlatform[c.platform] = c.n;
    }
    const lines = this.ticketLines(g);
    const redemptions = g.kickRewardCost !== null ? giveawaysRepo.redemptions(this.o.db, g.id) : [];
    return {
      id: g.id,
      prize: g.prize,
      description: g.description,
      status: g.status,
      winnerCount: g.winnerCount,
      durationMinutes: g.durationMinutes,
      platforms: platformsOf(g),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      startedAt: g.startedAt,
      endsAt: g.endsAt,
      closedAt: g.closedAt,
      drawnAt: g.drawnAt,
      cancelledAt: g.cancelledAt,
      entryCount: byPlatform.kick + byPlatform.discord,
      entriesByPlatform: byPlatform,
      ticketCount: lines.reduce((sum, l) => sum + l.weight, 0),
      subscriberMultiplier: g.subscriberMultiplier,
      verifiedSubscribers: lines.filter((l) => l.subscriber).length,
      kickReward:
        g.kickRewardCost !== null
          ? {
              title: g.kickRewardTitle ?? '',
              cost: g.kickRewardCost,
              tickets: g.kickRewardTickets ?? 1,
              rewardId: g.kickRewardId,
              status: g.kickRewardStatus,
              detail: g.kickRewardDetail,
              accepted: redemptions.filter((r) => r.status === 'accepted').length,
              rejected: redemptions.filter((r) => r.status === 'rejected').length,
            }
          : null,
      winners: giveawaysRepo.winners(this.o.db, g.id).map((w) => ({
        id: w.id,
        position: w.position,
        platform: w.platform,
        platformUserId: w.platformUserId,
        displayName: w.displayName,
        status: w.status,
        drawId: w.drawId,
        selectedAt: w.selectedAt,
        replacedAt: w.replacedAt,
      })),
      draws: giveawaysRepo.draws(this.o.db, g.id).map((d) => ({
        id: d.id,
        kind: d.kind,
        drawnAt: d.drawnAt,
        poolSize: d.poolSize,
        poolTickets: poolTickets(d.ticketSnapshot ?? null),
        replacedWinnerId: d.replacedWinnerId,
        reason: d.reason,
      })),
      announcement:
        g.announceAt && g.announceKind && g.announceOutcome
          ? { at: g.announceAt, kind: g.announceKind, outcome: g.announceOutcome, detail: g.announceDetail }
          : null,
      discord:
        g.discordGuildId && g.discordChannelId
          ? {
              guildId: g.discordGuildId,
              channelId: g.discordChannelId,
              channelName: g.discordChannelName,
              messageId: g.discordMessageId,
              status: g.discordStatus,
              detail: g.discordDetail,
              updatedAt: g.discordUpdatedAt,
            }
          : null,
    };
  }

  private require(id: string): GiveawayRecord {
    const g = /^[0-9a-f-]{36}$/.test(id) ? giveawaysRepo.get(this.o.db, id) : undefined;
    if (!g) throw notFound('Giveaway');
    return g;
  }

  private audit(action: AuditAction, giveawayId: string, extra: Record<string, unknown> = {}): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata: { giveawayId, ...extra } }, this.o.now());
  }

  private iso(): string {
    return this.o.now().toISOString();
  }
}

function poolTickets(snapshot: string | null): number | null {
  if (!snapshot) return null;
  try {
    const lines = JSON.parse(snapshot) as Array<{ weight?: unknown }>;
    return Array.isArray(lines) ? lines.reduce((sum, l) => sum + (typeof l.weight === 'number' ? l.weight : 0), 0) : null;
  } catch {
    return null;
  }
}

function platformsOf(g: GiveawayRecord): GiveawayPlatform[] {
  return [...(g.allowKick ? (['kick'] as const) : []), ...(g.allowDiscord ? (['discord'] as const) : [])];
}

/** A Discord announcement channel only makes sense when Discord is an entry platform. */
function assertChannelNeedsDiscord(channel: DiscordChannelRef | undefined, platforms: readonly GiveawayPlatform[]): void {
  if (channel && !platforms.includes('discord')) {
    throw new AppError('validation_error', 'Some fields are invalid', {
      issues: [{ path: 'discordChannel', message: 'Choose Discord as an entry platform to announce there' }],
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

/** What automations (and other listeners) learn about a giveaway change. Public facts only: never tickets or odds. */
export interface GiveawayLifecycleEvent {
  kind: 'started' | 'closed' | 'drawn' | 'redrawn';
  giveawayId: string;
  prize: string;
  winnerCount: number;
  platforms: Array<'kick' | 'discord'>;
  /** drawn: the winners; redrawn: the new winner (Kick as @name, Discord as "name (Discord)"). */
  winners: string[];
}

/** A display-name snapshot: single line, bounded; falls back to the id. */
function displayName(name: string, id: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return clean || id;
}

function entrantLabel(e: Pick<GiveawayEntryRecord, 'platform' | 'displayName'>): string {
  return e.platform === 'kick' ? `@${e.displayName}` : `${e.displayName} (Discord)`;
}

/** Public Kick start announcement (the saved template, filled in): how to enter, no counts or odds. */
export function startedMessage(g: GiveawayRecord, template = KICK_GIVEAWAY_MESSAGE_DEFAULTS.started): string {
  const how = [g.allowKick ? `type ${GIVEAWAY_ENTER.kick} in chat` : null, g.allowDiscord ? `click ${GIVEAWAY_BUTTONS.enter.label} on the Discord announcement` : null]
    .filter(Boolean)
    .join(' or ');
  const duration = g.durationMinutes === null ? '' : formatMinutes(g.durationMinutes);
  return renderKickGiveawayMessage('started', template, {
    prize: g.prize,
    how_to_enter: how,
    winner_count: String(g.winnerCount),
    winners_note: g.winnerCount > 1 ? `${g.winnerCount} winners.` : '',
    reward: g.kickRewardTitle ?? '',
    reward_note: g.kickRewardTitle ? `Redeem “${g.kickRewardTitle}” with Channel Points for bonus tickets.` : '',
    duration,
    closes_note: duration ? `Entries close in ${duration}.` : '',
  });
}

/** Public winner announcement: names and the prize only (never tickets or odds). */
export function winnersMessage(
  prize: string,
  winners: ReadonlyArray<Pick<GiveawayEntryRecord, 'platform' | 'displayName'>>,
  template = KICK_GIVEAWAY_MESSAGE_DEFAULTS.winners,
): string {
  return renderKickGiveawayMessage('winners', template, {
    prize,
    winners: winners.map(entrantLabel).join(', '),
    winner_label: winners.length === 1 ? 'Winner' : 'Winners',
  });
}

export function redrawMessage(
  prize: string,
  winner: Pick<GiveawayEntryRecord, 'platform' | 'displayName'>,
  template = KICK_GIVEAWAY_MESSAGE_DEFAULTS.redraw,
): string {
  return renderKickGiveawayMessage('redraw', template, { prize, winner: entrantLabel(winner) });
}

function formatMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} ${m === 1440 ? 'day' : 'days'}`;
  if (m % 60 === 0) return `${m / 60} ${m === 60 ? 'hour' : 'hours'}`;
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** Shortens a message to Kick's limit, ending with "…". */
export function fitKick(text: string): string {
  const chars = [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
  if (chars.length <= KICK_CHAT_MAX_CHARS) return text;
  return `${chars.slice(0, KICK_CHAT_MAX_CHARS - 1).join('').trimEnd()}…`;
}
