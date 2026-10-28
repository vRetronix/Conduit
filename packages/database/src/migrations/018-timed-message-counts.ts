/**
 * Migration 18 — timed-message chat counters are stored, so they survive restarts.
 *
 * - timed_messages.messages_since: chat messages from people counted towards the "after N messages" interval since the
 *   last post. Increments are single UPDATE statements (never read-modify-write), and a successful post subtracts the
 *   count it was triggered with, so messages that arrive while it is being sent are kept for the next interval.
 * Existing rows start at 0 (the count used to live in memory only, so there is nothing to carry over).
 * Additive: one column with a default; existing rows are otherwise untouched.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const TIMED_MESSAGE_COUNTS_MIGRATION_SQL = `
ALTER TABLE timed_messages ADD COLUMN messages_since INTEGER NOT NULL DEFAULT 0 CHECK (messages_since >= 0);
`;
