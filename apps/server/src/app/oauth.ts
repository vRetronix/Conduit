/**
 * OAuth building blocks shared by every platform adapter: unguessable single-use `state` (CSRF protection and the
 * binding between a browser redirect and the authorization CONDUIT started), and PKCE (RFC 7636) for platforms
 * that document it.
 */
import crypto from 'node:crypto';
import type { Platform } from '@conduit/shared';

/** How long the user has to finish authorizing in the browser. */
export const AUTHORIZATION_TTL_MS = 10 * 60_000;

export function randomUrlSafe(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** RFC 7636: a 43-character verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * What a redirect completes. Several purposes can share one registered redirect URI (Discord: the user's account
 * sign-in and adding the bot to a server); the single-use state tells them apart.
 */
export type AuthorizationPurpose =
  /** The streamer's own account (connection role 'primary'). */
  | 'account'
  /** A separate chatbot account (connection role 'bot'). */
  | 'bot-account'
  /** Adding the Discord bot to a server. */
  | 'bot-install';

export interface PendingAuthorization {
  platform: Platform;
  purpose: AuthorizationPurpose;
  state: string;
  codeVerifier: string | null;
  redirectUri: string;
  startedAt: number;
}

export type ConsumeResult =
  | { ok: true; pending: PendingAuthorization }
  | { ok: false; reason: 'missing_state' | 'unknown_state' | 'wrong_platform' | 'expired' };

/**
 * Authorizations started by CONDUIT and not yet completed: at most one per platform and purpose. A state is consumed on first
 * use, so a replayed redirect (or a second use of the same code) is rejected.
 */
export class PendingAuthorizations {
  private readonly byState = new Map<string, PendingAuthorization>();

  constructor(private readonly now: () => number = Date.now) {}

  start(
    platform: Platform,
    redirectUri: string,
    usesPkce: boolean,
    purpose: AuthorizationPurpose = 'account',
  ): PendingAuthorization & { codeChallenge: string | null } {
    this.cancel(platform, purpose);
    const pkce = usesPkce ? createPkcePair() : null;
    const pending: PendingAuthorization = {
      platform,
      purpose,
      state: randomUrlSafe(32),
      codeVerifier: pkce?.verifier ?? null,
      redirectUri,
      startedAt: this.now(),
    };
    this.byState.set(pending.state, pending);
    return { ...pending, codeChallenge: pkce?.challenge ?? null };
  }

  /** Validates and removes the pending authorization for a redirect. Never leaves a state reusable. */
  consume(platform: Platform, state: string | undefined): ConsumeResult {
    if (!state) return { ok: false, reason: 'missing_state' };
    const pending = this.byState.get(state);
    if (!pending) return { ok: false, reason: 'unknown_state' };
    if (pending.platform !== platform) return { ok: false, reason: 'wrong_platform' };
    this.byState.delete(state);
    if (this.now() - pending.startedAt > AUTHORIZATION_TTL_MS) return { ok: false, reason: 'expired' };
    return { ok: true, pending };
  }

  isPending(platform: Platform, purpose: AuthorizationPurpose = 'account'): boolean {
    this.sweep();
    return [...this.byState.values()].some((p) => p.platform === platform && p.purpose === purpose);
  }

  /** Drops a platform's pending authorization for a purpose; returns whether there was one. */
  cancel(platform: Platform, purpose: AuthorizationPurpose = 'account'): boolean {
    let removed = false;
    for (const [state, p] of this.byState) {
      if (p.platform === platform && p.purpose === purpose) {
        this.byState.delete(state);
        removed = true;
      }
    }
    return removed;
  }

  get size(): number {
    this.sweep();
    return this.byState.size;
  }

  /** Expired authorizations, removed. */
  sweep(): PendingAuthorization[] {
    const expired: PendingAuthorization[] = [];
    for (const [state, p] of this.byState) {
      if (this.now() - p.startedAt > AUTHORIZATION_TTL_MS) {
        this.byState.delete(state);
        expired.push(p);
      }
    }
    return expired;
  }
}
