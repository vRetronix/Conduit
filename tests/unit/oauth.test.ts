import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_TTL_MS, createPkcePair, PendingAuthorizations, pkceChallenge } from '../../apps/server/src/app/oauth';

describe('PKCE (RFC 7636)', () => {
  it('computes the S256 challenge from the RFC test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates high-entropy verifiers that are valid PKCE strings', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('PendingAuthorizations (state)', () => {
  const redirect = 'http://127.0.0.1:47821/oauth/discord/callback';

  it('issues unguessable states and includes PKCE only when the platform uses it', () => {
    const p = new PendingAuthorizations();
    const discord = p.start('discord', redirect, false);
    const kick = p.start('kick', 'http://127.0.0.1:47821/oauth/kick/callback', true);
    expect(discord.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(discord.codeVerifier).toBeNull();
    expect(discord.codeChallenge).toBeNull();
    expect(kick.codeChallenge).toBe(pkceChallenge(kick.codeVerifier!));
  });

  it('rejects missing, unknown and cross-platform states', () => {
    const p = new PendingAuthorizations();
    const { state } = p.start('discord', redirect, false);
    expect(p.consume('discord', undefined)).toEqual({ ok: false, reason: 'missing_state' });
    expect(p.consume('discord', '')).toEqual({ ok: false, reason: 'missing_state' });
    expect(p.consume('discord', 'forged-state')).toEqual({ ok: false, reason: 'unknown_state' });
    expect(p.consume('twitch', state)).toEqual({ ok: false, reason: 'wrong_platform' });
    // None of the above consumed the real state.
    expect(p.consume('discord', state).ok).toBe(true);
  });

  it('accepts a state exactly once (replay protection)', () => {
    const p = new PendingAuthorizations();
    const { state } = p.start('discord', redirect, false);
    expect(p.consume('discord', state).ok).toBe(true);
    expect(p.consume('discord', state)).toEqual({ ok: false, reason: 'unknown_state' });
  });

  it('expires states after the authorization window', () => {
    let now = 0;
    const p = new PendingAuthorizations(() => now);
    const { state } = p.start('discord', redirect, false);
    now = AUTHORIZATION_TTL_MS + 1;
    expect(p.consume('discord', state)).toEqual({ ok: false, reason: 'expired' });
    const again = p.start('discord', redirect, false);
    now += AUTHORIZATION_TTL_MS + 1;
    expect(p.sweep().map((e) => e.state)).toEqual([again.state]);
    expect(p.isPending('discord')).toBe(false);
  });

  it('keeps one pending authorization per platform; starting again invalidates the old state', () => {
    const p = new PendingAuthorizations();
    const first = p.start('discord', redirect, false);
    const second = p.start('discord', redirect, false);
    expect(p.consume('discord', first.state)).toEqual({ ok: false, reason: 'unknown_state' });
    expect(p.consume('discord', second.state).ok).toBe(true);
  });

  it('cancel removes the pending authorization', () => {
    const p = new PendingAuthorizations();
    const { state } = p.start('discord', redirect, false);
    expect(p.cancel('discord')).toBe(true);
    expect(p.cancel('discord')).toBe(false);
    expect(p.consume('discord', state)).toEqual({ ok: false, reason: 'unknown_state' });
  });
});
