/**
 * Twitch account authorization (OAuth 2.0 authorization-code grant), per Twitch's official documentation:
 * https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/, /validate-tokens/, /refresh-tokens/,
 * /revoke-tokens/, and https://dev.twitch.tv/docs/api/reference/#get-users.
 *
 * - OAuth server https://id.twitch.tv: GET /oauth2/authorize, POST /oauth2/token (form body with client_id and
 *   client_secret), POST /oauth2/revoke (client_id + the access token; Twitch revokes access tokens only), GET
 *   /oauth2/validate (`Authorization: OAuth <token>`).
 * - Twitch requires apps to validate user tokens when they start and every hour after that, so this adapter asks
 *   ConnectionService for an hourly check (verifyIntervalMs); the check is /oauth2/validate plus GET /helix/users.
 * - API https://api.twitch.tv/helix: every request sends the Client-Id header with the Bearer token.
 * - Redirect URI: CONDUIT registers http://localhost:<port>/oauth/twitch/callback (Twitch allows http for localhost).
 * - PKCE isn't part of Twitch's documented authorization-code flow (the app is confidential: it has a secret).
 *
 * Scopes: see twitchScopes(). The profile (Get Users) works with any user token, and public live status uses an app
 * access token (see twitch-api.ts).
 */
import type { ConnectionRole } from '@conduit/database';
import type { FetchLike, OAuthAdapter, PlatformIdentity, TokenSet } from '../app/types';
import { OAuthError } from '../app/types';

export const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
export const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Twitch: "validate tokens … on an hourly basis". */
export const TWITCH_VALIDATE_INTERVAL_MS = 60 * 60_000;

/**
 * Scopes per role (dev.twitch.tv/docs/authentication/scopes/):
 * - main account: user:read:chat, to receive its own channel's chat (EventSub channel.chat.message over CONDUIT's
 *   WebSocket session, which needs the reading account's user token);
 * - user:write:chat ("Send chat messages") for whichever account the chatbot uses: the bot account, or the main account
 *   when the user chose "Use my main account".
 */
export function twitchScopes(role: ConnectionRole, chatbotMode: 'primary' | 'separate'): string[] {
  if (role === 'bot') return ['user:write:chat'];
  return ['user:read:chat', ...(chatbotMode === 'primary' ? ['user:write:chat'] : [])];
}

export interface TwitchClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TwitchAdapterOptions {
  /** The user's Twitch app credentials; null until configured. Read at use time so they can be replaced. */
  credentials: () => Promise<TwitchClientCredentials | null>;
  /** Which account the chatbot uses (decides whether the main account is asked for user:write:chat). */
  chatbotMode?: () => 'primary' | 'separate';
  fetch?: FetchLike;
  now?: () => Date;
}

interface TwitchTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Profile pictures come only from Twitch's own image host, over https. */
export function isTwitchImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'static-cdn.jtvnw.net' || url.hostname.endsWith('.jtvnw.net'));
  } catch {
    return false;
  }
}

export class TwitchAdapter implements OAuthAdapter {
  readonly platform = 'twitch' as const;
  readonly usesPkce = false;
  readonly redirectHost = 'localhost' as const;
  readonly verifyIntervalMs = TWITCH_VALIDATE_INTERVAL_MS;
  readonly revokeWith = 'access_token' as const;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly o: TwitchAdapterOptions) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
  }

  get scopes(): readonly string[] {
    return this.scopesFor('primary');
  }

  scopesFor(role: ConnectionRole): readonly string[] {
    return twitchScopes(role, this.o.chatbotMode?.() ?? 'primary');
  }

  async configurationProblem(): Promise<string | null> {
    if (await this.o.credentials()) return null;
    return "Twitch isn't set up yet. Select Connect to add your Twitch app's Client ID and Client Secret first.";
  }

  private async requireCredentials(): Promise<TwitchClientCredentials> {
    const creds = await this.o.credentials();
    if (!creds) throw new OAuthError('invalid_client', 'The Twitch app is not configured');
    return creds;
  }

  async authorizationUrl(p: { state: string; redirectUri: string; codeChallenge: string | null; scopes?: readonly string[] }): Promise<string> {
    const { clientId } = await this.requireCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: p.redirectUri,
      state: p.state,
      scope: (p.scopes ?? this.scopes).join(' '),
      // Always show Twitch's approval page, so the user sees which account they are connecting.
      force_verify: 'true',
    });
    return `${TWITCH_AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
  }

  async exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string | null }): Promise<TokenSet> {
    const { clientId, clientSecret } = await this.requireCredentials();
    return this.tokenRequest({ client_id: clientId, client_secret: clientSecret, code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const { clientId, clientSecret } = await this.requireCredentials();
    return this.tokenRequest({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * An app access token (client credentials grant with the user's own Twitch app) for reading public information about
   * any channel, such as whether a streamer is live. It acts as the app, not as any account, and is kept in memory only.
   */
  async appAccessToken(): Promise<{ token: string; expiresAt: number; clientId: string }> {
    const { clientId, clientSecret } = await this.requireCredentials();
    const t = await this.tokenRequest({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }, false);
    const expiresAt = t.expiresAt ? Date.parse(t.expiresAt) : this.now().getTime() + 30 * 60_000;
    return { token: t.accessToken, expiresAt, clientId };
  }

  /** Checks a Client ID + Client Secret pair with the client credentials grant; revokes the test token. */
  async verifyClientCredentials(clientId: string, clientSecret: string): Promise<void> {
    const tokens = await this.tokenRequest({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }, false);
    await this.revokeFor(clientId, tokens.accessToken).catch(() => undefined);
  }

  /** Twitch revokes access tokens only (revokeWith), which ends the authorization. */
  async revoke(token: string): Promise<void> {
    const { clientId } = await this.requireCredentials();
    await this.revokeFor(clientId, token);
  }

  private async revokeFor(clientId: string, token: string): Promise<void> {
    const res = await this.send(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, token }).toString(),
    });
    await res.body?.cancel().catch(() => undefined);
    // 400 "Invalid token": already expired or revoked, so nothing is left to revoke.
    if (res.ok || res.status === 400) return;
    if (res.status === 404) throw new OAuthError('invalid_client', 'Twitch did not recognise the app');
    throw new OAuthError('unexpected_response', `Twitch revocation failed (HTTP ${res.status})`);
  }

  /**
   * The authorized account: GET /oauth2/validate (Twitch's required token check), then GET /helix/users for the display
   * name and profile picture. Both must describe the same account.
   */
  async fetchIdentity(accessToken: string): Promise<PlatformIdentity> {
    const { clientId } = await this.requireCredentials();
    const validated = await this.validate(accessToken);
    const res = await this.send(`${TWITCH_API_BASE}/users`, { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, Accept: 'application/json' } });
    if (res.status === 401) throw new OAuthError('unauthorized', 'Twitch rejected the access token');
    if (!res.ok) throw new OAuthError('unexpected_response', `Twitch /users failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const user = Array.isArray(body?.data)
      ? (body.data[0] as { id?: unknown; login?: unknown; display_name?: unknown; profile_image_url?: unknown } | undefined)
      : undefined;
    const id = typeof user?.id === 'string' ? user.id : '';
    if (!user || !/^\d{1,20}$/.test(id) || id !== validated.userId || typeof user.login !== 'string' || !/^[a-z0-9_]{1,25}$/i.test(user.login)) {
      throw new OAuthError('unexpected_response', 'Twitch returned an unexpected user object');
    }
    const name = typeof user.display_name === 'string' && user.display_name.trim() ? user.display_name.trim().slice(0, 100) : user.login;
    return {
      id,
      name,
      handle: user.login.toLowerCase(),
      avatarDataUrl: typeof user.profile_image_url === 'string' ? await this.fetchAvatar(user.profile_image_url) : null,
    };
  }

  /** GET /oauth2/validate: 200 with the token's user, or 401 when it is expired or revoked. */
  async validate(accessToken: string): Promise<{ userId: string; scopes: string[] }> {
    const res = await this.send(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}`, Accept: 'application/json' } });
    if (res.status === 401) throw new OAuthError('unauthorized', 'Twitch rejected the access token');
    if (!res.ok) throw new OAuthError('unexpected_response', `Twitch token validation failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => null)) as { user_id?: unknown; scopes?: unknown } | null;
    if (typeof body?.user_id !== 'string' || !body.user_id) throw new OAuthError('unexpected_response', 'Twitch validated a token without a user');
    return { userId: body.user_id, scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [] };
  }

  /** Best effort: a missing avatar never fails the connection. */
  private async fetchAvatar(raw: string): Promise<string | null> {
    if (!isTwitchImageUrl(raw)) return null;
    try {
      const res = await this.send(raw, {});
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !AVATAR_TYPES.has(type)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
      return `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }

  private async tokenRequest(fields: Record<string, string>, expectRefresh = true): Promise<TokenSet> {
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await res.json().catch(() => null)) as (TwitchTokenResponse & { message?: unknown }) | null;
    if (!res.ok) {
      const message = typeof body?.message === 'string' ? body.message.toLowerCase() : '';
      // Twitch answers a wrong secret with 403 "invalid client secret" and an unknown Client ID with 400 "invalid client".
      if (res.status === 401 || res.status === 403 || message.includes('invalid client'))
        throw new OAuthError('invalid_client', "Twitch rejected the app's Client ID or Client Secret");
      if (res.status === 400) throw new OAuthError('invalid_grant', 'Twitch rejected the authorization code or refresh token');
      throw new OAuthError('unexpected_response', `Twitch token request failed (HTTP ${res.status})`);
    }
    if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new OAuthError('unexpected_response', 'Twitch returned no access token');
    const expiresIn = Number(body.expires_in);
    // Twitch lists the granted scopes as an array, and leaves it out when none were requested.
    const scopes = Array.isArray(body.scope) ? body.scope.filter((s): s is string => typeof s === 'string') : [];
    return {
      accessToken: body.access_token,
      refreshToken: expectRefresh && typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      tokenType: 'Bearer',
      scopes,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(this.now().getTime() + expiresIn * 1000).toISOString() : null,
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new OAuthError('network', 'Twitch could not be reached');
    }
  }
}
