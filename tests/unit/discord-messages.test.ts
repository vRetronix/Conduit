/**
 * Embed Creator JSON: CONDUIT's embeds as Discord's JSON and back, and what can be pasted in.
 */
import { describe, expect, it } from 'vitest';
import {
  componentRowsSchema,
  componentsFromJson,
  componentsToJson,
  EMPTY_EMBED,
  embedFromJson,
  embedToJson,
  messageDraftSchema,
  messageToJson,
  newComponentId,
  parseMessageJson,
} from '@conduit/shared';

const embed = { ...EMPTY_EMBED, authorName: 'Retro', authorIconUrl: 'https://x.test/a.png', title: 'Hi', url: 'https://x.test', description: '{user} joined', color: '#ff8800', fields: [{ name: 'A', value: 'B', inline: true }], imageUrl: 'https://x.test/i.png', footerText: 'Foot', timestamp: true };
const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('embed JSON', () => {
  it('writes Discord’s format, keeping variables, and reads it back unchanged', () => {
    const j = embedToJson(embed, NOW);
    expect(j).toEqual({
      title: 'Hi',
      description: '{user} joined',
      url: 'https://x.test',
      color: 0xff8800,
      author: { name: 'Retro', icon_url: 'https://x.test/a.png' },
      fields: [{ name: 'A', value: 'B', inline: true }],
      image: { url: 'https://x.test/i.png' },
      footer: { text: 'Foot' },
      timestamp: '2026-10-20T12:00:00.000Z',
    });
    expect(embedFromJson(j)).toEqual(embed);
  });

  it('a message round-trips; empty text is null', () => {
    const d = { content: '', embeds: [embed], components: [], externalComponents: false };
    const j = messageToJson(d, NOW);
    expect(j.content).toBeNull();
    const back = parseMessageJson(JSON.stringify(j));
    expect(back.ok && back.draft).toEqual(d);
  });

  it('notes what isn’t kept: no colour, unknown parts, webhook name', () => {
    const notes: string[] = [];
    const e = embedFromJson({ title: 'x', video: { url: 'v' } }, notes);
    expect(e.color).toBe('#2b2d31');
    expect(notes.join(' ')).toMatch(/no colour.*Not kept from an embed: video/);
    const r = parseMessageJson(JSON.stringify({ content: 'x', username: 'Hook', components: [{ type: 1 }], embeds: [{ title: 'a' }, { type: 'link', url: 'https://x' }] }));
    expect(r.ok && r.draft.embeds.map((x) => x.title)).toEqual(['a']);
    expect(r.ok && r.notes.join(' ')).toMatch(/Link previews .* left out.*Not kept \(CONDUIT posts text and embeds only\): username/);
  });
});

describe('pasting', () => {
  it('a single embed, or a list of embeds', () => {
    const single = parseMessageJson('{"title":"Just an embed","color":255}');
    expect(single.ok && single.draft).toMatchObject({ content: '', embeds: [{ title: 'Just an embed', color: '#0000ff' }] });
    const list = parseMessageJson('[{"title":"a"},{"title":"b"}]');
    expect(list.ok && list.draft.embeds.length).toBe(2);
  });

  it('explains what isn’t a message', () => {
    expect(parseMessageJson('')).toEqual({ ok: false, error: 'Paste Discord message or embed JSON.' });
    expect(parseMessageJson('https://example.com/x').ok).toBe(false);
    const bad = parseMessageJson('{nope');
    expect(!bad.ok && bad.error).toMatch(/^That isn’t valid JSON/);
    expect(parseMessageJson('{"foo":1}')).toEqual({ ok: false, error: 'This JSON isn’t a Discord message or embed.' });
  });
});

describe('message drafts', () => {
  it('need text or an embed, at most 10 embeds, and 6000 characters across embeds', () => {
    expect(messageDraftSchema.safeParse({ content: '', embeds: [] }).success).toBe(false);
    expect(messageDraftSchema.safeParse({ content: 'x', embeds: Array.from({ length: 11 }, () => ({ ...EMPTY_EMBED, title: 't' })) }).success).toBe(false);
    const big = { ...EMPTY_EMBED, description: 'x'.repeat(4000) };
    const r = messageDraftSchema.safeParse({ content: '', embeds: [big, big] });
    expect(!r.success && r.error.issues[0]!.message).toBe('All embeds together are at most 6000 characters (now 8000)');
  });
});

describe('buttons and select menus', () => {
  const rows = componentRowsSchema.parse([
    {
      components: [
        { id: 'a', kind: 'button', style: 'success', label: 'Join', emoji: '<:retro:123456789012345678>', actions: [{ type: 'add_role', roleId: '7' }] },
        { id: 'b', kind: 'button', style: 'link', label: 'Site', url: 'https://x.test' },
      ],
    },
    { components: [{ id: 'c', kind: 'select', placeholder: 'Pick', minValues: 1, maxValues: 1, options: [{ id: '1', label: 'One', actions: [{ type: 'reply', content: 'Hi' }] }] }] },
  ]);

  it('as Discord’s JSON: with custom ids when sending, with CONDUIT’s actions in the editor; and back unchanged', () => {
    const sent = componentsToJson(rows, (id) => `c:x:${id}`);
    expect(sent[0]!.components).toEqual([
      { type: 2, style: 3, label: 'Join', emoji: { id: '123456789012345678', name: 'retro' }, custom_id: 'c:x:a' },
      { type: 2, style: 5, label: 'Site', url: 'https://x.test' },
    ]);
    expect(JSON.stringify(sent)).not.toContain('actions');
    const editor = componentsToJson(rows);
    expect(componentsFromJson(editor)).toEqual(rows);
    const draft = messageDraftSchema.parse({ content: 'x', embeds: [], components: rows });
    const back = parseMessageJson(JSON.stringify(messageToJson(draft)));
    expect(back.ok && back.draft.components).toEqual(rows);
  });

  it('checks Discord’s rules: a menu takes a whole row, labels or emoji, links need a URL, buttons need an action', () => {
    const bad = (r: unknown) => componentRowsSchema.safeParse(r).success;
    expect(bad([{ components: [{ id: 'a', kind: 'button', style: 'primary', label: '', actions: [{ type: 'reply', content: 'x' }] }] }])).toBe(false);
    expect(bad([{ components: [{ id: 'a', kind: 'button', style: 'link', label: 'x', url: 'ftp://x' }] }])).toBe(false);
    expect(bad([{ components: [{ id: 'a', kind: 'button', style: 'primary', label: 'x', actions: [] }] }])).toBe(false);
    expect(bad([{ components: [{ id: 'a', kind: 'button', style: 'primary', label: 'x', disabled: true, actions: [] }] }])).toBe(true);
    expect(bad([{ components: [rows[1]!.components[0], rows[0]!.components[1]] }])).toBe(false);
    expect(bad([{ components: [{ ...rows[0]!.components[1]!, id: 'a' }] }, { components: [{ ...rows[0]!.components[1]!, id: 'a' }] }])).toBe(false);
  });

  it('new ids never repeat', () => {
    expect(newComponentId(['1', '2', '4'])).toBe('5');
    expect(newComponentId([])).toBe('1');
  });
});
