/**
 * Stream Notifications: a Discord post when a streamer goes live, optionally deleted when the stream ends.
 *
 * Kick live status comes from Kick's public channel API (GET /public/v1/channels?slug=…, 50 channels per request) with
 * an app access token from the user's own Kick app (client credentials) — public information, readable for any channel,
 * acting as the app rather than as any account. It is checked every minute while CONDUIT runs. Kick's webhooks only
 * cover your own channel, so polling is what works for other streamers.
 *
 * Exactly one post per live session:
 * - a session is Kick's stream start time (or, if Kick doesn't send one, the first time CONDUIT saw it live);
 * - the session and the posted message id (and its channel) are saved in the database, so checks after a restart
 *   recognise a session that was already announced;
 * - a failed post is retried on later checks (at most 5 times per session); a successful one never repeats.
 * Kick makes a stream's first thumbnail a few minutes after it starts, so a post made at go-live usually has no
 * image yet. While the stream is live, CONDUIT edits its post to add the stream thumbnail as soon as Kick has one, then
 * refreshes it at most every 10 minutes (edits never ping anyone). If the channel info comes
 * without a thumbnail, Kick's livestreams endpoint is asked for it.
 * When the stream ends and "delete when ended" is on, exactly that session's message is deleted (already deleted
 * counts as done). Unknown channels, Kick or Discord outages and missing permissions are reported, never guessed: a
 * channel is only treated as live when Kick says so.
 */
import crypto from 'node:crypto';
import { notifiersRepo, type Database, type NotifierRecord, type NotifierState } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  canonicalNotifierVariables,
  fillTemplate,
  missingDiscordPermissions,
  notifierSchema,
  testNotificationSchema,
  type DiscordChannelsState,
  type NotifierConfig,
  type NotifierView,
  type StreamNotificationsState,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import { KickApiError, type KickChannelInfo, type KickChatApi } from './kick-chat-api';
import { parseInput } from '../validation';
import type { DiscordPoster } from '../discord/discord-poster';

export const NOTIFICATION_POLL_SECONDS = 60;
const MAX_POST_ATTEMPTS = 5;
/** How often a live post's stream thumbnail is refreshed, once it has one. */
export const THUMBNAIL_REFRESH_MINUTES = 10;

export interface StreamNotificationServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  kickApi: Pick<KickChatApi, 'channelsBySlugs' | 'usersByIds' | 'livestreamThumbnails'>;
  /** App access token from the user's Kick app; throws when the app isn't configured. */
  kickAppToken: () => Promise<{ token: string; expiresAt: number }>;
  kickConfigured: () => Promise<boolean>;
  poster: Pick<DiscordPoster, 'post' | 'edit' | 'delete'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
}

export class StreamNotificationService {
  private timer: NodeJS.Timeout | null = null;
  private token: { token: string; expiresAt: number } | null = null;
  private running: Promise<void> | null = null;
  private lastProblem: string | null = null;
  /** The thumbnail each live post currently shows (by notifier), so it's edited only when Kick has a new one. */
  private readonly shownThumbnails = new Map<string, { messageId: string; thumbnail: string; at: number }>();

  constructor(private readonly o: StreamNotificationServiceOptions) {}

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), NOTIFICATION_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── management ─────────────────────────────────────────────────────────────

  async state(): Promise<StreamNotificationsState> {
    const channels = await this.o.discordChannels().catch(() => null);
    const kickReady = await this.o.kickConfigured();
    return {
      notifiers: notifiersRepo.list(this.o.db).map((r) => this.view(r, channels)),
      kick: {
        ready: kickReady && this.lastProblem === null,
        problem: kickReady ? this.lastProblem : 'Set up your Kick app first (Dashboard → Kick → Connect): CONDUIT reads public live status with it.',
        pollSeconds: NOTIFICATION_POLL_SECONDS,
      },
      discord: { ready: channels !== null && channels.problem === null, problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.') },
    };
  }

  async create(raw: unknown): Promise<NotifierView> {
    const c = canonicalNotifierVariables(parseInput(notifierSchema, raw));
    await this.checkDestination(c);
    const known = await this.lookup(c.channel);
    if (notifiersRepo.list(this.o.db).some((n) => n.platform === c.platform && n.channelSlug === c.channel && n.discordChannelId === c.channelId))
      throw new AppError('conflict', 'That streamer already posts to that channel.');
    const id = crypto.randomUUID();
    notifiersRepo.insert(this.o.db, { id, platform: c.platform, channelSlug: c.channel, discordChannelId: c.channelId, enabled: c.enabled, config: JSON.stringify(c), at: this.iso() });
    if (known) {
      // The current state counts as already seen: a streamer who is live right now isn't announced the moment they're
      // added (only their next live session is).
      notifiersRepo.setState(this.o.db, id, {
        broadcasterId: known.broadcasterUserId,
        live: known.live,
        sessionKey: known.live ? sessionKey(known, this.iso()) : null,
        liveSince: known.live ? known.startTime : null,
        title: known.title,
        category: known.category,
        lastCheckedAt: this.iso(),
        // No retries for a session that was already live when it was added.
        notifyAttempts: known.live ? MAX_POST_ATTEMPTS : 0,
        status: known.live ? 'Live when added: the next stream will be announced.' : 'Offline. Waiting for the next stream.',
      });
      void this.refreshProfiles([id]);
    } else notifiersRepo.setState(this.o.db, id, { status: 'Added. Kick couldn’t be checked yet; it will be on the next check.' });
    this.audit('notifier.created', id, { platform: c.platform });
    return this.view(notifiersRepo.get(this.o.db, id)!, null);
  }

  async update(id: string, raw: unknown): Promise<NotifierView> {
    const r = notifiersRepo.get(this.o.db, id);
    const before = r && this.config(r);
    if (!r || !before) throw notFound('Notification');
    const c = canonicalNotifierVariables(parseInput(notifierSchema, { ...before, ...(raw && typeof raw === 'object' ? raw : {}) }));
    if (c.enabled) await this.checkDestination(c);
    if (c.channel !== r.channelSlug) await this.lookup(c.channel);
    notifiersRepo.updateConfig(this.o.db, id, { channelSlug: c.channel, discordChannelId: c.channelId, enabled: c.enabled, config: JSON.stringify(c) }, this.iso());
    if (c.channel !== r.channelSlug) notifiersRepo.setState(this.o.db, id, { broadcasterId: null, displayName: null, avatarUrl: null, live: null, sessionKey: null, status: 'Streamer changed; checking on the next check.' });
    this.audit('notifier.updated', id, { enabled: c.enabled });
    return this.view(notifiersRepo.get(this.o.db, id)!, null);
  }

  async delete(id: string): Promise<{ id: string; deleted: true }> {
    if (!notifiersRepo.delete(this.o.db, id)) throw notFound('Notification');
    this.audit('notifier.deleted', id, {});
    return { id, deleted: true };
  }

  /**
   * Posts a test of a notification (not saved) to its Discord channel, with the streamer's real current data from Kick
   * (title and category; the thumbnail only while they're live). Marked as a test; the role is shown but not pinged.
   */
  async test(raw: unknown): Promise<{ ok: boolean; message: string; live: boolean | null }> {
    const c = parseInput(testNotificationSchema, raw);
    await this.checkDestination({ ...c, enabled: true, deleteWhenEnded: false });
    const info = await this.lookup(c.channel);
    if (!info) return { ok: false, message: 'Couldn’t read that channel from Kick right now (is your Kick app set up?). Nothing was posted.', live: null };
    await this.fillThumbnails([info]);
    let avatar = '';
    let name = info.slug;
    try {
      const [u] = await this.withToken((t) => this.o.kickApi.usersByIds(t, [info.broadcasterUserId]));
      if (u) {
        avatar = u.profilePicture ?? '';
        name = u.name;
      }
    } catch {
      // The test still works without the profile picture.
    }
    const vars = this.vars({ displayName: name, avatarUrl: avatar } as NotifierRecord, info, { ...c, enabled: true, deleteWhenEnded: false });
    const m = buildNotification({ ...c, enabled: true, deleteWhenEnded: false }, vars);
    const posted = await this.o.poster.post(c.channelId, { content: `**Test notification** — ${m.content}`.slice(0, 2000), embed: c.embed }, vars, [], m.components);
    if (!posted.ok) return { ok: false, message: posted.detail, live: info.live };
    return {
      ok: true,
      message: !info.live
        ? 'Test posted. The streamer is offline, so Kick has no stream thumbnail right now (the image is left out).'
        : info.thumbnail
          ? 'Test posted with the live stream’s real data.'
          : 'Test posted. Kick hasn’t made a thumbnail for this stream yet (it does a few minutes in), so the image is left out; real notifications add it when it appears.',
      live: info.live,
    };
  }

  /** The Discord channel must take the post (View, Send, Embed Links; mentioning a role may need Mention Everyone). */
  private async checkDestination(c: NotifierConfig): Promise<void> {
    const channels = await this.o.discordChannels(true);
    const guild = channels.guilds.find((g) => g.id === c.guildId);
    const channel = guild?.channels.find((x) => x.id === c.channelId);
    if (!channel) throw new AppError('validation_error', 'Choose a channel the bot can see', { issues: [{ path: 'channelId', message: channels.problem ?? 'The bot can’t see that channel.' }] });
    const missing = missingDiscordPermissions(channel.permissions, ['viewChannel', 'sendMessages', 'embedLinks']);
    if (missing.length) throw new AppError('validation_error', 'The bot is missing permissions there', { issues: [{ path: 'channelId', message: `The bot needs ${missing.join(', ')} in #${channel.name}.` }] });
    if (c.roleId) {
      const role = guild!.roles?.find((x) => x.id === c.roleId);
      if (!role) throw new AppError('validation_error', 'Choose a role from that server', { issues: [{ path: 'roleId', message: 'That role isn’t in the server.' }] });
      if (!role.mentionable && missingDiscordPermissions(channel.permissions, ['mentionEveryone']).length)
        throw new AppError('validation_error', 'The role can’t be mentioned', {
          issues: [{ path: 'roleId', message: `@${role.name} isn’t mentionable. Turn on “Allow anyone to @mention this role” (Server Settings → Roles), or give the bot Mention Everyone in #${channel.name}.` }],
        });
    }
  }

  /** The channel as Kick reports it now; null when Kick couldn't be asked. Throws when Kick says it doesn't exist. */
  private async lookup(slug: string): Promise<KickChannelInfo | null> {
    if (!(await this.o.kickConfigured())) return null;
    let list: KickChannelInfo[];
    try {
      list = await this.withToken((t) => this.o.kickApi.channelsBySlugs(t, [slug]));
    } catch (err) {
      this.o.logger.warn('kick channel lookup failed', { kind: err instanceof KickApiError ? err.kind : 'unknown' });
      return null;
    }
    const found = list.find((c) => c.slug === slug);
    if (!found) throw new AppError('validation_error', 'No such Kick channel', { issues: [{ path: 'channel', message: `Kick has no channel named “${slug}”.` }] });
    return found;
  }

  // ── checking ───────────────────────────────────────────────────────────────

  /** Checks every enabled Kick streamer now (also every minute). One check at a time. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runCheck().finally(() => (this.running = null));
    return this.running;
  }

  private async runCheck(): Promise<void> {
    const notifiers = notifiersRepo.list(this.o.db).filter((n) => n.platform === 'kick' && n.enabled);
    if (notifiers.length === 0) return;
    if (!(await this.o.kickConfigured())) {
      this.lastProblem = 'Set up your Kick app first.';
      return;
    }
    const slugs = [...new Set(notifiers.map((n) => n.channelSlug))];
    const found = new Map<string, KickChannelInfo>();
    try {
      for (let i = 0; i < slugs.length; i += 50) {
        for (const c of await this.withToken((t) => this.o.kickApi.channelsBySlugs(t, slugs.slice(i, i + 50)))) found.set(c.slug, c);
      }
      this.lastProblem = null;
    } catch (err) {
      // Nothing is changed when Kick can't be asked: no post, no deletion, no guessed state.
      this.lastProblem = `Couldn’t check Kick: ${err instanceof KickApiError ? err.message : 'unknown error'}. Trying again in a minute.`;
      for (const n of notifiers) notifiersRepo.setState(this.o.db, n.id, { problem: this.lastProblem });
      return;
    }
    await this.fillThumbnails([...found.values()]);
    const needProfiles: string[] = [];
    for (const n of notifiers) {
      try {
        const info = found.get(n.channelSlug);
        if (!info) {
          notifiersRepo.setState(this.o.db, n.id, { lastCheckedAt: this.iso(), problem: `Kick has no channel named “${n.channelSlug}” (renamed or removed?).` });
          continue;
        }
        if (!n.avatarUrl || !n.displayName) needProfiles.push(n.id);
        await this.apply(n, info);
      } catch (err) {
        this.o.logger.error('stream notification failed', { id: n.id, err });
      }
    }
    if (needProfiles.length) await this.refreshProfiles(needProfiles);
  }

  /** One streamer's new state: announce a new session, or clean up an ended one. */
  private async apply(n: NotifierRecord, info: KickChannelInfo): Promise<void> {
    const c = this.config(n);
    if (!c) return;
    const at = this.iso();
    const base: NotifierState = { broadcasterId: info.broadcasterUserId, lastCheckedAt: at, problem: null, title: info.title, category: info.category };
    if (info.live) {
      const key = info.startTime ?? (n.live && n.sessionKey ? n.sessionKey : `seen:${at}`);
      const newSession = !n.live || n.sessionKey !== key;
      // A new session (or a retry of a failed post for this one).
      if (newSession || (!n.messageId && n.notifyAttempts < MAX_POST_ATTEMPTS)) {
        if (newSession && n.live && n.messageId && c.deleteWhenEnded) await this.o.poster.delete(n.messageChannelId ?? n.discordChannelId, n.messageId); // a previous session's leftover
        const attempts = newSession ? 0 : n.notifyAttempts;
        const vars = this.vars(n, info, c);
        const m = buildNotification(c, vars);
        const posted = await this.o.poster.post(c.channelId, { content: m.content, embed: c.embed }, vars, m.roles, m.components);
        notifiersRepo.setState(this.o.db, n.id, {
          ...base,
          live: true,
          sessionKey: key,
          liveSince: info.startTime ?? at,
          messageId: posted.ok ? posted.messageId : null,
          messageChannelId: posted.ok ? c.channelId : null,
          notifyAttempts: attempts + 1,
          ...(posted.ok ? { lastNotifiedAt: at, status: 'Live — notification posted.' } : { status: 'Live — the notification couldn’t be posted.', problem: posted.detail }),
        });
        if (posted.ok) this.shownThumbnails.set(n.id, { messageId: posted.messageId, thumbnail: vars.thumbnail ?? '', at: this.o.now().getTime() });
        this.o.logger.info('stream notification', { id: n.id, posted: posted.ok, thumbnail: !!vars.thumbnail });
        return;
      }
      notifiersRepo.setState(this.o.db, n.id, { ...base, live: true });
      if (n.messageId) await this.refreshThumbnail(n, info, c);
      return;
    }
    // Offline now.
    if (n.live) {
      let status = 'Stream ended.';
      let problem: string | null = null;
      let messageId = n.messageId;
      if (c.deleteWhenEnded && n.messageId) {
        const del = await this.o.poster.delete(n.messageChannelId ?? n.discordChannelId, n.messageId);
        if (del.ok) {
          status = del.alreadyGone ? 'Stream ended; the notification was already deleted.' : 'Stream ended; notification deleted.';
          messageId = null;
        } else problem = `Stream ended, but the notification couldn’t be deleted: ${del.detail}`;
      } else if (n.messageId) status = 'Stream ended; notification left in place.';
      notifiersRepo.setState(this.o.db, n.id, { ...base, live: false, messageId, status, problem, notifyAttempts: 0 });
      return;
    }
    notifiersRepo.setState(this.o.db, n.id, { ...base, live: false, ...(n.status ? {} : { status: 'Offline.' }) });
  }

  /** Live channels whose info came without a thumbnail: ask Kick's livestreams endpoint (one request). */
  private async fillThumbnails(infos: KickChannelInfo[]): Promise<void> {
    const missing = infos.filter((i) => i.live && !i.thumbnail);
    if (!missing.length) return;
    try {
      const thumbs = await this.withToken((t) => this.o.kickApi.livestreamThumbnails(t, [...new Set(missing.map((i) => i.broadcasterUserId))]));
      for (const i of missing) i.thumbnail = thumbs.get(i.broadcasterUserId) ?? null;
    } catch (err) {
      this.o.logger.warn('kick thumbnail lookup failed', { kind: err instanceof KickApiError ? err.kind : 'unknown' });
    }
  }

  /**
   * Adds the stream thumbnail to this session's post once Kick has one, then keeps it current (at most every
   * THUMBNAIL_REFRESH_MINUTES). Only for layouts that use {thumbnail}. The post's text, embed and buttons are rebuilt
   * from the saved layout with Kick's current data; an edit never pings the role again.
   */
  private async refreshThumbnail(n: NotifierRecord, info: KickChannelInfo, c: NotifierConfig): Promise<void> {
    if (!n.messageId || !info.thumbnail || !JSON.stringify(c.embed ?? {}).includes('{thumbnail}')) return;
    const shown = this.shownThumbnails.get(n.id);
    const now = this.o.now().getTime();
    if (shown && shown.messageId === n.messageId) {
      if (shown.thumbnail === info.thumbnail) return;
      if (shown.thumbnail && now - shown.at < THUMBNAIL_REFRESH_MINUTES * 60_000) return;
    }
    const vars = this.vars(n, info, c);
    const m = buildNotification(c, vars);
    const edited = await this.o.poster.edit(n.messageChannelId ?? c.channelId, n.messageId, { content: m.content, embed: c.embed }, vars, m.components);
    if (edited.ok) {
      this.shownThumbnails.set(n.id, { messageId: n.messageId, thumbnail: info.thumbnail, at: now });
      this.o.logger.info('stream notification thumbnail updated', { id: n.id, added: !shown?.thumbnail });
    } else {
      // Don't retry every minute against a post that is gone or can't be edited; try again after the refresh interval.
      this.shownThumbnails.set(n.id, { messageId: n.messageId, thumbnail: shown?.thumbnail || info.thumbnail, at: now });
      this.o.logger.warn('stream notification thumbnail update failed', { id: n.id, gone: edited.gone });
    }
  }

  private vars(n: NotifierRecord, info: KickChannelInfo, c: NotifierConfig): Record<string, string> {
    return {
      streamer: n.displayName ?? info.slug,
      title: info.title ?? '',
      category: info.category ?? '',
      url: `https://kick.com/${c.channel}`,
      viewers: info.viewerCount === null ? '' : String(info.viewerCount),
      thumbnail: info.thumbnail ?? '',
      avatar: n.avatarUrl ?? '',
    };
  }

  private async refreshProfiles(ids: string[]): Promise<void> {
    const rows = ids.map((id) => notifiersRepo.get(this.o.db, id)).filter((r): r is NotifierRecord => !!r && !!r.broadcasterId);
    if (!rows.length) return;
    try {
      const users = await this.withToken((t) => this.o.kickApi.usersByIds(t, [...new Set(rows.map((r) => r.broadcasterId!))]));
      for (const r of rows) {
        const u = users.find((x) => x.userId === r.broadcasterId);
        if (u) notifiersRepo.setState(this.o.db, r.id, { displayName: u.name, avatarUrl: u.profilePicture });
      }
    } catch (err) {
      this.o.logger.warn('kick profile lookup failed', { kind: err instanceof KickApiError ? err.kind : 'unknown' });
    }
  }

  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (!this.token || this.token.expiresAt - 60_000 < this.o.now().getTime()) this.token = await this.o.kickAppToken();
      try {
        return await fn(this.token.token);
      } catch (err) {
        if (err instanceof KickApiError && err.kind === 'unauthorized' && attempt === 0) {
          this.token = null; // expired early: get a new one once
          continue;
        }
        throw err;
      }
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private config(r: NotifierRecord): NotifierConfig | null {
    try {
      const parsed = notifierSchema.safeParse({ ...JSON.parse(r.config), enabled: r.enabled });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private view(r: NotifierRecord, channels: DiscordChannelsState | null): NotifierView {
    const c = this.config(r);
    if (!c) throw new AppError('internal_error', 'A saved notification is invalid');
    const guild = channels?.guilds.find((g) => g.id === c.guildId);
    const channel = guild?.channels.find((x) => x.id === c.channelId);
    return {
      ...c,
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      live: r.live,
      liveSince: r.liveSince,
      title: r.title,
      category: r.category,
      lastCheckedAt: r.lastCheckedAt,
      messageId: r.messageId,
      lastNotifiedAt: r.lastNotifiedAt,
      status: r.status,
      problem: r.problem ?? (channels && !channel ? 'The bot can’t see the Discord channel any more.' : null),
      destination: channel && guild ? `#${channel.name} in ${guild.name}` : null,
    };
  }

  private audit(action: 'notifier.created' | 'notifier.updated' | 'notifier.deleted', id: string, extra: Record<string, unknown>): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata: { id, ...extra } }, this.o.now());
  }

  private iso(): string {
    return this.o.now().toISOString();
  }
}

/**
 * The notification message: optional role mention + announcement text, and real Discord link buttons (one per row, under
 * the embed). Buttons whose URL isn't an http(s) link once filled in are left out rather than sent broken.
 */
export function buildNotification(c: NotifierConfig, vars: Record<string, string>): { content: string; roles: string[]; components: unknown[] } {
  const text = fillTemplate(c.content, vars).trim();
  const content = [c.roleId ? `<@&${c.roleId}>` : '', text].filter(Boolean).join(' ');
  const components = c.buttons
    .map((b) => ({ label: fillTemplate(b.label, vars).trim().slice(0, 80), url: fillTemplate(b.url, vars).trim() }))
    .filter((b) => b.label && /^https?:\/\/[^\s]+$/i.test(b.url))
    .map((b) => ({ type: 1, components: [{ type: 2, style: 5, label: b.label, url: b.url }] }));
  return { content, roles: c.roleId ? [c.roleId] : [], components };
}

function sessionKey(info: KickChannelInfo, at: string): string {
  return info.startTime ?? `seen:${at}`;
}
