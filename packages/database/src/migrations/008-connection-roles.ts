/**
 * Migration 8 — connection roles.
 *
 * A platform can now have two kinds of connected account:
 * - primary: the streamer's own account (the channel). Every existing row is one, so it is the default.
 * - bot: a separate account the streamer authorized for chatbot duties (Kick, optionally).
 * Roles are stored per row so connecting, refreshing or disconnecting one account never touches the other.
 * Tokens stay in the encrypted vault, keyed by row id. NEVER edit this SQL after release — add a new migration instead.
 */
export const CONNECTION_ROLES_MIGRATION_SQL = `
ALTER TABLE platform_connections ADD COLUMN role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'bot'));
CREATE INDEX platform_connections_platform_role ON platform_connections(platform, role);
`;
