/**
 * Migration 27 — the text of recent messages in the logged server, kept by Discord Logging (only while Messages logging
 * is on, for at most 7 days) so deleted and edited messages can show what was written, even after the bot reconnects.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_MESSAGE_TEXTS_MIGRATION_SQL = `
CREATE TABLE discord_message_texts (
  message_id   TEXT PRIMARY KEY CHECK (length(message_id) BETWEEN 1 AND 32),
  guild_id     TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  channel_id   TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 32),
  author_id    TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 32),
  author_name  TEXT CHECK (author_name IS NULL OR length(author_name) <= 100),
  content      TEXT NOT NULL CHECK (length(content) <= 4000),
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX discord_message_texts_created ON discord_message_texts (created_at);
`;
