/**
 * Twitch (1.1.0) against a simulated Twitch and Discord (automated, mocked — not proof of live Twitch behaviour): the
 * user's own Twitch app, connecting the streamer's account, Twitch's required token validation, disconnecting, and
 * Twitch → Discord go-live notifications next to Kick's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifierView, PlatformConnectionSummary, StreamNotificationsState, TwitchSetupState } from '@conduit/shared';
import type { FetchLike } from '../../apps/server/src/app/types';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET } from '../helpers/fake-kick';
import { FakeTwitch, TWITCH_AVATAR_BYTES, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, type FakeTwitchUser } from '../helpers/fake-twitch';
import { createHarness, freePort, type Harness } from '../helpers/harness';

const GUILD = '42';
const ALERTS = '500000000000000001';

let h: Harness;
let twitch: FakeTwitch;
let kick: FakeKick;
let discord: FakeDiscord;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const user = (n: number): FakeTwitchUser => ({ id: String(9990000 + n), login: `twitcher${n}`, display_name: `Twitcher${n}`, profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${n}-profile_image-300x300.png` });
const posts = () => [...discord.messages.entries()].filter(([, m]) => m.channelId === ALERTS);
const check = async () => (await call<StreamNotificationsState>('POST', '/api/notifications/check')).body;
const saveApp = () => call<TwitchSetupState>('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET });

async function connect(who: FakeTwitchUser): Promise<void> {
  const res = await call<{ authorizationUrl: string }>('POST', '/api/connections/twitch/connect', { role: 'primary' });
  expect(res.status).toBe(200);
  expect((await fetch(twitch.approve(new URL(res.body.authorizationUrl), who))).status).toBe(200);
}

beforeEach(async () => {
  twitch = new FakeTwitch();
  kick = new FakeKick();
  discord = new FakeDiscord();
  const gateway = new FakeGateway();
  for (let n = 1; n <= 2; n++) twitch.directory.set(`twitcher${n}`, user(n));
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [{ id: ALERTS, name: 'live-alerts' }]);
  const all: FetchLike = (input, init) => {
    const host = new URL(String(input)).hostname;
    if (host.endsWith('twitch.tv') || host.endsWith('jtvnw.net')) return twitch.fetch(input, init);
    if (host.includes('kick.com')) return kick.fetch(input, init);
    return discord.fetch(input, init);
  };
  h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(await freePort()) }, { vault: new MemoryVault(), fetch: all, botFactory: gateway.factory });
  await call('POST', '/api/discord/application', { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN });
});
afterEach(async () => {
  await h.close();
});

describe('Twitch setup', () => {
  it('the app is checked with Twitch before anything is saved; the secret never comes back', async () => {
    const wrong = await call('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: 'wrongsecret0000000000000000001' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.issues?.[0]?.message).toMatch(/Twitch rejected this Client ID and Client Secret/);
    expect((await call<TwitchSetupState>('GET', '/api/twitch/setup')).body.application.configured).toBe(false);

    const ok = await saveApp();
    expect(ok.status).toBe(200);
    expect(ok.body.application).toEqual({ configured: true, clientId: TWITCH_CLIENT_ID, clientSecretStored: true });
    expect(ok.body.redirectUri).toMatch(/^http:\/\/localhost:\d+\/oauth\/twitch\/callback$/);
    expect(JSON.stringify(ok.body)).not.toContain(TWITCH_CLIENT_SECRET);
    // The test token from checking the app is revoked again.
    expect(twitch.revoked).toHaveLength(1);
  });

  it('connects the streamer’s account through Twitch’s own page, confirmed by /oauth2/validate and /helix/users', async () => {
    expect((await call('POST', '/api/connections/twitch/connect')).status).toBe(503); // no app yet
    await saveApp();
    const started = await call<{ authorizationUrl: string }>('POST', '/api/connections/twitch/connect');
    const url = new URL(started.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: TWITCH_CLIENT_ID, response_type: 'code', scope: 'user:read:chat user:write:chat', force_verify: 'true' });
    expect((await fetch(twitch.approve(url, user(1)))).status).toBe(200);

    const s = (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
    expect(s.primary).toMatchObject({ status: 'connected', userId: '9990001', name: 'Twitcher1', handle: 'twitcher1', pending: false, problem: null });
    expect(s.primary.avatarDataUrl).toBe(`data:image/png;base64,${TWITCH_AVATAR_BYTES.toString('base64')}`);
    const card = (await call<PlatformConnectionSummary[]>('GET', '/api/connections')).body.find((c) => c.platform === 'twitch')!;
    expect(card).toMatchObject({ status: 'connected', account: { name: 'Twitcher1', handle: 'twitcher1' } });
    expect(twitch.validations).toBeGreaterThan(0);
  });

  it('a token Twitch no longer accepts is refreshed; a revoked authorization asks to reconnect', async () => {
    await saveApp();
    await connect(user(1));
    const [first] = [...twitch.accessTokens.entries()].find(([, u]) => u?.id === '9990001')!;
    twitch.expire(first);
    await h.services.connections.verifyAll('twitch');
    expect((await call<TwitchSetupState>('GET', '/api/twitch/setup')).body.primary.status).toBe('connected');

    for (const [token, u] of twitch.accessTokens) if (u) twitch.expire(token);
    twitch.refreshTokens.clear();
    await h.services.connections.verifyAll('twitch');
    const s = (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
    expect(s.primary.status).toBe('needs_reauth');
    expect(s.primary.problem).toMatch(/Reconnect/);
  });

  it('disconnecting revokes the access token at Twitch (Twitch revokes access tokens only)', async () => {
    await saveApp();
    await connect(user(1));
    const [token] = [...twitch.accessTokens.entries()].find(([, u]) => u?.id === '9990001')!;
    const res = await call<{ revokedAtPlatform: boolean }>('POST', '/api/connections/twitch/disconnect', { role: 'primary' });
    expect(res.body.revokedAtPlatform).toBe(true);
    expect(twitch.revoked).toContain(token);
    expect((await call<TwitchSetupState>('GET', '/api/twitch/setup')).body.primary.status).toBe('not_connected');
  });
});

describe('Twitch Stream Notifications', () => {
  const notifier = (channel: string, over: Record<string, unknown> = {}) => ({ platform: 'twitch', channel, guildId: GUILD, channelId: ALERTS, ...over });

  it('without the Twitch app, the Twitch source says what to do; Kick is unaffected', async () => {
    const s = (await call<StreamNotificationsState>('GET', '/api/notifications')).body;
    expect(s.twitch).toMatchObject({ ready: false, problem: expect.stringMatching(/Set up your Twitch app first/) });
    expect(s.kick.problem).toMatch(/Set up your Kick app first/);
  });

  it('adding: Twitch must know the channel (a twitch.tv link works); no Twitch account needed (app token only)', async () => {
    await saveApp();
    const missing = await call('POST', '/api/notifications', notifier('nobody_here'));
    expect(missing.status).toBe(400);
    expect(missing.body.error?.issues?.[0]?.message).toBe('Twitch has no channel named “nobody_here”.');
    const ok = await call<NotifierView>('POST', '/api/notifications', notifier('https://www.twitch.tv/Twitcher1'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ platform: 'twitch', channel: 'twitcher1', live: false, displayName: 'Twitcher1', status: 'Offline. Waiting for the next stream.' });
  });

  it('goes live → one post with Twitch’s data and the Twitch layout; the thumbnail is Twitch’s preview; deleted when it ends', async () => {
    await saveApp();
    await call('POST', '/api/notifications', {
      ...notifier('twitcher1', { deleteWhenEnded: true }),
      content: 'Live now! {streamer} is streaming on Twitch!',
      embed: { ...(await import('@conduit/shared')).DEFAULT_TWITCH_NOTIFICATION_EMBED },
      buttons: [{ label: 'Watch {streamer} on Twitch!', url: '{url}' }],
    });
    twitch.live.set('twitcher1', { started_at: '2026-10-29T18:00:00Z', title: 'Speedruns', game_name: 'Retro Games', viewer_count: 12 });
    await check();
    await check();
    expect(posts()).toHaveLength(1);
    const body = posts()[0]![1].body;
    expect(body.content).toBe('Live now! Twitcher1 is streaming on Twitch!');
    expect(body.embeds[0]).toMatchObject({
      title: 'Speedruns',
      url: 'https://www.twitch.tv/twitcher1',
      fields: [
        { name: 'Category', value: 'Retro Games', inline: true },
        { name: 'Viewers', value: '12', inline: true },
      ],
      footer: { text: 'twitch.tv/Twitcher1' },
      thumbnail: { url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/1-profile_image-300x300.png' },
      color: 0x9146ff,
    });
    expect(body.embeds[0].image.url).toMatch(/^https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_twitcher1-1280x720\.jpg\?t=\d+$/);
    expect(body.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: 'Watch Twitcher1 on Twitch!', url: 'https://www.twitch.tv/twitcher1' }] }]);

    twitch.live.clear();
    await check();
    expect(posts()).toHaveLength(0);
    const [n] = (await call<StreamNotificationsState>('GET', '/api/notifications')).body.notifiers;
    expect(n).toMatchObject({ live: false, status: 'Stream ended; notification deleted.' });
  });

  it('Kick and Twitch streamers are checked side by side, each through its own platform', async () => {
    await saveApp();
    await call('POST', '/api/kick/application', { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET });
    kick.directory.set('kicker', { user_id: 7770001, name: 'Kicker', slug: 'kicker', profile_picture: null });
    expect((await call('POST', '/api/notifications', { platform: 'kick', channel: 'kicker', guildId: GUILD, channelId: ALERTS })).status).toBe(201);
    expect((await call('POST', '/api/notifications', notifier('twitcher2'))).status).toBe(201);
    // The same name on the other platform is a different streamer.
    expect((await call('POST', '/api/notifications', notifier('kicker'))).status).toBe(400);
    twitch.live.set('twitcher2', { started_at: '2026-10-29T18:00:00Z' });
    kick.live.set('kicker', { startTime: '2026-10-29T18:01:00Z' });
    await check();
    expect(posts().map(([, m]) => m.body.embeds[0].url).sort()).toEqual(['https://kick.com/kicker', 'https://www.twitch.tv/twitcher2']);
  });

  it('a Twitch outage changes nothing and is reported; the next check catches up', async () => {
    await saveApp();
    await call('POST', '/api/notifications', notifier('twitcher1'));
    twitch.offline = true;
    twitch.live.set('twitcher1', { started_at: '2026-10-29T18:00:00Z' });
    const s = await check();
    expect(posts()).toHaveLength(0);
    expect(s.twitch.problem).toMatch(/Couldn’t check Twitch: Twitch couldn’t be reached/);
    twitch.offline = false;
    expect((await check()).twitch).toMatchObject({ ready: true, problem: null });
    expect(posts()).toHaveLength(1);
  });

  it('a notification stays on its platform when edited', async () => {
    await saveApp();
    const created = (await call<NotifierView>('POST', '/api/notifications', notifier('twitcher1'))).body;
    const edited = await call<NotifierView>('PATCH', `/api/notifications/${created.id}`, { platform: 'kick', enabled: false });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ platform: 'twitch', enabled: false });
  });
});
