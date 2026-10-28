/**
 * Settings → Backup, Restore & Logs: the API contract shared by the server and the dashboard.
 *
 * A backup is a verified copy of CONDUIT's database (everything you've set up: commands, giveaways, notifications,
 * moderation, settings and history). Credentials are not in it: they are encrypted with this PC's key in the
 * credential store and stay as they are when a backup is restored.
 */
import { z } from 'zod';

export const BACKUP_KINDS = ['manual', 'automatic', 'pre-restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_RETENTION_DEFAULT = 14;
export const BACKUP_RETENTION_MAX = 365;

export const backupSettingsSchema = z.strictObject({
  /** One automatic backup per day (a missed one is made once at the next start). */
  autoDaily: z.boolean().default(true),
  /** Automatic backups kept (oldest removed first). Manual and pre-restore backups are never removed automatically. */
  retention: z.number().int().min(1, 'Keep at least 1').max(BACKUP_RETENTION_MAX, `At most ${BACKUP_RETENTION_MAX}`).default(BACKUP_RETENTION_DEFAULT),
  /** Absolute folder for backups; null uses the default (the data folder's "backups"). */
  directory: z
    .string()
    .trim()
    .max(500, 'At most 500 characters')
    .refine((s) => /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\'), 'Use a full folder path, like D:\\CONDUIT Backups')
    .nullable()
    .default(null),
});
export type BackupSettings = z.output<typeof backupSettingsSchema>;

/** A backup file name as CONDUIT writes it; the only names the API accepts (no paths). */
export const BACKUP_FILE_PATTERN = /^conduit-\d{8}-\d{6}-\d{3}-(manual|automatic|pre-restore)\.db$/;
export const backupFileSchema = z.strictObject({ file: z.string().regex(BACKUP_FILE_PATTERN, 'Choose a backup from the list') });

export interface BackupView {
  file: string;
  kind: BackupKind;
  createdAt: string;
  bytes: number;
  /** "ok": checked when it was made (and on demand); "unverified": no check record (e.g. copied in by hand). */
  status: 'ok' | 'unverified';
  appVersion: string | null;
  schemaVersion: number | null;
}

export interface BackupCheck {
  file: string;
  ok: boolean;
  /** Plain-words result. */
  message: string;
  schemaVersion: number | null;
}

export interface RestoreResult {
  at: string;
  ok: boolean;
  file: string;
  message: string;
  /** The verified backup of the state just before the restore. */
  preRestoreFile: string | null;
}

export interface BackupsState {
  settings: BackupSettings;
  /** The folder in use (settings.directory, or the default). */
  directory: string;
  defaultDirectory: string;
  backups: BackupView[];
  lastAutomaticAt: string | null;
  /** When the next automatic backup is due (null when automatic backups are off). */
  nextAutomaticAt: string | null;
  /** The latest backup problem, if the last attempt failed. */
  problem: string | null;
  running: boolean;
  lastRestore: RestoreResult | null;
}

// ── Logs ──

export const LOG_VIEW_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogViewLevel = (typeof LOG_VIEW_LEVELS)[number];
export const LOG_SOURCES = ['server', 'desktop'] as const;

export const logQuerySchema = z.strictObject({
  levels: z.array(z.enum(LOG_VIEW_LEVELS)).max(4).default(['error', 'warn', 'info']),
  source: z.enum(LOG_SOURCES).nullable().default(null),
  /** Subsystem (the log's "module", e.g. kick-chat). */
  module: z.string().trim().max(60).regex(/^[a-z0-9_-]*$/).nullable().default(null),
  /** ISO dates/times; inclusive range. */
  from: z.iso.datetime({ offset: true }).nullable().default(null),
  to: z.iso.datetime({ offset: true }).nullable().default(null),
  search: z.string().trim().max(200).default(''),
  limit: z.number().int().min(1).max(1000).default(300),
});
export type LogQuery = z.output<typeof logQuerySchema>;

export interface LogEntryView {
  time: string;
  level: LogViewLevel;
  source: (typeof LOG_SOURCES)[number];
  module: string | null;
  message: string;
  /** Other fields of the entry, with secrets removed. */
  details: Record<string, unknown>;
  /** What to do about it, for known problems. */
  hint: string | null;
}

export interface LogsView {
  entries: LogEntryView[];
  /** Subsystems seen in the scanned logs (for the filter). */
  modules: string[];
  /** True when older entries exist beyond what was scanned or returned. */
  truncated: boolean;
  /** Files that couldn't be read right now (e.g. locked), in plain words. */
  problems: string[];
  folder: string;
}
