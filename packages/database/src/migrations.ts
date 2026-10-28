import type { Migration } from './migrate';
import { ACCOUNTS_MIGRATION_SQL } from './migrations/002-accounts';
import { MUST_CHANGE_PASSWORD_MIGRATION_SQL } from './migrations/003-must-change-password';
import { PLATFORM_CONNECTIONS_MIGRATION_SQL } from './migrations/004-platform-connections';
import { CONNECTION_PROFILE_MIGRATION_SQL } from './migrations/005-connection-profile';
import { DISCORD_SETUP_MIGRATION_SQL } from './migrations/006-discord-setup';
import { DISCORD_COMMANDS_MIGRATION_SQL } from './migrations/007-discord-commands';
import { CONNECTION_ROLES_MIGRATION_SQL } from './migrations/008-connection-roles';
import { CHAT_COMMANDS_MIGRATION_SQL } from './migrations/009-chat-commands';
import { COMMANDS_PLATFORMS_MIGRATION_SQL } from './migrations/010-commands-platforms';
import { COMMAND_ACCESS_MIGRATION_SQL } from './migrations/011-command-access';
import { GIVEAWAYS_MIGRATION_SQL } from './migrations/012-giveaways';
import { GIVEAWAY_DISCORD_MIGRATION_SQL } from './migrations/013-giveaway-discord';
import { GIVEAWAY_TICKETS_MIGRATION_SQL } from './migrations/014-giveaway-tickets';
import { MODERATION_MIGRATION_SQL } from './migrations/015-moderation';
import { AUTOMATIONS_MIGRATION_SQL } from './migrations/016-automations';
import { DISCORD_FEATURES_MIGRATION_SQL } from './migrations/017-discord-features';
import { TIMED_MESSAGE_COUNTS_MIGRATION_SQL } from './migrations/018-timed-message-counts';
import { LOYALTY_MIGRATION_SQL } from './migrations/019-loyalty';
import { LOYALTY_LEVELS_MIGRATION_SQL } from './migrations/020-loyalty-levels';
import { COMMAND_COUNTERS_MIGRATION_SQL } from './migrations/021-command-counters';
import { DISCORD_MODERATION_EVENTS_MIGRATION_SQL } from './migrations/022-discord-moderation-events';
import { DISCORD_PROTECTION_EVENTS_MIGRATION_SQL } from './migrations/023-discord-protection-events';
import { DISCORD_QUARANTINE_MIGRATION_SQL } from './migrations/024-discord-quarantine';
import { DISCORD_POSTED_MESSAGES_MIGRATION_SQL } from './migrations/025-discord-posted-messages';
import { DISCORD_LOG_ENTRIES_MIGRATION_SQL } from './migrations/026-discord-log-entries';
import { DISCORD_MESSAGE_TEXTS_MIGRATION_SQL } from './migrations/027-discord-message-texts';
import { KICK_CLIPS_MIGRATION_SQL } from './migrations/028-kick-clips';
import { KICK_MODERATION_MIGRATION_SQL } from './migrations/029-kick-moderation';

/**
 * The application's schema history. Append new migrations; never edit or reorder released ones
 * (the runner verifies checksums of applied migrations).
 *
 * Domain tables (users, streamer_profiles, commands, …) arrive with the phases that implement them.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'app_settings',
    up: `
      CREATE TABLE app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  { version: 2, name: 'accounts_profiles_sessions_audit', up: ACCOUNTS_MIGRATION_SQL },
  { version: 3, name: 'users_must_change_password', up: MUST_CHANGE_PASSWORD_MIGRATION_SQL },
  { version: 4, name: 'platform_connections', up: PLATFORM_CONNECTIONS_MIGRATION_SQL },
  { version: 5, name: 'connection_profile', up: CONNECTION_PROFILE_MIGRATION_SQL },
  { version: 6, name: 'discord_setup', up: DISCORD_SETUP_MIGRATION_SQL },
  { version: 7, name: 'discord_commands', up: DISCORD_COMMANDS_MIGRATION_SQL },
  { version: 8, name: 'connection_roles', up: CONNECTION_ROLES_MIGRATION_SQL },
  { version: 9, name: 'chat_commands', up: CHAT_COMMANDS_MIGRATION_SQL },
  { version: 10, name: 'commands_platforms', up: COMMANDS_PLATFORMS_MIGRATION_SQL },
  { version: 11, name: 'command_access', up: COMMAND_ACCESS_MIGRATION_SQL },
  { version: 12, name: 'giveaways', up: GIVEAWAYS_MIGRATION_SQL },
  { version: 13, name: 'giveaway_discord', up: GIVEAWAY_DISCORD_MIGRATION_SQL },
  { version: 14, name: 'giveaway_tickets', up: GIVEAWAY_TICKETS_MIGRATION_SQL },
  { version: 15, name: 'moderation', up: MODERATION_MIGRATION_SQL },
  { version: 16, name: 'automations', up: AUTOMATIONS_MIGRATION_SQL },
  { version: 17, name: 'discord_features', up: DISCORD_FEATURES_MIGRATION_SQL },
  { version: 18, name: 'timed_message_counts', up: TIMED_MESSAGE_COUNTS_MIGRATION_SQL },
  { version: 19, name: 'loyalty', up: LOYALTY_MIGRATION_SQL },
  { version: 20, name: 'loyalty_levels', up: LOYALTY_LEVELS_MIGRATION_SQL },
  { version: 21, name: 'command_counters', up: COMMAND_COUNTERS_MIGRATION_SQL },
  { version: 22, name: 'discord_moderation_events', up: DISCORD_MODERATION_EVENTS_MIGRATION_SQL },
  { version: 23, name: 'discord_protection_events', up: DISCORD_PROTECTION_EVENTS_MIGRATION_SQL },
  { version: 24, name: 'discord_quarantine', up: DISCORD_QUARANTINE_MIGRATION_SQL },
  { version: 25, name: 'discord_posted_messages', up: DISCORD_POSTED_MESSAGES_MIGRATION_SQL },
  { version: 26, name: 'discord_log_entries', up: DISCORD_LOG_ENTRIES_MIGRATION_SQL },
  { version: 27, name: 'discord_message_texts', up: DISCORD_MESSAGE_TEXTS_MIGRATION_SQL },
  { version: 28, name: 'kick_clips', up: KICK_CLIPS_MIGRATION_SQL },
  { version: 29, name: 'kick_moderation', up: KICK_MODERATION_MIGRATION_SQL },
];
