/**
 * Migration 25 — Embed Creator: messages CONDUIT can edit later (sent by its bot), with the message as last saved.
 * via is always 'bot' and webhook_id always NULL: editing webhook messages was planned but isn't offered.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_POSTED_MESSAGES_MIGRATION_SQL = `
CREATE TABLE discord_posted_messages (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  guild_id    TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  channel_id  TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 32),
  message_id  TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 32),
  via         TEXT NOT NULL CHECK (via IN ('bot', 'webhook')),
  webhook_id  TEXT CHECK (webhook_id IS NULL OR length(webhook_id) BETWEEN 1 AND 32),
  draft       TEXT NOT NULL CHECK (json_valid(draft)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (channel_id, message_id)
) STRICT;
CREATE INDEX discord_posted_messages_updated ON discord_posted_messages (updated_at DESC);
`;
