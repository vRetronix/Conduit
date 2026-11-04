/**
 * Twitch's Helix API for public channel information (https://dev.twitch.tv/docs/api/reference/), called with an app
 * access token from the user's own Twitch app:
 * - GET /helix/users?login=…  (up to 100): whether a channel exists, its id, display name and profile picture;
 * - GET /helix/streams?user_id=…&first=100: the channels that are live now (offline channels are simply absent), with
 *   the title, category (game_name), viewers, start time and a thumbnail template ({width}x{height}).
 * Every request sends the app's Client-Id header. Twitch answers 429 when rate limited (Ratelimit-Reset: epoch seconds).
 */
import type { FetchLike } from '../app/types';
import { TWITCH_API_BASE, isTwitchImageUrl } from './twitch';

const REQUEST_TIMEOUT_MS = 15_000;
/** Twitch accepts up to 100 logins or ids per request. */
export const TWITCH_BATCH = 100;
/** The size the stream thumbnail is asked for (Twitch fills in the {width}x{height} template). */
const THUMBNAIL_SIZE = '1280x720';
/** How often the thumbnail link changes, so Discord fetches Twitch's newer preview instead of its cached one. */
export const THUMBNAIL_REFRESH_MS = 10 * 60_000;

export type TwitchApiErrorKind = 'unauthorized' | 'rate_limited' | 'bad_request' | 'server_error' | 'network' | 'unexpected_response';

export class TwitchApiError extends Error {
  constructor(
    readonly kind: TwitchApiErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

export interface TwitchChannelInfo {
  /** The login (twitch.tv/<login>), lowercase. */
  slug: string;
  broadcasterUserId: string;
  displayName: string;
  profilePicture: string | null;
  live: boolean;
  /** When the current stream started (Twitch's value; identifies the live session). */
  startTime: string | null;
  thumbnail: string | null;
  viewerCount: number | null;
  title: string | null;
  category: string | null;
}

export interface TwitchAppToken {
  token: string;
  clientId: string;
}

export class TwitchApi {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly onRateLimited: (retryAfterSeconds: number | undefined) => void;

  /** onRateLimited: told whenever Twitch answers 429 (the dashboard shows a pop-up alert). */
  constructor(o: { fetch?: FetchLike; now?: () => Date; onRateLimited?: (retryAfterSeconds: number | undefined) => void } = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
    this.onRateLimited = o.onRateLimited ?? (() => {});
  }

  /** The channels Twitch knows among these logins (up to 100), with their live state. Unknown logins are left out. */
  async channelsByLogins(app: TwitchAppToken, logins: string[]): Promise<TwitchChannelInfo[]> {
    if (logins.length === 0) return [];
    if (logins.length > TWITCH_BATCH) throw new Error(`At most ${TWITCH_BATCH} channels per request`);
    const users = await this.users(app, 'login', logins);
    if (users.length === 0) return [];
    const streams = await this.streams(app, users.map((u) => u.id));
    return users.map((u) => {
      const s = streams.get(u.id);
      return {
        slug: u.login,
        broadcasterUserId: u.id,
        displayName: u.displayName,
        profilePicture: u.profilePicture,
        live: Boolean(s),
        startTime: s?.startTime ?? null,
        thumbnail: s?.thumbnail ?? null,
        viewerCount: s?.viewerCount ?? null,
        title: s?.title ?? null,
        category: s?.category ?? null,
      };
    });
  }

  /** Display names and profile pictures by user id (up to 100). */
  async usersByIds(app: TwitchAppToken, ids: string[]): Promise<Array<{ userId: string; name: string; profilePicture: string | null }>> {
    if (ids.length === 0) return [];
    return (await this.users(app, 'id', ids)).map((u) => ({ userId: u.id, name: u.displayName, profilePicture: u.profilePicture }));
  }

  private async users(app: TwitchAppToken, by: 'login' | 'id', values: string[]): Promise<Array<{ id: string; login: string; displayName: string; profilePicture: string | null }>> {
    const query = new URLSearchParams(values.map((v): [string, string] => [by, v]));
    const data = await this.get(app, `/users?${query.toString()}`);
    const out: Array<{ id: string; login: string; displayName: string; profilePicture: string | null }> = [];
    for (const raw of data) {
      const u = raw as { id?: unknown; login?: unknown; display_name?: unknown; profile_image_url?: unknown };
      if (typeof u.id !== 'string' || !/^\d{1,20}$/.test(u.id) || typeof u.login !== 'string' || !/^[a-z0-9_]{1,25}$/i.test(u.login)) continue;
      const login = u.login.toLowerCase();
      out.push({
        id: u.id,
        login,
        displayName: typeof u.display_name === 'string' && u.display_name.trim() ? u.display_name.trim().slice(0, 100) : login,
        profilePicture: typeof u.profile_image_url === 'string' && isTwitchImageUrl(u.profile_image_url) ? u.profile_image_url : null,
      });
    }
    return out;
  }

  private async streams(app: TwitchAppToken, ids: string[]): Promise<Map<string, { startTime: string | null; thumbnail: string | null; viewerCount: number | null; title: string | null; category: string | null }>> {
    const query = new URLSearchParams([...ids.map((id): [string, string] => ['user_id', id]), ['first', String(TWITCH_BATCH)]]);
    const data = await this.get(app, `/streams?${query.toString()}`);
    const live = new Map<string, { startTime: string | null; thumbnail: string | null; viewerCount: number | null; title: string | null; category: string | null }>();
    for (const raw of data) {
      const s = raw as { user_id?: unknown; type?: unknown; started_at?: unknown; thumbnail_url?: unknown; viewer_count?: unknown; title?: unknown; game_name?: unknown };
      if (typeof s.user_id !== 'string' || (s.type !== undefined && s.type !== 'live')) continue;
      const startTime = typeof s.started_at === 'string' && !Number.isNaN(Date.parse(s.started_at)) ? s.started_at : null;
      live.set(s.user_id, {
        startTime,
        thumbnail: typeof s.thumbnail_url === 'string' ? this.thumbnail(s.thumbnail_url) : null,
        viewerCount: typeof s.viewer_count === 'number' && Number.isFinite(s.viewer_count) ? s.viewer_count : null,
        title: typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 300) : null,
        category: typeof s.game_name === 'string' && s.game_name.trim() ? s.game_name.trim().slice(0, 200) : null,
      });
    }
    return live;
  }

  /**
   * The preview image at 1280x720. Twitch keeps the same link for a stream's whole run and updates the picture behind
   * it, so a time marker that changes every THUMBNAIL_REFRESH_MS makes Discord show the newer one.
   */
  private thumbnail(template: string): string | null {
    const url = template.replace('{width}x{height}', THUMBNAIL_SIZE);
    if (!isTwitchImageUrl(url)) return null;
    return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(this.now().getTime() / THUMBNAIL_REFRESH_MS)}`;
  }

  private async get(app: TwitchAppToken, path: string): Promise<unknown[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TWITCH_API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${app.token}`, 'Client-Id': app.clientId, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TwitchApiError('network', 'Twitch couldn’t be reached');
    }
    if (res.status === 401) throw new TwitchApiError('unauthorized', 'Twitch rejected the app’s access token');
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const seconds = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - this.now().getTime() / 1000)) : undefined;
      this.onRateLimited(seconds);
      throw new TwitchApiError('rate_limited', 'Twitch is rate limiting requests', seconds);
    }
    if (res.status === 400) throw new TwitchApiError('bad_request', 'Twitch refused the request');
    if (res.status >= 500) throw new TwitchApiError('server_error', `Twitch had a problem (HTTP ${res.status})`);
    if (!res.ok) throw new TwitchApiError('unexpected_response', `Twitch answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) throw new TwitchApiError('unexpected_response', 'Twitch sent an unexpected answer');
    return body.data;
  }
}
