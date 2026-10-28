/**
 * Discord slash commands for channels and settings: /slowmode, /lock, /unlock, /sticky and /loyalty —
 * against a simulated Discord REST API and gateway (automated, mocked — not proof of live Discord behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loyaltyLevelsRepo, loyaltyRepo } from '@conduit/database';
import { DEFAULT_LOGGING_SETTINGS, DEFAULT_LOYALTY_SETTINGS, type StickyMessagesState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import type { IncomingCommand } from '../../apps/server/src/discord/commands/types';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

const GUILD = '42';
const GENERAL = '500000000000000001';
const RULES = '500000000000000002';
const ALICE = '900000000000000041';
const BOB = '900000000000000042';
const ADMINISTRATOR = 1n << 3n;
const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_ROLES = 1n << 28n;
const SEND = 1n << 11n;

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: GENERAL, name: 'general' },
    { id: RULES, name: 'rules' },
  ]);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  const end = Date.now() + 3000;
  while ((await h.call<{ bot: { status: string } }>('GET', '/api/discord/setup')).body.bot.status !== 'connected' && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
});
afterEach(async () => {
  await h.close();
});

/** Runs a command as a member with these permissions (default: an administrator) in #general. */
const runAs = (commandName: string, options: IncomingCommand['options'] = [], memberPermissions = ADMINISTRATOR, userId = '555555555555555555') =>
  gateway.interact({ commandName, guildId: GUILD, channelId: GENERAL, channelName: 'general', userId, userName: 'admin', memberPermissions, options });
const run = runAs;
const sub = (name: string, options: IncomingCommand['options'] = []) => [{ name, type: 1, options }];
const reply = async (i: Promise<{ replies: Array<{ content: string; ephemeral?: boolean }> }>) => (await i).replies[0]!;
const channel = (id: string) => discord.channels.get(GUILD)!.find((c) => c.id === id)!;
const everyone = (id: string) => channel(id).permission_overwrites.find((o) => o.id === GUILD);

describe('/slowmode, /lock, /unlock', () => {
  // Discord sends a member's computed permissions: an administrator has every bit.
  const run = (commandName: string, options: IncomingCommand['options'] = [], memberPermissions = ADMINISTRATOR | MANAGE_CHANNELS) => runAs(commandName, options, memberPermissions);
  it('slowmode sets the channel’s wait (this channel or the one picked), and says so privately', async () => {
    discord.grantBot(GUILD, MANAGE_CHANNELS | MANAGE_ROLES);
    expect(await reply(run('slowmode', [{ name: 'duration', type: 4, value: 30 }]))).toEqual({ content: `Slowmode in <#${GENERAL}> is now 30 seconds.`, ephemeral: true });
    expect(channel(GENERAL).rate_limit_per_user).toBe(30);
    expect(await reply(run('slowmode', [{ name: 'duration', type: 4, value: 0 }, { name: 'channel', type: 7, value: RULES }]))).toMatchObject({ content: `Slowmode is off in <#${RULES}>.` });
    expect(channel(RULES).rate_limit_per_user).toBe(0);
    // A value that isn't one of the choices is refused before anything happens.
    expect((await reply(run('slowmode', [{ name: 'duration', type: 4, value: 7 }]))).content).toMatch(/options weren't valid/);
  });

  it('a refusal from Discord is a failure that says which permission is missing', async () => {
    const r = await reply(run('slowmode', [{ name: 'duration', type: 4, value: 5 }]));
    expect(r).toMatchObject({ ephemeral: true });
    expect(r.content).toMatch(/I need Manage Channels there/);
    expect(channel(GENERAL).rate_limit_per_user).toBeUndefined();
  });

  it('lock denies @everyone posting (keeping the rest of that overwrite), posts a notice; unlock puts it back', async () => {
    discord.grantBot(GUILD, MANAGE_CHANNELS | MANAGE_ROLES);
    channel(GENERAL).permission_overwrites.push({ id: GUILD, type: 0, allow: (1n << 6n).toString(), deny: '0' });
    expect((await reply(run('lock', [{ name: 'reason', type: 3, value: 'raid' }]))).content).toBe(`<#${GENERAL}> is locked. Use /unlock to open it again.`);
    const locked = everyone(GENERAL)!;
    expect(BigInt(locked.deny) & SEND).toBe(SEND);
    expect(BigInt(locked.allow)).toBe(1n << 6n); // Add Reactions stays allowed
    expect([...discord.messages.values()].filter((m) => m.channelId === GENERAL).map((m) => m.body.content)).toEqual(['🔒 This channel is locked.']);
    expect((await reply(run('lock'))).content).toMatch(/already locked/);
    expect((await reply(run('unlock'))).content).toBe(`<#${GENERAL}> is unlocked.`);
    expect(everyone(GENERAL)).toMatchObject({ allow: (1n << 6n).toString(), deny: '0' });
    expect((await reply(run('unlock'))).content).toMatch(/isn’t locked/);
  });

  it('unlock removes the overwrite when lock made it; only members with Manage Channels can use them', async () => {
    discord.grantBot(GUILD, MANAGE_CHANNELS | MANAGE_ROLES);
    await run('lock', [{ name: 'channel', type: 7, value: RULES }]);
    expect(everyone(RULES)).toBeDefined();
    await run('unlock', [{ name: 'channel', type: 7, value: RULES }]);
    expect(everyone(RULES)).toBeUndefined();
    expect((await reply(run('lock', [], 1n << 13n))).content).toMatch(/don't have permission/);
    expect(auditActions(h).filter((a) => a.action === 'discord.command.used').length).toBeGreaterThanOrEqual(2);
  });
});

describe('/kick', () => {
  const KICK_MEMBERS = 1n << 1n;
  const kick = (memberPermissions: bigint) => reply(runAs('kick', [{ name: 'user', type: 6, value: ALICE }, { name: 'reason', type: 3, value: 'spam' }], memberPermissions));

  it('removes the member with the reason in the audit log; refuses without the permission or above the moderator', async () => {
    discord.addMember(GUILD, { id: ALICE, username: 'alice' });
    discord.owners.set(GUILD, '555555555555555555'); // the member running it owns the server
    expect((await kick(KICK_MEMBERS)).content).toMatch(/don’t have the “Kick Members” permission/);
    discord.grantBot(GUILD, KICK_MEMBERS);
    expect((await kick(1n << 13n)).content).toMatch(/don't have permission/); // Manage Messages alone isn't enough
    expect(await kick(KICK_MEMBERS)).toEqual({ content: 'I’ve kicked alice.', ephemeral: true });
    expect(discord.kicked).toEqual([ALICE]);
  });
});

describe('/sticky', () => {
  const stickies = async () => (await h.call<StickyMessagesState>('GET', '/api/discord/stickies')).body.stickies;

  it('set creates a sticky (\\n starts a new line), set again changes its text, list and remove', async () => {
    const r = await reply(run('sticky', sub('set', [{ name: 'channel', type: 7, value: RULES, label: 'rules' }, { name: 'message', type: 3, value: 'Be kind\\nNo spam' }])));
    expect(r.content).toBe(`<#${RULES}> now has a sticky message. Edit it further in CONDUIT → Sticky Messages.`);
    expect(await stickies()).toEqual([expect.objectContaining({ name: '#rules', channelId: RULES, message: { content: 'Be kind\nNo spam', embed: null } })]);
    await reply(run('sticky', sub('set', [{ name: 'channel', type: 7, value: RULES }, { name: 'message', type: 3, value: 'Be nice' }])));
    expect((await stickies())[0]!.message.content).toBe('Be nice');
    expect((await reply(run('sticky', sub('list')))).content).toBe(`Sticky messages:\n• <#${RULES}> — #rules`);
    expect((await reply(run('sticky', sub('remove', [{ name: 'channel', type: 7, value: RULES }])))).content).toBe(`The sticky message in <#${RULES}> is removed.`);
    expect(await stickies()).toEqual([]);
    expect((await reply(run('sticky', sub('remove', [{ name: 'channel', type: 7, value: RULES }])))).content).toMatch(/has no sticky/);
  });
});

describe('/loyalty', () => {
  const on = async () => {
    await h.call('POST', '/api/loyalty/settings', { body: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true } });
    await new Promise((r) => setTimeout(r, 50));
  };
  const user = (id: string, label: string) => ({ name: 'user', type: 6, value: id, label });
  const amount = (n: number) => ({ name: 'amount', type: 4, value: n });

  it('add and remove XP and points for a member (even one without any yet), recorded in their history', async () => {
    await on();
    expect((await reply(run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(250)])))).content).toBe('Gave 250 XP to **alice**. They now have 250 XP (level 1).');
    expect((await reply(run('loyalty', sub('remove-xp', [user(ALICE, 'alice'), amount(50), { name: 'reason', type: 3, value: 'spam' }])))).content).toBe(
      'Took 50 XP from **alice**. They now have 200 XP (level 1).',
    );
    expect((await reply(run('loyalty', sub('remove-xp', [user(ALICE, 'alice'), amount(500)])))).content).toMatch(/below 0/);
    expect((await reply(run('loyalty', sub('add-points', [user(ALICE, 'alice'), amount(100)])))).content).toMatch(/^Gave 100 .+ to \*\*alice\*\*\. They now have 100 /);
    expect((await reply(run('loyalty', sub('remove-points', [user(BOB, 'bob'), amount(5)])))).content).toMatch(/\*\*bob\*\* has no/);
    expect(loyaltyLevelsRepo.xpEvents(h.db, ALICE, 10).map((e) => e.reason)).toEqual(['spam', '/loyalty add-xp by admin']);
    expect(loyaltyRepo.getAccount(h.db, 'discord', ALICE)!.balance).toBe(100);
  });

  it('reset-user sets a member’s XP and points back to 0', async () => {
    await on();
    await run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(300)]));
    await run('loyalty', sub('add-points', [user(ALICE, 'alice'), amount(40)]));
    expect((await reply(run('loyalty', sub('reset-user', [user(ALICE, 'alice')])))).content).toMatch(/^Reset \*\*alice\*\*: 300 XP and 40 .+ → 0\./);
    expect(loyaltyLevelsRepo.get(h.db, GUILD, ALICE)).toMatchObject({ xp: 0, level: 0, announcedLevel: 0 });
    expect(loyaltyRepo.getAccount(h.db, 'discord', ALICE)!.balance).toBe(0);
    expect((await reply(run('loyalty', sub('reset-user', [user(ALICE, 'alice')])))).content).toMatch(/has no XP or/);
    expect(auditActions(h).some((a) => a.action === 'loyalty.reset')).toBe(true);
  });

  it('reset-leaderboard asks for a Confirm click from the same admin, then resets everyone’s XP once', async () => {
    await on();
    await run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(300)]));
    await run('loyalty', sub('add-xp', [user(BOB, 'bob'), amount(120)]));
    const ask = (await run('loyalty', sub('reset-leaderboard'))).replies[0]!;
    expect(ask).toMatchObject({ ephemeral: true });
    expect(ask.content).toMatch(/all 2 members with XP/);
    const id = (ask.components as any)[0].components[0].custom_id as string;
    expect(id).toMatch(/^loyalty:reset:[0-9a-f]{32}$/);
    // Someone else's click does nothing.
    expect((await gateway.click(id, { userId: BOB, messageId: null })).replies[0]!.content).toMatch(/expired/);
    expect(loyaltyLevelsRepo.get(h.db, GUILD, ALICE)!.xp).toBe(300);
    expect((await gateway.click(id, { userId: '555555555555555555', messageId: null })).replies[0]!.content).toBe('Done: the XP of 2 members is back to 0.');
    expect(loyaltyLevelsRepo.withXp(h.db, GUILD)).toEqual([]);
    expect((await gateway.click(id, { userId: '555555555555555555', messageId: null })).replies[0]!.content).toMatch(/expired/);
  });

  it('with XP & Loyalty logging on, its changes and resets are logged with who ran them', async () => {
    await on();
    await h.call('POST', '/api/discord/logging', { body: { ...DEFAULT_LOGGING_SETTINGS, guildId: GUILD, loyalty: { enabled: true, channelId: RULES, off: [] } } });
    await run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(300)]));
    await run('loyalty', sub('add-points', [user(ALICE, 'alice'), amount(40)]));
    await run('loyalty', sub('reset-user', [user(ALICE, 'alice')]));
    await run('loyalty', sub('add-xp', [user(BOB, 'bob'), amount(10)]));
    const ask = (await run('loyalty', sub('reset-leaderboard'))).replies[0]!;
    await gateway.click((ask.components as any)[0].components[0].custom_id as string, { userId: '555555555555555555', messageId: null });
    await h.services.loyalty.idle();
    await h.services.logging.idle();
    const e = [...discord.messages.values()].filter((m) => m.channelId === RULES).map((m) => m.body.embeds[0]);
    expect(e.map((x) => x.title)).toEqual(['XP added', expect.stringMatching(/ added$/), 'Member reset', 'XP added', 'Leaderboard reset']);
    expect(e[0].fields.at(-1)).toEqual({ name: 'Reason', value: '/loyalty add-xp by admin', inline: false });
    expect(e[2]).toMatchObject({ description: `<@${ALICE}> **alice**` });
    expect(e[2].fields).toEqual(expect.arrayContaining([{ name: 'XP', value: '300 → 0', inline: true }, { name: 'By', value: 'admin', inline: true }]));
    expect(e[4].description).toBe('The XP of **1** members was set to 0.');
  });

  it('is Admin only, and XP changes need XP & levels on', async () => {
    await on();
    expect((await reply(run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(1)]), 1n << 13n))).content).toMatch(/admin only/i);
    await h.call('POST', '/api/loyalty/settings', { body: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true, xp: { ...DEFAULT_LOYALTY_SETTINGS.xp, enabled: false } } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await reply(run('loyalty', sub('add-xp', [user(ALICE, 'alice'), amount(1)])))).content).toBe('XP & levels are off in Loyalty & Rewards.');
  });
});
