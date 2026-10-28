import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse } from '@conduit/shared';
import { auditActions, createHarness, createUser, OWNER, SETUP_TOKEN, setupOwner, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

/** `token: null` sends no setup-token header. */
const setup = (body: unknown = OWNER, token: string | null = SETUP_TOKEN) =>
  h.call<AuthResponse>('POST', '/api/setup', { body, headers: token !== null ? { 'X-Setup-Token': token } : {} });

describe('first-run setup', () => {
  it('reports setup as required on an empty database', async () => {
    expect((await h.call('GET', '/api/setup/status')).body).toEqual({ setupRequired: true });
  });

  it('creates the owner, their first profile and a session, exactly once', async () => {
    const res = await setup();
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.user).toMatchObject({ username: 'owner', displayName: 'Owner', systemRole: 'admin', status: 'active' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.session.current).toBe(true);

    const profiles = await h.call('GET', '/api/profiles', { token: res.body.token });
    expect(profiles.body).toHaveLength(1);
    expect(profiles.body[0]).toMatchObject({ displayName: 'Owner Stream', slug: 'owner-stream', role: 'owner' });

    expect((await h.call('GET', '/api/setup/status')).body).toEqual({ setupRequired: false });
    const again = await setup({ ...OWNER, username: 'second' });
    expect(again.status).toBe(409);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  it('allows only one owner when setup requests race', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => setup({ ...OWNER, username: `racer${i}`, profileDisplayName: `Stream ${i}` })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM streamer_profiles').get()).toEqual({ n: 1 });
  });

  it('requires the setup token', async () => {
    expect((await setup(OWNER, null)).status).toBe(403);
    expect((await setup(OWNER, '')).status).toBe(403);
    expect((await setup(OWNER, 'wrong-token-wrong-token-wrong-token-wrong')).status).toBe(403);
    expect((await h.call('GET', '/api/setup/status')).body).toEqual({ setupRequired: true });
  });

  it('validates every field server-side without echoing values', async () => {
    const res = await h.call('POST', '/api/setup', {
      body: { username: 'x', displayName: '', password: 'short', profileDisplayName: 'ok' },
      headers: { 'X-Setup-Token': SETUP_TOKEN },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const paths = res.body.error.issues.map((i: { path: string }) => i.path).sort();
    expect(paths).toEqual(['displayName', 'password', 'username']);
    expect(JSON.stringify(res.body)).not.toContain('short');
  });

  it('rejects unknown fields such as a smuggled role', async () => {
    expect((await setup({ ...OWNER, systemRole: 'admin' })).status).toBe(400);
  });

  it('stores an Argon2id hash, never the password', async () => {
    await setup();
    const row = h.db.prepare('SELECT password_hash AS hash FROM users').get() as { hash: string };
    expect(row.hash.startsWith('$argon2id$')).toBe(true);
    expect(row.hash).not.toContain(OWNER.password);
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM users').all());
    expect(dump).not.toContain(OWNER.password);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await setupOwner(h);
  });

  const login = (username: string, password: string) => h.call<AuthResponse>('POST', '/api/auth/login', { body: { username, password } });

  it('succeeds with valid credentials (username is case-insensitive)', async () => {
    const res = await login('OWNER', OWNER.password);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('owner');
    expect((await h.call('GET', '/api/auth/session', { token: res.body.token })).status).toBe(200);
  });

  it('fails identically for a wrong password and an unknown user', async () => {
    const wrong = await login('owner', 'not the password');
    const unknown = await login('nobody', 'not the password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid username or password' } });
  });

  it('rejects malformed input without crashing', async () => {
    for (const body of [{}, { username: 'owner' }, { username: 1, password: 2 }, { username: 'owner', password: 'x'.repeat(300) }, []]) {
      expect((await h.call('POST', '/api/auth/login', { body })).status).toBe(400);
    }
    expect((await h.call('POST', '/api/auth/login', { rawBody: '{"username": "owner",' })).status).toBe(400);
    expect((await h.call('POST', '/api/auth/login', { rawBody: 'x'.repeat(200 * 1024) })).status).toBe(413);
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });

  it('locks a username after repeated failures, without revealing whether it exists', async () => {
    for (let i = 0; i < 5; i++) expect((await login('owner', `wrong-${i}`)).status).toBe(401);
    const locked = await login('owner', OWNER.password);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) await login('ghost', `wrong-${i}`);
    expect((await login('ghost', 'whatever')).status).toBe(429);

    h.clock.advance(15 * 60_000 + 1);
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });

  it('throttles failures across all usernames', async () => {
    for (let i = 0; i < 20; i++) await login(`user${i}`, 'wrong-password');
    expect((await login('owner', OWNER.password)).status).toBe(429);
    h.clock.advance(60_001);
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });

  it('rejects disabled accounts even with the right password', async () => {
    const admin = (await login('owner', OWNER.password)).body.token;
    const alice = await createUser(h, admin, 'alice');
    await h.call('PATCH', `/api/admin/users/${alice.user.id}`, { token: admin, body: { status: 'disabled' } });
    const res = await h.call('POST', '/api/auth/login', { body: { username: 'alice', password: alice.password } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This account is disabled.');
    expect((await login('alice', 'wrong password!!')).status).toBe(401);
  });

  it('never writes passwords or session tokens to the log', async () => {
    const res = await login('owner', OWNER.password);
    await h.call('GET', '/api/auth/session', { token: res.body.token });
    await login('owner', 'a-wrong-password');
    h.logger.error('probe', { authorization: `Bearer ${res.body.token}`, password: OWNER.password });
    const log = fs.readFileSync(h.logFile, 'utf8');
    expect(log).toContain('probe');
    expect(log).not.toContain(res.body.token);
    expect(log).not.toContain(OWNER.password);
    expect(log).not.toContain('a-wrong-password');
  });

  it('audits successful and failed logins without recording unknown usernames', async () => {
    await login('owner', OWNER.password);
    await login('owner', 'bad password');
    await login('typed-my-password-here', 'bad password');
    const logins = auditActions(h).filter((a) => a.action === 'auth.login');
    expect(logins.map((a) => [a.outcome, JSON.parse(a.metadata).reason ?? null])).toEqual([
      ['success', null], // setup sign-in
      ['success', null],
      ['failure', 'invalid_password'],
      ['failure', 'unknown_user'],
    ]);
    expect(JSON.stringify(auditActions(h))).not.toContain('typed-my-password-here');
  });
});
