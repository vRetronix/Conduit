/**
 * Migration 15 — moderation history: one row per moderation action taken through CONDUIT (from the dashboard or by
 * automated protection), with its outcome. Only actions CONDUIT performed or attempted are recorded; moderation done
 * directly on Discord or Kick isn't visible here.
 *
 * - platform / place: Discord server (guild id + name) or Kick channel (broadcaster id + name).
 * - action: timeout, untimeout, ban, unban, delete_message, or flag (automated protection in "log only" mode).
 * - target: the platform user id (never matched by name) and a display-name snapshot.
 * - source: manual (dashboard) or automod; rule: the automated rule that matched.
 * - outcome: success (the platform confirmed), failed (with the platform's explanation), logged (flag only).
 * Additive: a new table; nothing existing changes.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const MODERATION_MIGRATION_SQL = `
CREATE TABLE moderation_actions (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),
  created_at       TEXT NOT NULL,
  platform         TEXT NOT NULL CHECK (platform IN ('discord', 'kick')),
  place_id         TEXT CHECK (place_id IS NULL OR length(place_id) BETWEEN 1 AND 32),
  place_name       TEXT CHECK (place_name IS NULL OR length(place_name) <= 100),
  action           TEXT NOT NULL CHECK (action IN ('timeout', 'untimeout', 'ban', 'unban', 'delete_message', 'flag')),
  target_user_id   TEXT NOT NULL CHECK (length(target_user_id) BETWEEN 1 AND 32),
  target_name      TEXT CHECK (target_name IS NULL OR length(target_name) <= 100),
  message_id       TEXT CHECK (message_id IS NULL OR length(message_id) <= 64),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 2419200),
  reason           TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  source           TEXT NOT NULL CHECK (source IN ('manual', 'automod')),
  actor            TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  rule             TEXT CHECK (rule IS NULL OR rule IN ('blocked_terms', 'repeat', 'spam')),
  outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'logged')),
  detail           TEXT CHECK (detail IS NULL OR length(detail) <= 300)
) STRICT;

CREATE INDEX moderation_actions_created ON moderation_actions (created_at DESC);
CREATE INDEX moderation_actions_target ON moderation_actions (platform, target_user_id);
`;
