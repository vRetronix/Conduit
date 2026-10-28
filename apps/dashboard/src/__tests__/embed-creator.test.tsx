// Discord → Embed Creator and the JSON option of every embed editor, rendered without a browser (react-dom/server).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import type { PostedMessageView } from '@conduit/shared/discord/discord-messages';
import { EMPTY_EMBED } from '@conduit/shared/discord/embeds';

const never = () => new Promise<never>(() => {});
const stubBridge: ConduitBridge = {
  getAppInfo: never,
  getBackendStatus: never,
  onBackendStatus: () => () => {},
  api: { request: never },
  connections: { connect: never },
  kick: { openDeveloperSettings: () => new Promise(() => {}) },
  discord: { installBot: never, openPortal: never },
};

const g = globalThis as { window?: unknown };
beforeEach(() => {
  vi.resetModules();
  g.window = { conduit: stubBridge };
});
afterEach(() => {
  delete g.window;
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sections = (html: string) => [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1]);

const posted = (over: Partial<PostedMessageView> = {}): PostedMessageView => ({
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Rules',
  guildId: '42',
  channelId: '5',
  messageId: '9',
  place: 'Retro Server',
  channelName: 'rules',
  draft: { content: 'Hi', embeds: [{ ...EMPTY_EMBED, title: 'Rules' }], components: [], externalComponents: false },
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T11:00:00Z',
  link: 'https://discord.com/channels/42/5/9',
  ...over,
});

describe('Embed Creator page', () => {
  it('loads messages by link, edits a new message with embed tabs, and lists messages that can be edited later', async () => {
    const { EmbedCreatorView } = await import('../pages/discord/EmbedCreatorPage');
    const html = renderToStaticMarkup(
      <EmbedCreatorView messages={[posted(), posted({ id: '00000000-0000-0000-0000-000000000002', name: 'Roles', channelName: 'roles' })]} />,
    );
    const t = text(html);
    expect(sections(html)).toEqual(['New message', 'Embeds']);
    expect(html).not.toContain('aria-label="Message link"');
    // Whole-message Visual / JSON switch; the embed editor's own switch is hidden here.
    expect(html.match(/role="tab"[^>]*>Visual</g)).toHaveLength(1);
    expect(t).toMatch(/Embed 1 \+ Add embed Remove embed 1/);
    expect(t).toContain('Send as the bot');
    // The name is the library name; the embed editor's own library controls are hidden (saving is automatic).
    expect(t).toContain('Its embeds are saved to the library under this name.');
    expect(html).not.toContain('aria-label="Open a saved embed"');
    expect(html).not.toContain('aria-label="Save as"');
    expect(t).toMatch(/Rules .* #rules Retro Server .* Edit Copy link Remove/);
    expect(t).toMatch(/Roles .* #roles /);
    expect(t).not.toMatch(/Discohook|webhook/i);
  });

  it('is in the Discord sidebar group', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.find((s) => s.id === 'embed-creator')).toMatchObject({ label: 'Embed Creator', group: 'discord', phase: null });
  });
});

describe('embed fields editor', () => {
  it('one labelled card per field: Name, Inline and a big Value box, with move, duplicate and remove', async () => {
    const { EmbedEditor } = await import('../components/discord/EmbedEditor');
    const fields = [
      { name: 'Rule 1', value: 'Be kind', inline: false },
      { name: '', value: '', inline: true },
    ];
    const html = renderToStaticMarkup(<EmbedEditor value={{ ...EMPTY_EMBED, fields }} onChange={() => {}} json={false} />);
    expect(html.match(/class="embed-field-card"/g)).toHaveLength(2);
    expect(text(html)).toContain('Field 1 – Rule 1');
    expect(text(html)).toMatch(/Field 2 ↑/);
    expect(text(html)).toMatch(/Name 6\/256 .*Inline .*Value 7\/1024/);
    expect(html).toMatch(/<textarea aria-label="Field 1 value" rows="4">Be kind<\/textarea>/);
    const button = (label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
    expect(button('Move field 1 up')).toContain('disabled=""');
    expect(button('Move field 2 down')).toContain('disabled=""');
    expect(button('Move field 1 down')).not.toContain('disabled');
    for (const label of ['Duplicate field 1', 'Remove field 2']) expect(html).toContain(`aria-label="${label}"`);
  });
});

describe('every embed editor has a JSON option', () => {
  it('shows a Visual / JSON switch (and can hide it)', async () => {
    const { EmbedEditor } = await import('../components/discord/EmbedEditor');
    const html = renderToStaticMarkup(<EmbedEditor value={{ ...EMPTY_EMBED, title: 'x' }} onChange={() => {}} />);
    expect(html).toMatch(/role="tab" aria-selected="true" class="editor-mode-tab active">Visual<\/button><button type="button" role="tab" aria-selected="false" class="editor-mode-tab">JSON</);
    const hidden = renderToStaticMarkup(<EmbedEditor value={{ ...EMPTY_EMBED, title: 'x' }} onChange={() => {}} json={false} />);
    expect(hidden).not.toContain('editor-mode-tab');
  });

  it('the JSON box shows Discord’s JSON and can be copied', async () => {
    const { JsonEditor } = await import('../components/discord/EmbedEditor');
    const html = renderToStaticMarkup(<JsonEditor label="Embed JSON" initialText={'{\n  "title": "x"\n}'} single onDraft={() => {}} />);
    expect(html).toContain('class="json-text"');
    expect(html).toContain('&quot;title&quot;: &quot;x&quot;');
    expect(text(html)).toContain('Copy JSON');
    expect(text(html)).toContain('Discord’s message JSON: paste a whole message, one embed or a list of embeds.');
  });
});

describe('Embed Creator loading', () => {
  it('the editor shows straight away; only the Embeds list waits', async () => {
    const { EmbedCreatorView } = await import('../pages/discord/EmbedCreatorPage');
    const t = text(renderToStaticMarkup(<EmbedCreatorView messages={null} />));
    expect(t).toMatch(/New message .* Send as the bot .* Embeds .* Loading embeds…/);
  });
});

describe('Embed Creator buttons and menus', () => {
  it('rows of buttons or a select menu, each with actions; shown in the preview', async () => {
    const { EmbedCreatorView } = await import('../pages/discord/EmbedCreatorPage');
    const { ComponentsEditor } = await import('../components/discord/ComponentsEditor');
    const rows = [
      { components: [{ id: 'a', kind: 'button' as const, style: 'success' as const, label: 'Join', emoji: '✅', url: '', disabled: false, actions: [{ type: 'verify' as const, roleId: '7' }] }] },
      {
        components: [
          { id: 'b', kind: 'select' as const, placeholder: 'Pick a team', minValues: 1, maxValues: 1, disabled: false, options: [{ id: '1', label: 'Red', description: '', emoji: '', actions: [{ type: 'reply' as const, content: 'Hi' }] }] },
        ],
      },
    ];
    const editor = text(renderToStaticMarkup(<ComponentsEditor rows={rows} onChange={() => {}} />));
    expect(editor).toMatch(/Buttons &amp; Menus Row 1 \+ Button Remove row Style .* Green .* Label .* When clicked .* Verify \(join gate checks, then a role\)/);
    expect(editor).toMatch(/Row 2 Remove row Menu placeholder .* Option 1 .* When chosen .* Reply privately/);
    expect(editor).toContain('+ Buttons');
    expect(editor).toContain('+ Select Menu');
    const empty = text(renderToStaticMarkup(<ComponentsEditor rows={[]} onChange={() => {}} />));
    expect(empty).toContain('No buttons yet.');
    const page = renderToStaticMarkup(<EmbedCreatorView messages={[posted({ draft: { content: 'Hi', embeds: [{ ...EMPTY_EMBED, title: 'x' }], components: rows, externalComponents: false } })]} />);
    expect(text(page)).toContain('Buttons &amp; Menus');
  });

  it('another feature’s buttons are left alone', async () => {
    const { EmbedPreview } = await import('../components/discord/EmbedEditor');
    const html = renderToStaticMarkup(
      <EmbedPreview
        embed={null}
        content="x"
        components={[{ components: [{ id: 'a', kind: 'button', style: 'danger', label: 'Leave', emoji: '', url: '', disabled: true, actions: [] }] }]}
      />,
    );
    expect(html).toContain('class="dp-button dp-button-danger is-disabled"');
  });
});
