/** Database records → API shapes. These are the only places records become responses, so secrets cannot leak. */
import type { MemberRecord, ProfileWithRole, SessionRecord, UserRecord } from '@conduit/database';
import type { AdminUser, CurrentUser, Profile, ProfileMember, SessionInfo } from '@conduit/shared';

export function toCurrentUser(u: UserRecord): CurrentUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    systemRole: u.systemRole,
    status: u.status,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    mustChangePassword: u.mustChangePassword,
  };
}

export const toAdminUser = (u: UserRecord): AdminUser => toCurrentUser(u);

export function toSessionInfo(s: SessionRecord, currentSessionId: string): SessionInfo {
  return {
    id: s.id,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastSeenAt: s.lastSeenAt,
    clientName: s.clientName,
    current: s.id === currentSessionId,
  };
}

export function toProfile(p: ProfileWithRole): Profile {
  return {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    botDisplayName: p.botDisplayName,
    commandPrefix: p.commandPrefix,
    accentColor: p.accentColor,
    role: p.role,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function toMember(m: MemberRecord): ProfileMember {
  return { userId: m.userId, username: m.username, displayName: m.displayName, status: m.status, role: m.role, since: m.since };
}
