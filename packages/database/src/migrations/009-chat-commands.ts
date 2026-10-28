/**
 * Migration 9 — custom chat commands (Phase 7.1: Kick).
 *
 * A command is a trigger (e.g. "!discord", stored normalized to lower case) and a plain-text response. Responses are
 * data, never code. Triggers are unique per platform. Only 'kick' is allowed for now; Discord commands are a separate,
 * code-defined registry (slash commands) and are not stored here.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const CHAT_COMMANDS_MIGRATION_SQL = `
CREATE TABLE chat_commands (
  id         TEXT PRIMARY KEY,
  platform   TEXT NOT NULL CHECK (platform IN ('kick')),
  trigger    TEXT NOT NULL CHECK (length(trigger) BETWEEN 2 AND 32 AND trigger GLOB '!*' AND trigger = lower(trigger)),
  response   TEXT NOT NULL CHECK (length(response) BETWEEN 1 AND 2048),
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, trigger)
) STRICT;
`;
