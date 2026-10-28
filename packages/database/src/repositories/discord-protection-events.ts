import { execute, queryAll, type Database } from '../sqlite';

// What CONDUIT's own Discord protection noticed or did (migration 23).

export interface DiscordProtectionEventRecord {
  id: string;
  createdAt: string;
  guildId: string;
  feature: 'message' | 'antinuke' | 'antiraid' | 'joingate' | 'botbait';
  rule: string;
  userId: string | null;
  userName: string | null;
  channelId: string | null;
  action: string;
  outcome: 'success' | 'failed' | 'logged';
  detail: string | null;
}

/** At most this many are kept; older ones are removed when new ones arrive. */
const KEPT = 2000;
const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

interface Row {
  id: string;
  created_at: string;
  guild_id: string;
  feature: DiscordProtectionEventRecord['feature'];
  rule: string;
  user_id: string | null;
  user_name: string | null;
  channel_id: string | null;
  action: string;
  outcome: DiscordProtectionEventRecord['outcome'];
  detail: string | null;
}

export const discordProtectionEventsRepo = {
  insert(db: Database, r: DiscordProtectionEventRecord): void {
    execute(
      db,
      `INSERT INTO discord_protection_events (id, created_at, guild_id, feature, rule, user_id, user_name, channel_id, action, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.createdAt,
      r.guildId,
      r.feature,
      r.rule.slice(0, 40),
      r.userId,
      cap(r.userName, 100),
      r.channelId,
      r.action.slice(0, 40),
      r.outcome,
      cap(r.detail, 300),
    );
    execute(db, `DELETE FROM discord_protection_events WHERE id NOT IN (SELECT id FROM discord_protection_events ORDER BY created_at DESC LIMIT ${KEPT})`);
  },

  /** One user's entries, newest first. */
  listForUser(db: Database, userId: string, limit: number): DiscordProtectionEventRecord[] {
    return this.list(db, limit, userId);
  },

  /** Newest first (optionally one user's). */
  list(db: Database, limit: number, userId?: string): DiscordProtectionEventRecord[] {
    const rows = userId
      ? queryAll<Row>(db, 'SELECT * FROM discord_protection_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      : queryAll<Row>(db, 'SELECT * FROM discord_protection_events ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      guildId: r.guild_id,
      feature: r.feature,
      rule: r.rule,
      userId: r.user_id,
      userName: r.user_name,
      channelId: r.channel_id,
      action: r.action,
      outcome: r.outcome,
      detail: r.detail,
    }));
  },
};
