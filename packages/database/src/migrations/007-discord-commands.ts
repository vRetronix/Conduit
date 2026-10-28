/**
 * Migration 7 — Discord slash command registration status (non-secret only).
 *
 * One row per server CONDUIT registered (or tried to register) its slash commands in, for the configured
 * application. A row says "registered" only after Discord confirmed the commands. `commands_hash` fingerprints the
 * command definitions, so registration is repeated only when they change or Discord no longer has them.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_COMMANDS_MIGRATION_SQL = `
CREATE TABLE discord_command_registrations (
  guild_id        TEXT PRIMARY KEY CHECK (length(guild_id) BETWEEN 1 AND 25 AND guild_id NOT GLOB '*[^0-9]*'),
  application_id  TEXT NOT NULL CHECK (length(application_id) BETWEEN 15 AND 25 AND application_id NOT GLOB '*[^0-9]*'),
  commands_hash   TEXT NOT NULL CHECK (length(commands_hash) BETWEEN 1 AND 64),
  status          TEXT NOT NULL CHECK (status IN ('registered', 'failed')),
  registered_at   TEXT,
  last_attempt_at TEXT NOT NULL,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  CHECK (status <> 'registered' OR registered_at IS NOT NULL)
) STRICT;
`;
