import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@conduit/security';
import type { AuthResponse, SessionInfo } from '@conduit/shared';
import { auditActions, createHarness, createUser, OWNER, setupOwner, type Harness } from '../helpers/harness';

let h: Harness;
let owner: AuthResponse;
beforeEach(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
});
afterEach(async () => {
  await h.close();
});

const HOUR = 60 * 60_000;
const me = (token: string) => h.call('GET', '/api/auth/session', { token });
const login = () => h.call<AuthResponse>('POST', '/api/auth/login', { body: { username: OWNER.username, password: OWNER.password } });

describe('sessions', () => {
  it('a valid session works and reports the current user', async () => {
    const res = await me(owner.token);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(owner.user.id);
    expect(res.body.session).toMatchObject({ id: owner.session.id, current: true });
  });

  it('rejects missing, malformed and unknown tokens with a generic 401', async () => {
    const variants: Array<Record<string, string>> = [
      {},
      { Authorization: 'Bearer' },
      { Authorization: `Basic ${owner.token}` },
      { Authorization: 'Bearer not-a-token' },
      { Authorization: `Bearer ${'A'.repeat(43)}` },
    ];
    for (const headers of variants) {
      const res = await h.call('GET', '/api/auth/session', { headers });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: 'Authentication required' } });
    }
  });

  it('does not accept the token from the URL', async () => {
    expect((await h.call('GET', `/api/auth/session?token=${owner.token}`)).status).toBe(401);
  });

  it('expires after the absolute lifetime', async () => {
    // Keep it active so the idle timeout does not trigger first.
    for (let elapsed = 0; elapsed < 13 * 24; elapsed += 24) {
      h.clock.advance(24 * HOUR);
      expect((await me(owner.token)).status).toBe(200);
    }
    h.clock.advance(24 * HOUR);
    expect((await me(owner.token)).status).toBe(401);
  });

  it('expires after the idle timeout, well before the absolute lifetime', async () => {
    const short = await createHarness({ CONDUIT_SESSION_TTL_HOURS: '48', CONDUIT_SESSION_IDLE_HOURS: '12' });
    try {
      const { token } = await setupOwner(short);
      const check = () => short.call('GET', '/api/auth/session', { token });
      short.clock.advance(11 * HOUR);
      expect((await check()).status).toBe(200);
      short.clock.advance(11 * HOUR);
      expect((await check()).status).toBe(200); // activity reset the idle timer
      short.clock.advance(12 * HOUR); // 34h in: inside the 48h lifetime, but idle for 12h
      expect((await check()).status).toBe(401);
    } finally {
      await short.close();
    }
  });

  it('logout invalidates the session', async () => {
    expect((await h.call('POST', '/api/auth/logout', { token: owner.token })).status).toBe(204);
    expect((await me(owner.token)).status).toBe(401);
    expect((await h.call('POST', '/api/auth/logout', { token: owner.token })).status).toBe(401);
  });

  it('lists only the caller’s active sessions and revokes one of them', async () => {
    const second = (await login()).body;
    const list = await h.call<SessionInfo[]>('GET', '/api/auth/sessions', { token: owner.token });
    expect(list.body.map((s) => s.id).sort()).toEqual([owner.session.id, second.session.id].sort());
    expect(list.body.find((s) => s.current)?.id).toBe(owner.session.id);

    expect((await h.call('DELETE', `/api/auth/sessions/${second.session.id}`, { token: owner.token })).status).toBe(204);
    expect((await me(second.token)).status).toBe(401);
    expect((await me(owner.token)).status).toBe(200);
  });

  it('cannot revoke another user’s session (looks like it does not exist)', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    const res = await h.call('DELETE', `/api/auth/sessions/${owner.session.id}`, { token: alice.token });
    expect(res.status).toBe(404);
    expect((await me(owner.token)).status).toBe(200);
  });

  it('only the instance admin can revoke all of another user’s sessions', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    const bob = await createUser(h, owner.token, 'bob');
    expect((await h.call('POST', `/api/admin/users/${bob.user.id}/revoke-sessions`, { token: alice.token })).status).toBe(403);
    expect((await me(bob.token)).status).toBe(200);
    const res = await h.call('POST', `/api/admin/users/${bob.user.id}/revoke-sessions`, { token: owner.token });
    expect(res.body).toEqual({ revoked: 1 });
    expect((await me(bob.token)).status).toBe(401);
  });

  it('a disabled account loses access immediately, mid-session', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    expect((await h.call('GET', '/api/profiles', { token: alice.token })).status).toBe(200);
    await h.call('PATCH', `/api/admin/users/${alice.user.id}`, { token: owner.token, body: { status: 'disabled' } });
    expect((await h.call('GET', '/api/profiles', { token: alice.token })).status).toBe(401);
  });

  it('changing the password requires the current one and signs out other sessions', async () => {
    const other = (await login()).body;
    const bad = await h.call('POST', '/api/me/password', { token: owner.token, body: { currentPassword: 'nope', newPassword: 'a brand new passphrase' } });
    expect(bad.status).toBe(403);
    const ok = await h.call('POST', '/api/me/password', { token: owner.token, body: { currentPassword: OWNER.password, newPassword: 'a brand new passphrase' } });
    expect(ok.status).toBe(204);
    expect((await me(owner.token)).status).toBe(200);
    expect((await me(other.token)).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { username: 'owner', password: 'a brand new passphrase' } })).status).toBe(200);
  });

  it('an admin password reset signs the user out everywhere', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    expect((await h.call('POST', `/api/admin/users/${alice.user.id}/password`, { token: alice.token, body: { password: 'x'.repeat(12) } })).status).toBe(403);
    expect((await h.call('POST', `/api/admin/users/${owner.user.id}/password`, { token: owner.token, body: { password: 'x'.repeat(12) } })).status).toBe(403);
    expect((await h.call('POST', `/api/admin/users/${alice.user.id}/password`, { token: owner.token, body: { password: 'reset passphrase 1' } })).status).toBe(204);
    expect((await me(alice.token)).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { username: 'alice', password: 'reset passphrase 1' } })).status).toBe(200);
  });

  it('stores only token hashes', async () => {
    const rows = h.db.prepare('SELECT * FROM sessions').all();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(owner.token);
    expect(rows.map((r) => (r as { token_hash: string }).token_hash)).toContain(hashToken(owner.token));
  });

  it('cleans up long-dead sessions', async () => {
    await h.call('POST', '/api/auth/logout', { token: owner.token });
    h.clock.advance(8 * 24 * HOUR);
    expect(h.services.auth.cleanupSessions()).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('audits logout and revocations', async () => {
    const second = (await login()).body;
    await h.call('DELETE', `/api/auth/sessions/${second.session.id}`, { token: owner.token });
    await h.call('POST', '/api/auth/logout', { token: owner.token });
    const actions = auditActions(h).map((a) => a.action);
    expect(actions).toContain('session.revoked');
    expect(actions).toContain('auth.logout');
  });
});
