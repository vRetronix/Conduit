/**
 * Stream Notifications (Kick → Discord) and Kick Timed Messages against a simulated Kick and Discord (automated,
 * mocked — not proof of live Kick or Discord behaviour): live detection through Kick's public channel API with an app
 * token, one post per live session across checks and restarts, deletion when the stream ends, several streamers,
 * outages, and timed messages in Kick chat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifierView, StreamNotificationsState, TimedMessagesState } from '@conduit/shared';
import { DEFAULT_NOTIFICATION_CONTENT, DEFAULT_NOTIFICATION_EMBED } from '@conduit/shared/kick/stream-notifications';
import type { FetchLike } from '../../apps/server/src/app/types';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { auditActions, createHarness, freePort, type Harness } from '../helpers/harness';

const GUILD = '42';
const ALERTS = '500000000000000001';
const OTHER = '500000000000000002';
const ROLE = '800000000000000007';

let h: Harness;
let kick: FakeKick;
let discord: FakeDiscord;
let gateway: FakeGateway;
let port: number;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const streamer = (n: number, slug = `streamer${n}`): FakeKickUser => ({ user_id: 7770000 + n, name: `Streamer${n}`, slug, profile_picture: `https://files.kick.com/images/user/${n}/profile.webp` });
const posts = (channelId = ALERTS) => [...discord.messages.entries()].filter(([, m]) => m.channelId === channelId);
const check = async () => (await call<StreamNotificationsState>('POST', '/api/notifications/check')).body;
const notifier = (channel: string, over: Record<string, unknown> = {}) => ({ channel, guildId: GUILD, channelId: ALERTS, ...over });

async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
  expect((await fetch(kick.approve(new URL(res.body.authorizationUrl), who))).status).toBe(200);
}

beforeEach(async () => {
  kick = new FakeKick();
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  for (let n = 1; n <= 3; n++) kick.directory.set(`streamer${n}`, streamer(n));
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: ALERTS, name: 'live-alerts' },
    { id: OTHER, name: 'other' },
  ]);
  discord.addRole(GUILD, ROLE, 3, { name: 'Live Pings', mentionable: true });
  const both: FetchLike = (input, init) => (String(input).includes('kick.com') ? kick.fetch(input, init) : discord.fetch(input, init));
  port = await freePort();
  h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(port) }, { vault: new MemoryVault(), fetch: both, botFactory: gateway.factory });
  await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
});
afterEach(async () => {
  await h.close();
});

describe('Kick Stream Notifications', () => {
  it('adding: Kick must know the channel; works without any Kick account connected (app token only)', async () => {
    const missing = await call('POST', '/api/notifications', notifier('nobody_here'));
    expect(missing.status).toBe(400);
    expect(missing.body.error?.issues?.[0]?.message).toBe('Kick has no channel named “nobody_here”.');
    const ok = await call<NotifierView>('POST', '/api/notifications', notifier('https://kick.com/Streamer1'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ channel: 'streamer1', live: false, status: 'Offline. Waiting for the next stream.', destination: null });
    expect(auditActions(h).some((a) => a.action === 'notifier.created')).toBe(true);
    expect((await call('POST', '/api/notifications', notifier('streamer1'))).status).toBe(409);
  });

  it('goes live → one notification with real Kick data and the chosen role pinged; never twice for the same session, even after a restart', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { roleId: ROLE }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', title: 'Speedruns', category: 'Retro Games', thumbnail: 'https://images.kick.com/thumb.webp', viewers: 42 });
    await check();
    expect(posts()).toHaveLength(1);
    const body = posts()[0]![1].body;
    // The default (Retronix) layout: @Role + announcement; the stream title as the heading, Category and Viewers; large image; footer; buttons.
    expect(body.content).toBe(`<@&${ROLE}> Live now! Streamer1 is streaming on Kick!`);
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
    expect(body.embeds[0]).toMatchObject({
      title: 'Speedruns',
      url: 'https://kick.com/streamer1',
      fields: [
        { name: 'Category', value: 'Retro Games', inline: true },
        { name: 'Viewers', value: '42', inline: true },
      ],
      footer: { text: 'kick.com/Streamer1' },
      image: { url: 'https://images.kick.com/thumb.webp' },
      thumbnail: { url: 'https://files.kick.com/images/user/1/profile.webp' },
      color: 0x53fc18,
    });
    expect(body.embeds[0].author).toBeUndefined(); // no author needed: the bot posts it
    expect(body.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: 'Watch Streamer1 on Kick!', url: 'https://kick.com/streamer1' }] }]);
    expect(JSON.stringify(body)).not.toMatch(/STREAM-KEY|rtmps/);
    await check();
    await h.restart();
    await check();
    expect(posts()).toHaveLength(1);
    const [n] = (await call<StreamNotificationsState>('GET', '/api/notifications')).body.notifiers;
    expect(n).toMatchObject({ live: true, title: 'Speedruns', category: 'Retro Games', messageId: posts()[0]![0], status: 'Live — notification posted.', displayName: 'Streamer1' });
  });

  it('when the stream ends: deleted if chosen, left in place otherwise; a new session is announced again', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { deleteWhenEnded: true }));
    await call('POST', '/api/notifications', notifier('streamer2', { channelId: OTHER }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    kick.live.set('streamer2', { startTime: '2026-01-01T12:05:00Z' });
    await check();
    const first = posts()[0]![0];
    expect(posts(OTHER)).toHaveLength(1);
    kick.live.clear();
    await check();
    expect(discord.deletedMessages).toEqual([first]);
    expect(posts()).toHaveLength(0);
    expect(posts(OTHER)).toHaveLength(1); // not chosen: kept
    const states = (await call<StreamNotificationsState>('GET', '/api/notifications')).body.notifiers.map((x) => [x.channel, x.live, x.status]);
    expect(states).toEqual([
      ['streamer1', false, 'Stream ended; notification deleted.'],
      ['streamer2', false, 'Stream ended; notification left in place.'],
    ]);
    kick.live.set('streamer1', { startTime: '2026-01-02T18:00:00Z' });
    await check();
    expect(posts()).toHaveLength(1);
  });

  it('a message already deleted by someone counts as done', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { deleteWhenEnded: true }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    await check();
    discord.deletedMessages.push(posts()[0]![0]);
    discord.messages.clear();
    kick.live.clear();
    await check();
    expect((await call<StreamNotificationsState>('GET', '/api/notifications')).body.notifiers[0]).toMatchObject({ status: 'Stream ended; the notification was already deleted.', problem: null });
  });

  it('several streamers are checked together (one Kick request for up to 50)', async () => {
    for (const n of [1, 2, 3]) await call('POST', '/api/notifications', notifier(`streamer${n}`));
    const before = kick.appChannelRequests;
    kick.live.set('streamer2', { startTime: '2026-01-01T12:00:00Z' });
    await check();
    expect(kick.appChannelRequests - before).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![1].body.embeds[0].footer).toEqual({ text: 'kick.com/Streamer2' });
  });

  it('a streamer already live when added is not announced until their next stream', async () => {
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    const added = await call<NotifierView>('POST', '/api/notifications', notifier('streamer1'));
    expect(added.body).toMatchObject({ live: true, status: 'Live when added: the next stream will be announced.' });
    await check();
    expect(posts()).toHaveLength(0);
  });

  it('Kick outages change nothing (no post, no deletion, no guessed state); Discord failures are retried', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { deleteWhenEnded: true }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    discord.messageFailures.push({ status: 500, code: 0 });
    let s = await check();
    expect(posts()).toHaveLength(0);
    expect(s.notifiers[0]).toMatchObject({ live: true, status: 'Live — the notification couldn’t be posted.', problem: expect.any(String) });
    s = await check();
    expect(posts()).toHaveLength(1); // retried
    kick.channelsDown = true;
    kick.live.clear();
    s = await check();
    expect(posts()).toHaveLength(1); // not deleted: Kick couldn't say the stream ended
    expect(s.kick.problem).toMatch(/Couldn’t check Kick/);
    expect(s.notifiers[0]!.live).toBe(true);
  });

  it('disabled notifications are never posted; the role must be mentionable', async () => {
    discord.addRole(GUILD, '800000000000000008', 2, { name: 'Quiet', mentionable: false });
    const notMentionable = await call('POST', '/api/notifications', notifier('streamer1', { roleId: '800000000000000008' }));
    expect(notMentionable.body.error?.issues?.[0]?.message).toMatch(/@Quiet isn’t mentionable/);
    const n = (await call<NotifierView>('POST', '/api/notifications', notifier('streamer1', { enabled: false }))).body;
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    await check();
    expect(posts()).toHaveLength(0);
    expect((await call('DELETE', `/api/notifications/${n.id}`)).body).toEqual({ id: n.id, deleted: true });
  });
});

describe('Kick notification buttons, text and test posts', () => {
  it('no role: no empty mention; custom text; two link buttons (one per row); a button that isn’t a link once filled is left out', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', {
      content: 'Go watch {streamer}!',
      buttons: [
        { label: 'Watch {streamer}', url: '{url}' },
        { label: 'Schedule', url: 'https://example.com/schedule' },
      ],
    }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: 'https://images.kick.com/t.webp' });
    await check();
    const body = posts()[0]![1].body;
    expect(body.content).toBe('Go watch Streamer1!');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components).toEqual([
      { type: 1, components: [{ type: 2, style: 5, label: 'Watch Streamer1', url: 'https://kick.com/streamer1' }] },
      { type: 1, components: [{ type: 2, style: 5, label: 'Schedule', url: 'https://example.com/schedule' }] },
    ]);
  });

  it('validates buttons: label, http(s) link or {url}, at most 2', async () => {
    const issue = async (buttons: unknown) => (await call('POST', '/api/notifications', notifier('streamer1', { buttons }))).body.error?.issues?.[0];
    expect(await issue([{ label: '', url: '{url}' }])).toMatchObject({ message: 'Give the button a label' });
    expect(await issue([{ label: 'x', url: 'javascript:alert(1)' }])).toMatchObject({ message: expect.stringMatching(/http\(s\) link, or \{url\}/) });
    expect(await issue([{ label: 'x'.repeat(81), url: '{url}' }])).toMatchObject({ message: expect.stringMatching(/at most 80/) });
    expect(await issue([1, 2, 3].map(() => ({ label: 'x', url: '{url}' })))).toMatchObject({ message: 'At most 2 buttons' });
    expect((await call('POST', '/api/notifications', notifier('streamer1', { buttons: [] }))).status).toBe(201); // buttons are optional
  });

  it('no thumbnail from Kick: the image is simply left out (no placeholder in real posts)', async () => {
    await call('POST', '/api/notifications', notifier('streamer1'));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: '' });
    await check();
    expect(posts()[0]![1].body.embeds[0].image).toBeUndefined();
  });

  it('Send test: posts with the streamer’s real current data, marked as a test, role not pinged; nothing is saved', async () => {
    kick.live.set('streamer2', { startTime: '2026-01-01T12:00:00Z', title: 'Live now', category: 'Games', thumbnail: 'https://images.kick.com/s2.webp' });
    const res = await call<{ ok: boolean; message: string; live: boolean }>('POST', '/api/notifications/test', {
      channel: 'streamer2',
      guildId: GUILD,
      channelId: ALERTS,
      roleId: ROLE,
      content: 'Live now! {streamer} is streaming on Kick!',
      buttons: [{ label: 'Watch', url: '{url}' }],
    });
    expect(res.body).toEqual({ ok: true, message: 'Test posted with the live stream’s real data.', live: true });
    const body = posts()[0]![1].body;
    expect(body.content).toBe(`**Test notification** — <@&${ROLE}> Live now! Streamer2 is streaming on Kick!`);
    expect(body.allowed_mentions).toEqual({ parse: [] }); // shown, not pinged
    expect(body.embeds[0]).toMatchObject({ title: 'Live now', image: { url: 'https://images.kick.com/s2.webp' } });
    expect(body.components[0].components[0]).toMatchObject({ style: 5, url: 'https://kick.com/streamer2' });
    expect((await call<StreamNotificationsState>('GET', '/api/notifications')).body.notifiers).toEqual([]);
    // Offline: still a real post, without a stream image.
    const off = await call<{ ok: boolean; message: string }>('POST', '/api/notifications/test', { channel: 'streamer3', guildId: GUILD, channelId: ALERTS });
    expect(off.body.message).toMatch(/offline, so Kick has no stream thumbnail/);
    expect(posts()[1]![1].body.embeds[0].image).toBeUndefined();
  });
});

describe('Kick Timed Messages', () => {
  const viewer = (n: number): FakeKickUser => ({ user_id: 5550000 + n, name: `Viewer${n}`, slug: `viewer${n}`, profile_picture: null });
  const say = (content: string, from: FakeKickUser, messageId?: string) =>
    deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, messageId, badges: [] }));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 40));
    await h.services.timedMessages.idle();
  };

  beforeEach(async () => {
    await connect(kick.users.streamer);
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    await h.services.kickChat.start();
  });

  it('posts in Kick chat as the chatbot after N messages from people; the chatbot’s own messages never count', async () => {
    await call('POST', '/api/timed-messages', { platform: 'kick', name: 'Discord link', enabled: true, content: 'Join our Discord!', messageCount: 5 });
    for (let i = 0; i < 4; i++) await say(`hi ${i}`, viewer(1), `m${i}`);
    for (let i = 0; i < 3; i++) await say('Join our Discord!', kick.users.bot, `b${i}`);
    await settle();
    expect(kick.posted).toEqual([]);
    await say('one more', viewer(2), 'm9');
    await settle();
    expect(kick.posted.map((p) => [p.as, p.content])).toEqual([['RetroBotKick', 'Join our Discord!']]);
    const state = (await call<TimedMessagesState>('GET', '/api/timed-messages')).body;
    expect(state.timedMessages[0]).toMatchObject({ destination: 'retrolive’s Kick chat', recent: [{ ok: true, reason: 'messages' }] });
  });

  it('every X minutes in Kick chat; Kick messages can’t run commands', async () => {
    expect((await call('POST', '/api/timed-messages', { platform: 'kick', name: 'x', content: '!ban everyone', intervalMinutes: 10 })).status).toBe(400);
    await call('POST', '/api/timed-messages', { platform: 'kick', name: 'Reminder', enabled: true, content: 'Hydrate!', intervalMinutes: 10 });
    h.clock.advance(10 * 60_000);
    h.services.timedMessages.tick();
    await settle();
    expect(kick.posted.map((p) => p.content)).toEqual(['Hydrate!']);
  });
});

describe('Kick notification stream thumbnail', () => {
  const image = () => posts()[0]![1].body.embeds[0].image as { url: string } | undefined;

  it('posted before Kick has a thumbnail: the post is edited to add it when it appears, without pinging again', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { roleId: ROLE }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', title: 'Speedruns', thumbnail: '' });
    await check();
    expect(posts()).toHaveLength(1);
    expect(image()).toBeUndefined();
    const id = posts()[0]![0];

    await check(); // still no thumbnail: nothing to edit
    expect(discord.messages.get(id)!.edits).toBe(0);

    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', title: 'Speedruns', thumbnail: 'https://images.kick.com/video_thumbnails/a/720.webp?versionId=1' });
    await check();
    expect(posts()).toHaveLength(1); // the same post, edited; not a second one
    const msg = discord.messages.get(id)!;
    expect(msg.edits).toBe(1);
    expect(image()).toEqual({ url: 'https://images.kick.com/video_thumbnails/a/720.webp?versionId=1' });
    expect(msg.body.content).toBe(`<@&${ROLE}> Live now! Streamer1 is streaming on Kick!`);
    expect(msg.body.allowed_mentions).toEqual({ parse: [] }); // an edit never pings
    expect(msg.body.components).toHaveLength(1); // buttons kept
    expect(msg.body.embeds[0].title).toBe('Speedruns');

    await check(); // unchanged thumbnail: no further edits
    expect(msg.edits).toBe(1);
  });

  it('keeps the thumbnail current at most every 10 minutes', async () => {
    await call('POST', '/api/notifications', notifier('streamer1'));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: 'https://images.kick.com/t.webp?v=1' });
    await check();
    const id = posts()[0]![0];
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: 'https://images.kick.com/t.webp?v=2' });
    h.clock.advance(5 * 60_000);
    await check();
    expect(discord.messages.get(id)!.edits).toBe(0);
    h.clock.advance(5 * 60_000);
    await check();
    expect(discord.messages.get(id)!.edits).toBe(1);
    expect(image()).toEqual({ url: 'https://images.kick.com/t.webp?v=2' });
  });

  it('channel info without a thumbnail: Kick’s livestreams endpoint supplies it', async () => {
    await call('POST', '/api/notifications', notifier('streamer1'));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: '', livestreamThumbnail: 'https://images.kick.com/ls.webp' });
    await check();
    expect(kick.livestreamRequests).toBe(1);
    expect(image()).toEqual({ url: 'https://images.kick.com/ls.webp' });
  });

  it('no extra Kick requests when the channel info already has the thumbnail, or nobody is live', async () => {
    await call('POST', '/api/notifications', notifier('streamer1'));
    await check();
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: 'https://images.kick.com/t.webp' });
    await check();
    expect(kick.livestreamRequests).toBe(0);
  });

  it('a layout without {thumbnail} is never edited', async () => {
    await call('POST', '/api/notifications', notifier('streamer1', { embed: { ...DEFAULT_NOTIFICATION_EMBED, imageUrl: '' } }));
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: '' });
    await check();
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', thumbnail: 'https://images.kick.com/t.webp' });
    await check();
    expect(discord.messages.get(posts()[0]![0])!.edits).toBe(0);
  });

  it('Send test while Kick has no thumbnail yet says so', async () => {
    kick.live.set('streamer2', { startTime: '2026-01-01T12:00:00Z', thumbnail: '' });
    const res = await call<{ ok: boolean; message: string }>('POST', '/api/notifications/test', notifier('streamer2'));
    expect(res.body).toMatchObject({ ok: true, message: expect.stringMatching(/hasn’t made a thumbnail for this stream yet/) });
  });
});

describe('notification layout fixes (casing, default layout)', () => {
  it('a differently capitalised {Streamer} fills in, and is saved lowercase', async () => {
    const created = await call<NotifierView>('POST', '/api/notifications', notifier('streamer1', { content: '{Streamer} is now live! {TITLE}', buttons: [{ label: 'Watch {Streamer}', url: '{URL}' }] }));
    expect(created.status).toBe(201);
    expect(created.body.content).toBe('{streamer} is now live! {title}');
    expect(created.body.buttons).toEqual([{ label: 'Watch {streamer}', url: '{url}' }]);
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z', title: 'Speedruns' });
    await check();
    expect(posts()[0]![1].body.content).toBe('Streamer1 is now live! Speedruns');
  });

  it('replacing the layout while live keeps tracking: no second post, same message, other settings unchanged', async () => {
    const created = (await call<NotifierView>('POST', '/api/notifications', notifier('streamer1', { roleId: ROLE, deleteWhenEnded: true, content: '{Streamer} old' }))).body;
    const other = (await call<NotifierView>('POST', '/api/notifications', notifier('streamer2', { content: 'Other {streamer}' }))).body;
    kick.live.set('streamer1', { startTime: '2026-01-01T12:00:00Z' });
    await check();
    expect(posts()).toHaveLength(1);
    const messageId = posts()[0]![0];

    const res = await call<NotifierView>('PATCH', `/api/notifications/${created.id}`, {
      content: DEFAULT_NOTIFICATION_CONTENT,
      embed: DEFAULT_NOTIFICATION_EMBED,
      buttons: [{ label: 'Watch {streamer} on Kick!', url: '{url}' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roleId: ROLE, deleteWhenEnded: true, enabled: true, channelId: ALERTS, live: true, messageId, content: DEFAULT_NOTIFICATION_CONTENT });
    await check();
    expect(posts()).toHaveLength(1); // no duplicate for the same live session
    const state = (await call<StreamNotificationsState>('GET', '/api/notifications')).body;
    expect(state.notifiers.find((n) => n.id === other.id)?.content).toBe('Other {streamer}'); // other streamers untouched
  });
});
