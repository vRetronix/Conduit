import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_FILE, migrate, migrations, openDatabase } from '@conduit/database';
import { createLogger } from '@conduit/logger';
import { PasswordHasher } from '@conduit/security';
import { loadServerConfig } from '@conduit/shared';
import { LOCK_FILE, writeInstanceLock } from '../../apps/server/src/instance-lock';
import { generateTemporaryPassword, parseRecoveryArgs, recoverAdminPassword } from '../../apps/server/src/recovery';
import { formatRecoveryResult } from '../../apps/server/src/recovery-output';
import { createServices } from '../../apps/server/src/services';
import { OWNER, SETUP_TOKEN } from '../helpers/harness';

const fastHasher = () => new PasswordHasher({ memoryKiB: 256, passes: 1, parallelism: 1 });
let dataDir: string;
let ownerId: string;

/** Opens the on-disk database with fresh services, runs `fn`, and closes it (like starting and stopping the app). */
async function withApp<T>(fn: (s: ReturnType<typeof createServices>) => Promise<T> | T): Promise<T> {
  const db = openDatabase(path.join(dataDir, DATABASE_FILE));
  migrate(db, migrations);
  const config = loadServerConfig({}, { dataDir });
  const logger = createLogger({ name: 'test', console: false });
  try {
    return await fn(createServices({ db, config, hasher: fastHasher(), logger, setupToken: SETUP_TOKEN }));
  } finally {
    db.close();
  }
}

const recover = (overrides: Partial<Parameters<typeof recoverAdminPassword>[0]> = {}) =>
  recoverAdminPassword({ dataDir, username: OWNER.username, confirm: true, hasher: fastHasher(), ...overrides });

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-recovery-'));
  const owner = await withApp((s) => s.auth.setup(OWNER, SETUP_TOKEN, 'test'));
  ownerId = owner.user.id;
  await withApp((s) => s.auth.login({ username: OWNER.username, password: OWNER.password }, 'second device'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const tableRows = (sql: string) => {
  const db = openDatabase(path.join(dataDir, DATABASE_FILE));
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

describe('offline administrator recovery', () => {
  it('sets a working temporary password, revokes every session, and audits the change', async () => {
    const logFile = path.join(dataDir, 'logs', 'server.log');
    const logger = createLogger({ name: 'recovery', filePath: logFile, console: false });
    const result = await recover({ logger });
    logger.close();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.username).toBe('owner');
    expect(result.sessionsRevoked).toBe(2);
    expect(result.temporaryPassword).toMatch(/^([2-9a-hjkmnp-tv-z]{5}-){4}[2-9a-hjkmnp-tv-z]{5}$/);

    // Old password no longer works; the temporary one does, and the account must change it before anything else.
    await withApp(async (s) => {
      await expect(s.auth.login({ username: 'owner', password: OWNER.password }, null)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(s.auth.login({ username: 'owner', password: result.temporaryPassword }, null)).resolves.toMatchObject({
        user: { id: ownerId, mustChangePassword: true },
      });
    });
    expect(tableRows('SELECT must_change_password AS f FROM users')).toEqual([{ f: 1 }]);

    expect(tableRows("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND revoked_reason IS NULL AND client_name IN ('test', 'second device')")).toEqual([{ n: 0 }]);
    const audit = tableRows("SELECT actor_user_id, target_user_id, metadata FROM audit_logs WHERE action = 'user.password_recovered'");
    expect(audit).toEqual([
      { actor_user_id: null, target_user_id: ownerId, metadata: JSON.stringify({ method: 'local_recovery_tool', sessionsRevoked: 2, forcedChange: true }) },
    ]);

    // The temporary password and the hash never reach the log or the audit trail.
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('local recovery tool');
    expect(log).not.toContain(result.temporaryPassword);
    expect(log).not.toContain('$argon2id$');
    expect(JSON.stringify(tableRows('SELECT * FROM audit_logs'))).not.toContain(result.temporaryPassword);
    const hash = tableRows('SELECT password_hash AS h FROM users')[0]!.h as string;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(result.temporaryPassword);
  });

  it('clears a login lockout, including after restart', async () => {
    await withApp(async (s) => {
      for (let i = 0; i < 5; i++) await s.auth.login({ username: 'owner', password: `wrong-${i}` }, null).catch(() => {});
      await expect(s.auth.login({ username: 'owner', password: OWNER.password }, null)).rejects.toMatchObject({ code: 'rate_limited' });
    });
    const result = await recover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await withApp((s) => expect(s.auth.login({ username: 'owner', password: result.temporaryPassword }, null)).resolves.toBeTruthy());
  });

  it('refuses without --confirm', async () => {
    expect(await recover({ confirm: false })).toMatchObject({ ok: false, code: 'confirmation_required' });
  });

  it('refuses while CONDUIT is running on that data folder', async () => {
    const release = writeInstanceLock(dataDir); // lock held by this (live) process
    try {
      const result = await recover();
      expect(result).toMatchObject({ ok: false, code: 'app_running' });
      expect(!result.ok && result.message).toContain(LOCK_FILE);
    } finally {
      release();
    }
  });

  it('treats a lock left by a dead process as stale', async () => {
    fs.writeFileSync(path.join(dataDir, LOCK_FILE), JSON.stringify({ pid: 999_999, startedAt: 'x' }));
    expect(await recover({ isProcessAlive: () => false })).toMatchObject({ ok: true });
  });

  it('fails safe on an unreadable lock file', async () => {
    fs.writeFileSync(path.join(dataDir, LOCK_FILE), 'garbage');
    expect(await recover()).toMatchObject({ ok: false, code: 'app_running' });
  });

  it('refuses unknown users and non-administrators', async () => {
    expect(await recover({ username: 'nobody' })).toMatchObject({ ok: false, code: 'user_not_found' });
    await withApp(async (s) => {
      const p = (await s.auth.login({ username: 'owner', password: OWNER.password }, null)).token;
      const principal = s.auth.authenticate(p)!;
      await s.users.create(principal, { username: 'helper', displayName: 'Helper', password: 'helper-password-1' });
    });
    expect(await recover({ username: 'helper' })).toMatchObject({ ok: false, code: 'not_admin' });
    // The refused attempt changed nothing.
    await withApp((s) => expect(s.auth.login({ username: 'helper', password: 'helper-password-1' }, null)).resolves.toBeTruthy());
  });

  it('refuses a disabled administrator account', async () => {
    const db = openDatabase(path.join(dataDir, DATABASE_FILE));
    db.prepare("UPDATE users SET status = 'disabled'").run();
    db.close();
    expect(await recover()).toMatchObject({ ok: false, code: 'account_disabled' });
  });

  it('refuses a missing database or one from a different schema version', async () => {
    expect(await recover({ dataDir: path.join(dataDir, 'nope') })).toMatchObject({ ok: false, code: 'no_database' });
    const db = openDatabase(path.join(dataDir, DATABASE_FILE));
    db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')").run();
    db.close();
    expect(await recover()).toMatchObject({ ok: false, code: 'schema_mismatch' });
  });

  it('accepts the username case-insensitively', async () => {
    expect(await recover({ username: '  OWNER ' })).toMatchObject({ ok: true, username: 'owner' });
  });
});

describe('recovery command line', () => {
  it('parses arguments strictly', () => {
    expect(parseRecoveryArgs(['--recover-admin', '--username', 'retro', '--confirm'])).toEqual({ username: 'retro', confirm: true });
    expect(parseRecoveryArgs(['--username', 'retro', '--data-dir', 'D:\\data'])).toEqual({ username: 'retro', confirm: false, dataDir: 'D:\\data' });
    expect(parseRecoveryArgs(['--confirm']).error).toMatch(/--username is required/);
    expect(parseRecoveryArgs(['--username']).error).toMatch(/needs a value/);
    expect(parseRecoveryArgs(['--username', '--confirm']).error).toMatch(/needs a value/);
    expect(parseRecoveryArgs(['--username', 'x', '--password', 'y']).error).toMatch(/Unknown option --password/);
  });

  it('never accepts a password on the command line, and formats results for the operator only', () => {
    const ok = formatRecoveryResult({ ok: true, username: 'retro', temporaryPassword: 'abcde-fghjk-mnpqr-stvwx-yz234', sessionsRevoked: 1 }, 'D:\\data');
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain('abcde-fghjk-mnpqr-stvwx-yz234');
    expect(formatRecoveryResult({ ok: false, code: 'app_running', message: 'close it' }, 'x')).toEqual({ text: 'Recovery refused (app_running): close it', exitCode: 1 });
  });

  it('generates high-entropy temporary passwords that satisfy the password policy', () => {
    const seen = new Set(Array.from({ length: 200 }, generateTemporaryPassword));
    expect(seen.size).toBe(200);
    for (const p of seen) expect(p.length).toBeGreaterThanOrEqual(10);
  });
});
