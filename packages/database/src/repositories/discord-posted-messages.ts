import { execute, queryAll, queryOne, type Database } from '../sqlite';

// Embed Creator: messages CONDUIT can edit later (migration 25).

export interface DiscordPostedMessageRecord {
  id: string;
  name: string;
  guildId: string;
  channelId: string;
  messageId: string;
  /** Always 'bot' (and webhookId null): only the bot's own messages are kept. */
  via: 'bot' | 'webhook';
  webhookId: string | null;
  /** The message as last saved (JSON of a MessageDraft). */
  draft: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  via: 'bot' | 'webhook';
  webhook_id: string | null;
  draft: string;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: Row): DiscordPostedMessageRecord => ({
  id: r.id,
  name: r.name,
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  via: r.via,
  webhookId: r.webhook_id,
  draft: r.draft,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const discordPostedMessagesRepo = {
  insert(db: Database, r: DiscordPostedMessageRecord): void {
    execute(
      db,
      `INSERT INTO discord_posted_messages (id, name, guild_id, channel_id, message_id, via, webhook_id, draft, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.name.slice(0, 80),
      r.guildId,
      r.channelId,
      r.messageId,
      r.via,
      r.webhookId,
      r.draft,
      r.createdAt,
      r.updatedAt,
    );
  },

  get(db: Database, id: string): DiscordPostedMessageRecord | null {
    const row = queryOne<Row>(db, 'SELECT * FROM discord_posted_messages WHERE id = ?', id);
    return row ? toRecord(row) : null;
  },

  byMessage(db: Database, channelId: string, messageId: string): DiscordPostedMessageRecord | null {
    const row = queryOne<Row>(db, 'SELECT * FROM discord_posted_messages WHERE channel_id = ? AND message_id = ?', channelId, messageId);
    return row ? toRecord(row) : null;
  },

  update(db: Database, id: string, name: string, draft: string, at: string): boolean {
    return execute(db, 'UPDATE discord_posted_messages SET name = ?, draft = ?, updated_at = ? WHERE id = ?', name.slice(0, 80), draft, at, id) > 0;
  },

  delete(db: Database, id: string): boolean {
    return execute(db, 'DELETE FROM discord_posted_messages WHERE id = ?', id) > 0;
  },

  /** Most recently changed first. */
  list(db: Database, limit = 200): DiscordPostedMessageRecord[] {
    return queryAll<Row>(db, 'SELECT * FROM discord_posted_messages ORDER BY updated_at DESC LIMIT ?', limit).map(toRecord);
  },
};
