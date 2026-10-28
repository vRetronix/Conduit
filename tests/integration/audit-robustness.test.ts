import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse, Profile } from '@conduit/shared';
import { auditActions, createHarness, createUser, setupOwner, type Harness } from '../helpers/harness';

let h: Harness;
let owner: AuthResponse;
let A: Profile;
beforeEach(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
  A = (await h.call<Profile[]>('GET', '/api/profiles', { token: owner.token })).body[0]!;
});
afterEach(async () => {
  await h.close();
});

const count = (table: string) => (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('audit trail', () => {
  it('records setup, profile, membership, ownership and account events with actors and targets', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    await h.call('PATCH', `/api/profiles/${A.id}`, { token: owner.token, body: { displayName: 'Renamed' } });
    await h.call('POST', `/api/profiles/${A.id}/members`, { token: owner.token, body: { username: 'alice', role: 'member' } });
    await h.call('PATCH', `/api/profiles/${A.id}/members/${alice.user.id}`, { token: owner.token, body: { role: 'admin' } });
    await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: owner.token, body: { userId: alice.user.id } });
    await h.call('DELETE', `/api/profiles/${A.id}/members/${owner.user.id}`, { token: alice.token });
    await h.call('PATCH', `/api/admin/users/${alice.user.id}`, { token: owner.token, body: { status: 'disabled' } });

    const log = auditActions(h);
    const find = (action: string) => log.find((e) => e.action === action);
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'setup.completed',
        'profile.created',
        'user.created',
        'profile.updated',
        'member.added',
        'member.role_changed',
        'profile.ownership_transferred',
        'member.removed',
        'user.status_changed',
      ]),
    );
    expect(find('member.role_changed')).toMatchObject({ actorUserId: owner.user.id, targetUserId: alice.user.id, profileId: A.id });
    expect(JSON.parse(find('member.role_changed')!.metadata)).toEqual({ from: 'member', to: 'admin' });
    expect(find('profile.ownership_transferred')).toMatchObject({ actorUserId: owner.user.id, targetUserId: alice.user.id });
    expect(JSON.parse(find('profile.updated')!.metadata)).toEqual({ fields: ['displayName'] });
    expect(JSON.parse(find('user.status_changed')!.metadata)).toMatchObject({ from: 'active', to: 'disabled' });
  });

  it('never stores secrets in audit metadata', async () => {
    await createUser(h, owner.token, 'alice', 'alice-secret-password');
    await h.call('POST', '/api/me/password', { token: owner.token, body: { currentPassword: 'correct horse battery', newPassword: 'brand-new-secret-pass' } });
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM audit_logs').all());
    for (const secret of ['alice-secret-password', 'brand-new-secret-pass', 'correct horse battery', owner.token]) expect(dump).not.toContain(secret);
  });
});

describe('transactional integrity', () => {
  it('a failure part-way through leaves no partial profile or membership', async () => {
    const before = { profiles: count('streamer_profiles'), audit: count('audit_logs') };
    // Make the audit write (the last step of profile creation) fail.
    h.db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'profile.created' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const res = await h.call('POST', '/api/profiles', { token: owner.token, body: { displayName: 'Doomed' } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(JSON.stringify(res.body)).not.toMatch(/injected|sqlite|\\|\//i);
    expect(count('streamer_profiles')).toBe(before.profiles);
    expect(count('audit_logs')).toBe(before.audit);
    h.db.exec('DROP TRIGGER temp.fail_audit');
  });

  it('a failed ownership transfer changes nothing', async () => {
    const alice = await createUser(h, owner.token, 'alice');
    await h.call('POST', `/api/profiles/${A.id}/members`, { token: owner.token, body: { username: 'alice', role: 'member' } });
    h.db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'profile.ownership_transferred' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    const res = await h.call('POST', `/api/profiles/${A.id}/transfer-ownership`, { token: owner.token, body: { userId: alice.user.id } });
    expect(res.status).toBe(500);
    h.db.exec('DROP TRIGGER temp.fail_audit');
    const members = (await h.call('GET', `/api/profiles/${A.id}/members`, { token: owner.token })).body as Array<{ username: string; role: string }>;
    expect(members.map((m) => [m.username, m.role])).toEqual([
      ['owner', 'owner'],
      ['alice', 'member'],
    ]);
  });

  it('a failed setup leaves the installation un-initialized', async () => {
    const fresh = await createHarness();
    try {
      fresh.db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'setup.completed' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
      await expect(setupOwner(fresh)).rejects.toThrow(/setup failed: 500/);
      for (const table of ['users', 'streamer_profiles', 'sessions', 'app_settings']) {
        expect((fresh.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
      fresh.db.exec('DROP TRIGGER temp.fail_audit');
      expect((await setupOwner(fresh)).user.username).toBe('owner');
    } finally {
      await fresh.close();
    }
  });
});
