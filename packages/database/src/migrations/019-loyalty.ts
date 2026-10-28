/**
 * Migration 19 — Loyalty & Rewards: viewer point balances, an auditable ledger, a reward catalog and redemptions.
 *
 * - loyalty_accounts: one balance per platform identity (platform, user_id). Discord and Kick identities are separate
 *   accounts: nothing links them. balance >= 0 is enforced by the database as well as by the service.
 * - loyalty_transactions: every balance change, with the balance after it. event_key is UNIQUE, so the same chat
 *   message, interaction or redemption can never award or charge twice (retries, reconnects, redelivered webhooks).
 *   SUM(amount) per account always equals its balance (both are written in one transaction).
 * - loyalty_rewards: the catalog. A removed reward is archived (archived_at), not deleted, so redemption history keeps
 *   pointing at it. Active reward names are unique (case-insensitive), so "!redeem <name>" is unambiguous.
 * - loyalty_redemptions: one row per redemption (pending → fulfilled or rejected), with the cost and reward name as
 *   they were at the time. request_key is UNIQUE (one redemption per chat message / interaction).
 * Settings live in app_settings ('loyalty.settings'). Giveaway tickets and Kick Channel Points are separate and
 * untouched. Additive: new tables only.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const LOYALTY_MIGRATION_SQL = `
CREATE TABLE loyalty_accounts (
  platform         TEXT NOT NULL CHECK (platform IN ('discord', 'kick')),
  user_id          TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 32),
  display_name     TEXT CHECK (display_name IS NULL OR length(display_name) <= 100),
  balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned  INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  last_earned_at   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (platform, user_id)
) STRICT;
CREATE INDEX loyalty_accounts_balance ON loyalty_accounts (balance DESC);

CREATE TABLE loyalty_transactions (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  platform       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  amount         INTEGER NOT NULL CHECK (amount <> 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  kind           TEXT NOT NULL CHECK (kind IN ('chat', 'adjustment', 'redemption', 'refund')),
  reason         TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  event_key      TEXT UNIQUE CHECK (event_key IS NULL OR length(event_key) BETWEEN 1 AND 200),
  redemption_id  TEXT CHECK (redemption_id IS NULL OR length(redemption_id) = 36),
  created_at     TEXT NOT NULL,
  FOREIGN KEY (platform, user_id) REFERENCES loyalty_accounts (platform, user_id)
) STRICT;
CREATE INDEX loyalty_transactions_account ON loyalty_transactions (platform, user_id, created_at DESC);
CREATE INDEX loyalty_transactions_created ON loyalty_transactions (created_at DESC);

CREATE TABLE loyalty_rewards (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description  TEXT CHECK (description IS NULL OR length(description) <= 200),
  cost         INTEGER NOT NULL CHECK (cost BETWEEN 1 AND 10000000),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  stock        INTEGER CHECK (stock IS NULL OR stock >= 0),
  archived_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX loyalty_rewards_name ON loyalty_rewards (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE loyalty_redemptions (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36),
  reward_id     TEXT NOT NULL REFERENCES loyalty_rewards (id),
  reward_name   TEXT NOT NULL CHECK (length(reward_name) BETWEEN 1 AND 40),
  platform      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  display_name  TEXT CHECK (display_name IS NULL OR length(display_name) <= 100),
  cost          INTEGER NOT NULL CHECK (cost >= 1),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'fulfilled', 'rejected')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 200),
  request_key   TEXT NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 200),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  FOREIGN KEY (platform, user_id) REFERENCES loyalty_accounts (platform, user_id)
) STRICT;
CREATE INDEX loyalty_redemptions_status ON loyalty_redemptions (status, created_at DESC);
`;
