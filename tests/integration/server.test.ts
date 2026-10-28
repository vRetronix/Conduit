import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthResponseSchema, serverMessageSchema } from '@conduit/shared';
import { createHarness, DASHBOARD_ORIGIN, openSocket, setupOwner, upgradeStatus, type Harness } from '../helpers/harness';

let h: Harness;
let token: string;

beforeAll(async () => {
  h = await createHarness();
  token = (await setupOwner(h)).token;
});

afterAll(async () => {
  await h.close();
});

function rawRequest(
  pathname: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP API baseline', () => {
  it('reports health without authentication and without account data', async () => {
    const res = await rawRequest('/api/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(JSON.parse(res.body));
    expect(body).toMatchObject({ status: 'ok', version: '9.9.9-test', database: { ok: true, schemaVersion: 29 } });
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'time', 'uptimeSeconds', 'version']);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 404s outside /api', async () => {
    const res = await rawRequest('/nope');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('denies unknown /api paths to unauthenticated callers (deny by default)', async () => {
    const res = await rawRequest('/api/nope');
    expect(res.status).toBe(401);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    expect((await rawRequest('/api/health', { Host: 'attacker.example:47820' })).status).toBe(403);
  });

  it('allows the dashboard origin via CORS', async () => {
    const res = await rawRequest('/api/health', { Origin: DASHBOARD_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
  });

  it('refuses other browser origins, even with a valid session', async () => {
    const res = await rawRequest('/api/profiles', { Origin: 'https://evil.example', Authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for the dashboard origin', async () => {
    const res = await rawRequest('/api/health', { Origin: DASHBOARD_ORIGIN, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    expect(res.status).toBe(204);
  });
});

describe('WebSocket baseline', () => {
  it('greets an authenticated client with hello', async () => {
    const socket = await openSocket(h, token, { origin: DASHBOARD_ORIGIN });
    socket.ws.close();
  });

  it('identifies the user from the session in hello', async () => {
    const socket = await openSocket(h, token);
    socket.ws.close();
    const session = await h.call('GET', '/api/auth/session', { token });
    expect(serverMessageSchema.parse(socket.hello)).toMatchObject({ type: 'hello', version: '9.9.9-test', userId: session.body.user.id });
  });

  it('rejects connections from a foreign browser origin, even with a token', async () => {
    expect(await upgradeStatus(h, { origin: 'https://evil.example', headers: { Authorization: `Bearer ${token}` } })).toBe(403);
  });

  it('rejects connections without a session', async () => {
    expect(await upgradeStatus(h, { origin: DASHBOARD_ORIGIN })).toBe(401);
    expect(await upgradeStatus(h, {})).toBe(401);
  });

  it('rejects non-loopback Host headers', async () => {
    expect(await upgradeStatus(h, { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } })).toBe(403);
  });

  it('rejects unknown upgrade paths', async () => {
    expect(await upgradeStatus(h, { headers: { Authorization: `Bearer ${token}` } }, '/other')).toBe(404);
  });
});
