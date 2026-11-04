/**
 * Where Stream Notifications read live status: one source per platform, each with an app access token from the user's
 * own app for that platform (public channel information; no rights over anyone's channel). The token is kept in
 * memory, renewed before it expires, and renewed once more if the platform rejects it early.
 */
import type { NotificationPlatform } from '@conduit/shared';
import { KickApiError, type KickChannelInfo, type KickChatApi } from './kick-chat-api';
import { TwitchApiError, TWITCH_BATCH, type TwitchApi } from '../twitch/twitch-api';

/** A channel's live state as the notification service uses it (the same for every platform). */
export interface LiveChannelInfo extends KickChannelInfo {
  /** Display name and profile picture, when the platform sends them with the channel (Twitch). */
  displayName?: string;
  profilePicture?: string | null;
}

export interface LiveSource {
  readonly platform: NotificationPlatform;
  /** "Kick", "Twitch". */
  readonly name: string;
  /** Channels per request. */
  readonly batch: number;
  /** What to do when the platform's app isn't set up. */
  readonly setupHint: string;
  configured(): Promise<boolean>;
  /** The channels the platform knows among these names (at most `batch`), live ones with a thumbnail when it has one. */
  channels(slugs: string[]): Promise<LiveChannelInfo[]>;
  profiles(ids: string[]): Promise<Array<{ userId: string; name: string; profilePicture: string | null }>>;
  url(slug: string): string;
}

/** A platform's own words for a failed request (they're written for the user), otherwise a neutral one. */
export function sourceErrorText(err: unknown): string {
  return err instanceof KickApiError || err instanceof TwitchApiError ? err.message : 'unknown error';
}

export function sourceErrorKind(err: unknown): string {
  return err instanceof KickApiError || err instanceof TwitchApiError ? err.kind : 'unknown';
}

type Token = { token: string; expiresAt: number };

/** Runs `fn` with a current app token; a token the platform rejects early is replaced once. */
class TokenCache<T extends Token> {
  private current: T | null = null;
  constructor(
    private readonly fetchToken: () => Promise<T>,
    private readonly now: () => Date,
    private readonly rejected: (err: unknown) => boolean,
  ) {}

  async with<R>(fn: (token: T) => Promise<R>): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      if (!this.current || this.current.expiresAt - 60_000 < this.now().getTime()) this.current = await this.fetchToken();
      try {
        return await fn(this.current);
      } catch (err) {
        if (this.rejected(err) && attempt === 0) {
          this.current = null;
          continue;
        }
        throw err;
      }
    }
  }
}

export function kickLiveSource(o: {
  api: Pick<KickChatApi, 'channelsBySlugs' | 'usersByIds' | 'livestreamThumbnails'>;
  appToken: () => Promise<Token>;
  configured: () => Promise<boolean>;
  now: () => Date;
  onThumbnailError?: (err: unknown) => void;
}): LiveSource {
  const tokens = new TokenCache(o.appToken, o.now, (err) => err instanceof KickApiError && err.kind === 'unauthorized');
  return {
    platform: 'kick',
    name: 'Kick',
    batch: 50,
    setupHint: 'Set up your Kick app first (Dashboard → Kick → Connect): CONDUIT reads public live status with it.',
    configured: o.configured,
    async channels(slugs) {
      const infos: LiveChannelInfo[] = await tokens.with((t) => o.api.channelsBySlugs(t.token, slugs));
      // Live channels whose info came without a thumbnail: ask Kick's livestreams endpoint (one request).
      const missing = infos.filter((i) => i.live && !i.thumbnail);
      if (missing.length) {
        try {
          const thumbs = await tokens.with((t) => o.api.livestreamThumbnails(t.token, [...new Set(missing.map((i) => i.broadcasterUserId))]));
          for (const i of missing) i.thumbnail = thumbs.get(i.broadcasterUserId) ?? null;
        } catch (err) {
          o.onThumbnailError?.(err);
        }
      }
      return infos;
    },
    profiles: (ids) => tokens.with((t) => o.api.usersByIds(t.token, ids)),
    url: (slug) => `https://kick.com/${slug}`,
  };
}

export function twitchLiveSource(o: {
  api: Pick<TwitchApi, 'channelsByLogins' | 'usersByIds'>;
  appToken: () => Promise<Token & { clientId: string }>;
  configured: () => Promise<boolean>;
  now: () => Date;
}): LiveSource {
  const tokens = new TokenCache(o.appToken, o.now, (err) => err instanceof TwitchApiError && err.kind === 'unauthorized');
  return {
    platform: 'twitch',
    name: 'Twitch',
    batch: TWITCH_BATCH,
    setupHint: 'Set up your Twitch app first (Dashboard → Twitch → Connect): CONDUIT reads public live status with it.',
    configured: o.configured,
    channels: (slugs) => tokens.with((t) => o.api.channelsByLogins(t, slugs)),
    profiles: (ids) => tokens.with((t) => o.api.usersByIds(t, ids)),
    url: (slug) => `https://www.twitch.tv/${slug}`,
  };
}
