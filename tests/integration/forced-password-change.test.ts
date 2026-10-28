import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse, CurrentSessionResponse } from '@conduit/shared';
import { auditActions, createHarness, OWNER, openSocket, setupOwner, upgradeStatus, type Harness } from '../helpers/harness';

/**
 * API-level behaviour of the persistent "must change password" flag. Offline recovery sets it
 * (covered end-to-end in admin-recovery.test.ts); here it is set directly to exercise the API.
 */
let h: Harness;
let flagged: AuthResponse;
const TEMP = 'temporary-pass-23456';

beforeEach(async () => {
  h = await createHarness();
  const owner = await setupOwner(h);
  // Simulate offline recovery: new password + flag + all sessions revoked.
  await h.call('POST', '/api/me/password', { token: owner.token, body: { currentPassword: OWNER.password, newPassword: TEMP } });
  h.db.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'owner'").run();
  h.db.prepare("UPDATE sessions SET revoked_at = '2026-01-01T00:00:00.000Z', revoked_reason = 'password_recovery'").run();
  flagged = (await h.call<AuthResponse>('POST', '/api/auth/login', { body: { username: 'owner', password: TEMP } })).body;
});
afterEach(async () => {
  await h.close();
});

const changePassword = (token: string, currentPassword: string, newPassword: string) =>
  h.call('POST', '/api/me/password', { token, body: { currentPassword, newPassword } });

describe('forced password change', () => {
  it('login succeeds and reports the pending change', () => {
    expect(flagged.user.mustChangePassword).toBe(true);
    expect(flagged.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('allows only reading the session, changing the password and signing out', async () => {
    const t = flagged.token;
    expect((await h.call<CurrentSessionResponse>('GET', '/api/auth/session', { token: t })).body.user.mustChangePassword).toBe(true);
    const blocked: Array<[string, string, unknown?]> = [
      ['GET', '/api/profiles'],
      ['POST', '/api/profiles', { displayName: 'x' }],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { username: 'eve', displayName: 'Eve', password: 'eve-password-1' }],
      ['DELETE', '/api/auth/sessions/00000000-0000-4000-8000-000000000000'],
    ];
    for (const [method, path, body] of blocked) {
      const res = await h.call(method, path, { token: t, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('password_change_required');
    }
    expect((await h.call('GET', '/api/health')).status).toBe(200);
  });

  it('refuses realtime connections until the password is changed', async () => {
    expect(await upgradeStatus(h, { headers: { Authorization: `Bearer ${flagged.token}` } })).toBe(403);
    expect((await changePassword(flagged.token, TEMP, 'my own new passphrase')).status).toBe(204);
    const socket = await openSocket(h, flagged.token);
    socket.ws.close();
  });

  it('requires the temporary password and a different new password', async () => {
    expect((await changePassword(flagged.token, 'wrong-temporary', 'my own new passphrase')).status).toBe(403);
    const same = await changePassword(flagged.token, TEMP, TEMP);
    expect(same.status).toBe(400);
    expect(same.body.error.issues).toEqual([{ path: 'newPassword', message: 'Choose a password different from the current one' }]);
    expect((await changePassword(flagged.token, TEMP, 'short')).status).toBe(400);
    // Still flagged after failed attempts.
    expect((await h.call('GET', '/api/profiles', { token: flagged.token })).status).toBe(403);
  });

  it('clears the flag only after a successful change, keeps this session and revokes the others', async () => {
    const other = (await h.call<AuthResponse>('POST', '/api/auth/login', { body: { username: 'owner', password: TEMP } })).body;
    expect((await changePassword(flagged.token, TEMP, 'my own new passphrase')).status).toBe(204);

    const session = await h.call<CurrentSessionResponse>('GET', '/api/auth/session', { token: flagged.token });
    expect(session.body.user.mustChangePassword).toBe(false);
    expect((await h.call('GET', '/api/profiles', { token: flagged.token })).status).toBe(200);
    expect((await h.call('GET', '/api/auth/session', { token: other.token })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { username: 'owner', password: TEMP } })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { username: 'owner', password: 'my own new passphrase' } })).status).toBe(200);
    expect(h.db.prepare("SELECT must_change_password AS f FROM users WHERE username = 'owner'").get()).toEqual({ f: 0 });

    const audit = auditActions(h).filter((a) => a.action === 'password.changed' && a.outcome === 'success').at(-1)!;
    expect(JSON.parse(audit.metadata)).toEqual({ otherSessionsRevoked: 1, forced: true });
  });

  it('signing out works while flagged, and the flag persists to the next login', async () => {
    expect((await h.call('POST', '/api/auth/logout', { token: flagged.token })).status).toBe(204);
    const again = await h.call<AuthResponse>('POST', '/api/auth/login', { body: { username: 'owner', password: TEMP } });
    expect(again.body.user.mustChangePassword).toBe(true);
  });

  it('a transparent rehash at login does not clear the flag', async () => {
    // Login already ran with the harness's (cheap) parameters; a second login must leave the flag set.
    await h.call('POST', '/api/auth/login', { body: { username: 'owner', password: TEMP } });
    expect(h.db.prepare("SELECT must_change_password AS f FROM users WHERE username = 'owner'").get()).toEqual({ f: 1 });
  });

  it('never stores or logs the temporary or new password', async () => {
    await changePassword(flagged.token, TEMP, 'my own new passphrase');
    const log = fs.readFileSync(h.logFile, 'utf8');
    const dump = JSON.stringify([h.db.prepare('SELECT * FROM users').all(), h.db.prepare('SELECT * FROM audit_logs').all()]);
    for (const secret of [TEMP, 'my own new passphrase']) {
      expect(log).not.toContain(secret);
      expect(dump).not.toContain(secret);
    }
  });
});
