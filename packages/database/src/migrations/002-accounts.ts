/**
 * Migration 2 — user accounts, streamer profiles, memberships, sessions and the audit log (Phase 2).
 *
 * Invariants enforced here as a second line of defence behind the services:
 * - A profile always has exactly one owner: streamer_profiles.owner_user_id (NOT NULL, FK).
 * - The owner never also has a membership row, so membership roles are only 'admin' | 'member'.
 * - One membership per (profile, user).
 * - Only token hashes are stored for sessions; only Argon2id PHC strings for passwords.
 * - The audit log is append-only.
 *
 * Timestamps are UTC ISO-8601 strings with milliseconds, which sort correctly as text.
 * NEVER edit this SQL after release — add a new migration instead (checksums are verified at startup).
 */
export const ACCOUNTS_MIGRATION_SQL = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  system_role   TEXT NOT NULL DEFAULT 'user' CHECK (system_role IN ('admin', 'user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
) STRICT;

CREATE TABLE streamer_profiles (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  bot_display_name TEXT NOT NULL,
  command_prefix   TEXT NOT NULL DEFAULT '!',
  accent_color     TEXT NOT NULL DEFAULT '#7c5cff'
                     CHECK (length(accent_color) = 7 AND accent_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX streamer_profiles_owner ON streamer_profiles(owner_user_id);

CREATE TABLE profile_memberships (
  profile_id TEXT NOT NULL REFERENCES streamer_profiles(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  added_by   TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX profile_memberships_user ON profile_memberships(user_id);

CREATE TRIGGER profile_memberships_owner_insert
BEFORE INSERT ON profile_memberships
WHEN NEW.user_id = (SELECT owner_user_id FROM streamer_profiles WHERE id = NEW.profile_id)
BEGIN
  SELECT RAISE(ABORT, 'the profile owner cannot also hold a membership');
END;

CREATE TRIGGER streamer_profiles_owner_change
BEFORE UPDATE OF owner_user_id ON streamer_profiles
WHEN EXISTS (SELECT 1 FROM profile_memberships WHERE profile_id = NEW.id AND user_id = NEW.owner_user_id)
BEGIN
  SELECT RAISE(ABORT, 'remove the new owner''s membership before transferring ownership');
END;

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name    TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  revoked_at     TEXT,
  revoked_reason TEXT
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT NOT NULL,
  action         TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  actor_user_id  TEXT,
  target_user_id TEXT,
  profile_id     TEXT,
  session_id     TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
) STRICT;
CREATE INDEX audit_logs_occurred ON audit_logs(occurred_at);
CREATE INDEX audit_logs_actor ON audit_logs(actor_user_id, occurred_at);
CREATE INDEX audit_logs_profile ON audit_logs(profile_id, occurred_at);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
`;
