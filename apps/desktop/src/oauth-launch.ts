/**
 * The only URLs the desktop will open for platform authorization. The backend builds the URL; the main process
 * re-checks it here before handing it to the system browser, so neither a compromised renderer nor a bug can make
 * CONDUIT open an arbitrary page. Kept free of Electron imports for unit testing.
 */
import type { Platform } from '@conduit/shared/app/connections';
import { DISCORD_INSTALL_PERMISSIONS } from '@conduit/shared/discord/discord-permissions';

const AUTHORIZATION_PAGES: Partial<Record<Platform, { origin: string; pathname: string; redirectHost: string; pkce: boolean }>> = {
  discord: { origin: 'https://discord.com', pathname: '/oauth2/authorize', redirectHost: '127.0.0.1', pkce: false },
  // Kick requires PKCE (S256) and recommends a localhost redirect for local apps.
  kick: { origin: 'https://id.kick.com', pathname: '/oauth/authorize', redirectHost: 'localhost', pkce: true },
};

/** Kick's developer settings, where users create their own Kick app (fixed URL; nothing comes from the renderer). */
export const KICK_DEVELOPER_SETTINGS_URL = 'https://kick.com/settings/developer';

const REQUIRED_PARAMS = ['client_id', 'response_type', 'redirect_uri', 'state'];

/** Returns the URL if it is the platform's official authorization page with a loopback redirect, otherwise null. */
export function validateAuthorizationUrl(platform: Platform, raw: unknown): string | null {
  const page = AUTHORIZATION_PAGES[platform];
  if (!page || typeof raw !== 'string' || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== page.origin || url.pathname !== page.pathname || url.username || url.password || url.hash) return null;
  if (!REQUIRED_PARAMS.every((p) => url.searchParams.get(p))) return null;
  if (url.searchParams.get('response_type') !== 'code') return null;
  if (page.pkce && (url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? ''))) {
    return null;
  }
  // The redirect must come back to CONDUIT's loopback callback for this platform, never to another site.
  let redirect: URL;
  try {
    redirect = new URL(url.searchParams.get('redirect_uri')!);
  } catch {
    return null;
  }
  if (redirect.protocol !== 'http:' || redirect.hostname !== page.redirectHost || redirect.pathname !== `/oauth/${platform}/callback`) return null;
  return url.toString();
}

/**
 * Discord's add-bot page, as built by the backend: the official authorization page, `bot` and
 * `applications.commands` scopes only (adding the bot, and letting it register slash commands), exactly the giveaway
 * channel permissions (View Channel, Send Messages, Embed Links; never
 * Administrator), redirecting to CONDUIT's loopback callback. Anything else is refused.
 */
export function validateBotInstallUrl(raw: unknown): string | null {
  const checked = validateAuthorizationUrl('discord', raw);
  if (!checked) return null;
  const params = new URL(checked).searchParams;
  if (params.get('scope') !== 'bot applications.commands') return null;
  if (!/^\d{15,25}$/.test(params.get('client_id') ?? '')) return null;
  if (params.get('permissions') !== DISCORD_INSTALL_PERMISSIONS) return null;
  return checked;
}

const PORTAL = 'https://discord.com/developers/applications';

/**
 * Developer Portal pages the renderer may ask to open: chosen from a fixed list, with the application id taken from
 * the backend (never from the renderer). Returns null for anything else.
 */
export function discordPortalUrl(page: unknown, applicationId: string | null): string | null {
  if (page === 'applications') return PORTAL;
  if (page !== 'oauth2' && page !== 'bot' && page !== 'installation') return null;
  if (!applicationId || !/^\d{15,25}$/.test(applicationId)) return PORTAL;
  return `${PORTAL}/${applicationId}/${page}`;
}
