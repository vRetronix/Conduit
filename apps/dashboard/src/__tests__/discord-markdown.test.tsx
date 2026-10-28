// Discord markdown in the previews, rendered without a browser (react-dom/server).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiscordMarkdown } from '../components/discord/DiscordMarkdown';
import { EmbedPreview } from '../components/discord/EmbedEditor';
import { EMPTY_EMBED } from '@conduit/shared/discord/embeds';

const md = (text: string, inline = false) => renderToStaticMarkup(<DiscordMarkdown text={text} inline={inline} />);

describe('Discord markdown', () => {
  it('bold, italic, underline, strikethrough, spoilers and inline code', () => {
    expect(md('**b** *i* _i2_ __u__ ~~s~~ ||sp|| `c`')).toBe(
      '<div class="md-p"><strong>b</strong> <em>i</em> <em>i2</em> <u>u</u> <s>s</s> ' +
        '<span class="md-spoiler" title="Spoiler: hidden until it’s clicked in Discord">sp</span> <code class="md-code">c</code></div>',
    );
    expect(md('***both***')).toBe('<div class="md-p"><strong><em>both</em></strong></div>');
    expect(md('__*mixed*__')).toBe('<div class="md-p"><u><em>mixed</em></u></div>');
  });

  it('leaves text alone where Discord does: snake_case, escaped markers, lone stars, code contents', () => {
    expect(md('snake_case_name 2 * 3 = 6 \\*not italic\\*')).toBe('<div class="md-p">snake_case_name 2 * 3 = 6 *not italic*</div>');
    expect(md('`**not bold**`')).toBe('<div class="md-p"><code class="md-code">**not bold**</code></div>');
  });

  it('headings, subtext, quotes and lists on their own lines', () => {
    expect(md('# Big\n## Medium\n### Small\n-# fine print')).toBe(
      '<div class="md-h1" role="heading" aria-level="3">Big</div><div class="md-h2" role="heading" aria-level="4">Medium</div>' +
        '<div class="md-h3" role="heading" aria-level="5">Small</div><div class="md-sub">fine print</div>',
    );
    expect(md('#not a heading')).toBe('<div class="md-p">#not a heading</div>');
    expect(md('> quoted\n> **more**\nafter')).toBe(
      '<blockquote class="md-quote"><div class="md-p">quoted\n<strong>more</strong></div></blockquote><div class="md-p">after</div>',
    );
    expect(md('>>> all\nof this')).toBe('<blockquote class="md-quote"><div class="md-p">all\nof this</div></blockquote>');
    expect(md('- one\n  - nested\n1. first\n2. second')).toBe(
      '<ul class="md-list"><li>one</li><li style="margin-left:16px">nested</li></ul><ol class="md-list" start="1"><li>first</li><li>second</li></ol>',
    );
  });

  it('code blocks keep everything inside as written', () => {
    expect(md('before\n```js\nconst a = **1**;\n```\nafter')).toBe(
      '<div class="md-p">before</div><pre class="md-codeblock"><code>const a = **1**;</code></pre><div class="md-p">after</div>',
    );
  });

  it('links, mentions, emoji and timestamps are shown, never opened or loaded', () => {
    const html = md('[Site](https://example.com) https://kick.com/retronix <@123> <@&456> <#789> <:pog:111> @everyone');
    expect(html).toContain('<span class="md-link" title="https://example.com">Site</span>');
    expect(html).toContain('<span class="md-link" title="https://kick.com/retronix">https://kick.com/retronix</span>');
    expect(html).toContain('<span class="dp-mention">@member</span> <span class="dp-mention">@role</span> <span class="dp-mention">#channel</span>');
    expect(html).toContain('<span class="md-emoji" title="Custom emoji">:pog:</span>');
    expect(html).toContain('<span class="dp-mention">@everyone</span>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(md('<t:0:R>')).toMatch(/<span class="md-time">[^<]+<\/span>/);
  });

  it('titles and field names: formatting but no links (as in Discord)', () => {
    expect(md('**Hi** [x](https://example.com)', true)).toBe('<strong>Hi</strong> [x](https://example.com)');
  });

  it('never turns text into HTML', () => {
    const html = md('<b>x</b> <img src=x onerror=alert(1)> **<script>alert(1)</script>**');
    expect(html).not.toMatch(/<b>|<img|<script/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('the Discord preview renders markdown in the text, title, description and fields', () => {
    const html = renderToStaticMarkup(
      <EmbedPreview
        content="**Live** now"
        mention="@Live Pings"
        embed={{ ...EMPTY_EMBED, title: '*Stream*', description: '> quote', fields: [{ name: '__Game__', value: '- item', inline: false }] }}
      />,
    );
    expect(html).toContain('<span class="dp-mention">@Live Pings</span> <div class="md-p"><strong>Live</strong> now</div>');
    expect(html).toContain('<div class="dp-title"><em>Stream</em></div>');
    expect(html).toContain('<div class="dp-description"><blockquote class="md-quote"><div class="md-p">quote</div></blockquote></div>');
    expect(html).toContain('<div class="dp-field-name"><u>Game</u></div><div class="dp-field-value"><ul class="md-list"><li>item</li></ul></div>');
  });
});
