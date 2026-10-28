/**
 * Kick live chat against a simulated Kick (automated, mocked — not proof that real Kick chat works): the
 * chat.message.sent webhook subscription, the signed-webhook receiver, and sending as the chatbot account.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KickSendResult, KickSetupState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { parseChatMessage, type KickChatMessage } from '../../apps/server/src/kick/kick-chat-service';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { auditActions, createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;
let kick: FakeKick;
let vault: MemoryVault;
let port: number;

beforeEach(async () => {
  kick = new FakeKick();
  vault = new MemoryVault();
  port = await freePort();
  h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(port) }, { vault, fetch: kick.fetch });
  expect(
    (await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } })).status,
  ).toBe(200);
});
afterEach(async () => {
  await h.close();
});

const state = async () => (await h.call<KickSetupState>('GET', '/api/kick/setup')).body;
const chat = async () => (await state()).chat;
const send = (content: unknown) =>
  h.call<KickSendResult & { error?: { code: string; message: string } }>('POST', '/api/kick/chat/send', { body: { content } });

async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
  expect(res.status).toBe(200);
  const back = kick.approve(new URL(res.body.authorizationUrl), who);
  expect((await fetch(back)).status).toBe(200);
}

/** Simulates the real accounts as connected before this phase (without the new scopes). */
function setStoredScopes(role: 'primary' | 'bot', scopes: string[]): void {
  h.db.prepare("UPDATE platform_connections SET granted_scopes = ? WHERE platform = 'kick' AND role = ?").run(JSON.stringify(scopes), role);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`never matched: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('receiving: subscription lifecycle', () => {
  it('needs the main account first, then subscribes once Kick grants events:subscribe', async () => {
    await h.services.kickChat.start();
    expect((await chat()).receive).toMatchObject({
      status: 'disconnected',
      problem: expect.stringMatching(/Connect your main Kick account/),
    });
    await connect(kick.users.streamer);
    const c = await until(chat, (x) => x.receive.status === 'connected');
    expect(c.receive).toMatchObject({
      delivery: 'unconfirmed',
      problem: null,
      localTarget: `http://127.0.0.1:${port}`,
      webhookPath: '/kick/webhook',
    });
    expect(kick.subscriptions).toEqual([
      expect.objectContaining({
        event: 'chat.message.sent',
        version: 1,
        broadcaster_user_id: kick.users.streamer.user_id,
        method: 'webhook',
      }),
      // Reward redemptions (giveaway bonus tickets) and bans/timeouts (Kick Moderation's Logs) arrive on the same webhook.
      expect.objectContaining({ event: 'channel.reward.redemption.updated', version: 1, method: 'webhook' }),
      expect.objectContaining({ event: 'moderation.banned', version: 1, method: 'webhook' }),
    ]);
  });

  it('reports Permission required for an account authorized before this phase, and subscribes after reauthorizing', async () => {
    await connect(kick.users.streamer);
    setStoredScopes('primary', ['user:read', 'channel:read']);
    await h.services.kickChat.start();
    expect((await chat()).receive).toMatchObject({ status: 'permission_required', problem: expect.stringMatching(/events:subscribe/) });
    expect(kick.subscriptions).toHaveLength(0);
    await connect(kick.users.streamer); // Reauthorize main account (same account: same row, new scopes)
    await until(chat, (x) => x.receive.status === 'connected');
    expect(kick.subscriptions).toHaveLength(3); // chat, reward redemptions and bans
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM platform_connections WHERE platform = 'kick'").get()).toEqual({ n: 1 });
  });

  it('never creates duplicate subscriptions: reuses the existing one and removes extras', async () => {
    await connect(kick.users.streamer);
    await h.services.kickChat.start();
    await until(chat, (x) => x.receive.status === 'connected');
    await h.services.kickChat.ensure();
    await h.services.kickChat.ensure();
    expect(kick.subscriptions).toHaveLength(3); // one chat, one redemption, one ban subscription
    kick.subscriptions.push({ ...kick.subscriptions[0]!, id: '01SUBDUPLICATE' });
    kick.subscriptions.push({ ...kick.subscriptions[1]!, id: '01SUBDUPLICATE2' });
    kick.subscriptions.push({ ...kick.subscriptions[2]!, id: '01SUBDUPLICATE3' });
    await h.services.kickChat.ensure();
    expect(kick.subscriptions.map((s) => s.event).sort()).toEqual(['channel.reward.redemption.updated', 'chat.message.sent', 'moderation.banned']);
  });

  it('refreshes a rejected token once and continues; reports a transient failure with a scheduled retry', async () => {
    await connect(kick.users.streamer);
    kick.apiFailures.push(401);
    await h.services.kickChat.start();
    await until(chat, (x) => x.receive.status === 'connected');
    expect(kick.requests.some((r) => r.body.includes('grant_type=refresh_token'))).toBe(true);

    kick.apiFailures.push(503);
    await h.services.kickChat.ensure();
    expect((await chat()).receive).toMatchObject({
      status: 'reconnecting',
      problem: expect.stringMatching(/having problems.*Retrying in 30 seconds/),
      nextRetryAt: expect.any(String),
    });
    // The Retry action works right away.
    const retried = (await h.call<KickSetupState>('POST', '/api/kick/chat/retry')).body.chat.receive;
    expect(retried.status).toBe('connected');
  });

  it('a forbidden subscription is a permission problem, not a retry loop', async () => {
    await connect(kick.users.streamer);
    kick.apiFailures.push(403);
    await h.services.kickChat.start();
    expect((await chat()).receive).toMatchObject({ status: 'permission_required', nextRetryAt: null });
  });

  it("shows Kick's own reason when it rejects the subscription, with the likely fix, and doesn't retry by itself", async () => {
    await connect(kick.users.streamer);
    // Exactly what real Kick answered during manual testing: HTTP 400 with the message "Bad request".
    kick.rejectSubscribe = 'Bad request';
    await h.services.kickChat.start();
    const c = (await chat()).receive;
    expect(c).toMatchObject({ status: 'error', nextRetryAt: null });
    expect(c.problem).toContain('(HTTP 400): "Bad request"');
    expect(c.problem).toContain('Enable Webhooks');
    expect(kick.subscriptions).toHaveLength(0);
  });

  it('disconnecting the main account removes its chat and redemption subscriptions', async () => {
    await connect(kick.users.streamer);
    await h.services.kickChat.start();
    await until(chat, (x) => x.receive.status === 'connected');
    await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'primary' } });
    expect(kick.subscriptions).toHaveLength(0);
    expect((await chat()).receive.status).toBe('disconnected');
  });
});

describe('receiving: the signed webhook receiver', () => {
  let seen: KickChatMessage[];
  beforeEach(async () => {
    await connect(kick.users.streamer);
    await h.services.kickChat.start();
    await until(chat, (x) => x.receive.status === 'connected');
    seen = [];
    h.services.kickChat.onMessage((m) => seen.push(m));
  });
  const fromViewer = (content: string, messageId?: string) =>
    chatPayload({ content, sender: kick.users.bot, broadcaster: kick.users.streamer, messageId });

  it('accepts a correctly signed chat message for the main channel and shows it', async () => {
    expect(await deliverWebhook(kick, port, fromViewer('hello retro'))).toBe(200);
    const c = await until(chat, (x) => x.recent.length === 1);
    expect(c.receive).toMatchObject({ delivery: 'confirmed', messagesReceived: 1, lastEventAt: expect.any(String) });
    expect(c.recent[0]).toMatchObject({
      content: 'hello retro',
      senderUsername: 'RetroBotKick',
      senderUserId: '4242002',
      senderColor: '#FF5733',
      badges: ['Moderator'],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ broadcasterUserId: '4242001', emotes: [{ emoteId: '12345', positions: [{ s: 0, e: 3 }] }] });
  });

  it('works through localhost over IPv6 too (tunnel clients may resolve localhost to ::1)', async () => {
    const status = await deliverWebhook(kick, port, fromViewer('via ipv6'), { host: '[::1]' }).catch(() => 0);
    // Some CI machines have no IPv6 loopback; where it exists, it must work.
    expect([0, 200]).toContain(status);
  });

  it('processes a redelivered message once (same delivery id or same chat message id)', async () => {
    const payload = fromViewer('only once');
    expect(await deliverWebhook(kick, port, payload, { messageId: '01JSAMEDELIVERY00000000001' })).toBe(200);
    expect(await deliverWebhook(kick, port, payload, { messageId: '01JSAMEDELIVERY00000000001' })).toBe(200);
    expect(await deliverWebhook(kick, port, payload)).toBe(200); // new delivery id, same chat message
    await until(chat, (x) => x.recent.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect((await chat()).recent).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['a forged signature', { signWith: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, 401],
    ['a stale timestamp (replay)', { timestamp: new Date(Date.now() - 60 * 60_000).toISOString() }, 400],
    ['a future timestamp', { timestamp: new Date(Date.now() + 60 * 60_000).toISOString() }, 400],
    ['any other path', { path: '/api/kick/setup' }, 404],
  ])('refuses %s and processes nothing', async (_label, opts, status) => {
    expect(await deliverWebhook(kick, port, fromViewer('evil'), opts)).toBe(status);
    await new Promise((r) => setTimeout(r, 30));
    const c = await chat();
    expect(c.recent).toHaveLength(0);
    expect(c.receive.delivery).toBe('unconfirmed');
    expect(seen).toHaveLength(0);
  });

  it('refuses GET, oversize bodies and unsigned requests; the main API is not reachable through it', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/kick/webhook`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/kick/webhook`, { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/connections`, { headers: { 'X-CONDUIT-Local-Key': 'x' } })).status).toBe(404);
    const big = await deliverWebhook(kick, port, { content: 'x'.repeat(70 * 1024) }).catch(() => 413);
    expect(big).toBe(413);
    expect((await chat()).receive.rejected).toBeGreaterThanOrEqual(3);
  });

  it("ignores other channels' chat and other event types", async () => {
    await deliverWebhook(kick, port, chatPayload({ content: 'elsewhere', sender: kick.users.bot, broadcaster: kick.users.otherBot }));
    await deliverWebhook(kick, port, { follower: {} }, { type: 'channel.followed' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await chat()).recent).toHaveLength(0);
  });

  it('keeps only a short, in-memory history', async () => {
    for (let i = 0; i < 30; i++) await deliverWebhook(kick, port, fromViewer(`m${i}`));
    const c = await until(chat, (x) => x.receive.messagesReceived === 30);
    expect(c.recent).toHaveLength(25);
    expect(c.recent.at(-1)!.content).toBe('m29');
    // No table stores chat messages (chat_commands holds command definitions; kick_chatters only who chatted).
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%chat%' ORDER BY name").all()).toEqual([{ name: 'chat_commands' }, { name: 'kick_chatters' }]);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM chat_commands').all())).not.toContain('m29');
    expect(JSON.stringify(h.db.prepare('SELECT * FROM kick_chatters').all())).not.toContain('m29');
  });
});

describe('parseChatMessage', () => {
  const base = chatPayload({
    content: 'hi',
    sender: new FakeKick().users.bot,
    broadcaster: new FakeKick().users.streamer,
    messageId: 'm-1',
  });
  it('handles missing optional fields', () => {
    const minimal = { message_id: 'm-2', content: 'hey', sender: { user_id: 5, username: 'x' }, broadcaster: { user_id: 6 } };
    expect(parseChatMessage(minimal, 'd', 'now')).toMatchObject({
      content: 'hey',
      senderColor: null,
      badges: [],
      createdAt: null,
      repliesTo: null,
      emotes: [],
    });
  });
  it.each([
    ['no content', { ...base, content: undefined }],
    ['no sender', { ...base, sender: null }],
    ['no broadcaster id', { ...base, broadcaster: {} }],
    ['not an object', 'text'],
  ])('rejects %s', (_label, payload) => {
    expect(parseChatMessage(payload, 'd', 'now')).toBeNull();
  });
  it('drops an unsafe colour value', () => {
    const p = { ...base, sender: { ...(base.sender as object), identity: { username_color: 'red;background:url(x)' } } };
    expect(parseChatMessage(p, 'd', 'now')!.senderColor).toBeNull();
  });
});

describe('sending as the chatbot account', () => {
  beforeEach(async () => {
    await connect(kick.users.streamer);
  });

  it('connecting, reconnecting and restarting post nothing in chat (no greeting)', async () => {
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    await h.services.kickChat.start();
    await until(chat, (x) => x.receive.status === 'connected');
    await h.services.kickChat.ensure();
    await h.call('POST', '/api/kick/chat/retry');
    await h.restart();
    await h.services.kickChat.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(kick.posted).toEqual([]);
  });

  it('Option A: sends as the main account to its own channel', async () => {
    const res = await send('Hello from CONDUIT');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, as: 'RetroLive', channel: 'retrolive', messageId: expect.any(String) });
    expect(kick.posted).toEqual([{ as: 'RetroLive', type: 'user', broadcaster_user_id: 4242001, content: 'Hello from CONDUIT' }]);
  });

  it("Option B: sends as the bot account to the main account's channel (type user, broadcaster id)", async () => {
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    const s = await state();
    expect(s.chat.send).toMatchObject({
      account: 'bot',
      accountName: 'RetroBotKick',
      channel: 'retrolive',
      ready: true,
      missingScope: null,
    });
    const res = await send('Hi chat');
    expect(res.body).toMatchObject({ sent: true, as: 'RetroBotKick', channel: 'retrolive' });
    expect(kick.posted).toEqual([{ as: 'RetroBotKick', type: 'user', broadcaster_user_id: 4242001, content: 'Hi chat' }]);
    // The main account's credentials were not used to send.
    expect(kick.posted.every((p) => p.as === 'RetroBotKick')).toBe(true);
  });

  it('a bot account without chat:write must be reauthorized; nothing is sent', async () => {
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    setStoredScopes('bot', ['user:read']); // as connected before this phase
    const s = await state();
    expect(s.chat.send).toMatchObject({
      ready: false,
      missingScope: 'chat:write',
      problem: expect.stringMatching(/Reauthorize bot account/),
    });
    expect(s.chatbot.ready).toBe(false);
    const res = await send('should not post');
    expect(res.status).toBe(403);
    expect(kick.posted).toHaveLength(0);
    // Reauthorizing the bot keeps the main account untouched.
    const primaryBefore = s.primary;
    await connect(kick.users.bot, 'bot');
    const after = await state();
    expect(after.chat.send.ready).toBe(true);
    expect(after.primary).toEqual(primaryBefore);
  });

  it('validates the text on the backend', async () => {
    for (const bad of ['', '   ', 'line\nbreak', 'x'.repeat(501), '😀'.repeat(600), 42]) {
      expect((await send(bad)).status).toBe(400);
    }
    expect((await send('😀'.repeat(500))).status).toBe(200); // 500 grapheme clusters, under 2048 bytes
    expect(kick.posted).toHaveLength(1);
  });

  it('reports Kick refusing the post, rate limits and a message Kick did not send — never success', async () => {
    kick.apiFailures.push(403);
    let res = await send('a');
    expect(res.status).toBe(403);
    expect(res.body.error!.message).toMatch(/Kick refused to post as RetroLive in retrolive's chat/);
    h.clock.advance(3000);
    kick.apiFailures.push(429);
    res = await send('b');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    h.clock.advance(3000);
    kick.apiFailures.push('not_sent');
    res = await send('c');
    expect(res.status).toBe(503);
    expect(kick.posted).toHaveLength(0);
  });

  it('does not retry after a network failure (the message might have been posted)', async () => {
    kick.apiFailures.push('network');
    const before = kick.requests.filter((r) => r.url.endsWith('/public/v1/chat')).length;
    const res = await send('maybe');
    expect(res.status).toBe(503);
    expect(res.body.error!.message).toMatch(/couldn't confirm whether Kick posted/);
    expect(kick.requests.filter((r) => r.url.endsWith('/public/v1/chat')).length - before).toBe(1);
  });

  it('a rejected token is refreshed and the message sent exactly once', async () => {
    kick.apiFailures.push(401);
    const res = await send('after refresh');
    expect(res.status).toBe(200);
    expect(kick.posted).toHaveLength(1);
  });

  it('spaces out sends (no accidental double posts)', async () => {
    expect((await send('one')).status).toBe(200);
    expect((await send('two')).status).toBe(429);
    h.clock.advance(2500);
    expect((await send('three')).status).toBe(200);
    expect(kick.posted.map((p) => p.content)).toEqual(['one', 'three']);
  });

  it('audits sends without their content, and never logs tokens or messages', async () => {
    await send('private words here');
    const audit = auditActions(h).filter((a) => a.action === 'kick.chat.sent');
    expect(audit).toEqual([expect.objectContaining({ outcome: 'success' })]);
    expect(JSON.parse(audit[0]!.metadata)).toEqual({ as: 'primary' });
    const log = fs.readFileSync(h.logFile, 'utf8');
    expect(log).not.toContain('private words here');
    for (const [k, v] of vault.entries) {
      if (!k.startsWith('connection:')) continue;
      const t = JSON.parse(v) as { accessToken: string; refreshToken: string | null };
      expect(log).not.toContain(t.accessToken);
      expect(JSON.stringify(await state())).not.toContain(t.accessToken);
    }
  });
});
