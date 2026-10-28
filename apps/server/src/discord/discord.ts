/**
 * Discord user authorization (OAuth2 authorization-code grant), per the official documentation:
 * https://docs.discord.com/developers/topics/oauth2 and https://docs.discord.com/developers/resources/user
 *
 * - Authorize at https://discord.com/oauth2/authorize; exchange, refresh and revoke at
 *   https://discord.com/api/oauth2/token[/revoke], form-encoded, with HTTP Basic client authentication.
 * - Scope `identify` only: enough for GET /users/@me (id, username, global_name, avatar), and no email.
 * - Discord documents no PKCE for this flow, so none is sent; `state` protects the redirect.
 *
 * This connects the streamer's Discord *account*. It does not add the bot to any server; that is a separate grant
 * (`bot` scope) handled by the setup wizard (services/discord-setup-service.ts).
 *
 * Credentials are read at use time from the user's own application configuration (DPAPI vault), so they can be set or
 * replaced in the setup wizard without restarting.
 */
import type { DiscordClientCredentials } from './discord-credentials';
import type { FetchLike, OAuthAdapter, PlatformIdentity, TokenSet } from '../app/types';
import { OAuthError } from '../app/types';

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke';
const API_BASE = 'https://discord.com/api/v10';
const CDN_BASE = 'https://cdn.discordapp.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 128 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface DiscordAdapterOptions {
  /** The user's application credentials; null until configured in the setup wizard. */
  credentials: () => Promise<DiscordClientCredentials | null>;
  /** Used in the User-Agent Discord requires: "DiscordBot ($url, $versionNumber)". */
  version: string;
  fetch?: FetchLike;
  now?: () => Date;
}

interface DiscordTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
}

export class DiscordAdapter implements OAuthAdapter {
  readonly platform = 'discord' as const;
  readonly scopes = ['identify'] as const;
  readonly usesPkce = false;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly userAgent: string;

  constructor(private readonly o: DiscordAdapterOptions) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
    this.userAgent = `DiscordBot (https://github.com/vRetronix/CONDUIT, ${o.version}) CONDUIT`;
  }

  async configurationProblem(): Promise<string | null> {
    if (await this.o.credentials()) return null;
    return "Discord isn't set up yet. Select Connect to start the setup: first you'll add your own Discord application's details.";
  }

  private async requireCredentials(): Promise<DiscordClientCredentials> {
    const creds = await this.o.credentials();
    if (!creds) throw new OAuthError('invalid_client', 'The Discord application is not configured');
    return creds;
  }

  /** Discord documents no PKCE, so codeChallenge is never set (usesPkce = false) and is ignored. */
  async authorizationUrl(p: { state: string; redirectUri: string; codeChallenge?: string | null }): Promise<string> {
    const { clientId } = await this.requireCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state: p.state,
      redirect_uri: p.redirectUri,
      // Always show the consent screen so the user sees exactly what CONDUIT asks for.
      prompt: 'consent',
    });
    return `${DISCORD_AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
  }

  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string | null }): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
    const res = await this.send(REVOKE_URL, { method: 'POST', headers: await this.formHeaders(), body: new URLSearchParams({ token, token_type_hint: hint }).toString() });
    if (res.ok) return;
    if (res.status === 401) throw new OAuthError('invalid_client', 'Discord rejected CONDUIT\'s client credentials');
    throw new OAuthError('unexpected_response', `Discord revocation failed (HTTP ${res.status})`);
  }

  async fetchIdentity(accessToken: string): Promise<PlatformIdentity> {
    const res = await this.send(`${API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': this.userAgent, Accept: 'application/json' },
    });
    if (res.status === 401) throw new OAuthError('unauthorized', 'Discord rejected the access token');
    if (!res.ok) throw new OAuthError('unexpected_response', `Discord /users/@me failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => null)) as { id?: unknown; username?: unknown; global_name?: unknown; avatar?: unknown } | null;
    if (!body || typeof body.id !== 'string' || !/^\d{1,25}$/.test(body.id) || typeof body.username !== 'string') {
      throw new OAuthError('unexpected_response', 'Discord returned an unexpected user object');
    }
    const globalName = typeof body.global_name === 'string' && body.global_name.trim() ? body.global_name.trim() : null;
    const avatarHash = typeof body.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(body.avatar) ? body.avatar : null;
    return {
      id: body.id,
      name: (globalName ?? body.username).slice(0, 100),
      handle: body.username.slice(0, 100),
      avatarDataUrl: avatarHash ? await this.fetchAvatar(body.id, avatarHash) : null,
    };
  }

  /** Best effort: a missing avatar never fails the connection. */
  private async fetchAvatar(userId: string, hash: string): Promise<string | null> {
    try {
      const res = await this.send(`${CDN_BASE}/avatars/${userId}/${hash}.png?size=64`, { headers: { 'User-Agent': this.userAgent } });
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !AVATAR_TYPES.has(type)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
      return `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }

  private async formHeaders(): Promise<Record<string, string>> {
    const { clientId, clientSecret } = await this.requireCredentials();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenSet> {
    const res = await this.send(TOKEN_URL, { method: 'POST', headers: await this.formHeaders(), body: new URLSearchParams(fields).toString() });
    const body = (await res.json().catch(() => null)) as (DiscordTokenResponse & { error?: unknown }) | null;
    if (!res.ok) {
      const error = typeof body?.error === 'string' ? body.error : '';
      if (error === 'invalid_grant') throw new OAuthError('invalid_grant', 'Discord rejected the authorization code or refresh token');
      if (error === 'invalid_client' || res.status === 401) throw new OAuthError('invalid_client', 'Discord rejected CONDUIT\'s client credentials');
      throw new OAuthError('unexpected_response', `Discord token request failed (HTTP ${res.status})`);
    }
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new OAuthError('unexpected_response', 'Discord returned no access token');
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : null;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
      scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [...this.scopes],
      expiresAt: expiresIn ? new Date(this.now().getTime() + expiresIn * 1000).toISOString() : null,
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new OAuthError('network', 'Discord could not be reached');
    }
  }
}
