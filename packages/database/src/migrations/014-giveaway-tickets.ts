/**
 * Migration 14 — giveaway tickets: Kick Channel Points bonus tickets, a subscriber multiplier and auditable draws.
 *
 * - giveaways: the optional Kick reward (cost, bonus tickets per redemption, title, the reward id Kick returned and its
 *   state), and the subscriber multiplier (1 = off). Existing giveaways get no reward and multiplier 1, so they keep
 *   one entry = one ticket.
 * - giveaway_entries: whether the entrant was verified as an active subscriber when the entry was made, and the
 *   evidence (the signed chat event that carried Kick's subscriber badge). Existing rows: not verified.
 * - giveaway_redemptions: one row per Kick reward redemption, keyed by Kick's redemption id (never counted twice), with
 *   the outcome (accepted / rejected and why), the tickets it granted and whether Kick was told.
 * - giveaway_draws: the ticket calculation of every entry in the pool at that draw (JSON), so weights can be audited.
 * Columns are added with ALTER TABLE ADD COLUMN; existing rows are untouched.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const GIVEAWAY_TICKETS_MIGRATION_SQL = `
ALTER TABLE giveaways ADD COLUMN kick_reward_cost INTEGER
  CHECK (kick_reward_cost IS NULL OR kick_reward_cost BETWEEN 1 AND 10000000);
ALTER TABLE giveaways ADD COLUMN kick_reward_tickets INTEGER
  CHECK (kick_reward_tickets IS NULL OR kick_reward_tickets BETWEEN 1 AND 100);
ALTER TABLE giveaways ADD COLUMN kick_reward_title TEXT
  CHECK (kick_reward_title IS NULL OR length(kick_reward_title) BETWEEN 1 AND 50);
ALTER TABLE giveaways ADD COLUMN kick_reward_id TEXT
  CHECK (kick_reward_id IS NULL OR length(kick_reward_id) BETWEEN 1 AND 64);
ALTER TABLE giveaways ADD COLUMN kick_reward_status TEXT
  CHECK (kick_reward_status IS NULL OR kick_reward_status IN ('active', 'paused', 'removed', 'failed'));
ALTER TABLE giveaways ADD COLUMN kick_reward_detail TEXT
  CHECK (kick_reward_detail IS NULL OR length(kick_reward_detail) <= 300);
ALTER TABLE giveaways ADD COLUMN subscriber_multiplier INTEGER NOT NULL DEFAULT 1
  CHECK (subscriber_multiplier BETWEEN 1 AND 10);

ALTER TABLE giveaway_entries ADD COLUMN subscriber_verified INTEGER NOT NULL DEFAULT 0
  CHECK (subscriber_verified IN (0, 1));
ALTER TABLE giveaway_entries ADD COLUMN subscriber_evidence TEXT
  CHECK (subscriber_evidence IS NULL OR (length(subscriber_evidence) <= 500 AND json_valid(subscriber_evidence)));

CREATE TABLE giveaway_redemptions (
  id               TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  giveaway_id      TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  reward_id        TEXT NOT NULL CHECK (length(reward_id) BETWEEN 1 AND 64),
  redeemer_user_id TEXT NOT NULL CHECK (length(redeemer_user_id) BETWEEN 1 AND 32),
  redeemer_name    TEXT CHECK (redeemer_name IS NULL OR length(redeemer_name) <= 100),
  redeemed_at      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason           TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  tickets          INTEGER NOT NULL CHECK (tickets BETWEEN 0 AND 100),
  kick_synced      INTEGER NOT NULL DEFAULT 0 CHECK (kick_synced IN (0, 1)),
  processed_at     TEXT NOT NULL,
  CHECK ((status = 'accepted') = (tickets > 0))
) STRICT;
CREATE INDEX giveaway_redemptions_giveaway ON giveaway_redemptions (giveaway_id, redeemer_user_id);

ALTER TABLE giveaway_draws ADD COLUMN ticket_snapshot TEXT
  CHECK (ticket_snapshot IS NULL OR json_valid(ticket_snapshot));
`;
