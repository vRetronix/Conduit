import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORMS, type PlatformConnectionSummary } from '@conduit/shared';
import { auditActions, createHarness, LOCAL_KEY, upgradeStatus, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const list = () => h.call<PlatformConnectionSummary[]>('GET', '/api/connections');

/** Simulates a verified connection stored by a (future) real integration. */
function insertConnection(platform: string, name: string, status = 'connected', lastError: string | null = null) {
  h.db
    .prepare(
      `INSERT INTO platform_connections (id, platform, external_account_id, account_name, status, last_error, connected_at, last_verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    )
    .run(`${platform}-${name}`, platform, `ext-${name}`, name, status, lastError);
}

describe('connection state (no CONDUIT account needed)', () => {
  it('works on a fresh install with no CONDUIT account at all', async () => {
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.platform)).toEqual([...PLATFORMS]);
  });

  it('reports every platform as Not Connected, with authorization not yet available', async () => {
    for (const c of (await list()).body) {
      expect(c).toMatchObject({ status: 'not_connected', account: null, additionalAccounts: 0, authorizationAvailable: false, pending: false, lastAttempt: null, problem: null });
      // Discord is implemented but needs the user's own application first (the setup wizard).
      // Discord and Kick are implemented but need the user's own app first; the others are not implemented yet.
      expect(c.unavailableReason).toMatch(
        c.platform === 'discord' ? /Select Connect to start the setup/ : c.platform === 'kick' ? /Kick isn't set up yet/ : /not been implemented/,
      );
    }
  });

  it('never treats a Discord user connection as a bot installation', async () => {
    insertConnection('discord', 'retro#1');
    const discord = (await list()).body.find((c) => c.platform === 'discord')!;
    expect(discord.status).toBe('connected');
    // Installation is reported only by the Discord setup state, from Discord itself.
    const setup = await h.call('GET', '/api/discord/setup');
    expect(setup.body.installation.status).not.toBe('installed');
    expect(setup.body.installation.guilds).toEqual([]);
  });

  it('reflects verified connections from the database, and only those', async () => {
    insertConnection('twitch', 'RetroLive');
    insertConnection('twitch', 'RetroAlt');
    insertConnection('kick', 'expired', 'needs_reauth');
    insertConnection('youtube', 'broken', 'error', 'YouTube rejected the stored authorization.');
    const byPlatform = Object.fromEntries((await list()).body.map((c) => [c.platform, c]));
    expect(byPlatform.twitch).toMatchObject({ status: 'connected', account: { id: 'ext-RetroLive', name: 'RetroLive' }, additionalAccounts: 1, problem: null });
    expect(byPlatform.kick).toMatchObject({ status: 'not_connected', account: null, problem: expect.stringMatching(/expired or was revoked/) });
    expect(byPlatform.youtube).toMatchObject({ status: 'not_connected', problem: 'YouTube rejected the stored authorization.' });
    expect(byPlatform.discord).toMatchObject({ status: 'not_connected' });
  });

  it('connect reports honestly that authorization is not implemented, and stores nothing', async () => {
    for (const platform of PLATFORMS.filter((p) => p !== 'discord' && p !== 'kick')) {
      const res = await h.call('POST', `/api/connections/${platform}/connect`);
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('not_implemented');
      expect(res.body.error.message).toMatch(/not available yet/);
    }
    const kick = await h.call('POST', '/api/connections/kick/connect');
    expect(kick.status).toBe(503);
    expect(kick.body.error).toMatchObject({ code: 'not_configured', message: expect.stringMatching(/Kick isn't set up yet/) });
    const discord = await h.call('POST', '/api/connections/discord/connect');
    expect(discord.status).toBe(503);
    expect(discord.body.error).toMatchObject({ code: 'not_configured', message: expect.stringMatching(/Select Connect to start the setup/) });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM platform_connections').get()).toEqual({ n: 0 });
    expect((await list()).body.every((c) => c.status === 'not_connected')).toBe(true);
  });

  it('disconnect removes a connection and audits it; disconnecting nothing is a 404', async () => {
    expect((await h.call('POST', '/api/connections/twitch/disconnect')).status).toBe(404);
    insertConnection('twitch', 'RetroLive');
    expect((await h.call('POST', '/api/connections/twitch/disconnect')).status).toBe(200);
    expect((await list()).body.find((c) => c.platform === 'twitch')!.status).toBe('not_connected');
    const audit = auditActions(h).find((a) => a.action === 'connection.removed')!;
    expect(audit.actorUserId).toBeNull();
    expect(JSON.parse(audit.metadata)).toEqual({ platform: 'twitch', role: 'primary', revokedAtPlatform: false });
  });

  it('rejects unknown platforms', async () => {
    expect((await h.call('POST', '/api/connections/myspace/connect')).status).toBe(400);
    expect((await h.call('POST', '/api/connections/DISCORD/connect')).status).toBe(400);
  });
});

describe('local access protection (no CONDUIT login)', () => {
  it('refuses API calls without the local access key', async () => {
    for (const [method, path] of [
      ['GET', '/api/connections'],
      ['POST', '/api/connections/kick/connect'],
      ['POST', '/api/connections/kick/disconnect'],
      ['GET', '/api/setup/status'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/profiles'],
    ] as const) {
      const res = await h.call(method, path, { withoutLocalKey: true, ...(method === 'POST' ? { body: {} } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.message).toBe('Local access key required');
    }
  });

  it('refuses a wrong local access key', async () => {
    const res = await h.call('GET', '/api/connections', { withoutLocalKey: true, headers: { 'X-CONDUIT-Local-Key': `${LOCAL_KEY}x` } });
    expect(res.status).toBe(401);
  });

  it('keeps the health probe available without the key', async () => {
    expect((await h.call('GET', '/api/health', { withoutLocalKey: true })).status).toBe(200);
  });

  it('refuses a web page even if it somehow had the key (Origin and Host checks still apply)', async () => {
    expect((await h.call('GET', '/api/connections', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('refuses WebSocket upgrades without the key', async () => {
    expect(await upgradeStatus(h, {}, '/ws', false)).toBe(401);
  });

  it('still refuses the dormant account API without a CONDUIT session, even with the key', async () => {
    expect((await h.call('GET', '/api/profiles')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/users')).status).toBe(401);
  });
});
