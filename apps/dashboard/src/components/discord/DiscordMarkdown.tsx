/**
 * Discord markdown for the previews: headings, subtext, quotes, lists, code blocks, **bold**, *italic*, __underline__,
 * ~~strikethrough~~, ||spoilers||, `code`, [masked links](https://…), mentions, custom emoji and timestamps — shown the
 * way Discord shows them. The text only ever becomes React elements (never HTML), and links are shown, not opened.
 */
import { Fragment, type ReactNode } from 'react';

interface Rule {
  re: RegExp;
  /** Links are rendered only where Discord renders them (not in titles or field names). */
  link?: boolean;
  /** Only where a word starts (e.g. snake_case_names aren't italic). */
  wordStart?: boolean;
  render: (m: RegExpExecArray, links: boolean, key: string) => ReactNode;
}

const RULES: Rule[] = [
  { re: /\\([^\sA-Za-z0-9])/y, render: (m) => m[1] },
  { re: /(`+)([\s\S]*?[^`])\1(?!`)/y, render: (m) => <code className="md-code">{m[2]}</code> },
  { re: /<@!?(\d{1,25})>/y, render: () => <span className="dp-mention">@member</span> },
  { re: /<@&(\d{1,25})>/y, render: () => <span className="dp-mention">@role</span> },
  { re: /<#(\d{1,25})>/y, render: () => <span className="dp-mention">#channel</span> },
  { re: /<\/([\w -]{1,32}):\d{1,25}>/y, render: (m) => <span className="dp-mention">/{m[1]}</span> },
  { re: /@(everyone|here)(?![\w])/y, render: (m) => <span className="dp-mention">@{m[1]}</span> },
  { re: /<a?:(\w{2,32}):\d{1,25}>/y, render: (m) => <span className="md-emoji" title="Custom emoji">:{m[1]}:</span> },
  { re: /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y, render: (m) => <span className="md-time">{timestamp(Number(m[1]), m[2] ?? 'f')}</span> },
  {
    re: /\[([^[\]\n]+)\]\(<?(https?:\/\/[^\s<>)]+)>?\)/y,
    link: true,
    render: (m, _links, key) => (
      <span className="md-link" title={m[2]}>
        {inline(m[1]!, false, key)}
      </span>
    ),
  },
  {
    re: /<?(https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?])>?/y,
    link: true,
    render: (m) => (
      <span className="md-link" title={m[1]}>
        {m[1]}
      </span>
    ),
  },
  { re: /\*\*(?=\S)([\s\S]+?)\*\*(?!\*)/y, render: (m, links, key) => <strong>{inline(m[1]!, links, key)}</strong> },
  { re: /__([\s\S]+?)__(?!_)/y, render: (m, links, key) => <u>{inline(m[1]!, links, key)}</u> },
  { re: /\*(?=\S)([\s\S]*?[^\s*])\*(?!\*)/y, render: (m, links, key) => <em>{inline(m[1]!, links, key)}</em> },
  { re: /_((?:__|\\[\s\S]|[^\\_])+?)_(?![A-Za-z0-9_])/y, wordStart: true, render: (m, links, key) => <em>{inline(m[1]!, links, key)}</em> },
  { re: /~~([\s\S]+?)~~/y, render: (m, links, key) => <s>{inline(m[1]!, links, key)}</s> },
  {
    re: /\|\|([\s\S]+?)\|\|/y,
    render: (m, links, key) => (
      <span className="md-spoiler" title="Spoiler: hidden until it’s clicked in Discord">
        {inline(m[1]!, links, key)}
      </span>
    ),
  },
];

const STARTERS = new Set(['\\', '`', '<', '@', '[', 'h', '*', '_', '~', '|']);

/** Bold, italic, links and the rest within a line or paragraph. */
function inline(text: string, links: boolean, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let i = 0;
  outer: while (i < text.length) {
    if (STARTERS.has(text[i]!)) {
      for (const rule of RULES) {
        if (rule.link && !links) continue;
        if (rule.wordStart && i > 0 && /[A-Za-z0-9]/.test(text[i - 1]!)) continue;
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (!m) continue;
        if (plain) out.push(plain);
        plain = '';
        const k = `${key}.${out.length}`;
        out.push(<Fragment key={k}>{rule.render(m, links, k)}</Fragment>);
        i += m[0].length;
        continue outer;
      }
    }
    plain += text[i];
    i += 1;
  }
  if (plain) out.push(plain);
  return out;
}

const LIST_ITEM = /^( *)([-*]|\d{1,9}\.) +(\S.*)$/;

/** Headings, subtext, quotes and lists, line by line (code blocks are taken out first). */
function lines(text: string, inQuote: boolean, key: string): ReactNode[] {
  const all = text.split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  const k = () => `${key}.${out.length}`;
  const flush = () => {
    if (para.length === 0) return;
    // A blank last line still shows as a gap (white-space: pre-wrap drops a single trailing newline).
    const body = para.join('\n') + (para[para.length - 1] === '' ? '\n' : '');
    out.push(
      <div key={k()} className="md-p">
        {inline(body, true, k())}
      </div>,
    );
    para = [];
  };
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    if (!inQuote && line.startsWith('>>> ')) {
      flush();
      out.push(
        <blockquote key={k()} className="md-quote">
          {lines([line.slice(4), ...all.slice(i + 1)].join('\n'), true, k())}
        </blockquote>,
      );
      return out;
    }
    if (!inQuote && /^> /.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < all.length && /^> /.test(all[i]!)) quoted.push(all[i++]!.slice(2));
      i -= 1;
      out.push(
        <blockquote key={k()} className="md-quote">
          {lines(quoted.join('\n'), true, k())}
        </blockquote>,
      );
      continue;
    }
    const heading = /^(#{1,3}) +(\S.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(
        <div key={k()} className={`md-h${heading[1]!.length}`} role="heading" aria-level={heading[1]!.length + 2}>
          {inline(heading[2]!, true, k())}
        </div>,
      );
      continue;
    }
    const sub = /^-# +(\S.*)$/.exec(line);
    if (sub) {
      flush();
      out.push(
        <div key={k()} className="md-sub">
          {inline(sub[1]!, true, k())}
        </div>,
      );
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      flush();
      const ordered = /\d/.test(first[2]!);
      const items: Array<{ depth: number; text: string }> = [];
      for (let m: RegExpExecArray | null = first; m &&/\d/.test(m[2]!) === ordered; m = LIST_ITEM.exec(all[++i] ?? '')) {
        items.push({ depth: Math.min(m[1]!.length, 6), text: m[3]! });
      }
      i -= 1;
      const children = items.map((it, n) => (
        <li key={n} style={it.depth ? { marginLeft: it.depth * 8 } : undefined}>
          {inline(it.text, true, `${k()}.${n}`)}
        </li>
      ));
      out.push(
        ordered ? (
          <ol key={k()} className="md-list" start={Number.parseInt(first[2]!, 10)}>
            {children}
          </ol>
        ) : (
          <ul key={k()} className="md-list">
            {children}
          </ul>
        ),
      );
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

const CODE_BLOCK = /```(?:([\w+#.-]{1,20})\n)?\n?([\s\S]*?)```/g;

/** The whole message: code blocks first (nothing inside them is formatted), then everything else line by line. */
function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(CODE_BLOCK)) {
    if (!m[2]!.trim()) continue;
    const before = text.slice(at, m.index).replace(/\n$/, '');
    if (before) out.push(...lines(before, false, `b${out.length}`));
    out.push(
      <pre key={`b${out.length}`} className="md-codeblock">
        <code>{m[2]!.replace(/\n$/, '')}</code>
      </pre>,
    );
    at = m.index + m[0].length;
    if (text[at] === '\n') at += 1;
  }
  const rest = text.slice(at);
  if (rest) out.push(...lines(rest, false, `b${out.length}`));
  return out;
}

/** Discord's <t:…> timestamps, in this PC's time zone and language (as Discord shows them to each reader). */
function timestamp(seconds: number, style: string): string {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return 'Invalid date';
  try {
    if (style === 'R') {
      const diff = (d.getTime() - Date.now()) / 1000;
      const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
      ];
      const [unit, size] = units.find(([, s]) => Math.abs(diff) >= s) ?? ['second', 1];
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit);
    }
    const formats: Record<string, Intl.DateTimeFormatOptions> = {
      t: { timeStyle: 'short' },
      T: { timeStyle: 'medium' },
      d: { dateStyle: 'short' },
      D: { dateStyle: 'long' },
      f: { dateStyle: 'long', timeStyle: 'short' },
      F: { dateStyle: 'full', timeStyle: 'short' },
    };
    return new Intl.DateTimeFormat(undefined, formats[style] ?? formats.f).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * Text with Discord markdown. `inline`: only bold, italic and the like, without links (what Discord allows in embed
 * titles and field names).
 */
export function DiscordMarkdown({ text, inline: inlineOnly = false }: { text: string; inline?: boolean }) {
  return <>{inlineOnly ? inline(text, false, 'i') : blocks(text)}</>;
}
