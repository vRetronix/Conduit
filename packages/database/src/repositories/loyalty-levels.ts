import { execute, queryAll, queryOne, type Database } from '../sqlite';

// Discord XP and levels for Loyalty & Rewards (migration 20). Separate from spendable points (repositories/loyalty.ts).

export interface LoyaltyLevelRecord {
  guildId: string;
  userId: string;
  displayName: string | null;
  xp: number;
  level: number;
  announcedLevel: number;
  lastXpAt: string | null;
  lastContentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyXpEventRecord {
  id: string;
  guildId: string;
  userId: string;
  amount: number;
  xpAfter: number;
  levelAfter: number;
  kind: 'message' | 'adjustment';
  reason: string | null;
  createdAt: string;
}

export interface LoyaltyRoleRewardRecord {
  id: string;
  guildId: string;
  level: number;
  roleId: string;
  createdAt: string;
}

export interface LoyaltyRoleGrantRecord {
  guildId: string;
  userId: string;
  roleId: string;
  level: number;
  status: 'granted' | 'failed';
  detail: string | null;
  attempts: number;
  updatedAt: string;
}

/** A leaderboard row: XP in one server, with the member's (Discord-wide) points balance. */
export interface LoyaltyMemberRow {
  guildId: string;
  userId: string;
  displayName: string | null;
  xp: number;
  level: number;
  points: number;
}

const LEVEL = `guild_id AS guildId, user_id AS userId, display_name AS displayName, xp, level, announced_level AS announcedLevel,
  last_xp_at AS lastXpAt, last_content_hash AS lastContentHash, created_at AS createdAt, updated_at AS updatedAt`;
const XP_EVENT = `id, guild_id AS guildId, user_id AS userId, amount, xp_after AS xpAfter, level_after AS levelAfter, kind, reason, created_at AS createdAt`;
const ROLE_REWARD = 'id, guild_id AS guildId, level, role_id AS roleId, created_at AS createdAt';
const GRANT = 'guild_id AS guildId, user_id AS userId, role_id AS roleId, level, status, detail, attempts, updated_at AS updatedAt';

/** LIKE pattern for a plain-text search (%, _ and \ are matched literally). */
const likeText = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * XP and levels. As with points, the service runs related statements inside one withTransaction, and always computes
 * the level from the XP and stores both together.
 */
export const loyaltyLevelsRepo = {
  get(db: Database, guildId: string, userId: string): LoyaltyLevelRecord | undefined {
    return queryOne<LoyaltyLevelRecord>(db, `SELECT ${LEVEL} FROM loyalty_levels WHERE guild_id = ? AND user_id = ?`, guildId, userId);
  },

  /** Creates the member's row (0 XP) if it doesn't exist; refreshes the display name when one is given. */
  ensure(db: Database, guildId: string, userId: string, displayName: string | null, at: string): LoyaltyLevelRecord {
    execute(
      db,
      `INSERT INTO loyalty_levels (guild_id, user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name)`,
      guildId,
      userId,
      displayName?.slice(0, 100) ?? null,
      at,
      at,
    );
    return loyaltyLevelsRepo.get(db, guildId, userId)!;
  },

  /**
   * Applies one XP change and its history entry; call inside a transaction, with the level for the new XP.
   * 'duplicate': this event key was already applied; 'below_zero': the XP would go below 0. Nothing changes then.
   */
  applyXp(
    db: Database,
    c: {
      id: string;
      guildId: string;
      userId: string;
      amount: number;
      /** The level for the XP after this change. */
      levelFor: (xp: number) => number;
      kind: 'message' | 'adjustment';
      reason: string | null;
      eventKey: string | null;
      contentHash: string | null;
      at: string;
    },
  ): { outcome: 'ok' | 'duplicate' | 'below_zero'; xp: number; level: number } {
    const member = loyaltyLevelsRepo.get(db, c.guildId, c.userId);
    if (!member) throw new Error('loyalty level row missing');
    if (c.eventKey && queryOne(db, 'SELECT 1 AS x FROM loyalty_xp_events WHERE event_key = ?', c.eventKey)) return { outcome: 'duplicate', xp: member.xp, level: member.level };
    const xp = member.xp + c.amount;
    if (xp < 0) return { outcome: 'below_zero', xp: member.xp, level: member.level };
    const level = c.levelFor(xp);
    execute(
      db,
      'INSERT INTO loyalty_xp_events (id, guild_id, user_id, amount, xp_after, level_after, kind, reason, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id,
      c.guildId,
      c.userId,
      c.amount,
      xp,
      level,
      c.kind,
      c.reason?.slice(0, 200) ?? null,
      c.eventKey?.slice(0, 200) ?? null,
      c.at,
    );
    const fromMessage = c.kind === 'message' ? 1 : 0;
    execute(
      db,
      `UPDATE loyalty_levels SET xp = ?, level = ?,
         last_xp_at = CASE WHEN ? THEN ? ELSE last_xp_at END,
         last_content_hash = CASE WHEN ? THEN ? ELSE last_content_hash END,
         updated_at = ? WHERE guild_id = ? AND user_id = ?`,
      xp,
      level,
      fromMessage,
      c.at,
      fromMessage && c.contentHash ? 1 : 0,
      c.contentHash,
      c.at,
      c.guildId,
      c.userId,
    );
    return { outcome: 'ok', xp, level };
  },

  /** Whether an XP change with this event key exists (the message was already counted). */
  hasEvent(db: Database, eventKey: string): boolean {
    return queryOne(db, 'SELECT 1 AS x FROM loyalty_xp_events WHERE event_key = ?', eventKey) !== undefined;
  },

  /** After a reset: the announced mark comes down to the current level, so levelling up again is announced again. */
  resetAnnouncements(db: Database, guildId: string, userId: string | null): void {
    if (userId) execute(db, 'UPDATE loyalty_levels SET announced_level = MIN(announced_level, level) WHERE guild_id = ? AND user_id = ?', guildId, userId);
    else execute(db, 'UPDATE loyalty_levels SET announced_level = MIN(announced_level, level) WHERE guild_id = ?', guildId);
  },

  /** A server's members who have XP (for resetting the leaderboard). */
  withXp(db: Database, guildId: string): Array<{ userId: string; xp: number }> {
    return queryAll<{ userId: string; xp: number }>(db, 'SELECT user_id AS userId, xp FROM loyalty_levels WHERE guild_id = ? AND xp > 0', guildId);
  },

  /** Raises the announced high-water mark. False when this level (or a higher one) was already announced. */
  claimAnnouncement(db: Database, guildId: string, userId: string, level: number): boolean {
    return execute(db, 'UPDATE loyalty_levels SET announced_level = ? WHERE guild_id = ? AND user_id = ? AND announced_level < ?', level, guildId, userId, level) > 0;
  },

  /**
   * One server's members: by XP (the leaderboard), or by points (members with points but no XP there show level 0).
   * Points are Discord-wide (one balance per Discord account), XP is per server.
   */
  members(db: Database, f: { guildId: string; query: string | null; sort: 'xp' | 'points'; limit: number; offset: number }): { rows: LoyaltyMemberRow[]; total: number } {
    const params = f.query ? [likeText(f.query), f.query] : [];
    if (f.sort === 'xp') {
      const search = f.query ? "AND (l.display_name LIKE ? ESCAPE '\\' OR l.user_id = ?)" : '';
      const total = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM loyalty_levels l WHERE l.guild_id = ? ${search}`, f.guildId, ...params)?.n ?? 0;
      const rows = queryAll<LoyaltyMemberRow>(
        db,
        `SELECT l.guild_id AS guildId, l.user_id AS userId, COALESCE(l.display_name, a.display_name) AS displayName, l.xp, l.level, COALESCE(a.balance, 0) AS points
         FROM loyalty_levels l LEFT JOIN loyalty_accounts a ON a.platform = 'discord' AND a.user_id = l.user_id
         WHERE l.guild_id = ? ${search}
         ORDER BY l.xp DESC, points DESC, l.user_id LIMIT ? OFFSET ?`,
        f.guildId,
        ...params,
        f.limit,
        f.offset,
      );
      return { rows, total };
    }
    const search = f.query ? "AND (a.display_name LIKE ? ESCAPE '\\' OR a.user_id = ?)" : '';
    const total = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM loyalty_accounts a WHERE a.platform = 'discord' ${search}`, ...params)?.n ?? 0;
    const rows = queryAll<LoyaltyMemberRow>(
      db,
      `SELECT ? AS guildId, a.user_id AS userId, COALESCE(l.display_name, a.display_name) AS displayName, COALESCE(l.xp, 0) AS xp,
         COALESCE(l.level, 0) AS level, a.balance AS points
       FROM loyalty_accounts a LEFT JOIN loyalty_levels l ON l.guild_id = ? AND l.user_id = a.user_id
       WHERE a.platform = 'discord' ${search}
       ORDER BY a.balance DESC, xp DESC, a.user_id LIMIT ? OFFSET ?`,
      f.guildId,
      f.guildId,
      ...params,
      f.limit,
      f.offset,
    );
    return { rows, total };
  },

  /** A member's level rows in every server. */
  forUser(db: Database, userId: string): LoyaltyLevelRecord[] {
    return queryAll<LoyaltyLevelRecord>(db, `SELECT ${LEVEL} FROM loyalty_levels WHERE user_id = ? ORDER BY xp DESC`, userId);
  },

  /** Rank (1 = most XP) of a member in a server; ties are broken by user id, as on the leaderboard. */
  rank(db: Database, guildId: string, userId: string): number | null {
    const me = loyaltyLevelsRepo.get(db, guildId, userId);
    if (!me) return null;
    const ahead = queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM loyalty_levels WHERE guild_id = ? AND (xp > ? OR (xp = ? AND user_id < ?))', guildId, me.xp, me.xp, userId)?.n ?? 0;
    return ahead + 1;
  },

  /** Servers with XP records, with how many members each. */
  guilds(db: Database): Array<{ guildId: string; members: number }> {
    return queryAll(db, 'SELECT guild_id AS guildId, COUNT(*) AS members FROM loyalty_levels GROUP BY guild_id ORDER BY members DESC, guild_id');
  },

  xpEvents(db: Database, userId: string, limit: number): LoyaltyXpEventRecord[] {
    return queryAll<LoyaltyXpEventRecord>(db, `SELECT ${XP_EVENT} FROM loyalty_xp_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, userId, limit);
  },

  /** Recent XP adjustments (not ordinary message awards), newest first. */
  recentAdjustments(db: Database, limit: number): Array<LoyaltyXpEventRecord & { displayName: string | null }> {
    return queryAll(
      db,
      `SELECT e.id, e.guild_id AS guildId, e.user_id AS userId, e.amount, e.xp_after AS xpAfter, e.level_after AS levelAfter, e.kind, e.reason,
         e.created_at AS createdAt, l.display_name AS displayName
       FROM loyalty_xp_events e JOIN loyalty_levels l ON l.guild_id = e.guild_id AND l.user_id = e.user_id
       WHERE e.kind = 'adjustment' ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      limit,
    );
  },

  stats(db: Database): { members: number; totalXp: number } {
    const r = queryOne<{ members: number; totalXp: number | null }>(db, 'SELECT COUNT(*) AS members, SUM(xp) AS totalXp FROM loyalty_levels');
    return { members: r?.members ?? 0, totalXp: r?.totalXp ?? 0 };
  },

  // ── role rewards ──

  roleRewards(db: Database, guildId: string | null): LoyaltyRoleRewardRecord[] {
    return guildId
      ? queryAll<LoyaltyRoleRewardRecord>(db, `SELECT ${ROLE_REWARD} FROM loyalty_role_rewards WHERE guild_id = ? ORDER BY level, role_id`, guildId)
      : queryAll<LoyaltyRoleRewardRecord>(db, `SELECT ${ROLE_REWARD} FROM loyalty_role_rewards ORDER BY guild_id, level, role_id`);
  },

  /** False when that role is already a reward in that server. */
  insertRoleReward(db: Database, r: LoyaltyRoleRewardRecord): boolean {
    return execute(db, 'INSERT INTO loyalty_role_rewards (id, guild_id, level, role_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (guild_id, role_id) DO NOTHING', r.id, r.guildId, r.level, r.roleId, r.createdAt) > 0;
  },

  /** Removes the milestone only; roles members already received are not taken away. */
  deleteRoleReward(db: Database, id: string): LoyaltyRoleRewardRecord | undefined {
    const r = queryOne<LoyaltyRoleRewardRecord>(db, `SELECT ${ROLE_REWARD} FROM loyalty_role_rewards WHERE id = ?`, id);
    if (r) execute(db, 'DELETE FROM loyalty_role_rewards WHERE id = ?', id);
    return r;
  },

  grant(db: Database, guildId: string, userId: string, roleId: string): LoyaltyRoleGrantRecord | undefined {
    return queryOne<LoyaltyRoleGrantRecord>(db, `SELECT ${GRANT} FROM loyalty_role_grants WHERE guild_id = ? AND user_id = ? AND role_id = ?`, guildId, userId, roleId);
  },

  recordGrant(db: Database, g: Omit<LoyaltyRoleGrantRecord, 'attempts'>): void {
    execute(
      db,
      `INSERT INTO loyalty_role_grants (guild_id, user_id, role_id, level, status, detail, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, level = excluded.level,
         attempts = attempts + 1, updated_at = excluded.updated_at`,
      g.guildId,
      g.userId,
      g.roleId,
      g.level,
      g.status,
      g.detail?.slice(0, 300) ?? null,
      g.updatedAt,
    );
  },

  failedGrants(db: Database, limit: number): Array<LoyaltyRoleGrantRecord & { displayName: string | null }> {
    return queryAll(
      db,
      `SELECT g.guild_id AS guildId, g.user_id AS userId, g.role_id AS roleId, g.level, g.status, g.detail, g.attempts, g.updated_at AS updatedAt,
         l.display_name AS displayName
       FROM loyalty_role_grants g LEFT JOIN loyalty_levels l ON l.guild_id = g.guild_id AND l.user_id = g.user_id
       WHERE g.status = 'failed' ORDER BY g.updated_at DESC LIMIT ?`,
      limit,
    );
  },
};
