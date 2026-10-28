import { execute, queryOne, type Database } from '../sqlite';

// Counters for custom command variables (migration 21): "count:<command id>" and "counter:<name>".

/** Counter values are kept within ±1e12 (far beyond any real use, and exact in a JavaScript number). */
const LIMIT = 1_000_000_000_000;
const clamp = (n: number) => Math.max(-LIMIT, Math.min(LIMIT, Math.trunc(n)));

export const commandCountersRepo = {
  get(db: Database, key: string): number {
    return queryOne<{ value: number }>(db, 'SELECT value FROM command_counters WHERE key = ?', key)?.value ?? 0;
  },

  /** Adds `amount` (may be negative) and returns the new value; a missing counter starts at 0. */
  add(db: Database, key: string, amount: number, now: string): number {
    const current = this.get(db, key);
    const next = clamp(current + amount);
    this.set(db, key, next, now);
    return next;
  },

  set(db: Database, key: string, value: number, now: string): number {
    const v = clamp(value);
    execute(
      db,
      'INSERT INTO command_counters (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      v,
      now,
    );
    return v;
  },

  delete(db: Database, key: string): void {
    execute(db, 'DELETE FROM command_counters WHERE key = ?', key);
  },
};
