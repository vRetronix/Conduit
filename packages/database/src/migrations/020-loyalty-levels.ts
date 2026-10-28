/**
 * Migration 20 — Discord XP and levels for Loyalty & Rewards (separate from spendable points).
 *
 * - loyalty_levels: one row per Discord server and member (guild_id, user_id), so servers never share progress and a
 *   member who leaves and rejoins keeps theirs. xp >= 0; level is stored with it (always recalculated from xp by the
 *   service in the same transaction). announced_level is the highest level already announced, so a retry or restart
 *   never announces a level twice. last_content_hash is a fingerprint (never the text) of the last message that earned
 *   XP, for repeat detection when the Message Content intent is in use.
 * - loyalty_xp_events: every XP change (message, adjustment) with the XP and level after it. event_key is UNIQUE (the
 *   Discord message id), so a redelivered message never earns twice.
 * - loyalty_role_rewards: a role given at a level, per server (a role belongs to one milestone).
 * - loyalty_role_grants: what happened when a role reward was given to a member (granted / failed and why), so roles
 *   already given aren't requested again and failures can be looked into.
 * The points tables from migration 19 (balances, ledger, rewards, redemptions) are unchanged: points and XP are
 * separate. Existing rows — including any Kick-originated points history, which keeps its platform — are untouched.
 * Additive: new tables only. NEVER edit this SQL after release — add a new migration instead.
 */
export const LOYALTY_LEVELS_MIGRATION_SQL = `
CREATE TABLE loyalty_levels (
  guild_id           TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 25),
  user_id            TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 25),
  display_name       TEXT CHECK (display_name IS NULL OR length(display_name) <= 100),
  xp                 INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level              INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  announced_level    INTEGER NOT NULL DEFAULT 0 CHECK (announced_level >= 0),
  last_xp_at         TEXT,
  last_content_hash  TEXT CHECK (last_content_hash IS NULL OR length(last_content_hash) <= 64),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) STRICT;
CREATE INDEX loyalty_levels_rank ON loyalty_levels (guild_id, xp DESC);

CREATE TABLE loyalty_xp_events (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount <> 0),
  xp_after     INTEGER NOT NULL CHECK (xp_after >= 0),
  level_after  INTEGER NOT NULL CHECK (level_after >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('message', 'adjustment')),
  reason       TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  event_key    TEXT UNIQUE CHECK (event_key IS NULL OR length(event_key) BETWEEN 1 AND 200),
  created_at   TEXT NOT NULL,
  FOREIGN KEY (guild_id, user_id) REFERENCES loyalty_levels (guild_id, user_id)
) STRICT;
CREATE INDEX loyalty_xp_events_member ON loyalty_xp_events (guild_id, user_id, created_at DESC);
CREATE INDEX loyalty_xp_events_created ON loyalty_xp_events (created_at DESC);

CREATE TABLE loyalty_role_rewards (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  guild_id    TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 25),
  level       INTEGER NOT NULL CHECK (level BETWEEN 1 AND 1000),
  role_id     TEXT NOT NULL CHECK (length(role_id) BETWEEN 1 AND 25),
  created_at  TEXT NOT NULL,
  UNIQUE (guild_id, role_id)
) STRICT;
CREATE INDEX loyalty_role_rewards_level ON loyalty_role_rewards (guild_id, level);

CREATE TABLE loyalty_role_grants (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL CHECK (length(role_id) BETWEEN 1 AND 25),
  level       INTEGER NOT NULL CHECK (level >= 1),
  status      TEXT NOT NULL CHECK (status IN ('granted', 'failed')),
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  attempts    INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
) STRICT;
CREATE INDEX loyalty_role_grants_status ON loyalty_role_grants (status, updated_at DESC);
`;
