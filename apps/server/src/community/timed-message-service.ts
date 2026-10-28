/**
 * Timed Messages: one message posted repeatedly to a Kick chat or a Discord channel, every N minutes and/or after N new
 * chat messages there.
 *
 * - Time: checked every 15 seconds. The clock starts when the message is switched on (nothing is posted at that moment)
 *   and restarts after each post.
 * - Messages: counted live — Kick from the signed chat events (never the chatbot account or text CONDUIT just posted),
 *   Discord from the gateway's message events in that channel (never bots or webhooks). The count is stored with the
 *   timed message (timed_messages.messages_since), so a restart carries on where it left off: 15 of 20 before a
 *   restart means 5 more after it. Each count is one UPDATE statement, so no increment is lost; switching it on or
 *   off or changing its settings starts the count again, and a deleted message takes its count with it.
 * - Both: 'all' waits for both conditions; 'any' posts at whichever comes first. Each post restarts both: the clock
 *   from the post, and the count by subtracting the count the post was triggered with (messages that arrive while it
 *   is being sent count towards the next one). One post at a time per message with a minimum gap of 60 s, so
 *   overlapping triggers can never send twice.
 * - Sending goes through the existing paths: Kick via KickChatService (send spacing, token refresh, loop memory),
 *   Discord via DiscordPoster. A failure is recorded and retried after 5 minutes, never in a tight loop.
 * - Disabled messages are never sent: every check re-reads the stored enabled flag.
 */
import crypto from 'node:crypto';
import { timedMessagesRepo, type Database, type TimedMessageRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  TIMED_MIN_GAP_SECONDS,
  timedMessageSchema,
  type DiscordChannelsState,
  type TimedMessageConfig,
  type TimedMessageResult,
  type TimedMessagesState,
  type TimedMessageView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import type { GuildEvent } from '../discord/discord-bot';
import { parseInput } from '../validation';
import type { DiscordPoster } from '../discord/discord-poster';
import type { KickChatMessage, KickChatService } from '../kick/kick-chat-service';

const TICK_MS = 15_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const RECENT_KEPT = 10;

export interface TimedMessageServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  kick: Pick<KickChatService, 'onMessage' | 'sendResult' | 'sendReadiness' | 'msUntilNextSend' | 'chatbotIdentity' | 'wasRecentlySent' | 'mainChannelName'>;
  poster: Pick<DiscordPoster, 'post'>;
  discordChannels: () => Promise<DiscordChannelsState>;
  /** Whether the bot's gateway session is up (message counts for Discord need it). */
  discordConnected: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class TimedMessageService {
  private readonly sending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: TimedMessageServiceOptions) {}

  start(): void {
    if (this.timer) return;
    this.off = this.o.kick.onMessage((m) => this.onKickMessage(m));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  idle(): Promise<void> {
    return this.queue;
  }

  // ── management ─────────────────────────────────────────────────────────────

  async state(): Promise<TimedMessagesState> {
    const channels = await this.o.discordChannels().catch(() => null);
    const kick = this.o.kick.sendReadiness();
    return {
      timedMessages: timedMessagesRepo.list(this.o.db).map((r) => this.view(r, channels)),
      kick: { ready: kick.ready, problem: kick.ready ? null : (kick.problem ?? 'Kick chat can’t send messages.'), channel: this.o.kick.mainChannelName() },
      discord: {
        ready: channels !== null && channels.problem === null,
        problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.'),
        messageEvents: this.o.discordConnected(),
      },
    };
  }

  create(raw: unknown): TimedMessageView {
    const config = parseInput(timedMessageSchema, raw);
    const at = this.iso();
    const id = crypto.randomUUID();
    timedMessagesRepo.insert(this.o.db, { id, enabled: config.enabled, config: JSON.stringify(config), enabledAt: config.enabled ? at : null, createdAt: at, updatedAt: at });
    this.audit('timed_message.created', id, { platform: config.platform, enabled: config.enabled });
    return this.view(timedMessagesRepo.get(this.o.db, id)!, null);
  }

  update(id: string, raw: unknown): TimedMessageView {
    const current = timedMessagesRepo.get(this.o.db, id);
    if (!current) throw notFound('Timed message');
    const before = this.config(current);
    // A partial body (e.g. only { enabled }) is applied over the saved configuration, then validated as a whole.
    const merged = { ...(before ?? {}), ...(raw && typeof raw === 'object' ? raw : {}) };
    const config = parseInput(timedMessageSchema, merged);
    const turnedOn = config.enabled && !current.enabled;
    // Switched on or off, or its settings changed: the message count starts again (progress never carries over to a
    // different configuration). A save that changes nothing keeps it.
    const resetCount = turnedOn || JSON.stringify(before) !== JSON.stringify(config);
    timedMessagesRepo.update(this.o.db, id, { enabled: config.enabled, config: JSON.stringify(config), enabledAt: turnedOn ? this.iso() : config.enabled ? current.enabledAt : null, resetCount }, this.iso());
    this.audit('timed_message.updated', id, { enabled: config.enabled });
    return this.view(timedMessagesRepo.get(this.o.db, id)!, null);
  }

  /** A copy, switched off, named "… (copy)". */
  duplicate(id: string): TimedMessageView {
    const current = timedMessagesRepo.get(this.o.db, id);
    const config = current && this.config(current);
    if (!config) throw notFound('Timed message');
    return this.create({ ...config, name: `${config.name.slice(0, 53)} (copy)`, enabled: false });
  }

  delete(id: string): { id: string; deleted: true } {
    if (!timedMessagesRepo.delete(this.o.db, id)) throw notFound('Timed message');
    this.audit('timed_message.deleted', id, {});
    return { id, deleted: true };
  }

  // ── triggers ───────────────────────────────────────────────────────────────

  private onKickMessage(m: KickChatMessage): void {
    // People only: the chatbot account and text CONDUIT just posted (when the chatbot is the main account) never count.
    if (m.senderUserId === this.o.kick.chatbotIdentity().userId || this.o.kick.wasRecentlySent(m.content)) return;
    this.count((c) => c.platform === 'kick');
  }

  /** A Discord message (from the bot's gateway session). Bots and webhooks never count. */
  onDiscordEvent(e: GuildEvent): void {
    if (e.type !== 'message_create' || e.authorBot) return;
    this.count((c) => c.platform === 'discord' && c.channelId === e.channelId);
  }

  private count(matches: (c: TimedMessageConfig) => boolean): void {
    try {
      for (const r of timedMessagesRepo.list(this.o.db)) {
        if (!r.enabled) continue;
        const c = this.config(r);
        if (!c || c.messageCount === null || !matches(c)) continue;
        // One statement per message, so concurrent events can't lose an increment. Null: switched off meanwhile.
        const messagesSince = timedMessagesRepo.countMessage(this.o.db, r.id);
        if (messagesSince !== null) this.check({ ...r, messagesSince }, c);
      }
    } catch (err) {
      this.o.logger.error('timed message count failed', { err });
    }
  }

  /** Checks every enabled timed message's time interval. Public for tests (which drive the clock). */
  tick(): void {
    try {
      for (const r of timedMessagesRepo.list(this.o.db)) {
        if (!r.enabled) continue;
        const c = this.config(r);
        if (c && c.intervalMinutes !== null) this.check(r, c);
      }
    } catch (err) {
      this.o.logger.error('timed message tick failed', { err });
    }
  }

  private due(r: TimedMessageRecord, c: TimedMessageConfig): 'time' | 'messages' | 'both' | null {
    const now = this.o.now().getTime();
    const last = r.lastSentAt ? Date.parse(r.lastSentAt) : 0;
    if (last && now - last < TIMED_MIN_GAP_SECONDS * 1000) return null;
    const failed = this.failedAt.get(r.id);
    if (failed && now - failed < RETRY_AFTER_FAILURE_MS) return null;
    const anchor = Date.parse(r.lastSentAt ?? r.enabledAt ?? r.createdAt);
    const timeOk = c.intervalMinutes === null ? null : now - anchor >= c.intervalMinutes * 60_000;
    const countOk = c.messageCount === null ? null : r.messagesSince >= c.messageCount;
    if (timeOk !== null && countOk !== null) {
      if (c.combine === 'all') return timeOk && countOk ? 'both' : null;
      return timeOk && countOk ? 'both' : timeOk ? 'time' : countOk ? 'messages' : null;
    }
    return timeOk ? 'time' : countOk ? 'messages' : null;
  }

  private check(r: TimedMessageRecord, c: TimedMessageConfig): void {
    if (this.sending.has(r.id)) return;
    const reason = this.due(r, c);
    if (!reason) return;
    this.sending.add(r.id);
    this.queue = this.queue.then(() => this.send(r.id, reason)).finally(() => this.sending.delete(r.id));
  }

  private async send(id: string, reason: TimedMessageResult['reason']): Promise<void> {
    // Re-read: it may have been switched off or deleted since it became due.
    const r = timedMessagesRepo.get(this.o.db, id);
    const c = r && this.config(r);
    if (!r || !r.enabled || !c) return;
    let result: { ok: boolean; detail: string };
    try {
      result = c.platform === 'kick' ? await this.sendKick(c.content) : await this.sendDiscord(c);
    } catch (err) {
      this.o.logger.error('timed message send failed', { err });
      result = { ok: false, detail: 'Something went wrong sending it.' };
    }
    const at = this.iso();
    const recent = [{ at, ok: result.ok, reason, detail: result.detail }, ...parseRecent(r.recent)].slice(0, RECENT_KEPT);
    // Success subtracts the count read before sending (r.messagesSince); a failure keeps it for the retry.
    timedMessagesRepo.recordSend(this.o.db, id, { sentAt: result.ok ? at : null, recent: JSON.stringify(recent), countUsed: r.messagesSince });
    if (result.ok) this.failedAt.delete(id);
    else this.failedAt.set(id, this.o.now().getTime());
    this.o.logger.info('timed message', { id, platform: c.platform, reason, ok: result.ok });
  }

  private async sendKick(content: string): Promise<{ ok: boolean; detail: string }> {
    const readiness = this.o.kick.sendReadiness();
    if (!readiness.ready) return { ok: false, detail: `Kick chat can’t send: ${readiness.problem ?? 'not connected.'}` };
    for (let attempt = 0; ; attempt++) {
      const wait = this.o.kick.msUntilNextSend();
      if (wait > 0) await (this.o.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(Math.min(wait, 5000));
      const out = await this.o.kick.sendResult(content);
      if (out.ok) return { ok: true, detail: `Posted in ${out.result.channel}’s Kick chat.` };
      if (out.locallyThrottled && attempt === 0) continue;
      return { ok: false, detail: out.outcome === 'unconfirmed' ? `Kick may or may not have posted it: ${out.message}` : out.message };
    }
  }

  private async sendDiscord(c: Extract<TimedMessageConfig, { platform: 'discord' }>): Promise<{ ok: boolean; detail: string }> {
    const res = await this.o.poster.post(c.channelId, c.message);
    return res.ok ? { ok: true, detail: 'Posted in Discord.' } : { ok: false, detail: res.detail };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private config(r: TimedMessageRecord): TimedMessageConfig | null {
    try {
      const parsed = timedMessageSchema.safeParse({ ...JSON.parse(r.config), enabled: r.enabled });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private view(r: TimedMessageRecord, channels: DiscordChannelsState | null): TimedMessageView {
    const c = this.config(r);
    if (!c) throw new AppError('internal_error', 'A saved timed message is invalid');
    const anchor = Date.parse(r.lastSentAt ?? r.enabledAt ?? r.createdAt);
    let destination: string | null = null;
    let problem: string | null = null;
    if (c.platform === 'kick') {
      const ch = this.o.kick.mainChannelName();
      destination = ch ? `${ch}’s Kick chat` : 'Your Kick chat';
      // Whether Kick chat is connected is account status: shown on the Dashboard (and as a pop-up when it changes).
    } else {
      const guild = channels?.guilds.find((g) => g.id === c.guildId);
      const channel = guild?.channels.find((x) => x.id === c.channelId);
      destination = channel && guild ? `#${channel.name} in ${guild.name}` : null;
      if (channels && !channel) problem = 'The bot can’t see that channel any more.';
      else if (channel && channel.missing.length) problem = `The bot is missing ${channel.missing.join(', ')} in #${channel.name}.`;
    }
    return {
      ...c,
      id: r.id,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastSentAt: r.lastSentAt,
      messagesSince: r.messagesSince,
      nextDueAt: r.enabled && c.intervalMinutes !== null ? new Date(anchor + c.intervalMinutes * 60_000).toISOString() : null,
      recent: parseRecent(r.recent),
      destination,
      problem,
    };
  }

  private audit(action: 'timed_message.created' | 'timed_message.updated' | 'timed_message.deleted', id: string, extra: Record<string, unknown>): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata: { id, ...extra } }, this.o.now());
  }

  private iso(): string {
    return this.o.now().toISOString();
  }
}

function parseRecent(json: string): TimedMessageResult[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as TimedMessageResult[]) : [];
  } catch {
    return [];
  }
}
