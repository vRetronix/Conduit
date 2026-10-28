/**
 * Migration 17 — Timed Messages, Sticky Messages, Stream Notifications, saved embeds and Discord log deduplication.
 *
 * - saved_embeds: the embed library (name + validated embed JSON), reusable by every feature.
 * - timed_messages: a message posted every N minutes and/or after N chat messages (config JSON) with its last post time
 *   and recent results.
 * - sticky_messages: one sticky per Discord channel (UNIQUE channel_id) with the message currently posted, so restarts
 *   never post a second copy.
 * - stream_notifiers: a streamer → Discord destination, with the live session (Kick's stream start time) and the
 *   message posted for it (and the channel it was posted in), so a session is announced once and its own message is
 *   the one deleted when the stream ends.
 * - discord_log_events: keys of events already logged (pruned after 7 days), so a repeated gateway event is logged once.
 * The Phase 11 automations tables are left as they are (their data is kept; the feature is retired).
 * Additive: new tables only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_FEATURES_MIGRATION_SQL = `
CREATE TABLE saved_embeds (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  embed       TEXT NOT NULL CHECK (length(embed) <= 20000 AND json_valid(embed)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE timed_messages (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36),
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config        TEXT NOT NULL CHECK (length(config) <= 30000 AND json_valid(config)),
  last_sent_at  TEXT,
  enabled_at    TEXT,
  recent        TEXT NOT NULL DEFAULT '[]' CHECK (length(recent) <= 8000 AND json_valid(recent)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE sticky_messages (
  id                 TEXT PRIMARY KEY CHECK (length(id) = 36),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  guild_id           TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 25),
  channel_id         TEXT NOT NULL UNIQUE CHECK (length(channel_id) BETWEEN 1 AND 25),
  config             TEXT NOT NULL CHECK (length(config) <= 30000 AND json_valid(config)),
  posted_message_id  TEXT CHECK (posted_message_id IS NULL OR length(posted_message_id) BETWEEN 1 AND 25),
  last_posted_at     TEXT,
  problem            TEXT CHECK (problem IS NULL OR length(problem) <= 300),
  recent             TEXT NOT NULL DEFAULT '[]' CHECK (length(recent) <= 8000 AND json_valid(recent)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;

CREATE TABLE stream_notifiers (
  id                   TEXT PRIMARY KEY CHECK (length(id) = 36),
  platform             TEXT NOT NULL CHECK (platform IN ('kick', 'twitch', 'youtube')),
  channel_slug         TEXT NOT NULL CHECK (length(channel_slug) BETWEEN 1 AND 100),
  discord_channel_id   TEXT NOT NULL CHECK (length(discord_channel_id) BETWEEN 1 AND 25),
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config               TEXT NOT NULL CHECK (length(config) <= 30000 AND json_valid(config)),
  broadcaster_id       TEXT CHECK (broadcaster_id IS NULL OR length(broadcaster_id) <= 32),
  display_name         TEXT CHECK (display_name IS NULL OR length(display_name) <= 100),
  avatar_url           TEXT CHECK (avatar_url IS NULL OR length(avatar_url) <= 2048),
  live                 INTEGER CHECK (live IS NULL OR live IN (0, 1)),
  session_key          TEXT CHECK (session_key IS NULL OR length(session_key) <= 100),
  live_since           TEXT,
  title                TEXT CHECK (title IS NULL OR length(title) <= 300),
  category             TEXT CHECK (category IS NULL OR length(category) <= 200),
  last_checked_at      TEXT,
  message_id           TEXT CHECK (message_id IS NULL OR length(message_id) <= 25),
  message_channel_id   TEXT CHECK (message_channel_id IS NULL OR length(message_channel_id) <= 25),
  notify_attempts      INTEGER NOT NULL DEFAULT 0,
  last_notified_at     TEXT,
  status               TEXT CHECK (status IS NULL OR length(status) <= 300),
  problem              TEXT CHECK (problem IS NULL OR length(problem) <= 300),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (platform, channel_slug, discord_channel_id)
) STRICT;

CREATE TABLE discord_log_events (
  event_key   TEXT PRIMARY KEY CHECK (length(event_key) BETWEEN 1 AND 200),
  created_at  TEXT NOT NULL
) STRICT;
`;
