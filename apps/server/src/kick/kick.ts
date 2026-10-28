/**
 * Kick account authorization (OAuth 2.1 authorization-code grant with PKCE), per Kick's official documentation:
 * https://docs.kick.com/getting-started/generating-tokens-oauth2-flow, /getting-started/scopes, /apis/users,
 * /apis/channels.
 *
 * - OAuth server https://id.kick.com: GET /oauth/authorize (state + PKCE S256 required), POST /oauth/token
 *   (form body; client_id and client_secret in the body, not HTTP Basic), POST /oauth/revoke with `token` and
 *   `token_hint_type` as query parameters.
 * - API https://api.kick.com/public/v1: GET /users (no id = the authorized user; user:read) and GET /channels
 *   (no params = the authorized user's channel; channel:read).
 * - Redirect URI: must match the app settings exactly. Kick recommends `localhost` for local apps (its frontend
 *   rewrites the first "127.0.0.1" in the URL), so CONDUIT registers http://localhost:<port>/oauth/kick/callback.
 * - Token lifetimes are not documented; `expires_in` from each response is used, and refresh tokens are rotated if
 *   Kick returns a new one.
 *
 * Scopes: see kickScopes() — the minimum for identity, the channel, its chat events and sending chat messages.
 */
import type { ConnectionRole } from '@conduit/database';
import type { FetchLike, OAuthAdapter, PlatformIdentity, TokenSet } from '../app/types';
import { OAuthError } from '../app/types';

export const KICK_AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const REVOKE_URL = 'https://id.kick.com/oauth/revoke';
const API_BASE = 'https://api.kick.com/public/v1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Scopes per role (docs.kick.com/getting-started/scopes):
 * - main account: user:read (identity), channel:read (channel), events:subscribe (its chat and reward redemption
 *   events), channel:rewards:write (giveaway bonus-ticket rewards: create, pause, delete, accept/reject redemptions),
 *   moderation:ban (timeouts, bans, unbans) and moderation:chat_message:manage (deleting chat messages), used by
 *   Moderation as the channel owner;
 * - chat:write ("Send chat messages") for whichever account the chatbot uses: the bot account, or the main account
 *   when the user chose "Use my main account".
 */
export function kickScopes(role: ConnectionRole, chatbotMode: 'primary' | 'separate'): string[] {
  if (role === 'bot') return ['user:read', 'chat:write'];
  return [
    'user:read',
    'channel:read',
    'events:subscribe',
    'channel:rewards:write',
    'moderation:ban',
    'moderation:chat_message:manage',
    // Changing the title (!title) and category (!setcategory): Kick default commands.
    'channel:write',
    ...(chatbotMode === 'primary' ? ['chat:write'] : []),
  ];
}

export interface KickClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface KickAdapterOptions {
  /** The user's Kick app credentials; null until configured. Read at use time so they can be replaced. */
  credentials: () => Promise<KickClientCredentials | null>;
  /** Which account the chatbot uses (decides whether the main account is asked for chat:write). */
  chatbotMode?: () => 'primary' | 'separate';
  fetch?: FetchLike;
  now?: () => Date;
}

interface KickTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export class KickAdapter implements OAuthAdapter {
  readonly platform = 'kick' as const;
  readonly scopes: readonly string[] = kickScopes('primary', 'separate');
  readonly usesPkce = true;
  /** Kick's documented recommendation for local apps (see the module comment). */
  readonly redirectHost = 'localhost' as const;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly o: KickAdapterOptions) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
  }

  scopesFor(role: ConnectionRole): readonly string[] {
    return kickScopes(role, this.o.chatbotMode?.() ?? 'primary');
  }

  async configurationProblem(): Promise<string | null> {
    if (await this.o.credentials()) return null;
    return "Kick isn't set up yet. Select Connect to add your Kick app's Client ID and Client Secret first.";
  }

  private async requireCredentials(): Promise<KickClientCredentials> {
    const creds = await this.o.credentials();
    if (!creds) throw new OAuthError('invalid_client', 'The Kick app is not configured');
    return creds;
  }

  async authorizationUrl(p: {
    state: string;
    redirectUri: string;
    codeChallenge: string | null;
    scopes?: readonly string[];
  }): Promise<string> {
    const { clientId } = await this.requireCredentials();
    if (!p.codeChallenge) throw new OAuthError('unexpected_response', 'Kick requires PKCE');
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: p.redirectUri,
      state: p.state,
      scope: (p.scopes ?? this.scopes).join(' '),
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${KICK_AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
  }

  async exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string | null }): Promise<TokenSet> {
    if (!p.codeVerifier) throw new OAuthError('invalid_grant', 'Missing PKCE verifier');
    const { clientId, clientSecret } = await this.requireCredentials();
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code: p.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const { clientId, clientSecret } = await this.requireCredentials();
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  /**
   * An app access token (client credentials grant with the user's own Kick app) for reading public information about
   * any channel — e.g. whether a streamer is live. It acts as the app, not as any account, and is kept in memory only.
   */
  async appAccessToken(): Promise<{ token: string; expiresAt: number }> {
    const { clientId, clientSecret } = await this.requireCredentials();
    const t = await this.tokenRequest({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }, false);
    const expiresAt = t.expiresAt ? Date.parse(t.expiresAt) : this.now().getTime() + 30 * 60_000;
    return { token: t.accessToken, expiresAt };
  }

  /** Checks a Client ID + Client Secret pair with the documented client credentials grant; revokes the test token. */
  async verifyClientCredentials(clientId: string, clientSecret: string): Promise<void> {
    const tokens = await this.tokenRequest({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }, false);
    await this.revoke(tokens.accessToken, 'access_token').catch(() => undefined);
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
    // Kick documents these as query parameters on a form-encoded POST.
    const url = `${REVOKE_URL}?${new URLSearchParams({ token, token_hint_type: hint }).toString()}`;
    const res = await this.send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return;
    if (res.status === 401) throw new OAuthError('unauthorized', 'Kick rejected the revocation request');
    throw new OAuthError('unexpected_response', `Kick revocation failed (HTTP ${res.status})`);
  }

  /**
   * The authorized account: GET /users (user:read). The channel slug (GET /channels) is added when the authorization
   * includes channel:read; without it, the handle is unknown rather than guessed.
   */
  async fetchIdentity(accessToken: string, grantedScopes: readonly string[] = []): Promise<PlatformIdentity> {
    const users = await this.apiGet(accessToken, '/users');
    const user = (users as { data?: unknown } | null)?.data;
    const first = Array.isArray(user)
      ? (user[0] as { user_id?: unknown; name?: unknown; profile_picture?: unknown } | undefined)
      : undefined;
    const id = typeof first?.user_id === 'number' || typeof first?.user_id === 'string' ? String(first.user_id) : '';
    if (!first || !/^\d{1,20}$/.test(id) || typeof first.name !== 'string' || !first.name.trim()) {
      throw new OAuthError('unexpected_response', 'Kick returned an unexpected user object');
    }

    let handle: string | null = null;
    if (grantedScopes.includes('channel:read')) {
      const channels = await this.apiGet(accessToken, '/channels').catch((err) => {
        if (err instanceof OAuthError && err.kind === 'unauthorized') throw err;
        return null; // the identity is confirmed; the slug is a display detail
      });
      const ch = (channels as { data?: unknown } | null)?.data;
      const slug = Array.isArray(ch) ? (ch[0] as { slug?: unknown } | undefined)?.slug : undefined;
      if (typeof slug === 'string' && /^[A-Za-z0-9_-]{1,25}$/.test(slug)) handle = slug;
    }

    return {
      id,
      name: first.name.trim().slice(0, 100),
      handle,
      avatarDataUrl: typeof first.profile_picture === 'string' ? await this.fetchAvatar(first.profile_picture) : null,
    };
  }

  /** Best effort, and only from Kick's own hosts over https: a missing avatar never fails the connection. */
  private async fetchAvatar(raw: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'kick.com' || url.hostname.endsWith('.kick.com')))
      return null;
    try {
      const res = await this.send(url.toString(), {});
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !AVATAR_TYPES.has(type)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
      return `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }

  private async apiGet(accessToken: string, path: string): Promise<unknown> {
    const res = await this.send(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (res.status === 401) throw new OAuthError('unauthorized', 'Kick rejected the access token');
    if (res.status === 403) throw new OAuthError('unexpected_response', `Kick refused ${path}: the authorization lacks a required scope`);
    if (!res.ok) throw new OAuthError('unexpected_response', `Kick ${path} failed (HTTP ${res.status})`);
    return res.json().catch(() => null);
  }

  private async tokenRequest(fields: Record<string, string>, expectRefresh = true): Promise<TokenSet> {
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await res.json().catch(() => null)) as (KickTokenResponse & { error?: unknown }) | null;
    if (!res.ok) {
      const error = typeof body?.error === 'string' ? body.error : '';
      if (error === 'invalid_client' || res.status === 401)
        throw new OAuthError('invalid_client', "Kick rejected the app's Client ID or Client Secret");
      if (error === 'invalid_grant' || res.status === 400)
        throw new OAuthError('invalid_grant', 'Kick rejected the authorization code or refresh token');
      throw new OAuthError('unexpected_response', `Kick token request failed (HTTP ${res.status})`);
    }
    if (!body || typeof body.access_token !== 'string' || !body.access_token)
      throw new OAuthError('unexpected_response', 'Kick returned no access token');
    // Kick's documentation shows expires_in without a type; accept a number or a numeric string.
    const expiresIn = Number(body.expires_in);
    const scopes = typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : null;
    return {
      accessToken: body.access_token,
      refreshToken: expectRefresh && typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      tokenType: typeof body.token_type === 'string' && body.token_type ? body.token_type : 'Bearer',
      // If Kick omits the scope list, it is left empty (unknown) and checked by actually calling the API.
      scopes: scopes ?? [],
      ...(scopes === null ? { scopesUnreported: true } : {}),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(this.now().getTime() + expiresIn * 1000).toISOString() : null,
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new OAuthError('network', 'Kick could not be reached');
    }
  }
}
