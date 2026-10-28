import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse } from '@conduit/shared';
import { createHarness, createUser, OWNER, setupOwner, type Harness } from '../helpers/harness';

let h: Harness;
let owner: AuthResponse;
beforeEach(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
});
afterEach(async () => {
  await h.close();
});

const login = (username: string, password: string) => h.call('POST', '/api/auth/login', { body: { username, password } });

describe('failed-login limits survive a backend restart', () => {
  it('a locked username stays locked after restarting', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    for (let i = 0; i < 5; i++) expect((await login('alice', `wrong-${i}`)).status).toBe(401);
    expect((await login('alice', alice.password)).status).toBe(429);

    await h.restart();
    expect((await login('alice', alice.password)).status).toBe(429);

    h.clock.advance(15 * 60_000 + 1);
    expect((await login('alice', alice.password)).status).toBe(200);
  });

  it('failures before a successful login are not counted after a restart', async () => {
    for (let i = 0; i < 4; i++) await login('owner', `wrong-${i}`);
    expect((await login('owner', OWNER.password)).status).toBe(200);
    await login('owner', 'wrong-again');
    await h.restart();
    // Only one failure since the last success: still allowed.
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });

  it('an administrator password reset clears the lockout, now and after a restart', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    for (let i = 0; i < 5; i++) await login('alice', `wrong-${i}`);
    expect((await login('alice', alice.password)).status).toBe(429);

    expect((await h.call('POST', `/api/admin/users/${alice.user.id}/password`, { token: owner.token, body: { password: 'fresh passphrase 1' } })).status).toBe(204);
    expect((await login('alice', 'fresh passphrase 1')).status).toBe(200);

    for (let i = 0; i < 5; i++) await login('alice', `wrong-again-${i}`);
    expect((await h.call('POST', `/api/admin/users/${alice.user.id}/password`, { token: owner.token, body: { password: 'fresh passphrase 2' } })).status).toBe(204);
    await h.restart();
    expect((await login('alice', 'fresh passphrase 2')).status).toBe(200);
  });

  it('the global window is restored too (unknown usernames count toward it)', async () => {
    for (let i = 0; i < 20; i++) await login(`ghost${i}`, 'wrong');
    await h.restart();
    expect((await login('owner', OWNER.password)).status).toBe(429);
    h.clock.advance(60_001);
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });

  it('old failures outside the window are ignored after a restart', async () => {
    for (let i = 0; i < 5; i++) await login('owner', `wrong-${i}`);
    h.clock.advance(15 * 60_000 + 1);
    await h.restart();
    expect((await login('owner', OWNER.password)).status).toBe(200);
  });
});
