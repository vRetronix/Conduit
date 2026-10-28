import { execute, queryAll, queryOne, type Database } from '../sqlite';

export interface SessionRecord {
  id: string;
  userId: string;
  clientName: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

const COLUMNS = `id, user_id AS userId, client_name AS clientName, created_at AS createdAt, expires_at AS expiresAt,
  last_seen_at AS lastSeenAt, revoked_at AS revokedAt, revoked_reason AS revokedReason`;

export const sessionsRepo = {
  insert(
    db: Database,
    s: { id: string; tokenHash: string; userId: string; clientName: string | null; now: string; expiresAt: string },
  ): void {
    execute(
      db,
      `INSERT INTO sessions (id, token_hash, user_id, client_name, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.tokenHash,
      s.userId,
      s.clientName,
      s.now,
      s.expiresAt,
      s.now,
    );
  },

  findByTokenHash(db: Database, tokenHash: string): SessionRecord | undefined {
    return queryOne<SessionRecord>(db, `SELECT ${COLUMNS} FROM sessions WHERE token_hash = ?`, tokenHash);
  },

  findById(db: Database, id: string): SessionRecord | undefined {
    return queryOne<SessionRecord>(db, `SELECT ${COLUMNS} FROM sessions WHERE id = ?`, id);
  },

  /** Unrevoked, unexpired sessions of a user, newest first. */
  listActiveForUser(db: Database, userId: string, now: string): SessionRecord[] {
    return queryAll<SessionRecord>(
      db,
      `SELECT ${COLUMNS} FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      userId,
      now,
    );
  },

  touch(db: Database, id: string, now: string): void {
    execute(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', now, id);
  },

  revoke(db: Database, id: string, reason: string, now: string): number {
    return execute(
      db,
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
      now,
      reason,
      id,
    );
  },

  /** Revokes every active session of a user except `exceptId`; returns the revoked session IDs. */
  revokeAllForUser(db: Database, userId: string, reason: string, now: string, exceptId: string | null = null): string[] {
    const ids = queryAll<{ id: string }>(
      db,
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?',
      userId,
      exceptId,
    ).map((r) => r.id);
    execute(
      db,
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?',
      now,
      reason,
      userId,
      exceptId,
    );
    return ids;
  },

  /** Deletes sessions that expired, or were revoked, before `cutoff`. */
  deleteStale(db: Database, cutoff: string): number {
    return execute(db, 'DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', cutoff, cutoff);
  },
};
