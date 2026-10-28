/**
 * Discord giveaway announcements and button entries against a simulated Discord REST API and gateway (automated,
 * mocked — not proof of live Discord behaviour): channel choice and permission checks, the embed and its Enter
 * buttons, private (ephemeral) answers, failures (missing permissions, deleted messages) and restarts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCORD_BUTTON_REPLIES as R, type DiscordChannelsState, type DiscordSetupState, type GiveawaysState, type GiveawayView } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { createHarness, type Harness } from '../helpers/harness';

const GUILD = '42';
const CHANNEL = '500000000000000001';
const LOCKED = '500000000000000002';
const fan = (n: number) => `90000000000000000${n}`;

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string } } };
const state = async () => (await h.call<GiveawaysState>('GET', '/api/giveaways')).body;
const view = async (id: string) => (await state()).giveaways.find((g) => g.id === id);
/** Start Giveaway (one step). Discord-only unless the test says otherwise: this harness has no Kick connection. */
const create = (body: Record<string, unknown>) =>
  h.call<GiveawayView>('POST', '/api/giveaways', { body: { platforms: ['discord'], ...body } }) as Promise<Res<GiveawayView>>;
const act = (id: string, action: string, body?: unknown) =>
  h.call<GiveawayView>('POST', `/api/giveaways/${id}/${action}`, body === undefined ? {} : { body }) as Promise<Res<GiveawayView>>;

async function until<T>(get: () => Promise<T> | T, ok: (v: T) => boolean, what = 'condition'): Promise<T> {
  const end = Date.now() + 3000;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`${what} never became true: ${JSON.stringify(v)?.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function botReady(): Promise<void> {
  await until(
    async () => (await h.call<DiscordSetupState>('GET', '/api/discord/setup')).body,
    (s) => s.bot.status === 'connected' && s.commands.status === 'registered',
    'bot ready',
  );
}

beforeEach(async () => {
  discord = new FakeDiscord();
  gateway = new FakeGateway();
  discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
  gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
  discord.addServerWithChannels(GUILD, [
    { id: CHANNEL, name: 'giveaways' },
    { id: LOCKED, name: 'announcements', deny: 1n << 11n }, // @everyone can't send messages here
  ]);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

/** Start Giveaway announced in CHANNEL; returns it with its posted message id. */
async function announced(body: Record<string, unknown> = {}): Promise<{ g: GiveawayView; messageId: string }> {
  const started = await create({ prize: 'Nitro', winnerCount: 1, discordChannel: { guildId: GUILD, channelId: CHANNEL }, ...body });
  expect(started.status).toBe(201);
  expect(started.body.status).toBe('open');
  expect(started.body.discord).toMatchObject({ status: 'posted', channelName: 'giveaways' });
  return { g: started.body, messageId: started.body.discord!.messageId! };
}
const msg = (messageId: string) => discord.messages.get(messageId)!.body;
const embed = (messageId: string) => msg(messageId).embeds[0];
const field = (messageId: string, name: string) => embed(messageId).fields.find((f: { name: string }) => f.name === name)?.value as string | undefined;
const buttons = (messageId: string) => msg(messageId).components[0].components as Array<{ custom_id: string; label: string; disabled: boolean; style: number }>;
const entries = async (id: string) => (await view(id))!.entriesByPlatform.discord;
/** Clicks a giveaway button (Enter; "leave" only as a forged/old click) as a Discord user; returns the private answer. */
const click = async (g: { id: string }, messageId: string, action: 'enter' | 'leave', userId: string, extra: Record<string, unknown> = {}) => {
  const b = await gateway.click(`giveaway:${action}:${g.id}`, { userId, messageId, channelId: CHANNEL, guildId: GUILD, userName: `fan${userId.slice(-1)}`, ...extra });
  return b.replies;
};

describe('choosing the announcement channel', () => {
  it('lists the bot’s text channels with the permissions it lacks', async () => {
    const res = await h.call<DiscordChannelsState>('GET', '/api/giveaways/discord/channels');
    expect(res.body).toEqual({
      problem: null,
      guilds: [
        {
          id: GUILD,
          name: 'Retro Server',
          problem: null,
          channels: [
            { id: CHANNEL, name: 'giveaways', missing: [], permissions: expect.any(String) },
            { id: LOCKED, name: 'announcements', missing: ['Send Messages'], permissions: expect.any(String) },
          ],
          // The bot's server-level permissions and the server's roles (for other Discord features).
          permissions: expect.any(String),
          roles: [],
        },
      ],
    });
    // The locked channel's bits really lack Send Messages (1<<11).
    const locked = res.body.guilds[0]!.channels.find((c) => c.id === LOCKED)!;
    expect(BigInt(locked.permissions!) & (1n << 11n)).toBe(0n);
  });

  it('won’t start where the bot can’t post, and says what to fix', async () => {
    const res = await create({ prize: 'Nitro', discordChannel: { guildId: GUILD, channelId: LOCKED } });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/^Not started: The bot is missing Send Messages in #announcements\. Give the bot’s role/);
    expect((await state()).giveaways).toEqual([]); // nothing half-started
    expect(discord.messages.size).toBe(0);
  });

  it('publishes on Start in the channel chosen for that giveaway', async () => {
    const other = '500000000000000003';
    discord.channels.get(GUILD)!.push({ id: other, name: 'events', type: 0, position: 2, permission_overwrites: [] });
    const started = await create({ prize: 'Nitro', discordChannel: { guildId: GUILD, channelId: other } });
    expect(started.body.status).toBe('open');
    expect(discord.messages.get(started.body.discord!.messageId!)!.channelId).toBe(other);
    expect(started.body.discord!.channelName).toBe('events');
  });

  it('needs Discord as an entry platform, and remembers the last channel for new giveaways', async () => {
    const bad = await create({ prize: 'p', platforms: ['kick'], discordChannel: { guildId: GUILD, channelId: CHANNEL } });
    expect(bad.status).toBe(400);
    expect((await create({ prize: 'p', discordChannel: { guildId: GUILD, channelId: CHANNEL } })).status).toBe(201);
    expect((await state()).discordChannelDefault).toEqual({ guildId: GUILD, channelId: CHANNEL });
  });
});

describe('the embed and its buttons', () => {
  it('is a clean embed with the prize, winners, closing time, how to enter, entries and the two buttons', async () => {
    const { g, messageId } = await announced({ description: 'A year of Nitro', durationMinutes: 30, winnerCount: 2 });
    const m = discord.messages.get(messageId)!;
    expect(m.channelId).toBe(CHANNEL);
    expect(m.body.allowed_mentions).toEqual({ parse: [] });
    const e = embed(messageId);
    expect(e).toMatchObject({ title: '🎉 Nitro', description: 'A year of Nitro', color: 0x048ba8 });
    expect(e.author).toBeUndefined();
    expect(e.footer).toBeUndefined();
    expect(JSON.stringify(m.body)).not.toMatch(/CONDUIT|\/enter|React with/);
    expect(field(messageId, 'How to enter')).toBe('Click **🎉 Enter Giveaway** below.');
    expect(field(messageId, 'Winners')).toBe('2');
    expect(field(messageId, 'Entries')).toBeUndefined(); // entry and ticket counts are never public
    const closes = Math.floor(Date.parse(g.endsAt!) / 1000);
    expect(field(messageId, 'Closes')).toBe(`<t:${closes}:R> (<t:${closes}:f>)`);
    expect(msg(messageId).components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: `giveaway:enter:${g.id}`, label: 'Enter Giveaway', emoji: { name: '🎉' }, disabled: false },
        ],
      },
    ]);
    expect(m.reactions.size).toBe(0); // no 🎉 reaction any more
    expect(g.discord).toMatchObject({ guildId: GUILD, channelId: CHANNEL, messageId, status: 'posted', detail: null });
  });

  it('never shows entries; disables the buttons when entries close, then shows the winner (name only)', async () => {
    const { g, messageId } = await announced();
    await click(g, messageId, 'enter', fan(1));
    await click(g, messageId, 'enter', fan(2));
    await new Promise((r) => setTimeout(r, 40));
    expect(discord.messages.get(messageId)!.edits).toBe(0); // entering doesn't touch the public embed

    await act(g.id, 'end');
    await until(() => embed(messageId).description as string, (d) => /Entries are closed/.test(d ?? ''), 'closed embed');
    expect(buttons(messageId).map((b) => [b.label, b.disabled])).toEqual([['Enter Giveaway', true]]); // no Leave button comes back
    expect(JSON.stringify(msg(messageId))).not.toMatch(/Leave|Kick|!enter|kick\.com/);

    const drawn = await act(g.id, 'draw');
    const winner = drawn.body.winners[0]!;
    await until(() => field(messageId, '🏆 Winner'), (v) => v === `1. <@${winner.platformUserId}>`, 'winner in embed');
    expect(embed(messageId).title).toBe('🏆 Nitro');
    expect(buttons(messageId).every((b) => b.disabled)).toBe(true);
    expect(JSON.stringify(msg(messageId))).not.toMatch(/ticket|odds|chance|%|entries:/i);
  });

  it('cancelling deletes the giveaway; its embed says so with the buttons disabled, and they no longer do anything', async () => {
    const { g, messageId } = await announced();
    await click(g, messageId, 'enter', fan(1));
    const res = await h.call<{ deleted: boolean }>('POST', `/api/giveaways/${g.id}/cancel`);
    expect(res.body.deleted).toBe(true);
    expect(embed(messageId).description).toBe('**This giveaway was cancelled.**');
    expect(buttons(messageId).map((b) => [b.label, b.disabled])).toEqual([['Enter Giveaway', true]]);
    expect(JSON.stringify(msg(messageId))).not.toMatch(/Leave|Kick|!enter|kick\.com/);
    expect(await view(g.id))!.toBeUndefined();
    expect(await click(g, messageId, 'enter', fan(2))).toEqual([{ content: R.unavailable, ephemeral: true }]);
  });
});

describe('Enter Giveaway button (private answers; entering is one-way)', () => {
  it('enter and already entered, each answered privately; there is no way to leave', async () => {
    const { g, messageId } = await announced();
    expect(await click(g, messageId, 'enter', fan(1))).toEqual([{ content: 'You’ve entered the giveaway! 🎉', ephemeral: true }]);
    expect(await click(g, messageId, 'enter', fan(1))).toEqual([{ content: 'You’re already entered in this giveaway!', ephemeral: true }]);
    expect(await entries(g.id)).toBe(1);
    // A forged (or old-embed) "leave" click is refused privately and removes nothing.
    expect(await click(g, messageId, 'leave', fan(1))).toEqual([{ content: R.unavailable, ephemeral: true }]);
    expect(await entries(g.id)).toBe(1);
    // Nothing was ever posted publicly or by DM for these clicks: the only message created is the embed itself.
    expect(discord.messages.size).toBe(1);
    expect(discord.requests.filter((r) => r.method === 'POST' && /\/channels\/\d+\/messages$|\/users\/@me\/channels/.test(r.url))).toHaveLength(1);
  });

  it('identifies entrants by Discord user id, never by name', async () => {
    const { g, messageId } = await announced();
    await click(g, messageId, 'enter', fan(1), { userName: 'same' });
    expect(await click(g, messageId, 'enter', fan(2), { userName: 'same' })).toEqual([{ content: R.entered, ephemeral: true }]);
    expect(await click(g, messageId, 'enter', fan(1), { userName: 'renamed' })).toEqual([{ content: R.alreadyEntered, ephemeral: true }]);
    expect(await entries(g.id)).toBe(2);
  });

  it('a duplicated interaction event is answered once and never adds a second entry', async () => {
    const { g, messageId } = await announced();
    const first = await gateway.click(`giveaway:enter:${g.id}`, { id: '8100000000000000001', userId: fan(1), messageId, channelId: CHANNEL });
    const again = await gateway.click(`giveaway:enter:${g.id}`, { id: '8100000000000000001', userId: fan(1), messageId, channelId: CHANNEL });
    expect(first.replies).toEqual([{ content: R.entered, ephemeral: true }]);
    expect(again.replies).toEqual([]);
    expect(await entries(g.id)).toBe(1);
  });

  it('simultaneous clicks by the same user produce one entry', async () => {
    const { g, messageId } = await announced();
    const answers = await Promise.all([1, 2, 3, 4].map(() => click(g, messageId, 'enter', fan(1))));
    expect(answers.map((a) => a[0]!.content).sort()).toEqual([R.alreadyEntered, R.alreadyEntered, R.alreadyEntered, R.entered].sort());
    expect(await entries(g.id)).toBe(1);
  });

  it('a closed giveaway (past its end time, drawn or cancelled) accepts nothing', async () => {
    const timed = await announced({ durationMinutes: 1 });
    await click(timed.g, timed.messageId, 'enter', fan(1));
    h.clock.advance(61_000); // the background check hasn't run yet
    expect(await click(timed.g, timed.messageId, 'enter', fan(2))).toEqual([{ content: R.closed, ephemeral: true }]);
    expect(await view(timed.g.id))!.toMatchObject({ status: 'closed', entryCount: 1 });
    await act(timed.g.id, 'draw');
    expect(await click(timed.g, timed.messageId, 'enter', fan(3))).toEqual([{ content: R.closed, ephemeral: true }]);

    const other = await announced({ prize: 'Other' });
    await act(other.g.id, 'end');
    expect(await click(other.g, other.messageId, 'enter', fan(4))).toEqual([{ content: R.closed, ephemeral: true }]);
  });

  it('refuses invalid or foreign buttons privately', async () => {
    const { g, messageId } = await announced();
    const answer = async (customId: string, extra: Record<string, unknown> = {}) =>
      (await gateway.click(customId, { userId: fan(1), messageId, channelId: CHANNEL, guildId: GUILD, ...extra })).replies;
    const unavailable = [{ content: R.unavailable, ephemeral: true }];
    expect(await answer(`giveaway:steal:${g.id}`)).toEqual(unavailable);
    expect(await answer('giveaway:enter:not-a-uuid')).toEqual(unavailable);
    expect(await answer(`giveaway:enter:${g.id}:extra`)).toEqual(unavailable);
    expect(await answer('giveaway:enter:00000000-0000-4000-8000-000000000000')).toEqual(unavailable); // unknown giveaway
    expect(await answer(`giveaway:enter:${g.id}`, { messageId: '1300000000000000099' })).toEqual(unavailable); // other message
    expect(await answer(`giveaway:enter:${g.id}`, { channelId: '500000000000000009' })).toEqual(unavailable);
    expect(await answer(`giveaway:enter:${g.id}`, { guildId: '43' })).toEqual(unavailable);
    expect(await answer(`giveaway:enter:${g.id}`, { applicationId: '999999999999999999' })).toEqual(unavailable);
    expect(await answer('x'.repeat(200))).toEqual(unavailable);
    expect(await entries(g.id)).toBe(0);
  });

  it('only that giveaway’s buttons affect it', async () => {
    const first = await announced({ prize: 'First' });
    await act(first.g.id, 'end');
    const second = await announced({ prize: 'Second' });
    // The first giveaway's button id on the second giveaway's message (forged) does nothing to either.
    const forged = await gateway.click(`giveaway:enter:${first.g.id}`, { userId: fan(1), messageId: second.messageId, channelId: CHANNEL });
    expect(forged.replies).toEqual([{ content: R.unavailable, ephemeral: true }]);
    expect((await view(first.g.id))!.entryCount).toBe(0);
    expect((await view(second.g.id))!.entryCount).toBe(0);
  });

  it('the streamer’s own Discord account can’t enter (answered privately with the reason)', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    h.db
      .prepare(
        `INSERT INTO platform_connections (id, platform, external_account_id, account_name, granted_scopes, status, connected_at,
           last_verified_at, updated_at, role) VALUES ('c1', 'discord', ?, 'streamer', '[]', 'connected', ?, ?, ?, 'primary')`,
      )
      .run(fan(9), at, at, at);
    const { g, messageId } = await announced();
    expect(await click(g, messageId, 'enter', fan(9))).toEqual([{ content: 'The streamer’s own Discord account can’t enter.', ephemeral: true }]);
  });

  it('someone who entered by 🎉 reaction earlier is kept (already entered)', async () => {
    const { g, messageId } = await announced();
    h.db
      .prepare("INSERT INTO giveaway_entries (giveaway_id, platform, platform_user_id, display_name, entered_at, source) VALUES (?, 'discord', ?, 'fan1', 'x', 'reaction')")
      .run(g.id, fan(1));
    expect(await click(g, messageId, 'enter', fan(1))).toEqual([{ content: R.alreadyEntered, ephemeral: true }]);
    expect(await entries(g.id)).toBe(1);
  });
});

describe('failures are shown, never reported as success', () => {
  it('if the embed can’t be posted, the giveaway isn’t started and the error says what to fix', async () => {
    discord.messageFailures.push({ status: 403, code: 50013 });
    const res = await create({ prize: 'Nitro', discordChannel: { guildId: GUILD, channelId: CHANNEL } });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/^Not started: The bot is missing permissions in #giveaways: it needs View Channel, Send Messages and Embed Links/);
    expect((await state()).giveaways).toEqual([]);
    expect(discord.messages.size).toBe(0);
    // Fixed: starting again works.
    expect((await create({ prize: 'Nitro', discordChannel: { guildId: GUILD, channelId: CHANNEL } })).status).toBe(201);
  });

  it('a deleted announcement keeps the results, says so, and can be reposted (old buttons stop working)', async () => {
    const { g, messageId } = await announced();
    await click(g, messageId, 'enter', fan(1));
    discord.messages.delete(messageId); // someone deleted it in Discord
    const drawn = await act(g.id, 'draw');
    expect(drawn.body.status).toBe('drawn');
    const after = await until(() => view(g.id), (v) => v?.discord?.status === 'missing', 'missing status');
    expect(after!.discord!.detail).toBe('The announcement message was deleted in Discord. Select Repost to post it again.');
    expect(after!.winners).toHaveLength(1);

    const reposted = await act(g.id, 'discord/retry');
    const newId = reposted.body.discord!.messageId!;
    expect(newId).not.toBe(messageId);
    expect(field(newId, '🏆 Winner')).toBe(`1. <@${fan(1)}>`);
    expect(buttons(newId).every((b) => b.disabled)).toBe(true);
    expect(await click(g, messageId, 'enter', fan(2))).toEqual([{ content: R.unavailable, ephemeral: true }]); // the deleted message
  });

  it('a failed edit (e.g. lost permission) is shown and retried', async () => {
    const { g } = await announced();
    discord.messageFailures.push({ status: 403, code: 50001 });
    await act(g.id, 'end');
    const failed = await until(() => view(g.id), (v) => v?.discord?.status === 'failed');
    expect(failed!.discord!.detail).toMatch(/can’t access #giveaways/);
    expect(failed!.status).toBe('closed');
    expect((await act(g.id, 'discord/retry')).body.discord).toMatchObject({ status: 'posted', detail: null });
  });

  it('a deleted channel is reported when posting', async () => {
    discord.channels.set(GUILD, []);
    const res = await create({ prize: 'Nitro', discordChannel: { guildId: GUILD, channelId: CHANNEL } });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/no longer exists/);
  });
});

describe('restarts', () => {
  it('buttons keep working after a restart (resolved from the database), and the same embed is updated', async () => {
    const { g, messageId } = await announced();
    await click(g, messageId, 'enter', fan(1));
    await h.server.close();
    const editsBefore = discord.messages.get(messageId)!.edits;

    await h.restart();
    await h.services.discord.startBot(); // as main.ts does at startup
    await botReady();
    expect(await click(g, messageId, 'enter', fan(1))).toEqual([{ content: R.alreadyEntered, ephemeral: true }]);
    expect(await click(g, messageId, 'enter', fan(2))).toEqual([{ content: R.entered, ephemeral: true }]);
    await until(() => discord.messages.get(messageId)!.edits, (n) => n > editsBefore, 'embed refreshed after restart');
    expect((await view(g.id))!.entriesByPlatform.discord).toBe(2);
    expect(buttons(messageId).map((b) => b.label)).toEqual(['Enter Giveaway']);
    expect((await view(g.id))!.discord?.messageId).toBe(messageId);
  });

  it('an announcement posted with the old Leave button loses it (and any Kick instructions) when the bot reconnects', async () => {
    const { g, messageId } = await announced();
    const old = msg(messageId);
    old.components[0].components.push({ type: 2, style: 2, custom_id: `giveaway:leave:${g.id}`, label: 'Leave Giveaway', disabled: false });
    old.embeds[0].fields[0].value = 'Click **🎉 Enter Giveaway** below. Changed your mind? Click **Leave Giveaway**.\nOn Kick: type `!enter` in chat at kick.com/retronix.';
    await h.restart();
    await h.services.discord.startBot();
    await botReady();
    await until(() => buttons(messageId).length, (n) => n === 1, 'leave button removed');
    expect(field(messageId, 'How to enter')).toBe('Click **🎉 Enter Giveaway** below.');
    expect(JSON.stringify(msg(messageId))).not.toMatch(/Leave|Kick|!enter|kick\.com/);
  });

  it('an announcement posted before buttons existed gets them when the bot reconnects', async () => {
    const { g, messageId } = await announced();
    discord.messages.get(messageId)!.body = { embeds: [{ title: '🎉 Nitro' }], allowed_mentions: { parse: [] } }; // old style, no buttons
    await h.restart();
    await h.services.discord.startBot();
    await botReady();
    await until(() => msg(messageId).components?.[0]?.components?.length, (n) => n === 1, 'button added');
    expect(buttons(messageId)[0]!.custom_id).toBe(`giveaway:enter:${g.id}`);
  });
});
