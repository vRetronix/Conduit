import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type ConnectionPlatform = 'discord' | 'kick' | 'youtube' | 'twitch';
export type ConnectionRecordStatus = 'connected' | 'needs_reauth' | 'error';
/** primary: the streamer's own account (channel); bot: a separate account authorized for chatbot duties. */
export type ConnectionRole = 'primary' | 'bot';

export interface ConnectionRecord {
  id: string;
  platform: ConnectionPlatform;
  role: ConnectionRole;
  externalAccountId: string;
  accountName: string;
  accountHandle: string | null;
  avatarDataUrl: string | null;
  grantedScopes: string;
  status: ConnectionRecordStatus;
  lastError: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
  updatedAt: string;
}

/** Verified identity details written after a successful authorization or check. */
export interface ConnectionIdentity {
  accountName: string;
  accountHandle: string | null;
  avatarDataUrl: string | null;
}

const COLUMNS = `id, platform, role, external_account_id AS externalAccountId, account_name AS accountName,
  account_handle AS accountHandle, avatar_data_url AS avatarDataUrl,
  granted_scopes AS grantedScopes, status, last_error AS lastError, connected_at AS connectedAt,
  last_verified_at AS lastVerifiedAt, updated_at AS updatedAt`;

export const connectionsRepo = {
  /** All connections, oldest first within each platform. */
  list(db: Database): ConnectionRecord[] {
    return queryAll<ConnectionRecord>(db, `SELECT ${COLUMNS} FROM platform_connections ORDER BY platform, connected_at`);
  },

  listForPlatform(db: Database, platform: ConnectionPlatform): ConnectionRecord[] {
    return queryAll<ConnectionRecord>(db, `SELECT ${COLUMNS} FROM platform_connections WHERE platform = ? ORDER BY connected_at`, platform);
  },

  listForRole(db: Database, platform: ConnectionPlatform, role: ConnectionRole): ConnectionRecord[] {
    return queryAll<ConnectionRecord>(
      db,
      `SELECT ${COLUMNS} FROM platform_connections WHERE platform = ? AND role = ? ORDER BY connected_at`,
      platform,
      role,
    );
  },

  find(db: Database, platform: ConnectionPlatform, externalAccountId: string): ConnectionRecord | undefined {
    return queryOne<ConnectionRecord>(
      db,
      `SELECT ${COLUMNS} FROM platform_connections WHERE platform = ? AND external_account_id = ?`,
      platform,
      externalAccountId,
    );
  },

  /**
   * Records a verified connection: inserts it, or (re)connects an existing row for the same account, resetting its
   * status to connected. The role of an existing row is never changed here (callers refuse role conflicts first).
   */
  upsertVerified(
    db: Database,
    c: { id: string; platform: ConnectionPlatform; role?: ConnectionRole; externalAccountId: string; grantedScopes: string[]; now: string } & ConnectionIdentity,
  ): void {
    execute(
      db,
      `INSERT INTO platform_connections (id, platform, role, external_account_id, account_name, account_handle, avatar_data_url,
         granted_scopes, status, last_error, connected_at, last_verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?, ?)
       ON CONFLICT (platform, external_account_id) DO UPDATE SET
         account_name = excluded.account_name, account_handle = excluded.account_handle,
         avatar_data_url = excluded.avatar_data_url, granted_scopes = excluded.granted_scopes, status = 'connected',
         last_error = NULL, last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
      c.id,
      c.platform,
      c.role ?? 'primary',
      c.externalAccountId,
      c.accountName,
      c.accountHandle,
      c.avatarDataUrl,
      JSON.stringify(c.grantedScopes),
      c.now,
      c.now,
      c.now,
    );
  },

  /** A successful periodic check: refresh identity details and the verification time. */
  markVerified(db: Database, id: string, identity: ConnectionIdentity, now: string): void {
    execute(
      db,
      `UPDATE platform_connections SET account_name = ?, account_handle = ?, avatar_data_url = ?, status = 'connected',
         last_error = NULL, last_verified_at = ?, updated_at = ? WHERE id = ?`,
      identity.accountName,
      identity.accountHandle,
      identity.avatarDataUrl,
      now,
      now,
      id,
    );
  },

  markStatus(db: Database, id: string, status: Exclude<ConnectionRecordStatus, 'connected'>, lastError: string | null, now: string): void {
    execute(db, 'UPDATE platform_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', status, lastError, now, id);
  },

  remove(db: Database, id: string): void {
    execute(db, 'DELETE FROM platform_connections WHERE id = ?', id);
  },

  /** Removes every connection for a platform; returns the removed rows' ids. */
  removeForPlatform(db: Database, platform: ConnectionPlatform): string[] {
    const ids = queryAll<{ id: string }>(db, 'SELECT id FROM platform_connections WHERE platform = ?', platform).map((r) => r.id);
    execute(db, 'DELETE FROM platform_connections WHERE platform = ?', platform);
    return ids;
  },
};
