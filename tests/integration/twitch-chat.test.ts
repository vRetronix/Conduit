/**
 * Twitch chat (1.2.0) against a simulated Twitch (automated, mocked — not proof that real Twitch chat works): the
 * EventSub WebSocket session and its channel.chat.message subscription, sending as the chatbot account (the main
 * account or a separate bot account), custom Twitch commands and Twitch timed messages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandsHubState, CustomCommandView, TimedMessagesState, TimedMessageView, TwitchSendResult, TwitchSetupState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { parseTwitchChatMessage } from '../../apps/server/src/twitch/twitch-chat-service';
import { FakeTwitch, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, type FakeTwitchUser } from '../helpers/fake-twitch';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let twitch: FakeTwitch;

const user = (n: number, login = `twitcher${n}`): FakeTwitchUser => ({
  id: String(9990000 + n),
  login,
  display_name: login[0]!.toUpperCase() + login.slice(1),
  profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${n}-profile_image-300x300.png`,
});
const streamer = user(1, 'retrolive');
const botAccount = user(2, 'retrobot');
const viewer = user(3, 'viewer');
const mod = user(4, 'helper');

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const state = async () => (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
const send = (content: unknown) => call<TwitchSendResult>('POST', '/api/twitch/chat/send', { content });

/** Approves on Twitch's page as `who`; returns the status of CONDUIT's callback page. */
async function connect(who: FakeTwitchUser, role: 'primary' | 'bot' = 'primary', expected = 200): Promise<void> {
  const res = await call<{ authorizationUrl: string }>('POST', '/api/connections/twitch/connect', { role });
  expect(res.status).toBe(200);
  expect((await fetch(twitch.approve(new URL(res.body.authorizationUrl), who))).status).toBe(expected);
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`never matched: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The main account connected and chat subscribed. */
async function liveChat(): Promise<void> {
  await connect(streamer);
  await h.services.twitchChat.start();
  await until(state, (s) => s.chat.receive.status === 'connected');
}

beforeEach(async () => {
  twitch = new FakeTwitch();
  for (const u of [streamer, botAccount, viewer, mod]) twitch.directory.set(u.login, u);
  const eventSub = await twitch.startEventSub();
  h = await createHarness({}, { vault: new MemoryVault(), fetch: twitch.fetch, twitchEventSubUrl: eventSub });
  expect((await call('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET })).status).toBe(200);
});
afterEach(async () => {
  await h.close();
  await twitch.stopEventSub();
});

describe('receiving chat (EventSub over a WebSocket)', () => {
  it('asks only for chat permissions, then subscribes the session to the channel’s chat, read as the main account', async () => {
    const before = await state();
    expect(before.scopes).toEqual({ primary: ['user:read:chat', 'user:write:chat'], bot: ['user:write:chat'] });
    expect(before.chat.receive.status).toBe('disconnected');

    await liveChat();
    expect(twitch.sessions).toHaveLength(1);
    expect(twitch.subscriptions).toEqual([expect.objectContaining({ sessionId: twitch.sessions[0], broadcasterId: streamer.id, userId: streamer.id })]);

    twitch.chat(streamer, viewer, 'hello chat', { badges: [{ set_id: 'subscriber', info: '7' }] });
    const s = await until(state, (x) => x.chat.recent.length === 1);
    expect(s.chat.receive.messagesReceived).toBe(1);
    expect(s.chat.recent[0]).toMatchObject({ content: 'hello chat', senderUsername: 'Viewer', badges: ['subscriber'] });
  });

  it('an account connected before chat existed (no chat permission) is asked to reconnect; reconnecting starts chat', async () => {
    await connect(streamer);
    // As connected with 1.1.0, which asked for no permissions.
    h.db.prepare("UPDATE platform_connections SET granted_scopes = '[]' WHERE platform = 'twitch'").run();
    await h.services.twitchChat.start();
    const s = await state();
    expect(s.chat.receive.status).toBe('permission_required');
    expect(s.chat.receive.problem).toMatch(/user:read:chat/);
    expect(s.chat.send.missingScope).toBe('user:write:chat');
    expect(twitch.sessions).toHaveLength(0);

    await connect(streamer);
    await until(state, (x) => x.chat.receive.status === 'connected');
  });

  it('a dropped connection is reported and opened again on Retry (never two sessions)', async () => {
    await liveChat();
    twitch.dropConnections();
    const lost = await until(state, (x) => x.chat.receive.status === 'reconnecting');
    expect(lost.chat.receive.problem).toMatch(/Retrying in 5 seconds/);
    expect((await call('POST', '/api/twitch/chat/retry')).status).toBe(200);
    await until(state, (x) => x.chat.receive.status === 'connected');
    await until(() => twitch.sessions, (x) => x.length === 1);
    twitch.chat(streamer, viewer, 'back again');
    await until(state, (x) => x.chat.recent.some((m) => m.content === 'back again'));
  });

  it('follows Twitch’s session_reconnect to the new connection without subscribing again', async () => {
    await liveChat();
    const first = twitch.sessions[0]!;
    twitch.reconnect(first);
    await until(() => twitch.sessions, (x) => x.length === 1 && x[0] !== first);
    expect(twitch.subscriptions).toHaveLength(1);
    twitch.chat(streamer, viewer, 'still here');
    await until(state, (x) => x.chat.recent.some((m) => m.content === 'still here'));
    expect((await state()).chat.receive.status).toBe('connected');
  });

  it('a revoked subscription stops chat with an explanation', async () => {
    await liveChat();
    twitch.revokeSubscriptions();
    const s = await until(state, (x) => x.chat.receive.status === 'error');
    expect(s.chat.receive.problem).toMatch(/authorization was revoked/);
  });

  it('disconnecting the main account closes the session', async () => {
    await liveChat();
    expect((await call('POST', '/api/connections/twitch/disconnect', { role: 'primary' })).status).toBe(200);
    expect((await state()).chat.receive.status).toBe('disconnected');
    await until(() => twitch.sessions, (x) => x.length === 0);
  });

  it('parses Twitch’s chat event defensively and drops messages from other channels in a shared chat', () => {
    const at = '2026-10-29T12:00:00.000Z';
    const base = {
      broadcaster_user_id: '1',
      chatter_user_id: '2',
      chatter_user_login: 'viewer',
      chatter_user_name: 'Viewer',
      message_id: 'abc-123',
      message: { text: 'hi' },
      badges: [{ set_id: 'founder', id: '0', info: '14' }, { set_id: 'Bad Badge!' }],
      color: 'red',
    };
    expect(parseTwitchChatMessage(base, at)).toMatchObject({ content: 'hi', badgeTypes: ['founder'], subscriberMonths: 14, senderColor: null });
    expect(parseTwitchChatMessage({ ...base, source_broadcaster_user_id: '1' }, at)).not.toBeNull();
    expect(parseTwitchChatMessage({ ...base, source_broadcaster_user_id: '77' }, at)).toBeNull();
    expect(parseTwitchChatMessage({ ...base, chatter_user_id: 'x' }, at)).toBeNull();
    expect(parseTwitchChatMessage({ ...base, message: {} }, at)).toBeNull();
    expect(parseTwitchChatMessage(null, at)).toBeNull();
  });
});

describe('sending chat', () => {
  it('sends as the main account to its channel, only when Twitch confirms it, and audits it', async () => {
    await liveChat();
    const res = await send('Hello from CONDUIT!');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, as: 'Retrolive', channel: 'retrolive' });
    expect(twitch.sentChat).toEqual([{ broadcasterId: streamer.id, senderId: streamer.id, message: 'Hello from CONDUIT!' }]);
    expect(auditActions(h).map((a) => a.action)).toContain('twitch.chat.sent');

    expect((await send('two')).status).toBe(429); // CONDUIT's own spacing
    h.clock.advance(2000);
    twitch.dropNextChat = 'Your message wasn’t posted because the chat is in followers-only mode.';
    const dropped = await send('three');
    expect(dropped.status).toBe(409);
    expect(dropped.body.error?.message).toMatch(/Twitch didn't post the message: .*followers-only/);
    expect((await send('two\nlines')).status).toBe(400);
  });

  it('a separate bot account sends instead; the main account then isn’t asked to send', async () => {
    await liveChat();
    expect((await call<TwitchSetupState>('POST', '/api/twitch/chatbot', { mode: 'separate' })).body.scopes.primary).toEqual(['user:read:chat']);
    expect((await state()).chat.send.problem).toMatch(/Add or reconnect the bot account/);
    await connect(botAccount, 'bot');
    const s = await state();
    expect(s.bot).toMatchObject({ status: 'connected', name: 'Retrobot', scopes: ['user:write:chat'] });
    expect(s.chatbot).toMatchObject({ mode: 'separate', account: 'bot', ready: true });
    expect((await send('from the bot')).body).toMatchObject({ as: 'Retrobot', channel: 'retrolive' });
    expect(twitch.sentChat.at(-1)).toEqual({ broadcasterId: streamer.id, senderId: botAccount.id, message: 'from the bot' });
  });

  it('the same Twitch account can’t be both the main and the bot account', async () => {
    await liveChat();
    await call('POST', '/api/twitch/chatbot', { mode: 'separate' });
    await connect(streamer, 'bot', 400);
    const s = await state();
    expect(s.bot.status).toBe('not_connected');
    expect(s.primary.status).toBe('connected');
  });
});

describe('Twitch custom commands', () => {
  const create = (body: Record<string, unknown>) => call<CustomCommandView>('POST', '/api/commands/twitch', body);
  const hub = async () => (await call<CommandsHubState>('GET', '/api/commands/twitch')).body;

  it('are stored per platform (the same trigger may exist on Kick) and answer in chat with variables', async () => {
    const res = await create({ trigger: '!hello', response: 'Hi {user}, welcome to {channel}! ({platform})' });
    expect(res.status).toBe(201);
    expect((await call('POST', '/api/commands/kick', { trigger: '!hello', response: 'Kick hello' })).status).toBe(201);
    expect((await create({ trigger: '!hello', response: 'again' })).status).toBe(409);
    expect((await create({ trigger: '!bad', response: '!so someone' })).body.error?.issues?.[0]?.message).toMatch(/Twitch response can’t start with "!"/);
    expect((await create({ trigger: '!vars', response: '{mention}' })).body.error?.issues?.[0]?.message).toMatch(/isn’t a variable for Twitch commands/);
    expect((await hub()).ready).toMatchObject({ ok: false });

    await liveChat();
    expect((await hub()).ready).toMatchObject({ ok: true, sendAs: 'Retrolive', channel: 'retrolive' });
    twitch.chat(streamer, viewer, '!HELLO there');
    await until(() => twitch.sentChat, (x) => x.length === 1);
    expect(twitch.sentChat[0]!.message).toBe('Hi Viewer, welcome to retrolive! (Twitch)');
    // CONDUIT's own reply comes back through chat and is never answered.
    await new Promise((r) => setTimeout(r, 100));
    expect(twitch.sentChat).toHaveLength(1);
    expect((await hub()).recent[0]).toMatchObject({ trigger: '!hello', outcome: 'sent' });
  });

  it('check Twitch badges for permissions, and keep cooldowns', async () => {
    await create({ trigger: '!modonly', response: 'mods rule', permission: 'moderator' });
    await create({ trigger: '!subs', response: 'subs rule', permission: 'subscriber', cooldownMode: 'global', cooldownSeconds: 60 });
    await liveChat();

    twitch.chat(streamer, viewer, '!modonly');
    await until(hub, (s) => s.recent.length === 1);
    expect((await hub()).recent[0]).toMatchObject({ trigger: '!modonly', outcome: 'blocked', detail: 'Not allowed: moderators only.' });

    twitch.chat(streamer, mod, '!modonly', { badges: [{ set_id: 'moderator' }] });
    await until(() => twitch.sentChat, (x) => x.length === 1);
    twitch.chat(streamer, viewer, '!subs', { badges: [{ set_id: 'founder', info: '3' }] });
    await until(() => twitch.sentChat, (x) => x.length === 2);
    twitch.chat(streamer, mod, '!subs', { badges: [{ set_id: 'moderator' }] });
    await until(hub, (s) => s.recent.some((r) => r.outcome === 'blocked' && /cooldown/.test(r.detail ?? '')));
    expect(twitch.sentChat.map((m) => m.message)).toEqual(['mods rule', 'subs rule']);
  });

  it('use your Twitch stream for stream variables, and never reply to the bot account', async () => {
    twitch.live.set('retrolive', { started_at: '2026-01-01T10:00:00.000Z', title: 'Speedrun night', game_name: 'Retro Game', viewer_count: 42 });
    await create({ trigger: '!stream', response: '{streamer} is playing {category}: {title} ({viewers} watching, up {uptime}) {url}' });
    await liveChat();
    await call('POST', '/api/twitch/chatbot', { mode: 'separate' });
    await connect(botAccount, 'bot');
    twitch.chat(streamer, botAccount, '!stream');
    twitch.chat(streamer, viewer, '!stream');
    await until(() => twitch.sentChat, (x) => x.length === 1);
    expect(twitch.sentChat[0]).toEqual({
      broadcasterId: streamer.id,
      senderId: botAccount.id,
      message: 'Retrolive is playing Retro Game: Speedrun night (42 watching, up 2 hours) https://twitch.tv/retrolive',
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(twitch.sentChat).toHaveLength(1);
  });
});

describe('Twitch timed messages', () => {
  const timed = async () => (await call<TimedMessagesState>('GET', '/api/timed-messages')).body;

  it('post in Twitch chat after N messages from people (CONDUIT’s own posts don’t count)', async () => {
    const created = await call<TimedMessageView>('POST', '/api/timed-messages', { platform: 'twitch', name: 'Socials', enabled: true, content: 'Follow us on Discord!', messageCount: 5, intervalMinutes: null });
    expect(created.status).toBe(201);
    expect(created.body.destination).toBe('Your Twitch chat');
    expect((await call('POST', '/api/timed-messages', { platform: 'twitch', name: 'Bad', content: '/ban someone', messageCount: 5 })).status).toBe(400);

    await liveChat();
    expect((await timed()).twitch).toEqual({ ready: true, problem: null, channel: 'retrolive' });
    for (let i = 0; i < 5; i++) twitch.chat(streamer, viewer, `message ${i}`);
    await until(() => twitch.sentChat, (x) => x.length === 1);
    expect(twitch.sentChat[0]!.message).toBe('Follow us on Discord!');
    const t = await until(timed, (s) => s.timedMessages[0]!.recent.length === 1);
    expect(t.timedMessages[0]).toMatchObject({ destination: 'retrolive’s Twitch chat', messagesSince: 0 });
    expect(t.timedMessages[0]!.recent[0]).toMatchObject({ ok: true, reason: 'messages', detail: 'Posted in retrolive’s Twitch chat.' });
  });
});
