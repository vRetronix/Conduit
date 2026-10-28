import type { ConnectionRole } from '@conduit/database';
import type { Platform } from '@conduit/shared';

/** Tokens returned by a platform. Held only in the encrypted credential vault, never in the database or logs. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scopes: string[];
  /** ISO time the access token expires, if the platform said. */
  expiresAt: string | null;
  /** True when the platform did not report the granted scopes at all (as opposed to reporting too few). */
  scopesUnreported?: boolean;
}

/** The platform account an authorization belongs to, as confirmed by the platform's API. */
export interface PlatformIdentity {
  id: string;
  name: string;
  handle: string | null;
  avatarDataUrl: string | null;
}

export type OAuthErrorKind =
  /** The code or refresh token is invalid, expired, already used or revoked. */
  | 'invalid_grant'
  /** The platform rejected CONDUIT's client credentials. */
  | 'invalid_client'
  /** The access token was rejected (expired or revoked). */
  | 'unauthorized'
  /** The platform could not be reached. */
  | 'network'
  /** The platform answered in an unexpected way. */
  | 'unexpected_response';

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** A platform's official OAuth authorization-code flow and the identity call that confirms it. */
export interface OAuthAdapter {
  readonly platform: Platform;
  /** Scopes requested: the minimum needed for this platform's current features. */
  readonly scopes: readonly string[];
  /** Whether the platform documents PKCE for this flow (if so, a verifier is created and sent). */
  readonly usesPkce: boolean;
  /** Host for the loopback redirect URI, when the platform needs one other than 127.0.0.1 (Kick: localhost). */
  readonly redirectHost?: 'localhost' | '127.0.0.1';
  /** Scopes for a connection role, when they differ by role (default: `scopes`). */
  scopesFor?(role: ConnectionRole): readonly string[];
  /** Missing configuration, with the steps to supply it; null when ready. */
  configurationProblem(): Promise<string | null>;
  authorizationUrl(p: { state: string; redirectUri: string; codeChallenge: string | null; scopes?: readonly string[] }): Promise<string>;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string | null }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** `grantedScopes` lets an adapter fetch optional details only when they were granted. */
  fetchIdentity(accessToken: string, grantedScopes?: readonly string[]): Promise<PlatformIdentity>;
  /** Revokes the authorization at the platform. */
  revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
