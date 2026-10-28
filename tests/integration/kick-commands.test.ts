/**
 * Kick custom commands against a simulated Kick (automated, mocked — not proof of live Kick behaviour): management
 * through the API, and replies triggered by real signed webhook deliveries through the existing chat feed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandsHubState, CustomCommandView } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { parseCommand } from '../../apps/server/src/kick/kick-command-service';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;
let kick: FakeKick;
let vault: MemoryVault;
let port: number;
/** Kick's website answers, by URL (anything else: 404). */
let kickWeb: Record<string, unknown>;

beforeEach(async () => {
  kick = new FakeKick();
  vault = new MemoryVault();
  port = await freePort();
  kickWeb = {};
  h = await createHarness(
    { CONDUIT_KICK_WEBHOOK_PORT: String(port) },
    {
      vault,
      fetch: kick.fetch,
      random: () => 0.5,
      kickWebFetch: async (url) => (url in kickWeb ? new Response(JSON.stringify(kickWeb[url]), { status: 200 }) : new Response('not found', { status: 404 })),
    },
  );
  await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
});
afterEach(async () => {
  await h.close();
});

const hub = async () => (await h.call<CommandsHubState>('GET', '/api/commands/kick')).body;
const list = async () => ({ ...(await hub()), commands: (await hub()).custom });
const create = (body: unknown) =>
  h.call<CustomCommandView & { error?: { code: string; issues?: Array<{ path: string; message: string }> } }>(
    'POST',
    '/api/commands/kick',
    {
      body,
    },
  );
const patch = (id: string, body: unknown) =>
  h.call<CustomCommandView & { error?: { code: string } }>('PATCH', `/api/commands/kick/${id}`, { body });

async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
  const back = kick.approve(new URL(res.body.authorizationUrl), who);
  expect((await fetch(back)).status).toBe(200);
}

describe('managing commands', () => {
  it('starts empty, then creates, lists, edits, disables, enables and deletes', async () => {
    expect((await list()).commands).toEqual([]);
    const created = await create({ trigger: '!Discord', response: 'Join our Discord community!' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      platform: 'kick',
      trigger: '!discord',
      response: 'Join our Discord community!',
      enabled: true,
      valid: true,
      lastRun: null,
      runs: 0,
    });
    const id = created.body.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await patch(id, { response: 'discord.gg/retro' })).body).toMatchObject({ response: 'discord.gg/retro', trigger: '!discord' });
    expect((await patch(id, { enabled: false })).body.enabled).toBe(false);
    expect((await patch(id, { enabled: true })).body.enabled).toBe(true);
    expect((await patch(id, { trigger: '!dc' })).body.trigger).toBe('!dc');
    expect((await list()).commands.map((c) => c.trigger)).toEqual(['!dc']);

    expect((await h.call('DELETE', `/api/commands/kick/${id}`)).status).toBe(204);
    expect((await list()).commands).toEqual([]);
    expect((await h.call('DELETE', `/api/commands/kick/${id}`)).status).toBe(404);
    expect((await patch('00000000-0000-0000-0000-000000000000', { enabled: true })).status).toBe(404);
  });

  it.each([
    [{ trigger: 'discord', response: 'x' }, 'trigger', /starts with "!"/],
    [{ trigger: '!', response: 'x' }, 'trigger', /1–31/],
    [{ trigger: '!two words', response: 'x' }, 'trigger', /no spaces/],
    [{ trigger: '!' + 'a'.repeat(32), response: 'x' }, 'trigger', /1–31/],
    [{ trigger: '!ok', response: '   ' }, 'response', /Enter the response/],
    [{ trigger: '!ok', response: '!other' }, 'response', /can’t start with "!" or "\/"/],
    [{ trigger: '!ok', response: '/ban someone' }, 'response', /can’t start with "!" or "\/"/],
    [{ trigger: '!ok', response: 'line\nbreak' }, 'response', /single line/],
    [{ trigger: '!ok', response: 'x'.repeat(501) }, 'response', /500 characters/],
  ])('rejects invalid input %j on the backend', async (body, field, message) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error!.issues!.find((i) => i.path === field)!.message).toMatch(message);
    expect((await list()).commands).toEqual([]);
  });

  it('rejects unknown fields (no code, scripts or extra settings)', async () => {
    expect((await create({ trigger: '!ok', response: 'fine', script: 'alert(1)' })).status).toBe(400);
  });

  it('prevents duplicate triggers regardless of case, on create and on edit', async () => {
    await create({ trigger: '!hello', response: 'Hi!' });
    const dup = await create({ trigger: '!HELLO', response: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error!.issues).toEqual([{ path: 'trigger', message: expect.stringMatching(/!hello already exists/) }]);
    const other = await create({ trigger: '!bye', response: 'Bye' });
    expect((await patch(other.body.id, { trigger: '!Hello' })).status).toBe(409);
    // Editing a command without changing its trigger is fine.
    expect((await patch(other.body.id, { trigger: '!bye', response: 'See you' })).status).toBe(200);
  });

  it('commands persist across a restart', async () => {
    await create({ trigger: '!hello', response: 'Hello from MyChatBot!' });
    await create({ trigger: '!off', response: 'Disabled one', enabled: false });
    await h.restart();
    const s = await list();
    expect(s.commands.map((c) => [c.trigger, c.enabled])).toEqual([
      ['!hello', true],
      ['!off', false],
    ]);
  });
});

describe('matching', () => {
  it('uses the first word only, case-insensitively, as a whole token', () => {
    expect(parseCommand('!hello')?.trigger ?? null).toBe('!hello');
    expect(parseCommand('  !HeLLo there friend')?.trigger ?? null).toBe('!hello');
    expect(parseCommand('!helloworld')?.trigger ?? null).toBe('!helloworld'); // a different trigger, not !hello
    expect(parseCommand('say !hello')?.trigger ?? null).toBeNull();
    expect(parseCommand('hello')?.trigger ?? null).toBeNull();
    expect(parseCommand('!')?.trigger ?? null).toBeNull();
    expect(parseCommand('!hi!')?.trigger ?? null).toBeNull();
  });
});

describe('running commands from live chat (simulated Kick)', () => {
  beforeEach(async () => {
    await connect(kick.users.streamer);
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    await h.services.kickChat.start();
  });

  const say = (content: string, from: FakeKickUser = kick.users.otherBot, messageId?: string) =>
    deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, messageId }));

  async function settle(expectedPosts: number): Promise<void> {
    const end = Date.now() + 2000;
    while (kick.posted.length < expectedPosts && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 40));
  }

  it('replies to an enabled command as the chatbot account, in the main channel', async () => {
    await create({ trigger: '!discord', response: 'Join our Discord community!' });
    expect(await say('!discord')).toBe(200);
    await settle(1);
    expect(kick.posted).toEqual([
      { as: 'RetroBotKick', type: 'user', broadcaster_user_id: 4242001, content: 'Join our Discord community!' },
    ]);
    const s = await list();
    expect(s.commands[0]).toMatchObject({ runs: 1, lastRun: { outcome: 'sent', detail: 'Posted as RetroBotKick.' } });
    expect(s.recent).toEqual([expect.objectContaining({ trigger: '!discord', outcome: 'sent' })]);
    expect(s.ready).toMatchObject({ ok: true, sendAs: 'RetroBotKick', channel: 'retrolive', note: null });
    // The giveaway entry command, then the default commands.
    expect(s.defaults[0]).toEqual({ trigger: '!enter', description: 'Enters the current giveaway (silent: no reply in chat)', permission: 'everyone', enabled: true, canDisable: false, inactiveReason: null, args: [], example: '!enter', message: null });
    expect(s.defaults.find((d) => d.trigger === '!timeout')).toMatchObject({ args: ['@name', '[minutes]', '[reason]'], example: '!timeout @troll 10 spamming links', message: '{name} is timed out for {minutes} minutes.' });
    expect(s.defaults.slice(1).map((d) => d.trigger)).toEqual(['!ping', '!commands', '!uptime', '!followage', '!title', '!so', '!timeout', '!ban', '!unban', '!addcom', '!editcom', '!delcom', '!setcategory']);
  });

  it('an edited reply is saved before anything is sent, and exactly that text (with variables filled in) is posted', async () => {
    const created = await create({ trigger: '!so', response: 'Old text' });
    const edited = await patch(created.body.id, { response: 'Go follow {args}! Shout-out from {user} in {channel}. ({message})' });
    expect(edited.body.response).toBe('Go follow {args}! Shout-out from {user} in {channel}. ({message})');
    expect((await list()).commands[0]!.response).toBe('Go follow {args}! Shout-out from {user} in {channel}. ({message})');
    expect(kick.posted).toEqual([]); // saving never sends
    await say('!so streamer', kick.users.otherBot);
    await settle(1);
    expect(kick.posted.map((p) => p.content)).toEqual(['Go follow streamer! Shout-out from SecondBot in retrolive. (!so streamer)']);
  });

  it('matches case-insensitively and with extra words; ignores substrings and mid-message triggers', async () => {
    await create({ trigger: '!hello', response: 'Hello from MyChatBot!' });
    await say('!HELLO');
    await settle(1);
    await say('!hello everyone');
    await settle(2);
    await say('!helloworld');
    await say('say !hello please');
    await say('hello');
    await settle(3);
    expect(kick.posted.map((p) => p.content)).toEqual(['Hello from MyChatBot!', 'Hello from MyChatBot!']);
  });

  it('ignores disabled commands, and responds again after re-enabling', async () => {
    const c = await create({ trigger: '!hello', response: 'Hi there' });
    await patch(c.body.id, { enabled: false });
    await say('!hello');
    await settle(1);
    expect(kick.posted).toHaveLength(0);
    await patch(c.body.id, { enabled: true });
    await say('!hello');
    await settle(1);
    expect(kick.posted).toHaveLength(1);
  });

  it("never replies to the chatbot's own messages (no loops)", async () => {
    await create({ trigger: '!hello', response: 'Hi there' });
    await say('!hello', kick.users.bot); // MyChatBot itself typing the trigger
    await settle(1);
    expect(kick.posted).toHaveLength(0);
  });

  it('the streamer can use commands even when the chatbot is the main account', async () => {
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'primary' } });
    await connect(kick.users.streamer); // reauthorize: main account gains chat:write
    await create({ trigger: '!hello', response: 'Hi there' });
    await say('!hello', kick.users.streamer);
    await settle(1);
    expect(kick.posted).toEqual([expect.objectContaining({ as: 'RetroLive', content: 'Hi there' })]);
  });

  it('processes a repeated webhook delivery once', async () => {
    await create({ trigger: '!hello', response: 'Hi there' });
    const payload = chatPayload({
      content: '!hello',
      sender: kick.users.otherBot,
      broadcaster: kick.users.streamer,
      messageId: 'chat-msg-1',
    });
    await deliverWebhook(kick, port, payload, { messageId: '01JDELIVERYAAAAAAAAAAAAAA1' });
    await deliverWebhook(kick, port, payload, { messageId: '01JDELIVERYAAAAAAAAAAAAAA1' });
    await deliverWebhook(kick, port, payload); // redelivered under a new delivery id
    await settle(1);
    await settle(2);
    expect(kick.posted).toHaveLength(1);
  });

  it("ignores other channels' chat", async () => {
    await create({ trigger: '!hello', response: 'Hi there' });
    await deliverWebhook(kick, port, chatPayload({ content: '!hello', sender: kick.users.otherBot, broadcaster: kick.users.otherBot }));
    await settle(1);
    expect(kick.posted).toHaveLength(0);
  });

  it('sends a burst of commands one at a time, respecting the send spacing', async () => {
    await create({ trigger: '!a', response: 'Reply A' });
    await create({ trigger: '!b', response: 'Reply B' });
    await say('!a');
    await say('!b');
    await say('!a again');
    await settle(3);
    expect(kick.posted.map((p) => p.content)).toEqual(['Reply A', 'Reply B', 'Reply A']);
    expect((await list()).recent.every((r) => r.outcome === 'sent')).toBe(true);
  });

  it('reports a failed reply truthfully, keeps handling chat, and does not retry what Kick saw', async () => {
    await create({ trigger: '!a', response: 'Reply A' });
    await create({ trigger: '!b', response: 'Reply B' });
    kick.apiFailures.push(403);
    await say('!a');
    await settle(1);
    let s = await list();
    expect(s.commands.find((c) => c.trigger === '!a')!.lastRun).toMatchObject({
      outcome: 'failed',
      detail: expect.stringMatching(/Kick refused/),
    });
    expect(kick.posted).toHaveLength(0);

    kick.apiFailures.push('network');
    await say('!b');
    await settle(1);
    s = await list();
    expect(s.commands.find((c) => c.trigger === '!b')!.lastRun!.outcome).toBe('unconfirmed');
    const chatPosts = kick.requests.filter((r) => r.url.endsWith('/public/v1/chat')).length;
    expect(chatPosts).toBe(2); // one attempt each, no retries

    await say('!a');
    await settle(1);
    expect(kick.posted.map((p) => p.content)).toEqual(['Reply A']);
  });

  it("the chatbot's own messages never trigger commands (Kick echoes them back through the webhook)", async () => {
    await create({ trigger: '!hello', response: 'Hi there' });
    await say('!hello', kick.users.bot);
    await settle(1);
    expect(kick.posted).toHaveLength(0);
  });

  describe('variables', () => {
    it('fills in {user} and {channel} from the actual message before sending', async () => {
      await create({ trigger: '!hello', response: 'Hello {user}, welcome to {channel}!' });
      await say('!hello'); // sent by SecondBot in retrolive's channel
      await settle(1);
      expect(kick.posted.map((p) => p.content)).toEqual(['Hello SecondBot, welcome to retrolive!']);
    });

    it('{args} is the text after the trigger, and empty when there is none', async () => {
      await create({ trigger: '!so', response: 'Go follow {args} now' });
      await say('!so   CoolStreamer   ');
      await settle(1);
      await say('!so');
      await settle(2);
      expect(kick.posted.map((p) => p.content)).toEqual(['Go follow CoolStreamer now', 'Go follow now']);
    });

    it('{message} is the whole chat message; values are inserted once, never re-read as variables', async () => {
      await create({ trigger: '!echo', response: '{user} said: {message}' });
      await say('!echo {user} {channel}');
      await settle(1);
      expect(kick.posted[0]!.content).toBe('SecondBot said: !echo {user} {channel}');
    });

    it('never sends a reply that would start with "!" or "/" because of a variable (no command loops)', async () => {
      await create({ trigger: '!say', response: '{args}' });
      await say('!say !say');
      await say('!say /ban someone');
      await settle(1);
      expect(kick.posted).toHaveLength(0);
      const run = (await hub()).custom[0]!.lastRun!;
      expect(run).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/would start with "!" or "\/"/) });
    });

    it('does not send an empty reply', async () => {
      await create({ trigger: '!what', response: '{args}' });
      await say('!what');
      await settle(1);
      expect(kick.posted).toHaveLength(0);
      expect((await hub()).custom[0]!.lastRun).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/empty/) });
    });

    it("fits the reply to Kick's 500-character limit after substitution", async () => {
      await create({ trigger: '!long', response: `${'x'.repeat(300)} {args}` });
      await say(`!long ${'y'.repeat(400)}`);
      await settle(1);
      const sent = kick.posted[0]!.content;
      expect([...new Intl.Segmenter().segment(sent)].length).toBeLessThanOrEqual(500);
      expect(sent.endsWith('…')).toBe(true);
    });

    it('rejects unknown variables when saving; a stored one is posted as written and flagged', async () => {
      const bad = await create({ trigger: '!x', response: 'Hi {sender.username}' });
      expect(bad.status).toBe(400);
      expect(bad.body.error!.issues![0]!.message).toMatch(/\{sender\.username\} isn’t a variable for Kick commands/);
      // As in an existing installation: a command saved before variables existed.
      h.db
        .prepare(
          "INSERT INTO chat_commands (id, platform, trigger, description, response, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'kick', '!vanish', NULL, 'Bye {{sender.username}', 1, 'x', 'x')",
        )
        .run();
      const view = (await hub()).custom.find((x) => x.trigger === '!vanish')!;
      expect(view).toMatchObject({ valid: true, unknownVariables: ['{sender.username}'] });
      await say('!vanish');
      await settle(1);
      expect(kick.posted.map((p) => p.content)).toEqual(['Bye {{sender.username}']);
    });
  });

  describe('more variables', () => {
    const fan = (n: number): FakeKickUser => ({ user_id: 4243000 + n, name: `Fan${n}`, slug: `fan${n}`, profile_picture: null });

    it('{count} and named counters go up each use and are kept in the database', async () => {
      await create({ trigger: '!death', response: 'Deaths: {counter:deaths+1} (used {count}×)' });
      await create({ trigger: '!deaths', response: 'Total deaths: {counter:deaths}' });
      await say('!death');
      await settle(1);
      await say('!death');
      await settle(2);
      await say('!deaths');
      await settle(3);
      expect(kick.posted.map((p) => p.content)).toEqual(['Deaths: 1 (used 1×)', 'Deaths: 2 (used 2×)', 'Total deaths: 2']);
      expect(h.db.prepare("SELECT value FROM command_counters WHERE key = 'counter:deaths'").get()).toEqual({ value: 2 });
    });

    it('{roles} and {submonths} come from the sender’s Kick badges; {touser}, {1} and fallbacks from the message', async () => {
      await create({ trigger: '!me', response: '{user} ({roles}), sub for {submonths|0} months, hugs {touser}: {2|nothing}' });
      await deliverWebhook(
        kick,
        port,
        chatPayload({ content: '!me @Bob', sender: kick.users.otherBot, broadcaster: kick.users.streamer, badges: [{ text: 'Subscriber', type: 'subscriber', count: 6 }, { text: 'VIP', type: 'vip' }] }),
      );
      await settle(1);
      expect(kick.posted[0]!.content).toBe('SecondBot (Subscriber, VIP), sub for 6 months, hugs Bob: nothing');
    });

    it('your stream: {title}, {category}, {viewers}, {uptime}, {url} from Kick’s official API', async () => {
      kick.live.set('retrolive', { startTime: new Date(h.clock.now().getTime() - 75 * 60_000).toISOString(), title: 'Speedruns', category: 'Retro', viewers: 321 });
      await create({ trigger: '!live', response: '{streamer}: {title} ({category}) for {uptime}, {viewers} watching — {url}' });
      await say('!live');
      await settle(1);
      expect(kick.posted[0]!.content).toMatch(/^RetroLive: Speedruns \(Retro\) for 1 hour 15 minutes, 321 watching — https:\/\/kick\.com\/retrolive$/);
    });

    it('{uptime} says offline when you aren’t live', async () => {
      await create({ trigger: '!uptime', response: 'Uptime: {uptime}' });
      await say('!uptime');
      await settle(1);
      expect(kick.posted[0]!.content).toBe('Uptime: offline');
    });

    it('{randomuser} picks someone else who chatted recently', async () => {
      await create({ trigger: '!pick', response: 'Winner: {randomuser|nobody}' });
      await say('!pick');
      await settle(1);
      await say('hello', fan(1));
      await say('hi all', fan(2));
      await say('!pick');
      await settle(2);
      expect(kick.posted[0]!.content).toBe('Winner: nobody');
      expect(['Winner: Fan1', 'Winner: Fan2']).toContain(kick.posted[1]!.content);
    });

    it('variables from the other platform are rejected when saving', async () => {
      const res = await create({ trigger: '!x', response: 'Hi {mention}' });
      expect(res.status).toBe(400);
      expect(res.body.error!.issues![0]!.message).toMatch(/\{mention\} isn’t a variable for Kick commands/);
    });
  });

  describe('permissions and cooldowns', () => {
    const MOD = [{ text: 'Moderator', type: 'moderator' }];
    const SUB = [{ text: 'Subscriber', type: 'subscriber', count: 3 }];
    const NONE: Array<{ text: string; type: string }> = [];
    const as = (content: string, from: FakeKickUser, badges: Array<{ text: string; type: string }> | null, messageId?: string) =>
      deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, badges, messageId }));
    const viewer = { user_id: 5550001, name: 'Viewer', slug: 'viewer', profile_picture: null };
    const viewer2 = { user_id: 5550002, name: 'Viewer2', slug: 'viewer2', profile_picture: null };
    const runs = async (trigger: string) => (await hub()).custom.find((x) => x.trigger === trigger)!;

    it('existing commands keep working for everyone with no cooldown', async () => {
      const c = await create({ trigger: '!hi', response: 'Hi {user}' });
      expect(c.body).toMatchObject({ permission: 'everyone', cooldownMode: 'none', cooldownSeconds: 0, access: 'Anyone · no cooldown' });
      await as('!hi', viewer, NONE);
      await settle(1);
      await as('!hi', viewer, NONE);
      await settle(2);
      expect(kick.posted).toHaveLength(2);
    });

    it('moderator commands: moderators and the broadcaster yes, others no (silently)', async () => {
      await create({ trigger: '!mod', response: 'Mod tools ready', permission: 'moderator' });
      await as('!mod', viewer, NONE);
      await as('!mod', viewer, SUB);
      await settle(1);
      expect(kick.posted).toHaveLength(0);
      expect((await runs('!mod')).lastRun).toMatchObject({ outcome: 'blocked', detail: 'Not allowed: moderators only.' });
      await as('!mod', viewer, MOD);
      await settle(1);
      await as('!mod', kick.users.streamer, NONE); // the broadcaster, no badge needed
      await settle(2);
      expect(kick.posted.map((p) => p.content)).toEqual(['Mod tools ready', 'Mod tools ready']);
    });

    it('subscriber commands: subscribers, moderators and the broadcaster', async () => {
      await create({ trigger: '!sub', response: 'Thanks for subbing', permission: 'subscriber' });
      await as('!sub', viewer, NONE);
      await settle(1);
      expect(kick.posted).toHaveLength(0);
      await as('!sub', viewer, SUB);
      await settle(1);
      await as('!sub', viewer2, MOD);
      await settle(2);
      expect(kick.posted).toHaveLength(2);
    });

    it('broadcaster-only commands: only the channel owner', async () => {
      await create({ trigger: '!owner', response: 'Owner only', permission: 'broadcaster' });
      await as('!owner', viewer, MOD);
      await settle(1);
      expect(kick.posted).toHaveLength(0);
      await as('!owner', kick.users.streamer, NONE);
      await settle(1);
      expect(kick.posted).toHaveLength(1);
    });

    it('missing or unknown role data is treated as an ordinary user', async () => {
      await create({ trigger: '!sub', response: 'Thanks', permission: 'subscriber' });
      await as('!sub', viewer, null); // no identity in the event at all
      await as('!sub', viewer, [
        { text: 'VIP', type: 'vip' },
        { text: 'Founder', type: 'founder' },
      ]);
      await settle(1);
      expect(kick.posted).toHaveLength(0);
    });

    it('per-user cooldown: the same user waits, another user does not; it expires', async () => {
      await create({ trigger: '!cd', response: 'Cool', cooldownMode: 'user', cooldownSeconds: 60 });
      await as('!cd', viewer, NONE);
      await settle(1);
      await as('!cd', viewer, NONE);
      await settle(2);
      expect(kick.posted).toHaveLength(1);
      expect((await runs('!cd')).lastRun).toMatchObject({
        outcome: 'blocked',
        detail: expect.stringMatching(/^On cooldown \(\d+ s left\)\.$/),
      });
      await as('!cd', viewer2, NONE);
      await settle(2);
      expect(kick.posted).toHaveLength(2);
      h.clock.advance(61_000);
      await as('!cd', viewer, NONE);
      await settle(3);
      expect(kick.posted).toHaveLength(3);
    });

    it('global cooldown: after anyone uses it, everyone waits', async () => {
      await create({ trigger: '!g', response: 'Global', cooldownMode: 'global', cooldownSeconds: 60 });
      await as('!g', viewer, NONE);
      await settle(1);
      await as('!g', viewer2, MOD);
      await settle(2);
      expect(kick.posted).toHaveLength(1);
    });

    it('concurrent triggers from one user run once', async () => {
      await create({ trigger: '!cd', response: 'Once', cooldownMode: 'user', cooldownSeconds: 60 });
      await Promise.all([as('!cd', viewer, NONE), as('!cd', viewer, NONE), as('!cd', viewer, NONE)]);
      await settle(1);
      await settle(2);
      expect(kick.posted).toHaveLength(1);
    });

    it('a duplicate webhook delivery neither runs twice nor touches the cooldown', async () => {
      await create({ trigger: '!cd', response: 'Once', cooldownMode: 'user', cooldownSeconds: 60 });
      const payload = chatPayload({ content: '!cd', sender: viewer, broadcaster: kick.users.streamer, badges: NONE, messageId: 'dup-1' });
      await deliverWebhook(kick, port, payload);
      await deliverWebhook(kick, port, payload);
      await settle(1);
      await settle(2);
      expect(kick.posted).toHaveLength(1);
      expect((await runs('!cd')).runs).toBe(1); // the duplicate wasn't even counted as blocked
    });

    it('unauthorized attempts do not use up a cooldown', async () => {
      await create({ trigger: '!modg', response: 'Mod global', permission: 'moderator', cooldownMode: 'global', cooldownSeconds: 60 });
      await as('!modg', viewer, NONE); // blocked by permission
      await settle(1);
      await as('!modg', viewer2, MOD);
      await settle(1);
      expect(kick.posted.map((p) => p.content)).toEqual(['Mod global']);
    });

    it('a reply Kick refused does not use up the cooldown', async () => {
      await create({ trigger: '!g', response: 'Global', cooldownMode: 'global', cooldownSeconds: 60 });
      kick.apiFailures.push(403);
      await as('!g', viewer, NONE);
      await settle(1);
      expect((await runs('!g')).lastRun!.outcome).toBe('failed');
      await as('!g', viewer2, NONE);
      await settle(1);
      expect(kick.posted.map((p) => p.content)).toEqual(['Global']);
    });

    it('cooldowns are per command', async () => {
      await create({ trigger: '!a', response: 'A', cooldownMode: 'global', cooldownSeconds: 60 });
      await create({ trigger: '!b', response: 'B', cooldownMode: 'global', cooldownSeconds: 60 });
      await as('!a', viewer, NONE);
      await settle(1);
      await as('!b', viewer, NONE);
      await settle(2);
      expect(kick.posted.map((p) => p.content)).toEqual(['A', 'B']);
    });

    it('settings are saved, validated on the backend, and shown', async () => {
      const c = await create({ trigger: '!x', response: 'X', permission: 'moderator', cooldownMode: 'user', cooldownSeconds: 30 });
      expect(c.body.access).toBe('Moderators · 30 s per user');
      expect((await patch(c.body.id, { cooldownMode: 'none' })).body).toMatchObject({ cooldownMode: 'none', cooldownSeconds: 0 });
      expect((await patch(c.body.id, { cooldownMode: 'global' })).status).toBe(400); // needs a duration
      expect((await patch(c.body.id, { cooldownMode: 'global', cooldownSeconds: 120 })).body.access).toBe(
        'Moderators · 2 min for everyone',
      );
      expect((await create({ trigger: '!y', response: 'Y', permission: 'owner' })).status).toBe(400);
      expect((await create({ trigger: '!z', response: 'Z', cooldownMode: 'user', cooldownSeconds: 0 })).status).toBe(400);
      await h.restart();
      expect((await hub()).custom.find((x) => x.trigger === '!x')).toMatchObject({
        permission: 'moderator',
        cooldownMode: 'global',
        cooldownSeconds: 120,
      });
    });
  });
});
