import { execute, queryAll, type Database } from '../sqlite';

export interface CommandRegistrationRecord {
  guildId: string;
  applicationId: string;
  commandsHash: string;
  status: 'registered' | 'failed';
  registeredAt: string | null;
  lastAttemptAt: string;
  lastError: string | null;
}

export const discordCommandsRepo = {
  list(db: Database): CommandRegistrationRecord[] {
    return queryAll<CommandRegistrationRecord>(
      db,
      `SELECT guild_id AS guildId, application_id AS applicationId, commands_hash AS commandsHash, status,
              registered_at AS registeredAt, last_attempt_at AS lastAttemptAt, last_error AS lastError
         FROM discord_command_registrations ORDER BY guild_id`,
    );
  },

  upsert(db: Database, r: CommandRegistrationRecord): void {
    execute(
      db,
      `INSERT INTO discord_command_registrations (guild_id, application_id, commands_hash, status, registered_at, last_attempt_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET application_id = excluded.application_id, commands_hash = excluded.commands_hash,
         status = excluded.status, registered_at = excluded.registered_at, last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error`,
      r.guildId,
      r.applicationId,
      r.commandsHash,
      r.status,
      r.registeredAt,
      r.lastAttemptAt,
      r.lastError === null ? null : r.lastError.slice(0, 500),
    );
  },

  remove(db: Database, guildId: string): void {
    execute(db, 'DELETE FROM discord_command_registrations WHERE guild_id = ?', guildId);
  },

  clear(db: Database): void {
    execute(db, 'DELETE FROM discord_command_registrations');
  },
};
