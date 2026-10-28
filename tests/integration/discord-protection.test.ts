/**
 * Discord Automated Protection against a simulated Discord REST API and gateway (automated, mocked — not proof of live
 * Discord behaviour): CONDUIT's own AutoMod rules and message checks, anti-nuke, anti-raid and bot bait.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordAutomodRule, DiscordProtectionState, MessageChecks } from '@conduit/shared';
import { ANTINUKE_DEFAULTS, ANTIRAID_DEFAULTS, BOTBAIT_DEFAULTS, MESSAGE_CHECKS_DEFAULTS } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

const GUILD = '420000000000000042';
const GENERAL = '500000000000000001';
const ALERTS = '500000000000000002';
const PERSON = '900000000000000031';
const MOD_ROLE = '700000000000000001';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const state = async () => (await call<DiscordProtectionState>('GET', '/api/discord/protection')).body;

async function botReady(): Promise<void> {
  const end = Date.now() + 3000;
  while ((await h.call<{ bot: { status: string } }>('GET', '/api/discord/setup')).body.bot.status !== 'connected' && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: GENERAL, name: 'general' },
    { id: ALERTS, name: 'mod-alerts' },
  ]);
  discord.addRole(GUILD, MOD_ROLE, 5, { name: 'Mods' });
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

const rule = (over: Record<string, unknown> = {}) => ({
  name: 'No invites',
  enabled: true,
  trigger: 'keyword',
  keywords: ['discord.gg/*'],
  action: 'delete_message',
  alertChannelId: ALERTS,
  ...over,
});

describe('AutoMod (CONDUIT’s own rules)', () => {
  const base = `/api/discord/protection/automod/${GUILD}`;
  const say = (content: string | undefined, o: { authorId?: string; moderator?: boolean; roles?: string[]; mentions?: number; channelId?: string } = {}) => {
    const channelId = o.channelId ?? GENERAL;
    const messageId = discord.userPosts(channelId);
    gateway.event({
      type: 'message_create',
      guildId: GUILD,
      channelId,
      messageId,
      authorId: o.authorId ?? PERSON,
      authorBot: false,
      authorName: 'troll',
      ...(content === undefined ? {} : { content, contentHash: `h-${content}` }),
      authorRoleIds: o.roles ?? [],
      authorModerator: o.moderator ?? false,
      mentionCount: o.mentions ?? 0,
    });
    return messageId;
  };
  const user = (id: string, tag: string) => ({ id, tag, avatarUrl: null, bot: false });
  const events = async () =>
    (await call<{ protectionHistory: Array<{ rule: string; action: string; outcome: string; detail: string | null }> }>('GET', '/api/moderation/discord')).body.protectionHistory;
  const alerts = () => [...discord.messages.values()].filter((m) => m.channelId === ALERTS).map((m) => m.body.embeds?.[0]);

  it('rules are kept by CONDUIT (Discord’s AutoMod is never asked), listed per server, edited, switched and deleted', async () => {
    const created = await call<DiscordAutomodRule>('POST', base, rule());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ guildId: GUILD, name: 'No invites', trigger: 'keyword', action: 'delete_message', timeoutMinutes: 10, exemptModerators: true });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await state()).automod.guilds[0]!.rules.map((r) => r.name)).toEqual(['No invites']);

    const id = created.body.id;
    expect((await call<DiscordAutomodRule>('PATCH', `${base}/${id}`, rule({ name: 'Invite links', action: 'timeout', timeoutMinutes: 30 }))).body).toMatchObject({ name: 'Invite links', action: 'timeout', timeoutMinutes: 30 });
    expect((await call<DiscordAutomodRule>('POST', `${base}/${id}/enabled`, { enabled: false })).body.enabled).toBe(false);
    expect((await call('DELETE', `${base}/${id}`)).status).toBe(204);
    expect((await state()).automod.guilds[0]!.rules).toEqual([]);
    expect(discord.requests.some((r) => r.url.includes('auto-moderation'))).toBe(false);
    expect(auditActions(h).map((a) => a.action)).toEqual(
      expect.arrayContaining(['discord.automod.rule_created', 'discord.automod.rule_updated', 'discord.automod.rule_disabled', 'discord.automod.rule_deleted']),
    );
  });

  it('checks rules before saving; only servers the bot is in; ids must be CONDUIT’s', async () => {
    const bad = await call('POST', base, rule({ action: 'kick' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error?.issues?.map((i) => i.message)).toContain('Custom words rules can’t do that');
    expect((await call('POST', base, rule({ regexPatterns: ['(unclosed'] }))).body.error?.issues?.map((i) => i.message)).toContain('Not a valid regular expression: (unclosed');
    expect((await call('POST', '/api/discord/protection/automod/420000000000000099', rule())).status).toBe(404);
    expect((await call('POST', '/api/discord/protection/automod/not-a-server', rule())).status).toBe(400);
    expect((await call('PATCH', `${base}/1401370810609831966`, rule())).status).toBe(400);
    expect((await call('PATCH', `${base}/00000000-0000-0000-0000-000000000000`, rule())).status).toBe(404);
  });

  it('custom words: deletes the message and posts an alert; moderators, exempt roles and channels, and allowed words are skipped', async () => {
    discord.grantBot(GUILD, 1n << 13n);
    await call('POST', base, rule({ keywords: ['discord.gg/*', '*scam*'], allowList: ['scampi'], exemptRoles: [MOD_ROLE], exemptChannels: [ALERTS] }));
    const hit = say('free nitro at discord.gg/abc');
    say('discord.gg/abc', { moderator: true, authorId: '900000000000000032' });
    say('discord.gg/abc', { roles: [MOD_ROLE], authorId: '900000000000000033' });
    say('discord.gg/abc', { channelId: ALERTS, authorId: '900000000000000034' });
    say('I love scampi', { authorId: '900000000000000035' });
    await h.services.protection.idle();
    expect(discord.deletedMessages).toEqual([hit]);
    const [e] = await events();
    expect(e).toMatchObject({ rule: 'AutoMod: No invites', action: 'delete_message', outcome: 'success' });
    expect(e!.detail).toBe('Used “discord.gg/*”. Message deleted.');
    expect(alerts()).toEqual([
      expect.objectContaining({
        title: 'AutoMod: No invites',
        description: `<@${PERSON}> **troll**\nCustom words · Used “discord.gg/*”.`,
        fields: [
          { name: 'Channel', value: `<#${GENERAL}>`, inline: true },
          { name: 'Action', value: 'Message deleted.', inline: true },
          { name: 'Message', value: 'free nitro at discord.gg/abc', inline: false },
        ],
      }),
    ]);
    expect(JSON.stringify(alerts())).not.toMatch(/CONDUIT/);
  });

  it('“Log only” records and alerts without deleting; switched-off rules do nothing; a burst is reported once', async () => {
    const id = (await call<DiscordAutomodRule>('POST', base, rule({ action: 'log' }))).body.id;
    say('discord.gg/one');
    say('discord.gg/two');
    await h.services.protection.idle();
    expect(discord.deletedMessages).toEqual([]);
    expect((await events()).map((e) => e.outcome)).toEqual(['logged']);
    expect(alerts()).toHaveLength(1);
    await call('POST', `${base}/${id}/enabled`, { enabled: false });
    say('discord.gg/three', { authorId: '900000000000000036' });
    await h.services.protection.idle();
    expect(await events()).toHaveLength(1);
  });

  it('delete and time out: every matching message is deleted, the member is timed out once per burst', async () => {
    discord.grantBot(GUILD, (1n << 13n) | (1n << 40n));
    discord.addMember(GUILD, { id: PERSON, username: 'troll' });
    await call('POST', base, rule({ action: 'timeout', timeoutMinutes: 60, alertChannelId: null }));
    const a = say('discord.gg/one');
    const b = say('discord.gg/two');
    await h.services.protection.idle();
    expect(discord.deletedMessages).toEqual([a, b]);
    expect(discord.members.get(GUILD)!.get(PERSON)!.communication_disabled_until).not.toBeNull();
    const e = await events();
    expect(e).toHaveLength(1);
    expect(e[0]!.detail).toBe('Used “discord.gg/*”. Message deleted. Timed out for 1 hour.');
  });

  it('mention spam: more @mentions than allowed in one message (works without the message text)', async () => {
    discord.grantBot(GUILD, 1n << 13n);
    await call('POST', base, rule({ name: 'Pings', trigger: 'mention_spam', keywords: [], mentionLimit: 5, alertChannelId: null }));
    say(undefined, { mentions: 5 });
    const spam = say(undefined, { mentions: 6, authorId: '900000000000000037' });
    await h.services.protection.idle();
    expect(discord.deletedMessages).toEqual([spam]);
    expect((await events())[0]!.detail).toBe('6 mentions in one message (more than 5). Message deleted.');
  });

  it('a message AutoMod acted on isn’t also handled by the message checks', async () => {
    discord.grantBot(GUILD, 1n << 13n);
    await call('POST', '/api/discord/protection/messages', { ...structuredClone(MESSAGE_CHECKS_DEFAULTS), enabled: true });
    await call('POST', base, rule({ alertChannelId: null }));
    say('discord.gg/abcdef');
    await h.services.protection.idle();
    expect((await events()).map((e) => e.rule)).toEqual(['AutoMod: No invites']);
  });

  it('member names: usernames on join and new nicknames; kicks or times out, never the owner or an exempt role', async () => {
    discord.grantBot(GUILD, (1n << 1n) | (1n << 40n));
    discord.addMember(GUILD, { id: PERSON, username: 'freenitro_bot' });
    await call('POST', base, rule({ name: 'Bad names', trigger: 'member_profile', keywords: ['*nitro*'], action: 'kick', exemptRoles: [MOD_ROLE], alertChannelId: null }));
    gateway.event({ type: 'member_join', guildId: GUILD, user: user(PERSON, 'FreeNitro_Bot'), accountCreatedAt: null });
    gateway.event({ type: 'member_join', guildId: GUILD, user: user('900000000000000040', 'retrofan'), accountCreatedAt: null });
    // The owner changing nickname is never kicked.
    gateway.event({ type: 'member_update', guildId: GUILD, user: user('100000000000000001', 'owner'), nickBefore: null, nickAfter: 'nitro king', rolesAdded: [], rolesRemoved: [] });
    await h.services.protection.idle();
    expect(discord.kicked).toEqual([PERSON]);
    const e = await events();
    expect(e.map((x) => x.detail).sort()).toEqual(['Nickname “nitro king” uses “*nitro*”. Not punished: the server owner or an exempt role.', 'Username “freenitro_bot” uses “*nitro*”. Kicked.'].sort());
  });
});

describe('CONDUIT protection: message checks (gateway + REST)', () => {
  const checks = (over: Partial<MessageChecks> = {}): MessageChecks => ({ ...structuredClone(MESSAGE_CHECKS_DEFAULTS), enabled: true, ...over });
  const say = (content: string, o: { authorId?: string; moderator?: boolean; roles?: string[]; hash?: string } = {}) => {
    const messageId = discord.userPosts(GENERAL);
    gateway.event({
      type: 'message_create',
      guildId: GUILD,
      channelId: GENERAL,
      messageId,
      authorId: o.authorId ?? PERSON,
      authorBot: false,
      authorName: 'troll',
      content,
      contentHash: o.hash ?? `h-${content}`,
      authorRoleIds: o.roles ?? [],
      authorModerator: o.moderator ?? false,
    });
    return messageId;
  };
  const events = async () =>
    (await call<{ protectionHistory: Array<{ rule: string; action: string; outcome: string; userName: string | null; detail: string | null; place: string | null }> }>('GET', '/api/moderation/discord')).body.protectionHistory;

  it('is off by default: nothing is checked or recorded', async () => {
    expect((await state()).messageChecks.enabled).toBe(false);
    say('BUY CHEAP STUFF AT MY SHOP NOW');
    await h.services.protection.idle();
    expect(await events()).toEqual([]);
  });

  it('on "Log only", matches are recorded and nothing is deleted', async () => {
    expect((await call('POST', '/api/discord/protection/messages', checks())).status).toBe(200);
    say('BUY CHEAP STUFF AT MY SHOP NOW');
    say('join discord.gg/abcdef');
    await h.services.protection.idle();
    const e = await events();
    expect(e.map((x) => [x.rule, x.outcome]).sort()).toEqual([
      ['caps', 'logged'],
      ['invites', 'logged'],
    ]);
    expect(e.every((x) => x.place === 'Retro Server' && x.userName === 'troll')).toBe(true);
    expect(discord.deletedMessages).toEqual([]);
    expect(auditActions(h).some((a) => a.action === 'discord.protection.messages_updated')).toBe(true);
  });

  it('deletes and times out when chosen; one response per burst; moderators and exempt roles are skipped', async () => {
    discord.grantBot(GUILD, (1n << 13n) | (1n << 40n));
    discord.addMember(GUILD, { id: PERSON, username: 'troll' });
    const c = checks();
    c.repeat = { ...c.repeat, action: 'timeout', timeoutMinutes: 10 };
    c.invites = { ...c.invites, action: 'delete_message' };
    c.exemptRoles = [MOD_ROLE];
    await call('POST', '/api/discord/protection/messages', c);

    const invite = say('free nitro discord.gg/scam1');
    say('spam', { hash: 'same' });
    say('spam', { hash: 'same' });
    const third = say('spam', { hash: 'same' });
    say('spam', { hash: 'same' }); // same burst: no second response
    say('discord.gg/abc', { moderator: true, authorId: '900000000000000032' });
    say('discord.gg/abc', { roles: [MOD_ROLE], authorId: '900000000000000033' });
    await h.services.protection.idle();

    expect(discord.deletedMessages).toEqual([invite, third]);
    expect(discord.members.get(GUILD)!.get(PERSON)!.communication_disabled_until).not.toBeNull();
    const e = await events();
    expect(e.map((x) => [x.rule, x.action, x.outcome]).sort()).toEqual(
      [
        ['invites', 'delete_message', 'success'],
        ['repeat', 'timeout', 'success'],
      ].sort(),
    );
    expect(e.find((x) => x.rule === 'repeat')!.detail).toMatch(/Sent the same message 3 times.*Timed out for 10 min/);
  });

  it('records Discord’s refusal when the bot lacks permission', async () => {
    const c = checks();
    c.invites = { ...c.invites, action: 'delete_message' };
    await call('POST', '/api/discord/protection/messages', c);
    say('discord.gg/abcdef');
    await h.services.protection.idle();
    const [e] = await events();
    expect(e).toMatchObject({ rule: 'invites', outcome: 'failed' });
    expect(e!.detail).toMatch(/Discord refused/);
  });

  it('flooding: more messages than allowed within the window', async () => {
    const c = checks();
    c.flood = { ...c.flood, maxMessages: 3, windowSeconds: 10 };
    await call('POST', '/api/discord/protection/messages', c);
    for (let i = 0; i < 4; i++) say(`message ${i}`);
    await h.services.protection.idle();
    expect((await events()).map((x) => x.rule)).toEqual(['flood']);
  });

  it('rejects invalid settings', async () => {
    const res = await call('POST', '/api/discord/protection/messages', { ...checks(), repeat: { ...checks().repeat, count: 1 } });
    expect(res.status).toBe(400);
  });
});

describe('CONDUIT protection: anti-nuke (audit log + REST)', () => {
  const NUKER = '900000000000000050';
  const HELPER = '900000000000000051';
  const ROGUE_BOT = '900000000000000052';
  const LOW_ROLE = '700000000000000002';
  const HIGH_ROLE = '700000000000000003';
  const OWNER = '100000000000000001';
  let entry = 7000;
  const who = (id: string, tag = 'nuker', bot = false) => ({ id, tag, avatarUrl: null, bot });
  const change = (kind: 'channel_delete' | 'role_update' | 'bot_add', executor = NUKER, over: Record<string, unknown> = {}) =>
    gateway.event({ type: 'audit_change', guildId: GUILD, entryId: String(++entry), kind, executor: who(executor), targetId: String(800000000000000000 + entry), targetName: `chan-${entry}`, ...over } as never);
  const settings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(ANTINUKE_DEFAULTS), enabled: true, alertChannel: { guildId: GUILD, channelId: ALERTS }, ...over });
  const events = async () =>
    (await call<{ protectionHistory: Array<{ feature: string; rule: string; action: string; outcome: string; userName: string | null; detail: string | null }> }>('GET', '/api/moderation/discord')).body.protectionHistory;
  const alerts = () => [...discord.messages.values()].filter((m) => m.channelId === ALERTS).map((m) => m.body.embeds?.[0]);
  const roles = () => discord.members.get(GUILD)!.get(NUKER)!.roles;

  beforeEach(() => {
    // The bot: Manage Roles, Kick, Ban and Timeout Members, with its role at position 10.
    discord.grantBot(GUILD, (1n << 28n) | (1n << 1n) | (1n << 2n) | (1n << 40n));
    discord.setBotRolePosition(GUILD, 10);
    discord.addRole(GUILD, LOW_ROLE, 3, { name: 'Admins' });
    discord.addRole(GUILD, HIGH_ROLE, 20, { name: 'Owners' });
    discord.addMember(GUILD, { id: NUKER, username: 'nuker' }, { roles: [LOW_ROLE, MOD_ROLE, HIGH_ROLE] });
    discord.addMember(GUILD, { id: HELPER, username: 'helper' }, { roles: [MOD_ROLE] });
  });

  it('is off by default: nothing is counted', async () => {
    expect((await state()).antinuke.enabled).toBe(false);
    for (let i = 0; i < 5; i++) change('channel_delete');
    await h.services.protection.idle();
    expect(await events()).toEqual([]);
  });

  it('Alert only: reports once the threshold is reached, and does nothing to the member', async () => {
    expect((await call('POST', '/api/discord/protection/antinuke', settings())).status).toBe(200);
    change('channel_delete');
    change('channel_delete');
    await h.services.protection.idle();
    expect(await events()).toEqual([]); // below 3 within 60 s
    change('channel_delete');
    change('channel_delete'); // same burst: no second report
    await h.services.protection.idle();
    const e = await events();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ feature: 'antinuke', rule: 'channel_delete', action: 'alert', outcome: 'logged', userName: 'nuker' });
    expect(e[0]!.detail).toMatch(/^3 channels deleted within 60 s: chan-/);
    expect(alerts()).toEqual([expect.objectContaining({ title: 'Anti-nuke: Channels deleted', description: expect.stringContaining(`<@${NUKER}> **nuker**`) })]);
    expect(alerts()[0].fields[0]).toMatchObject({ name: 'Mode', value: 'Alert only — nothing was done.' });
    expect(roles()).toEqual([LOW_ROLE, MOD_ROLE, HIGH_ROLE]);
    expect(auditActions(h).some((a) => a.action === 'discord.protection.antinuke_updated')).toBe(true);
  });

  it('Enforce + quarantine: removes the roles below the bot’s, lists them, and restores them on request', async () => {
    await call('POST', '/api/discord/protection/antinuke', settings({ mode: 'enforce' }));
    for (let i = 0; i < 3; i++) change('channel_delete');
    await h.services.protection.idle();
    expect(roles()).toEqual([HIGH_ROLE]); // above the bot's role: Discord wouldn't allow removing it
    const [e] = await events();
    expect(e).toMatchObject({ action: 'quarantine', outcome: 'success' });
    expect(e!.detail).toMatch(/Quarantined: removed 2 roles \(1 kept: managed or not below the bot’s role\)\./);
    const s = await state();
    expect(s.quarantine).toHaveLength(1);
    expect(s.quarantine[0]).toMatchObject({ userId: NUKER, status: 'active', place: 'Retro Server' });
    expect(s.quarantine[0]!.roles.map((r) => r.name).sort()).toEqual(['Admins', 'Mods']);

    expect((await call('POST', `/api/discord/protection/quarantine/${s.quarantine[0]!.id}/restore`)).status).toBe(204);
    expect([...roles()].sort()).toEqual([HIGH_ROLE, LOW_ROLE, MOD_ROLE].sort());
    expect((await state()).quarantine[0]!.status).toBe('restored');
    expect((await call('POST', `/api/discord/protection/quarantine/${s.quarantine[0]!.id}/release`)).status).toBe(409);
    expect((await events()).map((x) => [x.rule, x.action])).toContainEqual(['quarantine', 'restore']);
  });

  it('never acts on CONDUIT’s bot, the server owner, trusted people or trusted roles', async () => {
    await call('POST', '/api/discord/protection/antinuke', settings({ mode: 'enforce', trustedUsers: [HELPER], trustedRoles: [LOW_ROLE] }));
    for (const id of ['223456789012345678', OWNER, HELPER, NUKER]) for (let i = 0; i < 3; i++) change('channel_delete', id);
    await h.services.protection.idle();
    expect(await events()).toEqual([]); // NUKER has the trusted Admins role
    expect(roles()).toEqual([LOW_ROLE, MOD_ROLE, HIGH_ROLE]);
  });

  it('dangerous permissions and bots added: ban the person and remove the bot they added', async () => {
    discord.addMember(GUILD, { id: ROGUE_BOT, username: 'NukeBot' });
    await call('POST', '/api/discord/protection/antinuke', settings({ mode: 'enforce', response: 'ban' }));
    change('bot_add', NUKER, { targetId: ROGUE_BOT, targetName: 'NukeBot' });
    change('bot_add', NUKER, { targetId: ROGUE_BOT, targetName: 'NukeBot' });
    await h.services.protection.idle();
    expect(discord.bans.get(GUILD)?.has(NUKER)).toBe(true);
    expect(discord.kicked).toEqual([ROGUE_BOT]);
    const [e] = await events();
    expect(e).toMatchObject({ rule: 'bot_add', action: 'ban', outcome: 'success' });
    expect(e!.detail).toMatch(/2 bots added within 600 s: NukeBot\. Banned\. Removed the added bot NukeBot\./);

    h.clock.advance(1000);
    change('role_update', HELPER, { targetName: 'everyone', permissionsAdded: ['Administrator'] });
    change('role_update', HELPER, { targetName: 'Mods', permissionsAdded: ['Ban Members'] });
    await h.services.protection.idle();
    expect((await events())[0]!.detail).toMatch(/2 roles given dangerous permissions within 60 s: everyone, Mods \(Administrator, Ban Members\)/);
  });

  it('a refused response is recorded as failed with the reason', async () => {
    await call('POST', '/api/discord/protection/antinuke', settings({ mode: 'enforce', response: 'kick' }));
    discord.members.get(GUILD)!.get(NUKER)!.above = true;
    for (let i = 0; i < 3; i++) change('channel_delete');
    await h.services.protection.idle();
    const [e] = await events();
    expect(e).toMatchObject({ action: 'kick', outcome: 'failed' });
    expect(e!.detail).toMatch(/Kick failed: Discord refused/);
    expect(alerts()[0].fields[0].value).toMatch(/Kick failed/);
  });

  it('rejects invalid settings', async () => {
    const bad = await call('POST', '/api/discord/protection/antinuke', settings({ trustedUsers: ['not-an-id'] }));
    expect(bad.status).toBe(400);
  });
});

describe('CONDUIT protection: anti-raid, lockdown and the join gate', () => {
  const VERIFIED = '700000000000000010';
  let joiner = 0;
  /** A Discord id created `daysOld` days before the test clock (ids carry their creation time). */
  const idAged = (daysOld: number) => String(((BigInt(h.clock.now().getTime() - daysOld * 86_400_000) - 1_420_070_400_000n) << 22n) + BigInt(++joiner));
  const join = (id = idAged(400), hasAvatar = true) =>
    gateway.event({ type: 'member_join', guildId: GUILD, user: { id, tag: `joiner${joiner}`, avatarUrl: null, bot: false }, accountCreatedAt: null, hasAvatar });
  const settings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(ANTIRAID_DEFAULTS), alertChannel: { guildId: GUILD, channelId: ALERTS }, ...over });
  const save = (over: Record<string, unknown> = {}) => call('POST', '/api/discord/protection/antiraid', settings(over));
  const events = async () =>
    (await call<{ protectionHistory: Array<{ feature: string; rule: string; action: string; outcome: string; userName: string | null; detail: string | null }> }>('GET', '/api/moderation/discord')).body.protectionHistory;
  const alerts = () => [...discord.messages.values()].filter((m) => m.channelId === ALERTS).map((m) => m.body.embeds?.[0]?.title);
  const everyone = (channelId: string) => discord.channels.get(GUILD)!.find((c) => c.id === channelId)!.permission_overwrites.find((o) => o.id === GUILD) ?? null;
  const idle = () => h.services.protection.idle();

  beforeEach(() => {
    // The bot: Manage Server, Manage Roles and Kick Members, its role at position 10.
    discord.grantBot(GUILD, (1n << 5n) | (1n << 28n) | (1n << 1n));
    discord.setBotRolePosition(GUILD, 10);
    discord.addRole(GUILD, VERIFIED, 2, { name: 'Verified' });
  });

  it('is off by default: joins are not acted on', async () => {
    const s = await state();
    expect(s.antiraid).toMatchObject({ enabled: false, mode: 'alert', gate: { enabled: false } });
    expect(s.lockdowns).toEqual([]);
    for (let i = 0; i < 12; i++) join(idAged(0));
    await idle();
    expect(await events()).toEqual([]);
  });

  it('Alert only: a join burst is reported once, and nothing is locked', async () => {
    expect((await save({ enabled: true, joinThreshold: 3, lockChannels: [GENERAL] })).status).toBe(200);
    join();
    join();
    await idle();
    expect(await events()).toEqual([]);
    join();
    join();
    await idle();
    const e = await events();
    expect(e.map((x) => [x.feature, x.rule, x.action, x.outcome])).toEqual([['antiraid', 'join_burst', 'alert', 'logged']]);
    expect(e[0]!.detail).toBe('3 members joined within 10 s.');
    expect(alerts()).toEqual(['Raid alert: join burst']);
    expect((await state()).lockdowns).toEqual([]);
    expect(everyone(GENERAL)).toBeNull();
  });

  it('Enforce: locks down (verification and channels), and lifts after a quiet period, restoring everything', async () => {
    await save({ enabled: true, mode: 'enforce', joinThreshold: 3, lockChannels: [GENERAL], autoLiftMinutes: 15 });
    for (let i = 0; i < 3; i++) join();
    await idle();
    const [l] = (await state()).lockdowns;
    expect(l).toMatchObject({ guildId: GUILD, place: 'Retro Server', manual: false, verification: { from: 'low', to: 'high' }, lockedChannels: [{ id: GENERAL, name: 'general' }], problems: [] });
    expect(discord.verificationLevels.get(GUILD)).toBe(3);
    expect(BigInt(everyone(GENERAL)!.deny) & (1n << 11n)).toBe(1n << 11n);
    expect(alerts()).toEqual(['Lockdown started']);

    // Joins keep it going; 15 quiet minutes lift it.
    h.clock.advance(10 * 60_000);
    join();
    await h.services.protection.antiraid.tick();
    expect((await state()).lockdowns).toHaveLength(1);
    h.clock.advance(15 * 60_000);
    await h.services.protection.antiraid.tick();
    expect((await state()).lockdowns).toEqual([]);
    expect(discord.verificationLevels.get(GUILD)).toBe(1);
    expect(everyone(GENERAL)).toBeNull();
    expect(alerts()).toEqual(['Lockdown started', 'Lockdown lifted']);
    expect((await events()).map((x) => [x.rule, x.action, x.outcome])).toEqual([
      ['auto_lift', 'lift', 'success'],
      ['join_burst', 'lockdown', 'success'],
    ]);
  });

  it('by hand: preview, lock down and lift; a channel’s earlier @everyone permissions come back exactly', async () => {
    await save({ lockChannels: [GENERAL], raiseVerification: false });
    const ch = discord.channels.get(GUILD)!.find((c) => c.id === GENERAL)!;
    ch.permission_overwrites.push({ id: GUILD, type: 0, allow: String(1n << 10n), deny: String(1n << 15n) });
    const preview = await call<{ lines: string[] }>('POST', `/api/discord/protection/lockdown/${GUILD}/preview`);
    expect(preview.body.lines).toEqual(['Lock #general: @everyone can’t send messages, create threads or react.']);

    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}`, { reason: 'Raid in progress' })).status).toBe(204);
    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}`, {})).status).toBe(409);
    const [l] = (await state()).lockdowns;
    expect(l).toMatchObject({ manual: true, reason: 'Raid in progress', liftAt: null, verification: null });
    // Manual lockdowns don't lift by themselves.
    h.clock.advance(24 * 60 * 60_000);
    await h.services.protection.antiraid.tick();
    expect((await state()).lockdowns).toHaveLength(1);

    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}/lift`)).status).toBe(204);
    expect(everyone(GENERAL)).toEqual({ id: GUILD, type: 0, allow: String(1n << 10n), deny: String(1n << 15n) });
    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}/lift`)).status).toBe(409);
    expect(auditActions(h).map((a) => a.action)).toEqual(expect.arrayContaining(['discord.protection.lockdown_raised', 'discord.protection.lockdown_lifted']));
  });

  it('a short Discord rate limit in the middle of a lockdown is waited out: every channel is locked and lifted', async () => {
    await save({ lockChannels: [GENERAL, ALERTS], raiseVerification: false });
    const lock = discord.requests.length;
    // Discord asks the bot to slow down part-way, as it does for bulk channel edits.
    discord.rateLimitNext.push(0.4, 0.4);
    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}`, { reason: 'Raid' })).status).toBe(204);
    const [l] = (await state()).lockdowns;
    expect(l).toMatchObject({ lockedChannels: [{ id: GENERAL }, { id: ALERTS }], problems: [] });
    for (const ch of [GENERAL, ALERTS]) expect(BigInt(everyone(ch)!.deny) & (1n << 11n)).toBe(1n << 11n);
    // The refused requests were sent again (each request after the 429s is a repeat of the one refused).
    expect(discord.requests.length - lock).toBeGreaterThan(2);

    discord.rateLimitNext.push(0.4);
    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}/lift`)).status).toBe(204);
    expect([everyone(GENERAL), everyone(ALERTS)]).toEqual([null, null]);
    expect(discord.rateLimitNext).toEqual([]);
  });

  it('a lift that fails part-way keeps what wasn’t put back, so lifting again restores it', async () => {
    await save({ enabled: true, mode: 'enforce', joinThreshold: 3, lockChannels: [GENERAL], autoLiftMinutes: 15 });
    const ch = discord.channels.get(GUILD)!.find((c) => c.id === GENERAL)!;
    ch.permission_overwrites.push({ id: GUILD, type: 0, allow: String(1n << 10n), deny: String(1n << 15n) });
    for (let i = 0; i < 3; i++) join();
    await idle();
    expect((await state()).lockdowns).toHaveLength(1);

    // The bot loses Manage Roles: the verification level comes back, the channel can't be unlocked.
    discord.grantBot(GUILD, (1n << 5n) | (1n << 1n));
    h.clock.advance(15 * 60_000);
    await h.services.protection.antiraid.tick();
    expect(discord.verificationLevels.get(GUILD)).toBe(1);
    const [l] = (await state()).lockdowns;
    expect(l).toMatchObject({ manual: true, liftAt: null, verification: null, lockedChannels: [{ id: GENERAL, name: 'general' }] });
    expect(l!.problems).toEqual([expect.stringMatching(/^#general not unlocked: /)]);
    expect(alerts()).toEqual(['Lockdown started', 'Lockdown partly lifted']);
    // Kept as a by-hand lockdown: no retry (or alert) every tick.
    h.clock.advance(60 * 60_000);
    await h.services.protection.antiraid.tick();
    expect(alerts()).toHaveLength(2);
    const failed = await call<{ error: { message: string } }>('POST', `/api/discord/protection/lockdown/${GUILD}/lift`);
    expect(failed.status).toBe(409);
    expect(JSON.stringify(failed.body)).toContain('lift it again to retry');

    // With the permission back, lifting again restores the channel's earlier permissions exactly.
    discord.grantBot(GUILD, (1n << 5n) | (1n << 28n) | (1n << 1n));
    discord.setBotRolePosition(GUILD, 10);
    h.clock.advance(60_000);
    expect((await call('POST', `/api/discord/protection/lockdown/${GUILD}/lift`)).status).toBe(204);
    expect(everyone(GENERAL)).toEqual({ id: GUILD, type: 0, allow: String(1n << 10n), deny: String(1n << 15n) });
    expect((await state()).lockdowns).toEqual([]);
    expect((await events()).map((x) => [x.rule, x.action, x.outcome])).toEqual([
      ['manual', 'lift', 'success'],
      ['manual', 'lift', 'failed'],
      ['auto_lift', 'lift', 'failed'],
      ['join_burst', 'lockdown', 'success'],
    ]);
  });

  it('join gate: young accounts and missing avatars are flagged; kick removes them', async () => {
    await save({ gate: { enabled: true, minAccountAgeDays: 7, requireAvatar: true, response: 'alert' } });
    join(idAged(2));
    join(idAged(400), false);
    join(idAged(400), true); // passes
    await idle();
    expect((await events()).map((x) => [x.feature, x.action, x.outcome, x.detail]).sort()).toEqual([
      ['joingate', 'alert', 'logged', 'Account is 2 days old (minimum 7).'],
      ['joingate', 'alert', 'logged', 'No profile picture.'],
    ]);
    expect(alerts()).toEqual(['Join gate: new member flagged', 'Join gate: new member flagged']);

    await save({ gate: { enabled: true, minAccountAgeDays: 7, requireAvatar: false, response: 'kick' } });
    h.clock.advance(1000);
    const young = idAged(1);
    discord.addMember(GUILD, { id: young, username: 'fresh' });
    join(young);
    await idle();
    expect(discord.kicked).toEqual([young]);
    expect((await events())[0]).toMatchObject({ action: 'kick', outcome: 'success', detail: 'Kicked: account is 1 day old (minimum 7).' });
  });

  it('settings: holding needs no setup (it works through Verify buttons); a gate needs a check', async () => {
    expect((await save({ gate: { enabled: true, minAccountAgeDays: 7, requireAvatar: false, response: 'hold' } })).status).toBe(200);
    expect((await save({ gate: { enabled: true, minAccountAgeDays: 0, requireAvatar: false, response: 'alert' } })).status).toBe(400);
  });

  it('settings saved before Verify became a button action still load (their old Verify entry is dropped)', async () => {
    h.db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('discord.protection.antiraid', ?, ?)").run(
      JSON.stringify({ ...ANTIRAID_DEFAULTS, enabled: true, joinThreshold: 7, verify: { guildId: GUILD, channelId: GENERAL, roleId: VERIFIED, messageId: null } }),
      h.clock.now().toISOString(),
    );
    expect((await state()).antiraid).toMatchObject({ enabled: true, joinThreshold: 7 });
    expect((await state()).antiraid).not.toHaveProperty('verify');
  });
});

describe('CONDUIT protection: bot bait (trap channels)', () => {
  const BAIT = '500000000000000009';
  const SPAMMER = '900000000000000070';
  const settings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(BOTBAIT_DEFAULTS), enabled: true, channels: [BAIT], alertChannel: { guildId: GUILD, channelId: ALERTS }, ...over });
  const save = (over: Record<string, unknown> = {}) => call('POST', '/api/discord/protection/botbait', settings(over));
  const post = (channelId = BAIT, o: { authorId?: string; moderator?: boolean; roles?: string[]; bot?: boolean } = {}) => {
    const messageId = discord.userPosts(channelId);
    gateway.event({
      type: 'message_create',
      guildId: GUILD,
      channelId,
      messageId,
      authorId: o.authorId ?? SPAMMER,
      authorBot: o.bot ?? false,
      authorName: 'spammer',
      content: 'free nitro',
      contentHash: `h-${messageId}`,
      authorRoleIds: o.roles ?? [],
      authorModerator: o.moderator ?? false,
    });
    return messageId;
  };
  const events = async () =>
    (await call<{ protectionHistory: Array<{ feature: string; rule: string; action: string; outcome: string; detail: string | null; userName: string | null }> }>('GET', '/api/moderation/discord')).body.protectionHistory;
  const alerts = () => [...discord.messages.values()].filter((m) => m.channelId === ALERTS).map((m) => m.body.embeds?.[0]);

  beforeEach(() => {
    discord.channels.get(GUILD)!.push({ id: BAIT, name: 'do-not-post', type: 0, position: 9, permission_overwrites: [] });
    // Manage Messages, Timeout, Kick and Ban Members.
    discord.grantBot(GUILD, (1n << 13n) | (1n << 40n) | (1n << 1n) | (1n << 2n));
    discord.addMember(GUILD, { id: SPAMMER, username: 'spammer' });
  });

  it('is off by default: posts in any channel are left alone', async () => {
    expect((await state()).botbait).toMatchObject({ enabled: false, action: 'alert', channels: [] });
    post();
    await h.services.protection.idle();
    expect(await events()).toEqual([]);
  });

  it('Alert only: reports the post once per burst and deletes nothing', async () => {
    expect((await save()).status).toBe(200);
    post();
    post();
    post(GENERAL); // not a bait channel
    await h.services.protection.idle();
    const e = await events();
    expect(e.map((x) => [x.feature, x.rule, x.action, x.outcome])).toEqual([['botbait', 'trap', 'alert', 'logged']]);
    expect(e[0]!.detail).toBe('Posted in the bait channel #do-not-post.');
    expect(alerts().map((a) => a.title)).toEqual(['Bot bait triggered']);
    expect(discord.deletedMessages).toEqual([]);
  });

  it('softban: bans with their recent messages and unbans straight away; later posts in the burst are still deleted', async () => {
    await save({ action: 'softban', deleteMessageHours: 24 });
    post();
    const second = post();
    await h.services.protection.idle();
    const banPut = discord.requests.find((r) => r.method === 'PUT' && r.url.includes(`/bans/${SPAMMER}`));
    expect(JSON.parse(banPut!.body!)).toEqual({ delete_message_seconds: 86_400 });
    expect(discord.bans.get(GUILD)?.has(SPAMMER)).toBe(false); // unbanned again
    expect(discord.deletedMessages).toEqual([second]);
    const e = await events();
    const first = e.find((x) => x.detail?.includes('Softbanned'));
    const latest = e.find((x) => !x.detail?.includes('Softbanned'));
    expect(e).toHaveLength(2);
    expect(first).toMatchObject({ action: 'softban', outcome: 'success' });
    expect(first!.detail).toMatch(/Softbanned: removed from the server and their messages from the last 1 day deleted; they can rejoin\./);
    expect(latest).toMatchObject({ action: 'softban', outcome: 'success', detail: 'Posted in the bait channel #do-not-post. Message deleted.' });
    expect(alerts()).toHaveLength(1);
  });

  it('timeout and kick; moderators, exempt roles and bots are never acted on; the message checks skip bait posts', async () => {
    await call('POST', '/api/discord/protection/messages', { ...structuredClone(MESSAGE_CHECKS_DEFAULTS), enabled: true });
    await save({ action: 'kick', exemptRoles: [MOD_ROLE] });
    post(BAIT, { authorId: '900000000000000071', moderator: true });
    post(BAIT, { authorId: '900000000000000072', roles: [MOD_ROLE] });
    post(BAIT, { authorId: '900000000000000073', bot: true });
    const msg = post();
    await h.services.protection.idle();
    expect(discord.kicked).toEqual([SPAMMER]);
    expect(discord.deletedMessages).toEqual([msg]);
    const e = await events();
    expect(e.map((x) => [x.feature, x.action, x.outcome])).toEqual([['botbait', 'kick', 'success']]);
    expect(e[0]!.detail).toBe('Posted in the bait channel #do-not-post. Message deleted. Kicked.');
  });

  it('a refused action is recorded as failed with the reason', async () => {
    await save({ action: 'ban' });
    discord.members.get(GUILD)!.get(SPAMMER)!.above = true;
    post();
    await h.services.protection.idle();
    const [e] = await events();
    expect(e).toMatchObject({ action: 'ban', outcome: 'failed' });
    expect(e!.detail).toMatch(/Ban failed: Discord refused/);
  });

  it('posts the warning in a bait channel only, with no CONDUIT branding', async () => {
    await save({ action: 'ban' });
    expect((await call('POST', '/api/discord/protection/botbait/warning', { channelId: GENERAL })).status).toBe(400);
    expect((await call('POST', '/api/discord/protection/botbait/warning', { channelId: BAIT })).status).toBe(204);
    const [warning] = [...discord.messages.values()].filter((m) => m.channelId === BAIT);
    expect(warning!.body.embeds[0]).toMatchObject({ title: '⚠️ Do not post in this channel', description: 'This channel catches spam bots. Anything posted here gets the account banned automatically.' });
    expect(JSON.stringify(warning!.body)).not.toMatch(/CONDUIT/);
    expect(auditActions(h).map((a) => a.action)).toEqual(expect.arrayContaining(['discord.protection.botbait_updated', 'discord.protection.botbait_warning_posted']));
  });

  it('rejects invalid settings', async () => {
    expect((await save({ channels: Array.from({ length: 11 }, (_, i) => String(600000000000000000 + i)) })).status).toBe(400);
    expect((await save({ deleteMessageHours: 200 })).status).toBe(400);
  });
});
