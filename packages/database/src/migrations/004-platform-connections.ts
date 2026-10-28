/**
 * Migration 4 — platform connections (Phase 2.3).
 *
 * One row per authorized platform account of the streamer (Discord, Kick, YouTube, Twitch). Rows are written
 * only by a real, verified authorization flow; none exists yet, so the table starts empty.
 *
 * Deliberately NOT stored here:
 * - OAuth access/refresh tokens. They will live in an encrypted credential store, separate from this table.
 * - Bot identities (the account CONDUIT speaks as in chat) — a separate entity.
 * - Discord bot installations in servers — a separate grant, never implied by a Discord user connection.
 *
 * Scoping to a particular streamer configuration will be added by a later migration when multi-streamer support
 * is designed. NEVER edit this SQL after release — add a new migration instead.
 */
export const PLATFORM_CONNECTIONS_MIGRATION_SQL = `
CREATE TABLE platform_connections (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL CHECK (platform IN ('discord', 'kick', 'youtube', 'twitch')),
  external_account_id TEXT NOT NULL,
  account_name        TEXT NOT NULL,
  granted_scopes      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes)),
  status              TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'error')),
  last_error          TEXT,
  connected_at        TEXT NOT NULL,
  last_verified_at    TEXT,
  updated_at          TEXT NOT NULL,
  UNIQUE (platform, external_account_id)
) STRICT;
CREATE INDEX platform_connections_platform ON platform_connections(platform);
`;
