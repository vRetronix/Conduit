/**
 * Migration 16 — automations: user-defined workflows (trigger → conditions → actions) and their execution history.
 *
 * - automations: name, enabled flag and the validated definition (JSON: trigger, conditions, actions, cooldown).
 * - automation_runs: one row per run. UNIQUE (automation_id, event_key) is the deduplication guard: the same event
 *   (a Kick message id, a giveaway change, a schedule slot) can start an automation at most once, even when a webhook
 *   is delivered twice. Runs belong to their automation and are removed with it (ON DELETE CASCADE); nothing else
 *   (commands, giveaways, moderation history) references these tables.
 * Additive: two new tables; nothing existing changes.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const AUTOMATIONS_MIGRATION_SQL = `
CREATE TABLE automations (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  definition  TEXT NOT NULL CHECK (length(definition) <= 20000 AND json_valid(definition)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE automation_runs (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  event_key      TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  trigger        TEXT NOT NULL CHECK (length(trigger) <= 40),
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  detail         TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  steps          TEXT NOT NULL DEFAULT '[]' CHECK (length(steps) <= 8000 AND json_valid(steps)),
  UNIQUE (automation_id, event_key)
) STRICT;

CREATE INDEX automation_runs_started ON automation_runs (started_at DESC);
`;
