/** Pure moderation contracts: target parsing, action and automod validation, Kick scopes. */
import { describe, expect, it } from 'vitest';
import {
  AUTOMOD_DEFAULTS,
  automodSettingsSchema,
  moderationActionSchema,
  parseDiscordMessageLink,
  parseDiscordUser,
} from '@conduit/shared';
import { kickScopes } from '../../apps/server/src/kick/kick';

describe('Discord targets', () => {
  it('accepts a user ID or mention, nothing else', () => {
    expect(parseDiscordUser('123456789012345678')).toBe('123456789012345678');
    expect(parseDiscordUser(' <@123456789012345678> ')).toBe('123456789012345678');
    expect(parseDiscordUser('<@!123456789012345678>')).toBe('123456789012345678');
    for (const bad of ['fan#1234', '@fan', '1234', '<@&123456789012345678>', '123456789012345678 OR 1=1']) expect(parseDiscordUser(bad)).toBeNull();
  });

  it('parses message links from discord.com (and ptb/canary), nothing else', () => {
    expect(parseDiscordMessageLink('https://discord.com/channels/42/500000000000000001/1300000000000000001')).toEqual({
      guildId: '42',
      channelId: '500000000000000001',
      messageId: '1300000000000000001',
    });
    expect(parseDiscordMessageLink('https://canary.discord.com/channels/42/500000000000000001/1300000000000000001')).not.toBeNull();
    for (const bad of ['https://evil.example/channels/42/500000000000000001/1300000000000000001', 'http://discord.com/channels/42/500000000000000001/1', 'https://discord.com/channels/@me/500000000000000001/1300000000000000001'])
      expect(parseDiscordMessageLink(bad)).toBeNull();
  });
});

describe('actions', () => {
  const parse = (v: unknown) => moderationActionSchema.safeParse(v).success;

  it('each platform accepts only its own actions and limits', () => {
    expect(parse({ platform: 'kick', action: 'timeout', userId: '1', username: 'a', durationSeconds: 600 })).toBe(true);
    expect(parse({ platform: 'kick', action: 'untimeout', userId: '1', username: 'a' })).toBe(false);
    expect(parse({ platform: 'kick', action: 'timeout', userId: '1', username: 'a', durationSeconds: 604_860 })).toBe(false);
    expect(parse({ platform: 'discord', action: 'timeout', guildId: '42', userId: '123456789012345678', durationSeconds: 28 * 86_400 })).toBe(true);
    expect(parse({ platform: 'discord', action: 'timeout', guildId: '42', userId: '123456789012345678', durationSeconds: 28 * 86_400 + 1 })).toBe(false);
    expect(parse({ platform: 'discord', action: 'ban', guildId: '42', userId: '123456789012345678', deleteMessageSeconds: 604_801 })).toBe(false);
    expect(parse({ platform: 'discord', action: 'ban', guildId: '42', userId: '123456789012345678', extra: true })).toBe(false);
    expect(parse({ platform: 'discord', action: 'ban', guildId: '42', userId: '123456789012345678', reason: 'line\nbreak' })).toBe(false);
  });
});

describe('automated protection settings', () => {
  it('defaults are off and log-only for every rule', () => {
    expect(AUTOMOD_DEFAULTS.enabled).toBe(false);
    expect([AUTOMOD_DEFAULTS.blockedTerms.action, AUTOMOD_DEFAULTS.repeat.action, AUTOMOD_DEFAULTS.spam.action]).toEqual(['log', 'log', 'log']);
    expect(automodSettingsSchema.parse(AUTOMOD_DEFAULTS)).toEqual(AUTOMOD_DEFAULTS);
  });

  it('normalizes terms (trim, lower case, no duplicates) and bounds everything', () => {
    const s = automodSettingsSchema.parse({ ...AUTOMOD_DEFAULTS, blockedTerms: { ...AUTOMOD_DEFAULTS.blockedTerms, terms: [' Spoiler ', 'spoiler', 'BAD word'] } });
    expect(s.blockedTerms.terms).toEqual(['spoiler', 'bad word']);
    const bad = (patch: object) => automodSettingsSchema.safeParse({ ...AUTOMOD_DEFAULTS, ...patch }).success;
    expect(bad({ blockedTerms: { ...AUTOMOD_DEFAULTS.blockedTerms, terms: Array.from({ length: 201 }, (_, i) => `t${i}`) } })).toBe(false);
    expect(bad({ blockedTerms: { ...AUTOMOD_DEFAULTS.blockedTerms, terms: ['x'.repeat(61)] } })).toBe(false);
    expect(bad({ spam: { ...AUTOMOD_DEFAULTS.spam, maxMessages: 2 } })).toBe(false);
    expect(bad({ repeat: { ...AUTOMOD_DEFAULTS.repeat, timeoutMinutes: 10_081 } })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });
});

describe('Kick scopes', () => {
  it('the main account asks for moderation scopes; the bot account doesn’t', () => {
    expect(kickScopes('primary', 'separate')).toEqual(expect.arrayContaining(['moderation:ban', 'moderation:chat_message:manage']));
    expect(kickScopes('bot', 'separate')).toEqual(['user:read', 'chat:write']);
  });
});

describe('Discord moderation command definitions', () => {
  it('satisfy Discord’s limits and are hidden from members without the permission', async () => {
    const { moderationCommands, validateCommands, commandPayload } = await import('../../apps/server/src/discord/commands');
    const cmds = moderationCommands({ runDiscordCommand: async () => ({ ok: true, message: 'done' }) });
    expect(validateCommands(cmds)).toEqual([]);
    expect(cmds.map((c) => [c.name, commandPayload(c).default_member_permissions, c.ephemeral])).toEqual([
      ['timeout', (1n << 40n).toString(), true],
      ['untimeout', (1n << 40n).toString(), true],
      ['kick', (1n << 1n).toString(), true],
      ['ban', '4', true],
      ['unban', '4', true],
    ]);
  });

  it('a refusal is a failed command (private), never a success reply', async () => {
    const { moderationCommands, CommandError } = await import('../../apps/server/src/discord/commands');
    const [timeout] = moderationCommands({ runDiscordCommand: async () => ({ ok: false, message: 'Discord refused.' }) });
    const ctx = { interactionId: '9001', guildId: '42', userId: '1', userName: 'mod', channelName: null, channelId: null, subcommand: null, optionLabels: new Map<string, string>(), memberPermissions: 1n << 40n, botName: null, options: new Map<string, string | number | boolean>([['user', '123456789012345678'], ['minutes', 5]]) };
    await expect(timeout!.execute(ctx)).rejects.toBeInstanceOf(CommandError);
    await expect(Promise.resolve().then(() => timeout!.execute({ ...ctx, options: new Map<string, string | number | boolean>([['user', '123456789012345678'], ['minutes', 0]]) }))).rejects.toThrow(/Choose 1 to 40320 minutes/);
  });
});
