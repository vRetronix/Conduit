/**
 * Migration 13 — Discord giveaway announcements and reaction entries.
 *
 * - giveaways gains the chosen Discord channel (guild and channel ids, a name snapshot for display) and the posted
 *   announcement's message id, with the outcome of the latest post or update, so the same message can be updated after
 *   a restart. A message belongs to at most one giveaway.
 * - giveaway_entries gains how the entry was made ('chat' = Kick !enter, 'command' = Discord /enter, 'reaction' =
 *   Discord 🎉). Removing the reaction removes only a reaction entry. Existing rows keep NULL (made before this).
 * Columns are added with ALTER TABLE ADD COLUMN; existing rows are untouched.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const GIVEAWAY_DISCORD_MIGRATION_SQL = `
ALTER TABLE giveaways ADD COLUMN discord_guild_id TEXT
  CHECK (discord_guild_id IS NULL OR (length(discord_guild_id) BETWEEN 1 AND 25 AND discord_guild_id NOT GLOB '*[^0-9]*'));
ALTER TABLE giveaways ADD COLUMN discord_channel_id TEXT
  CHECK (discord_channel_id IS NULL OR (length(discord_channel_id) BETWEEN 1 AND 25 AND discord_channel_id NOT GLOB '*[^0-9]*'));
ALTER TABLE giveaways ADD COLUMN discord_channel_name TEXT
  CHECK (discord_channel_name IS NULL OR length(discord_channel_name) BETWEEN 1 AND 100);
ALTER TABLE giveaways ADD COLUMN discord_message_id TEXT
  CHECK (discord_message_id IS NULL OR (length(discord_message_id) BETWEEN 1 AND 25 AND discord_message_id NOT GLOB '*[^0-9]*'));
ALTER TABLE giveaways ADD COLUMN discord_status TEXT
  CHECK (discord_status IS NULL OR discord_status IN ('posted', 'failed', 'missing'));
ALTER TABLE giveaways ADD COLUMN discord_detail TEXT
  CHECK (discord_detail IS NULL OR length(discord_detail) <= 300);
ALTER TABLE giveaways ADD COLUMN discord_updated_at TEXT;

CREATE UNIQUE INDEX giveaways_discord_message ON giveaways (discord_message_id) WHERE discord_message_id IS NOT NULL;

ALTER TABLE giveaway_entries ADD COLUMN source TEXT
  CHECK (source IS NULL OR source IN ('chat', 'command', 'reaction'));
`;
