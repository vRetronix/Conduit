/**
 * Who has chatted in the main Kick channel before (migration 29): Kick user id, name, and first/last time seen. Raid
 * mode uses it to tell first-time chatters from regulars, also across restarts. No message text is kept.
 */
import { execute, queryOne, type Database } from '../sqlite';

export const kickChattersRepo = {
  /** Records a chatter (or updates their name and last time). True when they had never chatted before. */
  seen(db: Database, userId: string, username: string, at: string): boolean {
    const known = queryOne<{ user_id: string }>(db, 'SELECT user_id FROM kick_chatters WHERE user_id = ?', userId);
    execute(
      db,
      `INSERT INTO kick_chatters (user_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at`,
      userId,
      username.slice(0, 64) || 'user',
      at,
      at,
    );
    return !known;
  },

  count(db: Database): number {
    return queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM kick_chatters')?.n ?? 0;
  },
};
