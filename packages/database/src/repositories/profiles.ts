import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type ProfileRole = 'owner' | 'admin' | 'member';
export type MembershipRole = 'admin' | 'member';

export interface ProfileRecord {
  id: string;
  slug: string;
  displayName: string;
  botDisplayName: string;
  commandPrefix: string;
  accentColor: string;
  ownerUserId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileWithRole extends ProfileRecord {
  role: ProfileRole;
}

export interface MemberRecord {
  userId: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled';
  role: ProfileRole;
  since: string;
}

const COLUMNS = `p.id, p.slug, p.display_name AS displayName, p.bot_display_name AS botDisplayName,
  p.command_prefix AS commandPrefix, p.accent_color AS accentColor, p.owner_user_id AS ownerUserId,
  p.created_by AS createdBy, p.created_at AS createdAt, p.updated_at AS updatedAt`;

/**
 * The caller's effective role: 'owner' via streamer_profiles.owner_user_id, otherwise the membership row.
 * Every profile-scoped read goes through a query of this shape, so a user only ever sees profiles they belong to.
 */
const WITH_ROLE = `SELECT ${COLUMNS},
    CASE WHEN p.owner_user_id = :userId THEN 'owner' ELSE m.role END AS role
  FROM streamer_profiles p
  LEFT JOIN profile_memberships m ON m.profile_id = p.id AND m.user_id = :userId
  WHERE (p.owner_user_id = :userId OR m.user_id IS NOT NULL)`;

export type ProfilePatch = Partial<Pick<ProfileRecord, 'displayName' | 'botDisplayName' | 'commandPrefix' | 'accentColor'>>;

const PATCH_COLUMNS: Record<keyof ProfilePatch, string> = {
  displayName: 'display_name',
  botDisplayName: 'bot_display_name',
  commandPrefix: 'command_prefix',
  accentColor: 'accent_color',
};

export const profilesRepo = {
  insert(db: Database, p: Omit<ProfileRecord, 'createdAt' | 'updatedAt'> & { now: string }): void {
    execute(
      db,
      `INSERT INTO streamer_profiles (id, slug, display_name, bot_display_name, command_prefix, accent_color,
         owner_user_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.slug,
      p.displayName,
      p.botDisplayName,
      p.commandPrefix,
      p.accentColor,
      p.ownerUserId,
      p.createdBy,
      p.now,
      p.now,
    );
  },

  slugExists(db: Database, slug: string): boolean {
    return queryOne(db, 'SELECT 1 AS x FROM streamer_profiles WHERE slug = ?', slug) !== undefined;
  },

  /** Profiles the user can access, with their role in each. */
  listForUser(db: Database, userId: string): ProfileWithRole[] {
    return queryAll<ProfileWithRole>(db, `${WITH_ROLE} ORDER BY p.display_name COLLATE NOCASE`, { userId });
  },

  /** The profile if the user can access it, else undefined (no distinction between "missing" and "not yours"). */
  findForUser(db: Database, profileId: string, userId: string): ProfileWithRole | undefined {
    return queryOne<ProfileWithRole>(db, `${WITH_ROLE} AND p.id = :profileId`, { userId, profileId });
  },

  /** Updates only the given fields of one profile. */
  update(db: Database, profileId: string, patch: ProfilePatch, now: string): number {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<[keyof ProfilePatch, string]>;
    if (entries.length === 0) return 0;
    const sets = entries.map(([k]) => `${PATCH_COLUMNS[k]} = ?`).join(', ');
    return execute(
      db,
      `UPDATE streamer_profiles SET ${sets}, updated_at = ? WHERE id = ?`,
      ...entries.map(([, v]) => v),
      now,
      profileId,
    );
  },

  setOwner(db: Database, profileId: string, ownerUserId: string, now: string): number {
    return execute(db, 'UPDATE streamer_profiles SET owner_user_id = ?, updated_at = ? WHERE id = ?', ownerUserId, now, profileId);
  },

  /** Owner first, then admins, then members. */
  listMembers(db: Database, profileId: string): MemberRecord[] {
    return queryAll<MemberRecord>(
      db,
      `SELECT * FROM (
         SELECT u.id AS userId, u.username, u.display_name AS displayName, u.status, 'owner' AS role, p.created_at AS since
           FROM streamer_profiles p JOIN users u ON u.id = p.owner_user_id
          WHERE p.id = :profileId
         UNION ALL
         SELECT u.id, u.username, u.display_name, u.status, m.role, m.created_at
           FROM profile_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.profile_id = :profileId
       )
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, username`,
      { profileId },
    );
  },

  /** Effective role of `userId` in `profileId`, or null when they have no access. */
  roleOf(db: Database, profileId: string, userId: string): ProfileRole | null {
    const row = queryOne<{ role: ProfileRole | null }>(
      db,
      `SELECT CASE WHEN p.owner_user_id = :userId THEN 'owner' ELSE m.role END AS role
         FROM streamer_profiles p
         LEFT JOIN profile_memberships m ON m.profile_id = p.id AND m.user_id = :userId
        WHERE p.id = :profileId`,
      { userId, profileId },
    );
    return row?.role ?? null;
  },

  addMembership(db: Database, m: { profileId: string; userId: string; role: MembershipRole; addedBy: string; now: string }): void {
    execute(
      db,
      `INSERT INTO profile_memberships (profile_id, user_id, role, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      m.profileId,
      m.userId,
      m.role,
      m.addedBy,
      m.now,
      m.now,
    );
  },

  setMembershipRole(db: Database, profileId: string, userId: string, role: MembershipRole, now: string): number {
    return execute(
      db,
      'UPDATE profile_memberships SET role = ?, updated_at = ? WHERE profile_id = ? AND user_id = ?',
      role,
      now,
      profileId,
      userId,
    );
  },

  removeMembership(db: Database, profileId: string, userId: string): number {
    return execute(db, 'DELETE FROM profile_memberships WHERE profile_id = ? AND user_id = ?', profileId, userId);
  },
};
