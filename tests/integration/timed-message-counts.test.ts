/**
 * Timed messages: the "after N chat messages" counters are stored, so they survive restarts — against a simulated
 * Discord REST API and gateway (automated, mocked — not proof of live Discord behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, migrations, openDatabase, timedMessagesRepo } from '@conduit/database';
import type { TimedMessagesState, TimedMessageView } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { createHarness, type Harness } from '../helpers/harness';

const GUILD = '42';
const GENERAL = '500000000000000001';
const LOGS = '500000000000000003';
const BOT = '223456789012345678';
const PERSON = '900000000000000031';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body });
const posted = (channelId: string) => [...discord.messages.values()].filter((m) => m.channelId === channelId);
const personPosts = (channelId: string, authorId = PERSON, authorBot = false) => {
  const messageId = discord.userPosts(channelId);
  gateway.event({ type: 'message_create', guildId: GUILD, channelId, messageId, authorId, authorBot });
};
const timed = (over: Record<string, unknown> = {}) => ({ platform: 'discord', name: 'Socials', enabled: true, guildId: GUILD, channelId: GENERAL, message: { content: 'Follow us!' }, intervalMinutes: null, messageCount: 20, ...over });
const views = async () => (await call<TimedMessagesState>('GET', '/api/timed-messages')).body.timedMessages;
const since = async (id: string) => (await views()).find((t) => t.id === id)!.messagesSince;

async function botReady(): Promise<void> {
  const end = Date.now() + 3000;
  while ((await h.call<{ bot: { status: string } }>('GET', '/api/discord/setup')).body.bot.status !== 'connected' && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
}

async function restart(): Promise<void> {
  await h.restart();
  await h.services.discord.startBot();
  await botReady();
}

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: GENERAL, name: 'general' },
    { id: LOGS, name: 'server-logs' },
  ]);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

describe('persistent chat-message counters', () => {
  it('a counter survives a restart: 15 of 20 before it, then exactly 5 more trigger the post', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    for (let i = 0; i < 15; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(await since(t.id)).toBe(15);

    await restart();
    expect(await since(t.id)).toBe(15); // restored, not reset to 0
    for (let i = 0; i < 4; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    expect(await since(t.id)).toBe(19);
    personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    expect(await since(t.id)).toBe(0); // the count it was triggered with is used up
  });

  it('separate timed messages keep independent counters (per channel and per configuration)', async () => {
    const a = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ name: 'A' }))).body;
    const b = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ name: 'B', messageCount: 50 }))).body;
    const c = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ name: 'C', channelId: LOGS }))).body;
    for (let i = 0; i < 7; i++) personPosts(GENERAL);
    for (let i = 0; i < 3; i++) personPosts(LOGS);
    await h.services.timedMessages.idle();
    await restart();
    expect([await since(a.id), await since(b.id), await since(c.id)]).toEqual([7, 7, 3]);
  });

  it('a burst of concurrent messages loses no increments and gives exactly one post', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    for (let i = 0; i < 19; i++) personPosts(GENERAL);
    expect(timedMessagesRepo.get(h.db, t.id)!.messagesSince).toBe(19); // every one counted, none lost
    for (let i = 0; i < 40; i++) personPosts(GENERAL); // the 20th triggers; the rest arrive before it is sent
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1); // one post per moment, never a burst of posts
    expect(await since(t.id)).toBe(0);
    // The next interval needs 20 new messages (and at least a minute since the last post).
    h.clock.advance(61_000);
    for (let i = 0; i < 19; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(2);
  });

  it('messages counted while a post is being sent are kept for the next interval', () => {
    const t = { id: '11111111-1111-4111-8111-111111111111', enabled: true, config: JSON.stringify(timed()), enabledAt: 'x', createdAt: 'x', updatedAt: 'x' };
    timedMessagesRepo.insert(h.db, t);
    for (let i = 0; i < 20; i++) timedMessagesRepo.countMessage(h.db, t.id);
    // The send was triggered at 20; three more arrived before it finished.
    for (let i = 0; i < 3; i++) timedMessagesRepo.countMessage(h.db, t.id);
    timedMessagesRepo.recordSend(h.db, t.id, { sentAt: '2026-01-01T12:00:00.000Z', recent: '[]', countUsed: 20 });
    expect(timedMessagesRepo.get(h.db, t.id)!.messagesSince).toBe(3);
    // A failed send keeps the whole count.
    timedMessagesRepo.recordSend(h.db, t.id, { sentAt: null, recent: '[]', countUsed: 3 });
    expect(timedMessagesRepo.get(h.db, t.id)!.messagesSince).toBe(3);
  });

  it('bots — including the timed message itself — never count, so it can’t keep itself going', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ messageCount: 5 }))).body;
    for (let i = 0; i < 5; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    // The bot's own post (and other bots) arrive as gateway events: no count, no further posts.
    h.clock.advance(61_000);
    for (let i = 0; i < 20; i++) personPosts(GENERAL, BOT, true);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    expect(await since(t.id)).toBe(0);
  });

  it('a failed post keeps the count; it is retried later instead of starting over', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed({ messageCount: 5 }))).body;
    discord.messageFailures.push({ status: 403, code: 50013 });
    for (let i = 0; i < 5; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    expect(await since(t.id)).toBe(5);
    h.clock.advance(5 * 60_000 + 1000);
    personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
    expect(await since(t.id)).toBe(0);
  });

  it('disabled messages don’t count or post; switching on, editing and recreating start from 0', async () => {
    const t = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    for (let i = 0; i < 12; i++) personPosts(GENERAL);
    await call('PATCH', `/api/timed-messages/${t.id}`, { enabled: false });
    for (let i = 0; i < 30; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    expect(await since(t.id)).toBe(0); // switched off: the count is cleared and nothing is counted while off
    await call('PATCH', `/api/timed-messages/${t.id}`, { enabled: true });
    expect(await since(t.id)).toBe(0); // switched on: a fresh start, nothing posts straight away
    for (let i = 0; i < 6; i++) personPosts(GENERAL);
    await call('PATCH', `/api/timed-messages/${t.id}`, { name: 'Socials' }); // no actual change: count kept
    expect(await since(t.id)).toBe(6);
    await call('PATCH', `/api/timed-messages/${t.id}`, { messageCount: 30 }); // a different configuration
    expect(await since(t.id)).toBe(0);
    for (let i = 0; i < 4; i++) personPosts(GENERAL);
    await call('DELETE', `/api/timed-messages/${t.id}`);
    for (let i = 0; i < 40; i++) personPosts(GENERAL);
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0); // deleted: never posts
    const again = (await call<TimedMessageView>('POST', '/api/timed-messages', timed())).body;
    expect(await since(again.id)).toBe(0); // no progress carried over from the deleted one
  });

  it('time-based schedules still work, also after a restart', async () => {
    await call('POST', '/api/timed-messages', timed({ intervalMinutes: 30, messageCount: null }));
    h.clock.advance(20 * 60_000);
    await restart();
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(0);
    h.clock.advance(10 * 60_000);
    h.services.timedMessages.tick();
    await h.services.timedMessages.idle();
    expect(posted(GENERAL)).toHaveLength(1);
  });
});

describe('migration', () => {
  it('existing timed messages keep their data and get a count of 0; nothing else changes', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, migrations.filter((m) => m.version <= 17));
      db.prepare(
        "INSERT INTO timed_messages (id, enabled, config, last_sent_at, enabled_at, recent, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', 1, ?, '2026-01-01T00:00:00.000Z', 'e', '[{\"ok\":true}]', 'c', 'u')",
      ).run(JSON.stringify(timed()));
      const result = migrate(db, migrations);
      expect(result.applied).toEqual(expect.arrayContaining([18, 19]));
      expect(timedMessagesRepo.get(db, '22222222-2222-4222-8222-222222222222')).toMatchObject({
        enabled: true,
        lastSentAt: '2026-01-01T00:00:00.000Z',
        recent: '[{"ok":true}]',
        messagesSince: 0,
      });
    } finally {
      db.close();
    }
  });
});
