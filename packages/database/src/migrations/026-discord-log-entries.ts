/**
 * Migration 26 — what Discord Logging posted (members, messages, server changes), kept so Discord Bot → Logs →
 * Moderation log lists it too. Moderation events are already kept elsewhere (moderation_records,
 * discord_moderation_events), so they aren't repeated here.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_LOG_ENTRIES_MIGRATION_SQL = `
CREATE TABLE discord_log_entries (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  created_at  TEXT NOT NULL,
  guild_id    TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  category    TEXT NOT NULL CHECK (category IN ('moderation', 'members', 'messages', 'server')),
  event       TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 40),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  user_id     TEXT CHECK (user_id IS NULL OR length(user_id) BETWEEN 1 AND 32),
  user_name   TEXT CHECK (user_name IS NULL OR length(user_name) <= 100),
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  posted      INTEGER NOT NULL CHECK (posted IN (0, 1))
) STRICT;
CREATE INDEX discord_log_entries_created ON discord_log_entries (created_at DESC);
`;
