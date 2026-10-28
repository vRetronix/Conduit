/**
 * Kick connections end to end against a simulated Kick (automated, mocked — no live Kick): app credentials,
 * the streamer's account (primary role), an optional separate chatbot account (bot role), refresh and disconnect.
 * The browser redirect goes to CONDUIT's real loopback callback listener at http://localhost:<port>.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KickSetupState, PlatformConnectionSummary } from '@conduit/shared';
import { validateAuthorizationUrl } from '../../apps/desktop/src/oauth-launch';
import { KICK_CLIENT_SECRET_KEY } from '../../apps/server/src/kick/kick-credentials';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { AVATAR_BYTES, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let kick: FakeKick;
let vault: MemoryVault;

beforeEach(async () => {
  kick = new FakeKick();
  vault = new MemoryVault();
  h = await createHarness({}, { vault, fetch: kick.fetch });
});
afterEach(async () => {
  await h.close();
});

const state = async () => (await h.call<KickSetupState>('GET', '/api/kick/setup')).body;
const saveApp = (body: unknown) => h.call<any>('POST', '/api/kick/application', { body });
const connections = () => vault.entries.size - (vault.entries.has(KICK_CLIENT_SECRET_KEY) ? 1 : 0);

async function configured(): Promise<void> {
  expect((await saveApp({ clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET })).status).toBe(200);
}

async function start(role: 'primary' | 'bot' = 'primary') {
  return h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
}

/** Start an authorization and complete it in the "browser" as `who`. */
async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<{ status: number; html: string; url: URL }> {
  const res = await start(role);
  expect(res.status).toBe(200);
  const url = new URL(res.body.authorizationUrl);
  const back = kick.approve(url, who);
  const page = await fetch(back);
  return { status: page.status, html: await page.text(), url };
}

describe('Kick app credentials', () => {
  it('is honestly not set up at first, and refuses to connect', async () => {
    expect(await state()).toMatchObject({
      application: { configured: false, clientId: null, clientSecretStored: false },
      primary: { status: 'not_connected' },
      bot: { status: 'not_connected' },
      chatbot: { mode: 'primary', account: null, ready: false },
      redirectUri: expect.stringMatching(/^http:\/\/localhost:\d+\/oauth\/kick\/callback$/),
      // Default chatbot choice is the main account, so it also asks to send chat messages.
      scopes: { primary: ['user:read', 'channel:read', 'events:subscribe', 'channel:rewards:write', 'moderation:ban', 'moderation:chat_message:manage', 'channel:write', 'chat:write'], bot: ['user:read', 'chat:write'] },
    });
    expect((await start()).status).toBe(503);
  });

  it('checks the Client ID and Secret with Kick before saving, and reports the failing field', async () => {
    const bad = await saveApp({ clientId: KICK_CLIENT_ID, clientSecret: 'wrong-secret-wrong-secret' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues).toEqual([
      { path: 'clientSecret', message: expect.stringMatching(/rejected this Client ID and Client Secret/) },
    ]);
    expect(vault.entries.size).toBe(0);
    expect((await state()).application.configured).toBe(false);

    kick.offline = true;
    expect((await saveApp({ clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET })).status).toBe(503);
    kick.offline = false;
    expect((await saveApp({ clientId: 'bad id!', clientSecret: KICK_CLIENT_SECRET })).status).toBe(400);
  });

  it('stores the secret only in the vault and never returns it; the probe token is revoked', async () => {
    const res = await saveApp({ clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET });
    expect(res.body.application).toEqual({ configured: true, clientId: KICK_CLIENT_ID, clientSecretStored: true });
    expect(JSON.stringify(res.body)).not.toContain(KICK_CLIENT_SECRET);
    expect(vault.entries.get(KICK_CLIENT_SECRET_KEY)).toBe(KICK_CLIENT_SECRET);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM app_settings').all())).not.toContain(KICK_CLIENT_SECRET);
    expect(kick.revoked).toEqual(['access_token']);
    // Same Client ID without a secret keeps the stored one.
    expect((await saveApp({ clientId: KICK_CLIENT_ID })).status).toBe(200);
  });
});

describe('Kick main account (primary role)', () => {
  beforeEach(configured);

  it('builds the documented authorization URL: PKCE S256, minimal scopes, localhost redirect', async () => {
    const url = new URL((await start()).body.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://id.kick.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: KICK_CLIENT_ID,
      response_type: 'code',
      scope: 'user:read channel:read events:subscribe channel:rewards:write moderation:ban moderation:chat_message:manage channel:write chat:write',
      code_challenge_method: 'S256',
      redirect_uri: expect.stringMatching(/^http:\/\/localhost:\d+\/oauth\/kick\/callback$/),
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(40);
    // The desktop accepts exactly this.
    expect(validateAuthorizationUrl('kick', url.toString())).not.toBeNull();
    expect((await state()).primary.pending).toBe(true);
  });

  it('connects: identity from Kick, avatar, channel slug, tokens only in the vault', async () => {
    const { status, html } = await connect(kick.users.streamer);
    expect(status).toBe(200);
    expect(html).toContain('RetroLive');
    const s = await state();
    expect(s.primary).toMatchObject({
      status: 'connected',
      userId: '4242001',
      name: 'RetroLive',
      handle: 'retrolive',
      avatarDataUrl: `data:image/webp;base64,${AVATAR_BYTES.toString('base64')}`,
      scopes: ['user:read', 'channel:read', 'events:subscribe', 'channel:rewards:write', 'moderation:ban', 'moderation:chat_message:manage', 'channel:write', 'chat:write'],
      pending: false,
      problem: null,
    });
    expect(s.chatbot).toMatchObject({ mode: 'primary', account: 'primary', ready: true });
    const card = (await h.call<PlatformConnectionSummary[]>('GET', '/api/connections')).body.find((c) => c.platform === 'kick')!;
    expect(card).toMatchObject({ status: 'connected', account: { name: 'RetroLive' } });
    // The PKCE verifier and client secret went to the token endpoint in the form body.
    const exchange = kick.requests.find((r) => r.url.endsWith('/oauth/token') && r.body.includes('authorization_code'))!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(connections()).toBe(1);
  });

  it('rejects a forged or replayed redirect without using the code', async () => {
    const res = await start();
    const url = new URL(res.body.authorizationUrl);
    const back = kick.approve(url, kick.users.streamer);
    const forged = new URL(back);
    forged.searchParams.set('state', 'forged');
    expect((await fetch(forged)).status).toBe(400);
    expect(kick.requests.some((r) => r.body.includes('authorization_code'))).toBe(false);
    expect((await fetch(back)).status).toBe(200);
    // The state is single-use (and the listener may already be closed).
    const replay = await fetch(back)
      .then((r) => r.status)
      .catch(() => 0);
    expect([0, 400]).toContain(replay);
  });

  it('does not connect without a required scope; accepts a token response that omits the scope list', async () => {
    kick.grantOnly = ['user:read'];
    await connect(kick.users.streamer);
    expect((await state()).primary).toMatchObject({ status: 'not_connected', problem: expect.stringMatching(/didn't confirm/) });
    kick.grantOnly = null;
    kick.omitScope = true;
    await connect(kick.users.streamer);
    expect((await state()).primary.status).toBe('connected');
  });

  it('refreshes before expiry (rotating the refresh token) and stays connected', async () => {
    await connect(kick.users.streamer);
    h.clock.advance(3600 * 1000);
    await h.services.connections.verifyAll();
    expect((await state()).primary.status).toBe('connected');
    expect(kick.requests.some((r) => r.body.includes('grant_type=refresh_token'))).toBe(true);
  });

  it('shows Reconnect instead of Connected when Kick no longer accepts the authorization', async () => {
    await connect(kick.users.streamer);
    kick.revokeAllFor(kick.users.streamer);
    h.clock.advance(3600 * 1000);
    await h.services.connections.verifyAll();
    const s = await state();
    expect(s.primary).toMatchObject({ status: 'needs_reauth', problem: expect.stringMatching(/Reconnect/) });
    expect(connections()).toBe(0); // useless tokens deleted
  });

  it('disconnect revokes at Kick (query parameters) and leaves Discord untouched', async () => {
    h.db
      .prepare(
        `INSERT INTO platform_connections (id, platform, external_account_id, account_name, status, connected_at, updated_at) VALUES ('d1', 'discord', '1', 'D', 'connected', 'x', 'x')`,
      )
      .run();
    await vault.set('connection:d1', '{"accessToken":"discord-token"}');
    await connect(kick.users.streamer);
    const res = await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'primary' } });
    expect(res.status).toBe(200);
    const revoke = kick.requests.find(
      (r) => r.url.startsWith('https://id.kick.com/oauth/revoke') && r.url.includes('token_hint_type=refresh_token'),
    );
    expect(revoke).toBeDefined();
    expect((await state()).primary.status).toBe('not_connected');
    expect(vault.entries.get('connection:d1')).toBe('{"accessToken":"discord-token"}');
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM platform_connections WHERE platform = 'discord'").get()).toEqual({ n: 1 });
  });
});

describe('Kick chatbot account (optional bot role)', () => {
  beforeEach(async () => {
    await configured();
    await connect(kick.users.streamer);
  });

  it('Option A: the main account is the chatbot by default; nothing else is required', async () => {
    const s = await state();
    expect(s.chatbot).toMatchObject({
      mode: 'primary',
      account: 'primary',
      ready: true,
      note: expect.stringMatching(/Messages are sent as RetroLive to retrolive's chat/),
    });
    expect(s.bot.status).toBe('not_connected');
  });

  it('Option B: choosing a separate account shows Add Bot Account state, not an error or fake connection', async () => {
    const s = (await h.call<KickSetupState>('POST', '/api/kick/chatbot', { body: { mode: 'separate' } })).body;
    expect(s.chatbot).toMatchObject({ mode: 'separate', account: null, note: expect.stringMatching(/Add a bot account/) });
    expect(s.bot).toMatchObject({ status: 'not_connected', problem: null });
    expect((await h.call('POST', '/api/kick/chatbot', { body: { mode: 'everyone' } })).status).toBe(400);
  });

  it('connects a separate bot account with its own scopes and credentials, without touching the main account', async () => {
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    const primaryBefore = (await state()).primary;
    const tokensBefore = [...vault.entries.entries()].filter(([k]) => k.startsWith('connection:'));

    const { html, url } = await connect(kick.users.bot, 'bot');
    expect(url.searchParams.get('scope')).toBe('user:read chat:write');
    expect(html).toContain('chatbot account');
    const s = await state();
    expect(s.bot).toMatchObject({ status: 'connected', name: 'RetroBotKick', scopes: ['user:read', 'chat:write'], avatarDataUrl: null, handle: null });
    expect(s.primary).toEqual(primaryBefore);
    expect(s.chatbot.account).toBe('bot');
    // Separate credentials; the main account's tokens are unchanged.
    expect(connections()).toBe(2);
    for (const [k, v] of tokensBefore) expect(vault.entries.get(k)).toBe(v);
    const roles = h.db.prepare("SELECT role, account_name AS n FROM platform_connections WHERE platform = 'kick' ORDER BY role").all();
    expect(roles).toEqual([
      { role: 'bot', n: 'RetroBotKick' },
      { role: 'primary', n: 'RetroLive' },
    ]);
  });

  it('refuses to use the main account as the separate bot (and revokes that extra grant)', async () => {
    const { html } = await connect(kick.users.streamer, 'bot');
    expect(html).toContain('main Kick account');
    const s = await state();
    expect(s.bot).toMatchObject({ status: 'not_connected', problem: expect.stringMatching(/That's your main Kick account/) });
    expect(s.primary.status).toBe('connected');
    expect(connections()).toBe(1);
  });

  it('a bot account needs the main account first', async () => {
    await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'primary' } });
    const res = await start('bot');
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { message: string } }).error.message).toMatch(/Connect your main Kick account first/);
  });

  it('replacing the bot account removes and revokes the previous one only', async () => {
    await connect(kick.users.bot, 'bot');
    await connect(kick.users.otherBot, 'bot');
    const s = await state();
    expect(s.bot.name).toBe('SecondBot');
    expect(s.primary.status).toBe('connected');
    expect(connections()).toBe(2);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM platform_connections WHERE platform = 'kick' AND role = 'bot'").get()).toEqual({ n: 1 });
  });

  it('disconnecting the bot account leaves the main account connected, and vice versa', async () => {
    await connect(kick.users.bot, 'bot');
    expect((await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'bot' } })).status).toBe(200);
    let s = await state();
    expect(s.bot.status).toBe('not_connected');
    expect(s.primary.status).toBe('connected');

    await connect(kick.users.bot, 'bot');
    expect((await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'primary' } })).status).toBe(200);
    s = await state();
    expect(s.primary.status).toBe('not_connected');
    expect(s.bot.status).toBe('connected');
  });

  it('a pending bot authorization is separate from the main account and can be cancelled', async () => {
    await start('bot');
    let s = await state();
    expect(s.bot.pending).toBe(true);
    expect(s.primary.pending).toBe(false);
    expect((await h.call('POST', '/api/connections/kick/cancel', { body: { role: 'bot' } })).status).toBe(204);
    s = await state();
    expect(s.bot).toMatchObject({ pending: false, problem: expect.stringMatching(/cancelled/) });
  });

  it('a bot authorization that expires shows Reconnect for the bot only', async () => {
    await connect(kick.users.bot, 'bot');
    kick.revokeAllFor(kick.users.bot);
    h.clock.advance(3600 * 1000);
    await h.services.connections.verifyAll();
    const s = await state();
    expect(s.bot.status).toBe('needs_reauth');
    expect(s.primary.status).toBe('connected');
  });

  it('never exposes tokens or the client secret in responses, the database or logs', async () => {
    await connect(kick.users.bot, 'bot');
    const tokens = [...vault.entries.entries()]
      .filter(([k]) => k.startsWith('connection:'))
      .flatMap(([, v]) => {
        const t = JSON.parse(v) as { accessToken: string; refreshToken: string | null };
        return [t.accessToken, t.refreshToken].filter((x): x is string => Boolean(x));
      });
    expect(tokens.length).toBeGreaterThanOrEqual(4);
    const everything = [
      JSON.stringify(await state()),
      JSON.stringify((await h.call('GET', '/api/connections')).body),
      JSON.stringify(h.db.prepare('SELECT * FROM platform_connections').all()),
      JSON.stringify(h.db.prepare('SELECT * FROM app_settings').all()),
      JSON.stringify(auditActions(h)),
      fs.readFileSync(h.logFile, 'utf8'),
    ].join('\n');
    for (const secret of [...tokens, KICK_CLIENT_SECRET, 'STREAM-KEY-MUST-NOT-LEAK', 'must-not-be-used@example.com'])
      expect(everything).not.toContain(secret);
  });
});
