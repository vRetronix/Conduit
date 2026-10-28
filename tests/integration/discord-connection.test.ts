/**
 * End-to-end Discord connection flow against a simulated Discord (automated, mocked — no live Discord):
 * API → authorization URL → browser redirect to the real loopback callback listener → token exchange → identity →
 * encrypted vault + database → dashboard status.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DisconnectResult, PlatformConnectionSummary } from '@conduit/shared';
import { DiscordAdapter } from '../../apps/server/src/discord/discord';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { auditActions, createHarness, setupOwner, type Harness } from '../helpers/harness';

let h: Harness;
let discord: FakeDiscord;
let vault: MemoryVault;

/** null = not configured. The adapter shares the harness clock so token expiry follows simulated time. */
async function harness(clientId: string | null = CLIENT_ID, clientSecret: string | null = CLIENT_SECRET) {
  discord = new FakeDiscord();
  vault = new MemoryVault();
  const adapter = new DiscordAdapter({
    credentials: async () => (clientId && clientSecret ? { clientId, clientSecret } : null),
    version: '9.9.9',
    fetch: discord.fetch,
    now: () => h.clock.now(),
  });
  h = await createHarness({}, { adapters: { discord: adapter }, vault });
}
beforeEach(() => harness());
afterEach(async () => {
  await h.close();
});

const card = async () => (await h.call<PlatformConnectionSummary[]>('GET', '/api/connections')).body.find((c) => c.platform === 'discord')!;

/** Starts an authorization; returns the parsed authorization URL. */
async function start(): Promise<URL> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/discord/connect');
  expect(res.status).toBe(200);
  return new URL(res.body.authorizationUrl);
}

/** What the browser does after the user decides on Discord's page. */
async function browserReturns(authUrl: URL, params: Record<string, string>): Promise<{ status: number; html: string }> {
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
  for (const [k, v] of Object.entries(params)) callback.searchParams.set(k, v);
  const res = await fetch(callback);
  return { status: res.status, html: await res.text() };
}

async function approve(authUrl: URL) {
  const code = discord.issueCode(authUrl.searchParams.get('redirect_uri')!);
  return { code, ...(await browserReturns(authUrl, { code, state: authUrl.searchParams.get('state')! })) };
}

describe('Discord connection (mocked Discord)', () => {
  it('is Not Connected and ready to connect when configured', async () => {
    expect(await card()).toMatchObject({ status: 'not_connected', authorizationAvailable: true, unavailableReason: null, pending: false, account: null });
  });

  it('connects after approval: identity confirmed, tokens only in the vault, status Connected', async () => {
    const authUrl = await start();
    expect(authUrl.searchParams.get('scope')).toBe('identify');
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/discord\/callback$/);
    expect(await card()).toMatchObject({ pending: true, status: 'not_connected' });

    const { status, html } = await approve(authUrl);
    expect(status).toBe(200);
    expect(html).toContain('Discord connected');
    expect(html).toContain('Retro Live');

    expect(await card()).toMatchObject({
      status: 'connected',
      pending: false,
      lastAttempt: null,
      account: { id: discord.user.id, name: 'Retro Live', handle: 'retro_live', avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
    });

    // Tokens are in the encrypted vault, never in SQLite.
    const [key, stored] = [...vault.entries][0]!;
    expect(key).toMatch(/^connection:[0-9a-f-]{36}$/);
    expect(JSON.parse(stored!)).toMatchObject({ accessToken: expect.stringMatching(/^access-token/), refreshToken: expect.stringMatching(/^refresh-token/) });
    const dbDump = JSON.stringify(h.db.prepare('SELECT * FROM platform_connections').all());
    expect(dbDump).not.toMatch(/access-token|refresh-token|SECRET/);
    expect(JSON.parse(h.db.prepare('SELECT granted_scopes AS s FROM platform_connections').get()!.s as string)).toEqual(['identify']);
    expect(auditActions(h).map((a) => a.action)).toContain('connection.created');
  });

  it('never treats the Discord account connection as a bot installation', async () => {
    await approve(await start());
    const c = await card();
    expect(c.status).toBe('connected');
    const setup = (await h.call('GET', '/api/discord/setup')).body;
    expect(setup.account.connected).toBe(true);
    expect(setup.installation.status).not.toBe('installed');
    expect(setup.bot.status).not.toBe('connected');
  });

  it('closes the callback listener when nothing is pending', async () => {
    const authUrl = await start();
    await approve(authUrl);
    await expect(fetch(authUrl.searchParams.get('redirect_uri')!)).rejects.toThrow();
  });

  it('rejects a callback with a missing or forged state without using the code', async () => {
    const authUrl = await start();
    const code = discord.issueCode(authUrl.searchParams.get('redirect_uri')!);
    const tokenCallsBefore = discord.requests.length;
    expect((await browserReturns(authUrl, { code })).status).toBe(400);
    expect((await browserReturns(authUrl, { code, state: 'forged-state-value' })).status).toBe(400);
    expect(discord.requests.length).toBe(tokenCallsBefore);
    // The genuine authorization is still pending and still works.
    expect(await card()).toMatchObject({ pending: true });
    expect((await browserReturns(authUrl, { code, state: authUrl.searchParams.get('state')! })).status).toBe(200);
  });

  it('rejects a replayed redirect (same state and code used twice)', async () => {
    const authUrl = await start();
    const first = await approve(authUrl);
    expect(first.status).toBe(200);
    // Re-open the listener with a new authorization, then replay the old redirect against it.
    const next = await start();
    const replay = await browserReturns(next, { code: first.code, state: authUrl.searchParams.get('state')! });
    expect(replay.status).toBe(400);
    expect(replay.html).toContain('already used');
  });

  it('reports the user cancelling on Discord\'s page, and allows retrying', async () => {
    const authUrl = await start();
    const page = await browserReturns(authUrl, { error: 'access_denied', state: authUrl.searchParams.get('state')! });
    expect(page.html).toContain('cancelled');
    expect(await card()).toMatchObject({
      status: 'not_connected',
      pending: false,
      lastAttempt: { outcome: 'cancelled', message: expect.stringContaining('Select Connect to try again') },
    });
    // Retry clears the failure and succeeds.
    const retry = await start();
    expect((await card()).lastAttempt).toBeNull();
    await approve(retry);
    expect((await card()).status).toBe('connected');
  });

  it('reports an invalid or expired code', async () => {
    const authUrl = await start();
    const page = await browserReturns(authUrl, { code: 'expired-or-invalid', state: authUrl.searchParams.get('state')! });
    expect(page.status).toBe(400);
    expect(await card()).toMatchObject({ status: 'not_connected', lastAttempt: { outcome: 'failed', message: expect.stringMatching(/invalid or had expired/) } });
    expect(vault.entries.size).toBe(0);
  });

  it('reports rejected client credentials and unreachable Discord', async () => {
    await h.close();
    await harness(CLIENT_ID, 'wrong-secret-wrong-secret');
    let authUrl = await start();
    await approve(authUrl);
    expect((await card()).lastAttempt?.message).toMatch(/rejected your application's credentials/);

    discord.offline = true;
    authUrl = await start();
    await browserReturns(authUrl, { code: 'whatever', state: authUrl.searchParams.get('state')! });
    expect((await card()).lastAttempt?.message).toMatch(/couldn't reach Discord/);
  });

  it('does not connect when Discord did not grant the identify scope', async () => {
    discord.grantedScope = '';
    await approve(await start());
    expect(await card()).toMatchObject({ status: 'not_connected', lastAttempt: { outcome: 'failed' } });
    expect(vault.entries.size).toBe(0);
  });

  it('lets the user cancel a pending authorization from the dashboard', async () => {
    const authUrl = await start();
    expect((await h.call('POST', '/api/connections/discord/cancel')).status).toBe(204);
    expect(await card()).toMatchObject({ pending: false, lastAttempt: { outcome: 'cancelled' } });
    expect((await h.call('POST', '/api/connections/discord/cancel')).status).toBe(404);
    // The cancelled state can no longer be used.
    await expect(browserReturns(authUrl, { code: 'x', state: authUrl.searchParams.get('state')! })).rejects.toThrow();
  });

  it('times out an authorization the user never finished', async () => {
    const authUrl = await start();
    h.clock.advance(10 * 60_000 + 1);
    expect(await card()).toMatchObject({ pending: false, lastAttempt: { outcome: 'failed', message: expect.stringMatching(/10 minutes/) } });
    await expect(browserReturns(authUrl, { code: 'x', state: authUrl.searchParams.get('state')! })).rejects.toThrow();
  });

  it('disconnect revokes at Discord, deletes the credentials and updates the status', async () => {
    await approve(await start());
    const res = await h.call<DisconnectResult>('POST', '/api/connections/discord/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedAtPlatform: true, message: null });
    expect(discord.revoked).toBe(1);
    expect(new URLSearchParams(discord.requests.at(-1)!.body).get('token_type_hint')).toBe('refresh_token');
    expect(vault.entries.size).toBe(0);
    expect(await card()).toMatchObject({ status: 'not_connected', account: null });
    expect(JSON.parse(auditActions(h).find((a) => a.action === 'connection.removed')!.metadata)).toEqual({ platform: 'discord', role: 'primary', revokedAtPlatform: true });
  });

  it('still removes local credentials when Discord cannot be reached to revoke', async () => {
    await approve(await start());
    discord.offline = true;
    const res = await h.call<DisconnectResult>('POST', '/api/connections/discord/disconnect');
    expect(res.body.revokedAtPlatform).toBe(false);
    expect(res.body.message).toMatch(/authorized apps/);
    expect(vault.entries.size).toBe(0);
    expect((await card()).status).toBe('not_connected');
  });

  it('reconnects the same account without duplicating it', async () => {
    await approve(await start());
    await approve(await start());
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM platform_connections').get()).toEqual({ n: 1 });
    expect(vault.entries.size).toBe(1);
    expect((await card()).additionalAccounts).toBe(0);
  });

  it('background check refreshes an expiring token and keeps the connection', async () => {
    await approve(await start());
    const before = JSON.parse([...vault.entries.values()][0]!);
    h.clock.advance(7 * 24 * 60 * 60_000); // past expires_in
    await h.services.connections.verifyAll();
    const after = JSON.parse([...vault.entries.values()][0]!);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect((await card()).status).toBe('connected');
  });

  it('marks a revoked authorization as needing reconnection and deletes the useless tokens', async () => {
    await approve(await start());
    discord.revokeAllExternally(); // user removed CONDUIT under Discord's Authorized Apps
    await h.services.connections.verifyAll();
    expect(await card()).toMatchObject({ status: 'not_connected', account: null, problem: expect.stringMatching(/expired or was revoked/) });
    expect(vault.entries.size).toBe(0);
    expect(auditActions(h).map((a) => a.action)).toContain('connection.expired');
    // Reconnecting restores it; disconnecting a needs-reauth row needs no revocation.
    await approve(await start());
    expect((await card()).status).toBe('connected');
  });

  it('leaves the status unchanged when Discord is temporarily unreachable during a check', async () => {
    await approve(await start());
    discord.offline = true;
    await h.services.connections.verifyAll();
    expect((await card()).status).toBe('connected');
  });

  it('marks the connection for reconnection if its stored credentials are missing', async () => {
    await approve(await start());
    vault.entries.clear();
    await h.services.connections.verifyAll();
    expect(await card()).toMatchObject({ status: 'not_connected', problem: expect.stringMatching(/no longer has the stored Discord credentials/) });
  });

  it('never writes codes, tokens or the client secret to the logs', async () => {
    const authUrl = await start();
    const { code } = await approve(authUrl);
    const tokens = JSON.parse([...vault.entries.values()][0]!);
    await h.services.connections.verifyAll();
    await h.call('POST', '/api/connections/discord/disconnect');
    const log = fs.readFileSync(h.logFile, 'utf8');
    for (const secret of [code, tokens.accessToken, tokens.refreshToken, CLIENT_SECRET, authUrl.searchParams.get('state')!]) {
      expect(log).not.toContain(secret);
    }
    expect(log).toContain('platform connected');
  });

  it('leaves the dormant account and profile data untouched', async () => {
    const owner = await setupOwner(h);
    const snapshot = () => JSON.stringify(['users', 'sessions', 'streamer_profiles', 'profile_memberships'].map((t) => h.db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    await approve(await start());
    await h.call('POST', '/api/connections/discord/disconnect');
    expect(snapshot()).toBe(before);
    expect(owner.user.username).toBe('owner');
  });
});

describe('Discord not configured / no secure storage', () => {
  it('explains exactly what to configure and starts nothing', async () => {
    await h.close();
    await harness(null, null);
    expect(await card()).toMatchObject({ authorizationAvailable: false, unavailableReason: expect.stringContaining('Select Connect to start the setup') });
    const res = await h.call('POST', '/api/connections/discord/connect');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'not_configured', message: expect.stringContaining('Select Connect to start the setup') });
  });

  it('refuses to connect without OS-backed credential storage (standalone server)', async () => {
    await h.close();
    discord = new FakeDiscord();
    h = await createHarness({}, { adapters: { discord: new DiscordAdapter({ credentials: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), version: '1', fetch: discord.fetch }) } });
    expect((await card()).unavailableReason).toMatch(/Secure credential storage needs the CONDUIT desktop app/);
    expect((await h.call('POST', '/api/connections/discord/connect')).status).toBe(503);
  });
});
