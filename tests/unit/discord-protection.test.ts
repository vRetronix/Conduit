/**
 * Pure parts of Discord Automated Protection: the message-check text rules, the shared schemas, and how CONDUIT's own
 * AutoMod matches words, wildcards, patterns and allowed words.
 */
import { describe, expect, it } from 'vitest';
import {
  ANTIRAID_DEFAULTS,
  antiraidSchema,
  applyAntiraidPreset,
  joinGateProblem,
  matchingAntiraidPreset,
  snowflakeCreatedAt,
  ANTINUKE_DEFAULTS,
  antinukePreset,
  antinukeSchema,
  automodMatcher,
  automodRuleSchema,
  dangerousPermissionsAdded,
  matchingAntinukePreset,
  MESSAGE_CHECKS_DEFAULTS,
  messageChecksSchema,
  textCheck,
} from '@conduit/shared';
import { describeTrip } from '../../apps/server/src/discord/protection/discord-antinuke';

const on = { ...structuredClone(MESSAGE_CHECKS_DEFAULTS), enabled: true };

describe('textCheck', () => {
  it('finds Discord invite links in their usual forms, not other links', () => {
    for (const t of ['discord.gg/abc', 'join https://discord.com/invite/retro', 'http://www.discordapp.com/invite/x-y']) expect(textCheck(t, on)?.check).toBe('invites');
    expect(textCheck('https://example.com/discord', on)).toBeNull();
  });

  it('caps: only long enough messages, by the share of capital letters', () => {
    expect(textCheck('HELLO THERE FRIENDS', on)).toMatchObject({ check: 'caps', detail: '100% capital letters.' });
    expect(textCheck('LOL OK', on)).toBeNull(); // fewer than 12 letters
    expect(textCheck('Hello There Friends Of Mine', on)).toBeNull();
    expect(textCheck('ПРИВЕТ ВСЕМ ДРУЗЬЯ', on)?.check).toBe('caps'); // any alphabet with case
  });

  it('switched-off checks never match', () => {
    const off = { ...on, caps: { ...on.caps, enabled: false }, invites: { ...on.invites, enabled: false } };
    expect(textCheck('JOIN DISCORD.GG/ABCDEFGHIJ NOW', off)).toBeNull();
  });
});

describe('schemas', () => {
  it('message checks: defaults are valid, off, and log only', () => {
    expect(messageChecksSchema.parse(MESSAGE_CHECKS_DEFAULTS)).toEqual(MESSAGE_CHECKS_DEFAULTS);
    expect(MESSAGE_CHECKS_DEFAULTS.enabled).toBe(false);
    for (const c of ['repeat', 'flood', 'caps', 'invites'] as const) expect(MESSAGE_CHECKS_DEFAULTS[c].action).toBe('log');
    expect(messageChecksSchema.safeParse({ ...on, extra: 1 }).success).toBe(false);
  });

  const rule = (over: Record<string, unknown>) => automodRuleSchema.safeParse({ name: 'R', enabled: true, trigger: 'keyword', keywords: ['bad'], action: 'delete_message', ...over });
  const messages = (r: ReturnType<typeof rule>) => (r.success ? [] : r.error.issues.map((i) => i.message));

  it('AutoMod rules: words or patterns, a mention limit, valid patterns, and only the actions each kind can take', () => {
    expect(rule({}).success).toBe(true);
    expect(rule({}).data).toMatchObject({ timeoutMinutes: 10, alertChannelId: null, exemptModerators: true, exemptRoles: [], exemptChannels: [] });
    expect(messages(rule({ keywords: ['x'.repeat(61)] }))).toContain('Each word is at most 60 characters');
    expect(messages(rule({ keywords: [] }))).toContain('Add at least one word or pattern');
    expect(messages(rule({ regexPatterns: Array.from({ length: 11 }, (_, i) => `a${i}`) }))).toContain('At most 10 patterns');
    expect(messages(rule({ regexPatterns: ['(unclosed'] }))).toContain('Not a valid regular expression: (unclosed');
    expect(messages(rule({ trigger: 'mention_spam', keywords: [] }))).toContain('Set how many mentions are too many');
    expect(messages(rule({ action: 'kick' }))).toContain('Custom words rules can’t do that');
    expect(messages(rule({ trigger: 'member_profile', action: 'delete_message' }))).toContain('Member names rules can’t do that');
    expect(rule({ trigger: 'member_profile', action: 'kick' }).success).toBe(true);
    // Discord's own kinds aren't CONDUIT's.
    for (const trigger of ['spam', 'keyword_preset']) expect(rule({ trigger }).success).toBe(false);
  });
});

describe('AutoMod matching (CONDUIT’s own)', () => {
  const m = (r: { keywords?: string[]; regexPatterns?: string[]; allowList?: string[] }) => automodMatcher({ keywords: [], regexPatterns: [], allowList: [], ...r });

  it('words are whole words unless * says otherwise, like Discord’s AutoMod', () => {
    expect(m({ keywords: ['cat'] }).match('my cat is here')).toBe('cat');
    expect(m({ keywords: ['cat'] }).match('concatenate')).toBeNull();
    expect(m({ keywords: ['cat*'] }).match('catalog')).toBe('cat*');
    expect(m({ keywords: ['cat*'] }).match('bobcat')).toBeNull();
    expect(m({ keywords: ['*cat'] }).match('bobcat')).toBe('*cat');
    expect(m({ keywords: ['*cat*'] }).match('concatenate')).toBe('*cat*');
    expect(m({ keywords: ['buy now'] }).match('please BUY   NOW!')).toBe('buy now');
  });

  it('capital letters and fancy fonts don’t matter; links can be listed', () => {
    expect(m({ keywords: ['spam'] }).match('SPAM')).toBe('spam');
    expect(m({ keywords: ['spam'] }).match('𝐬𝐩𝐚𝐦')).toBe('spam'); // mathematical bold letters
    expect(m({ keywords: ['discord.gg/*'] }).match('join discord.gg/abc')).toBe('discord.gg/*');
  });

  it('regular expressions match, and allowed words never count', () => {
    expect(m({ regexPatterns: ['fr[e3]{2}\\s*nitro'] }).match('get FRE3 nitro here')).toBe('fr[e3]{2}\\s*nitro');
    const r = m({ keywords: ['*ass*'], allowList: ['class', 'assist'] });
    expect(r.match('the class will assist you')).toBeNull();
    expect(r.match('what a pain in the ass')).toBe('*ass*');
  });
});

describe('anti-nuke', () => {
  it('defaults: off, alert only, balanced preset, valid', () => {
    expect(antinukeSchema.parse(ANTINUKE_DEFAULTS)).toEqual(ANTINUKE_DEFAULTS);
    expect(ANTINUKE_DEFAULTS).toMatchObject({ enabled: false, mode: 'alert', response: 'quarantine', alertChannel: null });
    expect(matchingAntinukePreset(ANTINUKE_DEFAULTS.rules)).toBe('balanced');
    expect(matchingAntinukePreset({ ...antinukePreset('strict'), ban: { enabled: true, threshold: 9, windowSeconds: 60 } })).toBeNull();
  });

  it('presets go from lenient to strict', () => {
    const l = antinukePreset('lenient');
    const s = antinukePreset('strict');
    for (const r of Object.keys(l) as Array<keyof typeof l>) expect(s[r].threshold).toBeLessThanOrEqual(l[r].threshold);
  });

  it('dangerous permissions: only ones that were added count', () => {
    const admin = String(1n << 3n);
    const ban = String(1n << 2n);
    expect(dangerousPermissionsAdded('0', admin)).toEqual(['Administrator']);
    expect(dangerousPermissionsAdded(admin, admin)).toEqual([]);
    expect(dangerousPermissionsAdded(admin, String((1n << 3n) | (1n << 2n) | (1n << 10n)))).toEqual(['Ban Members']);
    expect(dangerousPermissionsAdded(ban, '0')).toEqual([]);
    expect(dangerousPermissionsAdded(null, 'not a number')).toEqual([]);
  });

  it('describes a trip with the count, window, names and permissions', () => {
    expect(describeTrip('channel_delete', [{ targetName: 'a', permissions: [] }, { targetName: 'b', permissions: [] }], 60)).toBe('2 channels deleted within 60 s: a, b.');
    expect(describeTrip('role_update', [{ targetName: 'Mods', permissions: ['Administrator'] }], 60)).toBe('1 role given dangerous permissions within 60 s: Mods (Administrator).');
    expect(describeTrip('prune', [{ targetName: null, permissions: [] }], 600)).toBe('1 prune within 600 s.');
  });
});

describe('anti-raid', () => {
  it('defaults: off, alert only, gate off, valid; presets are recognised', () => {
    expect(antiraidSchema.parse(ANTIRAID_DEFAULTS)).toEqual(ANTIRAID_DEFAULTS);
    expect(ANTIRAID_DEFAULTS).toMatchObject({ enabled: false, mode: 'alert', gate: { enabled: false, response: 'alert' } });
    expect(ANTIRAID_DEFAULTS).not.toHaveProperty('verify');
    expect(matchingAntiraidPreset(ANTIRAID_DEFAULTS)).toBe('balanced');
    const strict = applyAntiraidPreset(ANTIRAID_DEFAULTS, 'strict');
    expect(strict).toMatchObject({ joinThreshold: 5, gate: { minAccountAgeDays: 30, requireAvatar: true } });
    expect(matchingAntiraidPreset(strict)).toBe('strict');
    expect(matchingAntiraidPreset({ ...strict, joinThreshold: 6 })).toBeNull();
  });

  it('reads an account’s creation time from its id', () => {
    expect(snowflakeCreatedAt('175928847299117063')?.toISOString()).toBe('2016-04-30T11:18:25.796Z');
    expect(snowflakeCreatedAt('nope')).toBeNull();
  });

  it('join gate: account age and profile picture', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const gate = { enabled: true, minAccountAgeDays: 7, requireAvatar: true, response: 'alert' as const };
    expect(joinGateProblem(gate, { createdAt: new Date('2026-10-17T12:00:00Z'), hasAvatar: true }, now)).toBe('account is 1 day old (minimum 7)');
    expect(joinGateProblem(gate, { createdAt: new Date('2026-01-01T00:00:00Z'), hasAvatar: false }, now)).toBe('no profile picture');
    expect(joinGateProblem(gate, { createdAt: new Date('2026-10-18T00:00:00Z'), hasAvatar: false }, now)).toBe('account is 0 days old (minimum 7); no profile picture');
    expect(joinGateProblem(gate, { createdAt: new Date('2026-01-01T00:00:00Z'), hasAvatar: true }, now)).toBeNull();
    // Unknown avatar never counts against them.
    expect(joinGateProblem(gate, { createdAt: null, hasAvatar: null }, now)).toBeNull();
  });
});
