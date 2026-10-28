/**
 * Central authorization. Route handlers never check roles themselves: services call these functions, which
 * apply the shared permission matrix (packages/shared/src/community/permissions.ts) to authoritative database state.
 */
import { profilesRepo, type Database, type ProfileWithRole, type SessionRecord, type UserRecord } from '@conduit/database';
import {
  canManageMember,
  hasProfilePermission,
  hasSystemPermission,
  type MemberAction,
  type ProfilePermission,
  type SystemPermission,
} from '@conduit/shared';
import { forbidden, notFound } from './errors';

/** The authenticated caller. Built only by AuthService.authenticate() from a valid session. */
export interface Principal {
  readonly user: UserRecord;
  readonly session: SessionRecord;
}

export function requireSystemPermission(principal: Principal, permission: SystemPermission): void {
  if (!hasSystemPermission(principal.user.systemRole, permission)) throw forbidden();
}

/**
 * Loads a profile through the caller's membership and checks `permission`.
 * - No membership (or no such profile): 404, so profile IDs cannot be probed.
 * - Membership without the permission: 403.
 */
export function requireProfileAccess(
  db: Database,
  principal: Principal,
  profileId: string,
  permission: ProfilePermission,
): ProfileWithRole {
  const profile = profilesRepo.findForUser(db, profileId, principal.user.id);
  if (!profile) throw notFound('Profile');
  if (!hasProfilePermission(profile.role, permission)) throw forbidden();
  return profile;
}

export function requireMemberAction(profile: ProfileWithRole, action: MemberAction): void {
  if (!canManageMember(profile.role, action)) throw forbidden();
}
