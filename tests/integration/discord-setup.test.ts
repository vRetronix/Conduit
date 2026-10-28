/**
 * The Discord setup wizard end to end against a simulated Discord (REST + gateway; automated, no live Discord):
 * application credentials → account sign-in → adding the bot to a server → the bot's gateway connection.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordSetupState } from '@conduit/shared';
import { validateBotInstallUrl } from '../../apps/desktop/src/oauth-launch';
import { BOT_TOKEN_KEY, CLIENT_SECRET_KEY } from '../../apps/server/src/discord/discord-credentials';
import { MemoryVault, UnavailableVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;
let vault: MemoryVault;

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  vault = new MemoryVault();
  h = await createHarness({}, { vault, fetch: discord.fetch, botFactory: gateway.factory });
});
afterEach(async () => {
  await h.close();
});

const VALID = { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN };

const setup = async () => (await h.call<DiscordSetupState>('GET', '/api/discord/setup')).body;
const save = (body: unknown) => h.call<any>('POST', '/api/discord/application', { body });

/** Polls the setup state until `ok` holds (gateway events arrive asynchronously). */
async function until(ok: (s: DiscordSetupState) => boolean, timeoutMs = 2000): Promise<DiscordSetupState> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await setup();
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`state never matched: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function connectAccount(): Promise<void> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/discord/connect');
  expect(res.status).toBe(200);
  const url = new URL(res.body.authorizationUrl);
  const redirect = url.searchParams.get('redirect_uri')!;
  const back = new URL(redirect);
  back.searchParams.set('code', discord.issueCode(redirect));
  back.searchParams.set('state', url.searchParams.get('state')!);
  expect((await fetch(back)).status).toBe(200);
}

async function startInstall(): Promise<URL> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/discord/install');
  expect(res.status).toBe(200);
  return new URL(res.body.authorizationUrl);
}

async function installReturns(url: URL, params: Record<string, string>): Promise<{ status: number; html: string }> {
  const back = new URL(url.searchParams.get('redirect_uri')!);
  for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
  const res = await fetch(back);
  return { status: res.status, html: await res.text() };
}

describe('Discord setup: initial state', () => {
  it('starts at the application step with every status honestly unset', async () => {
    expect(await setup()).toMatchObject({
      nextStep: 'application',
      application: { configured: false, applicationId: null, clientSecretStored: false, botTokenStored: false },
      account: { connected: false },
      bot: { status: 'not_configured' },
      installation: { status: 'unknown', guilds: [] },
      redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/discord\/callback$/),
      installPermissions: '1099780320502',
      intents: [
        { name: 'Guilds', privileged: false },
        { name: 'Guild Messages', privileged: false },
        { name: 'Guild Moderation', privileged: false },
        { name: 'Server Members', privileged: true },
        { name: 'Message Content', privileged: true },
        { name: 'Presence', privileged: true },
      ],
    });
    // Nothing is attempted against Discord before the user saves an application.
    expect(discord.requests).toHaveLength(0);
    expect(gateway.logins).toBe(0);
  });

  it('refuses account sign-in and bot install until the application is configured', async () => {
    expect((await h.call('POST', '/api/connections/discord/connect')).status).toBe(503);
    const install = await h.call('POST', '/api/discord/install');
    expect(install.status).toBe(503);
    expect(install.body.error.code).toBe('not_configured');
  });
});

describe('Discord setup: application details', () => {
  it('rejects malformed fields with per-field messages, without echoing values or calling Discord', async () => {
    const res = await save({ applicationId: 'my-bot', clientSecret: 'zq9secret', botToken: 'zq9token' });
    expect(res.status).toBe(400);
    const paths = [...new Set(res.body.error.issues.map((i: { path: string }) => i.path))].sort();
    expect(paths).toEqual(['applicationId', 'botToken', 'clientSecret']);
    expect(JSON.stringify(res.body)).not.toMatch(/my-bot|zq9/);
    expect(discord.requests).toHaveLength(0);
    expect(vault.entries.size).toBe(0);
  });

  it('rejects unknown fields (strict input)', async () => {
    expect((await save({ ...VALID, clientId: CLIENT_ID })).status).toBe(400);
  });

  it('identifies a rejected bot token, and stores nothing', async () => {
    discord.validBotToken = 'something-else';
    const res = await save(VALID);
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: 'botToken', message: expect.stringMatching(/rejected this bot token.*Reset Token/) }]);
    expect(vault.entries.size).toBe(0);
    expect((await setup()).application.configured).toBe(false);
    expect(gateway.logins).toBe(0);
  });

  it('identifies a rejected Client Secret when the bot token proves the Application ID', async () => {
    const res = await save({ ...VALID, clientSecret: 'wrong-secret-wrong-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: 'clientSecret', message: expect.stringMatching(/rejected this Client Secret.*Reset Secret/) }]);
    expect(vault.entries.size).toBe(0);
  });

  it('identifies a bot token from a different application', async () => {
    discord.botApplication = { id: '999999999999999999', name: 'Someone Else', flags: 0 };
    const res = await save(VALID);
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: 'botToken', message: expect.stringMatching(/belongs to a different application \("Someone Else"/) }]);
  });

  it('identifies a wrong Application ID when the bot token belongs to another application and the pair is rejected', async () => {
    const res = await save({ ...VALID, applicationId: '111111111111111111' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: 'applicationId', message: expect.stringMatching(/doesn't match your bot token.*Retro Bot.*123456789012345678/) }]);
  });

  it('reports both credentials when both are rejected', async () => {
    discord.validBotToken = 'something-else';
    const res = await save({ ...VALID, clientSecret: 'wrong-secret-wrong-secret' });
    expect(res.body.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['botToken', 'clientSecret']);
  });

  it('reports Discord being unreachable or rate limiting as such, not as a bad credential', async () => {
    discord.offline = true;
    let res = await save(VALID);
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/couldn't reach Discord.*Nothing was saved/);
    expect(res.body.error.issues).toBeUndefined();
    discord.offline = false;
    discord.rateLimited = true;
    res = await save(VALID);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(vault.entries.size).toBe(0);
  });

  it('fails safely without OS-backed secure storage: nothing is validated or stored', async () => {
    await h.close();
    h = await createHarness({}, { vault: new UnavailableVault(), fetch: discord.fetch, botFactory: gateway.factory });
    const res = await save(VALID);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_configured');
    expect(discord.requests).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM discord_application').get()).toEqual({ n: 0 });
  });

  it('saves valid details: secrets only in the vault, separately; never in responses, SQLite or logs', async () => {
    const res = await save(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      nextStep: 'account',
      application: { configured: true, applicationId: CLIENT_ID, applicationName: 'Retro Bot', clientSecretStored: true, botTokenStored: true },
    });
    // Separate vault entries: the user-OAuth secret and the bot token are never mixed.
    expect(vault.entries.get(CLIENT_SECRET_KEY)).toBe(CLIENT_SECRET);
    expect(vault.entries.get(BOT_TOKEN_KEY)).toBe(BOT_TOKEN);

    const everything = [
      JSON.stringify(res.body),
      JSON.stringify(await setup()),
      JSON.stringify(h.db.prepare('SELECT * FROM discord_application').all()),
      JSON.stringify(h.db.prepare('SELECT * FROM audit_logs').all()),
      JSON.stringify(h.db.prepare('SELECT * FROM discord_guild_installations').all()),
      fs.readFileSync(h.logFile, 'utf8'),
    ].join('\n');
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toContain(BOT_TOKEN.split('.')[2]);
    expect(auditActions(h).map((a) => a.action)).toContain('discord.application.saved');
  });

  it('verifies the Application ID + Client Secret with the client credentials grant and revokes the probe token', async () => {
    await save(VALID);
    const grant = discord.requests.find((r) => r.url === 'https://discord.com/api/oauth2/token' && r.body.includes('client_credentials'));
    expect(grant).toBeDefined();
    expect(new URLSearchParams(grant!.body).get('scope')).toBe('identify');
    expect(discord.requests.some((r) => r.url.endsWith('/oauth2/token/revoke') && r.body.includes('client-credentials-'))).toBe(true);
    // The bot token is used only with the Bot authorization scheme, never sent to the OAuth token endpoint.
    for (const r of discord.requests) {
      if (r.headers.authorization?.startsWith('Bot ')) expect(r.url).toMatch(/^https:\/\/discord\.com\/api\/v10\//);
      else expect(r.body).not.toContain(BOT_TOKEN);
    }
  });

  it('replaces only the values given; blank secrets keep the stored ones for the same application', async () => {
    await save(VALID);
    const res = await save({ applicationId: CLIENT_ID });
    expect(res.status).toBe(200);
    expect(vault.entries.get(CLIENT_SECRET_KEY)).toBe(CLIENT_SECRET);
    const newToken = `${BOT_TOKEN.slice(0, -4)}NEW1`;
    discord.validBotToken = newToken;
    gateway.validToken = newToken;
    expect((await save({ applicationId: CLIENT_ID, botToken: newToken })).status).toBe(200);
    expect(vault.entries.get(BOT_TOKEN_KEY)).toBe(newToken);
    expect(vault.entries.get(CLIENT_SECRET_KEY)).toBe(CLIENT_SECRET);
    await until((s) => s.bot.status === 'connected');
    expect(gateway.live).toHaveLength(1);
  });

  it('requires both secrets again for a different application', async () => {
    await save(VALID);
    const res = await save({ applicationId: '999999999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues.map((i: { path: string }) => i.path)).toEqual(['clientSecret', 'botToken']);
  });
});

describe('Discord setup: account, install and bot', () => {
  it('walks through every step, resuming at the right one, and verifies each with Discord', async () => {
    await save(VALID);
    let s = await until((x) => x.bot.status === 'connected');
    expect(s.nextStep).toBe('account');
    expect(s.bot).toMatchObject({ username: 'RetroBot', problem: null });

    // A working bot is not an account connection…
    expect(s.account.connected).toBe(false);
    await connectAccount();
    s = await setup();
    expect(s.account).toMatchObject({ connected: true, name: 'Retro Live' });
    // …and an account connection is not an installation.
    expect(s.installation.status).toBe('not_installed');
    expect(s.nextStep).toBe('install');

    const url = await startInstall();
    expect(validateBotInstallUrl(url.toString())).not.toBeNull();
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, scope: 'bot applications.commands', permissions: '1099780320502', integration_type: '0', response_type: 'code' });
    expect((await setup()).installation.pending).toBe(true);

    // The browser returns with a guild hint, but Discord doesn't list the bot there yet: not claimed as installed.
    let page = await installReturns(url, { code: discord.issueCode(url.searchParams.get('redirect_uri')!), state: url.searchParams.get('state')!, guild_id: '42', permissions: '1099780320502' });
    expect(page.html).toContain('Not confirmed yet');
    s = await setup();
    expect(s.installation).toMatchObject({ status: 'not_installed', pending: false, problem: expect.stringMatching(/doesn't list the bot/) });

    // Discord's gateway reports the bot joining the server: now it is installed.
    gateway.setGuilds([{ id: '42', name: 'Retro Server' }]);
    s = await until((x) => x.installation.status === 'installed');
    expect(s.installation).toMatchObject({ guilds: [{ id: '42', name: 'Retro Server' }], source: 'gateway', problem: null });
    expect(s.nextStep).toBe('done');

    // Replaying the install redirect is rejected (single-use state).
    page = await installReturns(url, { code: 'again', state: url.searchParams.get('state')!, guild_id: '42' }).catch(() => ({ status: 0, html: '' }));
    expect(page.status === 0 || page.status === 400).toBe(true);
  });

  it('confirms an install from Discord when the bot is in the server at redirect time', async () => {
    await save(VALID);
    await until((x) => x.bot.status === 'connected');
    gateway.guilds = [{ id: '42', name: 'Retro Server' }];
    discord.botGuilds = [{ id: '42', name: 'Retro Server' }];
    const url = await startInstall();
    const page = await installReturns(url, { code: discord.issueCode(url.searchParams.get('redirect_uri')!), state: url.searchParams.get('state')!, guild_id: '42' });
    expect(page.html).toContain('Discord confirms the bot is in');
    expect(page.html).toContain('Retro Server');
    expect(auditActions(h).map((a) => a.action)).toContain('discord.bot.installed');
  });

  it('reports the user cancelling on Discord’s add-bot page', async () => {
    await save(VALID);
    const url = await startInstall();
    const page = await installReturns(url, { error: 'access_denied', state: url.searchParams.get('state')! });
    expect(page.html).toContain('Bot not added');
    expect((await setup()).installation).toMatchObject({ status: 'not_installed', pending: false, problem: expect.stringMatching(/cancelled adding the bot/) });
  });

  it('ignores an install redirect with a forged state', async () => {
    await save(VALID);
    const url = await startInstall();
    const page = await installReturns(url, { code: 'x', state: 'forged', guild_id: '42' });
    expect(page.status).toBe(400);
    expect((await setup()).installation.pending).toBe(true);
    expect(discord.requests.some((r) => r.body.includes('code=x'))).toBe(false);
  });

  it('lets the user cancel a pending install from the wizard', async () => {
    await save(VALID);
    await startInstall();
    const res = await h.call<DiscordSetupState>('POST', '/api/discord/install/cancel');
    expect(res.body.installation).toMatchObject({ pending: false, problem: expect.stringMatching(/cancelled/) });
  });

  it('keeps account sign-in and bot install pending independently', async () => {
    await save(VALID);
    await h.call('POST', '/api/connections/discord/connect');
    await startInstall();
    const s = await setup();
    expect(s.account.pending).toBe(true);
    expect(s.installation.pending).toBe(true);
    await h.call('POST', '/api/connections/discord/cancel');
    expect((await setup()).installation.pending).toBe(true);
  });

  it('checks installation over the API when the bot is offline, and says when it cannot verify', async () => {
    gateway.outcome = 'network';
    await save(VALID);
    discord.botGuilds = [{ id: '7', name: 'Other Server' }];
    let s = (await h.call<DiscordSetupState>('POST', '/api/discord/installation/check')).body;
    expect(s.installation).toMatchObject({ status: 'installed', source: 'api', guilds: [{ id: '7', name: 'Other Server' }] });
    discord.offline = true;
    h.clock.advance(61_000);
    s = (await h.call<DiscordSetupState>('POST', '/api/discord/installation/check')).body;
    expect(s.installation).toMatchObject({ status: 'unable_to_verify', problem: expect.stringMatching(/couldn't reach Discord/) });
  });
});

describe('Discord setup: the bot connection', () => {
  it('reports a token the gateway rejects as an error that needs a new token (not retried)', async () => {
    gateway.outcome = 'invalid_token';
    await save(VALID);
    const s = await until((x) => x.bot.status === 'error');
    expect(s.bot).toMatchObject({ retryable: false, problem: expect.stringMatching(/rejected the bot token/) });
    expect(gateway.logins).toBe(1);
  });

  it('reports disallowed intents with the portal fix, and Reconnect retries', async () => {
    gateway.outcome = 'disallowed_intents';
    await save(VALID);
    let s = await until((x) => x.bot.status === 'error');
    expect(s.bot).toMatchObject({ retryable: true, problem: expect.stringMatching(/intent/) });
    gateway.outcome = 'ok';
    s = (await h.call<DiscordSetupState>('POST', '/api/discord/bot/restart')).body;
    s = await until((x) => x.bot.status === 'connected');
    expect(gateway.live).toHaveLength(1);
  });

  it('never runs two gateway connections at once', async () => {
    await save(VALID);
    await until((x) => x.bot.status === 'connected');
    await save({ applicationId: CLIENT_ID });
    await h.call('POST', '/api/discord/bot/restart');
    await h.call('POST', '/api/discord/bot/restart');
    await until((x) => x.bot.status === 'connected');
    expect(gateway.live).toHaveLength(1);
  });

  it('shows reconnecting and recovery from gateway events', async () => {
    await save(VALID);
    await until((x) => x.bot.status === 'connected');
    const client = gateway.live[0]!;
    client.emit('reconnecting');
    expect((await setup()).bot.status).toBe('reconnecting');
    client.emit('resumed');
    expect((await setup()).bot.status).toBe('connected');
    client.emit('disconnected', 4014);
    expect((await setup()).bot).toMatchObject({ status: 'disconnected', retryable: false, problem: expect.stringMatching(/intent/) });
  });

  it('resumes after a restart: progress persists, secrets stay in the vault, the bot starts again', async () => {
    await save(VALID);
    await connectAccount();
    await h.restart();
    let s = await setup();
    expect(s.application).toMatchObject({ configured: true, applicationId: CLIENT_ID });
    expect(s.account.connected).toBe(true);
    await h.services.discord.startBot();
    s = await until((x) => x.bot.status === 'connected');
    expect(s.nextStep).toBe('install');
  });
});

describe('Discord setup: changing and removing', () => {
  it('switching to a different application signs out the old account and forgets old installations', async () => {
    await save(VALID);
    await connectAccount();
    gateway.setGuilds([{ id: '42', name: 'Retro Server' }]);
    await until((x) => x.installation.status === 'installed');

    const otherId = '999999999999999999';
    discord.clientId = otherId;
    discord.botApplication = { id: otherId, name: 'New App', flags: 0 };
    gateway.guilds = [];
    const before = discord.requests.length;
    const res = await save({ applicationId: otherId, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.application).toMatchObject({ applicationId: otherId, applicationName: 'New App' });
    expect(res.body.account.connected).toBe(false);
    expect(res.body.installation.guilds).toEqual([]);
    // The old account authorization was revoked with the old application's credentials.
    const oldBasic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
    expect(discord.requests.slice(before).some((r) => r.url.endsWith('/oauth2/token/revoke') && r.headers.authorization === oldBasic)).toBe(true);
    expect(auditActions(h).map((x) => x.action)).toContain('connection.removed');
  });

  it('remove setup revokes the account, stops the bot and deletes secrets and the application', async () => {
    await save(VALID);
    await connectAccount();
    await until((x) => x.bot.status === 'connected');
    const res = await h.call<DiscordSetupState>('POST', '/api/discord/reset');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nextStep: 'application', application: { configured: false }, account: { connected: false }, bot: { status: 'not_configured' } });
    expect(vault.entries.size).toBe(0);
    expect(gateway.live).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM discord_application').get()).toEqual({ n: 0 });
    expect(auditActions(h).map((a) => a.action)).toContain('discord.application.removed');
  });
});

describe('Discord setup: real pictures for the dashboard', () => {
  const BOT_AVATAR = 'b'.repeat(32);
  const SERVER_ICON = 'c'.repeat(32);
  const BOT_PNG = Buffer.from('bot-avatar-png');
  const SERVER_PNG = Buffer.from('server-icon-png');

  it('shows the bot avatar and server icon Discord reports, fetched by the backend as data URLs', async () => {
    gateway.user.avatar = BOT_AVATAR;
    gateway.guilds = [{ id: '42', name: 'Retro Server', icon: SERVER_ICON }];
    discord.cdn.set(`/avatars/${gateway.user.id}/${BOT_AVATAR}.png`, BOT_PNG);
    discord.cdn.set(`/icons/42/${SERVER_ICON}.png`, SERVER_PNG);
    await save(VALID);
    const s = await until((x) => x.bot.avatarDataUrl != null && x.installation.guilds[0]?.iconDataUrl != null);
    expect(s.bot.avatarDataUrl).toBe(`data:image/png;base64,${BOT_PNG.toString('base64')}`);
    expect(s.installation.guilds[0]).toEqual({ id: '42', name: 'Retro Server', iconDataUrl: `data:image/png;base64,${SERVER_PNG.toString('base64')}` });
  });

  it('reports no picture (the UI shows a fallback) when the bot has no avatar or the image fails', async () => {
    gateway.guilds = [{ id: '42', name: 'Retro Server', icon: SERVER_ICON }]; // icon not on the CDN: fetch fails
    await save(VALID);
    await until((x) => x.bot.status === 'connected');
    await new Promise((r) => setTimeout(r, 50));
    const s = await setup();
    expect(s.bot.avatarDataUrl).toBeNull();
    expect(s.installation.guilds[0]!.iconDataUrl).toBeNull();
  });

  it('while the bot is offline, uses the avatar Discord reported when the token was verified', async () => {
    gateway.outcome = 'network';
    discord.botUser = { ...discord.botUser, avatar: BOT_AVATAR } as typeof discord.botUser;
    discord.cdn.set(`/avatars/${discord.botUser.id}/${BOT_AVATAR}.png`, BOT_PNG);
    await save(VALID);
    const s = await until((x) => x.bot.avatarDataUrl != null);
    expect(s.bot.status).not.toBe('connected');
    expect(s.bot.avatarDataUrl).toContain(BOT_PNG.toString('base64'));
  });
});
