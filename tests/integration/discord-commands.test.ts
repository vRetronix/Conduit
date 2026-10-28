/**
 * Slash commands end to end against a simulated Discord REST API and gateway (automated, mocked — no live Discord):
 * registration per server, /ping over the bot's existing gateway connection, failures, retries and restarts.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordSetupState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;
let vault: MemoryVault;

const SERVER = { id: '42', name: 'Retro Server' };

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  vault = new MemoryVault();
  h = await createHarness({}, { vault, fetch: discord.fetch, botFactory: gateway.factory });
});
afterEach(async () => {
  await h.close();
});

const setup = async () => (await h.call<DiscordSetupState>('GET', '/api/discord/setup')).body;
const register = () => h.call<DiscordSetupState>('POST', '/api/discord/commands/register');

async function until(ok: (s: DiscordSetupState) => boolean, timeoutMs = 2000): Promise<DiscordSetupState> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await setup();
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`state never matched: ${JSON.stringify(s.commands)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Configures the application with the bot already in SERVER, and waits until the bot is online. */
async function configured(): Promise<DiscordSetupState> {
  discord.botGuilds = [SERVER];
  gateway.guilds = [SERVER];
  const res = await h.call('POST', '/api/discord/application', {
    body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN },
  });
  expect(res.status).toBe(200);
  return until((s) => s.bot.status === 'connected' && s.commands.status !== 'registering');
}

describe('slash command registration', () => {
  it('registers /ping in the server when the bot comes online, and reports it only after Discord confirms', async () => {
    const state = await configured();
    expect(state.commands).toMatchObject({
      status: 'registered',
      scope: 'guild',
      names: ['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky'],
      definitions: [
        { name: 'ping', description: 'Check that I’m connected', requiresPermissions: false, origin: 'default' },
        // Moderation commands: shown only to members with the permission (default_member_permissions).
        { name: 'timeout', description: 'Time a member out', requiresPermissions: true, origin: 'default' },
        { name: 'untimeout', description: 'Remove a member’s timeout', requiresPermissions: true, origin: 'default' },
        { name: 'kick', description: 'Remove a member from the server (they can rejoin with an invite)', requiresPermissions: true, origin: 'default' },
        { name: 'ban', description: 'Ban a user from the server', requiresPermissions: true, origin: 'default' },
        { name: 'unban', description: 'Lift a ban', requiresPermissions: true, origin: 'default' },
        { name: 'slowmode', description: 'Set how long members wait between messages', requiresPermissions: true, origin: 'default' },
        { name: 'lock', description: 'Stop members posting in a channel', requiresPermissions: true, origin: 'default' },
        { name: 'unlock', description: 'Let members post in a locked channel again', requiresPermissions: true, origin: 'default' },
        // Admin only: shown to members with Administrator.
        { name: 'sticky', description: 'Keep a message at the bottom of a channel', requiresPermissions: true, origin: 'default' },
      ],
      applicationId: CLIENT_ID,
      botUsername: 'RetroBot',
      guilds: [{ id: '42', name: 'Retro Server', status: 'registered', error: null }],
      problem: null,
    });
    // Registered with the bot's own credentials, for the configured application, as a guild command.
    const put = discord.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe(`https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/42/commands`);
    expect(put.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    const payload = JSON.parse(put.body) as Array<{ name: string; default_member_permissions: string | null }>;
    expect(payload[0]).toEqual(
      expect.objectContaining({
        name: 'ping',
        description: 'Check that I’m connected',
        type: 1,
        contexts: [0],
        default_member_permissions: null,
      }),
    );
    // Moderation commands are hidden from members without the permission: Timeout Members (1<<40), Ban Members (1<<2).
    expect(payload.slice(1).map((c) => [c.name, c.default_member_permissions])).toEqual([
      ['timeout', (1n << 40n).toString()],
      ['untimeout', (1n << 40n).toString()],
      ['kick', '2'],
      ['ban', '4'],
      ['unban', '4'],
      // Manage Channels (1<<4); /sticky: Administrator.
      ['slowmode', '16'],
      ['lock', '16'],
      ['unlock', '16'],
      ['sticky', '8'],
    ]);
    expect(discord.guildCommands.get('42')!.map((c) => c.name)).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky']);
    expect(auditActions(h).some((a) => a.action === 'discord.commands.registered' && a.outcome === 'success')).toBe(true);
  });

  it('reports the verified bot identity even while the bot is offline (for Bot Accounts)', async () => {
    await configured();
    await h.services.discord.stopBot();
    const s = await setup();
    expect(s.bot.username).toBeNull();
    expect(s.application).toMatchObject({ botUsername: 'RetroBot', botUserId: '223456789012345678', applicationName: 'Retro Bot' });
    expect(JSON.stringify(s)).not.toContain(BOT_TOKEN);
  });

  it('keeps bot status and command status separate', async () => {
    discord.noCommandAccess.add('42');
    const s = await configured();
    expect(s.bot.status).toBe('connected');
    expect(s.commands.status).toBe('failed');
  });

  it('does not count a registration Discord did not confirm', async () => {
    discord.dropFromConfirmation = 'ping';
    const s = await configured();
    expect(s.commands).toMatchObject({
      status: 'failed',
      guilds: [{ status: 'failed' }],
      problem: expect.stringMatching(/didn't confirm \/ping/),
    });
  });

  it('does not register again on restart when Discord still has the commands (one check instead)', async () => {
    await configured();
    expect(discord.commandPuts).toBe(1);
    await h.restart();
    await h.services.discord.startBot();
    const s = await until((x) => x.bot.status === 'connected' && x.commands.status === 'registered');
    expect(s.commands.guilds[0]!.status).toBe('registered');
    expect(discord.commandGets).toBe(1);
    expect(discord.commandPuts).toBe(1);
  });

  it('registers again after a restart if the commands were removed on Discord', async () => {
    await configured();
    discord.guildCommands.delete('42');
    await h.restart();
    await h.services.discord.startBot();
    await until((x) => x.bot.status === 'connected');
    await until(() => discord.commandPuts === 2);
    expect(discord.guildCommands.get('42')!.map((c) => c.name)).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky']);
  });

  it('never creates duplicates: registering repeatedly leaves exactly one /ping', async () => {
    await configured();
    for (let n = 0; n < 3; n++) expect((await register()).status).toBe(200);
    expect(discord.guildCommands.get('42')!.filter((c) => c.name === 'ping')).toHaveLength(1);
  });

  it('registers in a server the bot joins later', async () => {
    discord.botGuilds = [];
    gateway.guilds = [];
    await h.call('POST', '/api/discord/application', {
      body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN },
    });
    let s = await until((x) => x.bot.status === 'connected');
    expect(s.commands).toMatchObject({
      status: 'not_registered',
      canRegister: false,
      problem: expect.stringMatching(/Add the bot to a server first/),
    });
    expect((await register()).status).toBe(409);

    discord.botGuilds = [SERVER];
    gateway.setGuilds([SERVER]);
    s = await until((x) => x.commands.status === 'registered');
    expect(s.commands.guilds).toEqual([expect.objectContaining({ id: '42', status: 'registered' })]);
  });

  it('missing access: explains the fix, does not retry by itself, and Retry works once fixed', async () => {
    discord.noCommandAccess.add('42');
    let s = await configured();
    expect(s.commands).toMatchObject({
      status: 'failed',
      canRegister: true,
      nextRetryAt: null,
      problem: expect.stringMatching(/Missing Access.*Add bot to server/),
    });
    expect(s.commands.guilds[0]!.error).toMatch(/Missing Access/);

    discord.noCommandAccess.clear();
    const res = await register();
    expect(res.status).toBe(200);
    s = res.body;
    expect(s.commands).toMatchObject({ status: 'registered', problem: null, guilds: [{ status: 'registered', error: null }] });
  });

  it('rate limits: honours retry_after, schedules a retry and says when', async () => {
    discord.commandFailures.push({ status: 429, retryAfter: 45 });
    const s = await configured();
    expect(s.commands.status).toBe('failed');
    expect(s.commands.problem).toMatch(/rate limiting.*retry in 45 seconds/);
    expect(s.commands.nextRetryAt).not.toBeNull();
    // The user can also retry right away.
    expect((await register()).body.commands.status).toBe('registered');
  });

  it('Discord outages and network failures are reported as such and retried automatically', async () => {
    discord.commandFailures.push({ status: 503 });
    let s = await configured();
    expect(s.commands.problem).toMatch(/Discord is having problems.*retry in 30 seconds/);
    expect(s.commands.nextRetryAt).not.toBeNull();

    discord.offline = true;
    s = (await register()).body;
    expect(s.commands.problem).toMatch(/couldn't reach Discord/);
    discord.offline = false;
    expect((await register()).body.commands.status).toBe('registered');
  });

  it('a transient failure does not undo a registration Discord already confirmed', async () => {
    await configured();
    discord.commandFailures.push({ status: 500 });
    const s = (await register()).body;
    expect(s.commands.guilds[0]!.status).toBe('registered');
    expect(s.commands.problem).toMatch(/having problems/);
  });

  it('a rejected bot token is reported with the fix', async () => {
    await configured();
    discord.validBotToken = 'rotated-elsewhere';
    const s = (await register()).body;
    expect(s.commands.problem).toMatch(/rejected the bot token.*Reconfigure/);
  });

  it('survives restarts with its status (registered stays registered; failures keep their reason)', async () => {
    discord.noCommandAccess.add('42');
    await configured();
    await h.restart();
    const s = await setup();
    expect(s.commands.guilds[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Missing Access/) });
  });

  it('removing the Discord setup removes the commands from the server', async () => {
    await configured();
    await h.call('POST', '/api/discord/reset');
    expect(discord.guildCommands.get('42')).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM discord_command_registrations').get()).toEqual({ n: 0 });
  });
});

describe('/ping', () => {
  it('answers through the existing bot connection', async () => {
    await configured();
    const i = await gateway.interact({ commandName: 'ping', guildId: '42' });
    expect(i.replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
    expect(gateway.clients).toHaveLength(1); // no second connection was opened for commands
  });

  it('answers each interaction exactly once, even if Discord delivers it twice', async () => {
    await configured();
    const i = await gateway.interact();
    gateway.live[0]!.emit('interaction', i);
    await new Promise((r) => setTimeout(r, 30));
    expect(i.replies).toHaveLength(1);
  });

  it('has exactly one interaction listener per connection, also after reconnects', async () => {
    await configured();
    for (let n = 0; n < 3; n++) {
      await h.call('POST', '/api/discord/bot/restart');
      await until((x) => x.bot.status === 'connected');
    }
    expect(gateway.live).toHaveLength(1);
    for (const c of gateway.clients) expect(c.listenerCount('interaction')).toBe(1);
    const i = await gateway.interact();
    expect(i.replies).toHaveLength(1);
  });

  it('keeps working across a resumed gateway session', async () => {
    await configured();
    gateway.live[0]!.emit('reconnecting');
    gateway.live[0]!.emit('resumed');
    expect((await gateway.interact()).replies[0]!.content).toBe('Pong! I’m connected and ready!');
  });

  it('a late interaction on a replaced connection gets a "restarting" reply instead of running', async () => {
    await configured();
    const old = gateway.live[0]!;
    await h.call('POST', '/api/discord/bot/restart');
    await until((x) => x.bot.status === 'connected');
    const { fakeInteraction } = await import('../helpers/fake-gateway');
    const i = fakeInteraction();
    old.emitLate('interaction', i);
    await new Promise((r) => setTimeout(r, 20));
    expect(i.replies).toEqual([{ content: 'I’m restarting. Try again in a moment.', ephemeral: true }]);
  });

  it('while shutting down, commands get a "restarting" reply', async () => {
    await configured();
    const client = gateway.live[0]!;
    await h.services.discord.stopBot();
    const { fakeInteraction } = await import('../helpers/fake-gateway');
    const i = fakeInteraction();
    client.emitLate('interaction', i);
    await new Promise((r) => setTimeout(r, 20));
    expect(i.replies[0]).toMatchObject({ content: expect.stringMatching(/restarting/), ephemeral: true });
  });

  it.each([
    ['another application', { applicationId: '999999999999999999' }, null],
    ['a malformed interaction id', { id: 'not-an-id' }, null],
    ['a direct message', { guildId: null }, /servers only/],
    ['an unknown command', { commandName: 'giveaway' }, /not available/],
    ['unexpected options', { options: [{ name: 'evil', type: 3, value: 'x' }] }, /options weren't valid/],
  ])('refuses %s', async (_label, overrides, reply) => {
    await configured();
    const i = await gateway.interact(overrides as never);
    if (reply === null) expect(i.replies).toEqual([]);
    else expect(i.replies).toEqual([{ content: expect.stringMatching(reply), ephemeral: true }]);
  });

  it('never writes the bot token or client secret to logs, status or requests other than Discord auth headers', async () => {
    await configured();
    await gateway.interact();
    await register();
    const everything = [
      JSON.stringify(await setup()),
      fs.readFileSync(h.logFile, 'utf8'),
      JSON.stringify(h.db.prepare('SELECT * FROM discord_command_registrations').all()),
      JSON.stringify(auditActions(h)),
    ].join('\n');
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toContain(CLIENT_SECRET);
    for (const r of discord.requests) {
      expect(r.url).not.toContain(BOT_TOKEN);
      expect(r.body).not.toContain(BOT_TOKEN);
    }
  });
});

describe('custom Discord commands (slash commands)', () => {
  const createCustom = (body: unknown) => h.call<any>('POST', '/api/commands/discord', { body });
  const hub = async () => (await h.call<any>('GET', '/api/commands/discord')).body;
  const registeredNames = () => (discord.guildCommands.get('42') ?? []).map((c) => c.name).sort();
  const lastPut = () =>
    JSON.parse(discord.requests.filter((r) => r.method === 'PUT').at(-1)!.body) as Array<{ name: string; options: unknown[] }>;

  it('are registered with Discord next to /ping, and removed when disabled or deleted', async () => {
    await configured();
    const created = await createCustom({ trigger: 'Discord', description: 'Our Discord link', response: 'Join us, {user}!' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ platform: 'discord', trigger: '/discord', description: 'Our Discord link' });
    await until(() => true);
    await new Promise((r) => setTimeout(r, 50));
    expect(registeredNames()).toEqual(['ban', 'discord', 'kick', 'lock', 'ping', 'slowmode', 'sticky', 'timeout', 'unban', 'unlock', 'untimeout']);
    // No {args}/{message} in the reply: no "text" option is offered.
    expect(lastPut().find((c) => c.name === 'discord')!.options).toEqual([]);

    await h.call('PATCH', `/api/commands/discord/${created.body.id}`, { body: { enabled: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(registeredNames()).toEqual(['ban', 'kick', 'lock', 'ping', 'slowmode', 'sticky', 'timeout', 'unban', 'unlock', 'untimeout']);
    await h.call('DELETE', `/api/commands/discord/${created.body.id}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(registeredNames()).toEqual(['ban', 'kick', 'lock', 'ping', 'slowmode', 'sticky', 'timeout', 'unban', 'unlock', 'untimeout']);
  });

  it('a reply that uses {args} offers an optional "text" box; variables come from the real interaction', async () => {
    await configured();
    await createCustom({ trigger: '/say', description: 'Say something', response: '{user} in #{channel} says: {args} ({message})' });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastPut().find((c) => c.name === 'say')!.options).toEqual([expect.objectContaining({ name: 'text', type: 3, required: false })]);

    const i = await gateway.interact({
      commandName: 'say',
      userName: 'viewer42',
      channelName: 'general',
      options: [{ name: 'text', type: 3, value: 'hello all' }],
    });
    expect(i.replies).toEqual([{ content: 'viewer42 in #general says: hello all (/say hello all)' }]);
    const noText = await gateway.interact({ commandName: 'say', userName: 'viewer42', channelName: 'general' });
    expect(noText.replies[0]!.content).toBe('viewer42 in #general says: (/say)');

    const c = (await hub()).custom[0];
    expect(c).toMatchObject({ runs: 2, lastRun: { outcome: 'sent' } });
  });

  it('replies can use Discord markdown over several lines, posted exactly as written', async () => {
    await configured();
    const created = await createCustom({ trigger: '/rules', description: 'Server rules', response: '## Rules\r\n> Be kind, {user}\r\n- **No spam**\r\n- ||Have fun||' });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    const i = await gateway.interact({ commandName: 'rules', userName: 'viewer42', channelName: 'general' });
    expect(i.replies).toEqual([{ content: '## Rules\n> Be kind, viewer42\n- **No spam**\n- ||Have fun||' }]);
  });

  it('a missing channel name is empty, never a crash; long replies fit Discord’s 2000-character limit', async () => {
    await configured();
    await createCustom({ trigger: '/where', description: 'Where am I', response: `You are in {channel}. ${'x'.repeat(1800)} {args}` });
    await new Promise((r) => setTimeout(r, 50));
    const i = await gateway.interact({
      commandName: 'where',
      channelName: null,
      options: [{ name: 'text', type: 3, value: 'y'.repeat(400) }],
    });
    expect(i.replies[0]!.content.startsWith('You are in . x')).toBe(true);
    expect(i.replies[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(i.replies[0]!.content.endsWith('…')).toBe(true);
  });

  it('keeps /ping exactly as it was (no variables, default command)', async () => {
    await configured();
    await createCustom({ trigger: '/hello', description: 'Hi', response: 'Hello {user}' });
    const ping = await gateway.interact({ commandName: 'ping', userName: '{user}' });
    expect(ping.replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
    expect((await hub()).defaults.map((d: { trigger: string; description: string }) => ({ trigger: d.trigger, description: d.description }))).toEqual([
      { trigger: '/ping', description: 'Check that I’m connected' },
      { trigger: '/timeout', description: 'Time a member out' },
      { trigger: '/untimeout', description: 'Remove a member’s timeout' },
      { trigger: '/kick', description: 'Remove a member from the server (they can rejoin with an invite)' },
      { trigger: '/ban', description: 'Ban a user from the server' },
      { trigger: '/unban', description: 'Lift a ban' },
      { trigger: '/slowmode', description: 'Set how long members wait between messages' },
      { trigger: '/lock', description: 'Stop members posting in a channel' },
      { trigger: '/unlock', description: 'Let members post in a locked channel again' },
      { trigger: '/sticky', description: 'Keep a message at the bottom of a channel' },
    ]);
    for (const name of ['/ban', '/timeout']) expect((await createCustom({ trigger: name, description: 'Mine', response: 'x' })).status).toBe(400);
    expect((await createCustom({ trigger: '/ping', description: 'Mine', response: 'x' })).status).toBe(400);
  });

  it('Kick and Discord commands are kept apart', async () => {
    await createCustom({ trigger: '/hello', description: 'Hi', response: 'Hello {user}' });
    expect((await h.call<any>('POST', '/api/commands/kick', { body: { trigger: '!hello', response: 'Hello {user}' } })).status).toBe(201);
    expect((await hub()).custom.map((c: { trigger: string }) => c.trigger)).toEqual(['/hello']);
    expect((await h.call<any>('GET', '/api/commands/kick')).body.custom.map((c: { trigger: string }) => c.trigger)).toEqual(['!hello']);
    expect((await h.call('GET', '/api/commands/youtube')).status).toBe(400);
  });
});

describe('Discord custom command permissions and cooldowns', () => {
  const createCustom = (body: unknown) => h.call<any>('POST', '/api/commands/discord', { body });
  const hub = async () => (await h.call<any>('GET', '/api/commands/discord')).body;
  const MANAGE_MESSAGES = 1n << 13n;
  const MODERATE_MEMBERS = 1n << 40n;
  const ADMINISTRATOR = 1n << 3n;
  const ready = async () => {
    await configured();
    await new Promise((r) => setTimeout(r, 50));
  };

  it('moderator commands use Discord’s computed member permissions; others get a private note', async () => {
    await ready();
    await createCustom({ trigger: '/modonly', description: 'Mods', response: 'Hello mod', permission: 'moderator' });
    await new Promise((r) => setTimeout(r, 50));
    const denied = await gateway.interact({ commandName: 'modonly', memberPermissions: 1n << 11n });
    expect(denied.replies).toEqual([{ content: 'Not allowed: moderator only.', ephemeral: true }]);
    for (const perms of [MANAGE_MESSAGES, MODERATE_MEMBERS, ADMINISTRATOR]) {
      const ok = await gateway.interact({ commandName: 'modonly', memberPermissions: perms });
      expect(ok.replies).toEqual([{ content: 'Hello mod' }]);
    }
    const c = (await hub()).custom[0];
    expect(c.runs).toBe(4);
  });

  it('administrator commands need Administrator (a moderator is not enough)', async () => {
    await ready();
    await createCustom({ trigger: '/admin', description: 'Admins', response: 'Hi admin', permission: 'broadcaster' });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await gateway.interact({ commandName: 'admin', memberPermissions: MANAGE_MESSAGES | MODERATE_MEMBERS })).replies[0],
    ).toMatchObject({ ephemeral: true });
    expect((await gateway.interact({ commandName: 'admin', memberPermissions: ADMINISTRATOR })).replies).toEqual([{ content: 'Hi admin' }]);
  });

  it('variables: {mention} (no ping), {server}, {membercount}, {count}, {touser} from the text box, Loyalty with a fallback', async () => {
    await ready();
    gateway.guilds = [{ ...SERVER, memberCount: 1500 }];
    const res = await createCustom({
      trigger: '/stats',
      description: 'Stats',
      response: '{mention} hugs {touser} on {server} ({membercount} members) — used {count}× on {platform}, {points|no points}',
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    const text = (value: string) => [{ name: 'text', type: 3, value }];
    const first = await gateway.interact({ commandName: 'stats', options: text('@Bob hi') });
    expect(first.replies).toEqual([{ content: '<@555555555555555555> hugs Bob on Retro Server (1,500 members) — used 1× on Discord, no points' }]);
    const second = await gateway.interact({ commandName: 'stats', options: text('Ann') });
    expect(second.replies[0]!.content).toContain('hugs Ann on Retro Server (1,500 members) — used 2×');
    // Kick-only variables can't be saved in a Discord command.
    expect((await createCustom({ trigger: '/subs', description: 'x', response: '{submonths}' })).status).toBe(400);
  });

  it('subscriber level is not available on Discord', async () => {
    const res = await createCustom({ trigger: '/subs', description: 'Subs', response: 'x', permission: 'subscriber' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].message).toMatch(/Discord has no subscribers/);
  });

  it('per-user cooldown keys on the Discord user id; blocked uses get a private note', async () => {
    await ready();
    await createCustom({ trigger: '/cd', description: 'Cooldown', response: 'Hi {user}', cooldownMode: 'user', cooldownSeconds: 60 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await gateway.interact({ commandName: 'cd', userId: '111111111111111111', userName: 'a' })).replies).toEqual([
      { content: 'Hi a' },
    ]);
    const again = await gateway.interact({ commandName: 'cd', userId: '111111111111111111', userName: 'a' });
    expect(again.replies).toEqual([
      { content: expect.stringMatching(/^\/cd is on cooldown\. Try again in \d+ (s|min)\.$/), ephemeral: true },
    ]);
    // Same username, different Discord user: a different person, not blocked.
    expect((await gateway.interact({ commandName: 'cd', userId: '222222222222222222', userName: 'a' })).replies).toEqual([
      { content: 'Hi a' },
    ]);
    expect((await hub()).custom[0].lastRun.outcome).toBe('sent');
    h.clock.advance(61_000);
    expect((await gateway.interact({ commandName: 'cd', userId: '111111111111111111', userName: 'a' })).replies).toEqual([
      { content: 'Hi a' },
    ]);
  });

  it('global cooldown blocks everyone; /ping is never affected', async () => {
    await ready();
    await createCustom({ trigger: '/g', description: 'Global', response: 'G', cooldownMode: 'global', cooldownSeconds: 60 });
    await new Promise((r) => setTimeout(r, 50));
    await gateway.interact({ commandName: 'g', userId: '111111111111111111' });
    expect((await gateway.interact({ commandName: 'g', userId: '222222222222222222' })).replies[0]).toMatchObject({ ephemeral: true });
    for (let n = 0; n < 3; n++)
      expect((await gateway.interact({ commandName: 'ping' })).replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
    const recent = (await hub()).recent.map((r: { trigger: string; outcome: string }) => `${r.trigger}:${r.outcome}`);
    expect(recent).toEqual(['/g:blocked', '/g:sent']);
  });

  it('a reply Discord refused does not use up the cooldown', async () => {
    await ready();
    await createCustom({ trigger: '/g', description: 'Global', response: 'G', cooldownMode: 'global', cooldownSeconds: 60 });
    await new Promise((r) => setTimeout(r, 50));
    const failing = await gateway.interact({
      commandName: 'g',
      reply: async () => {
        throw new Error('Unknown interaction');
      },
    });
    expect(failing.replies).toEqual([]);
    expect((await gateway.interact({ commandName: 'g' })).replies).toEqual([{ content: 'G' }]);
  });
});
