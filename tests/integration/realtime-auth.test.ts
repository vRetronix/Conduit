import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WS_CLOSE, type AuthResponse, type Profile } from '@conduit/shared';
import { createHarness, createUser, openSocket, setupOwner, upgradeStatus, type Harness } from '../helpers/harness';

let h: Harness;
let owner: AuthResponse;
let bob: AuthResponse;
let carol: AuthResponse;
let A: Profile; // owner's profile; bob is a member
let B: Profile; // carol's profile

beforeEach(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
  bob = await createUser(h, owner.token, 'bob');
  carol = await createUser(h, owner.token, 'carol');
  A = (await h.call<Profile[]>('GET', '/api/profiles', { token: owner.token })).body[0]!;
  await h.call('POST', `/api/profiles/${A.id}/members`, { token: owner.token, body: { username: 'bob', role: 'member' } });
  B = (await h.call<Profile>('POST', '/api/profiles', { token: carol.token, body: { displayName: 'Carol Stream' } })).body;
});
afterEach(async () => {
  await h.close();
});

describe('realtime authentication', () => {
  it('requires a valid, current session to connect', async () => {
    expect(await upgradeStatus(h, { headers: { Authorization: 'Bearer not-a-token' } })).toBe(401);
    await h.call('POST', '/api/auth/logout', { token: bob.token });
    expect(await upgradeStatus(h, { headers: { Authorization: `Bearer ${bob.token}` } })).toBe(401);
  });

  it('does not accept the token in the URL', async () => {
    expect(await upgradeStatus(h, {}, `/ws?token=${owner.token}`)).toBe(401);
  });
});

describe('realtime authorization', () => {
  it('allows subscribing to a profile the user belongs to', async () => {
    const s = await openSocket(h, bob.token);
    s.send({ type: 'subscribe', profileId: A.id });
    expect(await s.next()).toEqual({ type: 'subscribed', profileId: A.id });
    s.ws.close();
  });

  it('refuses subscriptions to other profiles, indistinguishably from missing ones', async () => {
    const s = await openSocket(h, bob.token);
    s.send({ type: 'subscribe', profileId: B.id });
    const denied = await s.next();
    s.send({ type: 'subscribe', profileId: '00000000-0000-4000-8000-000000000000' });
    const missing = await s.next();
    expect(denied).toEqual({ type: 'error', code: 'not_found', message: 'Profile not found' });
    expect(missing).toEqual(denied);
    s.ws.close();
  });

  it('rejects spoofed identity fields instead of trusting them', async () => {
    const s = await openSocket(h, bob.token);
    // Bob claims to be Carol (B's owner) to subscribe to B.
    s.send({ type: 'subscribe', profileId: B.id, userId: carol.user.id, role: 'owner' });
    expect(await s.next()).toMatchObject({ type: 'error', code: 'bad_request' });
    s.ws.close();
  });

  it('rejects malformed messages and disconnects persistent offenders', async () => {
    const s = await openSocket(h, bob.token);
    for (const bad of ['not json', '{"type":"subscribe"}', '{"type":"subscribe","profileId":"x"}', '{"type":"admin"}', '[]']) {
      s.send(bad);
      expect(await s.next()).toMatchObject({ type: 'error', code: 'bad_request' });
    }
    expect((await s.closed).code).toBe(WS_CLOSE.policyViolation);
  });

  it('delivers profile events only to authorized subscribers', async () => {
    const bobSocket = await openSocket(h, bob.token);
    const carolSocket = await openSocket(h, carol.token);
    bobSocket.send({ type: 'subscribe', profileId: A.id });
    carolSocket.send({ type: 'subscribe', profileId: B.id });
    await bobSocket.next((m) => m.type === 'subscribed');
    await carolSocket.next((m) => m.type === 'subscribed');

    await h.call('PATCH', `/api/profiles/${A.id}`, { token: owner.token, body: { displayName: 'Renamed' } });
    expect(await bobSocket.next()).toEqual({ type: 'profile.updated', profileId: A.id });
    await expect(carolSocket.next(() => true, 300)).rejects.toThrow(/timed out/);
    bobSocket.ws.close();
    carolSocket.ws.close();
  });
});

describe('realtime revocation', () => {
  it('closes the socket when its session is revoked', async () => {
    const s = await openSocket(h, owner.token);
    const second = (await h.call<AuthResponse>('POST', '/api/auth/login', { body: { username: 'owner', password: 'correct horse battery' } })).body;
    await h.call('DELETE', `/api/auth/sessions/${owner.session.id}`, { token: second.token });
    expect((await s.closed).code).toBe(WS_CLOSE.sessionInvalid);
  });

  it('closes the socket on logout', async () => {
    const s = await openSocket(h, bob.token);
    await h.call('POST', '/api/auth/logout', { token: bob.token });
    expect((await s.closed).code).toBe(WS_CLOSE.sessionInvalid);
  });

  it('closes sockets of a disabled account', async () => {
    const s = await openSocket(h, bob.token);
    await h.call('PATCH', `/api/admin/users/${bob.user.id}`, { token: owner.token, body: { status: 'disabled' } });
    expect((await s.closed).code).toBe(WS_CLOSE.sessionInvalid);
  });

  it('drops a subscription as soon as membership is removed', async () => {
    const s = await openSocket(h, bob.token);
    s.send({ type: 'subscribe', profileId: A.id });
    await s.next((m) => m.type === 'subscribed');
    await h.call('DELETE', `/api/profiles/${A.id}/members/${bob.user.id}`, { token: owner.token });
    expect(await s.next((m) => m.type === 'unsubscribed')).toEqual({ type: 'unsubscribed', profileId: A.id, reason: 'access_revoked' });
    // Later profile events are no longer delivered.
    await h.call('PATCH', `/api/profiles/${A.id}`, { token: owner.token, body: { displayName: 'After removal' } });
    await expect(s.next(() => true, 300)).rejects.toThrow(/timed out/);
    s.ws.close();
  });

  it('stops acting on messages once the session has expired', async () => {
    const s = await openSocket(h, bob.token);
    h.clock.advance(15 * 24 * 60 * 60_000);
    s.send({ type: 'subscribe', profileId: A.id });
    expect((await s.closed).code).toBe(WS_CLOSE.sessionInvalid);
  });
});
