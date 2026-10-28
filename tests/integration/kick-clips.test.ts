/**
 * Kick → Clips against a simulated Kick (official API and website) and Discord (automated, mocked — not proof of live
 * Kick or Discord behaviour): the clip list from Kick's website, posting in Discord with the watch buttons, posting new
 * clips by themselves, and saving a clip's video from its HLS byte ranges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KICK_DEFAULT_COMMANDS, type KickClipsState } from '@conduit/shared';
import type { FetchLike } from '../../apps/server/src/app/types';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET } from '../helpers/fake-kick';
import { auditActions, createHarness, freePort, type Harness } from '../helpers/harness';

const GUILD = '42';
const CLIPS = '500000000000000001';
const HIDDEN = '500000000000000002';
const VOD = '36d9b0c6-b1e7-477a-9124-f370c4f10a4e';

let h: Harness;
let kick: FakeKick;
let discord: FakeDiscord;
let gateway: FakeGateway;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST', p: string, body?: unknown) => h.call<T>(method, p, body === undefined ? {} : { body }) as Promise<Res<T>>;
const refresh = async () => (await call<KickClipsState>('POST', '/api/kick/clips/refresh')).body;
const posts = () => [...discord.messages.values()].filter((m) => m.channelId === CLIPS).map((m) => m.body);

/** Kick's website, simulated: the channel's clip list, single clips, and clips.kick.com video. */
const web = {
  clips: [] as Array<Record<string, unknown>>,
  status: 200,
  vod: VOD as string | null,
  playlists: new Map<string, string>(),
  files: new Map<string, Buffer>(),
  requests: [] as string[],
};
const clipId = (n: number) => `clip_01TESTCLIP${String(n).padStart(16, '0')}`;
function clip(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = clipId(n);
  return {
    id,
    title: `Great play ${n}`,
    video_url: `https://clips.kick.com/clips/aa/${id}/playlist.m3u8`,
    thumbnail_url: `https://clips.kick.com/clips/aa/${id}/thumbnail.webp`,
    duration: 30,
    views: 5,
    created_at: new Date(h.clock.now().getTime() - n * 60_000).toISOString(),
    creator: { username: 'BigFan' },
    category: { name: 'Just Chatting' },
    ...over,
  };
}
const webFetch: FetchLike = async (input, init) => {
  const u = new URL(input);
  web.requests.push(`${u.hostname}${u.pathname}`);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'kick.com' && u.pathname === '/api/v2/channels/retrolive/clips') {
    return web.status === 200 ? json({ clips: web.clips, nextCursor: null }) : new Response('{}', { status: web.status });
  }
  const single = /^\/api\/v2\/clips\/(clip_\w+)$/.exec(u.pathname);
  if (u.hostname === 'kick.com' && single) {
    const known = web.clips.find((c) => c.id === single[1]);
    return json({ clip: { ...(known ?? { id: single[1] }), vod: web.vod ? { id: web.vod } : null } });
  }
  if (u.hostname === 'clips.kick.com') {
    const playlist = web.playlists.get(u.pathname);
    if (playlist !== undefined) return new Response(playlist, { status: 200 });
    const file = web.files.get(path.posix.basename(u.pathname));
    if (!file) return new Response('', { status: 404 });
    const range = /^bytes=(\d+)-(\d+)$/.exec(((init?.headers ?? {}) as Record<string, string>).range ?? '');
    return range ? new Response(new Uint8Array(file.subarray(Number(range[1]), Number(range[2]) + 1)), { status: 206 }) : new Response(new Uint8Array(file), { status: 200 });
  }
  return new Response('', { status: 404 });
};

beforeEach(async () => {
  web.clips = [];
  web.status = 200;
  web.vod = VOD;
  web.playlists.clear();
  web.files.clear();
  web.requests = [];
  kick = new FakeKick();
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: CLIPS, name: 'clips' },
    { id: HIDDEN, name: 'hidden' },
  ]);
  discord.channels.get(GUILD)!.find((c) => c.id === HIDDEN)!.permission_overwrites.push({ id: GUILD, type: 0, allow: '0', deny: String(1n << 10n) });
  const both: FetchLike = (input, init) => (String(input).includes('kick.com') ? kick.fetch(input, init) : discord.fetch(input, init));
  h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(await freePort()) }, { vault: new MemoryVault(), fetch: both, botFactory: gateway.factory, kickWebFetch: webFetch });
  await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role: 'primary' } });
  expect((await fetch(kick.approve(new URL(res.body.authorizationUrl), kick.users.streamer))).status).toBe(200);
});
afterEach(async () => {
  await h.close();
});

describe('Kick → Clips', () => {
  it('lists the channel’s clips from Kick’s website, newest first, and keeps them listed; says when Kick refuses', async () => {
    web.clips = [clip(1), clip(2), clip(3, { video_url: 'https://evil.example/clip.m3u8' })];
    let s = await refresh();
    expect(s.channel).toEqual({ slug: 'retrolive', name: 'RetroLive' });
    expect(s.clips.map((c) => [c.title, c.creatorName, c.category, c.durationSeconds, c.url])).toEqual([
      ['Great play 1', 'BigFan', 'Just Chatting', 30, `https://kick.com/retrolive/clips/${clipId(1)}`],
      ['Great play 2', 'BigFan', 'Just Chatting', 30, `https://kick.com/retrolive/clips/${clipId(2)}`],
    ]); // the clip whose video isn't on clips.kick.com is left out
    expect(s.lastCheck?.problem).toBeNull();

    // Kick refuses later: the list stays, and the page says why.
    web.status = 403;
    s = await refresh();
    expect(s.clips).toHaveLength(2);
    expect(s.lastCheck?.problem).toMatch(/refused the request \(HTTP 403\)/);
  });

  it('posts a clip in Discord: embed and buttons — the VOD while offline, the stream while live', async () => {
    web.clips = [clip(1)];
    await refresh();
    // A channel is needed, and the bot must be able to post there.
    expect((await call('POST', `/api/kick/clips/${clipId(1)}/post`)).status).toBe(400);
    const hidden = await call('POST', '/api/kick/clips', { guildId: GUILD, channelId: HIDDEN, autoPost: false, folder: null });
    expect(hidden.status).toBe(400);
    expect(hidden.body.error?.issues?.[0]).toMatchObject({ path: 'channelId', message: expect.stringMatching(/needs View Channel/) });
    expect((await call('POST', '/api/kick/clips', { guildId: GUILD, channelId: CLIPS, autoPost: false, folder: null })).status).toBe(200);
    expect(auditActions(h).some((a) => a.action === 'kick_clips.updated')).toBe(true);

    const posted = await call<KickClipsState>('POST', `/api/kick/clips/${clipId(1)}/post`);
    expect(posted.status).toBe(200);
    expect(posted.body.clips[0]!.posted).toMatchObject({ channelId: CLIPS });
    const [offline] = posts();
    expect(offline.embeds[0]).toMatchObject({
      title: 'Great play 1',
      url: `https://kick.com/retrolive/clips/${clipId(1)}`,
      author: { name: 'RetroLive', url: 'https://kick.com/retrolive' },
      image: { url: `https://clips.kick.com/clips/aa/${clipId(1)}/thumbnail.webp` },
      fields: [
        { name: 'Clipped by', value: 'BigFan', inline: true },
        { name: 'Category', value: 'Just Chatting', inline: true },
        { name: 'Length', value: '30 s', inline: true },
      ],
    });
    expect(offline.components[0].components).toEqual([
      { type: 2, style: 5, label: 'Watch VOD', url: `https://kick.com/retrolive/videos/${VOD}` },
      { type: 2, style: 5, label: 'View clip on Kick', url: `https://kick.com/retrolive/clips/${clipId(1)}` },
    ]);
    expect(offline.allowed_mentions).toEqual({ parse: [] });

    kick.live.set('retrolive', { startTime: new Date().toISOString(), title: 'Live!', category: 'Just Chatting' });
    await call('POST', `/api/kick/clips/${clipId(1)}/post`);
    expect(posts()[1].components[0].components[0]).toEqual({ type: 2, style: 5, label: 'Watch stream', url: 'https://kick.com/retrolive' });
    expect((await call('POST', '/api/kick/clips/clip_01UNKNOWNCLIPID0000000000/post')).status).toBe(404);
  });

  it('posts new clips by themselves once switched on — never the backlog, never twice', async () => {
    web.clips = [clip(1), clip(2)];
    await refresh();
    const on = await call('POST', '/api/kick/clips', { guildId: GUILD, channelId: null, autoPost: true, folder: null });
    expect(on.status).toBe(400); // needs a channel
    expect((await call('POST', '/api/kick/clips', { guildId: GUILD, channelId: CLIPS, autoPost: true, folder: null })).status).toBe(200);
    h.clock.advance(5 * 60_000);
    web.clips = [clip(0, { created_at: h.clock.now().toISOString(), title: 'Brand new' }), clip(1), clip(2)];
    await refresh();
    await refresh();
    expect(posts().map((p) => p.embeds[0].title)).toEqual(['Brand new']);
  });

  it('saves a clip’s video on this PC from its byte ranges, under a safe file name', async () => {
    const id = clipId(1);
    web.clips = [clip(1, { title: 'What: a / play?' })];
    const a = Buffer.from('AAAAABBBBBCCCCC');
    const b = Buffer.from('DDDDDEEEEE');
    web.files.set('4064.ts', a);
    web.files.set('4065.ts', b);
    web.playlists.set(
      `/clips/aa/${id}/playlist.m3u8`,
      ['#EXTM3U', '#EXT-X-BYTERANGE:5@5', '#EXTINF:2.0,', '4064.ts', '#EXT-X-BYTERANGE:5', '#EXTINF:2.0,', '4064.ts', '#EXT-X-BYTERANGE:10@0', '#EXTINF:2.0,', '4065.ts', '#EXT-X-ENDLIST'].join('\n'),
    );
    await refresh();
    const res = await call<KickClipsState>('POST', `/api/kick/clips/${id}/save`);
    expect(res.status).toBe(200);
    const saved = res.body.clips[0]!.saved!;
    expect(path.basename(saved.path)).toBe(`${res.body.clips[0]!.createdAt.slice(0, 10)} What a play (${id}).ts`);
    expect(path.dirname(saved.path)).toBe(res.body.folder);
    expect(fs.readFileSync(saved.path).toString()).toBe('BBBBBCCCCCDDDDDEEEEE');
    expect(fs.existsSync(`${saved.path}.part`)).toBe(false);
    // Back-to-back ranges of one file are fetched together.
    expect(web.requests.filter((r) => r.endsWith('.ts'))).toEqual(['clips.kick.com/clips/aa/' + id + '/4064.ts', 'clips.kick.com/clips/aa/' + id + '/4065.ts']);

    // A video that can't be fetched leaves nothing behind and says why.
    web.files.delete('4065.ts');
    fs.rmSync(saved.path);
    const failed = await call('POST', `/api/kick/clips/${id}/save`);
    expect(failed.status).toBe(503);
    expect(failed.body.error?.message).toMatch(/HTTP 404/);
    expect(fs.readdirSync(res.body.folder)).toEqual([]);
  });
});

describe('clips made with Kick’s own /clip', () => {
  it('show up with the next list check and are posted with their thumbnail and buttons, no video', async () => {
    await call('POST', '/api/kick/clips', { guildId: GUILD, channelId: CLIPS, autoPost: true, folder: null });
    h.clock.advance(60_000);
    web.clips = [clip(0, { created_at: h.clock.now().toISOString(), title: 'Made with /clip' })];
    await refresh();
    const [post] = posts();
    expect(post.embeds[0]).toMatchObject({ title: 'Made with /clip', image: { url: `https://clips.kick.com/clips/aa/${clipId(0)}/thumbnail.webp` } });
    expect(post.components[0].components.map((b: { label: string; url: string }) => [b.label, b.url])).toEqual([
      ['Watch VOD', `https://kick.com/retrolive/videos/${VOD}`],
      ['View clip on Kick', `https://kick.com/retrolive/clips/${clipId(0)}`],
    ]);
    expect(post.attachments).toBeUndefined();
    // Nothing is downloaded to post it.
    expect(web.requests.some((r) => r.endsWith('.m3u8') || r.endsWith('.ts'))).toBe(false);
  });

  it('CONDUIT has no !clip of its own, and forgets the kick.com login an earlier version kept', async () => {
    expect(KICK_DEFAULT_COMMANDS.some((c) => c.trigger === '!clip')).toBe(false);
    const vault = new MemoryVault();
    await vault.set('kick:web-session', '123456|OldSessionToken');
    const h2 = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(await freePort()) }, { vault, fetch: () => Promise.reject(new Error('offline')), kickWebFetch: webFetch });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await vault.get('kick:web-session')).toBeNull();
    } finally {
      await h2.close();
    }
  });
});
