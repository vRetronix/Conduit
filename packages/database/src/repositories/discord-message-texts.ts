import { execute, queryOne, type Database } from '../sqlite';

// Recent message text kept by Discord Logging, for deleted and edited messages (migration 27).

export interface DiscordMessageTextRecord {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorName: string | null;
  content: string;
  createdAt: string;
}

/** At most this many are kept; the oldest go first. */
const KEPT = 50_000;

interface Row {
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  author_name: string | null;
  content: string;
  created_at: string;
}

export const discordMessageTextsRepo = {
  put(db: Database, r: DiscordMessageTextRecord): void {
    execute(
      db,
      `INSERT OR REPLACE INTO discord_message_texts (message_id, guild_id, channel_id, author_id, author_name, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      r.messageId,
      r.guildId,
      r.channelId,
      r.authorId,
      r.authorName === null ? null : r.authorName.slice(0, 100),
      r.content.slice(0, 4000),
      r.createdAt,
    );
  },

  get(db: Database, messageId: string): DiscordMessageTextRecord | null {
    const r = queryOne<Row>(db, 'SELECT * FROM discord_message_texts WHERE message_id = ?', messageId);
    return r
      ? { messageId: r.message_id, guildId: r.guild_id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: r.created_at }
      : null;
  },

  /** After an edit: the new text (only for a message already kept). */
  setContent(db: Database, messageId: string, content: string): void {
    execute(db, 'UPDATE discord_message_texts SET content = ? WHERE message_id = ?', content.slice(0, 4000), messageId);
  },

  remove(db: Database, messageIds: string[]): void {
    for (const id of messageIds) execute(db, 'DELETE FROM discord_message_texts WHERE message_id = ?', id);
  },

  /** Removes text older than `before`, and the oldest beyond the cap. */
  prune(db: Database, before: string): void {
    execute(db, 'DELETE FROM discord_message_texts WHERE created_at < ?', before);
    execute(db, `DELETE FROM discord_message_texts WHERE message_id NOT IN (SELECT message_id FROM discord_message_texts ORDER BY created_at DESC LIMIT ${KEPT})`);
  },

  /** Removes everything, or everything except one server's. */
  clear(db: Database, exceptGuildId: string | null = null): void {
    if (exceptGuildId) execute(db, 'DELETE FROM discord_message_texts WHERE guild_id <> ?', exceptGuildId);
    else execute(db, 'DELETE FROM discord_message_texts');
  },
};
