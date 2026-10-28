/** The shared embed model: Discord's limits, filling variables, and safe output. */
import { describe, expect, it } from 'vitest';
import { describeSchedule, EMPTY_EMBED, embedSchema, missingDiscordPermissions, toDiscordEmbed } from '@conduit/shared';

describe('embeds', () => {
  it('validates Discord’s limits, including the 6000-character total and 25 fields', () => {
    const bad = (e: object) => embedSchema.safeParse({ ...EMPTY_EMBED, title: 'x', ...e }).success;
    expect(bad({ title: 'x'.repeat(257) })).toBe(false);
    expect(bad({ fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b', inline: false })) })).toBe(false);
    expect(bad({ description: 'x'.repeat(4096), fields: Array.from({ length: 2 }, () => ({ name: 'a', value: 'x'.repeat(1024), inline: false })) })).toBe(false);
    expect(bad({ imageUrl: 'ftp://x' })).toBe(false);
    expect(bad({ imageUrl: '{thumbnail}' })).toBe(true);
    expect(embedSchema.safeParse(EMPTY_EMBED).success).toBe(false); // empty
  });

  it('fills variables, cuts to limits after filling, and drops links that aren’t http(s)', () => {
    const out = toDiscordEmbed(
      { ...EMPTY_EMBED, title: '{title}', url: '{url}', imageUrl: '{thumbnail}', thumbnailUrl: '{avatar}', color: '#53FC18', fields: [{ name: 'Category', value: '{category}', inline: true }], timestamp: true },
      { title: 'x'.repeat(400), url: 'https://kick.com/a', thumbnail: '', avatar: 'javascript:alert(1)', category: 'Games' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect((out.title as string).length).toBe(256);
    expect(out).toMatchObject({ url: 'https://kick.com/a', color: 0x53fc18, fields: [{ name: 'Category', value: 'Games', inline: true }], timestamp: '2026-01-01T00:00:00.000Z' });
    expect(out.image).toBeUndefined();
    expect(out.thumbnail).toBeUndefined();
  });

  it('reports missing channel permissions by name', () => {
    expect(missingDiscordPermissions(String((1n << 10n) | (1n << 11n)), ['viewChannel', 'sendMessages', 'readMessageHistory'])).toEqual(['Read Message History']);
    expect(missingDiscordPermissions(undefined, ['viewChannel'])).toEqual(['View Channel']);
  });

  it('describes schedules in plain English', () => {
    expect(describeSchedule({ intervalMinutes: 30, messageCount: null, combine: 'all' })).toBe('every 30 minutes');
    expect(describeSchedule({ intervalMinutes: null, messageCount: 20, combine: 'all' })).toBe('after 20 chat messages');
    expect(describeSchedule({ intervalMinutes: 15, messageCount: 10, combine: 'any' })).toBe('every 15 minutes or after 10 chat messages, whichever comes first');
  });
});

describe('variable casing', () => {
  it('fillTemplate fills known variables whatever their capitalisation; unknown ones stay', async () => {
    const { fillTemplate, canonicalVariables } = await import('@conduit/shared/discord/embeds');
    expect(fillTemplate('{Streamer} / {STREAMER} / {streamer} / {Nope}', { streamer: 'xQc' })).toBe('xQc / xQc / xQc / {Nope}');
    expect(canonicalVariables('{Streamer} {TITLE} {Nope}', ['streamer', 'title'])).toBe('{streamer} {title} {Nope}');
  });
});
