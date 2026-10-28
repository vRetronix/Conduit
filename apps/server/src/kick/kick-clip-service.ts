/**
 * Kick → Clips. The clips of your Kick channel (made by anyone on kick.com, e.g. with Kick's own /clip in chat) are
 * read from Kick's website (see kick-clips-api.ts) and kept in kick_clips, so CONDUIT lists them. Each can be:
 * - posted in Discord: an embed with the clip's thumbnail, and "Watch stream" (your live channel, or the VOD it was cut
 *   from when you're offline) and "View clip on Kick" buttons; new clips can be posted by themselves (only clips made
 *   after that was switched on, never the backlog);
 * - saved on this PC as a .ts video file.
 * The list is read when the page is open (at most once a minute) and every 2 minutes while auto-posting is on.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { kickClipsRepo, settingsRepo, type Database, type KickClipRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  KICK_CLIP_ID,
  kickClipSettingsSchema,
  missingDiscordPermissions,
  type DiscordChannelsState,
  type KickClipSettings,
  type KickClipsState,
  type KickClipView,
} from '@conduit/shared';
import type { CredentialVault } from '../app/vault';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { parseInput } from '../validation';
import type { DiscordPoster } from '../discord/discord-poster';
import { KickClipsError, type KickClipsApi } from './kick-clips-api';

const SETTINGS_KEY = 'kick.clips';
/** When auto-posting was switched on: older clips are never posted by themselves. */
const AUTO_POST_SINCE_KEY = 'kick.clips.auto_post_since';
const LISTED = 200;
/** The page reads Kick's list at most this often. */
const FRESH_MS = 60_000;
/** While auto-posting, Kick's list is read this often. */
const AUTO_CHECK_MS = 2 * 60_000;
const KICK_GREEN = 0x53fc18;
/** Left by an earlier version's !clip (a kick.com login); removed at start. */
const OLD_LOGIN_VAULT_KEY = 'kick:web-session';
const OLD_LOGIN_USER_KEY = 'kick.clips.login_user';

export interface KickClipServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  api: Pick<KickClipsApi, 'channelClips' | 'clip' | 'download'>;
  poster: Pick<DiscordPoster, 'post'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
  /** Your Kick channel (the main account), or null until it's connected. */
  mainChannel: () => { slug: string; name: string } | null;
  /** Whether the channel is live now (Kick's official API); null when it couldn't be checked. */
  isLive: (slug: string) => Promise<boolean | null>;
  /** Where clips are saved unless a folder is chosen. */
  defaultFolder: string;
  /** Only to remove what an earlier version's !clip kept there. */
  vault: Pick<CredentialVault, 'delete'>;
}

export class KickClipService {
  private lastCheck: { at: string; ms: number; problem: string | null } | null = null;
  private checking: Promise<void> | null = null;
  private readonly saving = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: KickClipServiceOptions) {}

  start(): void {
    void this.o.vault.delete(OLD_LOGIN_VAULT_KEY).catch(() => undefined);
    settingsRepo.delete(this.o.db, OLD_LOGIN_USER_KEY);
    this.timer ??= setInterval(() => {
      if (this.settings().autoPost) void this.check();
    }, AUTO_CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  settings(): KickClipSettings {
    const raw = settingsRepo.get(this.o.db, SETTINGS_KEY);
    try {
      const parsed = raw ? kickClipSettingsSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) return parsed.data;
    } catch {
      // falls back to the defaults
    }
    return kickClipSettingsSchema.parse({});
  }

  folder(): string {
    return this.settings().folder ?? this.o.defaultFolder;
  }

  async state(): Promise<KickClipsState> {
    if (!this.lastCheck || this.o.now().getTime() - this.lastCheck.ms > FRESH_MS) await this.check();
    const channel = this.o.mainChannel();
    return {
      channel,
      settings: this.settings(),
      folder: this.folder(),
      clips: channel ? kickClipsRepo.list(this.o.db, channel.slug, LISTED).map(view) : [],
      lastCheck: this.lastCheck ? { at: this.lastCheck.at, problem: this.lastCheck.problem } : null,
    };
  }

  /** Reads Kick's clip list now (the Refresh button). */
  async refresh(): Promise<KickClipsState> {
    await this.check();
    return this.state();
  }

  async saveSettings(raw: unknown): Promise<KickClipsState> {
    const next = parseInput(kickClipSettingsSchema, raw);
    if (next.folder && !path.isAbsolute(next.folder)) throw invalid('folder', 'Choose a full folder path.');
    if (next.channelId) {
      const channels = await this.o.discordChannels(true);
      const ch = channels.guilds.find((g) => g.id === next.guildId)?.channels.find((c) => c.id === next.channelId);
      if (!ch) throw invalid('channelId', 'The bot can’t see that channel.');
      const missing = missingDiscordPermissions(ch.permissions, ['viewChannel', 'sendMessages', 'embedLinks']);
      if (missing.length) throw invalid('channelId', `The bot needs ${missing.join(', ')} in #${ch.name}.`);
    }
    const at = this.o.now().toISOString();
    if (next.autoPost && !this.settings().autoPost) settingsRepo.set(this.o.db, AUTO_POST_SINCE_KEY, at, at);
    settingsRepo.set(this.o.db, SETTINGS_KEY, JSON.stringify(next), at);
    writeAudit(this.o.db, { action: 'kick_clips.updated', outcome: 'success', actorUserId: null, metadata: { autoPost: next.autoPost } }, this.o.now());
    return this.state();
  }

  /** Posts a clip in the chosen Discord channel. */
  async post(id: string): Promise<KickClipsState> {
    const clip = this.clip(id);
    const s = this.settings();
    if (!s.channelId) throw invalid('channelId', 'Choose a Discord channel for clips first.');
    const problem = await this.postTo(clip, s.channelId);
    if (problem) throw new AppError('service_unavailable', problem);
    return this.state();
  }

  /** Saves a clip's video in the clips folder. */
  async save(id: string): Promise<KickClipsState> {
    const clip = this.clip(id);
    if (this.saving.has(id)) throw new AppError('conflict', 'That clip is already being saved.');
    this.saving.add(id);
    try {
      const folder = this.folder();
      await fs.mkdir(folder, { recursive: true }).catch(() => {
        throw new AppError('bad_request', `CONDUIT can’t create the folder ${folder}. Choose another one.`);
      });
      const file = path.join(folder, fileName(clip));
      const bytes = await this.o.api.download(clip.videoUrl, file).catch((err: unknown) => {
        throw new AppError('service_unavailable', err instanceof KickClipsError ? err.message : 'The clip couldn’t be saved.');
      });
      kickClipsRepo.setSaved(this.o.db, id, file, this.o.now().toISOString());
      this.o.logger.info('kick clip saved', { bytes });
    } finally {
      this.saving.delete(id);
    }
    return this.state();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private clip(id: string): KickClipRecord {
    const clip = KICK_CLIP_ID.test(id) ? kickClipsRepo.get(this.o.db, id) : null;
    if (!clip) throw new AppError('not_found', 'CONDUIT doesn’t know that clip. Refresh the list.');
    return clip;
  }

  private check(): Promise<void> {
    this.checking ??= this.readList().finally(() => (this.checking = null));
    return this.checking;
  }

  private async readList(): Promise<void> {
    const channel = this.o.mainChannel();
    const now = this.o.now();
    if (!channel) {
      this.lastCheck = { at: now.toISOString(), ms: now.getTime(), problem: 'Connect your main Kick account first (Dashboard → Kick).' };
      return;
    }
    let seen;
    try {
      seen = await this.o.api.channelClips(channel.slug);
    } catch (err) {
      this.lastCheck = { at: now.toISOString(), ms: now.getTime(), problem: err instanceof KickClipsError ? err.message : 'Kick’s clip list couldn’t be read.' };
      return;
    }
    this.lastCheck = { at: now.toISOString(), ms: now.getTime(), problem: null };
    const fresh: string[] = [];
    for (const c of seen) if (kickClipsRepo.upsert(this.o.db, c, now.toISOString())) fresh.push(c.id);
    const s = this.settings();
    if (!s.autoPost || !s.channelId || fresh.length === 0) return;
    const since = Date.parse(settingsRepo.get(this.o.db, AUTO_POST_SINCE_KEY) ?? '');
    // Oldest first, so Discord shows them in the order they were made.
    for (const id of fresh.reverse()) {
      const clip = kickClipsRepo.get(this.o.db, id);
      if (!clip || clip.postedAt || !Number.isFinite(since) || Date.parse(clip.createdAt) < since) continue;
      const problem = await this.postTo(clip, s.channelId);
      if (problem) this.o.logger.warn('kick clip not posted', { detail: problem });
    }
  }

  /** Posts the clip; returns what went wrong, or null. */
  private async postTo(clip: KickClipRecord, channelId: string): Promise<string | null> {
    const channel = this.o.mainChannel();
    const name = channel?.name ?? clip.channelSlug;
    // The VOD (for "Watch stream" while offline) is only in the single-clip answer; asked once per clip.
    let vodId = clip.vodId;
    if (!vodId) {
      vodId = await this.o.api
        .clip(clip.id)
        .then((d) => d.vodId)
        .catch(() => null);
      if (vodId) kickClipsRepo.setVod(this.o.db, clip.id, vodId);
    }
    const live = await this.o.isLive(clip.channelSlug).catch(() => null);
    const result = await this.o.poster.post(channelId, { embed: clipEmbed(clip, name) }, {}, [], clipButtons(clip, live, vodId));
    if (!result.ok) {
      kickClipsRepo.setPosted(this.o.db, clip.id, { problem: result.detail });
      return result.detail;
    }
    kickClipsRepo.setPosted(this.o.db, clip.id, { channelId, messageId: result.messageId, at: this.o.now().toISOString() });
    return null;
  }
}

const clipPage = (c: Pick<KickClipRecord, 'channelSlug' | 'id'>) => `https://kick.com/${c.channelSlug}/clips/${c.id}`;

function view(c: KickClipRecord): KickClipView {
  return {
    id: c.id,
    title: c.title,
    creatorName: c.creatorName,
    category: c.category,
    durationSeconds: c.durationSeconds,
    views: c.views,
    thumbnailUrl: c.thumbnailUrl,
    url: clipPage(c),
    createdAt: c.createdAt,
    saved: c.savedPath && c.savedAt ? { path: c.savedPath, at: c.savedAt } : null,
    posted: c.postedAt && c.discordChannelId ? { at: c.postedAt, channelId: c.discordChannelId } : null,
    postProblem: c.postProblem,
  };
}

/** The Discord embed for a clip. */
export function clipEmbed(c: KickClipRecord, channelName: string): Record<string, unknown> {
  const fields = [
    ...(c.creatorName ? [{ name: 'Clipped by', value: c.creatorName.slice(0, 64), inline: true }] : []),
    ...(c.category ? [{ name: 'Category', value: c.category.slice(0, 100), inline: true }] : []),
    { name: 'Length', value: formatLength(c.durationSeconds), inline: true },
  ];
  return {
    color: KICK_GREEN,
    author: { name: channelName.slice(0, 256), url: `https://kick.com/${c.channelSlug}` },
    title: c.title.slice(0, 256),
    url: clipPage(c),
    fields,
    ...(c.thumbnailUrl ? { image: { url: c.thumbnailUrl } } : {}),
    footer: { text: 'Kick clip' },
    timestamp: c.createdAt,
  };
}

/** "Watch stream" (live) or "Watch VOD" (offline, when Kick knows the VOD), and "View clip on Kick". */
export function clipButtons(c: KickClipRecord, live: boolean | null, vodId: string | null): unknown[] {
  const link = (label: string, url: string) => ({ type: 2, style: 5, label, url });
  const watch = live === false && vodId ? link('Watch VOD', `https://kick.com/${c.channelSlug}/videos/${vodId}`) : link('Watch stream', `https://kick.com/${c.channelSlug}`);
  return [{ type: 1, components: [watch, link('View clip on Kick', clipPage(c))] }];
}

/** "2026-10-24 Nice shot (clip_01…).ts", without characters Windows doesn't allow in names. */
function fileName(c: KickClipRecord): string {
  const title = c.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80);
  return `${c.createdAt.slice(0, 10)} ${title || 'Clip'} (${c.id}).ts`;
}

function formatLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s} s`;
}

function invalid(field: string, message: string): AppError {
  return new AppError('validation_error', message, { issues: [{ path: field, message }] });
}
