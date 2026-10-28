import { execute, queryAll, queryOne, withTransaction, type Database } from '../sqlite';

export interface DiscordApplicationRecord {
  applicationId: string;
  applicationName: string | null;
  botUserId: string | null;
  botUsername: string | null;
  validatedAt: string;
  updatedAt: string;
}

export interface DiscordGuildRecord {
  guildId: string;
  guildName: string;
  verifiedAt: string;
}

export const discordRepo = {
  getApplication(db: Database): DiscordApplicationRecord | undefined {
    return queryOne<DiscordApplicationRecord>(
      db,
      `SELECT application_id AS applicationId, application_name AS applicationName, bot_user_id AS botUserId,
              bot_username AS botUsername, validated_at AS validatedAt, updated_at AS updatedAt
         FROM discord_application WHERE id = 1`,
    );
  },

  saveApplication(db: Database, a: Omit<DiscordApplicationRecord, 'updatedAt'> & { now: string }): void {
    execute(
      db,
      `INSERT INTO discord_application (id, application_id, application_name, bot_user_id, bot_username, validated_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET application_id = excluded.application_id, application_name = excluded.application_name,
         bot_user_id = excluded.bot_user_id, bot_username = excluded.bot_username, validated_at = excluded.validated_at,
         updated_at = excluded.updated_at`,
      a.applicationId,
      a.applicationName,
      a.botUserId,
      a.botUsername,
      a.validatedAt,
      a.now,
    );
  },

  deleteApplication(db: Database): void {
    execute(db, 'DELETE FROM discord_application');
  },

  listGuilds(db: Database): DiscordGuildRecord[] {
    return queryAll<DiscordGuildRecord>(
      db,
      'SELECT guild_id AS guildId, guild_name AS guildName, verified_at AS verifiedAt FROM discord_guild_installations ORDER BY guild_name COLLATE NOCASE',
    );
  },

  /** Replaces the verified installation list with what Discord reported. */
  replaceGuilds(db: Database, guilds: Array<{ id: string; name: string }>, now: string): void {
    withTransaction(db, () => {
      execute(db, 'DELETE FROM discord_guild_installations');
      for (const g of guilds) {
        execute(db, 'INSERT INTO discord_guild_installations (guild_id, guild_name, verified_at) VALUES (?, ?, ?)', g.id, g.name.slice(0, 100), now);
      }
    });
  },
};
