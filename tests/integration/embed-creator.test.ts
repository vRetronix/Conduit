/**
 * Discord → Embed Creator against a simulated Discord REST API (automated, mocked — not proof of live Discord behaviour):
 * sending as the bot and editing later, loading messages from their link (the bot's own; anyone else's by recreating),
 * and removing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadMessageResult, PostedMessageView } from '@conduit/shared';
import { ANTIRAID_DEFAULTS, EMPTY_EMBED } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { auditActions, createHarness, type Harness } from '../helpers/harness';

const GUILD = '420000000000000042';
const GENERAL = '500000000000000001';
const LOCKED = '500000000000000002';

let h: Harness;
let discord: FakeDiscord;
let gateway: FakeGateway;

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const link = (channelId: string, messageId: string) => `https://discord.com/channels/${GUILD}/${channelId}/${messageId}`;
const embed = (over: Record<string, unknown> = {}) => ({ ...EMPTY_EMBED, title: 'Welcome', description: 'Read the rules', color: '#5865F2', ...over });
const draft = (over: Record<string, unknown> = {}) => ({ content: 'Hello', embeds: [embed()], ...over });

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
  ]);
  h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
  await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  await botReady();
});
afterEach(async () => {
  await h.close();
});

describe('Embed Creator: sending as the bot', () => {
  it('sends text and several embeds, keeps the message, and edits it in place later', async () => {
    const sent = await call<PostedMessageView>('POST', '/api/discord/messages', { name: 'Rules', guildId: GUILD, channelId: GENERAL, draft: draft({ embeds: [embed(), embed({ title: 'FAQ' })] }) });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ name: 'Rules', channelName: 'general', place: 'Retro Server' });
    const posted = discord.messages.get(sent.body.messageId)!;
    expect(posted.body.content).toBe('Hello');
    expect(posted.body.embeds.map((e: { title: string }) => e.title)).toEqual(['Welcome', 'FAQ']);
    expect(posted.body.embeds[0].color).toBe(0x5865f2);
    expect(posted.body.allowed_mentions).toEqual({ parse: [] });

    const edited = await call<PostedMessageView>('PATCH', `/api/discord/messages/${sent.body.id}`, { name: 'Server rules', draft: draft({ content: '', embeds: [embed({ title: 'Rules v2' })] }) });
    expect(edited.status).toBe(200);
    expect(posted.edits).toBe(1);
    expect(posted.body.content).toBe(''); // text removed
    expect(posted.body.embeds[0].title).toBe('Rules v2');
    const list = (await call<PostedMessageView[]>('GET', '/api/discord/messages')).body;
    expect(list.map((m) => [m.name, m.draft.embeds[0]!.title])).toEqual([['Server rules', 'Rules v2']]);
    expect(auditActions(h).map((a) => a.action)).toEqual(expect.arrayContaining(['embed.message_sent', 'embed.message_edited']));
  });

  it('checks the message and the channel first', async () => {
    expect((await call('POST', '/api/discord/messages', { name: 'x', guildId: GUILD, channelId: GENERAL, draft: { content: '', embeds: [] } })).status).toBe(400);
    expect((await call('POST', '/api/discord/messages', { name: 'x', guildId: GUILD, channelId: GENERAL, draft: draft({ embeds: Array.from({ length: 11 }, () => embed()) }) })).status).toBe(400);
    const locked = await call('POST', '/api/discord/messages', { name: 'x', guildId: GUILD, channelId: LOCKED, draft: draft() });
    expect(locked.status).toBe(400);
    expect(locked.body.error?.message).toMatch(/needs Send Messages in #locked/);
  });
});

describe('Embed Creator: loading messages from Discord', () => {
  it('the bot’s own message is kept and editable; loading it again picks up its current content', async () => {
    const sent = (await call<PostedMessageView>('POST', '/api/discord/messages', { name: 'Rules', guildId: GUILD, channelId: GENERAL, draft: draft() })).body;
    discord.messages.get(sent.messageId)!.body.content = 'Changed in Discord';
    const r = (await call<LoadMessageResult>('POST', '/api/discord/messages/load', { link: link(GENERAL, sent.messageId) })).body;
    expect(r).toMatchObject({ status: 'tracked', message: { id: sent.id } });
    expect(r.status === 'tracked' && r.message.draft.content).toBe('Changed in Discord');
  });

  it('removing can delete the message in Discord too', async () => {
    const sent = (await call<PostedMessageView>('POST', '/api/discord/messages', { name: 'Rules', guildId: GUILD, channelId: GENERAL, draft: draft() })).body;
    expect((await call('POST', `/api/discord/messages/${sent.id}/remove`, { fromDiscord: true })).status).toBe(204);
    expect(discord.deletedMessages).toContain(sent.messageId);
    expect((await call<PostedMessageView[]>('GET', '/api/discord/messages')).body).toEqual([]);
  });

  it('someone else’s buttons come along when recreating: links as they are, others without actions until you choose', async () => {
    const theirs = discord.foreignPost(GENERAL, {
      content: 'Pick a role',
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Site', url: 'https://x.test' }, { type: 2, style: 1, label: 'Red team', custom_id: 'their:red' }] }],
      author: { id: '900000000000000078', username: 'rolebot', bot: true },
    });
    const r = (await call<LoadMessageResult>('POST', '/api/discord/messages/load', { link: link(GENERAL, theirs) })).body;
    expect(r).toMatchObject({ status: 'recreate', author: 'rolebot' });
    if (r.status !== 'recreate') return;
    expect(r.draft.components[0]!.components).toMatchObject([
      { kind: 'button', style: 'link', label: 'Site', url: 'https://x.test' },
      { kind: 'button', style: 'primary', label: 'Red team', actions: [] },
    ]);
    expect(r.notes).toContain('Some buttons or menus have no actions here yet: choose what they do.');
  });

  it('another feature’s message (e.g. a giveaway): its buttons stay its own when the text is edited here', async () => {
    const giveaway = await h.services.embedCreator['o'].api.createMessage(BOT_TOKEN, GENERAL, {
      content: 'Giveaway!',
      embeds: [],
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Enter', custom_id: 'giveaway:enter:x' }] }],
      allowed_mentions: { parse: [] },
    });
    const r = (await call<LoadMessageResult>('POST', '/api/discord/messages/load', { link: link(GENERAL, giveaway) })).body;
    expect(r.status === 'tracked' && r.message.draft).toMatchObject({ externalComponents: true, components: [] });
    expect(r.notes).toEqual(['Its buttons belong to another feature (for example a giveaway) and stay as they are when you save changes.']);
    if (r.status !== 'tracked') return;
    await call('PATCH', `/api/discord/messages/${r.message.id}`, { name: 'Giveaway', draft: { content: 'Giveaway! (edited)', embeds: [], components: [] } });
    const body = discord.messages.get(giveaway)!.body;
    expect(body.content).toBe('Giveaway! (edited)');
    expect(body).not.toHaveProperty('components'); // left out of the edit: Discord keeps the Enter button
  });

  it('someone else’s message is recreated as the bot, optionally deleting the original', async () => {
    const messageId = discord.foreignPost(GENERAL, { content: 'Old announcement', author: { id: '900000000000000077', username: 'otherbot', bot: true } });
    const r = (await call<LoadMessageResult>('POST', '/api/discord/messages/load', { link: link(GENERAL, messageId) })).body;
    expect(r).toMatchObject({ status: 'recreate', author: 'otherbot' });

    // Without Manage Messages the copy is posted, and why the original stayed is explained.
    const noPerm = await call<{ message: PostedMessageView; note: string | null }>('POST', '/api/discord/messages/recreate', { link: link(GENERAL, messageId), name: 'Announcement', draft: draft({ content: 'Old announcement', embeds: [] }), deleteOriginal: true });
    expect(noPerm.status).toBe(201);
    expect(noPerm.body.note).toMatch(/the original wasn’t deleted: the bot needs Manage Messages/);
    expect(discord.messages.get(noPerm.body.message.messageId)!.body.content).toBe('Old announcement');

    discord.grantBot(GUILD, 1n << 13n);
    const again = await call<{ message: PostedMessageView; note: string | null }>('POST', '/api/discord/messages/recreate', { link: link(GENERAL, messageId), name: 'Announcement', draft: draft({ embeds: [] }), deleteOriginal: true });
    expect(again.body.note).toBeNull();
    expect(discord.deletedMessages).toContain(messageId);
  });

  it('explains links that don’t work', async () => {
    expect((await call('POST', '/api/discord/messages/load', { link: 'not a link' })).status).toBe(400);
    const missing = await call('POST', '/api/discord/messages/load', { link: link(GENERAL, '1999999999999999999') });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.message).toMatch(/couldn’t find that message/);
  });
});

describe('Embed Creator: embeds saved to the library automatically, under the message’s name', () => {
  type Saved = Array<{ id: string; name: string; embed: { title: string } }>;
  const library = async () => (await call<Saved>('GET', '/api/discord/embeds')).body.map((x) => [x.name, x.embed.title]).sort((p, q) => p[0]!.localeCompare(q[0]!));
  const autosave = (body: Record<string, unknown>) => call<Saved>('POST', '/api/discord/embeds/autosave', body);

  it('one embed is saved as the name; more as “Name (2)”…; changes update the same entries', async () => {
    const first = await autosave({ name: 'Rules', previousName: null, embeds: [embed({ title: 'Rules' })] });
    expect(first.body.map((x) => x.name)).toEqual(['Rules']);
    await autosave({ name: 'Rules', previousName: 'Rules', embeds: [embed({ title: 'Rules v2' }), embed({ title: 'FAQ' })] });
    expect(await library()).toEqual([
      ['Rules', 'Rules v2'],
      ['Rules (2)', 'FAQ'],
    ]);
    const again = await autosave({ name: 'Rules', previousName: 'Rules', embeds: [embed({ title: 'Rules v2' }), embed({ title: 'FAQ' })] });
    expect(again.body[0]!.id).toBe(first.body[0]!.id);
  });

  it('renaming moves the entries; removed embeds’ entries are deleted; other saved embeds are left alone', async () => {
    await call('POST', '/api/discord/embeds', { name: 'Unrelated', embed: embed({ title: 'Keep me' }) });
    await autosave({ name: 'Rules', previousName: null, embeds: [embed({ title: 'A' }), embed({ title: 'B' }), embed({ title: 'C' })] });
    await autosave({ name: 'Server rules', previousName: 'Rules', embeds: [embed({ title: 'A' }), embed({ title: 'B' })] });
    expect(await library()).toEqual([
      ['Server rules', 'A'],
      ['Server rules (2)', 'B'],
      ['Unrelated', 'Keep me'],
    ]);
  });

  it('checks the name and the embeds', async () => {
    expect((await autosave({ name: '', previousName: null, embeds: [embed()] })).status).toBe(400);
    expect((await autosave({ name: 'x'.repeat(55), previousName: null, embeds: [embed()] })).status).toBe(400);
    expect((await autosave({ name: 'Bad', previousName: null, embeds: [embed({ title: '', description: '' })] })).status).toBe(400);
  });
});

describe('Embed Creator: buttons and select menus', () => {
  const MEMBER = '900000000000000060';
  const RED = '700000000000000021';
  const BLUE = '700000000000000022';
  const VERIFIED = '700000000000000023';
  const STAFF = '700000000000000024';
  let n = 0;
  /** A Discord id created daysOld days before the test clock. */
  const idAged = (daysOld: number) => String(((BigInt(h.clock.now().getTime() - daysOld * 86_400_000) - 1_420_070_400_000n) << 22n) + BigInt(++n));
  const rows = () => [
    {
      components: [
        { id: 'a', kind: 'button', style: 'success', label: 'Red team', emoji: '🔴', actions: [{ type: 'toggle_role', roleId: RED }] },
        { id: 'b', kind: 'button', style: 'primary', label: 'Verify', actions: [{ type: 'verify', roleId: VERIFIED }] },
        { id: 'c', kind: 'button', style: 'link', label: 'Rules', url: 'https://x.test/rules' },
        { id: 'd', kind: 'button', style: 'danger', label: 'Staff', actions: [{ type: 'add_role', roleId: STAFF }] },
        { id: 'e', kind: 'button', style: 'secondary', label: 'Hello', actions: [{ type: 'reply', content: 'Hi there!' }] },
      ],
    },
    {
      components: [
        {
          id: 'f',
          kind: 'select',
          placeholder: 'Pick teams',
          minValues: 0,
          maxValues: 2,
          options: [
            { id: '1', label: 'Red', actions: [{ type: 'add_role', roleId: RED }] },
            { id: '2', label: 'Blue', actions: [{ type: 'add_role', roleId: BLUE }] },
          ],
        },
      ],
    },
  ];
  let sent: PostedMessageView;
  const click = (id: string, userId = MEMBER, o: { values?: string[]; messageId?: string; recordId?: string; userHasAvatar?: boolean } = {}) =>
    gateway.click(`c:${o.recordId ?? sent.id}:${id}`, { userId, messageId: o.messageId ?? sent.messageId, guildId: GUILD, values: o.values, userHasAvatar: o.userHasAvatar });

  beforeEach(async () => {
    // The bot: Manage Roles, its role at position 10; Staff is above it.
    discord.grantBot(GUILD, 1n << 28n);
    discord.setBotRolePosition(GUILD, 10);
    discord.addRole(GUILD, RED, 2, { name: 'Red' });
    discord.addRole(GUILD, BLUE, 3, { name: 'Blue' });
    discord.addRole(GUILD, VERIFIED, 4, { name: 'Verified' });
    discord.addRole(GUILD, STAFF, 20, { name: 'Staff' });
    discord.addMember(GUILD, { id: MEMBER, username: 'member' });
    sent = (await call<PostedMessageView>('POST', '/api/discord/messages', { name: 'Roles', guildId: GUILD, channelId: GENERAL, draft: draft({ components: rows() }) })).body;
  });

  it('are sent as Discord components: custom ids CONDUIT answers to, links as links; what they do stays in CONDUIT', async () => {
    const body = discord.messages.get(sent.messageId)!.body;
    expect(body.components[0].components.map((c: { custom_id?: string; url?: string }) => c.custom_id ?? c.url)).toEqual([
      `c:${sent.id}:a`,
      `c:${sent.id}:b`,
      'https://x.test/rules',
      `c:${sent.id}:d`,
      `c:${sent.id}:e`,
    ]);
    expect(body.components[0].components[0]).toMatchObject({ type: 2, style: 3, label: 'Red team', emoji: { name: '🔴' } });
    expect(body.components[1].components[0]).toMatchObject({ type: 3, custom_id: `c:${sent.id}:f`, min_values: 0, max_values: 2, options: [{ label: 'Red', value: '1' }, { label: 'Blue', value: '2' }] });
    expect(JSON.stringify(body)).not.toContain('actions');
    expect(sent.draft.components).toHaveLength(2);
  });

  it('toggle a role, reply privately, and pick from a menu', async () => {
    expect((await click('a')).replies[0]!.content).toBe(`You now have <@&${RED}>.`);
    expect((await click('a')).replies[0]!.content).toBe(`<@&${RED}> was removed.`);
    expect(discord.roleRemoves.map((r) => r.roleId)).toEqual([RED]);
    expect((await click('e')).replies[0]!.content).toBe('Hi there!');
    const picked = await click('f', MEMBER, { values: ['1', '2'] });
    expect(picked.replies[0]!.content).toBe(`You now have <@&${RED}>.\nYou now have <@&${BLUE}>.`);
    expect(discord.members.get(GUILD)!.get(MEMBER)!.roles.sort()).toEqual([BLUE, RED].sort());
  });

  it('Verify: gives the role; with the join gate on Hold, flagged accounts are refused; paused during a lockdown', async () => {
    expect((await click('b')).replies[0]!.content).toBe('You’re verified. Welcome!');
    expect(discord.roleAdds.at(-1)).toMatchObject({ userId: MEMBER, roleId: VERIFIED, reason: 'Verified with a button' });

    await call('POST', '/api/discord/protection/antiraid', { ...structuredClone(ANTIRAID_DEFAULTS), gate: { enabled: true, minAccountAgeDays: 7, requireAvatar: true, response: 'hold' } });
    const young = idAged(2);
    expect((await click('b', young)).replies[0]!.content).toBe('You can’t verify yet: your account is 2 days old (minimum 7). Please contact a moderator.');
    expect((await click('b', idAged(400), { userHasAvatar: false })).replies[0]!.content).toMatch(/You can’t verify yet: your no profile picture/);

    discord.grantBot(GUILD, (1n << 28n) | (1n << 5n));
    await call('POST', `/api/discord/protection/lockdown/${GUILD}`, {});
    expect((await click('b', idAged(400))).replies[0]!.content).toBe('Verification is paused while the server is locked down. Please try again later.');
    expect(discord.roleAdds.filter((r) => r.roleId === VERIFIED)).toHaveLength(1);
  });

  it('a role above the bot’s, or a click that isn’t from this message, is answered without doing anything', async () => {
    expect((await click('d')).replies[0]!.content).toMatch(/I can’t change that role/);
    expect((await click('a', MEMBER, { messageId: '1999999999999999999' })).replies[0]!.content).toBe('This button isn’t active any more.');
    expect((await click('zz')).replies[0]!.content).toBe('This button isn’t active any more.');
    expect((await click('a', MEMBER, { recordId: '00000000-0000-0000-0000-000000000000' })).replies[0]!.content).toBe('This button isn’t active any more.');
    expect(discord.roleAdds).toEqual([]);
  });

  it('checks buttons and menus before sending', async () => {
    const bad = (components: unknown) => call('POST', '/api/discord/messages', { name: 'x', guildId: GUILD, channelId: GENERAL, draft: draft({ components }) });
    expect((await bad([{ components: [{ id: 'a', kind: 'button', style: 'primary', label: 'Nothing', actions: [] }] }])).status).toBe(400);
    expect((await bad([{ components: [{ id: 'a', kind: 'button', style: 'link', label: 'No link', url: '' }] }])).status).toBe(400);
    expect((await bad([{ components: Array.from({ length: 6 }, (_, i) => ({ id: String(i), kind: 'button', style: 'link', label: 'x', url: 'https://x.test' })) }])).status).toBe(400);
    const selectAndButton = [{ components: [rows()[1]!.components[0], { id: 'z', kind: 'button', style: 'link', label: 'x', url: 'https://x.test' }] }];
    expect((await bad(selectAndButton)).status).toBe(400);
  });
});
