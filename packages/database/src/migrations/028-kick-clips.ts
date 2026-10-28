/**
 * Migration 28 — Kick clips of the streamer's channel, as Kick's website lists them, kept so Kick → Clips can list
 * them, and where each was saved on this PC and posted in Discord.
 * Additive: a new table only. NEVER edit this SQL after release — add a new migration instead.
 */
export const KICK_CLIPS_MIGRATION_SQL = `
CREATE TABLE kick_clips (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'clip_*' AND length(id) BETWEEN 6 AND 64),
  channel_slug        TEXT NOT NULL CHECK (length(channel_slug) BETWEEN 1 AND 64),
  title               TEXT NOT NULL CHECK (length(title) <= 200),
  creator_name        TEXT CHECK (creator_name IS NULL OR length(creator_name) <= 64),
  category            TEXT CHECK (category IS NULL OR length(category) <= 100),
  duration_seconds    INTEGER NOT NULL CHECK (duration_seconds BETWEEN 0 AND 3600),
  views               INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  thumbnail_url       TEXT CHECK (thumbnail_url IS NULL OR length(thumbnail_url) <= 500),
  video_url           TEXT NOT NULL CHECK (length(video_url) <= 500),
  vod_id              TEXT CHECK (vod_id IS NULL OR length(vod_id) <= 64),
  created_at          TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,
  saved_path          TEXT CHECK (saved_path IS NULL OR length(saved_path) <= 1000),
  saved_at            TEXT,
  discord_channel_id  TEXT CHECK (discord_channel_id IS NULL OR length(discord_channel_id) BETWEEN 1 AND 32),
  discord_message_id  TEXT CHECK (discord_message_id IS NULL OR length(discord_message_id) BETWEEN 1 AND 32),
  posted_at           TEXT,
  post_problem        TEXT CHECK (post_problem IS NULL OR length(post_problem) <= 300)
) STRICT;
CREATE INDEX kick_clips_created ON kick_clips (created_at DESC);
`;
