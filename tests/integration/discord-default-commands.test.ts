/**
 * Commands → Discord: the default commands' Access (Admin / Moderator / Community, enforced by the dispatcher) and
 * Enabled / Disabled, and the bot's presence (Status Updates, Rich Presence Updates). Against a simulated Discord REST
 * API and gateway.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOYALTY_SETTINGS, type DiscordCommandsOverview, type DiscordSetupState, type PresenceState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

const SERVER = { id: '42', name: 'Retro Server' };
const MANAGE_MESSAGES = 1n << 13n;
const MODERATE_MEMBERS = 1n << 40n;
const BAN_MEMBERS = 1n << 2n;
const ADMINISTRATOR = 1n << 3n;

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
});
afterEach(async () => {
  await h.close();
});

const setup = async () => (await h.call<DiscordSetupState>('GET', '/api/discord/setup')).body;
async function until(ok: (s: DiscordSetupState) => boolean, timeoutMs = 2000): Promise<DiscordSetupState> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await setup();
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`state never matched: ${JSON.stringify(s.commands)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function online(): Promise<DiscordSetupState> {
  discord.botGuilds = [SERVER];
  gateway.guilds = [SERVER];
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  return until((s) => s.bot.status === 'connected' && s.commands.status !== 'registering');
}
const overview = async () => (await h.call<DiscordCommandsOverview>('GET', '/api/discord/commands')).body;
const saveAccess = (groups: Record<string, string>) => h.call<DiscordCommandsOverview & { error?: { issues?: Array<{ path: string; message: string }> } }>('POST', '/api/discord/command-access', { body: { groups } });
/** The latest registration Discord received for the server: name → default_member_permissions. */
const registered = () => {
  const put = discord.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/guilds/42/commands')).at(-1)!;
  return Object.fromEntries((JSON.parse(put.body) as Array<{ name: string; default_member_permissions: string | null }>).map((c) => [c.name, c.default_member_permissions]));
};
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('Discord default commands', () => {
  it('lists every built-in command once, in order; custom commands are not part of it', async () => {
    await h.call('POST', '/api/commands/discord', { body: { trigger: '/rules', description: 'Server rules', response: 'Be kind', permission: 'moderator' } });
    const o = await overview();
    expect(o.commands.map((c) => c.name)).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky', 'points', 'rewards', 'redeem', 'level', 'leaderboard', 'loyalty']);
    expect(o.commands.every((c) => c.enabled)).toBe(true);
  });

  it('the existing commands stay registered exactly as before by default (no access widened or narrowed)', async () => {
    await online();
    expect(registered()).toEqual({
      ping: null,
      timeout: MODERATE_MEMBERS.toString(),
      untimeout: MODERATE_MEMBERS.toString(),
      kick: '2',
      ban: '4',
      unban: '4',
      // Manage Channels; /sticky is Admin only.
      slowmode: '16',
      lock: '16',
      unlock: '16',
      sticky: ADMINISTRATOR.toString(),
    });
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: 0n })).replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
    const o = await overview();
    expect(o.commands.find((c) => c.name === 'ping')).toMatchObject({ group: 'community', defaultGroup: 'community', enabled: true, active: true });
    expect(o.commands.find((c) => c.name === 'ban')).toMatchObject({ group: 'moderator', minimumGroup: 'moderator', discordPermission: 'Ban Members' });
  });

  it('Loyalty & Rewards commands show why they aren’t in Discord, and are registered once Loyalty is on (Discord only)', async () => {
    await online();
    expect((await overview()).commands.find((c) => c.name === 'points')).toMatchObject({ enabled: true, active: false, inactiveReason: 'Loyalty & Rewards is off' });
    await h.call('POST', '/api/loyalty/settings', { body: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true, xp: { ...DEFAULT_LOYALTY_SETTINGS.xp, enabled: false } } });
    await settle();
    const o = await overview();
    expect(o.commands.filter((c) => c.kind === 'loyalty').map((c) => [c.name, c.active])).toEqual([
      ['points', true],
      ['rewards', true],
      ['redeem', true],
      ['level', false],
      ['leaderboard', false],
      ['loyalty', true],
    ]);
    expect(o.commands.find((c) => c.name === 'level')!.inactiveReason).toMatch(/XP & levels/);
    expect(o.commands.find((c) => c.name === 'loyalty')).toMatchObject({ group: 'admin', minimumGroup: 'admin' });
    expect(Object.keys(registered())).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky', 'points', 'rewards', 'redeem', 'loyalty']);
    // Kick has no loyalty commands.
    const kick = (await h.call<{ defaults: Array<{ trigger: string }> }>('GET', '/api/commands/kick')).body;
    expect(kick.defaults.map((d) => d.trigger).filter((t) => /points|rank|leaderboard|redeem|rewards|loyalty/.test(t))).toEqual([]);
  });

  it('Disabled: removed from Discord, refused if invoked anyway; Enabled again restores it', async () => {
    await online();
    const res = await h.call<DiscordCommandsOverview>('POST', '/api/discord/command-access', { body: { groups: {}, disabled: ['ping', 'ban'] } });
    expect(res.status).toBe(200);
    expect(res.body.commands.filter((c) => !c.enabled).map((c) => [c.name, c.active])).toEqual([
      ['ping', false],
      ['ban', false],
    ]);
    await settle();
    expect(Object.keys(registered())).toEqual(['timeout', 'untimeout', 'kick', 'unban', 'slowmode', 'lock', 'unlock', 'sticky']);
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: ADMINISTRATOR })).replies).toEqual([
      { content: 'This command is not available anymore.', ephemeral: true },
    ]);
    await h.call('POST', '/api/discord/command-access', { body: { groups: {}, disabled: [] } });
    await settle();
    expect(Object.keys(registered())).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky']);
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: 0n })).replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
  });

  it('a disabled Loyalty command stays out of Discord even while Loyalty is on', async () => {
    await online();
    await h.call('POST', '/api/discord/command-access', { body: { groups: {}, disabled: ['redeem'] } });
    await h.call('POST', '/api/loyalty/settings', { body: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true } });
    await settle();
    expect(Object.keys(registered())).toEqual(['ping', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'slowmode', 'lock', 'unlock', 'sticky', 'points', 'rewards', 'level', 'leaderboard', 'loyalty']);
    expect((await overview()).commands.find((c) => c.name === 'redeem')).toMatchObject({ enabled: false, active: false });
  });
});

describe('Access (Admin, Moderator, Community)', () => {
  it('Admin: hidden from other members in Discord, and refused by the backend even when invoked directly', async () => {
    await online();
    const res = await saveAccess({ ping: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.commands.find((c) => c.name === 'ping')!.group).toBe('admin');
    await settle();
    expect(registered().ping).toBe(ADMINISTRATOR.toString());
    // A moderator invoking it anyway (e.g. a server admin made it visible in Discord's Integrations settings).
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: MANAGE_MESSAGES | BAN_MEMBERS })).replies).toEqual([
      { content: 'Not allowed: admin only.', ephemeral: true },
    ]);
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: ADMINISTRATOR })).replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
  });

  it('Moderator: any moderator permission is enough; a member without one is refused privately', async () => {
    await online();
    await saveAccess({ ping: 'moderator' });
    await settle();
    expect(registered().ping).toBeNull(); // Discord can't express "any of", so it stays listed and the backend decides
    expect((await gateway.interact({ commandName: 'ping', memberPermissions: 1n << 11n })).replies).toEqual([{ content: 'Not allowed: moderator only.', ephemeral: true }]);
    for (const p of [MANAGE_MESSAGES, MODERATE_MEMBERS, ADMINISTRATOR])
      expect((await gateway.interact({ commandName: 'ping', memberPermissions: p })).replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
  });

  it('moderation commands can never be opened to Community, and keep their Discord permission when raised to Admin', async () => {
    await online();
    const widened = await saveAccess({ ban: 'community' });
    expect(widened.status).toBe(400);
    expect(widened.body.error?.issues).toEqual([{ path: 'groups.ban', message: '/ban can’t be opened below Moderator' }]);
    expect((await overview()).commands.find((c) => c.name === 'ban')!.group).toBe('moderator');
    // Raised to Admin: a moderator with Ban Members is refused; Ban Members is still required (re-checked first).
    await saveAccess({ ban: 'admin' });
    await settle();
    expect(registered().ban).toBe(ADMINISTRATOR.toString());
    expect((await gateway.interact({ commandName: 'ban', memberPermissions: BAN_MEMBERS, options: [{ name: 'user', type: 6, value: '123456789012345678' }] })).replies).toEqual([
      { content: 'Not allowed: admin only.', ephemeral: true },
    ]);
    expect((await gateway.interact({ commandName: 'unban', memberPermissions: MANAGE_MESSAGES, options: [{ name: 'user', type: 6, value: '123456789012345678' }] })).replies).toEqual([
      { content: "You don't have permission to use this command.", ephemeral: true },
    ]);
  });

  it('rejects unknown commands and custom commands; restoring the defaults stores nothing', async () => {
    expect((await saveAccess({ nope: 'admin' })).status).toBe(400);
    await h.call('POST', '/api/commands/discord', { body: { trigger: '/rules', description: 'Rules', response: 'Be kind' } });
    expect((await saveAccess({ rules: 'admin' })).body.error?.issues?.[0]?.message).toMatch(/isn’t a default command/);
    expect((await h.call('POST', '/api/discord/command-access', { body: { groups: {}, disabled: ['rules'] } })).status).toBe(400);
    expect((await h.call('POST', '/api/discord/command-access', { body: { groups: { ping: 'owner' } } })).status).toBe(400);
    await saveAccess({ ping: 'admin' });
    await saveAccess({ ping: 'community', ban: 'moderator' });
    const row = h.db.prepare("SELECT value FROM app_settings WHERE key = 'discord.command_access'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ groups: {}, disabled: [] });
  });

  it('a stored value that no longer fits (edited by hand, or widening a moderation command) is ignored, never applied', async () => {
    h.db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('discord.command_access', ?, 'x')")
      .run(JSON.stringify({ groups: { ban: 'community', timeout: 'everyone', ping: 'admin' } }));
    const o = await overview();
    expect(o.commands.find((c) => c.name === 'ban')!.group).toBe('moderator');
    expect(o.commands.find((c) => c.name === 'timeout')!.group).toBe('moderator');
    expect(o.commands.find((c) => c.name === 'ping')!.group).toBe('admin');
  });

  it('survives a restart', async () => {
    await saveAccess({ ping: 'moderator' });
    await h.restart();
    expect((await overview()).commands.find((c) => c.name === 'ping')!.group).toBe('moderator');
  });
});

describe('bot presence (Status Updates, Rich Presence Updates)', () => {
  const presence = async () => (await h.call<PresenceState>('GET', '/api/discord/presence')).body;
  const save = (body: unknown) => h.call<PresenceState & { error?: { code?: string; message?: string; issues?: Array<{ path: string; message: string }> } }>('POST', '/api/discord/presence', { body });

  it('nothing is saved or sent by default (Discord shows the bot online, no activity)', async () => {
    await online();
    expect(await presence()).toEqual({ saved: null, applied: { state: 'not_sent', at: null, presence: null, problem: null }, botConnected: true, history: [] });
    expect(gateway.presences).toEqual([]);
  });

  it('saving sends it on the live session; "saved" and "sent" are reported separately', async () => {
    await online();
    const res = await save({ status: 'idle', customStatus: 'Keeping it tidy', activity: { type: 'watching', name: 'the stream', url: null } });
    expect(res.status).toBe(200);
    expect(res.body.saved).toEqual({ status: 'idle', customStatus: 'Keeping it tidy', activity: { type: 'watching', name: 'the stream', url: null } });
    expect(res.body.applied).toMatchObject({ state: 'sent', problem: null, presence: res.body.saved });
    // One activity: the activity wins over the custom status text.
    expect(gateway.presences.at(-1)).toEqual({ status: 'idle', activities: [{ name: 'the stream', type: 3 }] });
    await save({ status: 'dnd', customStatus: 'Back soon', activity: null });
    expect(gateway.presences.at(-1)).toEqual({ status: 'dnd', activities: [{ name: 'Custom Status', type: 4, state: 'Back soon' }] });
    await save({ status: 'online', customStatus: null, activity: { type: 'streaming', name: 'Retro night', url: 'https://twitch.tv/retronix' } });
    expect(gateway.presences.at(-1)).toEqual({ status: 'online', activities: [{ name: 'Retro night', type: 1, url: 'https://twitch.tv/retronix' }] });
  });

  it('saved while the bot is offline: kept, marked not sent, and sent when the bot connects (and again after a reconnect)', async () => {
    const res = await save({ status: 'online', customStatus: null, activity: { type: 'playing', name: 'with cables', url: null } });
    expect(res.body.applied).toMatchObject({ state: 'not_sent', problem: 'Saved. It is sent when the bot connects to Discord.' });
    expect(res.body.botConnected).toBe(false);
    await online();
    await settle();
    expect(gateway.presences).toEqual([{ status: 'online', activities: [{ name: 'with cables', type: 0 }] }]);
    expect((await presence()).applied.state).toBe('sent');
    gateway.live[0]!.emit('resumed');
    expect(gateway.presences).toHaveLength(2);
    // The log (Discord Bot → Logs): newest first, with why each was sent.
    expect((await presence()).history.map((e) => [e.reason, e.state])).toEqual([
      ['reconnected', 'sent'],
      ['reconnected', 'sent'],
      ['saved', 'not_sent'],
    ]);
  });

  it('a session that refuses the update is reported as not applied, with the reason', async () => {
    await online();
    gateway.failPresence = true;
    const res = await save({ status: 'idle', customStatus: null, activity: null });
    expect(res.body.applied).toMatchObject({ state: 'failed', problem: 'Shard is not ready.' });
    expect(res.body.saved).toEqual({ status: 'idle', customStatus: null, activity: null });
  });

  it('validates fields Discord supports for bots', async () => {
    const issue = async (body: unknown) => (await save(body)).body.error?.issues?.[0];
    expect(await issue({ status: 'away', customStatus: null, activity: null })).toMatchObject({ path: 'status' });
    expect(await issue({ status: 'online', customStatus: 'x'.repeat(129), activity: null })).toMatchObject({ path: 'customStatus', message: 'Up to 128 characters' });
    expect(await issue({ status: 'online', customStatus: 'two\nlines', activity: null })).toMatchObject({ path: 'customStatus' });
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'streaming', name: 'Live', url: null } })).toMatchObject({ path: 'activity.url' });
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'streaming', name: 'Live', url: 'https://example.com/live' } })).toMatchObject({ path: 'activity.url' });
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'playing', name: 'Game', url: 'https://twitch.tv/retronix' } })).toMatchObject({ path: 'activity.url', message: 'Only Streaming uses a link' });
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'custom', name: 'x', url: null } })).toMatchObject({ path: 'activity.type' });
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'playing', name: '  ', url: null } })).toMatchObject({ path: 'activity.name' });
    // Rich Presence extras games use (images, buttons, timestamps) aren't accepted for bots.
    expect(await issue({ status: 'online', customStatus: null, activity: { type: 'playing', name: 'x', url: null, buttons: ['a'] } })).toBeDefined();
    expect(gateway.presences).toEqual([]);
    expect(await presence()).toMatchObject({ saved: null });
  });

  it('too many changes in a minute are refused with a clear message instead of being dropped by Discord', async () => {
    await online();
    for (let i = 0; i < 5; i++) expect((await save({ status: 'online', customStatus: `n${i}`, activity: null })).status).toBe(200);
    const sixth = await save({ status: 'online', customStatus: 'n5', activity: null });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error?.message).toMatch(/only a few presence changes a minute/);
    h.clock.advance(61_000);
    expect((await save({ status: 'online', customStatus: 'n6', activity: null })).status).toBe(200);
  });
});
