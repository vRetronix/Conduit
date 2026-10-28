/**
 * Migration 21 — counters for custom command variables: {count} (how often a command was used; key "count:<command
 * id>") and named counters such as {counter:deaths+1} (key "counter:<name>"). Shared by Kick and Discord commands.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const COMMAND_COUNTERS_MIGRATION_SQL = `
CREATE TABLE command_counters (
  key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 80),
  value       INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
`;
