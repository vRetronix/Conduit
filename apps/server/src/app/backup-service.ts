/**
 * Settings → Backup & Restore.
 *
 * - Back Up Now and one automatic backup per day. The time of the last automatic backup is saved in the database, so a
 *   restart never causes an extra one, and a backup missed while CONDUIT was closed is made once, shortly after start.
 * - Retention removes old automatic backups only (see pruneAutomaticBackups).
 * - Restore checks the backup, makes a verified backup of the current state, records the restore and asks for a
 *   restart: the file is replaced on the next start, before the database is opened (see applyPendingRestore).
 *
 * Logs name files and sizes only; never contents, credentials or secrets.
 */
import path from 'node:path';
import {
  createBackup,
  listBackups,
  migrations,
  pruneAutomaticBackups,
  readRestoreResult,
  settingsRepo,
  stageRestore,
  verifyBackup,
  type Database,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { backupFileSchema, backupSettingsSchema, type BackupCheck, type BackupSettings, type BackupsState, type BackupView } from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { parseInput } from '../validation';

const SETTINGS_KEY = 'backup.settings';
const LAST_AUTO_KEY = 'backup.last_automatic_at';
const DAY_MS = 24 * 60 * 60_000;
/** How often the schedule is checked. */
export const BACKUP_CHECK_INTERVAL_MS = 15 * 60_000;
/** First check after start: lets startup finish before a catch-up backup. */
export const BACKUP_FIRST_CHECK_MS = 60_000;
/** After a failed automatic backup, wait this long before trying again. */
const RETRY_AFTER_MS = 60 * 60_000;

export const MAX_SCHEMA_VERSION = Math.max(...migrations.map((m) => m.version));

export interface BackupServiceOptions {
  db: Database;
  dataDir: string;
  now: () => Date;
  logger: Logger;
  appVersion: string;
  /** Restarts the backend so a staged restore is applied before the database is opened again. */
  requestRestart: () => void;
}

export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private running = false;
  private problem: string | null = null;
  private lastFailureAt = 0;
  private restoring = false;

  constructor(private readonly o: BackupServiceOptions) {}

  get defaultDirectory(): string {
    return path.join(this.o.dataDir, 'backups');
  }

  settings(): BackupSettings {
    const raw = settingsRepo.get(this.o.db, SETTINGS_KEY);
    let parsed: unknown = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    const r = backupSettingsSchema.safeParse(parsed);
    return r.success ? r.data : backupSettingsSchema.parse({});
  }

  directory(settings = this.settings()): string {
    return settings.directory ?? this.defaultDirectory;
  }

  private lastAutomaticAt(): string | null {
    return settingsRepo.get(this.o.db, LAST_AUTO_KEY) ?? null;
  }

  state(): BackupsState {
    const settings = this.settings();
    const last = this.lastAutomaticAt();
    return {
      settings,
      directory: this.directory(settings),
      defaultDirectory: this.defaultDirectory,
      backups: listBackups(this.directory(settings)) as BackupView[],
      lastAutomaticAt: last,
      nextAutomaticAt: settings.autoDaily ? new Date(last ? Date.parse(last) + DAY_MS : this.o.now().getTime()).toISOString() : null,
      problem: this.problem,
      running: this.running,
      lastRestore: readRestoreResult(this.o.dataDir),
    };
  }

  updateSettings(raw: unknown): BackupsState {
    const next = parseInput(backupSettingsSchema, { ...this.settings(), ...(raw && typeof raw === 'object' ? raw : {}) });
    if (next.directory && path.resolve(next.directory) === path.resolve(this.o.dataDir)) {
      throw new AppError('validation_error', 'Choose a different folder', { issues: [{ path: 'directory', message: 'Use a separate folder, not CONDUIT’s data folder itself.' }] });
    }
    settingsRepo.set(this.o.db, SETTINGS_KEY, JSON.stringify(next), this.o.now().toISOString());
    this.audit('backup.settings_updated', { autoDaily: next.autoDaily, retention: next.retention, customFolder: next.directory !== null });
    return this.state();
  }

  /** Back Up Now. */
  backupNow(): BackupView {
    return this.run('manual');
  }

  private run(kind: 'manual' | 'automatic' | 'pre-restore'): BackupView {
    if (this.running) throw new AppError('conflict', 'A backup is already being made.');
    this.running = true;
    const dir = this.directory();
    try {
      const record = createBackup(this.o.db, dir, { kind, now: this.o.now(), appVersion: this.o.appVersion });
      this.problem = null;
      this.o.logger.info('backup created', { kind, file: record.file, bytes: record.bytes });
      if (kind === 'automatic') {
        settingsRepo.set(this.o.db, LAST_AUTO_KEY, record.createdAt, this.o.now().toISOString());
        const removed = pruneAutomaticBackups(dir, this.settings().retention);
        if (removed.length) this.o.logger.info('old automatic backups removed', { count: removed.length });
      }
      if (kind !== 'automatic') this.audit('backup.created', { kind, file: record.file });
      return record as BackupView;
    } catch (err) {
      this.problem = `The ${kind === 'automatic' ? 'automatic ' : ''}backup failed: ${err instanceof Error ? err.message : String(err)}`;
      this.o.logger.warn('backup failed', { kind, err });
      throw new AppError('service_unavailable', this.problem);
    } finally {
      this.running = false;
    }
  }

  verify(raw: unknown): BackupCheck {
    const { file } = parseInput(backupFileSchema, raw);
    const r = verifyBackup(this.directory(), file, MAX_SCHEMA_VERSION);
    this.o.logger.info('backup checked', { file, ok: r.ok });
    return {
      file,
      ok: r.ok,
      schemaVersion: r.schemaVersion,
      message: r.ok ? 'The backup is complete and unchanged, and passed the database integrity check.' : r.problems.join(' '),
    };
  }

  /**
   * Restores a backup: checks it, backs up the current state (verified), records the restore and restarts the backend,
   * which replaces the database before opening it.
   */
  restore(raw: unknown): { restarting: true; preRestoreFile: string } {
    if (this.restoring) throw new AppError('conflict', 'A restore is already in progress.');
    const { file } = parseInput(backupFileSchema, raw);
    const dir = this.directory();
    const check = verifyBackup(dir, file, MAX_SCHEMA_VERSION);
    if (!check.ok) throw new AppError('validation_error', `That backup can’t be restored: ${check.problems.join(' ')}`);
    const pre = this.run('pre-restore');
    const preCheck = verifyBackup(dir, pre.file, MAX_SCHEMA_VERSION);
    if (!preCheck.ok) throw new AppError('service_unavailable', 'The backup of the current state failed its check, so nothing was restored.');
    stageRestore(this.o.dataDir, path.join(dir, file), path.join(dir, pre.file), this.o.now());
    this.restoring = true;
    this.audit('backup.restore_requested', { file, preRestoreFile: pre.file });
    this.o.logger.warn('restore requested; restarting the backend to apply it', { file, preRestoreFile: pre.file });
    // Answer first, then restart (the dashboard shows "restarting" and reconnects).
    setTimeout(() => this.o.requestRestart(), 300).unref();
    return { restarting: true, preRestoreFile: pre.file };
  }

  // ── schedule ──

  start(): void {
    if (this.timer) return;
    this.firstTimer = setTimeout(() => this.tick(), BACKUP_FIRST_CHECK_MS);
    this.firstTimer.unref();
    this.timer = setInterval(() => this.tick(), BACKUP_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = this.firstTimer = null;
  }

  /** Makes the automatic backup when it's due. At most one per day, also across restarts. */
  tick(): void {
    if (this.running || this.restoring) return;
    const settings = this.settings();
    if (!settings.autoDaily) return;
    const now = this.o.now().getTime();
    const last = this.lastAutomaticAt();
    if (last && now - Date.parse(last) < DAY_MS) return;
    if (this.lastFailureAt && now - this.lastFailureAt < RETRY_AFTER_MS) return;
    try {
      this.run('automatic');
      this.lastFailureAt = 0;
    } catch {
      this.lastFailureAt = now;
    }
  }

  private audit(action: 'backup.settings_updated' | 'backup.created' | 'backup.restore_requested', metadata: Record<string, unknown>): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata }, this.o.now());
  }
}
