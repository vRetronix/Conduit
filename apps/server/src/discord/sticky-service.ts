/**
 * Discord Sticky Messages: keeps a message at the bottom of a channel by reposting it after people post.
 *
 * Discord can't move a message, so "sticky" means: post a new copy, then delete the previous one. To keep that calm:
 * - only messages from people count (bots, webhooks and the sticky itself never do — no repost loops);
 * - after the configured number of messages, one repost is scheduled no sooner than the cooldown after the last one,
 *   so a burst of messages causes a single repost;
 * - nothing is reposted when the sticky is still the newest message in the channel;
 * - each sticky runs one step at a time, and the new copy's id is saved before the old copy is deleted, so a crash or
 *   restart can't leave two copies behind (at start-up and when the bot reconnects, each sticky checks the channel's
 *   newest message and reposts only if it isn't the sticky);
 * - if someone deletes the sticky, it's posted again after the cooldown.
 * Needs View Channel, Send Messages, Read Message History (and Embed Links for embeds) in the channel; no privileged
 * intent (the bot never reads message text).
 */
import crypto from 'node:crypto';
import { stickyRepo, type Database, type StickyRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { missingDiscordPermissions, stickyMessageSchema, type DiscordChannelsState, type StickyMessageConfig, type StickyMessagesState, type StickyMessageView } from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import type { GuildEvent } from './discord-bot';
import { parseInput } from '../validation';
import type { DiscordPoster } from './discord-poster';

const RECENT_KEPT = 10;
/** Even with a short cooldown, wait a moment after the last message (several people often post together). */
const MIN_DELAY_MS = 2000;

export interface StickyServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  poster: Pick<DiscordPoster, 'post' | 'delete' | 'latestMessageId'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
  discordConnected: () => boolean;
  /** The bot's own user id (its messages never count). */
  botUserId: () => string | null;
}

export class StickyService {
  private readonly counts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Newest message seen per channel (to know whether the sticky is still at the bottom). */
  private readonly newest = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly o: StickyServiceOptions) {}

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Waits for every sticky's pending step (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** Runs every scheduled repost now instead of waiting for its cooldown (tests). */
  async flush(): Promise<void> {
    const ids = [...this.timers.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id)!);
      this.timers.delete(id);
      void this.run(id, () => this.repost(id, 'new messages'));
    }
    await this.idle();
  }

  // ── management ─────────────────────────────────────────────────────────────

  async state(): Promise<StickyMessagesState> {
    const channels = await this.o.discordChannels().catch(() => null);
    return {
      stickies: stickyRepo.list(this.o.db).map((r) => this.view(r, channels)),
      discord: {
        ready: channels !== null && channels.problem === null,
        problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.'),
        messageEvents: this.o.discordConnected(),
      },
    };
  }

  async create(raw: unknown): Promise<StickyMessageView> {
    const config = parseInput(stickyMessageSchema, raw);
    await this.checkChannel(config);
    if (stickyRepo.byChannel(this.o.db, config.channelId)) throw new AppError('conflict', 'That channel already has a sticky message. Edit it instead.');
    const id = crypto.randomUUID();
    stickyRepo.insert(this.o.db, { id, enabled: config.enabled, guildId: config.guildId, channelId: config.channelId, config: JSON.stringify(config), at: this.iso() });
    this.audit('sticky.created', id);
    if (config.enabled) await this.run(id, () => this.repost(id, 'created'));
    return this.view(stickyRepo.get(this.o.db, id)!, null);
  }

  async update(id: string, raw: unknown): Promise<StickyMessageView> {
    const current = stickyRepo.get(this.o.db, id);
    const before = current && this.config(current);
    if (!current || !before) throw notFound('Sticky message');
    const config = parseInput(stickyMessageSchema, { ...before, ...(raw && typeof raw === 'object' ? raw : {}) });
    if (config.enabled) await this.checkChannel(config);
    if (config.channelId !== current.channelId) {
      const other = stickyRepo.byChannel(this.o.db, config.channelId);
      if (other && other.id !== id) throw new AppError('conflict', 'That channel already has a sticky message.');
    }
    await this.run(id, async () => {
      const moved = config.channelId !== current.channelId;
      const contentChanged = JSON.stringify(config.message) !== JSON.stringify(before.message);
      // The posted copy is removed when it's switched off, moved, or its content changed (a fresh copy follows).
      if (current.postedMessageId && (!config.enabled || moved || contentChanged)) {
        await this.o.poster.delete(current.channelId, current.postedMessageId);
        stickyRepo.setPosted(this.o.db, id, null, null);
      }
      stickyRepo.update(this.o.db, id, { enabled: config.enabled, guildId: config.guildId, channelId: config.channelId, config: JSON.stringify(config) }, this.iso());
      this.cancel(id);
      if (config.enabled && (moved || contentChanged || !current.enabled || !current.postedMessageId)) await this.repost(id, 'updated');
    });
    this.audit('sticky.updated', id);
    return this.view(stickyRepo.get(this.o.db, id)!, null);
  }

  async delete(id: string): Promise<{ id: string; deleted: true }> {
    const current = stickyRepo.get(this.o.db, id);
    if (!current) throw notFound('Sticky message');
    await this.run(id, async () => {
      this.cancel(id);
      if (current.postedMessageId) await this.o.poster.delete(current.channelId, current.postedMessageId);
      stickyRepo.delete(this.o.db, id);
    });
    this.audit('sticky.deleted', id);
    return { id, deleted: true };
  }

  /** Permissions the sticky needs in its channel, checked before it's switched on. */
  private async checkChannel(c: StickyMessageConfig): Promise<void> {
    const channels = await this.o.discordChannels(true);
    const guild = channels.guilds.find((g) => g.id === c.guildId);
    const channel = guild?.channels.find((x) => x.id === c.channelId);
    if (!channel) throw new AppError('validation_error', 'Choose a channel the bot can see', { issues: [{ path: 'channelId', message: channels.problem ?? 'The bot can’t see that channel.' }] });
    const missing = missingDiscordPermissions(channel.permissions, ['viewChannel', 'sendMessages', 'readMessageHistory', ...(c.message.embed ? (['embedLinks'] as const) : [])]);
    if (missing.length)
      throw new AppError('validation_error', 'The bot is missing permissions there', {
        issues: [{ path: 'channelId', message: `The bot needs ${missing.join(', ')} in #${channel.name}. Give its role these in the channel’s permissions (Edit Channel → Permissions).` }],
      });
  }

  // ── events ─────────────────────────────────────────────────────────────────

  /** Server events from the bot's gateway session. */
  onDiscordEvent(e: GuildEvent): void {
    try {
      if (e.type === 'message_create') {
        this.newest.set(e.channelId, e.messageId);
        if (e.authorBot || e.authorId === this.o.botUserId()) return; // bots (and the sticky itself) never count
        const s = stickyRepo.byChannel(this.o.db, e.channelId);
        if (!s || !s.enabled) return;
        const c = this.config(s);
        if (!c) return;
        const n = (this.counts.get(s.id) ?? 0) + 1;
        this.counts.set(s.id, n);
        if (n >= c.messagesBeforeRepost) this.schedule(s, c);
      } else if (e.type === 'message_delete' || e.type === 'message_delete_bulk') {
        const ids = e.type === 'message_delete' ? [e.messageId] : e.messageIds;
        const s = stickyRepo.byChannel(this.o.db, e.channelId);
        if (s?.postedMessageId && ids.includes(s.postedMessageId)) {
          // Someone removed the sticky: forget that copy and post it again after the cooldown.
          stickyRepo.setPosted(this.o.db, s.id, null, null);
          const c = this.config(s);
          if (s.enabled && c) this.schedule(s, c);
        }
      }
    } catch (err) {
      this.o.logger.error('sticky event failed', { err });
    }
  }

  /** At start-up and on every new bot session: repost any enabled sticky that isn't the newest message. */
  async recover(): Promise<void> {
    for (const s of stickyRepo.list(this.o.db)) {
      if (!s.enabled) continue;
      void this.run(s.id, async () => {
        const latest = await this.o.poster.latestMessageId(s.channelId);
        if (!latest.ok) {
          stickyRepo.setProblem(this.o.db, s.id, latest.detail);
          this.note(s.id, false, `Couldn’t check the channel: ${latest.detail}`);
          return;
        }
        if (latest.messageId && latest.messageId === stickyRepo.get(this.o.db, s.id)?.postedMessageId) return; // still at the bottom
        await this.repost(s.id, 'recovery');
      });
    }
    await this.idle();
  }

  private schedule(s: StickyRecord, c: StickyMessageConfig): void {
    if (this.timers.has(s.id)) return; // one repost per burst
    const last = s.lastPostedAt ? Date.parse(s.lastPostedAt) : 0;
    const delay = Math.max(MIN_DELAY_MS, last + c.cooldownSeconds * 1000 - this.o.now().getTime());
    const t = setTimeout(() => {
      this.timers.delete(s.id);
      void this.run(s.id, () => this.repost(s.id, 'new messages'));
    }, delay);
    t.unref();
    this.timers.set(s.id, t);
  }

  private cancel(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.counts.delete(id);
  }

  /** One step at a time per sticky. */
  private run(id: string, step: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(step).catch((err: unknown) => this.o.logger.error('sticky step failed', { err }));
    this.chains.set(id, next);
    return next;
  }

  private async repost(id: string, why: string): Promise<void> {
    const s = stickyRepo.get(this.o.db, id);
    const c = s && this.config(s);
    if (!s || !c || !s.enabled) return;
    this.counts.set(id, 0);
    if (s.postedMessageId && this.newest.get(s.channelId) === s.postedMessageId) return; // already at the bottom
    const posted = await this.o.poster.post(s.channelId, c.message);
    if (!posted.ok) {
      stickyRepo.setProblem(this.o.db, id, posted.detail);
      this.note(id, false, posted.detail);
      return;
    }
    // Save the new copy first, then remove the old one: never two copies after a crash.
    stickyRepo.setPosted(this.o.db, id, posted.messageId, this.iso());
    this.newest.set(s.channelId, posted.messageId);
    if (s.postedMessageId) await this.o.poster.delete(s.channelId, s.postedMessageId);
    this.note(id, true, why === 'created' ? 'Posted.' : why === 'recovery' ? 'Reposted after a restart (it wasn’t the newest message).' : 'Moved to the bottom.');
  }

  private note(id: string, ok: boolean, detail: string): void {
    const s = stickyRepo.get(this.o.db, id);
    if (!s) return;
    let recent: StickyMessageView['recent'] = [];
    try {
      recent = JSON.parse(s.recent) as StickyMessageView['recent'];
    } catch {
      recent = [];
    }
    stickyRepo.setRecent(this.o.db, id, JSON.stringify([{ at: this.iso(), ok, detail }, ...recent].slice(0, RECENT_KEPT)));
  }

  private config(r: StickyRecord): StickyMessageConfig | null {
    try {
      const parsed = stickyMessageSchema.safeParse({ ...JSON.parse(r.config), enabled: r.enabled });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private view(r: StickyRecord, channels: DiscordChannelsState | null): StickyMessageView {
    const c = this.config(r);
    if (!c) throw new AppError('internal_error', 'A saved sticky message is invalid');
    const guild = channels?.guilds.find((g) => g.id === r.guildId);
    const channel = guild?.channels.find((x) => x.id === r.channelId);
    let recent: StickyMessageView['recent'] = [];
    try {
      recent = JSON.parse(r.recent) as StickyMessageView['recent'];
    } catch {
      recent = [];
    }
    const problem = r.problem ?? (channels && !channel ? 'The bot can’t see that channel any more.' : null);
    return {
      ...c,
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      postedMessageId: r.postedMessageId,
      lastPostedAt: r.lastPostedAt,
      destination: channel && guild ? `#${channel.name} in ${guild.name}` : null,
      status: !r.enabled ? 'off' : problem ? 'problem' : 'active',
      problem,
      recent,
    };
  }

  private audit(action: 'sticky.created' | 'sticky.updated' | 'sticky.deleted', id: string): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata: { id } }, this.o.now());
  }

  private iso(): string {
    return this.o.now().toISOString();
  }
}
