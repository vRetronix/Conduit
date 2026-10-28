/**
 * Database backups and restores, safe for a live WAL-mode database.
 *
 * Backup: `VACUUM INTO` runs on the live connection and writes a complete, consistent snapshot of the database as that
 * connection sees it, including committed changes still in the WAL file (copying only the main file could miss
 * them). The copy goes to a temporary name, is integrity-checked, gets a SHA-256 and a manifest, and only then takes
 * its final name, so a failure never leaves a half-written backup that looks valid. The active database is only read.
 *
 * Restore: never done to a database that is open. The server records a "restore pending" note and restarts; on the
 * next start, before the database is opened, `applyPendingRestore` checks the backup again, copies it in under a
 * temporary name, moves the current database (and its WAL/SHM files) aside, puts the copy in place and checks it.
 * If anything fails, the original files are put back. Each step can safely run again after a crash.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from './sqlite';

export type BackupKind = 'manual' | 'automatic' | 'pre-restore';

export interface BackupManifest {
  format: 1;
  file: string;
  kind: BackupKind;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  bytes: number;
  sha256: string;
}

export interface BackupRecord {
  file: string;
  kind: BackupKind;
  createdAt: string;
  bytes: number;
  /** "ok": has a manifest (it was checked when made); "unverified": no manifest. */
  status: 'ok' | 'unverified';
  appVersion: string | null;
  schemaVersion: number | null;
}

export interface BackupCheckResult {
  ok: boolean;
  problems: string[];
  schemaVersion: number | null;
}

const NAME = /^conduit-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-(manual|automatic|pre-restore)\.db$/;
const MANIFEST_SUFFIX = '.json';
export const RESTORE_PENDING_FILE = 'restore-pending.json';
export const RESTORE_RESULT_FILE = 'restore-result.json';

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}

function sha256(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Opens a database file read-only and checks it: full integrity check and the schema version. Never writes. */
export function checkDatabaseFile(file: string): BackupCheckResult {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const problems = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
    let schemaVersion: number | null = null;
    try {
      schemaVersion = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? null;
    } catch {
      problems.push('It is not a CONDUIT database (no migration history).');
    }
    return { ok: problems.length === 0, problems: problems.slice(0, 5), schemaVersion };
  } catch (err) {
    return { ok: false, problems: [`It can’t be opened as a database: ${err instanceof Error ? err.message : String(err)}`], schemaVersion: null };
  } finally {
    db?.close();
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Makes a verified backup of the live database in `dir` (created if needed). Throws, leaving nothing behind, if the
 * copy can't be made or doesn't pass the integrity check.
 */
export function createBackup(db: Database, dir: string, opts: { kind: BackupKind; now: Date; appVersion: string }): BackupRecord {
  fs.mkdirSync(dir, { recursive: true });
  let at = opts.now;
  let file = `conduit-${stamp(at)}-${opts.kind}.db`;
  // Two backups in the same millisecond: take the next free name rather than overwrite.
  while (fs.existsSync(path.join(dir, file))) {
    at = new Date(at.getTime() + 1);
    file = `conduit-${stamp(at)}-${opts.kind}.db`;
  }
  const target = path.join(dir, file);
  const tmp = `${target}.partial`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    const check = checkDatabaseFile(tmp);
    if (!check.ok || check.schemaVersion === null) throw new Error(`the copy failed its check: ${check.problems.join('; ')}`);
    const bytes = fs.statSync(tmp).size;
    const manifest: BackupManifest = {
      format: 1,
      file,
      kind: opts.kind,
      createdAt: opts.now.toISOString(),
      appVersion: opts.appVersion,
      schemaVersion: check.schemaVersion,
      bytes,
      sha256: sha256(tmp),
    };
    fs.renameSync(tmp, target);
    writeJsonAtomic(`${target}${MANIFEST_SUFFIX}`, manifest);
    return { file, kind: opts.kind, createdAt: manifest.createdAt, bytes, status: 'ok', appVersion: opts.appVersion, schemaVersion: check.schemaVersion };
  } catch (err) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    throw err;
  }
}

function readManifest(file: string): BackupManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(`${file}${MANIFEST_SUFFIX}`, 'utf8')) as BackupManifest;
    return m && m.format === 1 && typeof m.sha256 === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** The backups in `dir`, newest first. Only files named like CONDUIT backups are listed. */
export function listBackups(dir: string): BackupRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupRecord[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let bytes: number;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    const manifest = readManifest(full);
    const createdAt = manifest?.createdAt ?? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
    out.push({
      file: name,
      kind: m[8] as BackupKind,
      createdAt,
      bytes,
      status: manifest ? 'ok' : 'unverified',
      appVersion: manifest?.appVersion ?? null,
      schemaVersion: manifest?.schemaVersion ?? null,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.file.localeCompare(a.file)));
}

/** Checks a backup now: readable, unchanged since it was made (SHA-256), integrity, schema not newer than this app. */
export function verifyBackup(dir: string, name: string, maxSchemaVersion: number): BackupCheckResult {
  if (!NAME.test(name)) return { ok: false, problems: ['That isn’t a CONDUIT backup file name.'], schemaVersion: null };
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return { ok: false, problems: ['The backup file is missing.'], schemaVersion: null };
  const problems: string[] = [];
  const manifest = readManifest(full);
  if (!manifest) problems.push('It has no check record (manifest), so it can’t be confirmed unchanged.');
  else if (sha256(full) !== manifest.sha256) problems.push('The file changed after it was made (checksum mismatch).');
  const check = checkDatabaseFile(full);
  problems.push(...check.problems);
  if (check.schemaVersion !== null && check.schemaVersion > maxSchemaVersion) {
    problems.push(`It comes from a newer CONDUIT (database version ${check.schemaVersion}; this one supports up to ${maxSchemaVersion}).`);
  }
  return { ok: problems.length === 0, problems, schemaVersion: check.schemaVersion };
}

/**
 * Applies the retention policy to automatic backups only: keeps the newest `keep`, removes older ones. Manual and
 * pre-restore backups are never removed, and the newest checked backup of any kind always stays. Only files with
 * CONDUIT backup names directly inside `dir` are ever removed. Returns the removed names.
 */
export function pruneAutomaticBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  const newestOk = all.find((b) => b.status === 'ok')?.file;
  const automatic = all.filter((b) => b.kind === 'automatic');
  const removed: string[] = [];
  const root = path.resolve(dir);
  for (const b of automatic.slice(Math.max(1, keep))) {
    if (b.file === newestOk) continue;
    const full = path.resolve(root, b.file);
    if (path.dirname(full) !== root || !NAME.test(path.basename(full))) continue;
    fs.rmSync(full, { force: true });
    fs.rmSync(`${full}${MANIFEST_SUFFIX}`, { force: true });
    removed.push(b.file);
  }
  return removed;
}

// ── Restore ──

export interface PendingRestore {
  backupFile: string;
  sha256: string;
  preRestoreFile: string;
  requestedAt: string;
}

export interface RestoreOutcome {
  at: string;
  ok: boolean;
  file: string;
  message: string;
  preRestoreFile: string | null;
}

/** Records a restore to perform on the next start (the database must not be replaced while it's open). */
export function stageRestore(dataDir: string, backupPath: string, preRestoreFile: string, now: Date): PendingRestore {
  const manifest = readManifest(backupPath);
  if (!manifest) throw new Error('The backup has no check record (manifest).');
  const pending: PendingRestore = { backupFile: backupPath, sha256: manifest.sha256, preRestoreFile, requestedAt: now.toISOString() };
  writeJsonAtomic(path.join(dataDir, RESTORE_PENDING_FILE), pending);
  return pending;
}

export function readRestoreResult(dataDir: string): RestoreOutcome | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, RESTORE_RESULT_FILE), 'utf8')) as RestoreOutcome;
  } catch {
    return null;
  }
}

/**
 * Performs a staged restore, if there is one. Must run before the database is opened. Returns null when nothing was
 * pending. On any failure the database that was in place stays (or is put back) in place.
 */
export function applyPendingRestore(dataDir: string, dbFile: string, opts: { maxSchemaVersion: number; now: Date }): RestoreOutcome | null {
  const pendingPath = path.join(dataDir, RESTORE_PENDING_FILE);
  let pending: PendingRestore;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as PendingRestore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fs.rmSync(pendingPath, { force: true });
    return finish(dataDir, { ok: false, file: '', message: 'The restore request was unreadable; nothing was changed.', preRestoreFile: null }, opts.now);
  }
  const name = path.basename(pending.backupFile);
  const done = (ok: boolean, message: string) => {
    fs.rmSync(pendingPath, { force: true });
    return finish(dataDir, { ok, file: name, message, preRestoreFile: pending.preRestoreFile ? path.basename(pending.preRestoreFile) : null }, opts.now);
  };

  // 1. The backup must still be exactly the one that was checked.
  if (!fs.existsSync(pending.backupFile)) return done(false, 'The backup file is gone; nothing was changed.');
  if (sha256(pending.backupFile) !== pending.sha256) return done(false, 'The backup file changed after it was chosen; nothing was changed.');
  const check = checkDatabaseFile(pending.backupFile);
  if (!check.ok) return done(false, `The backup failed its check (${check.problems.join('; ')}); nothing was changed.`);
  if (check.schemaVersion === null || check.schemaVersion > opts.maxSchemaVersion) return done(false, 'The backup is from a newer CONDUIT; nothing was changed.');

  // 2. Copy it in under a temporary name and check the copy.
  const incoming = `${dbFile}.restoring`;
  fs.rmSync(incoming, { force: true });
  fs.copyFileSync(pending.backupFile, incoming);
  if (!checkDatabaseFile(incoming).ok) {
    fs.rmSync(incoming, { force: true });
    return done(false, 'The copied backup failed its check; nothing was changed.');
  }

  // 3. Move the current database and its WAL/SHM files aside (never deleted), then put the copy in place.
  const asideStamp = stamp(opts.now);
  const moved: Array<[string, string]> = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbFile}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = `${dbFile}.before-restore-${asideStamp}${suffix}`;
    fs.renameSync(from, to);
    moved.push([from, to]);
  }
  const putBack = () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true });
    for (const [from, to] of moved) fs.renameSync(to, from);
  };
  try {
    fs.renameSync(incoming, dbFile);
    const after = checkDatabaseFile(dbFile);
    if (!after.ok) throw new Error(after.problems.join('; '));
  } catch (err) {
    fs.rmSync(incoming, { force: true });
    putBack();
    return done(false, `The restore failed and the previous database was put back: ${err instanceof Error ? err.message : String(err)}`);
  }
  return done(
    true,
    `Restored ${name}. The database that was replaced is kept as ${path.basename(dbFile)}.before-restore-${asideStamp}, and as the backup ${pending.preRestoreFile ? path.basename(pending.preRestoreFile) : '(none)'}.`,
  );
}

function finish(dataDir: string, r: Omit<RestoreOutcome, 'at'>, now: Date): RestoreOutcome {
  const outcome: RestoreOutcome = { at: now.toISOString(), ...r };
  try {
    writeJsonAtomic(path.join(dataDir, RESTORE_RESULT_FILE), outcome);
  } catch {
    // The outcome is also logged by the caller.
  }
  return outcome;
}
