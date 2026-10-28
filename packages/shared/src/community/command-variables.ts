/**
 * Custom command variables (Kick and Discord): the catalogue shown in the editor, and the renderer that fills them in.
 *
 * Syntax: `{name}`, `{name:argument}` and `{name|fallback}` (or both: `{name:argument|fallback}`). The fallback is used
 * when the value is empty or unavailable, e.g. `{touser|everyone}` or `{title|no title}`.
 *
 * Rendering is a single pass over the template: inserted values are never read as variables again, so a value that
 * contains "{user}" stays literal. Unknown placeholders are posted exactly as written. Values are plain text — never
 * code — and are cleaned (control characters removed, whitespace collapsed, length capped).
 *
 * The data comes from the backend (CommandVariableService), which looks up only what a template uses. This module has
 * no dependencies, so the dashboard can use the catalogue and preview without loading anything else.
 */

export type VariablePlatform = 'kick' | 'discord';

export const VARIABLE_GROUPS = ['input', 'stream', 'random', 'counters', 'time', 'kick', 'discord'] as const;
export type VariableGroup = (typeof VARIABLE_GROUPS)[number];

export const VARIABLE_GROUP_LABEL: Record<VariableGroup, string> = {
  input: 'User and input',
  stream: 'Your Kick stream',
  random: 'Random and maths',
  counters: 'Counters',
  time: 'Time',
  kick: 'Kick only',
  discord: 'Discord only',
};

export interface VariableInfo {
  /** The placeholder's name (what follows "{"). */
  name: string;
  group: VariableGroup;
  platforms: readonly VariablePlatform[];
  description: string;
  /** What the editor inserts when clicked (with an example argument where one is needed). */
  insert: string;
}

const BOTH = ['kick', 'discord'] as const;
const KICK = ['kick'] as const;
const DISCORD = ['discord'] as const;

export const VARIABLES: readonly VariableInfo[] = [
  // User and input
  { name: 'user', group: 'input', platforms: BOTH, description: 'Who used the command', insert: '{user}' },
  { name: 'touser', group: 'input', platforms: BOTH, description: 'The first word after the command without @, else who used it', insert: '{touser}' },
  { name: 'userid', group: 'input', platforms: BOTH, description: 'The user’s Kick or Discord user id', insert: '{userid}' },
  { name: 'args', group: 'input', platforms: BOTH, description: 'Everything after the command (Discord: the "text" box)', insert: '{args}' },
  { name: '1', group: 'input', platforms: BOTH, description: 'One word after the command: {1} to {9}', insert: '{1}' },
  { name: 'message', group: 'input', platforms: BOTH, description: 'The whole command as typed', insert: '{message}' },
  { name: 'channel', group: 'input', platforms: BOTH, description: 'Kick: your channel. Discord: the text channel', insert: '{channel}' },
  { name: 'platform', group: 'input', platforms: BOTH, description: 'Kick or Discord', insert: '{platform}' },
  { name: 'commands', group: 'input', platforms: BOTH, description: 'The commands people can use here', insert: '{commands}' },
  // Your Kick stream
  { name: 'streamer', group: 'stream', platforms: BOTH, description: 'Your Kick channel name', insert: '{streamer}' },
  { name: 'title', group: 'stream', platforms: BOTH, description: 'Your stream title', insert: '{title}' },
  { name: 'category', group: 'stream', platforms: BOTH, description: 'Your stream category or game', insert: '{category}' },
  { name: 'viewers', group: 'stream', platforms: BOTH, description: 'Viewers right now (when live)', insert: '{viewers}' },
  { name: 'uptime', group: 'stream', platforms: BOTH, description: 'How long you’ve been live (or "offline")', insert: '{uptime}' },
  { name: 'url', group: 'stream', platforms: BOTH, description: 'Link to your Kick channel', insert: '{url}' },
  // Random and maths
  { name: 'random', group: 'random', platforms: BOTH, description: 'A random number: 1–100, or the range you give', insert: '{random:1-6}' },
  { name: 'pick', group: 'random', platforms: BOTH, description: 'One item at random, items separated by ;', insert: '{pick:heads;tails}' },
  { name: 'randomuser', group: 'random', platforms: BOTH, description: 'Someone who chatted recently here', insert: '{randomuser}' },
  { name: 'math', group: 'random', platforms: BOTH, description: 'Arithmetic: + - * / % ^ and ( )', insert: '{math:2*(3+4)}' },
  // Counters
  { name: 'count', group: 'counters', platforms: BOTH, description: 'How many times this command has been used', insert: '{count}' },
  { name: 'counter', group: 'counters', platforms: BOTH, description: 'A named counter; +1, -1 or =0 changes it', insert: '{counter:deaths+1}' },
  // Time
  { name: 'time', group: 'time', platforms: BOTH, description: 'The time now (optionally in a time zone)', insert: '{time:America/New_York}' },
  { name: 'date', group: 'time', platforms: BOTH, description: 'Today’s date (optionally in a time zone)', insert: '{date}' },
  { name: 'countdown', group: 'time', platforms: BOTH, description: 'Time left until a date', insert: '{countdown:2026-12-25}' },
  { name: 'countup', group: 'time', platforms: BOTH, description: 'Time since a date', insert: '{countup:2025-01-01}' },
  // Kick only
  { name: 'roles', group: 'kick', platforms: KICK, description: 'The user’s Kick badges (moderator, VIP, subscriber…)', insert: '{roles}' },
  { name: 'submonths', group: 'kick', platforms: KICK, description: 'The user’s subscriber months (from their badge)', insert: '{submonths}' },
  // Discord only
  { name: 'mention', group: 'discord', platforms: DISCORD, description: 'A clickable @mention of the user (never pings)', insert: '{mention}' },
  { name: 'server', group: 'discord', platforms: DISCORD, description: 'The server’s name', insert: '{server}' },
  { name: 'membercount', group: 'discord', platforms: DISCORD, description: 'How many members the server has', insert: '{membercount}' },
  { name: 'points', group: 'discord', platforms: DISCORD, description: 'The user’s Loyalty points', insert: '{points}' },
  { name: 'level', group: 'discord', platforms: DISCORD, description: 'The user’s Loyalty level', insert: '{level}' },
  { name: 'xp', group: 'discord', platforms: DISCORD, description: 'The user’s Loyalty XP', insert: '{xp}' },
  { name: 'rank', group: 'discord', platforms: DISCORD, description: 'The user’s XP rank in the server', insert: '{rank}' },
];

/** Every name a template may use (the catalogue plus {2}…{9}). */
const NAMES = new Map<string, VariableInfo>();
for (const v of VARIABLES) NAMES.set(v.name, v);
for (let n = 2; n <= 9; n++) NAMES.set(String(n), NAMES.get('1')!);

// ── parsing ──────────────────────────────────────────────────────────────────

export interface VariableToken {
  /** The placeholder exactly as written, e.g. "{random:1-6|7}". */
  whole: string;
  name: string;
  /** Text after ":", or null. */
  arg: string | null;
  /** Text after "|", or null. */
  fallback: string | null;
}

/** {name}, {name:arg}, {name|fallback}, {name:arg|fallback}. Names are letters, digits, _ and dots; {1}…{9} too. */
const TOKEN = /\{([A-Za-z_][\w.]*|[1-9])(?::([^{}|]*))?(?:\|([^{}]*))?\}/g;

export function variableTokens(template: string): VariableToken[] {
  return [...template.matchAll(TOKEN)].map((m) => ({ whole: m[0], name: m[1]!, arg: m[2] ?? null, fallback: m[3] ?? null }));
}

/** Placeholders that aren't variables at all, or aren't available on this platform (e.g. {mention} in a Kick command). */
export function unsupportedVariables(template: string, platform?: VariablePlatform): string[] {
  const out = new Set<string>();
  for (const t of variableTokens(template)) {
    const info = NAMES.get(t.name);
    if (!info || (platform && !info.platforms.includes(platform))) out.add(`{${t.name}}`);
  }
  return [...out];
}

/** Counter changes a template asks for: {counter:deaths}, {counter:deaths+1}, {counter:deaths-2}, {counter:deaths=0}. */
export interface CounterOp {
  name: string;
  op: 'get' | 'add' | 'set';
  amount: number;
}
/** Counter names are letters, digits and _ (so "deaths-1" reads as "deaths minus 1"). */
const COUNTER = /^\s*([A-Za-z0-9_]{1,32})\s*(?:([+=-])\s*(\d{1,9}))?\s*$/;

export function parseCounter(arg: string | null): CounterOp | null {
  const m = COUNTER.exec(arg ?? '');
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!m[2]) return { name, op: 'get', amount: 0 };
  const n = Number(m[3]);
  return m[2] === '=' ? { name, op: 'set', amount: n } : { name, op: 'add', amount: m[2] === '-' ? -n : n };
}

export function counterOps(template: string): CounterOp[] {
  return variableTokens(template)
    .filter((t) => t.name === 'counter')
    .map((t) => parseCounter(t.arg))
    .filter((c): c is CounterOp => c !== null);
}

// ── data and rendering ───────────────────────────────────────────────────────

export interface StreamVariables {
  streamer: string;
  url: string;
  live: boolean;
  title: string | null;
  category: string | null;
  viewers: number | null;
  /** When the current stream started (ISO), when live. */
  startedAt: string | null;
}

/** What a command run knows; the backend fills in only what the template uses. */
export interface VariableData {
  user: string;
  userId?: string | null;
  channel?: string | null;
  args?: string;
  message?: string;
  stream?: StreamVariables | null;
  commands?: readonly string[];
  count?: number | null;
  /** Named counters after this run's changes. */
  counters?: Readonly<Record<string, number>>;
  randomUser?: string | null;
  roles?: readonly string[];
  subMonths?: number | null;
  mention?: string | null;
  server?: string | null;
  memberCount?: number | null;
  loyalty?: { points: string | null; level: number | null; xp: number | null; rank: number | null } | null;
  now?: Date;
  /** 0 ≤ n < 1 (Math.random by default; tests pass a fixed one). */
  random?: () => number;
}

const MAX_VALUE = 400;
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].map((g) => g.segment);

/** A value made safe for a one-line chat reply. */
export function cleanVariableValue(v: string | null | undefined): string {
  if (!v) return '';
  return graphemes(
    v
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, MAX_VALUE)
    .join('');
}

const words = (args: string | undefined) => (args ?? '').trim().split(/\s+/).filter(Boolean);

/** "3 days 4 hours", "2 hours 5 minutes", "45 seconds" — the two largest units. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const units: Array<[string, number]> = [
    ['year', 365 * 86_400],
    ['month', 30 * 86_400],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0 || (parts.length === 0 && size === 1)) {
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** A date written as YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time), or null. */
function parseDate(arg: string | null): Date | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?\s*$/.exec(arg ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe arithmetic: numbers, + - * / % ^ (power) and parentheses. No names, no code. Null when the expression isn't
 * valid, divides by zero, or the result isn't a finite number.
 */
export function evalMath(expr: string): number | null {
  const src = expr.replace(/\s+/g, '');
  if (!src || src.length > 100 || !/^[\d.+\-*/%^()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const number = (): number | null => {
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  // expr := term (('+'|'-') term)* ; term := power (('*'|'/'|'%') power)* ; power := unary ('^' power)? ;
  // unary := '-' unary | '+' unary | atom ; atom := number | '(' expr ')'
  let depth = 0;
  const atom = (): number | null => {
    if (peek() === '(') {
      if (++depth > 20) return null;
      i++;
      const v = expression();
      if (v === null || peek() !== ')') return null;
      i++;
      depth--;
      return v;
    }
    return number();
  };
  const unary = (): number | null => {
    if (peek() === '-') return (i++, ((v) => (v === null ? null : -v))(unary()));
    if (peek() === '+') return (i++, unary());
    return atom();
  };
  const power = (): number | null => {
    const base = unary();
    if (base === null) return null;
    if (peek() !== '^') return base;
    i++;
    const exp = power();
    return exp === null ? null : base ** exp;
  };
  const term = (): number | null => {
    let v = power();
    while (v !== null && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = src[i++];
      const r = power();
      if (r === null || ((op === '/' || op === '%') && r === 0)) return null;
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  function expression(): number | null {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const result = expression();
  if (result === null || i !== src.length || !Number.isFinite(result)) return null;
  return Math.round(result * 1e6) / 1e6;
}

/** The value of one placeholder, or null when it has none (then its fallback, else nothing, is used). */
function valueOf(t: VariableToken, d: VariableData, platform: VariablePlatform): string | null {
  const info = NAMES.get(t.name);
  if (!info || !info.platforms.includes(platform)) return null;
  const now = d.now ?? new Date();
  const random = d.random ?? Math.random;
  const num = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : null);
  const since = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) ? formatDuration(now.getTime() - at) : null;
  };
  switch (t.name) {
    case 'user':
      return d.user;
    case 'touser':
      return words(d.args)[0]?.replace(/^@+/, '') || d.user;
    case 'userid':
      return d.userId ?? null;
    case 'args':
      return d.args ?? null;
    case 'message':
      return d.message ?? null;
    case 'channel':
      return d.channel ?? null;
    case 'platform':
      return platform === 'kick' ? 'Kick' : 'Discord';
    case 'commands':
      return d.commands?.length ? d.commands.join(', ') : null;
    case 'streamer':
      return d.stream?.streamer ?? null;
    case 'url':
      return d.stream?.url ?? null;
    case 'title':
      return d.stream?.title ?? null;
    case 'category':
      return d.stream?.category ?? null;
    case 'viewers':
      return d.stream?.live ? num(d.stream.viewers) : null;
    case 'uptime':
      if (!d.stream) return null;
      return d.stream.live ? since(d.stream.startedAt) : 'offline';
    case 'random': {
      const m = /^\s*(-?\d{1,9})\s*-\s*(-?\d{1,9})\s*$/.exec(t.arg ?? '');
      const lo = m ? Math.min(Number(m[1]), Number(m[2])) : 1;
      const hi = m ? Math.max(Number(m[1]), Number(m[2])) : 100;
      if (t.arg && !m) return null;
      return String(lo + Math.floor(random() * (hi - lo + 1)));
    }
    case 'pick': {
      const items = (t.arg ?? '').split(';').map((s) => s.trim()).filter(Boolean);
      return items.length ? items[Math.floor(random() * items.length)]! : null;
    }
    case 'randomuser':
      return d.randomUser ?? null;
    case 'math': {
      const v = evalMath(t.arg ?? '');
      return v === null ? null : String(v);
    }
    case 'count':
      return num(d.count);
    case 'counter': {
      const c = parseCounter(t.arg);
      return c ? num(d.counters?.[c.name] ?? 0) : null;
    }
    case 'time':
    case 'date': {
      const tz = t.arg?.trim() || undefined;
      if (tz && !validTimeZone(tz)) return null;
      return t.name === 'time'
        ? now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
        : now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
    }
    case 'countdown':
    case 'countup': {
      const at = parseDate(t.arg);
      if (!at) return null;
      const ms = t.name === 'countdown' ? at.getTime() - now.getTime() : now.getTime() - at.getTime();
      return ms > 0 ? formatDuration(ms) : t.name === 'countdown' ? 'now' : null;
    }
    case 'roles':
      return d.roles?.length ? d.roles.join(', ') : null;
    case 'submonths':
      return d.subMonths ? String(d.subMonths) : null;
    case 'mention':
      return d.mention ?? null;
    case 'server':
      return d.server ?? null;
    case 'membercount':
      return num(d.memberCount);
    case 'points':
      return d.loyalty?.points ?? null;
    case 'level':
      return num(d.loyalty?.level);
    case 'xp':
      return num(d.loyalty?.xp);
    case 'rank':
      return d.loyalty?.rank ? `#${d.loyalty.rank}` : null;
    default:
      return /^[1-9]$/.test(t.name) ? (words(d.args)[Number(t.name) - 1] ?? null) : null;
  }
}

/** Fills in a template (single pass). Not shortened to the platform's limit: callers do that. */
export function fillVariables(template: string, data: VariableData, platform: VariablePlatform): string {
  return template.replace(TOKEN, (whole, name: string, arg?: string, fallback?: string) => {
    if (!NAMES.has(name)) return whole;
    const value = cleanVariableValue(valueOf({ whole, name, arg: arg ?? null, fallback: fallback ?? null }, data, platform));
    return value || cleanVariableValue(fallback ?? '');
  });
}
