import { describe, expect, it } from 'vitest';
import { migrate, migrations, openDatabase } from '@conduit/database';
import { fitToPlatform, renderTemplate, responseSchema, triggerSchema, unknownVariables } from '@conduit/shared';

describe('renderTemplate', () => {
  it('fills in known variables from the event', () => {
    expect(renderTemplate('Hello {user}, welcome to {channel}!', { user: 'RetroFan', channel: 'retronix' }, 'kick')).toBe(
      'Hello RetroFan, welcome to retronix!',
    );
  });

  it('missing values become empty, and extra spaces are tidied', () => {
    expect(renderTemplate('Go follow {args} now', { args: '' }, 'kick')).toBe('Go follow now');
    expect(renderTemplate('In {channel}.', {}, 'discord')).toBe('In .');
  });

  it('leaves unknown placeholders exactly as written, and never crashes on odd braces', () => {
    expect(renderTemplate('Bye {{sender.username} {} {user', { user: 'x' }, 'kick')).toBe('Bye {{sender.username} {} {user');
  });

  it('inserts values once: a value that looks like a variable stays literal (no recursion)', () => {
    expect(renderTemplate('{user}: {args}', { user: '{args}', args: '{user}' }, 'kick')).toBe('{args}: {user}');
  });

  it('cleans values: control characters and newlines can’t break the one-line reply', () => {
    expect(renderTemplate('[{args}]', { args: 'a\n\u0007b\t c' }, 'kick')).toBe('[a b c]');
  });

  it('fits each platform’s limit after substitution', () => {
    const kick = renderTemplate('{args}', { args: 'é'.repeat(400) + 'z'.repeat(400) }, 'kick');
    expect([...new Intl.Segmenter().segment(kick)].length).toBeLessThanOrEqual(500);
    const discord = fitToPlatform('x'.repeat(2500), 'discord');
    expect(discord.length).toBe(2000);
    expect(discord.endsWith('…')).toBe(true);
    expect(fitToPlatform('short', 'kick')).toBe('short');
  });

  it('Discord replies keep their markdown: line breaks, indentation and code stay exactly as written', () => {
    const template = '# Rules for {user}\n> be kind  {args}\n- one\n  - nested\n```\na    b\n```\n`x  y` and  {args}  done   ';
    expect(renderTemplate(template, { user: 'RetroFan', args: '' }, 'discord')).toBe(
      '# Rules for RetroFan\n> be kind\n- one\n  - nested\n```\na    b\n```\n`x  y` and done',
    );
    // A typed value is still one line, so it can't add headings or quotes of its own.
    expect(renderTemplate('Said: {args}', { args: 'hi\n# big' }, 'discord')).toBe('Said: hi # big');
  });
});

describe('command rules', () => {
  it('normalizes triggers per platform', () => {
    expect(triggerSchema('kick').parse('!HeLLo')).toBe('!hello');
    expect(triggerSchema('discord').parse('Hello')).toBe('/hello');
    expect(triggerSchema('discord').safeParse('/ping').success).toBe(false);
    expect(triggerSchema('kick').safeParse('hello').success).toBe(false);
  });

  it('lists unknown placeholders; stored templates may keep them, new ones may not', () => {
    expect(unknownVariables('Hi {user} {name} {sender.username} {user}')).toEqual(['{name}', '{sender.username}']);
    expect(responseSchema('kick').safeParse('Hi {name}').success).toBe(false);
    expect(responseSchema('kick', true).safeParse('Hi {name}').success).toBe(true);
    expect(responseSchema('discord').safeParse('/no leading slash rule on Discord').success).toBe(true);
    expect(responseSchema('kick').safeParse('/ban x').success).toBe(false);
  });

  it('Discord responses may span lines (Windows line breaks are stored as \\n); Kick responses stay one line', () => {
    expect(responseSchema('discord').parse('**Rules**\r\n- be kind\r\n- have fun')).toBe('**Rules**\n- be kind\n- have fun');
    expect(responseSchema('discord').safeParse('tab\there').success).toBe(false);
    expect(responseSchema('discord').safeParse('bell\u0007').success).toBe(false);
    expect(responseSchema('kick').safeParse('two\nlines').success).toBe(false);
  });
});

describe('migration 10 (commands for Discord and Kick)', () => {
  it('keeps existing Kick commands exactly, and adds Discord support', () => {
    const db = openDatabase(':memory:');
    migrate(db, migrations.slice(0, 9));
    db.prepare(
      "INSERT INTO chat_commands (id, platform, trigger, response, enabled, created_at, updated_at) VALUES ('k1', 'kick', '!vanish', 'Bye {{sender.username}', 0, '2026-10-11T17:30:00Z', '2026-10-11T17:31:00Z')",
    ).run();
    expect(migrate(db, migrations)).toEqual({ applied: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(
      db.prepare('SELECT id, platform, trigger, description, response, enabled, created_at, updated_at FROM chat_commands').all(),
    ).toEqual([
      {
        id: 'k1',
        platform: 'kick',
        trigger: '!vanish',
        description: null,
        response: 'Bye {{sender.username}',
        enabled: 0,
        created_at: '2026-10-11T17:30:00Z',
        updated_at: '2026-10-11T17:31:00Z',
      },
    ]);
    const insert = (id: string, platform: string, trigger: string, description: string | null) =>
      db
        .prepare(
          'INSERT INTO chat_commands (id, platform, trigger, description, response, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        )
        .run(id, platform, trigger, description, 'x', 't', 't');
    insert('d1', 'discord', '/hello', 'Say hi');
    expect(() => insert('d2', 'discord', '/nodesc', null)).toThrow(/CHECK/); // Discord needs a description
    expect(() => insert('d3', 'discord', '!wrong', 'x')).toThrow(/CHECK/);
    expect(() => insert('k2', 'kick', '/wrong', null)).toThrow(/CHECK/);
    expect(() => insert('y1', 'youtube', '!x', null)).toThrow(/CHECK/);
    insert('k3', 'kick', '/hello'.replace('/', '!'), null); // same name on another platform is fine
    db.close();
  });
});
