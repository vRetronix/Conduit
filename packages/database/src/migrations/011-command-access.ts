/**
 * Migration 11 — permissions and cooldowns for custom commands.
 *
 * Adds three columns with defaults that keep the existing behaviour: everyone may use the command, no cooldown.
 * Existing rows are untouched apart from gaining these defaults (ALTER TABLE ADD COLUMN; no rebuild).
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const COMMAND_ACCESS_MIGRATION_SQL = `
ALTER TABLE chat_commands ADD COLUMN permission TEXT NOT NULL DEFAULT 'everyone'
  CHECK (permission IN ('everyone', 'subscriber', 'moderator', 'broadcaster'));
ALTER TABLE chat_commands ADD COLUMN cooldown_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (cooldown_mode IN ('none', 'user', 'global'));
ALTER TABLE chat_commands ADD COLUMN cooldown_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (cooldown_seconds BETWEEN 0 AND 86400);
`;
