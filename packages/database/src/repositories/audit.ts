import { execute, queryAll, type Database } from '../sqlite';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  targetUserId?: string | null;
  profileId?: string | null;
  sessionId?: string | null;
  /** Small, non-sensitive structured context. Callers must never include secrets. */
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: number;
  occurredAt: string;
  action: string;
  outcome: AuditOutcome;
  actorUserId: string | null;
  targetUserId: string | null;
  profileId: string | null;
  sessionId: string | null;
  metadata: string;
}

export const auditRepo = {
  insert(db: Database, entry: AuditEntry, now: string): void {
    execute(
      db,
      `INSERT INTO audit_logs (occurred_at, action, outcome, actor_user_id, target_user_id, profile_id, session_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      now,
      entry.action,
      entry.outcome,
      entry.actorUserId ?? null,
      entry.targetUserId ?? null,
      entry.profileId ?? null,
      entry.sessionId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    );
  },

  /**
   * Failed logins since `sinceIso`, oldest first, with the username (for existing accounts) and whether the
   * account's failure count was cleared afterwards (successful login, password change, admin reset or recovery).
   * Used to rebuild in-memory rate-limit windows after a restart.
   */
  recentLoginFailures(db: Database, sinceIso: string): Array<{ occurredAt: string; username: string | null; clearedAfter: boolean }> {
    // Ordering uses the autoincrement id, not timestamps, so events within the same millisecond are ordered correctly.
    return queryAll<{ occurredAt: string; username: string | null; clearedAfter: number }>(
      db,
      `SELECT a.occurred_at AS occurredAt, u.username AS username,
              EXISTS (SELECT 1 FROM audit_logs c
                WHERE c.id > a.id AND a.target_user_id IS NOT NULL AND c.outcome = 'success' AND (
                  (c.action IN ('user.password_reset', 'user.password_recovered') AND c.target_user_id = a.target_user_id)
                  OR (c.action IN ('auth.login', 'password.changed') AND c.actor_user_id = a.target_user_id))) AS clearedAfter
         FROM audit_logs a LEFT JOIN users u ON u.id = a.target_user_id
        WHERE a.action = 'auth.login' AND a.outcome = 'failure' AND a.occurred_at > ?
        ORDER BY a.id`,
      sinceIso,
    ).map((r) => ({ ...r, clearedAfter: r.clearedAfter === 1 }));
  },

  /** Most recent first, only actions starting with `prefix` (e.g. "loyalty."). */
  listByPrefix(db: Database, prefix: string, limit = 50): AuditRecord[] {
    return queryAll<AuditRecord>(
      db,
      `SELECT id, occurred_at AS occurredAt, action, outcome, actor_user_id AS actorUserId,
              target_user_id AS targetUserId, profile_id AS profileId, session_id AS sessionId, metadata
         FROM audit_logs WHERE substr(action, 1, ?) = ? ORDER BY id DESC LIMIT ?`,
      prefix.length,
      prefix,
      limit,
    );
  },

  /** Most recent first. */
  list(db: Database, limit = 100): AuditRecord[] {
    return queryAll<AuditRecord>(
      db,
      `SELECT id, occurred_at AS occurredAt, action, outcome, actor_user_id AS actorUserId,
              target_user_id AS targetUserId, profile_id AS profileId, session_id AS sessionId, metadata
         FROM audit_logs ORDER BY id DESC LIMIT ?`,
      limit,
    );
  },
};
