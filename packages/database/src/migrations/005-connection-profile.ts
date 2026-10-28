/**
 * Migration 5 — display metadata for platform connections (Phase 3).
 *
 * Non-secret only: the account handle (e.g. Discord username) and a small avatar image as a data: URL, so the
 * renderer can show it without loading remote images. Tokens are never stored in the database; they live in the
 * desktop's DPAPI-encrypted credential vault. NEVER edit this SQL after release — add a new migration instead.
 */
export const CONNECTION_PROFILE_MIGRATION_SQL = `
ALTER TABLE platform_connections ADD COLUMN account_handle TEXT;
ALTER TABLE platform_connections ADD COLUMN avatar_data_url TEXT
  CHECK (avatar_data_url IS NULL OR (length(avatar_data_url) <= 200000 AND avatar_data_url LIKE 'data:image/%'));
`;
