/**
 * Kick default commands (!uptime, !so, !timeout, !addcom, !settitle…) against a simulated Kick (automated, mocked —
 * not proof of live Kick behaviour): triggered by signed webhook deliveries through the chat feed, answered by the
 * chatbot account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandsHubState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;
let kick: FakeKick;
let port: number;
let kickWeb: Record<string, unknown>;

const TROLL: FakeKickUser = { user_id: 4242099, name: 'Troll', slug: 'troll', profile_picture: null };
const COOL: FakeKickUser = { user_id: 4242098, name: 'CoolStreamer', slug: 'coolstreamer', profile_picture: null };
const VIEWER: FakeKickUser = { user_id: 4242097, name: 'Viewer', slug: 'viewer', profile_picture: null };

beforeEach(async () => {
  kick = new FakeKick();
  port = await freePort();
  kickWeb = {};
  h = await createHarness(
    { CONDUIT_KICK_WEBHOOK_PORT: String(port) },
    {
      vault: new MemoryVault(),
      fetch: kick.fetch,
      kickWebFetch: async (url) => (url in kickWeb ? new Response(JSON.stringify(kickWeb[url]), { status: 200 }) : new Response('not found', { status: 404 })),
    },
  );
  await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
  for (const [who, role] of [
    [kick.users.streamer, 'primary'],
    [kick.users.bot, 'bot'],
  ] as const) {
    if (role === 'bot') await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
    expect((await fetch(kick.approve(new URL(res.body.authorizationUrl), who))).status).toBe(200);
  }
  await h.services.kickChat.start();
  for (const u of [TROLL, COOL, VIEWER]) kick.directory.set(u.slug, u);
});
afterEach(async () => {
  await h.close();
});

/** Someone writes in chat: a moderator by default, or a viewer without badges. */
const say = (content: string, o: { from?: FakeKickUser; mod?: boolean } = {}) =>
  deliverWebhook(kick, port, chatPayload({ content, sender: o.from ?? VIEWER, broadcaster: kick.users.streamer, badges: o.mod === false ? [] : undefined }));
/** Waits until the chatbot has posted this many messages in total; returns what it posted. */
async function posts(n: number): Promise<string[]> {
  const end = Date.now() + 2000;
  while (kick.posted.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 40));
  return kick.posted.map((p) => p.content);
}
const hub = async () => (await h.call<CommandsHubState>('GET', '/api/commands/kick')).body;

describe('everyone’s commands', () => {
  it('!uptime answers from your channel; offline is said plainly', async () => {
    await say('!uptime', { mod: false });
    expect(await posts(1)).toEqual(['RetroLive is offline right now.']);
    kick.live.set('retrolive', { startTime: new Date(h.clock.now().getTime() - (2 * 3600 + 5 * 60) * 1000).toISOString(), title: 'Speedruns!', category: 'Minecraft' });
    h.clock.advance(60_000); // past the shared cooldown and the stream cache
    await say('!uptime', { mod: false });
    const all = await posts(2);
    expect(all[1]).toMatch(/^RetroLive has been live for 2 hours 6 minutes\.$/);
    expect(kick.posted.every((p) => p.as === 'RetroBotKick')).toBe(true);
  });

  it('everyone’s commands share a short cooldown so chat isn’t flooded', async () => {
    await say('!uptime', { mod: false });
    await say('!uptime', { mod: false });
    expect(await posts(2)).toHaveLength(1);
    expect((await hub()).recent).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: '!uptime', outcome: 'blocked', detail: expect.stringMatching(/On cooldown/) })]));
  });

  it('!followage for yourself or someone else; !commands lists what everyone can use', async () => {
    kickWeb['https://kick.com/api/v2/channels/retrolive/users/viewer'] = { following_since: new Date(h.clock.now().getTime() - 40 * 86_400_000).toISOString() };
    kickWeb['https://kick.com/api/v2/channels/retrolive/users/troll'] = { following_since: null };
    await say('!followage', { mod: false });
    await say('!commands', { mod: false });
    expect(await posts(2)).toEqual(['Viewer has followed RetroLive for 1 month 10 days.', expect.stringMatching(/^Commands: !enter, !commands, !uptime, !followage$/)]);
    h.clock.advance(60_000);
    await say('!followage @troll', { mod: false });
    expect((await posts(3))[2]).toBe('troll isn’t following RetroLive.');
  });
});

describe('!clip', () => {
  it('isn’t a CONDUIT command (Kick’s own /clip makes clips; Kick → Clips posts them)', async () => {
    await say('!clip 60', { mod: false });
    expect(await posts(0)).toEqual([]);
    expect((await hub()).defaults.find((d) => d.trigger === '!clip')).toBeUndefined();
  });
});

describe('moderator commands', () => {
  it('!ping: the chatbot answers moderators and you, to check it’s connected; viewers get nothing', async () => {
    await say('!ping', { mod: false });
    expect(await posts(1)).toEqual([]);
    await say('!ping');
    await say('!PING', { from: kick.users.streamer, mod: false });
    expect(await posts(2)).toEqual(['Pong! I’m connected and ready!', 'Pong! I’m connected and ready!']);
    expect(kick.posted.every((p) => p.as === 'RetroBotKick')).toBe(true);
  });

  it('viewers can’t use them (nothing is posted); !so shouts out with the channel’s category', async () => {
    await say('!so @coolstreamer', { mod: false });
    expect(await posts(1)).toEqual([]);
    kick.live.set('coolstreamer', { startTime: new Date().toISOString(), category: 'Just Chatting' });
    await say('!so @CoolStreamer');
    await say('!so @nobodyhere');
    expect(await posts(2)).toEqual(['Go check out coolstreamer at kick.com/coolstreamer! They’re live now with Just Chatting!', 'I couldn’t find a Kick channel called nobodyhere.']);
  });

  it('!timeout, !ban and !unban act with the main account and are recorded as "<moderator> via !command"', async () => {
    await say('!timeout @troll 5 spamming links');
    await say('!ban troll');
    await say('!unban @troll');
    await say('!timeout @retrolive');
    expect(await posts(4)).toEqual(['troll is timed out for 5 minutes.', 'troll is banned.', 'troll is unbanned.', 'The channel owner can’t be moderated.']);
    const history = (await h.call<{ history: Array<{ action: string; actor: string; reason: string | null; durationSeconds: number | null }> }>('GET', '/api/moderation')).body.history;
    expect(history.filter((r) => r.actor === 'Viewer via !timeout')).toEqual([expect.objectContaining({ action: 'timeout', reason: 'spamming links', durationSeconds: 300 })]);
    expect(history.some((r) => r.actor === 'Viewer via !ban')).toBe(true);
  });

  it('!addcom, !editcom and !delcom manage custom commands (same checks as the Commands page)', async () => {
    await say('!addcom !discord Join us at discord.gg/retro');
    await say('!discord', { mod: false });
    await say('!editcom discord Our Discord: discord.gg/retro2');
    await say('!addcom !bad !nested');
    await say('!delcom !discord');
    await say('!delcom !discord');
    expect(await posts(6)).toEqual([
      'Added !discord.',
      'Join us at discord.gg/retro',
      'Updated !discord.',
      expect.stringMatching(/^Couldn’t add !bad: .*can’t start with "!" or "\/"/),
      'Deleted !discord.',
      'There’s no custom !discord.',
    ]);
  });

  it('a custom command with the same trigger answers instead; a switched-off default is silent', async () => {
    await h.call('POST', '/api/commands/kick', { body: { trigger: '!uptime', response: 'My own uptime reply' } });
    await say('!uptime', { mod: false });
    expect(await posts(1)).toEqual(['My own uptime reply']);
    expect((await hub()).defaults.find((d) => d.trigger === '!uptime')).toMatchObject({ enabled: true, inactiveReason: 'Your custom !uptime answers instead' });
    const saved = await h.call<CommandsHubState>('POST', '/api/kick/default-commands', { body: { disabled: ['!followage'] } });
    expect(saved.body.defaults.find((d) => d.trigger === '!followage')).toMatchObject({ enabled: false });
    await say('!followage', { mod: false });
    expect(await posts(2)).toHaveLength(1);
    expect((await h.call('POST', '/api/kick/default-commands', { body: { disabled: ['!nope'] } })).status).toBe(400);
  });

  it('!title shows or changes your title and !setcategory looks the category up by name (moderators and you only)', async () => {
    await say('!title Viewers can’t do this', { mod: false });
    await say('!title', { mod: false });
    await say('!title');
    await say('!title Chill Sunday stream');
    await say('!setcategory minecraft');
    await say('!setcategory no such game');
    expect(await posts(4)).toEqual(['Title: Offline title', 'Title changed to: Chill Sunday stream', 'Category changed to Minecraft.', 'I couldn’t find a category called no such game.']);
    expect(kick.channelUpdates).toEqual([
      { slug: 'retrolive', stream_title: 'Chill Sunday stream' },
      { slug: 'retrolive', category_id: 28 },
    ]);
  });
});
