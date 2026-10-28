/**
 * Loyalty & Rewards (Discord only): XP and levels, level-up announcements and role rewards, the separate points
 * ledger, rewards, redemptions and the slash commands — against a simulated Discord REST API and gateway (automated,
 * mocked — not proof of live Discord behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loyaltyLevelsRepo, loyaltyRepo, migrate, migrations, openDatabase } from '@conduit/database';
import type { LoyaltyLogEntry, LoyaltyMemberHistory, LoyaltyMemberPage, LoyaltyRedemptionView, LoyaltyRewardView, LoyaltyRoleOptions, LoyaltySettings, LoyaltyState } from '@conduit/shared';
import { DEFAULT_LOGGING_SETTINGS, DEFAULT_LOYALTY_SETTINGS, EMPTY_EMBED, levelForXp, levelProgress, totalXpForLevel, xpForNextLevel, type LoggingState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

const GUILD = '42';
const GUILD2 = '43';
const GENERAL = '500000000000000001';
const LEVELS = '500000000000000002';
const OTHER = '500000000000000009';
const ALICE = '900000000000000031';
const BOB = '900000000000000032';
const ROLE_LOW = '700000000000000001';
const ROLE_HIGH = '700000000000000002';
const MANAGE_ROLES = 1n << 28n;

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;
/** The next XP amounts: 0 → the minimum, 0.999… → the maximum. */
let rolls: number[] = [];

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const state = async () => (await call<LoyaltyState>('GET', '/api/loyalty')).body;
type Over = { xp?: Partial<LoyaltySettings['xp']>; discord?: Partial<LoyaltySettings['discord']>; top?: Partial<LoyaltySettings> };
const settings = (o: Over = {}): LoyaltySettings => ({
  ...DEFAULT_LOYALTY_SETTINGS,
  enabled: true,
  ...o.top,
  xp: { ...DEFAULT_LOYALTY_SETTINGS.xp, minXp: 20, maxXp: 20, cooldownSeconds: 60, ...o.xp },
  discord: { ...DEFAULT_LOYALTY_SETTINGS.discord, pointsPerMessage: 10, cooldownSeconds: 60, ...o.discord },
});
const save = (o: Over = {}) => call<LoyaltyState>('POST', '/api/loyalty/settings', settings(o));
let lastMessageId = '';
const chat = (authorId: string, o: { guildId?: string; channelId?: string; bot?: boolean; system?: boolean; hash?: string; messageId?: string } = {}) => {
  const channelId = o.channelId ?? (o.guildId === GUILD2 ? OTHER : GENERAL);
  lastMessageId = o.messageId ?? discord.userPosts(channelId);
  gateway.event({
    type: 'message_create',
    guildId: o.guildId ?? GUILD,
    channelId,
    messageId: lastMessageId,
    authorId,
    authorBot: o.bot ?? false,
    authorName: authorId === ALICE ? 'alice' : 'bob',
    ...(o.system ? { system: true } : {}),
    ...(o.hash ? { contentHash: o.hash } : {}),
  });
};
const xp = (userId: string, guildId = GUILD) => loyaltyLevelsRepo.get(h.db, guildId, userId)?.xp ?? 0;
const points = (userId: string) => loyaltyRepo.getAccount(h.db, 'discord', userId)?.balance ?? 0;
const posted = (channelId: string) => [...discord.messages.values()].filter((m) => m.channelId === channelId);
const ledgerConsistent = () =>
  (h.db.prepare('SELECT a.balance AS b, COALESCE((SELECT SUM(amount) FROM loyalty_transactions t WHERE t.platform = a.platform AND t.user_id = a.user_id), 0) AS s FROM loyalty_accounts a').all() as Array<{ b: number; s: number }>).every((r) => r.b === r.s);
const xpConsistent = () =>
  (h.db.prepare('SELECT l.xp AS x, l.level AS lv, COALESCE((SELECT SUM(amount) FROM loyalty_xp_events e WHERE e.guild_id = l.guild_id AND e.user_id = l.user_id), 0) AS s FROM loyalty_levels l').all() as Array<{ x: number; lv: number; s: number }>).every(
    (r) => r.x === r.s && r.lv === levelForXp(r.x),
  );
const givePoints = async (userId: string, amount: number) => {
  if (!loyaltyRepo.getAccount(h.db, 'discord', userId) && !loyaltyLevelsRepo.get(h.db, GUILD, userId)) chat(userId);
  return call('POST', '/api/loyalty/members/points', { userId, amount, reason: 'Test setup' });
};
const reward = async (body: Record<string, unknown>) => (await call<LoyaltyRewardView>('POST', '/api/loyalty/rewards', { cost: 50, ...body })).body;

/** A backend restart, with the bot's gateway session back up (as when CONDUIT starts). */
async function restart(): Promise<void> {
  await h.restart();
  await h.services.discord.startBot();
  await botReady();
}

async function botReady(): Promise<void> {
  const end = Date.now() + 3000;
  while ((await h.call<{ bot: { status: string } }>('GET', '/api/discord/setup')).body.bot.status !== 'connected' && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}

beforeEach(async () => {
  rolls = [];
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [
    { id: GUILD, name: 'Retro Server' },
    { id: GUILD2, name: 'Second Server' },
  ];
  gateway.guilds = discord.botGuilds;
  discord.addServerWithChannels(GUILD, [
    { id: GENERAL, name: 'general' },
    { id: LEVELS, name: 'level-ups' },
  ]);
  discord.addServerWithChannels(GUILD2, [{ id: OTHER, name: 'chat' }]);
  discord.addRole(GUILD, ROLE_LOW, 1, { name: 'Regular' });
  discord.addRole(GUILD, ROLE_HIGH, 10, { name: 'Admin' });
  discord.grantBot(GUILD, MANAGE_ROLES);
  discord.setBotRolePosition(GUILD, 5);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory, random: () => rolls.shift() ?? 0 });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

describe('settings', () => {
  it('starts off: nothing is earned and no loyalty commands are registered', async () => {
    const s = await state();
    expect(s.settings).toEqual(DEFAULT_LOYALTY_SETTINGS);
    expect(s.settings).not.toHaveProperty('kick');
    expect(s.stats).toMatchObject({ viewers: 0, outstanding: 0, pending: 0, members: 0, totalXp: 0, legacyKick: { accounts: 0, points: 0 } });
    chat(ALICE);
    expect([xp(ALICE), points(ALICE)]).toEqual([0, 0]);
    expect(h.services.loyalty.slashCommands()).toEqual([]);
  });

  it('validates settings on the backend (no Kick options any more) and audits changes', async () => {
    const bad = async (body: unknown) => (await call('POST', '/api/loyalty/settings', body)).body.error?.issues?.[0];
    expect(await bad({ ...settings(), kick: { earn: true } })).toBeTruthy();
    expect(await bad({ ...settings(), xp: { ...settings().xp, minXp: 30, maxXp: 10 } })).toMatchObject({ path: 'xp.maxXp' });
    expect(await bad({ ...settings(), xp: { ...settings().xp, announce: { enabled: true, guildId: GUILD, channelId: null, template: 'x', embed: null } } })).toMatchObject({ path: 'xp.announce.channelId' });
    expect(await bad({ ...settings(), discord: { ...settings().discord, cooldownSeconds: 1 } })).toMatchObject({ path: 'discord.cooldownSeconds' });
    expect((await save({ top: { pointsName: 'coins' } })).body.settings).toMatchObject({ enabled: true, pointsName: 'coins' });
    expect(auditActions(h).some((a) => a.action === 'loyalty.settings_updated')).toBe(true);
  });

  it('settings saved by the earlier version (with Kick options) are read, and the Kick part is ignored', async () => {
    h.db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('loyalty.settings', ?, 'x')")
      .run(JSON.stringify({ enabled: true, pointsName: 'coins', kick: { earn: true, pointsPerMessage: 5, cooldownSeconds: 60, dailyLimit: 0, commands: true, subscriberBonus: 3 }, discord: { earn: true, pointsPerMessage: 7, cooldownSeconds: 60, dailyLimit: 0, commands: true } }));
    const s = (await state()).settings;
    expect(s).toMatchObject({ enabled: true, pointsName: 'coins', discord: { earn: true, pointsPerMessage: 7 }, xp: DEFAULT_LOYALTY_SETTINGS.xp });
    expect(s).not.toHaveProperty('kick');
  });
});

describe('XP from Discord messages', () => {
  beforeEach(async () => {
    await save({ xp: { minXp: 15, maxXp: 25 } });
  });

  it('awards a random amount in the range, once per cooldown per member; bots, webhooks and system messages never earn', async () => {
    rolls = [0, 0.9999];
    chat(ALICE);
    chat(ALICE); // within the cooldown
    chat(BOB);
    chat('900000000000000099', { bot: true });
    chat(ALICE, { system: true });
    expect([xp(ALICE), xp(BOB)]).toEqual([15, 25]);
    expect(loyaltyLevelsRepo.get(h.db, GUILD, '900000000000000099')).toBeUndefined();
    h.clock.advance(60_000);
    chat(ALICE);
    expect(xp(ALICE)).toBe(30);
    expect(xpConsistent()).toBe(true);
  });

  it('XP only by default: messages give no points unless "messages also earn points" is on', async () => {
    chat(ALICE);
    expect([xp(ALICE) > 0, points(ALICE)]).toEqual([true, 0]);
    expect(loyaltyRepo.getAccount(h.db, 'discord', ALICE)).toBeUndefined();
  });

  it('a repeated message (same content fingerprint) earns nothing, even after the cooldown', async () => {
    chat(ALICE, { hash: 'aaa' });
    h.clock.advance(61_000);
    chat(ALICE, { hash: 'aaa' });
    expect(xp(ALICE)).toBe(15);
    chat(ALICE, { hash: 'bbb' });
    expect(xp(ALICE)).toBe(30);
    await save({ xp: { ignoreRepeats: false } });
    h.clock.advance(61_000);
    chat(ALICE, { hash: 'bbb' });
    expect(xp(ALICE)).toBe(50);
  });

  it('the same message delivered twice earns once (unique message id), also after a restart', async () => {
    chat(ALICE, { messageId: '12345' });
    await restart();
    h.clock.advance(5 * 60_000);
    chat(ALICE, { messageId: '12345' });
    expect(xp(ALICE)).toBe(15);
    expect(h.services.loyalty.awardXp(GUILD, { id: ALICE, name: 'alice' }, '12345', null, GENERAL)).toBe('duplicate');
  });

  it('concurrent messages from many members: each counted exactly once; one member is limited by the cooldown', async () => {
    const people = Array.from({ length: 20 }, (_, i) => `9100000000000000${String(i).padStart(2, '0')}`);
    for (const p of people) chat(p);
    for (let i = 0; i < 10; i++) chat(ALICE);
    expect(people.every((p) => xp(p) === 15)).toBe(true);
    expect(xp(ALICE)).toBe(15);
    expect(xpConsistent()).toBe(true);
  });

  it('servers are separate: XP, levels and ranks are per server', async () => {
    chat(ALICE);
    chat(ALICE, { guildId: GUILD2 });
    h.clock.advance(61_000);
    chat(ALICE, { guildId: GUILD2 });
    expect([xp(ALICE, GUILD), xp(ALICE, GUILD2)]).toEqual([15, 30]);
    const page = (await call<LoyaltyMemberPage>('POST', '/api/loyalty/members/query', { guildId: GUILD2 })).body;
    expect(page.members.map((m) => [m.userId, m.xp, m.rank])).toEqual([[ALICE, 30, 1]]);
  });

  it('levels follow the formula; progress is reported; everything survives a restart (cooldown too)', async () => {
    expect([xpForNextLevel(0), xpForNextLevel(1), xpForNextLevel(2), totalXpForLevel(3)]).toEqual([100, 155, 220, 475]);
    expect([levelForXp(99), levelForXp(100), levelForXp(254), levelForXp(255)]).toEqual([0, 1, 1, 2]);
    expect(levelProgress(130)).toEqual({ level: 1, xpIntoLevel: 30, xpForNext: 155, totalForNext: 255 });
    await save({ xp: { minXp: 60, maxXp: 60 } });
    chat(ALICE);
    h.clock.advance(61_000);
    chat(ALICE);
    expect(loyaltyLevelsRepo.get(h.db, GUILD, ALICE)).toMatchObject({ xp: 120, level: 1 });
    await restart();
    const page = (await call<LoyaltyMemberPage>('POST', '/api/loyalty/members/query', { guildId: GUILD })).body;
    expect(page.members[0]).toMatchObject({ userId: ALICE, displayName: 'alice', xp: 120, progress: { level: 1, xpIntoLevel: 20, xpForNext: 155 }, rank: 1 });
    expect(h.services.loyalty.awardXp(GUILD, { id: ALICE, name: 'alice' }, 'after-restart', null, GENERAL)).toBe('cooldown');
  });

  it('switching XP off keeps everyone’s progress; a member who leaves and comes back keeps theirs', async () => {
    chat(ALICE);
    await save({ xp: { enabled: false } });
    h.clock.advance(61_000);
    chat(ALICE);
    expect(xp(ALICE)).toBe(15);
    await save({ xp: { minXp: 15, maxXp: 25 } });
    discord.departed.add(ALICE); // left the server; same server and member ids when back
    h.clock.advance(61_000);
    chat(ALICE);
    expect(xp(ALICE)).toBe(30);
  });
});

describe('administrator XP adjustments', () => {
  beforeEach(async () => {
    await save({});
    chat(ALICE);
  });

  it('need a reason, recalculate the level both ways, never go below 0, are audited and never announced', async () => {
    await save({ xp: { announce: { enabled: true, guildId: null, channelId: null, template: 'GG {user} level {level}', embed: null } } });
    expect((await call('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: 500 })).status).toBe(400);
    const up = await call<LoyaltyMemberHistory>('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: 500, reason: 'Event winner' });
    expect(up.body.levels[0]).toMatchObject({ xp: 520, progress: { level: 3 } });
    expect(up.body.xpEvents[0]).toMatchObject({ kind: 'adjustment', amount: 500, reason: 'Event winner', levelAfter: 3 });
    const down = await call<LoyaltyMemberHistory>('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: -470, reason: 'Correction' });
    expect(down.body.levels[0]).toMatchObject({ xp: 50, progress: { level: 0 } });
    const below = await call('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: -51, reason: 'Too much' });
    expect(below.status).toBe(400);
    expect(below.body.error!.issues![0]!.message).toMatch(/below 0/);
    expect((await call('POST', '/api/loyalty/members/xp', { guildId: GUILD2, userId: ALICE, amount: 5, reason: 'Unknown here' })).status).toBe(404);
    await h.services.loyalty.idle();
    expect(posted(GENERAL)).toEqual([]); // adjustments are never announced
    expect(auditActions(h).filter((a) => a.action === 'loyalty.xp_adjusted')).toHaveLength(2);
    expect(xpConsistent()).toBe(true);
  });
});

describe('level-up announcements', () => {
  it('announce once per level, in the channel where it happened, without pinging anyone', async () => {
    await save({ xp: { minXp: 100, maxXp: 100, cooldownSeconds: 10, announce: { enabled: true, guildId: null, channelId: null, template: 'GG {user} ({username}), level {level}!', embed: null } } });
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(posted(GENERAL).map((m) => m.body)).toEqual([expect.objectContaining({ content: `GG <@${ALICE}> (alice), level 1!`, allowed_mentions: { parse: [] } })]);
    // A level reached again (XP lowered, then raised) and a restart don't repeat the announcement.
    await call('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: -100, reason: 'Reset' });
    await restart();
    h.clock.advance(11_000);
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    // The next new level is announced.
    h.clock.advance(11_000);
    chat(ALICE);
    h.clock.advance(11_000);
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(posted(GENERAL).map((m) => m.body.content)).toEqual([`GG <@${ALICE}> (alice), level 1!`, `GG <@${ALICE}> (alice), level 2!`]);
  });

  it('a fixed announcement channel is used for that server only; a failed post keeps the XP and is reported', async () => {
    await save({ xp: { minXp: 100, maxXp: 100, announce: { enabled: true, guildId: GUILD, channelId: LEVELS, template: '{username} is level {level}', embed: null } } });
    chat(ALICE);
    chat(BOB, { guildId: GUILD2 }); // another server: announced where it happened
    await h.services.loyalty.idle();
    expect(posted(LEVELS).map((m) => m.body.content)).toEqual(['alice is level 1']);
    expect(posted(OTHER).map((m) => m.body.content)).toEqual(['bob is level 1']);
    discord.messageFailures.push({ status: 403, code: 50013 });
    chat(BOB);
    h.clock.advance(61_000);
    chat(BOB);
    await h.services.loyalty.idle();
    expect(xp(BOB)).toBe(200);
    const s = await state();
    expect(s.problems[0]!.detail).toMatch(/Level-up announcement for bob \(level 1\) wasn’t posted/);
    expect(posted(LEVELS)).toHaveLength(1); // not retried
  });
});

describe('level-up announcements with an embed', () => {
  it('posts the embed with the same variables filled in; the text is optional; text or embed is required', async () => {
    const embed = { ...EMPTY_EMBED, title: 'Level {level}!', description: '{user} ({username}) levelled up.', color: '#048BA8' };
    const announce = (template: string, e: typeof embed | null) => ({ enabled: true, guildId: null, channelId: null, template, embed: e });
    const bad = await call('POST', '/api/loyalty/settings', settings({ xp: { announce: announce('', null) } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error!.issues![0]).toMatchObject({ path: 'xp.announce.template', message: 'Add message text or an embed' });
    expect((await call('POST', '/api/loyalty/settings', settings({ xp: { announce: announce('', { ...embed, imageUrl: 'javascript:alert(1)' }) } }))).status).toBe(400);
    expect((await save({ xp: { minXp: 100, maxXp: 100, announce: announce('', embed) } })).status).toBe(200);
    chat(ALICE);
    await h.services.loyalty.idle();
    const [post] = posted(GENERAL);
    expect(post!.body.content).toBeUndefined(); // embed only
    expect(post!.body.embeds).toEqual([{ color: 0x048ba8, title: 'Level 1!', description: `<@${ALICE}> (alice) levelled up.` }]);
    expect(post!.body.allowed_mentions).toEqual({ parse: [] });
    await save({ xp: { minXp: 100, maxXp: 100, cooldownSeconds: 10, announce: announce('GG {user}!', embed) } });
    h.clock.advance(61_000);
    chat(ALICE);
    h.clock.advance(61_000);
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(posted(GENERAL)[1]!.body).toMatchObject({ content: `GG <@${ALICE}>!`, embeds: [{ title: 'Level 2!' }] });
  });
});

describe('role rewards', () => {
  beforeEach(async () => {
    await save({ xp: { minXp: 100, maxXp: 100, cooldownSeconds: 10 } });
  });

  it('only roles the bot can give can be chosen (Manage Roles, below its highest role); one milestone per role', async () => {
    const options = (await call<LoyaltyRoleOptions>('GET', '/api/loyalty/roles')).body;
    const roles = options.guilds.find((g) => g.id === GUILD)!.roles;
    expect(roles.find((r) => r.id === ROLE_LOW)).toMatchObject({ name: 'Regular', assignable: true, problem: null });
    expect(roles.find((r) => r.id === ROLE_HIGH)).toMatchObject({ assignable: false, problem: expect.stringMatching(/at or above the bot’s highest role/) });
    const high = await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_HIGH, level: 2 });
    expect(high.status).toBe(400);
    expect((await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: '700000000000000099', level: 2 })).status).toBe(400);
    expect((await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 1 })).status).toBe(201);
    expect((await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 3 })).status).toBe(409);
    const noPerm = (await call<LoyaltyRoleOptions>('GET', '/api/loyalty/roles')).body.guilds.find((g) => g.id === GUILD2)!;
    expect(noPerm.roles.every((r) => !r.assignable)).toBe(true);
  });

  it('gives the role when the level is reached, once; removing the reward never takes roles away', async () => {
    const r = (await call<{ id: string }>('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 1 })).body;
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(discord.roleAdds).toEqual([{ guildId: GUILD, userId: ALICE, roleId: ROLE_LOW, reason: 'Level 1 reward' }]);
    h.clock.advance(11_000);
    chat(ALICE);
    h.clock.advance(11_000);
    chat(ALICE); // level 2: the level 1 role isn't requested again
    await h.services.loyalty.idle();
    expect(discord.roleAdds).toHaveLength(1);
    expect((await call('DELETE', `/api/loyalty/role-rewards/${r.id}`)).status).toBe(200);
    expect((await state()).roleRewards).toEqual([]);
    expect(discord.roleAdds).toHaveLength(1); // nothing removed from anyone
    expect(auditActions(h).map((a) => a.action)).toEqual(expect.arrayContaining(['loyalty.role_reward_added', 'loyalty.role_reward_removed']));
  });

  it('an admin XP increase gives the role rewards up to the new level', async () => {
    await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 3 });
    chat(ALICE);
    await call('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: 400, reason: 'Event' });
    await h.services.loyalty.idle();
    expect(discord.roleAdds.map((a) => a.roleId)).toEqual([ROLE_LOW]);
  });

  it('a refused role (hierarchy changed, member left) is recorded with a readable reason and the XP is kept', async () => {
    await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 1 });
    discord.setBotRolePosition(GUILD, 1); // someone moved the bot's role down
    chat(ALICE);
    discord.departed.add(BOB);
    chat(BOB);
    await h.services.loyalty.idle();
    expect(discord.roleAdds).toEqual([]);
    expect([xp(ALICE), xp(BOB)]).toEqual([100, 100]);
    const grants = h.db.prepare('SELECT user_id AS userId, status, detail FROM loyalty_role_grants ORDER BY user_id').all();
    expect(grants).toEqual([
      { userId: ALICE, status: 'failed', detail: expect.stringMatching(/needs Manage Roles, and its highest role must be above this role/) },
      { userId: BOB, status: 'failed', detail: 'The member isn’t in the server any more.' },
    ]);
    h.clock.advance(31_000); // past the short role-check cache
    const s = await state();
    expect(s.problems.map((p) => p.detail).join(' ')).toMatch(/Level 1 role for alice wasn’t given/);
    expect(s.roleRewards[0]!.problem).toMatch(/at or above the bot’s highest role/);
    // Fixed: the failed role is tried again at the member's next level-up.
    discord.setBotRolePosition(GUILD, 5);
    h.clock.advance(11_000);
    chat(ALICE);
    h.clock.advance(11_000);
    chat(ALICE);
    await h.services.loyalty.idle();
    expect(discord.roleAdds.map((a) => a.userId)).toEqual([ALICE]);
  });
});

describe('points (separate from XP)', () => {
  beforeEach(async () => {
    await save({ discord: { earn: true } });
  });

  it('messages earn XP and points with their own cooldowns; the two are never converted', async () => {
    await save({ discord: { earn: true, cooldownSeconds: 120 } });
    chat(ALICE);
    h.clock.advance(61_000);
    chat(ALICE); // XP cooldown over, points cooldown not
    expect([xp(ALICE), points(ALICE)]).toEqual([40, 10]);
    const hist = (await call<LoyaltyMemberHistory>('POST', '/api/loyalty/members/history', { userId: ALICE })).body;
    expect(hist.transactions.map((t) => t.kind)).toEqual(['chat']);
    expect(hist.xpEvents.map((e) => e.kind)).toEqual(['message', 'message']);
    expect(ledgerConsistent() && xpConsistent()).toBe(true);
  });

  it('respects the daily limit (UTC day) and never awards the same message twice', async () => {
    await save({ discord: { earn: true, dailyLimit: 25 } });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      chat(ALICE);
      ids.push(lastMessageId);
      h.clock.advance(61_000);
    }
    expect(points(ALICE)).toBe(25);
    h.clock.advance(24 * 60 * 60_000); // even on a new day, an awarded message is never awarded again
    expect(h.services.loyalty.award({ id: ALICE, name: 'alice' }, `discord:chat:${ids[0]}`)).toBe('duplicate');
    chat(ALICE);
    expect(points(ALICE)).toBe(35);
  });

  it('administrator adjustments need a reason, are audited, and never take a balance below 0', async () => {
    chat(ALICE);
    expect((await call('POST', '/api/loyalty/members/points', { userId: ALICE, amount: 50 })).status).toBe(400);
    expect((await call('POST', '/api/loyalty/members/points', { userId: ALICE, amount: 0, reason: 'Nothing' })).status).toBe(400);
    expect((await call('POST', '/api/loyalty/members/points', { platform: 'kick', userId: ALICE, amount: 5, reason: 'Kick' })).status).toBe(400);
    const ok = await call<LoyaltyMemberHistory>('POST', '/api/loyalty/members/points', { userId: ALICE, amount: 50, reason: 'Won the quiz' });
    expect(ok.body.points.balance).toBe(60);
    expect(ok.body.transactions[0]).toMatchObject({ kind: 'adjustment', amount: 50, reason: 'Won the quiz', balanceAfter: 60 });
    expect((await call('POST', '/api/loyalty/members/points', { userId: ALICE, amount: -61, reason: 'Oops' })).status).toBe(400);
    expect((await call('POST', '/api/loyalty/members/points', { userId: '900000000000000077', amount: 5, reason: 'Unknown' })).status).toBe(404);
    expect(xp(ALICE)).toBe(20); // XP untouched by points adjustments
    expect(JSON.parse(auditActions(h).find((a) => a.action === 'loyalty.adjusted')!.metadata)).toMatchObject({ amount: 50, reason: 'Won the quiz' });
    // The Loyalty & Reward Logs show who it was about by name; the user ID isn't repeated in the details.
    // Discord Bot → Logs → Moderation log: who it was about by name, the change and reason; the ids aren't repeated in
    // the details.
    const log = async () => (await call<{ loyaltyHistory: LoyaltyLogEntry[] }>('GET', '/api/moderation/discord')).body.loyaltyHistory;
    expect((await log()).find((e) => e.title === 'Points adjusted' && e.change !== null)).toMatchObject({ userId: ALICE, userName: 'alice', change: '+50 points · balance 60', reason: 'Won the quiz' });
    expect((await log()).filter((e) => e.title === 'Points adjusted')).toHaveLength(1); // not repeated from the audit log
    // Settings saves record their server (here, the level-up channel's), shown by name; with two servers and no
    // announcement channel it's unclear, so none is recorded.
    expect((await log()).find((e) => e.title === 'Loyalty settings saved')).toMatchObject({ place: null });
    await save({ xp: { announce: { enabled: true, guildId: GUILD, channelId: LEVELS, template: 'GG {user}', embed: null } } });
    expect((await log()).find((e) => e.title === 'Loyalty settings saved')).toMatchObject({ place: 'Retro Server', detail: expect.not.stringContaining('guildId') });
  });

  it('concurrent deductions can’t overspend', async () => {
    await givePoints(ALICE, 80);
    expect(points(ALICE)).toBe(90);
    const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/loyalty/members/points', { userId: ALICE, amount: -30, reason: 'Parallel' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(points(ALICE)).toBe(0);
    expect(ledgerConsistent()).toBe(true);
  });
});

describe('rewards and redemptions', () => {
  const redeem = (name: string, key: string) => h.services.loyalty.redeem({ id: ALICE, name: 'alice' }, name, key);
  beforeEach(async () => {
    await save({});
  });

  it('creates, edits, switches off and removes rewards; names are unique and validated', async () => {
    const r = await reward({ name: 'Song request', description: 'Pick the next song', cost: 500 });
    expect((await call('POST', '/api/loyalty/rewards', { name: 'song REQUEST', cost: 10 })).status).toBe(409);
    expect((await call('POST', '/api/loyalty/rewards', { name: '!hack', cost: 10 })).status).toBe(400);
    expect((await call<LoyaltyRewardView>('PATCH', `/api/loyalty/rewards/${r.id}`, { enabled: false })).body).toMatchObject({ enabled: false, cost: 500 });
    expect((await call('DELETE', `/api/loyalty/rewards/${r.id}`)).body).toEqual({ id: r.id, deleted: true });
    expect((await state()).rewards).toEqual([]);
    expect((await call('POST', '/api/loyalty/rewards', { name: 'Song request', cost: 400 })).status).toBe(201);
  });

  it('redeeming takes the points atomically; insufficient, duplicate, unknown, off and sold-out change nothing', async () => {
    await givePoints(ALICE, 120);
    await reward({ name: 'Hydrate', cost: 100 });
    await reward({ name: 'Off', enabled: false });
    const one = await reward({ name: 'Print', cost: 10, stock: 1 });
    expect(redeem('hydrate', 'k:1')).toMatchObject({ outcome: 'redeemed', balance: 20, redemption: { rewardName: 'Hydrate', platform: 'discord', status: 'pending' } });
    expect(redeem('Hydrate', 'k:2')).toEqual({ outcome: 'insufficient', cost: 100, balance: 20 });
    expect(redeem('Hydrate', 'k:1')).toEqual({ outcome: 'duplicate' });
    expect(redeem('Nope', 'k:3')).toEqual({ outcome: 'unknown_reward' });
    expect(redeem('Off', 'k:4')).toEqual({ outcome: 'unavailable' });
    expect(redeem('Print', 'k:5').outcome).toBe('redeemed');
    expect(redeem('Print', 'k:6')).toEqual({ outcome: 'out_of_stock' });
    expect(points(ALICE)).toBe(10);
    expect(loyaltyRepo.getReward(h.db, one.id)!.stock).toBe(0);
    expect(loyaltyRepo.listRedemptions(h.db, null, 10)).toHaveLength(2);
    expect(ledgerConsistent()).toBe(true);
  });

  it('concurrent redemptions can’t overspend', async () => {
    await givePoints(ALICE, 100);
    await reward({ name: 'Shoutout', cost: 60 });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => Promise.resolve().then(() => redeem('Shoutout', `c:${i}`))));
    expect(results.filter((r) => r.outcome === 'redeemed')).toHaveLength(1);
    expect(points(ALICE)).toBe(40);
  });

  it('fulfil keeps the points; reject refunds exactly once (and the quantity); handled ones can’t be handled again', async () => {
    await givePoints(ALICE, 300);
    const emote = await reward({ name: 'Emote', cost: 100, stock: 5 });
    const a = redeem('Emote', 'r:1') as { redemption: { id: string } };
    const b = redeem('Emote', 'r:2') as { redemption: { id: string } };
    expect((await call<LoyaltyRedemptionView>('POST', `/api/loyalty/redemptions/${a.redemption.id}/fulfill`, { note: 'Added' })).body).toMatchObject({ status: 'fulfilled', note: 'Added' });
    expect((await call<LoyaltyRedemptionView>('POST', `/api/loyalty/redemptions/${b.redemption.id}/reject`, {})).body.status).toBe('rejected');
    expect(points(ALICE)).toBe(200);
    expect((await call('POST', `/api/loyalty/redemptions/${b.redemption.id}/reject`, {})).status).toBe(409);
    expect((await call('POST', `/api/loyalty/redemptions/${a.redemption.id}/reject`, {})).status).toBe(409);
    expect(points(ALICE)).toBe(200);
    expect(loyaltyRepo.getReward(h.db, emote.id)!.stock).toBe(4);
    expect(ledgerConsistent()).toBe(true);
  });

  it('a removed reward keeps its redemptions, which can still be handled', async () => {
    await givePoints(ALICE, 100);
    const r = await reward({ name: 'Old reward', cost: 100 });
    const red = redeem('Old reward', 'x:1') as { redemption: { id: string } };
    await call('DELETE', `/api/loyalty/rewards/${r.id}`);
    expect((await state()).redemptions[0]).toMatchObject({ rewardName: 'Old reward', status: 'pending' });
    expect((await call('POST', `/api/loyalty/redemptions/${red.redemption.id}/reject`, {})).status).toBe(200);
    expect(points(ALICE)).toBe(100);
  });
});

describe('Discord slash commands', () => {
  const names = () => (discord.guildCommands.get(GUILD) ?? []).map((c) => c.name).sort();

  it('registers /points, /rewards, /redeem, /level and /leaderboard only while switched on', async () => {
    expect(names()).not.toContain('points');
    await save({});
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).toEqual(expect.arrayContaining(['leaderboard', 'level', 'points', 'redeem', 'rewards']));
    expect(names()).not.toContain('rank');
    await save({ xp: { enabled: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).toEqual(expect.arrayContaining(['points', 'redeem', 'rewards']));
    expect(names()).not.toContain('rank');
    await save({ discord: { commands: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).not.toContain('points');
  });

  it('answer privately; /redeem is charged once per interaction; no branding', async () => {
    await save({ top: { pointsName: 'coins' } });
    await givePoints(ALICE, 130);
    chat(BOB);
    await reward({ name: 'Shoutout', cost: 100 });
    const points = await gateway.interact({ commandName: 'points', guildId: GUILD, userId: ALICE, userName: 'alice' });
    expect(points.replies[0]).toEqual({ content: 'You have 130 coins.', ephemeral: true });
    const rank = await gateway.interact({ commandName: 'level', guildId: GUILD, userId: ALICE, userName: 'alice' });
    expect(rank.replies[0]).toMatchObject({ content: '', ephemeral: true });
    expect(rank.replies[0]!.embeds![0]).toEqual({
      author: { name: 'alice' },
      title: 'Level 0',
      description: '▰▰▱▱▱▱▱▱▱▱▱▱ 20%\n-# 20 / 100 XP to level 1',
      fields: [
        { name: 'Rank', value: '#1 of 2', inline: true },
        { name: 'Total XP', value: '20', inline: true },
        { name: 'Coins', value: '130', inline: true },
      ],
      color: 0x3498db,
    });
    // Someone else's level, by picking them.
    const other = await gateway.interact({ commandName: 'level', guildId: GUILD, userId: ALICE, options: [{ name: 'user', type: 6, value: BOB, label: 'bob' }] });
    expect(other.replies[0]!.embeds![0]).toMatchObject({ author: { name: 'bob' }, title: 'Level 0', fields: [{ name: 'Rank', value: '#2 of 2', inline: true }, expect.anything(), expect.anything()] });
    const board = await gateway.interact({ commandName: 'leaderboard', guildId: GUILD, userId: BOB });
    expect(board.replies[0]).toMatchObject({ content: '', ephemeral: true });
    const embed = board.replies[0]!.embeds![0]!;
    expect(embed).toMatchObject({ title: '🏆 Leaderboard', footer: { text: 'Top 10 by XP · your level: /level' } });
    expect(embed.description).toBe('🥇 **alice**\n-# Level 0 · 20 XP\n🥈 **bob** *(you)*\n-# Level 0 · 20 XP');
    expect(embed.fields).toBeUndefined();
    const list = await gateway.interact({ commandName: 'rewards', guildId: GUILD, userId: BOB });
    expect(list.replies[0]!.content).toContain('Shoutout — 100 coins');
    const redeem = await gateway.interact({ commandName: 'redeem', guildId: GUILD, userId: ALICE, userName: 'alice', options: [{ name: 'reward', type: 3, value: 'shoutout' }] });
    expect(redeem.replies[0]).toMatchObject({ ephemeral: true, content: 'You redeemed Shoutout for 100 coins. It’s waiting for the streamer. You have 30 coins left.' });
    gateway.live[0]!.emit('interaction', redeem);
    await new Promise((r) => setTimeout(r, 30));
    expect(loyaltyRepo.getAccount(h.db, 'discord', ALICE)!.balance).toBe(30);
    const replies = [points, rank, board, list, redeem].flatMap((i) => i.replies.map((r) => r.content + JSON.stringify(r.embeds ?? []))).join('\n');
    expect(replies).not.toMatch(/CONDUIT/);
  });
});

describe('Discord Logging: XP & Loyalty', () => {
  const embeds = async (channelId = LEVELS) => {
    await h.services.loyalty.idle();
    await h.services.logging.idle();
    return posted(channelId).map((m) => m.body.embeds[0]);
  };
  const logTo = (off: string[] = [], guildId = GUILD) =>
    call('POST', '/api/discord/logging', { ...DEFAULT_LOGGING_SETTINGS, guildId, loyalty: { enabled: true, channelId: guildId === GUILD ? LEVELS : OTHER, off } });

  it('is off until switched on; says when Loyalty & Rewards itself is off', async () => {
    expect((await call<LoggingState>('GET', '/api/discord/logging')).body.availability.loyalty.partial).toMatch(/Loyalty & Rewards is off/);
    await save({ discord: { earn: true } });
    await givePoints(ALICE, 50);
    expect(await embeds()).toEqual([]);
    expect((await call<LoggingState>('GET', '/api/discord/logging')).body.availability.loyalty.partial).toBeNull();
  });

  it('logs level-ups, XP and points adjustments, redemptions and their handling, with who, what changed and why', async () => {
    await save({ xp: { minXp: 100, maxXp: 100 } });
    expect((await logTo()).status).toBe(200);
    chat(ALICE); // level 1
    await call('POST', '/api/loyalty/members/xp', { guildId: GUILD, userId: ALICE, amount: -30, reason: 'Spam' });
    await call('POST', '/api/loyalty/members/points', { userId: ALICE, amount: 150, reason: 'Event winner' });
    await reward({ name: 'Emote', cost: 100 });
    const r = h.services.loyalty.redeem({ id: ALICE, name: 'alice' }, 'Emote', 'log:1') as { redemption: { id: string } };
    await call('POST', `/api/loyalty/redemptions/${r.redemption.id}/reject`, { note: 'Out of slots' });
    const e = await embeds();
    expect(e.map((x) => x.title)).toEqual(['Reached level 1', 'XP removed', 'Points added', 'Reward redeemed', 'Redemption rejected']);
    expect(e.every((x) => x.description === `<@${ALICE}> **alice**` && x.footer.text === `User ID: ${ALICE}`)).toBe(true);
    expect(e[0].fields).toEqual([{ name: 'Total XP', value: '100', inline: true }]);
    expect(e[1].fields).toEqual([
      { name: 'Change', value: '−30 XP', inline: true },
      { name: 'Now', value: '70 XP · level 0', inline: true },
      { name: 'Reason', value: 'Spam', inline: false },
    ]);
    expect(e[2].fields).toEqual([
      { name: 'Change', value: '+150 points', inline: true },
      { name: 'Balance', value: '150 points', inline: true },
      { name: 'Reason', value: 'Event winner', inline: false },
    ]);
    expect(e[3].fields).toEqual(expect.arrayContaining([{ name: 'Reward', value: 'Emote', inline: true }, { name: 'Balance', value: '50 points', inline: true }]));
    expect(e[4].fields).toEqual([
      { name: 'Reward', value: 'Emote', inline: true },
      { name: 'Refunded', value: '100 points', inline: true },
      { name: 'Note', value: 'Out of slots', inline: false },
    ]);
    // Not added to the Moderation log a second time (Loyalty & Rewards lists its own changes there).
    expect((await call<{ loggingHistory: unknown[] }>('GET', '/api/moderation/discord')).body.loggingHistory).toEqual([]);
  });

  it('logs level roles given and refused; other servers’ XP isn’t logged; events can be switched off', async () => {
    await save({ xp: { minXp: 100, maxXp: 100 } });
    await call('POST', '/api/loyalty/role-rewards', { guildId: GUILD, roleId: ROLE_LOW, level: 1 });
    await logTo(['level_up']);
    chat(ALICE);
    discord.departed.add(BOB);
    chat(BOB);
    chat(BOB, { guildId: GUILD2 }); // another server: not logged
    const e = await embeds();
    expect(e.map((x) => [x.title, x.description])).toEqual([
      ['Level role given', `<@${ALICE}> **alice**`],
      ['Level role not given', `<@${BOB}> **bob**`],
    ]);
    expect(e[0].fields).toEqual([
      { name: 'Role', value: `<@&${ROLE_LOW}>`, inline: true },
      { name: 'Level', value: '1', inline: true },
    ]);
    expect(e[1].fields.at(-1)).toEqual({ name: 'Discord’s answer', value: 'The member isn’t in the server any more.', inline: false });
  });

  it('uses the points name chosen in Loyalty & Rewards', async () => {
    await save({ top: { pointsName: 'coins' } });
    await logTo();
    await givePoints(ALICE, 5);
    expect((await embeds()).map((x) => [x.title, x.fields[1].value])).toEqual([['Coins added', '5 coins']]);
  });
});

describe('migration 20', () => {
  it('adds the XP tables without touching existing points, rewards, redemptions, Kick history or audit records', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, migrations.filter((m) => m.version <= 19));
      db.exec(`
        INSERT INTO loyalty_accounts (platform, user_id, display_name, balance, lifetime_earned, created_at, updated_at) VALUES
          ('discord', '${ALICE}', 'alice', 40, 140, 'c', 'u'), ('kick', '5550001', 'Viewer', 15, 15, 'c', 'u');
        INSERT INTO loyalty_transactions (id, platform, user_id, amount, balance_after, kind, reason, event_key, created_at) VALUES
          ('11111111-1111-4111-8111-111111111111', 'discord', '${ALICE}', 140, 140, 'chat', 'Chat message', 'discord:chat:1', 'c'),
          ('22222222-2222-4222-8222-222222222222', 'discord', '${ALICE}', -100, 40, 'redemption', 'Redeemed: Hat', 'redeem:x', 'c'),
          ('33333333-3333-4333-8333-333333333333', 'kick', '5550001', 15, 15, 'chat', 'Chat message', 'kick:chat:1', 'c');
        INSERT INTO loyalty_rewards (id, name, cost, created_at, updated_at) VALUES ('44444444-4444-4444-8444-444444444444', 'Hat', 100, 'c', 'u');
        INSERT INTO loyalty_redemptions (id, reward_id, reward_name, platform, user_id, cost, status, request_key, created_at) VALUES
          ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 'Hat', 'discord', '${ALICE}', 100, 'pending', 'k', 'c');
        INSERT INTO audit_logs (occurred_at, action, outcome, metadata) VALUES ('c', 'loyalty.adjusted', 'success', '{}');
      `);
      const before = (sql: string) => JSON.stringify(db.prepare(sql).all());
      const snapshot = ['loyalty_accounts', 'loyalty_transactions', 'loyalty_rewards', 'loyalty_redemptions', 'audit_logs'].map((t) => before(`SELECT * FROM ${t} ORDER BY rowid`));
      expect(migrate(db, migrations)).toEqual({ applied: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
      expect(['loyalty_accounts', 'loyalty_transactions', 'loyalty_rewards', 'loyalty_redemptions', 'audit_logs'].map((t) => before(`SELECT * FROM ${t} ORDER BY rowid`))).toEqual(snapshot);
      expect(loyaltyRepo.stats(db)).toEqual({ viewers: 1, outstanding: 40, pending: 1, legacyKick: { accounts: 1, points: 15 } });
      expect(db.prepare('SELECT COUNT(*) AS n FROM loyalty_levels').get()).toEqual({ n: 0 });
      loyaltyLevelsRepo.ensure(db, GUILD, ALICE, 'alice', 'now');
      expect(() => db.prepare(`UPDATE loyalty_levels SET xp = -1 WHERE user_id = '${ALICE}'`).run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
