/**
 * Migration 10 — custom commands for Discord as well as Kick.
 *
 * SQLite can't change a CHECK constraint in place, so the table is rebuilt: a new table with the wider rules, every
 * existing row copied unchanged (ids, triggers, responses, enabled flags, timestamps), then swapped in. The migration
 * runner wraps this in one transaction, so it either fully happens or not at all.
 *
 * - platform: 'kick' (triggers "!name") or 'discord' (slash commands, stored as "/name").
 * - description: required by Discord for slash commands; NULL for Kick.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const COMMANDS_PLATFORMS_MIGRATION_SQL = `
CREATE TABLE chat_commands_v10 (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL CHECK (platform IN ('kick', 'discord')),
  trigger     TEXT NOT NULL CHECK (
                length(trigger) BETWEEN 2 AND 33 AND trigger = lower(trigger)
                AND ((platform = 'kick' AND trigger GLOB '!*') OR (platform = 'discord' AND trigger GLOB '/*'))
              ),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 100),
  response    TEXT NOT NULL CHECK (length(response) BETWEEN 1 AND 4000),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (platform, trigger),
  CHECK (platform <> 'discord' OR description IS NOT NULL)
) STRICT;

INSERT INTO chat_commands_v10 (id, platform, trigger, description, response, enabled, created_at, updated_at)
  SELECT id, platform, trigger, NULL, response, enabled, created_at, updated_at FROM chat_commands;

DROP TABLE chat_commands;
ALTER TABLE chat_commands_v10 RENAME TO chat_commands;
`;
