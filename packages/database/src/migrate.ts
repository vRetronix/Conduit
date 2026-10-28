import { createHash } from 'node:crypto';
import { withTransaction, type Database } from './sqlite';

export interface Migration {
  /** Strictly increasing, starting at 1. Never renumber or edit a released migration; add a new one. */
  version: number;
  name: string;
  /** SQL executed inside a transaction. */
  up: string;
}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim()).digest('hex');

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(`Migration "${m.name}" has version ${m.version}; expected ${i + 1} (versions must be contiguous from 1).`);
    }
  });
}

export function getSchemaVersion(db: Database): number {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  return row.version ?? 0;
}

/**
 * Applies pending migrations in order, each in its own IMMEDIATE transaction.
 * Refuses to run if the database was created by a newer app version or if an applied
 * migration's SQL has been modified since it ran.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  assertWellFormed(migrations);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT`);

  const appliedRows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;

  const latestKnown = migrations.length;
  for (const row of appliedRows) {
    const known = migrations[row.version - 1];
    if (!known) {
      throw new MigrationError(
        `Database schema version ${row.version} is newer than this application supports (${latestKnown}). Update CONDUIT instead of downgrading.`,
      );
    }
    if (checksum(known.up) !== row.checksum) {
      throw new MigrationError(`Migration ${row.version} ("${row.name}") was modified after it was applied.`);
    }
  }

  const appliedVersions = new Set(appliedRows.map((r) => r.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  const applied: number[] = [];

  for (const m of migrations) {
    if (appliedVersions.has(m.version)) continue;
    withTransaction(db, () => {
      db.exec(m.up);
      insert.run(m.version, m.name, checksum(m.up), new Date().toISOString());
    });
    applied.push(m.version);
  }

  return { applied, currentVersion: getSchemaVersion(db) };
}
