// Database backup and restore (packages/database/src/backup.ts), on disposable databases in a temp folder only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPendingRestore,
  checkDatabaseFile,
  createBackup,
  listBackups,
  migrate,
  migrations,
  openDatabase,
  pruneAutomaticBackups,
  readRestoreResult,
  RESTORE_PENDING_FILE,
  stageRestore,
  verifyBackup,
  type Database,
} from '@conduit/database';

const MAX = Math.max(...migrations.map((m) => m.version));
const roots: string[] = [];
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-backup-'));
  roots.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const dbFile = path.join(dataDir, 'conduit.db');
  const db = openDatabase(dbFile);
  open.push(db);
  migrate(db, migrations);
  // Keep committed changes in the WAL file (no automatic checkpoint), like a busy live database.
  db.exec('PRAGMA wal_autocheckpoint = 0');
  const backups = path.join(root, 'backups');
  return { root, dataDir, dbFile, db, backups };
}

const setValue = (db: Database, value: string) =>
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('test.value', ?, 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(value);
const readValue = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT value FROM app_settings WHERE key = 'test.value'").get() as { value: string } | undefined)?.value;
  } finally {
    db.close();
  }
};
const at = (iso: string) => new Date(iso);

describe('createBackup', () => {
  it('includes committed changes that are still only in the WAL, and passes its checks', () => {
    const { db, dbFile, backups } = setup();
    setValue(db, 'in-the-wal');
    expect(fs.statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);
    const b = createBackup(db, backups, { kind: 'manual', now: at('2026-10-14T12:00:00.000Z'), appVersion: '0.4.0' });
    expect(b).toMatchObject({ kind: 'manual', status: 'ok', appVersion: '0.4.0', schemaVersion: MAX });
    expect(b.file).toBe('conduit-20261014-120000-000-manual.db');
    const file = path.join(backups, b.file);
    expect(readValue(file)).toBe('in-the-wal');
    expect(checkDatabaseFile(file)).toMatchObject({ ok: true, schemaVersion: MAX });
    expect(verifyBackup(backups, b.file, MAX)).toMatchObject({ ok: true });
    // The live database is untouched and still writable.
    setValue(db, 'after');
    expect(readValue(file)).toBe('in-the-wal');
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('never overwrites: two backups in the same millisecond get different names', () => {
    const { db, backups } = setup();
    const now = at('2026-10-14T12:00:00.000Z');
    const a = createBackup(db, backups, { kind: 'manual', now, appVersion: '1' });
    const b = createBackup(db, backups, { kind: 'manual', now, appVersion: '1' });
    expect(a.file).not.toBe(b.file);
    expect(listBackups(backups)).toHaveLength(2);
  });
});

describe('verifyBackup', () => {
  it('detects a changed file, a missing manifest, a non-backup name and a newer database version', () => {
    const { db, backups } = setup();
    const b = createBackup(db, backups, { kind: 'manual', now: at('2026-10-14T12:00:00.000Z'), appVersion: '1' });
    const file = path.join(backups, b.file);
    expect(verifyBackup(backups, '../conduit.db', MAX)).toMatchObject({ ok: false, problems: [expect.stringMatching(/isn’t a CONDUIT backup/)] });
    expect(verifyBackup(backups, b.file, MAX - 1).problems.join(' ')).toMatch(/newer CONDUIT/);
    fs.appendFileSync(file, 'tampered');
    expect(verifyBackup(backups, b.file, MAX).problems.join(' ')).toMatch(/changed after it was made/);
    fs.rmSync(`${file}.json`);
    expect(listBackups(backups)[0]!.status).toBe('unverified');
    expect(verifyBackup(backups, b.file, MAX).problems.join(' ')).toMatch(/no check record/);
  });
});

describe('retention', () => {
  it('removes only old automatic backups; manual and pre-restore stay; other files are never touched', () => {
    const { db, backups } = setup();
    const made = (kind: 'manual' | 'automatic' | 'pre-restore', day: number) =>
      createBackup(db, backups, { kind, now: at(`2026-10-${String(day).padStart(2, '0')}T03:00:00.000Z`), appVersion: '1' }).file;
    const manual = made('manual', 1);
    const pre = made('pre-restore', 2);
    const autos = [3, 4, 5, 6].map((d) => made('automatic', d));
    fs.writeFileSync(path.join(backups, 'my-notes.txt'), 'keep me');
    fs.writeFileSync(path.join(backups, 'conduit.db'), 'not a backup name');
    const removed = pruneAutomaticBackups(backups, 2);
    expect(removed.sort()).toEqual([autos[0], autos[1]].sort());
    const left = fs.readdirSync(backups);
    expect(left).toEqual(expect.arrayContaining([manual, pre, autos[2], autos[3], 'my-notes.txt', 'conduit.db']));
    expect(left).not.toContain(autos[0]);
  });

  it('never removes the only valid backup', () => {
    const { db, backups } = setup();
    const only = createBackup(db, backups, { kind: 'automatic', now: at('2026-10-01T03:00:00.000Z'), appVersion: '1' }).file;
    expect(pruneAutomaticBackups(backups, 0)).toEqual([]);
    expect(fs.existsSync(path.join(backups, only))).toBe(true);
  });
});

describe('restore (separate test location; never the active database)', () => {
  it('replaces the database before it is opened, keeping the old files aside', () => {
    const { db, dbFile, dataDir, backups } = setup();
    setValue(db, 'old state');
    const good = createBackup(db, backups, { kind: 'manual', now: at('2026-10-14T12:00:00.000Z'), appVersion: '1' });
    setValue(db, 'newer state');
    const pre = createBackup(db, backups, { kind: 'pre-restore', now: at('2026-10-14T13:00:00.000Z'), appVersion: '1' });
    stageRestore(dataDir, path.join(backups, good.file), path.join(backups, pre.file), at('2026-10-14T13:00:00.000Z'));
    open.splice(open.indexOf(db), 1);
    db.close(); // the server is restarted: nothing has the database open
    // Leave WAL/SHM files behind, as after a crash, to prove they're moved aside with the old database.
    fs.writeFileSync(`${dbFile}-wal`, 'stale');

    const r = applyPendingRestore(dataDir, dbFile, { maxSchemaVersion: MAX, now: at('2026-10-14T13:00:01.000Z') });
    expect(r).toMatchObject({ ok: true, file: good.file, preRestoreFile: pre.file });
    expect(readValue(dbFile)).toBe('old state');
    expect(fs.existsSync(path.join(dataDir, RESTORE_PENDING_FILE))).toBe(false);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
    const aside = fs.readdirSync(dataDir).filter((f) => f.startsWith('conduit.db.before-restore-'));
    expect(aside.sort()).toEqual([expect.stringMatching(/before-restore-\d{8}-\d{6}-\d{3}$/), expect.stringMatching(/-wal$/)]);
    expect(readRestoreResult(dataDir)).toMatchObject({ ok: true });
    // The pre-restore backup can bring the newer state back.
    expect(readValue(path.join(backups, pre.file))).toBe('newer state');
  });

  it('a backup that changed after it was chosen is refused and nothing is changed', () => {
    const { db, dbFile, dataDir, backups } = setup();
    setValue(db, 'current');
    const b = createBackup(db, backups, { kind: 'manual', now: at('2026-10-14T12:00:00.000Z'), appVersion: '1' });
    stageRestore(dataDir, path.join(backups, b.file), path.join(backups, b.file), at('2026-10-14T12:00:00.000Z'));
    fs.appendFileSync(path.join(backups, b.file), 'x');
    open.splice(open.indexOf(db), 1);
    db.close();
    const r = applyPendingRestore(dataDir, dbFile, { maxSchemaVersion: MAX, now: at('2026-10-14T12:00:01.000Z') });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/changed after it was chosen; nothing was changed/) });
    expect(readValue(dbFile)).toBe('current');
    expect(fs.readdirSync(dataDir).some((f) => f.includes('before-restore'))).toBe(false);
  });

  it('a backup from a newer CONDUIT is refused; no pending restore means nothing happens', () => {
    const { db, dbFile, dataDir, backups } = setup();
    expect(applyPendingRestore(dataDir, dbFile, { maxSchemaVersion: MAX, now: new Date() })).toBeNull();
    const b = createBackup(db, backups, { kind: 'manual', now: at('2026-10-14T12:00:00.000Z'), appVersion: '1' });
    stageRestore(dataDir, path.join(backups, b.file), path.join(backups, b.file), new Date());
    open.splice(open.indexOf(db), 1);
    db.close();
    const r = applyPendingRestore(dataDir, dbFile, { maxSchemaVersion: MAX - 1, now: new Date() });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/newer CONDUIT/) });
    expect(checkDatabaseFile(dbFile).ok).toBe(true);
  });
});
