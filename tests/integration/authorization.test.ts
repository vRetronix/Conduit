import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse, Profile, ProfileMember } from '@conduit/shared';
import { createHarness, createUser, setupOwner, type Harness } from '../helpers/harness';

/**
 * Fixture (rebuilt per test):
 *   Profile A "Owner Stream": owner (owner), alice (admin), bob (member)
 *   Profile B "Carol Stream": carol (owner), dave (member)
 * The instance admin is "owner", who is NOT a member of B.
 */
let h: Harness;
let owner: AuthResponse;
let alice: AuthResponse;
let bob: AuthResponse;
let carol: AuthResponse;
let dave: AuthResponse;
let A: Profile;
let B: Profile;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  h.db.exec(`
    DROP TRIGGER IF EXISTS audit_logs_no_delete;
    DELETE FROM audit_logs; DELETE FROM sessions; DELETE FROM profile_memberships;
    DELETE FROM streamer_profiles; DELETE FROM users; DELETE FROM app_settings;
    CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
  `);
  owner = await setupOwner(h);
  alice = await createUser(h, owner.token, 'alice');
  bob = await createUser(h, owner.token, 'bob');
  carol = await createUser(h, owner.token, 'carol');
  dave = await createUser(h, owner.token, 'dave');
  A = (await h.call<Profile[]>('GET', '/api/profiles', { token: owner.token })).body[0]!;
  expect((await addMember(owner.token, A.id, 'alice', 'admin')).status).toBe(201);
  expect((await addMember(owner.token, A.id, 'bob', 'member')).status).toBe(201);
  B = (await h.call<Profile>('POST', '/api/profiles', { token: carol.token, body: { displayName: 'Carol Stream' } })).body;
  expect((await addMember(carol.token, B.id, 'dave', 'member')).status).toBe(201);
});

function addMember(token: string, profileId: string, username: string, role: string) {
  return h.call('POST', `/api/profiles/${profileId}/members`, { token, body: { username, role } });
}
const getProfile = (token: string, id: string) => h.call<Profile>('GET', `/api/profiles/${id}`, { token });
const members = (token: string, id: string) => h.call<ProfileMember[]>('GET', `/api/profiles/${id}/members`, { token });
const setRole = (token: string, profileId: string, userId: string, role: unknown) =>
  h.call('PATCH', `/api/profiles/${profileId}/members/${userId}`, { token, body: { role } });
const remove = (token: string, profileId: string, userId: string) => h.call('DELETE', `/api/profiles/${profileId}/members/${userId}`, { token });

describe('authentication is required', () => {
  const ID = '00000000-0000-4000-8000-000000000000';
  it.each([
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/auth/sessions'],
    ['DELETE', `/api/auth/sessions/${ID}`],
    ['POST', '/api/me/password'],
    ['GET', '/api/profiles'],
    ['POST', '/api/profiles'],
    ['GET', `/api/profiles/${ID}`],
    ['PATCH', `/api/profiles/${ID}`],
    ['GET', `/api/profiles/${ID}/members`],
    ['POST', `/api/profiles/${ID}/members`],
    ['PATCH', `/api/profiles/${ID}/members/${ID}`],
    ['DELETE', `/api/profiles/${ID}/members/${ID}`],
    ['POST', `/api/profiles/${ID}/transfer-ownership`],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users'],
    ['PATCH', `/api/admin/users/${ID}`],
    ['POST', `/api/admin/users/${ID}/password`],
    ['POST', `/api/admin/users/${ID}/revoke-sessions`],
  ])('%s %s → 401', async (method, path) => {
    const res = await h.call(method, path, method === 'GET' || method === 'DELETE' ? {} : { body: {} });
    expect(res.status).toBe(401);
  });
});

describe('cross-profile isolation', () => {
  it('list endpoints return only profiles the caller belongs to', async () => {
    const names = async (token: string) => (await h.call<Profile[]>('GET', '/api/profiles', { token })).body.map((p) => p.displayName).sort();
    expect(await names(owner.token)).toEqual(['Owner Stream']);
    expect(await names(alice.token)).toEqual(['Owner Stream']);
    expect(await names(carol.token)).toEqual(['Carol Stream']);
    expect(await names(dave.token)).toEqual(['Carol Stream']);
  });

  it('detail and member reads of another profile look like it does not exist', async () => {
    for (const token of [carol.token, dave.token]) {
      expect((await getProfile(token, A.id)).status).toBe(404);
      expect((await members(token, A.id)).status).toBe(404);
    }
    // Being the instance administrator grants no access to other people's profiles.
    expect((await getProfile(owner.token, B.id)).status).toBe(404);
    expect((await members(owner.token, B.id)).status).toBe(404);
    // ...and a non-existent profile gives the same answer.
    expect((await getProfile(carol.token, '00000000-0000-4000-8000-000000000000')).body).toEqual((await getProfile(carol.token, A.id)).body);
  });

  it('updates and membership changes cannot reach another profile', async () => {
    expect((await h.call('PATCH', `/api/profiles/${A.id}`, { token: carol.token, body: { displayName: 'Hijacked' } })).status).toBe(404);
    expect((await addMember(carol.token, A.id, 'dave', 'admin')).status).toBe(404);
    expect((await setRole(carol.token, A.id, bob.user.id, 'admin')).status).toBe(404);
    expect((await remove(carol.token, A.id, bob.user.id)).status).toBe(404);
    expect((await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: carol.token, body: { userId: carol.user.id } })).status).toBe(404);
    expect((await getProfile(owner.token, A.id)).body.displayName).toBe('Owner Stream');
    expect((await members(owner.token, A.id)).body.map((m) => [m.username, m.role])).toEqual([
      ['owner', 'owner'],
      ['alice', 'admin'],
      ['bob', 'member'],
    ]);
  });

  it('mixing IDs across profiles does not touch the other profile', async () => {
    // Carol owns B; alice belongs to A only. Targeting alice through B must not affect A.
    expect((await setRole(carol.token, B.id, alice.user.id, 'admin')).status).toBe(404);
    expect((await remove(carol.token, B.id, alice.user.id)).status).toBe(404);
    expect((await h.call('POST', `/api/profiles/${B.id}/transfer-ownership`, { token: carol.token, body: { userId: alice.user.id } })).status).toBe(404);
    expect((await members(alice.token, A.id)).body.find((m) => m.userId === alice.user.id)?.role).toBe('admin');
  });

  it('updating one profile leaves the other unchanged', async () => {
    const res = await h.call<Profile>('PATCH', `/api/profiles/${B.id}`, { token: carol.token, body: { displayName: 'Carol Live', accentColor: '#FF0000' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Carol Live', accentColor: '#ff0000' });
    expect((await getProfile(owner.token, A.id)).body).toMatchObject({ displayName: 'Owner Stream', accentColor: '#7c5cff' });
  });
});

describe('role permissions within a profile', () => {
  it('members can read but not change settings or membership', async () => {
    expect((await getProfile(bob.token, A.id)).body.role).toBe('member');
    expect((await members(bob.token, A.id)).status).toBe(200);
    expect((await h.call('PATCH', `/api/profiles/${A.id}`, { token: bob.token, body: { displayName: 'x' } })).status).toBe(403);
    expect((await addMember(bob.token, A.id, 'dave', 'member')).status).toBe(403);
    expect((await remove(bob.token, A.id, alice.user.id)).status).toBe(403);
  });

  it('admins edit settings and manage members, but nothing owner-only', async () => {
    expect((await h.call('PATCH', `/api/profiles/${A.id}`, { token: alice.token, body: { commandPrefix: '?' } })).status).toBe(200);
    expect((await addMember(alice.token, A.id, 'dave', 'admin')).status).toBe(403);
    expect((await addMember(alice.token, A.id, 'dave', 'member')).status).toBe(201);
    expect((await setRole(alice.token, A.id, bob.user.id, 'admin')).status).toBe(403);
    expect((await remove(alice.token, A.id, owner.user.id)).status).toBe(403);
    expect((await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: alice.token, body: { userId: bob.user.id } })).status).toBe(403);
    expect((await remove(alice.token, A.id, bob.user.id)).status).toBe(204);
  });

  it('nobody can elevate their own role', async () => {
    expect((await setRole(bob.token, A.id, bob.user.id, 'admin')).status).toBe(403);
    expect((await setRole(alice.token, A.id, alice.user.id, 'admin')).status).toBe(403);
    expect((await setRole(owner.token, A.id, owner.user.id, 'member')).status).toBe(403);
    expect((await addMember(bob.token, A.id, 'bob', 'admin')).status).toBe(403);
  });

  it('ownership cannot be granted through role changes or member creation', async () => {
    expect((await setRole(owner.token, A.id, alice.user.id, 'owner')).status).toBe(400);
    expect((await addMember(owner.token, A.id, 'dave', 'owner')).status).toBe(400);
  });

  it('owners change roles of others', async () => {
    expect((await setRole(owner.token, A.id, bob.user.id, 'admin')).status).toBe(200);
    expect((await getProfile(bob.token, A.id)).body.role).toBe('admin');
  });

  it('the owner can neither be removed nor leave', async () => {
    expect((await remove(owner.token, A.id, owner.user.id)).status).toBe(403);
    expect((await remove(alice.token, A.id, owner.user.id)).status).toBe(403);
  });

  it('a removed member loses access immediately', async () => {
    expect((await remove(owner.token, A.id, bob.user.id)).status).toBe(204);
    expect((await getProfile(bob.token, A.id)).status).toBe(404);
    expect((await members(bob.token, A.id)).status).toBe(404);
    expect((await h.call<Profile[]>('GET', '/api/profiles', { token: bob.token })).body).toEqual([]);
  });

  it('members can leave', async () => {
    expect((await remove(bob.token, A.id, bob.user.id)).status).toBe(204);
    expect((await getProfile(bob.token, A.id)).status).toBe(404);
  });

  it('rejects disabled users, duplicates and unknown users when adding members', async () => {
    expect((await addMember(owner.token, A.id, 'bob', 'member')).status).toBe(409);
    expect((await addMember(owner.token, A.id, 'nobody-here', 'member')).status).toBe(404);
    await h.call('PATCH', `/api/admin/users/${dave.user.id}`, { token: owner.token, body: { status: 'disabled' } });
    expect((await addMember(owner.token, A.id, 'dave', 'member')).status).toBe(409);
  });

  it('transfers ownership explicitly, keeping exactly one owner', async () => {
    const res = await h.call<Profile>('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: owner.token, body: { userId: alice.user.id } });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    const list = (await members(alice.token, A.id)).body;
    expect(list.filter((m) => m.role === 'owner').map((m) => m.username)).toEqual(['alice']);
    expect(list.find((m) => m.username === 'owner')?.role).toBe('admin');
    // The previous owner lost owner-only powers.
    expect((await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: owner.token, body: { userId: bob.user.id } })).status).toBe(403);
    // Transfer to a non-member or to oneself fails.
    expect((await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: alice.token, body: { userId: carol.user.id } })).status).toBe(404);
    expect((await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: alice.token, body: { userId: alice.user.id } })).status).toBe(403);
  });
});

describe('input validation on protected routes', () => {
  it('rejects malformed identifiers and invalid role names', async () => {
    expect((await getProfile(owner.token, 'not-a-uuid')).status).toBe(400);
    expect((await getProfile(owner.token, "1' OR '1'='1")).status).toBe(400);
    expect((await setRole(owner.token, A.id, 'bob', 'admin')).status).toBe(400);
    expect((await setRole(owner.token, A.id, bob.user.id, 'superadmin')).status).toBe(400);
    expect((await setRole(owner.token, A.id, bob.user.id, ['admin'])).status).toBe(400);
  });

  it('rejects unknown and immutable fields in profile updates', async () => {
    for (const body of [{}, { slug: 'new-slug' }, { ownerUserId: carol.user.id }, { role: 'owner' }, { accentColor: 'red' }, { commandPrefix: 'a b' }]) {
      expect((await h.call('PATCH', `/api/profiles/${A.id}`, { token: owner.token, body })).status).toBe(400);
    }
  });

  it('rejects a duplicate slug on creation', async () => {
    const res = await h.call('POST', '/api/profiles', { token: dave.token, body: { displayName: 'Dupe', slug: A.slug } });
    expect(res.status).toBe(409);
  });
});

describe('instance administration', () => {
  it('is limited to system administrators', async () => {
    for (const token of [alice.token, carol.token]) {
      expect((await h.call('GET', '/api/admin/users', { token })).status).toBe(403);
      expect((await h.call('POST', '/api/admin/users', { token, body: { username: 'eve', displayName: 'Eve', password: 'eve-password-123' } })).status).toBe(403);
      expect((await h.call('PATCH', `/api/admin/users/${bob.user.id}`, { token, body: { status: 'disabled' } })).status).toBe(403);
    }
  });

  it('never exposes password or session hashes', async () => {
    const res = await h.call('GET', '/api/admin/users', { token: owner.token });
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('argon2');
    expect(json).not.toMatch(/passwordHash|password_hash|token/i);
  });

  it('cannot disable its own account', async () => {
    expect((await h.call('PATCH', `/api/admin/users/${owner.user.id}`, { token: owner.token, body: { status: 'disabled' } })).status).toBe(403);
  });

  it('rejects duplicate usernames', async () => {
    expect((await h.call('POST', '/api/admin/users', { token: owner.token, body: { username: 'ALICE', displayName: 'A2', password: 'another-password' } })).status).toBe(409);
  });
});
