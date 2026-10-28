/**
 * Migration 24 — members CONDUIT's anti-nuke quarantined (their roles removed), with the roles it removed so they can be
 * given back (Discord Bot → Protection → Anti-nuke → Quarantine).
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_QUARANTINE_MIGRATION_SQL = `
CREATE TABLE discord_quarantine (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  created_at   TEXT NOT NULL,
  guild_id     TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  user_id      TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 32),
  user_name    TEXT CHECK (user_name IS NULL OR length(user_name) <= 100),
  roles        TEXT NOT NULL CHECK (json_valid(roles)),
  reason       TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  status       TEXT NOT NULL CHECK (status IN ('active', 'restored', 'released')),
  resolved_at  TEXT
) STRICT;
CREATE INDEX discord_quarantine_created ON discord_quarantine (created_at DESC);
`;
