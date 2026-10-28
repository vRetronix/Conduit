/**
 * Migration 29 — Kick moderation, wider.
 *
 * 1. moderation_actions accepts more:
 *    - rule: Kick protection's new checks (caps, links, emotes, long_message, symbols) and raid mode (raid);
 *    - source 'platform': moderation done on Kick itself (Kick's own buttons, or another bot), from Kick's signed
 *      moderation.banned events, so the Logs show it next to CONDUIT's own.
 *    SQLite can't change a CHECK constraint in place, so the table is rebuilt: a new table with the wider rules, every
 *    existing row copied unchanged, then swapped in (with its indexes). The runner wraps this in one transaction.
 * 2. kick_chatters: who has chatted in the main channel before (Kick user id, name, first and last time), so raid mode
 *    can tell a burst of first-time chatters from regulars, also across restarts. No message text is kept.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const KICK_MODERATION_MIGRATION_SQL = `
CREATE TABLE moderation_actions_v29 (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),
  created_at       TEXT NOT NULL,
  platform         TEXT NOT NULL CHECK (platform IN ('discord', 'kick')),
  place_id         TEXT CHECK (place_id IS NULL OR length(place_id) BETWEEN 1 AND 32),
  place_name       TEXT CHECK (place_name IS NULL OR length(place_name) <= 100),
  action           TEXT NOT NULL CHECK (action IN ('timeout', 'untimeout', 'ban', 'unban', 'delete_message', 'flag')),
  target_user_id   TEXT NOT NULL CHECK (length(target_user_id) BETWEEN 1 AND 32),
  target_name      TEXT CHECK (target_name IS NULL OR length(target_name) <= 100),
  message_id       TEXT CHECK (message_id IS NULL OR length(message_id) <= 64),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 2419200),
  reason           TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  source           TEXT NOT NULL CHECK (source IN ('manual', 'automod', 'platform')),
  actor            TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  rule             TEXT CHECK (rule IS NULL OR rule IN ('blocked_terms', 'repeat', 'spam', 'caps', 'links', 'emotes', 'long_message', 'symbols', 'raid')),
  outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'logged')),
  detail           TEXT CHECK (detail IS NULL OR length(detail) <= 300)
) STRICT;

INSERT INTO moderation_actions_v29 (id, created_at, platform, place_id, place_name, action, target_user_id, target_name, message_id, duration_seconds, reason, source, actor, rule, outcome, detail)
  SELECT id, created_at, platform, place_id, place_name, action, target_user_id, target_name, message_id, duration_seconds, reason, source, actor, rule, outcome, detail
  FROM moderation_actions;

DROP TABLE moderation_actions;
ALTER TABLE moderation_actions_v29 RENAME TO moderation_actions;
CREATE INDEX moderation_actions_created ON moderation_actions (created_at DESC);
CREATE INDEX moderation_actions_target ON moderation_actions (platform, target_user_id);

CREATE TABLE kick_chatters (
  user_id        TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 32),
  username       TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
) STRICT;
`;
