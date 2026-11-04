/**
 * Migration 30 — custom commands for Twitch chat as well.
 *
 * chat_commands accepts platform 'twitch' (triggers "!name", like Kick). SQLite can't change a CHECK constraint in
 * place, so the table is rebuilt: a new table with the wider rules, every existing row copied unchanged (ids, triggers,
 * responses, permissions, cooldowns, timestamps), then swapped in. The runner wraps this in one transaction.
 * Command counters ({count}) are keyed by command id, so they carry over untouched.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const TWITCH_COMMANDS_MIGRATION_SQL = `
CREATE TABLE chat_commands_v30 (
  id               TEXT PRIMARY KEY,
  platform         TEXT NOT NULL CHECK (platform IN ('kick', 'discord', 'twitch')),
  trigger          TEXT NOT NULL CHECK (
                     length(trigger) BETWEEN 2 AND 33 AND trigger = lower(trigger)
                     AND ((platform IN ('kick', 'twitch') AND trigger GLOB '!*') OR (platform = 'discord' AND trigger GLOB '/*'))
                   ),
  description      TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 100),
  response         TEXT NOT NULL CHECK (length(response) BETWEEN 1 AND 4000),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  permission       TEXT NOT NULL DEFAULT 'everyone' CHECK (permission IN ('everyone', 'subscriber', 'moderator', 'broadcaster')),
  cooldown_mode    TEXT NOT NULL DEFAULT 'none' CHECK (cooldown_mode IN ('none', 'user', 'global')),
  cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  UNIQUE (platform, trigger),
  CHECK (platform <> 'discord' OR description IS NOT NULL)
) STRICT;

INSERT INTO chat_commands_v30 (id, platform, trigger, description, response, enabled, created_at, updated_at, permission, cooldown_mode, cooldown_seconds)
  SELECT id, platform, trigger, description, response, enabled, created_at, updated_at, permission, cooldown_mode, cooldown_seconds
  FROM chat_commands;

DROP TABLE chat_commands;
ALTER TABLE chat_commands_v30 RENAME TO chat_commands;
`;
