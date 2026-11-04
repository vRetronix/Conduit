/**
 * Stream Notifications: a Discord post when a streamer goes live, optionally deleted when the stream ends.
 *
 * Live status comes from each platform's public API with an app access token from the user's own app for that
 * platform (see live-sources.ts) — public information, readable for any channel, acting as the app rather than as any
 * account. It is checked every minute while CONDUIT runs:
 * - Kick: GET /public/v1/channels?slug=… (50 channels per request). Kick's webhooks only cover your own channel, so
 *   polling is what works for other streamers.
 * - Twitch: GET /helix/users?login=… and /helix/streams?user_id=… (100 per request).
 *
 * Exactly one post per live session:
 * - a session is the platform's stream start time (or, if it doesn't send one, the first time CONDUIT saw it live);
 * - the session and the posted message id (and its channel) are saved in the database, so checks after a restart
 *   recognise a session that was already announced;
 * - a failed post is retried on later checks (at most 5 times per session); a successful one never repeats.
 * A stream's first thumbnail usually appears a few minutes after it starts, so a post made at go-live often has no
 * image yet. While the stream is live, CONDUIT edits its post to add the stream thumbnail as soon as there is one, then
 * refreshes it at most every 10 minutes (edits never ping anyone). If Kick's channel info comes without a thumbnail,
 * Kick's livestreams endpoint is asked for it.
 * When the stream ends and "delete when ended" is on, exactly that session's message is deleted (already deleted
 * counts as done). Unknown channels, platform or Discord outages and missing permissions are reported, never guessed:
 * a channel is only treated as live when its platform says so.
 */
import crypto from 'node:crypto';
import { notifiersRepo, type Database, type NotifierRecord, type NotifierState } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  canonicalNotifierVariables,
  fillTemplate,
  missingDiscordPermissions,
  notifierSchema,
  NOTIFICATION_PLATFORMS,
  testNotificationSchema,
  type DiscordChannelsState,
  type NotificationPlatform,
  type NotificationSourceState,
  type NotifierConfig,
  type NotifierView,
  type StreamNotificationsState,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import type { KickChatApi } from './kick-chat-api';
import { kickLiveSource, sourceErrorKind, sourceErrorText, type LiveChannelInfo, type LiveSource } from './live-sources';
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
  /** Twitch live status (twitchLiveSource); without it, Twitch notifications report that Twitch isn't available. */
  twitch?: LiveSource;
  poster: Pick<DiscordPoster, 'post' | 'edit' | 'delete'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
}

export class StreamNotificationService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly sources: Partial<Record<NotificationPlatform, LiveSource>>;
  /** The last check's problem per platform (null: it worked). */
  private readonly lastProblem = new Map<NotificationPlatform, string>();
  /** The thumbnail each live post currently shows (by notifier), so it's edited only when there is a new one. */
  private readonly shownThumbnails = new Map<string, { messageId: string; thumbnail: string; at: number }>();

  constructor(private readonly o: StreamNotificationServiceOptions) {
    this.sources = {
      kick: kickLiveSource({
        api: o.kickApi,
        appToken: o.kickAppToken,
        configured: o.kickConfigured,
        now: o.now,
        onThumbnailError: (err) => o.logger.warn('kick thumbnail lookup failed', { kind: sourceErrorKind(err) }),
      }),
      ...(o.twitch ? { twitch: o.twitch } : {}),
    };
  }

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
    return {
      notifiers: notifiersRepo.list(this.o.db).map((r) => this.view(r, channels)),
      kick: await this.sourceState('kick'),
      twitch: await this.sourceState('twitch'),
      discord: { ready: channels !== null && channels.problem === null, problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.') },
    };
  }

  private async sourceState(platform: NotificationPlatform): Promise<NotificationSourceState> {
    const source = this.sources[platform];
    if (!source) return { ready: false, problem: 'Not available yet.', pollSeconds: NOTIFICATION_POLL_SECONDS };
    const configured = await source.configured();
    const problem = this.lastProblem.get(platform) ?? null;
    return { ready: configured && problem === null, problem: configured ? problem : source.setupHint, pollSeconds: NOTIFICATION_POLL_SECONDS };
  }

  private source(platform: NotificationPlatform): LiveSource {
    const source = this.sources[platform];
    if (!source) throw new AppError('not_implemented', 'Notifications for this platform aren’t available yet.');
    return source;
  }

  async create(raw: unknown): Promise<NotifierView> {
    const c = canonicalNotifierVariables(parseInput(notifierSchema, raw));
    const source = this.source(c.platform);
    await this.checkDestination(c);
    const known = await this.lookup(source, c.channel);
    if (notifiersRepo.list(this.o.db).some((n) => n.platform === c.platform && n.channelSlug === c.channel && n.discordChannelId === c.channelId))
      throw new AppError('conflict', 'That streamer already posts to that channel.');
    const id = crypto.randomUUID();
    notifiersRepo.insert(this.o.db, { id, platform: c.platform, channelSlug: c.channel, discordChannelId: c.channelId, enabled: c.enabled, config: JSON.stringify(c), at: this.iso() });
    if (known) {
      // The current state counts as already seen: a streamer who is live right now isn't announced the moment they're
      // added (only their next live session is).
      notifiersRepo.setState(this.o.db, id, {
        broadcasterId: known.broadcasterUserId,
        ...profileOf(known),
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
      if (!known.displayName) void this.refreshProfiles(source, [id]);
    } else notifiersRepo.setState(this.o.db, id, { status: `Added. ${source.name} couldn’t be checked yet; it will be on the next check.` });
    this.audit('notifier.created', id, { platform: c.platform });
    return this.view(notifiersRepo.get(this.o.db, id)!, null);
  }

  async update(id: string, raw: unknown): Promise<NotifierView> {
    const r = notifiersRepo.get(this.o.db, id);
    const before = r && this.config(r);
    if (!r || !before) throw notFound('Notification');
    // A notification stays on its platform: changing the streamer's platform means adding a new one.
    const c = canonicalNotifierVariables(parseInput(notifierSchema, { ...before, ...(raw && typeof raw === 'object' ? raw : {}), platform: before.platform }));
    if (c.enabled) await this.checkDestination(c);
    if (c.channel !== r.channelSlug) await this.lookup(this.source(c.platform), c.channel);
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
   * Posts a test of a notification (not saved) to its Discord channel, with the streamer's real current data from the
   * platform (title and category; the thumbnail only while they're live). Marked as a test; the role is shown but not
   * pinged.
   */
  async test(raw: unknown): Promise<{ ok: boolean; message: string; live: boolean | null }> {
    const c = parseInput(testNotificationSchema, raw);
    const source = this.source(c.platform);
    await this.checkDestination({ ...c, enabled: true, deleteWhenEnded: false });
    const info = await this.lookup(source, c.channel);
    if (!info) return { ok: false, message: `Couldn’t read that channel from ${source.name} right now (is your ${source.name} app set up?). Nothing was posted.`, live: null };
    let avatar = info.profilePicture ?? '';
    let name = info.displayName ?? info.slug;
    if (!info.displayName) {
      try {
        const [u] = await source.profiles([info.broadcasterUserId]);
        if (u) {
          avatar = u.profilePicture ?? '';
          name = u.name;
        }
      } catch {
        // The test still works without the profile picture.
      }
    }
    const config = { ...c, enabled: true, deleteWhenEnded: false };
    const vars = this.vars({ displayName: name, avatarUrl: avatar } as NotifierRecord, info, config);
    const m = buildNotification(config, vars);
    const posted = await this.o.poster.post(c.channelId, { content: `**Test notification** — ${m.content}`.slice(0, 2000), embed: c.embed }, vars, [], m.components);
    if (!posted.ok) return { ok: false, message: posted.detail, live: info.live };
    return {
      ok: true,
      message: !info.live
        ? `Test posted. The streamer is offline, so ${source.name} has no stream thumbnail right now (the image is left out).`
        : info.thumbnail
          ? 'Test posted with the live stream’s real data.'
          : `Test posted. ${source.name} hasn’t made a thumbnail for this stream yet (it does a few minutes in), so the image is left out; real notifications add it when it appears.`,
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

  /** The channel as its platform reports it now; null when it couldn't be asked. Throws when it says it doesn't exist. */
  private async lookup(source: LiveSource, slug: string): Promise<LiveChannelInfo | null> {
    if (!(await source.configured())) return null;
    let list: LiveChannelInfo[];
    try {
      list = await source.channels([slug]);
    } catch (err) {
      this.o.logger.warn('channel lookup failed', { platform: source.platform, kind: sourceErrorKind(err) });
      return null;
    }
    const found = list.find((c) => c.slug === slug);
    if (!found) throw new AppError('validation_error', `No such ${source.name} channel`, { issues: [{ path: 'channel', message: `${source.name} has no channel named “${slug}”.` }] });
    return found;
  }

  // ── checking ───────────────────────────────────────────────────────────────

  /** Checks every enabled streamer now (also every minute), platform by platform. One check at a time. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runCheck().finally(() => (this.running = null));
    return this.running;
  }

  private async runCheck(): Promise<void> {
    for (const platform of NOTIFICATION_PLATFORMS) {
      const source = this.sources[platform];
      if (source) await this.checkPlatform(source);
    }
  }

  private async checkPlatform(source: LiveSource): Promise<void> {
    const notifiers = notifiersRepo.list(this.o.db).filter((n) => n.platform === source.platform && n.enabled);
    if (notifiers.length === 0) return;
    if (!(await source.configured())) {
      this.lastProblem.set(source.platform, `Set up your ${source.name} app first.`);
      return;
    }
    const slugs = [...new Set(notifiers.map((n) => n.channelSlug))];
    const found = new Map<string, LiveChannelInfo>();
    try {
      for (let i = 0; i < slugs.length; i += source.batch) {
        for (const c of await source.channels(slugs.slice(i, i + source.batch))) found.set(c.slug, c);
      }
      this.lastProblem.delete(source.platform);
    } catch (err) {
      // Nothing is changed when the platform can't be asked: no post, no deletion, no guessed state.
      const problem = `Couldn’t check ${source.name}: ${sourceErrorText(err)}. Trying again in a minute.`;
      this.lastProblem.set(source.platform, problem);
      for (const n of notifiers) notifiersRepo.setState(this.o.db, n.id, { problem });
      return;
    }
    const needProfiles: string[] = [];
    for (const n of notifiers) {
      try {
        const info = found.get(n.channelSlug);
        if (!info) {
          notifiersRepo.setState(this.o.db, n.id, { lastCheckedAt: this.iso(), problem: `${source.name} has no channel named “${n.channelSlug}” (renamed or removed?).` });
          continue;
        }
        if ((!n.avatarUrl || !n.displayName) && !info.displayName) needProfiles.push(n.id);
        await this.apply(n, info);
      } catch (err) {
        this.o.logger.error('stream notification failed', { id: n.id, err });
      }
    }
    if (needProfiles.length) await this.refreshProfiles(source, needProfiles);
  }

  /** One streamer's new state: announce a new session, or clean up an ended one. */
  private async apply(n: NotifierRecord, info: LiveChannelInfo): Promise<void> {
    const c = this.config(n);
    if (!c) return;
    const at = this.iso();
    const profile = profileOf(info);
    const base: NotifierState = { broadcasterId: info.broadcasterUserId, ...profile, lastCheckedAt: at, problem: null, title: info.title, category: info.category };
    // The post uses the newest name and picture (Twitch sends them with every check).
    const current: NotifierRecord = { ...n, ...profile };
    if (info.live) {
      const key = info.startTime ?? (n.live && n.sessionKey ? n.sessionKey : `seen:${at}`);
      const newSession = !n.live || n.sessionKey !== key;
      // A new session (or a retry of a failed post for this one).
      if (newSession || (!n.messageId && n.notifyAttempts < MAX_POST_ATTEMPTS)) {
        if (newSession && n.live && n.messageId && c.deleteWhenEnded) await this.o.poster.delete(n.messageChannelId ?? n.discordChannelId, n.messageId); // a previous session's leftover
        const attempts = newSession ? 0 : n.notifyAttempts;
        const vars = this.vars(current, info, c);
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
        this.o.logger.info('stream notification', { id: n.id, platform: n.platform, posted: posted.ok, thumbnail: !!vars.thumbnail });
        return;
      }
      notifiersRepo.setState(this.o.db, n.id, { ...base, live: true });
      if (n.messageId) await this.refreshThumbnail(current, info, c);
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

  /**
   * Adds the stream thumbnail to this session's post once there is one, then keeps it current (at most every
   * THUMBNAIL_REFRESH_MINUTES). Only for layouts that use {thumbnail}. The post's text, embed and buttons are rebuilt
   * from the saved layout with the platform's current data; an edit never pings the role again.
   */
  private async refreshThumbnail(n: NotifierRecord, info: LiveChannelInfo, c: NotifierConfig): Promise<void> {
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

  private vars(n: NotifierRecord, info: LiveChannelInfo, c: NotifierConfig): Record<string, string> {
    return {
      streamer: n.displayName ?? info.slug,
      title: info.title ?? '',
      category: info.category ?? '',
      url: this.source(c.platform).url(c.channel),
      viewers: info.viewerCount === null ? '' : String(info.viewerCount),
      thumbnail: info.thumbnail ?? '',
      avatar: n.avatarUrl ?? '',
    };
  }

  private async refreshProfiles(source: LiveSource, ids: string[]): Promise<void> {
    const rows = ids.map((id) => notifiersRepo.get(this.o.db, id)).filter((r): r is NotifierRecord => !!r && !!r.broadcasterId);
    if (!rows.length) return;
    try {
      const users = await source.profiles([...new Set(rows.map((r) => r.broadcasterId!))]);
      for (const r of rows) {
        const u = users.find((x) => x.userId === r.broadcasterId);
        if (u) notifiersRepo.setState(this.o.db, r.id, { displayName: u.name, avatarUrl: u.profilePicture });
      }
    } catch (err) {
      this.o.logger.warn('profile lookup failed', { platform: source.platform, kind: sourceErrorKind(err) });
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

/** The name and picture that came with the channel, if the platform sent them. */
function profileOf(info: LiveChannelInfo): Pick<NotifierState, 'displayName' | 'avatarUrl'> {
  return info.displayName ? { displayName: info.displayName, avatarUrl: info.profilePicture ?? null } : {};
}

function sessionKey(info: LiveChannelInfo, at: string): string {
  return info.startTime ?? `seen:${at}`;
}
