/**
 * Discord Sticky Messages, Timed Messages (Discord), Discord Logging and the embed library against a simulated
 * Discord REST API and gateway (automated, mocked — not proof of live Discord behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discordMessageTextsRepo } from '@conduit/database';
import type { LoggingSettings, LoggingState, StickyMessagesState, StickyMessageView, TimedMessagesState, TimedMessageView } from '@conduit/shared';
import { DEFAULT_LOGGING_SETTINGS, EMPTY_EMBED } from '@conduit/shared';
import type { GuildEvent } from '../../apps/server/src/discord/discord-bot';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

const GUILD = '42';
const GENERAL = '500000000000000001';
const LOCKED = '500000000000000002';
const LOGS = '500000000000000003';
const BANS = '500000000000000004';
const BOT = '223456789012345678';
const PERSON = '900000000000000031';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const posted = (channelId: string) => [...discord.messages.entries()].filter(([, m]) => m.channelId === channelId);
/** Someone posts in a channel: Discord stores it and the bot's gateway session hears about it. */
const personPosts = (channelId: string, authorId = PERSON, authorBot = false) => {
  const messageId = discord.userPosts(channelId);
  gateway.event({ type: 'message_create', guildId: GUILD, channelId, messageId, authorId, authorBot });
  return messageId;
};

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
    { id: LOCKED, name: 'locked', deny: 1n << 11n },
    { id: LOGS, name: 'server-logs' },
    { id: BANS, name: 'brads-bans' },
  ]);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

const sticky = (over: Record<string, unknown> = {}) => ({ name: 'Rules', guildId: GUILD, channelId: GENERAL, message: { content: 'Read the rules in #rules!' }, cooldownSeconds: 5, ...over });
const stickies = async () => (await call<StickyMessagesState>('GET', '/api/discord/stickies')).body.stickies;

describe('Sticky Messages', () => {
  it('posts the sticky when created; one per channel; checks the bot’s permissions first', async () => {
    const res = await call<StickyMessageView>('POST', '/api/discord/stickies', sticky());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', postedMessageId: expect.any(String) });
    expect(posted(GENERAL).map(([, m]) => m.body.content)).toEqual(['Read the rules in #rules!']);
    expect(posted(GENERAL)[0]![1].body.allowed_mentions).toEqual({ parse: [] });
    expect((await call('POST', '/api/discord/stickies', sticky({ name: 'Again' }))).status).toBe(409);
    const locked = await call('POST', '/api/discord/stickies', sticky({ channelId: LOCKED }));
    expect(locked.status).toBe(400);
    expect(locked.body.error?.issues?.[0]?.message).toMatch(/needs Send Messages in #locked/);
    expect(auditActions(h).some((a) => a.action === 'sticky.created')).toBe(true);
  });

  it('when people post it moves to the bottom: new copy first, then the old one is deleted; a burst gives one repost', async () => {
    const first = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky())).body;
    personPosts(GENERAL);
    personPosts(GENERAL);
    personPosts(GENERAL);
    await h.services.stickies.flush();
    const [s] = await stickies();
    expect(s!.postedMessageId).not.toBe(first.postedMessageId);
    expect(discord.deletedMessages).toEqual([first.postedMessageId]);
    expect(posted(GENERAL)).toHaveLength(1); // exactly one copy exists
    expect(discord.channelLatest.get(GENERAL)).toBe(s!.postedMessageId);
  });

  it('bots (and the sticky itself) never trigger a repost — no loops', async () => {
    const first = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky())).body;
    personPosts(GENERAL, '900000000000000099', true); // another bot
    gateway.event({ type: 'message_create', guildId: GUILD, channelId: GENERAL, messageId: first.postedMessageId!, authorId: BOT, authorBot: true });
    await h.services.stickies.flush();
    expect((await stickies())[0]!.postedMessageId).toBe(first.postedMessageId);
    expect(discord.deletedMessages).toEqual([]);
  });

  it('waits for the configured number of messages', async () => {
    const first = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky({ messagesBeforeRepost: 3 }))).body;
    personPosts(GENERAL);
    personPosts(GENERAL);
    await h.services.stickies.flush();
    expect((await stickies())[0]!.postedMessageId).toBe(first.postedMessageId);
    personPosts(GENERAL);
    await h.services.stickies.flush();
    expect((await stickies())[0]!.postedMessageId).not.toBe(first.postedMessageId);
  });

  it('several channels each keep their own sticky', async () => {
    await call('POST', '/api/discord/stickies', sticky());
    await call('POST', '/api/discord/stickies', sticky({ name: 'Logs note', channelId: LOGS, message: { content: 'Logs only' } }));
    personPosts(LOGS);
    await h.services.stickies.flush();
    expect(posted(GENERAL)).toHaveLength(1);
    expect(posted(LOGS).map(([, m]) => m.body.content)).toEqual(['Logs only']);
    expect(discord.deletedMessages).toHaveLength(1);
  });

  it('a manually deleted sticky is posted again', async () => {
    const first = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky())).body;
    discord.messages.delete(first.postedMessageId!);
    gateway.event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: first.postedMessageId!, author: null, content: null, attachments: 0, createdAt: null });
    await h.services.stickies.flush();
    expect(posted(GENERAL)).toHaveLength(1);
    expect((await stickies())[0]!.postedMessageId).not.toBe(first.postedMessageId);
  });

  it('after a restart: no new copy if it is still the newest message; exactly one repost if people posted meanwhile', async () => {
    const first = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky())).body;
    await h.restart();
    await h.services.discord.startBot();
    await botReady();
    await h.services.stickies.idle();
    expect((await stickies())[0]!.postedMessageId).toBe(first.postedMessageId);
    expect(posted(GENERAL)).toHaveLength(1);
    // People posted while CONDUIT was closed.
    discord.userPosts(GENERAL);
    await h.restart();
    await h.services.discord.startBot();
    await botReady();
    await h.services.stickies.recover();
    expect(posted(GENERAL)).toHaveLength(1);
    expect(discord.deletedMessages).toEqual([first.postedMessageId]);
  });

  it('switching off removes the posted copy; switching on posts it again; deleting removes it; content edits repost', async () => {
    const s = (await call<StickyMessageView>('POST', '/api/discord/stickies', sticky())).body;
    expect((await call<StickyMessageView>('PATCH', `/api/discord/stickies/${s.id}`, { enabled: false })).body).toMatchObject({ status: 'off', postedMessageId: null });
    expect(posted(GENERAL)).toHaveLength(0);
    personPosts(GENERAL);
    await h.services.stickies.flush();
    expect(posted(GENERAL)).toHaveLength(0); // off: nothing posted
    await call('PATCH', `/api/discord/stickies/${s.id}`, { enabled: true });
    expect(posted(GENERAL)).toHaveLength(1);
    await call('PATCH', `/api/discord/stickies/${s.id}`, { message: { content: 'New rules!' } });
    expect(posted(GENERAL).map(([, m]) => m.body.content)).toEqual(['New rules!']);
    expect((await call('DELETE', `/api/discord/stickies/${s.id}`)).body).toEqual({ id: s.id, deleted: true });
    expect(posted(GENERAL)).toHaveLength(0);
    expect(await stickies()).toEqual([]);
  });

  it('sticky embeds are validated against Discord’s limits', async () => {
    const bad = await call('POST', '/api/discord/stickies', sticky({ message: { content: '', embed: { ...EMPTY_EMBED, title: 'x'.repeat(257) } } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error?.issues?.[0]?.message).toMatch(/Title: at most 256/);
    const ok = await call('POST', '/api/discord/stickies', sticky({ message: { content: '', embed: { ...EMPTY_EMBED, title: 'Rules', color: '#EEC584', fields: [{ name: 'One', value: 'Be kind', inline: true }] } } }));
    expect(ok.status).toBe(201);
    expect(posted(GENERAL)[0]![1].body.embeds[0]).toMatchObject({ title: 'Rules', color: 0xeec584, fields: [{ name: 'One', value: 'Be kind', inline: true }] });
  });
});

const timed = (over: Record<string, unknown> = {}) => ({ platform: 'discord', name: 'Socials', enabled: true, guildId: GUILD, channelId: GENERAL, message: { content: 'Follow us!' }, intervalMinutes: 30, ...over });
const timedState = async () => (await call<TimedMessagesState>('GET', '/api/timed-messages')).body;

describe('Timed Messages (Discord)', () => {
  it('every X minutes: nothing when switched on, then once per interval; never twice in the same window', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    h.clock.advance(30 * 60_000);
    h.services.timedMessages.tick();
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    h.clock.advance(29 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    const view = (await timedState()).timedMessages[0]!;
    expect(view).toMatchObject({ id: t.id, destination: '#general in Retro Server', recent: [{ ok: true, reason: 'time' }] });
  });

  it('after X messages from people (bots don’t count); disabled ones never post', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ intervalMinutes: null, messageCount: 5 }))).body;
    for (let i = 0; i < 4; i++) personPosts(GENERAL);
    for (let i = 0; i < 3; i++) personPosts(GENERAL, BOT, true);
    personPosts(LOGS); // another channel
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    expect((await timedState()).timedMessages[0]!.messagesSince).toBe(0);
    await call('PATCH', `/api/timed-messages/${t.id}`, { enabled: false });
    h.clock.advance(10 * 60_000);
    for (let i = 0; i < 10; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
  });

  it('both intervals: "all" needs time AND messages; "any" posts at whichever comes first — one post either way', async () => {
    await call('POST', '/api/timed-messages', timed({ messageCount: 5, combine: 'all' }));
    h.clock.advance(31 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0); // time passed, quiet chat: no post
    for (let i = 0; i < 5; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);

    await call('POST', '/api/timed-messages', timed({ name: 'Any', channelId: LOGS, messageCount: 100, combine: 'any' }));
    h.clock.advance(31 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(LOGS)).toHaveLength(1);
  });

  it('validates the schedule and the message; Kick can’t take embeds; duplicates start off', async () => {
    const issue = async (body: unknown) => (await call('POST', '/api/timed-messages', body)).body.error?.issues?.[0];
    expect(await issue(timed({ intervalMinutes: null }))).toMatchObject({ message: expect.stringMatching(/every X minutes, after X messages, or both/) });
    expect(await issue(timed({ intervalMinutes: 2 }))).toMatchObject({ message: expect.stringMatching(/At least every 5 minutes/) });
    expect(await issue(timed({ message: { content: '', embed: { ...EMPTY_EMBED, title: 'Hi', imageUrl: 'javascript:alert(1)' } } }))).toMatchObject({ path: 'message.embed.imageUrl' });
    expect(await issue({ platform: 'kick', name: 'x', content: 'Hi', embed: EMPTY_EMBED, intervalMinutes: 10 })).toBeTruthy();
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    const copy = await call<TimedMessageView>('POST', `/api/timed-messages/${t.id}/duplicate`);
    expect(copy.body).toMatchObject({ name: 'Socials (copy)', enabled: false, intervalMinutes: 30 });
    expect((await timedState()).timedMessages).toHaveLength(2);
  });

  it('Discord content: text only, embed only (no author needed), or text + embed', async () => {
    const embed = { ...EMPTY_EMBED, title: 'Weekly schedule', description: 'Mon–Fri 7pm', fields: [{ name: 'Where', value: 'Kick', inline: true }], color: '#048BA8' };
    await call('POST', '/api/timed-messages', timed({ name: 'Text', channelId: GENERAL, message: { content: 'Just text' } }));
    await call('POST', '/api/timed-messages', timed({ name: 'Embed', channelId: LOGS, message: { content: '', embed } }));
    await call('POST', '/api/timed-messages', timed({ name: 'Both', channelId: BANS, message: { content: 'Hello!', embed } }));
    h.clock.advance(30 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)[0]![1].body).toMatchObject({ content: 'Just text', embeds: [] });
    const embedOnly = posted(LOGS)[0]![1].body;
    expect(embedOnly.content).toBeUndefined();
    expect(embedOnly.embeds[0]).toEqual({ color: 0x048ba8, title: 'Weekly schedule', description: 'Mon–Fri 7pm', fields: [{ name: 'Where', value: 'Kick', inline: true }] });
    expect(embedOnly.embeds[0].author).toBeUndefined();
    expect(posted(BANS)[0]![1].body).toMatchObject({ content: 'Hello!', embeds: [{ title: 'Weekly schedule' }] });
    // Neither text nor embed is refused.
    expect((await call('POST', '/api/timed-messages', timed({ message: { content: '  ', embed: null } }))).status).toBe(400);
  });

  it('a failure is recorded and not retried in a tight loop', async () => {
    await call('POST', '/api/timed-messages', timed());
    discord.messageFailures.push({ status: 403, code: 50013 });
    h.clock.advance(30 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    h.clock.advance(60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    const [t] = (await timedState()).timedMessages;
    expect(t!.recent).toEqual([{ at: expect.any(String), ok: false, reason: 'time', detail: expect.stringMatching(/missing a permission/) }]);
    expect(t!.lastSentAt).toBeNull();
    h.clock.advance(5 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1); // retried after 5 minutes, succeeded
  });
});

const logging = (over: Partial<LoggingSettings> = {}): LoggingSettings => ({
  ...structuredClone(DEFAULT_LOGGING_SETTINGS),
  guildId: GUILD,
  moderation: { enabled: true, channelId: BANS, off: ['failed'] },
  members: { enabled: true, channelId: LOGS, off: [] },
  messages: { enabled: true, channelId: LOGS, off: [] },
  server: { enabled: true, channelId: LOGS, off: [] },
  ...over,
});
const user = (id: string, tag: string, bot = false) => ({ id, tag, avatarUrl: null, bot });
const logEmbeds = (channelId: string) => posted(channelId).map(([, m]) => m.body.embeds[0]);
const event = async (e: GuildEvent) => {
  gateway.event(e);
  await h.services.logging.idle();
};

describe('Discord Logging', () => {
  it('validates destinations: a channel per enabled category, where the bot can post', async () => {
    const missing = await call('POST', '/api/discord/logging', { ...logging(), moderation: { enabled: true, channelId: null, off: [] } });
    expect(missing.body.error?.issues?.[0]).toMatchObject({ path: 'moderation.channelId' });
    const locked = await call('POST', '/api/discord/logging', logging({ server: { enabled: true, channelId: LOCKED, off: [] } }));
    expect(locked.status).toBe(400);
    expect(locked.body.error?.issues?.[0]?.message).toMatch(/needs Send Messages in #locked/);
    expect((await call('POST', '/api/discord/logging', logging())).status).toBe(200);
    expect(auditActions(h).some((a) => a.action === 'discord_logging.updated')).toBe(true);
  });

  it('moderation from the audit log: who, why, until; each entry once; the bot’s own entries are left to CONDUIT’s record', async () => {
    await call('POST', '/api/discord/logging', logging());
    const ban: GuildEvent = { type: 'audit', guildId: GUILD, entryId: '1111', action: 'ban', executor: user('900000000000000040', 'modbrad'), target: user(PERSON, 'troll'), targetId: PERSON, reason: 'Spam links', until: null };
    await event(ban);
    await event(ban); // the same entry again
    await event({ ...ban, entryId: '2222', action: 'timeout', until: '2026-01-01T13:00:00.000Z' });
    await event({ ...ban, entryId: '3333', executor: user(BOT, 'RetroBot', true) }); // a CONDUIT command
    const embeds = logEmbeds(BANS);
    expect(embeds.map((e) => e.title)).toEqual(['Member banned', 'Member timed out']);
    expect(embeds[0]).toMatchObject({ color: 0xe74c3c, description: `<@${PERSON}> **troll**`, footer: { text: expect.stringMatching(/User ID: 900000000000000031 · Audit log entry 1111/) } });
    expect(embeds[0].fields).toEqual(expect.arrayContaining([{ name: 'Moderator', value: '<@900000000000000040> modbrad', inline: true }, { name: 'Reason', value: 'Spam links', inline: false }]));
    expect(embeds[1].fields.find((f: { name: string }) => f.name === 'Until').value).toMatch(/^<t:\d+:F>/);
  });

  it('AutoMod actions (blocked, flagged, timed out) are logged with the rule and channel; they can be switched off', async () => {
    await call('POST', '/api/discord/logging', logging());
    const automod = (entryId: string, action: 'automod_block' | 'automod_flag' | 'automod_timeout'): GuildEvent => ({
      type: 'audit',
      guildId: GUILD,
      entryId,
      action,
      executor: null,
      target: user(PERSON, 'troll'),
      targetId: PERSON,
      reason: null,
      until: null,
      ruleName: 'Block invite links',
      channelId: GENERAL,
    });
    await event(automod('5001', 'automod_block'));
    await event(automod('5002', 'automod_flag'));
    await event(automod('5003', 'automod_timeout'));
    const embeds = logEmbeds(BANS);
    expect(embeds.map((e) => e.title)).toEqual(['Message blocked by AutoMod', 'Message flagged by AutoMod', 'Member timed out by AutoMod']);
    expect(embeds[0].fields).toEqual([
      { name: 'Rule', value: 'Block invite links', inline: true },
      { name: 'Channel', value: `<#${GENERAL}>`, inline: true },
    ]);
    // Switched off: nothing more is posted for AutoMod.
    await call('POST', '/api/discord/logging', logging({ moderation: { enabled: true, channelId: BANS, off: ['failed', 'automod'] } }));
    await event(automod('5004', 'automod_block'));
    expect(logEmbeds(BANS)).toHaveLength(3);
  });

  it('Discord Bot → Logs lists moderation done outside CONDUIT: Discord’s buttons, other bots and AutoMod (not the bot’s own)', async () => {
    const base = { type: 'audit' as const, guildId: GUILD, target: user(PERSON, 'troll'), targetId: PERSON, reason: 'Spam', until: null };
    await event({ ...base, entryId: '6001', action: 'ban', executor: user('900000000000000040', 'modbrad') });
    await event({ ...base, entryId: '6002', action: 'kick', executor: user('900000000000000041', 'OtherBot', true) });
    await event({ ...base, entryId: '6003', action: 'automod_timeout', executor: null, reason: null, ruleName: 'No slurs', channelId: GENERAL });
    await event({ ...base, entryId: '6004', action: 'ban', executor: user(BOT, 'RetroBot', true) }); // CONDUIT's own command
    await event({ ...base, entryId: '6001', action: 'ban', executor: user('900000000000000040', 'modbrad') }); // repeated entry
    const s = (await call<{ serverHistory: Array<{ action: string; via: string; by: string | null; ruleName: string | null; targetName: string | null; place: string | null }> }>('GET', '/api/moderation/discord')).body;
    expect(s.serverHistory.map((r) => [r.action, r.via, r.by, r.ruleName, r.targetName]).sort()).toEqual(
      [
        ['automod_timeout', 'automod', null, 'No slurs', 'troll'],
        ['ban', 'discord', 'modbrad', null, 'troll'],
        ['kick', 'bot', 'OtherBot', null, 'troll'],
      ].sort(),
    );
    expect(s.serverHistory.every((r) => r.place === 'Retro Server')).toBe(true);
  });

  it('CONDUIT’s moderation commands are logged with the member who ran them; failures only when asked, labelled failed', async () => {
    await call('POST', '/api/discord/logging', logging());
    discord.addMember(GUILD, { id: PERSON, username: 'troll' });
    discord.grantBot(GUILD, 1n << 2n);
    const ban = () => h.services.moderation.runDiscordCommand({ guildId: GUILD, invokerId: '100000000000000001', invokerName: 'brad', command: 'ban', action: 'ban', userId: PERSON, reason: 'Raid' });
    await ban();
    await h.services.logging.idle();
    expect(logEmbeds(BANS)).toEqual([expect.objectContaining({ title: 'Member banned', fields: expect.arrayContaining([{ name: 'Moderator', value: 'brad via /ban', inline: true }]) })]);
    // A failed command (already banned → Discord refuses the unban of someone else, etc.) isn't logged by default…
    await h.services.moderation.runDiscordCommand({ guildId: GUILD, invokerId: '100000000000000001', invokerName: 'brad', command: 'unban', action: 'unban', userId: '900000000000000077', reason: null });
    await h.services.logging.idle();
    expect(logEmbeds(BANS)).toHaveLength(1);
    // …and when asked, it is clearly marked.
    await call('POST', '/api/discord/logging', logging({ moderation: { enabled: true, channelId: BANS, off: [] } }));
    await h.services.moderation.runDiscordCommand({ guildId: GUILD, invokerId: '100000000000000001', invokerName: 'brad', command: 'unban', action: 'unban', userId: '900000000000000078', reason: null });
    await h.services.logging.idle();
    expect(logEmbeds(BANS)[1]).toMatchObject({ title: 'Moderation command failed (nothing was done)', color: 0x95a5a6 });
  });

  it('messages, members and server events, with ids and links; bots, log channels and other servers are skipped', async () => {
    await call('POST', '/api/discord/logging', logging());
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: '7001', author: user(PERSON, 'troll'), content: null, attachments: 1, createdAt: null });
    await event({ type: 'message_update', guildId: GUILD, channelId: GENERAL, messageId: '7002', author: user(PERSON, 'troll'), before: 'helo', after: 'hello' });
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: '7003', author: user(BOT, 'RetroBot', true), content: 'x', attachments: 0, createdAt: null });
    await event({ type: 'message_delete', guildId: GUILD, channelId: LOGS, messageId: '7004', author: user(PERSON, 'troll'), content: 'x', attachments: 0, createdAt: null });
    await event({ type: 'message_delete', guildId: '99', channelId: GENERAL, messageId: '7005', author: user(PERSON, 'troll'), content: 'x', attachments: 0, createdAt: null });
    await event({ type: 'member_join', guildId: GUILD, user: user(PERSON, 'troll'), accountCreatedAt: '2020-01-01T00:00:00.000Z' });
    await event({ type: 'member_update', guildId: GUILD, user: user(PERSON, 'troll'), nickBefore: null, nickAfter: 'Trolly', rolesAdded: [], rolesRemoved: [] });
    await event({ type: 'role', action: 'update', guildId: GUILD, roleId: '800', name: 'Mods', changes: [{ key: 'Color', before: '#000000', after: '#ff0000' }] });
    const embeds = logEmbeds(LOGS);
    expect(embeds.map((e) => e.title)).toEqual(['Message deleted', 'Message edited', 'Member joined', 'Nickname changed', 'Role updated']);
    expect(embeds[0].description).toMatch(/Text unavailable \(the Message Content intent is off\)/);
    expect(embeds[1].description).toContain(`https://discord.com/channels/${GUILD}/${GENERAL}/7002`);
    expect(embeds[1].fields).toEqual([
      { name: 'Before', value: 'helo', inline: false },
      { name: 'After', value: 'hello', inline: false },
    ]);
    expect(embeds[4].fields).toEqual([{ name: 'Color', value: '#000000 → #ff0000', inline: false }]);

    // Everything posted is also in Discord Bot → Logs → Moderation log.
    type Entry = { title: string; category: string; userName: string | null; userId: string | null; detail: string | null; posted: boolean; place: string | null };
    const entries = (await call<{ loggingHistory: Entry[] }>('GET', '/api/moderation/discord')).body.loggingHistory;
    expect(entries.map((e) => [e.title, e.category]).sort()).toEqual(
      [
        ['Member joined', 'members'],
        ['Message deleted', 'messages'],
        ['Message edited', 'messages'],
        ['Nickname changed', 'members'],
        ['Role updated', 'server'],
      ].sort(),
    );
    const edited = entries.find((e) => e.title === 'Message edited')!;
    expect(edited).toMatchObject({ userName: 'troll', userId: PERSON, posted: true, place: 'Retro Server' });
    expect(edited.detail).toMatch(/Before: helo · After: hello/);
    expect(edited.detail).not.toMatch(/<@|<#/);
    expect(entries.find((e) => e.title === 'Role updated')!.detail).toBe('Mods · Color: #000000 → #ff0000');
  });

  it('deleted and edited messages show their text even when Discord doesn’t send it (kept 7 days, only while Messages logging is on)', async () => {
    await call('POST', '/api/discord/logging', logging());
    const said = (messageId: string, content: string, over: Partial<Extract<GuildEvent, { type: 'message_create' }>> = {}) =>
      event({ type: 'message_create', guildId: GUILD, channelId: GENERAL, messageId, authorId: PERSON, authorBot: false, authorName: 'troll', content, ...over });
    const kept = (id: string) => discordMessageTextsRepo.get(h.db, id)?.content ?? null;
    await said('7101', 'first words');
    await said('7102', 'beep', { authorBot: true });
    await said('7103', 'in the log channel', { channelId: LOGS });
    await said('7104', 'other server', { guildId: '99' });
    expect([kept('7101'), kept('7102'), kept('7103'), kept('7104')]).toEqual(['first words', null, null, null]);

    // Edited, then deleted, after a reconnect (Discord sends neither the old text nor the author).
    await event({ type: 'message_update', guildId: GUILD, channelId: GENERAL, messageId: '7101', author: null, before: null, after: 'second words' });
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: '7101', author: null, content: null, attachments: 0, createdAt: null });
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: '7199', author: null, content: null, attachments: 0, createdAt: null });
    const embeds = logEmbeds(LOGS);
    expect(embeds.map((e) => e.title)).toEqual(['Message edited', 'Message deleted', 'Message deleted']);
    expect(embeds[0].fields).toEqual([
      { name: 'Before', value: 'first words', inline: false },
      { name: 'After', value: 'second words', inline: false },
    ]);
    expect(embeds[0].description).toContain(`by <@${PERSON}>`);
    expect(embeds[1].description).toContain(`sent by <@${PERSON}>`);
    expect(embeds[1].description).toContain('second words');
    expect(embeds[1].author).toMatchObject({ name: 'troll' });
    expect(embeds[2].description).toMatch(/Text unavailable/);
    expect(kept('7101')).toBeNull(); // let go once deleted

    // Bulk deletions let go too, and old text is removed after 7 days.
    await said('7105', 'bulk me');
    await event({ type: 'message_delete_bulk', guildId: GUILD, channelId: GENERAL, messageIds: ['7105'] });
    expect(kept('7105')).toBeNull();
    await said('7106', 'old news');
    h.clock.advance(7 * 24 * 3600_000 + 60_000);
    await said('7107', 'fresh');
    expect([kept('7106'), kept('7107')]).toEqual([null, 'fresh']);

    // Not kept when deleted and edited messages aren't logged; cleared when Messages logging is switched off.
    await call('POST', '/api/discord/logging', logging({ messages: { enabled: true, channelId: LOGS, off: ['delete', 'edit'] } }));
    await said('7108', 'not needed');
    expect(kept('7108')).toBeNull();
    await call('POST', '/api/discord/logging', logging({ messages: { enabled: false, channelId: LOGS, off: [] } }));
    expect(kept('7107')).toBeNull();
  });

  it('messages CONDUIT deletes for its own features aren’t logged; messages without text show “No text”', async () => {
    await call('POST', '/api/discord/logging', logging());
    // An Embed Creator message removed in CONDUIT (also from Discord): Discord then reports the deletion, unknown author.
    const sent = (await call<{ id: string; messageId: string }>('POST', '/api/discord/messages', { name: 'Rules', guildId: GUILD, channelId: GENERAL, draft: { content: 'Rules', embeds: [] } })).body;
    expect((await call('POST', `/api/discord/messages/${sent.id}/remove`, { fromDiscord: true })).status).toBeLessThan(300);
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: sent.messageId, author: null, content: null, attachments: 0, createdAt: null });
    expect(logEmbeds(LOGS)).toEqual([]);

    // Someone else deleting a message is still logged; one with only an image shows "No text", not "unavailable".
    await event({ type: 'message_create', guildId: GUILD, channelId: GENERAL, messageId: '7301', authorId: PERSON, authorBot: false, authorName: 'troll', content: '' });
    await event({ type: 'message_delete', guildId: GUILD, channelId: GENERAL, messageId: '7301', author: null, content: null, attachments: 1, createdAt: null });
    const [deleted] = logEmbeds(LOGS);
    expect(deleted).toMatchObject({ title: 'Message deleted', author: { name: 'troll' } });
    expect(deleted.description).toContain('*No text*');
    expect(deleted.description).not.toMatch(/unavailable/i);
  });

  it('moderation isn’t kept twice: it’s already in the Moderation log', async () => {
    await call('POST', '/api/discord/logging', logging());
    await event({ type: 'audit', guildId: GUILD, entryId: '8001', action: 'ban', executor: user('900000000000000040', 'modbrad'), target: user(PERSON, 'troll'), targetId: PERSON, reason: 'Spam', until: null });
    expect(logEmbeds(BANS)).toHaveLength(1);
    const s = (await call<{ loggingHistory: unknown[]; serverHistory: unknown[] }>('GET', '/api/moderation/discord')).body;
    expect(s.loggingHistory).toEqual([]);
    expect(s.serverHistory).toHaveLength(1);
  });

  it('privileged intents are required: all three are requested as soon as they’re on in the Developer Portal (the bot reconnects by itself); a refusal keeps it online', async () => {
    const NONE = { members: false, messageContent: false, presences: false };
    const ALL = { members: true, messageContent: true, presences: true };
    const lastIntents = () => gateway.intentRequests.at(-1);
    const state = async () => (await call<LoggingState>('GET', '/api/discord/logging')).body;
    expect(lastIntents()).toEqual(NONE); // off on the portal: never requested (Discord would refuse the connection)
    let s = await state();
    expect(s.intents).toEqual({ members: { portal: false, inUse: false }, messageContent: { portal: false, inUse: false }, presences: { portal: false, inUse: false } });
    expect(s.availability.members).toMatchObject({ available: false, problem: expect.stringMatching(/CONDUIT needs “Server Members Intent”/) });
    // The user turns them on in the Developer Portal: CONDUIT notices and reconnects with them — no switch, no save.
    discord.botApplication.flags = (1 << 13) | (1 << 15) | (1 << 19);
    await state();
    await botReady();
    expect(lastIntents()).toEqual(ALL);
    s = await state();
    expect(s.intents).toEqual({ members: { portal: true, inUse: true }, messageContent: { portal: true, inUse: true }, presences: { portal: true, inUse: true } });
    expect(s.availability.members.available).toBe(true);
    expect(s.availability.messages.partial).toBeNull();
    // Discord refuses anyway (e.g. switched off again): the bot reconnects without them instead of going down, and
    // doesn't keep retrying.
    gateway.refusePrivileged = true;
    await h.call('POST', '/api/discord/bot/restart');
    await botReady();
    expect(gateway.intentRequests.slice(-2)).toEqual([ALL, NONE]);
    const requests = gateway.intentRequests.length;
    s = await state();
    await state();
    expect(gateway.intentRequests).toHaveLength(requests);
    expect(s.availability.members.problem).toMatch(/Discord refused the Server Members intent/);
    expect(gateway.live).toHaveLength(1); // still exactly one connection
  });
});

describe('Embed library', () => {
  it('saves, edits and reuses embeds; test posts go to the chosen channel and report Discord’s answer', async () => {
    const saved = await call<{ id: string }>('POST', '/api/discord/embeds', { name: 'Welcome', embed: { ...EMPTY_EMBED, title: 'Welcome!' } });
    expect(saved.status).toBe(201);
    await call('PATCH', `/api/discord/embeds/${saved.body.id}`, { name: 'Welcome v2', embed: { ...EMPTY_EMBED, title: 'Welcome back!' } });
    expect((await call<Array<{ name: string }>>('GET', '/api/discord/embeds')).body.map((e) => e.name)).toEqual(['Welcome v2']);
    const test = await call<{ ok: boolean; message: string }>('POST', '/api/discord/embeds/test', { guildId: GUILD, channelId: GENERAL, message: { content: '', embed: { ...EMPTY_EMBED, title: 'Test {streamer}' } } });
    expect(test.body).toEqual({ ok: true, message: 'Test posted in #general.' });
    expect(posted(GENERAL)[0]![1].body.embeds[0].title).toBe('Test {streamer}');
    const locked = await call<{ ok: boolean; message: string }>('POST', '/api/discord/embeds/test', { guildId: GUILD, channelId: LOCKED, message: { content: 'x', embed: null } });
    expect(locked.body).toEqual({ ok: false, message: 'The bot needs Send Messages in #locked.' });
    expect((await call('POST', '/api/discord/embeds', { name: 'Empty', embed: EMPTY_EMBED })).body.error?.issues?.[0]?.message).toMatch(/embed is empty/);
  });
});

describe('Discord channel list while Discord is busy', () => {
  const channels = async () => (await call<{ guilds: Array<{ id: string; channels: Array<{ id: string }> }>; problem: string | null }>('GET', '/api/giveaways/discord/channels')).body;
  const channelRequests = () => discord.requests.filter((r) => /\/users\/@me\/guilds|\/guilds\/\d+\/channels/.test(r.url)).length;

  it('keeps showing the last known channels and waits before asking again (no request storm, no error in the menus)', async () => {
    const first = await channels();
    expect(first.guilds[0]!.channels.map((c) => c.id)).toContain(GENERAL);
    discord.rateLimited = true;
    h.clock.advance(31_000); // past the 30 s cache
    const busy = await channels();
    expect(busy.problem).toBeNull();
    expect(busy.guilds[0]!.channels.map((c) => c.id)).toContain(GENERAL); // the last known list
    const after = channelRequests();
    for (let i = 0; i < 5; i++) await channels(); // pages polling while Discord is busy
    expect(channelRequests()).toBe(after); // nothing more sent during the back-off
    discord.rateLimited = false;
    h.clock.advance(31_000);
    expect((await channels()).guilds[0]!.channels.map((c) => c.id)).toContain(GENERAL);
    expect(channelRequests()).toBeGreaterThan(after);
  });

  it('several pages asking at the same moment share one lookup', async () => {
    await channels();
    h.clock.advance(31_000);
    const guildLists = () => discord.requests.filter((r) => r.url.includes('/users/@me/guilds')).length;
    const before = guildLists();
    await Promise.all([channels(), channels(), channels(), channels()]);
    expect(guildLists() - before).toBe(1);
  });
});
