/**
 * Migration 6 — Discord setup progress (non-secret only).
 *
 * - discord_application: the user's own Discord application (a single row). The Client Secret and Bot Token are NOT
 *   here; they live in the desktop's DPAPI-encrypted credential vault. This row records what Discord confirmed when
 *   they were validated (application name, bot user).
 * - discord_guild_installations: servers the bot is verifiably in, as reported by Discord's gateway or API — never
 *   inferred from a browser redirect.
 *
 * Progress through the setup wizard is derived from these rows, the Discord account connection
 * (platform_connections) and the live bot status, so a restart resumes where the user left off.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_SETUP_MIGRATION_SQL = `
CREATE TABLE discord_application (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  application_id   TEXT NOT NULL CHECK (length(application_id) BETWEEN 15 AND 25 AND application_id NOT GLOB '*[^0-9]*'),
  application_name TEXT,
  bot_user_id      TEXT CHECK (bot_user_id IS NULL OR bot_user_id NOT GLOB '*[^0-9]*'),
  bot_username     TEXT,
  validated_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE discord_guild_installations (
  guild_id    TEXT PRIMARY KEY CHECK (guild_id NOT GLOB '*[^0-9]*'),
  guild_name  TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;
`;
