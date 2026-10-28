import { execute, queryAll, queryOne, type Database } from '../sqlite';

// Members CONDUIT's anti-nuke quarantined, with the roles it removed (migration 24).

export interface DiscordQuarantineRecord {
  id: string;
  createdAt: string;
  guildId: string;
  userId: string;
  userName: string | null;
  /** The role ids CONDUIT removed (given back on restore). */
  roles: string[];
  reason: string;
  status: 'active' | 'restored' | 'released';
  resolvedAt: string | null;
}

/** At most this many are kept; the oldest resolved ones are removed first. */
const KEPT = 500;

interface Row {
  id: string;
  created_at: string;
  guild_id: string;
  user_id: string;
  user_name: string | null;
  roles: string;
  reason: string;
  status: DiscordQuarantineRecord['status'];
  resolved_at: string | null;
}

function toRecord(r: Row): DiscordQuarantineRecord {
  let roles: string[] = [];
  try {
    const parsed = JSON.parse(r.roles) as unknown;
    if (Array.isArray(parsed)) roles = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // keep none
  }
  return {
    id: r.id,
    createdAt: r.created_at,
    guildId: r.guild_id,
    userId: r.user_id,
    userName: r.user_name,
    roles,
    reason: r.reason,
    status: r.status,
    resolvedAt: r.resolved_at,
  };
}

export const discordQuarantineRepo = {
  insert(db: Database, r: Omit<DiscordQuarantineRecord, 'status' | 'resolvedAt'>): void {
    execute(
      db,
      `INSERT INTO discord_quarantine (id, created_at, guild_id, user_id, user_name, roles, reason, status, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
      r.id,
      r.createdAt,
      r.guildId,
      r.userId,
      r.userName === null ? null : r.userName.slice(0, 100),
      JSON.stringify(r.roles),
      r.reason.slice(0, 300),
    );
    execute(
      db,
      `DELETE FROM discord_quarantine WHERE status <> 'active' AND id NOT IN (SELECT id FROM discord_quarantine ORDER BY created_at DESC LIMIT ${KEPT})`,
    );
  },

  get(db: Database, id: string): DiscordQuarantineRecord | null {
    const row = queryOne<Row>(db, 'SELECT * FROM discord_quarantine WHERE id = ?', id);
    return row ? toRecord(row) : null;
  },

  /** The member's active quarantine in a server, if any. */
  active(db: Database, guildId: string, userId: string): DiscordQuarantineRecord | null {
    const row = queryOne<Row>(db, "SELECT * FROM discord_quarantine WHERE guild_id = ? AND user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", guildId, userId);
    return row ? toRecord(row) : null;
  },

  resolve(db: Database, id: string, status: 'restored' | 'released', at: string): boolean {
    return execute(db, "UPDATE discord_quarantine SET status = ?, resolved_at = ? WHERE id = ? AND status = 'active'", status, at, id) > 0;
  },

  /** Newest first. */
  list(db: Database, limit: number): DiscordQuarantineRecord[] {
    return queryAll<Row>(db, 'SELECT * FROM discord_quarantine ORDER BY created_at DESC LIMIT ?', limit).map(toRecord);
  },
};
