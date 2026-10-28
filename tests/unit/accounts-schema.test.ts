import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSchemaVersion, migrate, migrations, openDatabase, type Database } from '@conduit/database';

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const T = '2026-01-01T00:00:00.000Z';
const HASH = '$argon2id$v=19$m=256,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

function freshDb(): Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  migrate(db, migrations);
  return db;
}

function addUser(db: Database, id: string, username = id): void {
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, system_role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', 'active', ?, ?)`,
  ).run(id, username, username, HASH, T, T);
}

function addProfile(db: Database, id: string, owner: string): void {
  db.prepare(
    `INSERT INTO streamer_profiles (id, slug, display_name, bot_display_name, owner_user_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, id, id, owner, owner, T, T);
}

function addMember(db: Database, profile: string, user: string, role = 'member'): void {
  db.prepare(
    `INSERT INTO profile_memberships (profile_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(profile, user, role, T, T);
}

describe('migration 2 (accounts)', () => {
  it('upgrades an existing Phase 1 database without losing data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-upgrade-'));
    dirs.push(dir);
    const file = path.join(dir, 'conduit.db');

    // Simulate a Phase 1 install: only migration 1 applied, with some data.
    const v1 = openDatabase(file);
    migrate(v1, migrations.slice(0, 1));
    v1.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('phase1_marker', 'kept', ?)").run(T);
    expect(getSchemaVersion(v1)).toBe(1);
    v1.close();

    const db = openDatabase(file);
    dbs.push(db);
    expect(migrate(db, migrations)).toEqual({ applied: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'phase1_marker'").get()).toEqual({ value: 'kept' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    // Running again is a no-op, and the database still passes integrity checks.
    expect(migrate(db, migrations)).toEqual({ applied: [], currentVersion: 29 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('migration 3 adds the forced-password-change flag without touching existing accounts', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 2));
    addUser(db, 'u1', 'alice');
    expect(migrate(db, migrations)).toEqual({ applied: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare("SELECT username, must_change_password AS flag FROM users WHERE id = 'u1'").get()).toEqual({ username: 'alice', flag: 0 });
    expect(() => db.prepare("UPDATE users SET must_change_password = 2 WHERE id = 'u1'").run()).toThrow(/CHECK/);
  });

  it('migration 4 adds platform_connections with integrity constraints and keeps account data', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 3));
    addUser(db, 'u1', 'alice');
    expect(migrate(db, migrations)).toEqual({ applied: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare('SELECT username FROM users').all()).toEqual([{ username: 'alice' }]);
    const insert = (platform: string, ext: string, status = 'connected', scopes = '[]') =>
      db
        .prepare(
          `INSERT INTO platform_connections (id, platform, external_account_id, account_name, granted_scopes, status, connected_at, updated_at)
           VALUES (?, ?, ?, 'n', ?, ?, ?, ?)`,
        )
        .run(`${platform}-${ext}`, platform, ext, scopes, status, T, T);
    insert('twitch', 'a');
    expect(() => insert('myspace', 'a')).toThrow(/CHECK/);
    expect(() => insert('kick', 'b', 'pretend-connected')).toThrow(/CHECK/);
    expect(() => insert('kick', 'c', 'connected', 'not json')).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO platform_connections (id, platform, external_account_id, account_name, status, connected_at, updated_at) VALUES ('dup', 'twitch', 'a', 'n', 'connected', 'x', 'x')").run()).toThrow(/UNIQUE/);
  });

  it('migration 5 adds non-secret display metadata only, with a bounded avatar', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 4));
    db.prepare(`INSERT INTO platform_connections (id, platform, external_account_id, account_name, status, connected_at, updated_at) VALUES ('c1', 'discord', 'x', 'n', 'connected', ?, ?)`).run(T, T);
    expect(migrate(db, migrations)).toEqual({ applied: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare("SELECT account_handle AS h, avatar_data_url AS a FROM platform_connections WHERE id = 'c1'").get()).toEqual({ h: null, a: null });
    db.prepare("UPDATE platform_connections SET avatar_data_url = 'data:image/png;base64,AAAA' WHERE id = 'c1'").run();
    expect(() => db.prepare("UPDATE platform_connections SET avatar_data_url = 'https://evil.example/a.png' WHERE id = 'c1'").run()).toThrow(/CHECK/);
    const columns = (db.prepare('PRAGMA table_info(platform_connections)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns.some((c) => /token|secret/i.test(c))).toBe(false);
  });

  it('migration 6 stores the Discord application id and verified servers only, never secrets', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 5));
    expect(migrate(db, migrations)).toEqual({ applied: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    const insert = (id: string) =>
      db.prepare('INSERT INTO discord_application (id, application_id, validated_at, updated_at) VALUES (?, ?, ?, ?)').run(id === 'second' ? 2 : 1, id, T, T);
    insert('123456789012345678');
    expect(() => db.prepare("UPDATE discord_application SET application_id = 'abc' WHERE id = 1").run()).toThrow(/CHECK/);
    expect(() => insert('second')).toThrow(/CHECK/); // a single application row
    expect(() => db.prepare("INSERT INTO discord_guild_installations (guild_id, guild_name, verified_at) VALUES ('x1', 'n', ?)").run(T)).toThrow(/CHECK/);
    for (const table of ['discord_application', 'discord_guild_installations']) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
      expect(columns.some((col) => /token|secret/i.test(col))).toBe(false);
    }
  });

  it('migration 7 records command registration status per server, never secrets', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 6));
    expect(migrate(db, migrations)).toEqual({ applied: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    const insert = (status: string, registeredAt: string | null, guild = '42') =>
      db
        .prepare('INSERT OR REPLACE INTO discord_command_registrations (guild_id, application_id, commands_hash, status, registered_at, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(guild, '123456789012345678', 'abc', status, registeredAt, T);
    insert('registered', T);
    insert('failed', null);
    expect(() => insert('registered', null)).toThrow(/CHECK/); // "registered" needs a confirmation time
    expect(() => insert('maybe', T)).toThrow(/CHECK/);
    expect(() => insert('failed', null, 'x1')).toThrow(/CHECK/);
    const columns = (db.prepare('PRAGMA table_info(discord_command_registrations)').all() as Array<{ name: string }>).map((col) => col.name);
    expect(columns.some((col) => /token|secret/i.test(col))).toBe(false);
  });

  it('migration 8 adds connection roles: existing rows become the primary account, nothing else changes', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 7));
    db.prepare(`INSERT INTO platform_connections (id, platform, external_account_id, account_name, status, connected_at, updated_at) VALUES ('d1', 'discord', 'x', 'n', 'connected', ?, ?)`).run(T, T);
    expect(migrate(db, migrations)).toEqual({ applied: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare("SELECT role, account_name AS n, status FROM platform_connections WHERE id = 'd1'").get()).toEqual({ role: 'primary', n: 'n', status: 'connected' });
    db.prepare(`INSERT INTO platform_connections (id, platform, role, external_account_id, account_name, status, connected_at, updated_at) VALUES ('k2', 'kick', 'bot', 'y', 'b', 'connected', ?, ?)`).run(T, T);
    expect(() =>
      db.prepare(`INSERT INTO platform_connections (id, platform, role, external_account_id, account_name, status, connected_at, updated_at) VALUES ('k3', 'kick', 'admin', 'z', 'c', 'connected', ?, ?)`).run(T, T),
    ).toThrow(/CHECK/);
    const columns = (db.prepare('PRAGMA table_info(platform_connections)').all() as Array<{ name: string }>).map((col) => col.name);
    expect(columns.some((col) => /token|secret/i.test(col))).toBe(false);
  });

  it('migration 9 stores Kick command definitions: normalized unique triggers, plain-text responses', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 8));
    expect(migrate(db, migrations)).toEqual({ applied: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    const insert = (id: string, trigger: string, platform = 'kick', response = 'Hi') =>
      db
        .prepare('INSERT INTO chat_commands (id, platform, trigger, response, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(id, platform, trigger, response, T, T);
    insert('c1', '!hello');
    expect(() => insert('c2', '!hello')).toThrow(/UNIQUE/);
    expect(() => insert('c3', '!Hello')).toThrow(/CHECK/); // stored lower case only
    expect(() => insert('c4', 'hello')).toThrow(/CHECK/);
    expect(() => insert('c5', '!x', 'discord')).toThrow(/CHECK/);
    expect(() => insert('c6', '!empty', 'kick', '')).toThrow(/CHECK/);
  });

  it('rejects a database from a newer schema', () => {
    const db = freshDb();
    db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', ?)").run(T);
    expect(() => migrate(db, migrations)).toThrow(/newer than this application supports/);
  });

  it('enforces unique usernames and valid roles/statuses', () => {
    const db = freshDb();
    addUser(db, 'u1', 'alice');
    expect(() => addUser(db, 'u2', 'alice')).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, system_role, created_at, updated_at) VALUES ('u3','bob','b',?, 'root', ?, ?)`).run(HASH, T, T),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES ('u4','carol','c','plaintext', ?, ?)`).run(T, T),
    ).toThrow(/CHECK/);
  });

  it('requires every profile to have an existing owner', () => {
    const db = freshDb();
    expect(() => addProfile(db, 'p1', 'nobody')).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(`INSERT INTO streamer_profiles (id, slug, display_name, bot_display_name, created_by, created_at, updated_at) VALUES ('p2','p2','p','p','x',?,?)`).run(T, T),
    ).toThrow(/NOT NULL/);
  });

  it('rejects owner memberships, duplicate memberships and invalid roles', () => {
    const db = freshDb();
    addUser(db, 'owner');
    addUser(db, 'm');
    addProfile(db, 'p', 'owner');
    expect(() => addMember(db, 'p', 'owner')).toThrow(/owner cannot also hold a membership/);
    addMember(db, 'p', 'm');
    expect(() => addMember(db, 'p', 'm')).toThrow(/UNIQUE|PRIMARY KEY/);
    addUser(db, 'x');
    expect(() => addMember(db, 'p', 'x', 'owner')).toThrow(/CHECK/);
    expect(() => addMember(db, 'p', 'x', 'superadmin')).toThrow(/CHECK/);
  });

  it('blocks moving ownership to a user who still holds a membership', () => {
    const db = freshDb();
    addUser(db, 'owner');
    addUser(db, 'm');
    addProfile(db, 'p', 'owner');
    addMember(db, 'p', 'm');
    expect(() => db.prepare("UPDATE streamer_profiles SET owner_user_id = 'm' WHERE id = 'p'").run()).toThrow(/remove the new owner/);
  });

  it('makes the audit log append-only', () => {
    const db = freshDb();
    db.prepare("INSERT INTO audit_logs (occurred_at, action, outcome) VALUES (?, 'x', 'success')").run(T);
    expect(() => db.prepare("UPDATE audit_logs SET action = 'y'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_logs').run()).toThrow(/append-only/);
    expect(() => db.prepare("INSERT INTO audit_logs (occurred_at, action, outcome, metadata) VALUES (?, 'x', 'success', 'not json')").run(T)).toThrow(/CHECK/);
  });

  it('stores only fixed-length token hashes for sessions', () => {
    const db = freshDb();
    addUser(db, 'u');
    expect(() =>
      db.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('s','raw-token','u',?,?,?)`).run(T, T, T),
    ).toThrow(/CHECK/);
  });
});
