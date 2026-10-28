/**
 * The single source of truth for authorization rules. The server enforces these; the dashboard uses the
 * same functions only to decide which controls to show (hiding a control is never authorization).
 */
import type { AssignableRole, ProfileRole, SystemRole } from '../app/accounts';

export type ProfilePermission =
  | 'profile.read'
  | 'profile.update'
  | 'members.read'
  | 'members.manage'
  | 'profile.transferOwnership';

const PROFILE_MATRIX: Record<ProfilePermission, readonly ProfileRole[]> = {
  'profile.read': ['owner', 'admin', 'member'],
  'profile.update': ['owner', 'admin'],
  'members.read': ['owner', 'admin', 'member'],
  // Coarse gate for add/remove/role changes; canManageMember() applies the fine-grained rules.
  'members.manage': ['owner', 'admin'],
  'profile.transferOwnership': ['owner'],
};

export function hasProfilePermission(role: ProfileRole | null | undefined, permission: ProfilePermission): boolean {
  return role != null && PROFILE_MATRIX[permission].includes(role);
}

export type MemberAction =
  | { kind: 'add'; newRole: AssignableRole }
  | { kind: 'changeRole'; targetRole: ProfileRole; newRole: AssignableRole; isSelf: boolean }
  | { kind: 'remove'; targetRole: ProfileRole; isSelf: boolean }
  | { kind: 'transferOwnership'; targetRole: ProfileRole; isSelf: boolean };

/**
 * Fine-grained membership rules:
 * - Nobody changes their own role (owners hand over with an ownership transfer).
 * - The owner can never be removed or demoted, so a profile always has an owner.
 * - Owners add, remove and re-role admins and members.
 * - Admins add and remove members only.
 * - Admins and members may remove themselves (leave). The owner must transfer ownership first.
 * - Ownership moves only from the current owner to an existing admin or member.
 */
export function canManageMember(actorRole: ProfileRole | null | undefined, action: MemberAction): boolean {
  if (actorRole == null) return false;
  switch (action.kind) {
    case 'add':
      if (actorRole === 'owner') return true;
      return actorRole === 'admin' && action.newRole === 'member';
    case 'changeRole':
      if (action.isSelf || action.targetRole === 'owner') return false;
      return actorRole === 'owner';
    case 'remove':
      if (action.targetRole === 'owner') return false;
      if (action.isSelf) return true;
      if (actorRole === 'owner') return true;
      return actorRole === 'admin' && action.targetRole === 'member';
    case 'transferOwnership':
      return actorRole === 'owner' && !action.isSelf && action.targetRole !== 'owner';
  }
}

export type SystemPermission = 'users.manage';

const SYSTEM_MATRIX: Record<SystemPermission, readonly SystemRole[]> = {
  // Create local accounts, enable/disable accounts, revoke a user's sessions. Grants no access to any
  // streamer profile: profile data is visible only through membership.
  'users.manage': ['admin'],
};

export function hasSystemPermission(role: SystemRole | null | undefined, permission: SystemPermission): boolean {
  return role != null && SYSTEM_MATRIX[permission].includes(role);
}
