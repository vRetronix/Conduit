import { execute, queryAll, type Database } from '../sqlite';

// Moderation in Discord servers outside CONDUIT, from the audit log (migration 22).

export type DiscordModerationEventAction = 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout' | 'automod_block' | 'automod_flag' | 'automod_timeout';

export interface DiscordModerationEventRecord {
  id: string;
  entryId: string;
  createdAt: string;
  guildId: string;
  action: DiscordModerationEventAction;
  targetUserId: string | null;
  targetName: string | null;
  executorId: string | null;
  executorName: string | null;
  executorBot: boolean;
  reason: string | null;
  ruleName: string | null;
  channelId: string | null;
  until: string | null;
}

/** At most this many are kept; older ones are removed when new ones arrive. */
const KEPT = 2000;
const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

interface Row {
  id: string;
  entry_id: string;
  created_at: string;
  guild_id: string;
  action: DiscordModerationEventAction;
  target_user_id: string | null;
  target_name: string | null;
  executor_id: string | null;
  executor_name: string | null;
  executor_bot: number;
  reason: string | null;
  rule_name: string | null;
  channel_id: string | null;
  until: string | null;
}

export const discordModerationEventsRepo = {
  /** Records an event; a repeated audit entry id is ignored. Returns whether it was new. */
  insert(db: Database, r: DiscordModerationEventRecord): boolean {
    const added = execute(
      db,
      `INSERT OR IGNORE INTO discord_moderation_events
        (id, entry_id, created_at, guild_id, action, target_user_id, target_name, executor_id, executor_name, executor_bot, reason, rule_name, channel_id, until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.entryId,
      r.createdAt,
      r.guildId,
      r.action,
      r.targetUserId,
      cap(r.targetName, 100),
      r.executorId,
      cap(r.executorName, 100),
      r.executorBot ? 1 : 0,
      cap(r.reason, 512),
      cap(r.ruleName, 100),
      r.channelId,
      cap(r.until, 40),
    );
    if (added > 0) {
      execute(db, `DELETE FROM discord_moderation_events WHERE id NOT IN (SELECT id FROM discord_moderation_events ORDER BY created_at DESC LIMIT ${KEPT})`);
    }
    return added > 0;
  },

  /** One user's entries, newest first. */
  listForUser(db: Database, userId: string, limit: number): DiscordModerationEventRecord[] {
    return this.list(db, limit, userId);
  },

  /** Newest first (optionally one user's). */
  list(db: Database, limit: number, userId?: string): DiscordModerationEventRecord[] {
    const rows = userId
      ? queryAll<Row>(db, 'SELECT * FROM discord_moderation_events WHERE target_user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      : queryAll<Row>(db, 'SELECT * FROM discord_moderation_events ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      createdAt: r.created_at,
      guildId: r.guild_id,
      action: r.action,
      targetUserId: r.target_user_id,
      targetName: r.target_name,
      executorId: r.executor_id,
      executorName: r.executor_name,
      executorBot: r.executor_bot === 1,
      reason: r.reason,
      ruleName: r.rule_name,
      channelId: r.channel_id,
      until: r.until,
    }));
  },
};
