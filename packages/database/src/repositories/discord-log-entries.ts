import { execute, queryAll, type Database } from '../sqlite';

// What Discord Logging posted, for the Moderation log (migration 26).

export interface DiscordLogEntryRecord {
  id: string;
  createdAt: string;
  guildId: string;
  category: 'moderation' | 'members' | 'messages' | 'server';
  event: string;
  title: string;
  userId: string | null;
  userName: string | null;
  detail: string | null;
  /** Posted to the log channel (false: Discord refused it). */
  posted: boolean;
}

/** At most this many are kept; older ones are removed when new ones arrive. */
const KEPT = 2000;
const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

interface Row {
  id: string;
  created_at: string;
  guild_id: string;
  category: DiscordLogEntryRecord['category'];
  event: string;
  title: string;
  user_id: string | null;
  user_name: string | null;
  detail: string | null;
  posted: number;
}

export const discordLogEntriesRepo = {
  insert(db: Database, r: DiscordLogEntryRecord): void {
    execute(
      db,
      `INSERT INTO discord_log_entries (id, created_at, guild_id, category, event, title, user_id, user_name, detail, posted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.createdAt,
      r.guildId,
      r.category,
      r.event.slice(0, 40),
      r.title.slice(0, 120) || 'Logged',
      r.userId,
      cap(r.userName, 100),
      cap(r.detail, 300),
      r.posted ? 1 : 0,
    );
    execute(db, `DELETE FROM discord_log_entries WHERE id NOT IN (SELECT id FROM discord_log_entries ORDER BY created_at DESC LIMIT ${KEPT})`);
  },

  /** One user's entries, newest first. */
  listForUser(db: Database, userId: string, limit: number): DiscordLogEntryRecord[] {
    return this.list(db, limit, userId);
  },

  /** Newest first (optionally one user's). */
  list(db: Database, limit: number, userId?: string): DiscordLogEntryRecord[] {
    const rows = userId
      ? queryAll<Row>(db, 'SELECT * FROM discord_log_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      : queryAll<Row>(db, 'SELECT * FROM discord_log_entries ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      guildId: r.guild_id,
      category: r.category,
      event: r.event,
      title: r.title,
      userId: r.user_id,
      userName: r.user_name,
      detail: r.detail,
      posted: r.posted === 1,
    }));
  },
};
