import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type ChatCommandPlatform = 'kick' | 'discord';
export type ChatCommandPermission = 'everyone' | 'subscriber' | 'moderator' | 'broadcaster';
export type ChatCommandCooldownMode = 'none' | 'user' | 'global';

export interface ChatCommandRecord {
  id: string;
  platform: ChatCommandPlatform;
  /** Normalized, lower case: "!name" (Kick) or "/name" (Discord). */
  trigger: string;
  /** Discord slash-command description; null for Kick. */
  description: string | null;
  response: string;
  enabled: boolean;
  permission: ChatCommandPermission;
  cooldownMode: ChatCommandCooldownMode;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, platform, trigger, description, response, enabled, permission, cooldown_mode AS cooldownMode,
  cooldown_seconds AS cooldownSeconds, created_at AS createdAt, updated_at AS updatedAt`;

type Row = Omit<ChatCommandRecord, 'enabled'> & { enabled: number };
const toRecord = (r: Row): ChatCommandRecord => ({ ...r, enabled: r.enabled === 1 });

export const chatCommandsRepo = {
  list(db: Database, platform: ChatCommandPlatform): ChatCommandRecord[] {
    return queryAll<Row>(db, `SELECT ${COLUMNS} FROM chat_commands WHERE platform = ? ORDER BY trigger`, platform).map(toRecord);
  },

  get(db: Database, id: string): ChatCommandRecord | undefined {
    const r = queryOne<Row>(db, `SELECT ${COLUMNS} FROM chat_commands WHERE id = ?`, id);
    return r ? toRecord(r) : undefined;
  },

  findByTrigger(db: Database, platform: ChatCommandPlatform, trigger: string): ChatCommandRecord | undefined {
    const r = queryOne<Row>(db, `SELECT ${COLUMNS} FROM chat_commands WHERE platform = ? AND trigger = ?`, platform, trigger);
    return r ? toRecord(r) : undefined;
  },

  insert(db: Database, c: ChatCommandRecord): void {
    execute(
      db,
      `INSERT INTO chat_commands (id, platform, trigger, description, response, enabled, permission, cooldown_mode, cooldown_seconds,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.platform,
      c.trigger,
      c.description,
      c.response,
      c.enabled ? 1 : 0,
      c.permission,
      c.cooldownMode,
      c.cooldownSeconds,
      c.createdAt,
      c.updatedAt,
    );
  },

  update(
    db: Database,
    id: string,
    patch: Omit<ChatCommandRecord, 'id' | 'platform' | 'createdAt'>,
  ): void {
    execute(
      db,
      `UPDATE chat_commands SET trigger = ?, description = ?, response = ?, enabled = ?, permission = ?, cooldown_mode = ?,
         cooldown_seconds = ?, updated_at = ? WHERE id = ?`,
      patch.trigger,
      patch.description,
      patch.response,
      patch.enabled ? 1 : 0,
      patch.permission,
      patch.cooldownMode,
      patch.cooldownSeconds,
      patch.updatedAt,
      id,
    );
  },

  remove(db: Database, id: string): boolean {
    const before = queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_commands WHERE id = ?', id)?.n ?? 0;
    execute(db, 'DELETE FROM chat_commands WHERE id = ?', id);
    return before > 0;
  },
};
