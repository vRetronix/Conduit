import { describe, expect, it } from 'vitest';
import { canManageMember, hasProfilePermission, hasSystemPermission, type ProfileRole } from '@conduit/shared';

describe('profile permission matrix', () => {
  const cases: Array<[ProfileRole | null, Record<string, boolean>]> = [
    ['owner', { 'profile.read': true, 'profile.update': true, 'members.read': true, 'members.manage': true, 'profile.transferOwnership': true }],
    ['admin', { 'profile.read': true, 'profile.update': true, 'members.read': true, 'members.manage': true, 'profile.transferOwnership': false }],
    ['member', { 'profile.read': true, 'profile.update': false, 'members.read': true, 'members.manage': false, 'profile.transferOwnership': false }],
    [null, { 'profile.read': false, 'profile.update': false, 'members.read': false, 'members.manage': false, 'profile.transferOwnership': false }],
  ];
  it.each(cases)('%s', (role, expected) => {
    for (const [permission, allowed] of Object.entries(expected)) {
      expect(hasProfilePermission(role, permission as never), `${role} ${permission}`).toBe(allowed);
    }
  });

  it('rejects unknown roles', () => {
    expect(hasProfilePermission('superuser' as never, 'profile.read')).toBe(false);
  });
});

describe('canManageMember', () => {
  it('owners add admins and members; admins add members only; members add nobody', () => {
    expect(canManageMember('owner', { kind: 'add', newRole: 'admin' })).toBe(true);
    expect(canManageMember('owner', { kind: 'add', newRole: 'member' })).toBe(true);
    expect(canManageMember('admin', { kind: 'add', newRole: 'member' })).toBe(true);
    expect(canManageMember('admin', { kind: 'add', newRole: 'admin' })).toBe(false);
    expect(canManageMember('member', { kind: 'add', newRole: 'member' })).toBe(false);
  });

  it('nobody changes their own role, and the owner cannot be re-roled', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(canManageMember(role, { kind: 'changeRole', targetRole: role, newRole: 'admin', isSelf: true })).toBe(false);
    }
    expect(canManageMember('owner', { kind: 'changeRole', targetRole: 'owner', newRole: 'member', isSelf: false })).toBe(false);
  });

  it('only owners change roles', () => {
    expect(canManageMember('owner', { kind: 'changeRole', targetRole: 'member', newRole: 'admin', isSelf: false })).toBe(true);
    expect(canManageMember('owner', { kind: 'changeRole', targetRole: 'admin', newRole: 'member', isSelf: false })).toBe(true);
    expect(canManageMember('admin', { kind: 'changeRole', targetRole: 'member', newRole: 'admin', isSelf: false })).toBe(false);
    expect(canManageMember('member', { kind: 'changeRole', targetRole: 'member', newRole: 'admin', isSelf: false })).toBe(false);
  });

  it('removal rules protect the owner and admins', () => {
    expect(canManageMember('owner', { kind: 'remove', targetRole: 'admin', isSelf: false })).toBe(true);
    expect(canManageMember('admin', { kind: 'remove', targetRole: 'member', isSelf: false })).toBe(true);
    expect(canManageMember('admin', { kind: 'remove', targetRole: 'admin', isSelf: false })).toBe(false);
    expect(canManageMember('admin', { kind: 'remove', targetRole: 'owner', isSelf: false })).toBe(false);
    expect(canManageMember('member', { kind: 'remove', targetRole: 'member', isSelf: false })).toBe(false);
  });

  it('members and admins may leave; the owner may not', () => {
    expect(canManageMember('member', { kind: 'remove', targetRole: 'member', isSelf: true })).toBe(true);
    expect(canManageMember('admin', { kind: 'remove', targetRole: 'admin', isSelf: true })).toBe(true);
    expect(canManageMember('owner', { kind: 'remove', targetRole: 'owner', isSelf: true })).toBe(false);
  });

  it('only the owner transfers ownership, to someone else', () => {
    expect(canManageMember('owner', { kind: 'transferOwnership', targetRole: 'member', isSelf: false })).toBe(true);
    expect(canManageMember('owner', { kind: 'transferOwnership', targetRole: 'owner', isSelf: true })).toBe(false);
    expect(canManageMember('admin', { kind: 'transferOwnership', targetRole: 'member', isSelf: false })).toBe(false);
  });

  it('denies everything without a role', () => {
    expect(canManageMember(null, { kind: 'add', newRole: 'member' })).toBe(false);
    expect(canManageMember(undefined, { kind: 'remove', targetRole: 'member', isSelf: true })).toBe(false);
  });
});

describe('system permissions', () => {
  it('only system admins manage users', () => {
    expect(hasSystemPermission('admin', 'users.manage')).toBe(true);
    expect(hasSystemPermission('user', 'users.manage')).toBe(false);
    expect(hasSystemPermission(null, 'users.manage')).toBe(false);
  });
});
