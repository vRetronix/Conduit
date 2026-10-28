// Settings → Backup & Restore and Logs, through the real API on a temporary database (never the developer's data).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPendingRestore, DATABASE_FILE, listBackups, migrations, openDatabase } from '@conduit/database';
import type { BackupCheck, BackupsState, BackupView, LogsView } from '@conduit/shared';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const state = async () => (await h.call<BackupsState>('GET', '/api/backups')).body;
const backupDir = () => path.join(h.config.dataDir, 'backups');
const DAY = 24 * 60 * 60_000;

describe('Backup & Restore API', () => {
  it('Back Up Now makes a checked backup that is listed, and Check confirms it', async () => {
    const res = await h.call<BackupView>('POST', '/api/backups');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'manual', status: 'ok' });
    const s = await state();
    expect(s.directory).toBe(backupDir());
    expect(s.backups.map((b) => b.file)).toEqual([res.body.file]);
    const check = await h.call<BackupCheck>('POST', '/api/backups/verify', { body: { file: res.body.file } });
    expect(check.body).toMatchObject({ ok: true, message: expect.stringMatching(/passed the database integrity check/) });
    // Only backup file names are accepted: no paths.
    expect((await h.call('POST', '/api/backups/verify', { body: { file: '../conduit.db' } })).status).toBe(400);
  });

  it('settings: validated, saved, and the data folder itself is refused', async () => {
    expect(await state()).toMatchObject({ settings: { autoDaily: true, retention: 14, directory: null } });
    expect((await h.call('PATCH', '/api/backups/settings', { body: { retention: 0 } })).status).toBe(400);
    expect((await h.call('PATCH', '/api/backups/settings', { body: { directory: 'relative/folder' } })).status).toBe(400);
    expect((await h.call('PATCH', '/api/backups/settings', { body: { directory: h.config.dataDir } })).status).toBe(400);
    const custom = path.join(h.config.dataDir, 'elsewhere');
    const ok = await h.call<BackupsState>('PATCH', '/api/backups/settings', { body: { retention: 3, directory: custom } });
    expect(ok.body).toMatchObject({ settings: { retention: 3, directory: custom }, directory: custom });
    await h.call('POST', '/api/backups');
    expect(listBackups(custom)).toHaveLength(1);
  });

  it('automatic backups: one per day, also across restarts; a missed day is made once', async () => {
    h.services.backups.tick();
    expect((await state()).backups.filter((b) => b.kind === 'automatic')).toHaveLength(1);
    h.services.backups.tick(); // same day: nothing
    h.clock.advance(DAY / 2);
    await h.restart(); // a restart doesn't cause an extra one (the last time is saved in the database)
    h.services.backups.tick();
    expect((await state()).backups.filter((b) => b.kind === 'automatic')).toHaveLength(1);
    h.clock.advance(3 * DAY); // closed for days: exactly one catch-up backup
    h.services.backups.tick();
    h.services.backups.tick();
    expect((await state()).backups.filter((b) => b.kind === 'automatic')).toHaveLength(2);
  });

  it('automatic backups off: none are made', async () => {
    await h.call('PATCH', '/api/backups/settings', { body: { autoDaily: false } });
    h.services.backups.tick();
    expect((await state()).backups).toHaveLength(0);
    expect((await state()).nextAutomaticAt).toBeNull();
  });

  it('retention keeps the newest automatic backups and every manual one', async () => {
    await h.call('PATCH', '/api/backups/settings', { body: { retention: 2 } });
    await h.call('POST', '/api/backups');
    for (let i = 0; i < 4; i++) {
      h.clock.advance(DAY);
      h.services.backups.tick();
    }
    const kinds = (await state()).backups.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'automatic')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'manual')).toHaveLength(1);
  });

  it('restore: checks the backup, backs up the current state, stages it and asks for a restart; applied before reopening', async () => {
    h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('test.value', 'old', 'x')").run();
    const good = (await h.call<BackupView>('POST', '/api/backups')).body;
    h.db.prepare("UPDATE app_settings SET value = 'new' WHERE key = 'test.value'").run();
    h.clock.advance(1000);

    const res = await h.call<{ restarting: boolean; preRestoreFile: string }>('POST', '/api/backups/restore', { body: { file: good.file } });
    expect(res.status).toBe(202);
    expect(res.body.restarting).toBe(true);
    expect(res.body.preRestoreFile).toMatch(/-pre-restore\.db$/);
    expect(fs.existsSync(path.join(h.config.dataDir, 'restore-pending.json'))).toBe(true);
    // Nothing is replaced while the database is open.
    expect((h.db.prepare("SELECT value FROM app_settings WHERE key = 'test.value'").get() as { value: string }).value).toBe('new');

    // What the server does on its next start, before opening the database, done in a separate test location: a copy
    // of this (temporary) data folder, so the restore never touches a database that is in use.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-restore-'));
    try {
      // The harness database lives in memory: write its current state out as the "active" database file.
      h.db.prepare('VACUUM INTO ?').run(path.join(copy, DATABASE_FILE));
      fs.cpSync(backupDir(), path.join(copy, 'backups'), { recursive: true });
      const pending = JSON.parse(fs.readFileSync(path.join(h.config.dataDir, 'restore-pending.json'), 'utf8')) as { backupFile: string };
      pending.backupFile = path.join(copy, 'backups', path.basename(pending.backupFile));
      fs.writeFileSync(path.join(copy, 'restore-pending.json'), JSON.stringify(pending));

      const dbFile = path.join(copy, DATABASE_FILE);
      const outcome = applyPendingRestore(copy, dbFile, { maxSchemaVersion: Math.max(...migrations.map((m) => m.version)), now: new Date() });
      expect(outcome).toMatchObject({ ok: true, file: good.file });
      const db = openDatabase(dbFile);
      expect((db.prepare("SELECT value FROM app_settings WHERE key = 'test.value'").get() as { value: string }).value).toBe('old');
      db.close();
      // The pre-restore backup holds the state from just before the restore.
      const pre = openDatabase(path.join(copy, 'backups', res.body.preRestoreFile));
      expect((pre.prepare("SELECT value FROM app_settings WHERE key = 'test.value'").get() as { value: string }).value).toBe('new');
      pre.close();
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('refuses to restore an unknown or damaged backup', async () => {
    expect((await h.call('POST', '/api/backups/restore', { body: { file: 'conduit-20260101-000000-000-manual.db' } })).status).toBe(400);
    const b = (await h.call<BackupView>('POST', '/api/backups')).body;
    fs.appendFileSync(path.join(backupDir(), b.file), 'damage');
    const res = await h.call<{ error: { message: string } }>('POST', '/api/backups/restore', { body: { file: b.file } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/can’t be restored/);
    expect(fs.existsSync(path.join(h.config.dataDir, 'restore-pending.json'))).toBe(false);
  });
});

describe('Logs API', () => {
  const logDir = () => path.join(h.config.dataDir, 'logs');
  const line = (o: Record<string, unknown>) => `${JSON.stringify({ name: 'server', ...o })}\n`;

  it('filters by level, subsystem, date and text, newest first, with secrets removed', async () => {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(
      path.join(logDir(), 'server.log'),
      [
        line({ time: '2026-10-14T10:00:00.000Z', level: 'info', msg: 'kick chat subscription active', module: 'kick-chat' }),
        line({ time: '2026-10-14T11:00:00.000Z', level: 'error', msg: 'could not start the discord bot', module: 'discord-bot', detail: `Bot ${'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA'}.${'GhIjKl'}.${'abcdefghijklmnopqrstuvwxyz0123456789'}` }),
        '{not json\n',
        line({ time: '2026-10-14T12:00:00.000Z', level: 'warn', msg: 'oauth callback rejected', module: 'oauth-callback', url: 'http://127.0.0.1/cb?code=SECRETCODE123&state=abc', accessToken: 'tok-123' }),
        line({ time: '2026-10-14T12:30:00.000Z', level: 'debug', msg: 'noise' }),
      ].join(''),
    );
    fs.writeFileSync(path.join(logDir(), 'desktop.log'), line({ name: 'desktop', time: '2026-10-14T09:00:00.000Z', level: 'info', msg: 'starting' }));

    const q = async (body: Record<string, unknown>) => (await h.call<LogsView>('POST', '/api/logs/query', { body })).body;
    const all = await q({ levels: ['error', 'warn', 'info'] });
    const ours = all.entries.filter((e) => e.time.startsWith('2026-10-14'));
    expect(ours.map((e) => e.message)).toEqual(['oauth callback rejected', 'could not start the discord bot', 'kick chat subscription active', 'starting']);
    expect(all.modules).toEqual(expect.arrayContaining(['discord-bot', 'kick-chat', 'oauth-callback']));
    const text = JSON.stringify(all);
    for (const secret of ['SECRETCODE123', 'tok-123', 'abcdefghijklmnopqrstuvwxyz0123456789']) expect(text).not.toContain(secret);
    expect(ours[0]!.details).toMatchObject({ url: 'http://127.0.0.1/cb?code=[REDACTED]&state=[REDACTED]', accessToken: '[REDACTED]' });
    expect(ours[1]!.hint).toMatch(/Dashboard → Discord/);

    expect((await q({ levels: ['error'] })).entries.map((e) => e.message)).toEqual(['could not start the discord bot']);
    expect((await q({ module: 'kick-chat', levels: ['info'] })).entries.map((e) => e.message)).toEqual(['kick chat subscription active']);
    expect((await q({ source: 'desktop' })).entries.map((e) => e.message)).toEqual(['starting']);
    expect((await q({ search: 'OAUTH' })).entries.map((e) => e.message)).toEqual(['oauth callback rejected']);
    expect((await q({ from: '2026-10-14T10:30:00.000Z', to: '2026-10-14T11:30:00.000Z' })).entries.map((e) => e.message)).toEqual(['could not start the discord bot']);
    expect((await q({ levels: ['debug'] })).entries.map((e) => e.message)).toEqual(['noise']);
  });

  it('a missing log file is reported, not an error; bad filters are refused', async () => {
    fs.rmSync(path.join(logDir(), 'desktop.log'), { force: true });
    const res = await h.call<LogsView>('POST', '/api/logs/query', { body: { source: 'desktop' } });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.problems).toEqual(['desktop.log doesn’t exist yet.']);
    expect((await h.call('POST', '/api/logs/query', { body: { levels: ['nope'] } })).status).toBe(400);
    expect((await h.call('POST', '/api/logs/query', { body: { module: '../etc' } })).status).toBe(400);
  });
});
