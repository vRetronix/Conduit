/**
 * Migration 23 — what CONDUIT's own Discord protection noticed or did: message checks (repeats, flooding, caps,
 * invites), and later anti-nuke, anti-raid, the join gate and bot-bait. Shown in Discord Bot → Logs. (Discord's own
 * AutoMod is logged from the audit log in discord_moderation_events.)
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const DISCORD_PROTECTION_EVENTS_MIGRATION_SQL = `
CREATE TABLE discord_protection_events (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  created_at  TEXT NOT NULL,
  guild_id    TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 32),
  feature     TEXT NOT NULL CHECK (feature IN ('message', 'antinuke', 'antiraid', 'joingate', 'botbait')),
  rule        TEXT NOT NULL CHECK (length(rule) BETWEEN 1 AND 40),
  user_id     TEXT CHECK (user_id IS NULL OR length(user_id) BETWEEN 1 AND 32),
  user_name   TEXT CHECK (user_name IS NULL OR length(user_name) <= 100),
  channel_id  TEXT CHECK (channel_id IS NULL OR length(channel_id) BETWEEN 1 AND 32),
  action      TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  outcome     TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'logged')),
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 300)
) STRICT;
CREATE INDEX discord_protection_events_created ON discord_protection_events (created_at DESC);
`;
