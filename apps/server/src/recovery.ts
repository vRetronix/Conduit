/**
 * Offline administrator password recovery.
 *
 * Runs only as a local command on the host (there is no HTTP endpoint), against the database file directly, while
 * CONDUIT is closed. It replaces a system administrator's password with a freshly generated temporary one,
 * marks the account as having to change it at next sign-in, revokes all of that account's sessions, and records an
 * audit entry, all in a single transaction.
 *
 * Safeguards: explicit --confirm; target must be an existing, active system administrator; refuses while CONDUIT
 * is running, on a damaged database, or on an unexpected schema version. The temporary password is returned to the
 * caller for display to the operator. It is never logged, and only its Argon2id hash is stored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkIntegrity,
  DATABASE_FILE,
  getSchemaVersion,
  migrations,
  openDatabase,
  sessionsRepo,
  usersRepo,
  withTransaction,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { PasswordHasher, verifyArgon2Implementation } from '@conduit/security';
import { normalizeUsername } from '@conduit/shared';
import { writeAudit } from './audit';
import { isProcessAlive, LOCK_FILE, readInstanceLock } from './instance-lock';

export type RecoveryErrorCode =
  | 'confirmation_required'
  | 'no_database'
  | 'app_running'
  | 'integrity_failed'
  | 'schema_mismatch'
  | 'user_not_found'
  | 'not_admin'
  | 'account_disabled';

export type RecoveryResult =
  | { ok: true; username: string; temporaryPassword: string; sessionsRevoked: number }
  | { ok: false; code: RecoveryErrorCode; message: string };

export interface RecoveryOptions {
  dataDir: string;
  username: string;
  confirm: boolean;
  logger?: Logger;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  /** Argon2 cost for the new hash (defaults to the OWASP minimum; raised automatically at next login if configured higher). */
  hasher?: PasswordHasher;
}

/** Crockford-style alphabet without look-alike characters (no 0/O, 1/I/L, U). 25 chars × 5 bits = 125 bits. */
const ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let group = '';
    for (let i = 0; i < 5; i++) group += ALPHABET[crypto.randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

const fail = (code: RecoveryErrorCode, message: string): RecoveryResult => ({ ok: false, code, message });

export async function recoverAdminPassword(opts: RecoveryOptions): Promise<RecoveryResult> {
  if (!opts.confirm) {
    return fail('confirmation_required', 'Refusing to continue without --confirm. This replaces the administrator password and signs them out everywhere.');
  }
  const dbFile = path.join(opts.dataDir, DATABASE_FILE);
  if (!fs.existsSync(dbFile)) return fail('no_database', `No CONDUIT database found at ${dbFile}.`);

  const lock = readInstanceLock(opts.dataDir, opts.isProcessAlive ?? isProcessAlive);
  if (lock.state === 'running') {
    return fail(
      'app_running',
      `CONDUIT appears to be running (process ${lock.pid}). Close CONDUIT completely and try again. ` +
        `If you are certain it is not running, delete ${path.join(opts.dataDir, LOCK_FILE)} and retry.`,
    );
  }

  await verifyArgon2Implementation();
  const db = openDatabase(dbFile);
  try {
    const problems = checkIntegrity(db);
    if (problems.length > 0) return fail('integrity_failed', 'The database failed its integrity check. Restore a backup instead.');
    const version = getSchemaVersion(db);
    if (version !== migrations.length) {
      return fail(
        'schema_mismatch',
        version < migrations.length
          ? `The database is at schema version ${version}; start CONDUIT once to upgrade it, then retry.`
          : `The database (schema ${version}) is newer than this CONDUIT (schema ${migrations.length}). Use the matching CONDUIT version.`,
      );
    }

    const user = usersRepo.findByUsername(db, normalizeUsername(opts.username));
    if (!user) return fail('user_not_found', 'No account with that username exists.');
    if (user.systemRole !== 'admin') {
      return fail('not_admin', 'That account is not an administrator. Administrators can reset other accounts from User Accounts in the app.');
    }
    if (user.status !== 'active') return fail('account_disabled', 'That administrator account is disabled; recovery will not re-enable it.');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await (opts.hasher ?? new PasswordHasher()).hash(temporaryPassword);
    const now = (opts.now ?? (() => new Date()))();
    const revoked = withTransaction(db, () => {
      const iso = now.toISOString();
      // The temporary password must be replaced at next sign-in before anything else is allowed.
      usersRepo.setPasswordHash(db, user.id, passwordHash, iso, true);
      const ids = sessionsRepo.revokeAllForUser(db, user.id, 'password_recovery', iso);
      writeAudit(
        db,
        {
          action: 'user.password_recovered',
          outcome: 'success',
          actorUserId: null,
          targetUserId: user.id,
          // Key names containing "password" are redacted by the audit writer's backstop, hence "forcedChange".
          metadata: { method: 'local_recovery_tool', sessionsRevoked: ids.length, forcedChange: true },
        },
        now,
      );
      return ids;
    });
    opts.logger?.warn('administrator password reset by local recovery tool', { userId: user.id, sessionsRevoked: revoked.length });
    return { ok: true, username: user.username, temporaryPassword, sessionsRevoked: revoked.length };
  } finally {
    db.close();
  }
}

/** Parses `--username <name> --confirm [--data-dir <dir>]`. Unknown flags are rejected. */
export function parseRecoveryArgs(argv: readonly string[]): { username?: string; confirm: boolean; dataDir?: string; error?: string } {
  const out: { username?: string; confirm: boolean; dataDir?: string; error?: string } = { confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--recover-admin') continue;
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--username' || arg === '--data-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { ...out, error: `${arg} needs a value` };
      if (arg === '--username') out.username = value;
      else out.dataDir = value;
    } else if (arg.startsWith('--')) {
      return { ...out, error: `Unknown option ${arg}` };
    }
  }
  if (!out.username) out.error ??= '--username is required';
  return out;
}

export const RECOVERY_USAGE = 'Usage: --recover-admin --username <administrator username> --confirm [--data-dir <folder>]';
