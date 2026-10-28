/**
 * Pure parts of Discord giveaways: the bot's channel permissions, button ids, the embed and its buttons, and error
 * messages.
 */
import { describe, expect, it } from 'vitest';
import type { GiveawayRecord, GiveawayWinnerRecord } from '@conduit/database';
import { DISCORD_INSTALL_PERMISSIONS } from '@conduit/shared';
import { DiscordApiError } from '../../apps/server/src/discord/discord-api';
import { BOT_INTENTS } from '../../apps/server/src/discord/discord-bot';
import {
  channelPermissions,
  describe as describeFailure,
  giveawayButtonId,
  giveawayMessage,
  missingPermissions,
  parseGiveawayButtonId,
} from '../../apps/server/src/discord/discord-giveaways';

const G = '42';
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const EMBED = 1n << 14n;
const REACT = 1n << 6n;
const HISTORY = 1n << 16n;
const ALL = VIEW | SEND | EMBED;

describe('bot permissions and intents', () => {
  it('the add-bot link requests the permissions CONDUIT uses (incl. the giveaway ones), never Administrator', () => {
    expect(DISCORD_INSTALL_PERMISSIONS).toBe('1099780320502');
    const p = BigInt(DISCORD_INSTALL_PERMISSIONS);
    expect(p & ALL).toBe(ALL);
    expect(p & (REACT | HISTORY)).toBe(REACT | HISTORY);
    for (const bit of [1n << 7n, 1n << 13n, 1n << 15n, 1n << 17n, 1n << 2n, 1n << 28n, 1n << 40n]) expect(p & bit).toBe(bit);
    expect(p & (1n << 3n)).toBe(0n); // Administrator
    expect(p & (1n << 4n)).toBe(1n << 4n); // Manage Channels (/slowmode, /lock, /unlock, /logging setup)
    expect(p & (1n << 1n)).toBe(1n << 1n); // Kick Members (protection responses)
    expect(p & (1n << 5n)).toBe(1n << 5n); // Manage Server (Discord AutoMod rules)
  });

  it('uses three non-privileged intents and the three required privileged ones (buttons are interactions; no reaction intent)', () => {
    expect(BOT_INTENTS).toEqual([
      { name: 'Guilds', privileged: false },
      { name: 'Guild Messages', privileged: false },
      { name: 'Guild Moderation', privileged: false },
      { name: 'Server Members', privileged: true },
      { name: 'Message Content', privileged: true },
      { name: 'Presence', privileged: true },
    ]);
  });
});

describe('channelPermissions (Discord’s algorithm)', () => {
  const perms = (o: Partial<Parameters<typeof channelPermissions>[0]>) =>
    channelPermissions({ guildId: G, userId: 'bot', roles: [{ id: G, permissions: ALL }], memberRoleIds: [], overwrites: [], ...o });

  it('starts from @everyone plus the member’s roles', () => {
    expect(missingPermissions(perms({}))).toEqual([]);
    expect(missingPermissions(perms({ roles: [{ id: G, permissions: VIEW }] }))).toEqual(['Send Messages', 'Embed Links']);
    expect(missingPermissions(perms({ roles: [{ id: G, permissions: VIEW }, { id: 'r1', permissions: ALL }], memberRoleIds: ['r1'] }))).toEqual([]);
  });

  it('Administrator grants everything, overwrites included', () => {
    const admin = perms({ roles: [{ id: G, permissions: 0n }, { id: 'a', permissions: 1n << 3n }], memberRoleIds: ['a'], overwrites: [{ id: G, type: 0, allow: 0n, deny: ALL }] });
    expect(missingPermissions(admin)).toEqual([]);
  });

  it('applies @everyone, then role, then member overwrites', () => {
    const everyoneDenies = [{ id: G, type: 0, allow: 0n, deny: SEND }];
    expect(missingPermissions(perms({ overwrites: everyoneDenies }))).toEqual(['Send Messages']);
    // A role overwrite re-allows what @everyone denied…
    expect(missingPermissions(perms({ memberRoleIds: ['r1'], overwrites: [...everyoneDenies, { id: 'r1', type: 0, allow: SEND, deny: 0n }] }))).toEqual([]);
    // …role overwrites only count for the member's roles…
    expect(missingPermissions(perms({ overwrites: [...everyoneDenies, { id: 'r2', type: 0, allow: SEND, deny: 0n }] }))).toEqual(['Send Messages']);
    // …and a member overwrite wins over both.
    const memberDenies = { id: 'bot', type: 1, allow: 0n, deny: EMBED };
    expect(missingPermissions(perms({ memberRoleIds: ['r1'], overwrites: [{ id: 'r1', type: 0, allow: EMBED, deny: 0n }, memberDenies] }))).toEqual(['Embed Links']);
  });
});

describe('button custom ids', () => {
  const id = 'aaaaaaaa-2222-4333-8444-5555555555bb';

  it('carry only the giveaway id (Enter is the only action)', () => {
    expect(giveawayButtonId(id)).toBe(`giveaway:enter:${id}`);
    expect(parseGiveawayButtonId(giveawayButtonId(id))).toEqual({ giveawayId: id });
  });

  it.each([
    ['another action', `giveaway:delete:${id}`],
    ['the removed leave action', `giveaway:leave:${id}`],
    ['extra parts', `giveaway:enter:${id}:x`],
    ['not a uuid', 'giveaway:enter:1 OR 1=1'],
    ['upper-case id', `giveaway:enter:${id.toUpperCase()}`],
    ['another prefix', `poll:enter:${id}`],
    ['too long', `giveaway:enter:${id}${'x'.repeat(100)}`],
    ['not a string', 42],
  ])('rejects %s', (_label, raw) => {
    expect(parseGiveawayButtonId(raw)).toBeNull();
  });
});

describe('the embed', () => {
  const base: GiveawayRecord = {
    id: 'g',
    prize: 'Nitro',
    description: null,
    status: 'open',
    winnerCount: 1,
    durationMinutes: null,
    allowKick: true,
    allowDiscord: true,
    createdAt: '2026-10-11T18:00:00.000Z',
    updatedAt: '2026-10-11T18:00:00.000Z',
    startedAt: '2026-10-11T18:00:00.000Z',
    endsAt: null,
    closedAt: null,
    drawnAt: null,
    cancelledAt: null,
    announceAt: null,
    announceKind: null,
    announceOutcome: null,
    announceDetail: null,
    discordGuildId: '42',
    discordChannelId: '5',
    discordChannelName: 'giveaways',
    discordMessageId: null,
    discordStatus: null,
    discordDetail: null,
    discordUpdatedAt: null,
    kickRewardCost: null,
    kickRewardTickets: null,
    kickRewardTitle: null,
    kickRewardId: null,
    kickRewardStatus: null,
    kickRewardDetail: null,
    subscriberMultiplier: 1,
  };
  const winner = (n: number, over: Partial<GiveawayWinnerRecord> = {}): GiveawayWinnerRecord => ({
    id: `w${n}`,
    giveawayId: 'g',
    drawId: 'd',
    entryId: n,
    position: n,
    status: 'won',
    selectedAt: 'x',
    replacedAt: null,
    platform: 'discord',
    platformUserId: `90000000000000000${n}`,
    displayName: `fan${n}`,
    ...over,
  });
  const fields = (m: ReturnType<typeof giveawayMessage>) => Object.fromEntries((m.embeds[0] as { fields: Array<{ name: string; value: string }> }).fields.map((f) => [f.name, f.value]));

  it('never pings anyone, and carries no app branding', () => {
    const m = giveawayMessage(base, { winners: [] });
    expect(m.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(m)).not.toMatch(/CONDUIT/);
  });

  it('has only the Enter Giveaway button (no Leave), enabled only while entries are open', () => {
    const rows = (status: GiveawayRecord['status']) =>
      (giveawayMessage({ ...base, status }, { winners: [] }).components as Array<{ components: Array<{ label: string; disabled: boolean; custom_id: string }> }>)[0]!.components;
    expect(rows('open').map((b) => [b.label, b.disabled, b.custom_id])).toEqual([['Enter Giveaway', false, 'giveaway:enter:g']]);
    for (const status of ['closed', 'drawn', 'cancelled'] as const) {
      expect(rows(status).map((b) => [b.label, b.disabled])).toEqual([['Enter Giveaway', true]]);
      expect(JSON.stringify(giveawayMessage({ ...base, status }, { winners: [] }))).not.toMatch(/Leave|Kick|!enter|kick\.com/);
    }
  });

  it('open: explains the Enter Giveaway button only (never Kick or !enter), no entries, no end time', () => {
    expect(base.allowKick).toBe(true); // a giveaway that also takes Kick entries
    const m = giveawayMessage(base, { winners: [] });
    const f = fields(m);
    expect(f['How to enter']).toBe('Click **🎉 Enter Giveaway** below.');
    expect(JSON.stringify(m)).not.toMatch(/Kick|!enter|kick\.com|retronix|Leave/);
    expect(f.Entries).toBeUndefined(); // never public: no entry or ticket counts
    expect(f.Closes).toBe('When the host ends it');
    expect(f.Winners).toBe('1');
    expect(fields(giveawayMessage({ ...base, allowKick: false }, { winners: [] }))['How to enter']).toBe('Click **🎉 Enter Giveaway** below.');
  });

  it('drawn: current winners as mentions (Kick winners by name), replaced ones left out, bounded', () => {
    const drawn = { ...base, status: 'drawn' as const, drawnAt: '2026-10-11T19:00:00.000Z' };
    const m = giveawayMessage(drawn, {
      winners: [winner(1, { status: 'replaced', replacedAt: 'y' }), winner(1, { id: 'w9', platformUserId: '900000000000000009' }), winner(2, { platform: 'kick', displayName: 'kickfan' })],
    });
    expect(fields(m)['🏆 Winners']).toBe('1. <@900000000000000009>\n2. kickfan (Kick)');
    expect(fields(m).Note).toBe('Some winners were redrawn by the host.');
    const many = Array.from({ length: 50 }, (_, i) => winner(i + 1, { platform: 'kick', displayName: 'x'.repeat(100) }));
    const big = fields(giveawayMessage(drawn, { winners: many }))['🏆 Winners']!;
    expect(big.length).toBeLessThanOrEqual(1024);
    expect(big).toMatch(/… and \d+ more$/);
  });

  it('cancelled and closed states say so', () => {
    expect((giveawayMessage({ ...base, status: 'cancelled' }, { winners: [] }).embeds[0] as { description: string }).description).toBe(
      '**This giveaway was cancelled.**',
    );
    expect((giveawayMessage({ ...base, status: 'closed' }, { winners: [] }).embeds[0] as { description: string }).description).toMatch(
      /Entries are closed/,
    );
  });
});

describe('failure messages say what to do', () => {
  it.each([
    [new DiscordApiError('forbidden', 'x', undefined, 50013), 'failed', /missing permissions in #giveaways/],
    [new DiscordApiError('forbidden', 'x', undefined, 50001), 'failed', /can’t access #giveaways/],
    [new DiscordApiError('not_found', 'x', undefined, 10008), 'missing', /message was deleted.*Repost/],
    [new DiscordApiError('not_found', 'x', undefined, 10003), 'missing', /#giveaways no longer exists/],
    [new DiscordApiError('not_found', 'x', undefined, 10004), 'missing', /no longer in that Discord server/],
    [new DiscordApiError('invalid_credentials', 'x'), 'failed', /rejected the bot token/],
    [new DiscordApiError('network', 'x'), 'failed', /Couldn’t reach Discord/],
    [new DiscordApiError('rate_limited', 'x', 3), 'failed', /slow down/],
  ])('%s', (err, status, message) => {
    const d = describeFailure(err, 'giveaways');
    expect(d.status).toBe(status);
    expect(d.detail).toMatch(message);
  });
});
