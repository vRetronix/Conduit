/**
 * Kick clips, read from Kick's own website API (kick.com/api/v2/…). Kick's official public API has no clips, so this is
 * UNOFFICIAL and undocumented: Kick can change or block it at any time. Reading clips is public and read-only, with no
 * token or login.
 *
 * - A channel's clips: GET kick.com/api/v2/channels/{slug}/clips (newest first, 20 per page).
 * - One clip: GET kick.com/api/v2/clips/{id} (also has the VOD it was cut from).
 * - The video: an HLS playlist on clips.kick.com of MPEG-TS byte ranges. Saving fetches those ranges and joins them
 *   into one .ts video file (no conversion, so nothing extra is installed). Only clips.kick.com is ever fetched.
 */
import fs from 'node:fs/promises';
import { KICK_CLIP_ID } from '@conduit/shared';
import type { FetchLike } from '../app/types';
import type { KickClipSeen } from '@conduit/database';

const WEB = 'https://kick.com/api/v2';
const CLIP_HOST = 'clips.kick.com';
const NAME = /^[A-Za-z0-9_-]{1,25}$/;
const TIMEOUT_MS = 10_000;
const SEGMENT_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PLAYLIST_BYTES = 512 * 1024;
/** A clip is at most a few minutes; anything bigger than this isn't a clip. */
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

export class KickClipsError extends Error {}

export interface KickClipDetails {
  vodId: string | null;
}

export class KickClipsApi {
  private readonly fetchImpl: FetchLike;

  constructor(o: { fetch?: FetchLike } = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The channel's newest clips (one page). */
  async channelClips(slug: string): Promise<KickClipSeen[]> {
    if (!NAME.test(slug)) throw new KickClipsError('That isn’t a Kick channel name.');
    const body = await this.json(`${WEB}/channels/${slug.toLowerCase()}/clips?sort=date&time=all`);
    const list = Array.isArray(body.clips) ? (body.clips as unknown[]) : null;
    if (!list) throw new KickClipsError('Kick’s website answered without a clip list.');
    return list.map((c) => parseClip(c, slug.toLowerCase())).filter((c): c is KickClipSeen => c !== null);
  }

  /** Details only the single-clip answer has: the VOD it was cut from. */
  async clip(id: string): Promise<KickClipDetails> {
    if (!KICK_CLIP_ID.test(id)) throw new KickClipsError('That isn’t a Kick clip id.');
    const body = await this.json(`${WEB}/clips/${id}`);
    const clip = (body.clip ?? null) as { vod?: { id?: unknown } | null } | null;
    if (!clip) throw new KickClipsError('Kick’s website doesn’t know that clip (it may have been deleted).');
    const vod = clip.vod?.id;
    return { vodId: typeof vod === 'string' && /^[0-9a-f-]{8,64}$/i.test(vod) ? vod : null };
  }

  /**
   * Saves the clip's video into `file` (an MPEG-TS .ts file). Written to a temporary name first, so a failed or
   * interrupted save never leaves a half file under the real name. Returns its size.
   */
  async download(videoUrl: string, file: string): Promise<number> {
    const playlist = clipUrl(videoUrl);
    let text = await this.text(playlist);
    let base = playlist;
    // A master playlist lists qualities: take the best one (once).
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const variant = bestVariant(text, base);
      if (!variant) throw new KickClipsError('The clip’s video list is empty.');
      base = variant;
      text = await this.text(variant);
    }
    const parts = segments(text, base);
    if (parts.length === 0) throw new KickClipsError('The clip has no video.');
    const temp = `${file}.part`;
    const out = await fs.open(temp, 'w');
    let total = 0;
    try {
      for (const part of mergeRanges(parts)) {
        const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0' };
        if (part.range) headers.range = `bytes=${part.range.start}-${part.range.end}`;
        const res = await this.fetchImpl(part.url, { headers, redirect: 'error', signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS) }).catch(() => {
          throw new KickClipsError('The clip’s video couldn’t be downloaded (network problem).');
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new KickClipsError(`The clip’s video couldn’t be downloaded (HTTP ${res.status}).`);
        }
        let bytes = Buffer.from(await res.arrayBuffer());
        // A server that ignores Range sends the whole file: keep only the part asked for.
        if (part.range && res.status === 200) bytes = bytes.subarray(part.range.start, part.range.end + 1);
        total += bytes.length;
        if (total > MAX_VIDEO_BYTES) throw new KickClipsError('The clip’s video is unexpectedly large; nothing was saved.');
        await out.write(bytes);
      }
    } catch (err) {
      await out.close().catch(() => undefined);
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
    await out.close();
    await fs.rename(temp, file);
    return total;
  }

  private async json(url: string, headers?: Record<string, string>): Promise<Record<string, unknown>> {
    return parseObject(await this.get(url, 'application/json', MAX_JSON_BYTES, headers));
  }

  private text(url: string): Promise<string> {
    return this.get(url, '*/*', MAX_PLAYLIST_BYTES);
  }

  private async get(url: string, accept: string, max: number, headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0' }): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { ...headers, accept }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new KickClipsError('Kick’s website couldn’t be reached.');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) throw new KickClipsError('Kick’s website doesn’t know that (HTTP 404).');
      if (res.status === 403 || res.status === 429) throw new KickClipsError(`Kick’s website refused the request (HTTP ${res.status}); try again in a few minutes.`);
      throw new KickClipsError(`Kick’s website had a problem (HTTP ${res.status}).`);
    }
    const text = await res.text();
    if (text.length > max) throw new KickClipsError('Kick’s website answered with more than expected.');
    return text;
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // handled below
  }
  throw new KickClipsError('Kick’s website gave an answer CONDUIT doesn’t understand.');
}

/** One clip from Kick's list, or null when it's missing something essential. */
function parseClip(raw: unknown, slug: string): KickClipSeen | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const id = typeof c.id === 'string' && KICK_CLIP_ID.test(c.id) ? c.id : null;
  const video = typeof c.video_url === 'string' ? c.video_url : typeof c.clip_url === 'string' ? c.clip_url : null;
  const created = typeof c.created_at === 'string' && Number.isFinite(Date.parse(c.created_at)) ? new Date(c.created_at).toISOString() : null;
  if (!id || !video || !created) return null;
  try {
    clipUrl(video);
  } catch {
    return null;
  }
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  const thumb = text(c.thumbnail_url, 500);
  return {
    id,
    channelSlug: slug,
    title: text(c.title, 200) ?? 'Untitled clip',
    creatorName: text((c.creator as { username?: unknown } | null)?.username, 64),
    category: text((c.category as { name?: unknown } | null)?.name, 100),
    durationSeconds: Math.min(3600, count(c.duration)),
    views: count(c.views ?? c.view_count),
    thumbnailUrl: thumb && thumb.startsWith('https://') ? thumb : null,
    videoUrl: video,
    createdAt: created,
  };
}

/** A clips.kick.com https address, or an error: nothing else is ever fetched for a video. */
function clipUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new KickClipsError('The clip’s video address isn’t valid.');
  }
  if (u.protocol !== 'https:' || u.hostname !== CLIP_HOST || u.username || u.password) throw new KickClipsError('The clip’s video isn’t on Kick’s clip server.');
  return u.toString();
}

function bestVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/);
  let best: { bandwidth: number; url: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/i.exec(lines[i]!.trim());
    if (!m) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(m[1]!)?.[1] ?? 0);
    const next = lines.slice(i + 1).find((l) => l.trim() && !l.trim().startsWith('#'));
    if (!next) continue;
    const url = clipUrl(new URL(next.trim(), base).toString());
    if (!best || bandwidth > best.bandwidth) best = { bandwidth, url };
  }
  return best?.url ?? null;
}

interface Part {
  url: string;
  range: { start: number; end: number } | null;
}

/** The media segments of a playlist, with their byte ranges (EXT-X-BYTERANGE: length[@offset]). */
function segments(text: string, base: string): Part[] {
  const parts: Part[] = [];
  const lastEnd = new Map<string, number>();
  let pending: { length: number; offset: number | null } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/i.exec(line);
      if (m) pending = { length: Number(m[1]), offset: m[2] === undefined ? null : Number(m[2]) };
      continue;
    }
    const url = clipUrl(new URL(line, base).toString());
    if (pending) {
      const start = pending.offset ?? lastEnd.get(url) ?? 0;
      parts.push({ url, range: { start, end: start + pending.length - 1 } });
      lastEnd.set(url, start + pending.length);
      pending = null;
    } else {
      parts.push({ url, range: null });
    }
  }
  return parts;
}

/** Joins back-to-back ranges of the same file into one request (Kick's clips are a few files, cut in many ranges). */
function mergeRanges(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    if (prev?.range && p.range && prev.url === p.url && p.range.start === prev.range.end + 1) prev.range = { start: prev.range.start, end: p.range.end };
    else out.push({ url: p.url, range: p.range ? { ...p.range } : null });
  }
  return out;
}
