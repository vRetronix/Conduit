/**
 * Migration 3 — persistent "must change password" flag (Phase 2.2).
 *
 * Set when an account's password was set by someone other than its owner through offline administrator recovery.
 * While set, the account may only read its session, change its password, and sign out. Existing accounts get 0.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const MUST_CHANGE_PASSWORD_MIGRATION_SQL = `
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
`;
