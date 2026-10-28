import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Database = DatabaseSync;
export type SqlParam = SQLInputValue;
/** Positional values, or one leading object of named values matching `:name` placeholders. */
export type SqlParams = SqlParam[] | [Record<string, SqlParam>, ...SqlParam[]];

const statementCache = new WeakMap<Database, Map<string, StatementSync>>();

/** Returns a cached prepared statement for `sql` on `db`. */
export function statement(db: Database, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) statementCache.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) cache.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

/** First row of a query, typed by the caller (column aliases must match T's keys). */
export function queryOne<T>(db: Database, sql: string, ...params: SqlParams): T | undefined {
  return statement(db, sql).get(...(params as SqlParam[])) as T | undefined;
}

export function queryAll<T>(db: Database, sql: string, ...params: SqlParams): T[] {
  return statement(db, sql).all(...(params as SqlParam[])) as T[];
}

/** Executes a write; returns the number of changed rows. */
export function execute(db: Database, sql: string, ...params: SqlParams): number {
  return Number(statement(db, sql).run(...(params as SqlParam[])).changes);
}

export interface OpenDatabaseOptions {
  /** Milliseconds to wait for a lock held by another connection/process before failing. */
  busyTimeoutMs?: number;
}

/**
 * Opens (creating if needed) a SQLite database with the settings CONDUIT relies on:
 * WAL journaling so the API and worker processes can read concurrently, enforced foreign keys,
 * and a busy timeout so short write contention waits instead of failing.
 */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Database {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/**
 * Runs `fn` inside a transaction. IMMEDIATE (the default) takes the write lock up front, which avoids
 * deadlock-style SQLITE_BUSY failures when two processes upgrade read transactions to writes.
 * Not re-entrant: do not call from inside another transaction.
 */
export function withTransaction<T>(db: Database, fn: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Runs SQLite's quick integrity check. Returns the problems found (empty when healthy). */
export function checkIntegrity(db: Database): string[] {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  const problems = rows.map((r) => r.quick_check).filter((r) => r !== 'ok');
  return problems;
}
