/**
 * Platform integrations and their OAuth adapters.
 *
 * Implemented: Discord user authorization (identify); Kick account authorization (streamer and optional chatbot
 * account). Not yet implemented: YouTube, Twitch — their cards stay
 * "Not Connected" and Connect reports that honestly.
 * Every integration uses the platform's official OAuth flow, requests only the scopes its features need, and records
 * a connection only after the platform's API has confirmed the authorized identity. CONDUIT never asks for
 * platform passwords.
 */
import type { Platform } from '@conduit/shared';
import { DiscordAdapter } from '../discord/discord';
import type { DiscordCredentials } from '../discord/discord-credentials';
import { KickAdapter } from '../kick/kick';
import type { KickCredentials } from '../kick/kick-credentials';
import type { FetchLike, OAuthAdapter } from './types';

export type Adapters = Partial<Record<Platform, OAuthAdapter>>;

export function createAdapters(
  deps: { discordCredentials: DiscordCredentials; kickCredentials: KickCredentials },
  opts: { version: string; fetch?: FetchLike; now?: () => Date },
): Adapters {
  return {
    discord: new DiscordAdapter({ credentials: () => deps.discordCredentials.client(), version: opts.version, fetch: opts.fetch, now: opts.now }),
    kick: new KickAdapter({
      credentials: () => deps.kickCredentials.client(),
      chatbotMode: () => deps.kickCredentials.chatbotMode(),
      fetch: opts.fetch,
      now: opts.now,
    }),
  };
}
