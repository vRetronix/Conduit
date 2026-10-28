import { execute, queryOne, type Database } from '../sqlite';

export const SETTING_KEYS = {
  /** Written exactly once by first-run setup. Its PRIMARY KEY makes a second setup impossible at the database level. */
  setupCompletedAt: 'setup_completed_at',
  /** The user's own Kick developer app Client ID (not secret; the Client Secret is in the encrypted vault). */
  kickClientId: 'kick.client_id',
  /** Which Kick account CONDUIT's chatbot uses: 'primary' (the streamer's account) or 'separate' (a bot account). */
  kickChatbotAccount: 'kick.chatbot_account',
  /** The Discord channel last used for a giveaway announcement (JSON {guildId, channelId}), preselected for new ones. */
  giveawayDiscordChannel: 'giveaways.discord_channel',
  /** Edited Kick giveaway chat messages (JSON {kind: template}; a missing kind uses its default). */
  giveawayKickMessages: 'giveaways.kick_messages',
  /** Automated chat protection settings (JSON, see automodSettingsSchema); unset: off, log-only defaults. */
  automodSettings: 'moderation.automod',
  /** Loyalty & Rewards settings (JSON, see loyaltySettingsSchema); unset: off, with defaults. */
  loyaltySettings: 'loyalty.settings',
  /** Settings → Appearance & Themes (JSON, see appearanceSchema); unset: CONDUIT Default. */
  appearance: 'appearance',
  /** Commands → Discord → Command Permissions (JSON, see commandAccessSchema); unset: every command at its default group. */
  discordCommandAccess: 'discord.command_access',
  /** Commands → Kick → Default Commands (JSON, see kickDefaultCommandSettingsSchema); unset: all on. */
  kickDefaultCommands: 'kick.default_commands',
  /** The Discord bot's presence (JSON, see presenceSchema); unset: Discord's default (online, no activity). */
  discordPresence: 'discord.presence',
  /** CONDUIT's Discord message checks (JSON, see messageChecksSchema); unset: off, log-only defaults. */
  discordMessageChecks: 'discord.protection.messages',
  /** CONDUIT's own AutoMod rules, every server's (JSON array, see automodRuleSchema); unset: none. */
  discordAutomodRules: 'discord.protection.automod_rules',
  discordAntinuke: 'discord.protection.antinuke',
  discordAntiraid: 'discord.protection.antiraid',
  discordBotbait: 'discord.protection.botbait',
  /** Lockdowns in effect, with what to restore when they lift. */
  discordLockdowns: 'discord.protection.lockdowns',
} as const;

export const settingsRepo = {
  get(db: Database, key: string): string | undefined {
    return queryOne<{ value: string }>(db, 'SELECT value FROM app_settings WHERE key = ?', key)?.value;
  },

  /** Inserts or replaces a key. */
  set(db: Database, key: string, value: string, now: string): void {
    execute(
      db,
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      now,
    );
  },

  delete(db: Database, key: string): void {
    execute(db, 'DELETE FROM app_settings WHERE key = ?', key);
  },

  /** Inserts a new key; throws (constraint violation) if it already exists. */
  insert(db: Database, key: string, value: string, now: string): void {
    execute(db, 'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)', key, value, now);
  },
};
