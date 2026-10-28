import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@conduit/logger';
import { KickWebhookServer, parsePublicKey, type KickWebhookEvent } from '../../apps/server/src/kick/kick-webhook-server';
import { deliverWebhook, FakeKick } from '../helpers/fake-kick';
import { freePort } from '../helpers/harness';

const logger = createLogger({ name: 'test', level: 'error', console: false });
let kick: FakeKick;
let server: KickWebhookServer;
let port: number;
let now: number;
let keyFetches: number;
let events: KickWebhookEvent[];
let keyAvailable: boolean;

beforeEach(async () => {
  kick = new FakeKick();
  port = await freePort();
  now = Date.now();
  keyFetches = 0;
  keyAvailable = true;
  events = [];
  server = new KickWebhookServer({
    port,
    logger,
    now: () => now,
    fetchPublicKey: async () => {
      keyFetches++;
      if (!keyAvailable) throw new Error('Kick unreachable');
      return kick.signingKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    },
    onEvent: (e) => events.push(e),
  });
  await server.start();
});
afterEach(async () => {
  await server.close();
});

const settle = () => new Promise((r) => setImmediate(r));
const deliver = (opts: Parameters<typeof deliverWebhook>[3] = {}) =>
  deliverWebhook(kick, port, { content: 'x' }, { timestamp: new Date(now).toISOString(), ...opts });

describe('KickWebhookServer', () => {
  it('fetches the key once and reuses it', async () => {
    expect(await deliver()).toBe(200);
    expect(await deliver()).toBe(200);
    await settle();
    expect(keyFetches).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'chat.message.sent', version: '1', subscriptionId: '01SUB', payload: { content: 'x' } });
  });

  it('follows a key rotation: refetches after a failed check (at most once a minute)', async () => {
    expect(await deliver()).toBe(200);
    kick.signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Within a minute of the last fetch, a failing signature does not refetch (a forger can't force key downloads).
    expect(await deliver()).toBe(401);
    expect(keyFetches).toBe(1);
    now += 61_000;
    expect(await deliver()).toBe(200);
    expect(keyFetches).toBe(2);
  });

  it("answers 503 (so Kick retries) when Kick's key can't be fetched, and processes nothing", async () => {
    keyAvailable = false;
    expect(await deliver()).toBe(503);
    await settle();
    expect(events).toHaveLength(0);
  });

  it('caps request volume on the public port', async () => {
    const statuses = await Promise.all(Array.from({ length: 60 }, () => fetch(`http://127.0.0.1:${port}/nope`).then((r) => r.status)));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('rejects a query string and malformed headers', async () => {
    expect(await deliver({ path: '/kick/webhook?x=1' })).toBe(404);
    expect(await deliver({ messageId: 'bad id with spaces' })).toBe(400);
    expect(await deliver({ type: 'Chat Message' })).toBe(400);
  });
});

describe('parsePublicKey', () => {
  it('accepts PEM and bare base64 DER (the documentation does not state the format)', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const der = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    expect(parsePublicKey(pem).asymmetricKeyType).toBe('rsa');
    expect(parsePublicKey(der).asymmetricKeyType).toBe('rsa');
    expect(() => parsePublicKey('not a key')).toThrow();
  });
});

describe('kickErrorDetail', () => {
  it("extracts Kick's explanation from JSON or text, sanitized and capped", async () => {
    const { kickErrorDetail } = await import('../../apps/server/src/kick/kick-chat-api');
    expect(kickErrorDetail('{"message":"Webhook is not enabled for this app","data":null}')).toBe('Webhook is not enabled for this app');
    expect(kickErrorDetail('{"error":"invalid_request"}')).toBe('invalid_request');
    expect(kickErrorDetail('plain\nreason\u0007here')).toBe('plain reason here');
    expect(kickErrorDetail('<html><body>Bad gateway</body></html>')).toBeNull();
    expect(kickErrorDetail('x'.repeat(500))!.length).toBe(200);
    expect(kickErrorDetail('')).toBeNull();
  });
});

describe('KickWebhookServer diagnostics', () => {
  it('logs accepted deliveries and refusal reasons without content, signatures or headers', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kick-diag-')), 'log.txt');
    const fileLogger = createLogger({ name: 'test', level: 'info', console: false, filePath: file });
    const p = await freePort();
    const k = new FakeKick();
    const s = new KickWebhookServer({
      port: p,
      logger: fileLogger,
      fetchPublicKey: async () => k.signingKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      onEvent: () => {},
    });
    await s.start();
    await deliverWebhook(k, p, { content: 'secret words' });
    await deliverWebhook(k, p, { content: 'forged' }, { signWith: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey });
    await deliverWebhook(
      k,
      p,
      { content: 'forged again' },
      { signWith: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey },
    );
    await s.close();
    fileLogger.close();
    const log = fs.readFileSync(file, 'utf8');
    expect(log).toContain('"msg":"kick webhook delivery accepted","type":"chat.message.sent"');
    expect(log.match(/kick webhook request refused/g)).toHaveLength(1); // second refusal within a minute is counted, not logged
    expect(log).toContain('"reason":"signature"');
    expect(log).not.toMatch(/secret words|forged|Kick-Event-Signature|BEGIN PUBLIC KEY/);
  });
});

describe('KickWebhookServer wrong-path diagnostics', () => {
  it('records the path and whether it looked like a Kick delivery (to spot a mistyped webhook URL)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kick-path-')), 'log.txt');
    const fileLogger = createLogger({ name: 'test', level: 'info', console: false, filePath: file });
    const p = await freePort();
    const k = new FakeKick();
    const s = new KickWebhookServer({ port: p, logger: fileLogger, fetchPublicKey: async () => '', onEvent: () => {} });
    await s.start();
    expect(await deliverWebhook(k, p, { content: 'x' }, { path: '/' })).toBe(404);
    await s.close();
    fileLogger.close();
    const log = fs.readFileSync(file, 'utf8');
    expect(log).toContain('"reason":"path","status":404,"path":"/","hadQuery":false,"looksLikeKick":true');
  });
});
