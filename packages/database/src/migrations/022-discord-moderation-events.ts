/**
 * Migration 22 — moderation that happened in a Discord server outside CONDUIT, from Discord's audit log: bans, unbans,
 * kicks and timeouts done with Discord's own buttons or by other bots, and AutoMod's actions (message blocked, flagged
 * to a channel, member timed out). Shown with CONDUIT's own moderation commands under Discord Bot → Logs.
 * - entry_id is Discord's audit log entry id (UNIQUE), so a redelivered entry is recorded once.
 * - Actions by CONDUIT's own bot aren't stored here: they're CONDUIT commands, already in moderation_actions.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_MODERATION_EVENTS_MIGRATION_SQL = `
CREATE TABLE discord_moderation_events (
  id              TEXT PRIMARY KEY CHECK (length(id) = 36),
  entry_id        TEXT NOT NULL UNIQUE CHECK (length(entry_id) BETWEEN 1 AND 32),
  created_at      TEXT NOT NULL,
  guild_id        TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  action          TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'kick', 'timeout', 'untimeout', 'automod_block', 'automod_flag', 'automod_timeout')),
  target_user_id  TEXT CHECK (target_user_id IS NULL OR length(target_user_id) BETWEEN 1 AND 32),
  target_name     TEXT CHECK (target_name IS NULL OR length(target_name) <= 100),
  executor_id     TEXT CHECK (executor_id IS NULL OR length(executor_id) BETWEEN 1 AND 32),
  executor_name   TEXT CHECK (executor_name IS NULL OR length(executor_name) <= 100),
  executor_bot    INTEGER NOT NULL DEFAULT 0 CHECK (executor_bot IN (0, 1)),
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 512),
  rule_name       TEXT CHECK (rule_name IS NULL OR length(rule_name) <= 100),
  channel_id      TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 32),
  until           TEXT CHECK (until IS NULL OR length(until) <= 40)
) STRICT;
CREATE INDEX discord_moderation_events_created ON discord_moderation_events (created_at DESC);
`;
