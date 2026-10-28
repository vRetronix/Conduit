/**
 * Migration 12 — giveaways (Phase 9).
 *
 * - giveaways: one row per giveaway and its lifecycle timestamps. At most one is 'open' (partial unique index), so the
 *   entry commands always mean the same giveaway. The latest Kick announcement's outcome is kept for the dashboard.
 * - giveaway_entries: one row per entrant, unique per (giveaway, platform, platform user id) — never by display name.
 *   The display name is a snapshot taken at entry, for showing results.
 * - giveaway_draws: every drawing, initial or redraw, with its pool size. At most one initial draw per giveaway.
 * - giveaway_winners: every winner ever selected. A redraw marks the replaced winner 'replaced' (kept for the record)
 *   and adds the new one at the same place; an entry can win at most once per giveaway.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const GIVEAWAYS_MIGRATION_SQL = `
CREATE TABLE giveaways (
  id               TEXT PRIMARY KEY,
  prize            TEXT NOT NULL CHECK (length(prize) BETWEEN 1 AND 100),
  description      TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  status           TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'drawn', 'cancelled')),
  winner_count     INTEGER NOT NULL CHECK (winner_count BETWEEN 1 AND 50),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 10080),
  allow_kick       INTEGER NOT NULL CHECK (allow_kick IN (0, 1)),
  allow_discord    INTEGER NOT NULL CHECK (allow_discord IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  ends_at          TEXT,
  closed_at        TEXT,
  drawn_at         TEXT,
  cancelled_at     TEXT,
  announce_at      TEXT,
  announce_kind    TEXT CHECK (announce_kind IS NULL OR announce_kind IN ('started', 'closed', 'winners', 'redraw')),
  announce_outcome TEXT CHECK (announce_outcome IS NULL OR announce_outcome IN ('sent', 'failed', 'unconfirmed', 'skipped')),
  announce_detail  TEXT CHECK (announce_detail IS NULL OR length(announce_detail) <= 300),
  CHECK (allow_kick = 1 OR allow_discord = 1)
) STRICT;

CREATE UNIQUE INDEX giveaways_one_open ON giveaways (status) WHERE status = 'open';
CREATE INDEX giveaways_open_ends ON giveaways (ends_at) WHERE status = 'open';

CREATE TABLE giveaway_entries (
  id               INTEGER PRIMARY KEY,
  giveaway_id      TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN ('kick', 'discord')),
  platform_user_id TEXT NOT NULL CHECK (length(platform_user_id) BETWEEN 1 AND 32),
  display_name     TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  entered_at       TEXT NOT NULL,
  UNIQUE (giveaway_id, platform, platform_user_id)
) STRICT;

CREATE TABLE giveaway_draws (
  id                 TEXT PRIMARY KEY,
  giveaway_id        TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('initial', 'redraw')),
  drawn_at           TEXT NOT NULL,
  pool_size          INTEGER NOT NULL CHECK (pool_size >= 0),
  replaced_winner_id TEXT,
  reason             TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  CHECK ((kind = 'initial') = (replaced_winner_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX giveaway_draws_one_initial ON giveaway_draws (giveaway_id) WHERE kind = 'initial';

CREATE TABLE giveaway_winners (
  id          TEXT PRIMARY KEY,
  giveaway_id TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  draw_id     TEXT NOT NULL REFERENCES giveaway_draws (id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES giveaway_entries (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
  status      TEXT NOT NULL CHECK (status IN ('won', 'replaced')),
  selected_at TEXT NOT NULL,
  replaced_at TEXT,
  CHECK ((status = 'replaced') = (replaced_at IS NOT NULL)),
  UNIQUE (giveaway_id, entry_id)
) STRICT;

CREATE UNIQUE INDEX giveaway_winners_current_place ON giveaway_winners (giveaway_id, position) WHERE status = 'won';
`;
