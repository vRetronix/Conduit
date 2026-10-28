import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  getSchemaVersion,
  migrate,
  MigrationError,
  migrations,
  openDatabase,
  withTransaction,
  type Database,
  type Migration,
} from '@conduit/database';

const open: Database[] = [];
const dirs: string[] = [];
function memoryDb(): Database {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}
afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sample: Migration[] = [
  { version: 1, name: 'a', up: 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;' },
  { version: 2, name: 'b', up: 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES a(id)) STRICT;' },
];

describe('openDatabase', () => {
  it('enables foreign keys and WAL for file databases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-db-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'nested', 'test.db'));
    open.push(db);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(checkIntegrity(db)).toEqual([]);
  });
});

describe('migrate', () => {
  it('applies pending migrations once', () => {
    const db = memoryDb();
    expect(getSchemaVersion(db)).toBe(0);
    expect(migrate(db, sample)).toEqual({ applied: [1, 2], currentVersion: 2 });
    expect(migrate(db, sample)).toEqual({ applied: [], currentVersion: 2 });
  });

  it('applies only new migrations on upgrade', () => {
    const db = memoryDb();
    migrate(db, sample.slice(0, 1));
    expect(migrate(db, sample)).toEqual({ applied: [2], currentVersion: 2 });
  });

  it('refuses a database from a newer app version', () => {
    const db = memoryDb();
    migrate(db, sample);
    expect(() => migrate(db, sample.slice(0, 1))).toThrow(/newer than this application supports/);
  });

  it('detects edited migrations', () => {
    const db = memoryDb();
    migrate(db, sample);
    const edited = [sample[0]!, { ...sample[1]!, up: 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;' }];
    expect(() => migrate(db, edited)).toThrow(MigrationError);
  });

  it('rejects non-contiguous versions', () => {
    expect(() => migrate(memoryDb(), [{ ...sample[1]! }])).toThrow(/versions must be contiguous/);
  });

  it('rolls back a failing migration entirely', () => {
    const db = memoryDb();
    const bad: Migration[] = [{ version: 1, name: 'bad', up: 'CREATE TABLE ok (id INTEGER); THIS IS NOT SQL;' }];
    expect(() => migrate(db, bad)).toThrow();
    expect(getSchemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
  });

  it('applies the application schema cleanly', () => {
    const db = memoryDb();
    const result = migrate(db, migrations);
    expect(result.currentVersion).toBe(migrations.length);
    expect(checkIntegrity(db)).toEqual([]);
  });
});

describe('withTransaction', () => {
  it('commits on success and rolls back on error', () => {
    const db = memoryDb();
    migrate(db, sample);
    withTransaction(db, () => db.prepare('INSERT INTO a (id) VALUES (1)').run());
    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO a (id) VALUES (2)').run();
        db.prepare('INSERT INTO b (id, a_id) VALUES (1, 999)').run(); // FK violation
      }),
    ).toThrow();
    expect(db.prepare('SELECT id FROM a ORDER BY id').all()).toEqual([{ id: 1 }]);
    expect(db.isTransaction).toBe(false);
  });
});
