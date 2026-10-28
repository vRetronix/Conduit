import { execute, queryAll, queryOne, type Database } from '../sqlite';

export type SystemRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  systemRole: SystemRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** The account must choose a new password before using anything else (set by offline recovery). */
  mustChangePassword: boolean;
}

const COLUMNS = `id, username, display_name AS displayName, password_hash AS passwordHash, system_role AS systemRole,
  status, created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt,
  must_change_password AS mustChangePassword`;

type UserRow = Omit<UserRecord, 'mustChangePassword'> & { mustChangePassword: number };
const toRecord = (row: UserRow | undefined): UserRecord | undefined =>
  row && { ...row, mustChangePassword: row.mustChangePassword === 1 };

export const usersRepo = {
  count(db: Database): number {
    return queryOne<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users')!.n;
  },

  findById(db: Database, id: string): UserRecord | undefined {
    return toRecord(queryOne<UserRow>(db, `SELECT ${COLUMNS} FROM users WHERE id = ?`, id));
  },

  /** `username` must already be normalized. */
  findByUsername(db: Database, username: string): UserRecord | undefined {
    return toRecord(queryOne<UserRow>(db, `SELECT ${COLUMNS} FROM users WHERE username = ?`, username));
  },

  list(db: Database): UserRecord[] {
    return queryAll<UserRow>(db, `SELECT ${COLUMNS} FROM users ORDER BY username`).map((r) => toRecord(r)!);
  },

  insert(
    db: Database,
    user: Pick<UserRecord, 'id' | 'username' | 'displayName' | 'passwordHash' | 'systemRole'> & { now: string },
  ): void {
    execute(
      db,
      `INSERT INTO users (id, username, display_name, password_hash, system_role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      user.id,
      user.username,
      user.displayName,
      user.passwordHash,
      user.systemRole,
      user.now,
      user.now,
    );
  },

  setStatus(db: Database, id: string, status: UserStatus, now: string): number {
    return execute(db, 'UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  },

  /**
   * Replaces the password hash. `mustChangePassword` sets or clears the forced-change flag; omit it to leave the flag
   * as is (e.g. a transparent rehash at login must not clear a pending forced change).
   */
  setPasswordHash(db: Database, id: string, passwordHash: string, now: string, mustChangePassword?: boolean): number {
    if (mustChangePassword === undefined) {
      return execute(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, now, id);
    }
    return execute(
      db,
      'UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      passwordHash,
      mustChangePassword ? 1 : 0,
      now,
      id,
    );
  },

  recordLogin(db: Database, id: string, now: string): void {
    execute(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', now, id);
  },
};
