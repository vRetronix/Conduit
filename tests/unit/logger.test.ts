import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from '@conduit/logger';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-log-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('redact', () => {
  it('removes sensitive values at any depth', () => {
    const out = redact({
      user: 'alice',
      password: 'hunter2',
      nested: { accessToken: 'a', refresh_token: 'b', clientSecret: 'c', headers: { Authorization: 'Bearer x' } },
      list: [{ apiKey: 'k' }],
    });
    expect(out).toEqual({
      user: 'alice',
      password: REDACTED,
      nested: { accessToken: REDACTED, refresh_token: REDACTED, clientSecret: REDACTED, headers: { Authorization: REDACTED } },
      list: [{ apiKey: REDACTED }],
    });
  });

  it('serializes errors and survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact({ err: new Error('boom'), a }) as { err: { message: string }; a: { self: unknown } };
    expect(out.err.message).toBe('boom');
    expect(out.a.self).toBe('[Circular]');
  });
});

describe('createLogger', () => {
  it('writes redacted JSON lines and respects the level', () => {
    const file = path.join(tempDir(), 'logs', 'test.log');
    const log = createLogger({ name: 'test', level: 'info', filePath: file, console: false });
    log.debug('hidden');
    log.child({ module: 'auth' }).info('signed in', { token: 'secret-value' });
    log.close();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', name: 'test', msg: 'signed in', module: 'auth', token: REDACTED });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret-value');
  });

  it('rotates files and keeps at most maxFiles backups', () => {
    const file = path.join(tempDir(), 'r.log');
    const log = createLogger({ name: 'r', filePath: file, maxBytes: 300, maxFiles: 2, console: false });
    for (let i = 0; i < 40; i++) log.info(`message ${i}`, { padding: 'x'.repeat(50) });
    log.close();

    const files = fs.readdirSync(path.dirname(file)).sort();
    expect(files).toEqual(['r.log', 'r.log.1', 'r.log.2']);
    for (const f of files) expect(fs.statSync(path.join(path.dirname(file), f)).size).toBeLessThanOrEqual(300);
    expect(fs.readFileSync(file, 'utf8')).toContain('message 39');
  });
});
