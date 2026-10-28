/**
 * Settings → Logs: reads CONDUIT's own log files (logs/server.log and logs/desktop.log, plus their rotated copies
 * .1 … .5) for the dashboard. No second logging system: these are the files the logger already writes.
 *
 * - Bounded: only the last part of each file is read (MAX_BYTES_PER_FILE), newest files first, and older rotated files
 *   only while more entries are still needed. Huge files are never loaded whole.
 * - Safe: every entry is redacted again before it's returned (sensitive field names, plus token-shaped text such as
 *   Bearer/Bot tokens, JWTs and OAuth codes in URLs), even though the logger already redacts when writing.
 * - Robust: a missing, rotated or locked file is reported in plain words and skipped; a damaged line is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '@conduit/logger';
import { logQuerySchema, type LogEntryView, type LogsView, type LogViewLevel } from '@conduit/shared';
import { parseInput } from '../validation';

const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_ROTATED = 5;
const SOURCES = ['server', 'desktop'] as const;

/** Token-shaped text that must never be shown, even inside free-form values. */
const SCRUB: Array<[RegExp, string]> = [
  [/\b[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g, '[REDACTED]'], // Discord bot token
  [/\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+/g, '[REDACTED]'], // JWT
  [/\b(Bearer|Bot)\s+[A-Za-z\d._~+/-]{16,}=*/gi, '$1 [REDACTED]'],
  [/([?&#](?:code|state|access_token|refresh_token|id_token|client_secret|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/((?:client_secret|refresh_token|access_token|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]'],
];

export function scrubText(s: string): string {
  let out = s;
  for (const [re, by] of SCRUB) out = out.replace(re, by);
  return out;
}

function scrubDeep(v: unknown): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}

/** What to do about known problems. */
const HINTS: Array<[RegExp, string]> = [
  [/integrity check failed|damaged database/i, 'Restore a recent backup in Settings → Backup & Restore.'],
  [/discord bot|gateway|discord/i, 'Check Dashboard → Discord → Manage. If the bot was disconnected, it reconnects by itself.'],
  [/kick/i, 'Check Dashboard → Kick → Manage. An expired authorization needs Reconnect.'],
  [/backup|restore/i, 'See Settings → Backup & Restore for the details and the backup list.'],
  [/oauth callback|callback port|in use/i, 'Another program may be using the port. Close it and try again.'],
];

function hintFor(level: LogViewLevel, msg: string, module: string | null): string | null {
  if (level !== 'error' && level !== 'warn') return null;
  const text = `${module ?? ''} ${msg}`;
  return HINTS.find(([re]) => re.test(text))?.[1] ?? null;
}

function readTail(file: string, maxBytes: number): { text: string; partial: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Starting mid-file: drop the first (probably cut) line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, partial: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

export class LogService {
  constructor(private readonly o: { logDir: string }) {}

  query(raw: unknown): LogsView {
    const q = parseInput(logQuerySchema, raw ?? {});
    const from = q.from ? Date.parse(q.from) : -Infinity;
    const to = q.to ? Date.parse(q.to) : Infinity;
    const search = q.search.toLowerCase();
    const levels = new Set<string>(q.levels);
    const modules = new Set<string>();
    const problems: string[] = [];
    let truncated = false;
    const matches: LogEntryView[] = [];

    for (const source of SOURCES) {
      if (q.source && q.source !== source) continue;
      let found = 0;
      for (let i = 0; i <= MAX_ROTATED && found < q.limit; i++) {
        const name = i === 0 ? `${source}.log` : `${source}.log.${i}`;
        const file = path.join(this.o.logDir, name);
        if (!fs.existsSync(file)) {
          if (i === 0) problems.push(`${name} doesn’t exist yet.`);
          break;
        }
        let text: string;
        try {
          const tail = readTail(file, MAX_BYTES_PER_FILE);
          text = tail.text;
          if (tail.partial) truncated = true;
        } catch (err) {
          problems.push(`${name} couldn’t be read right now (${(err as NodeJS.ErrnoException).code ?? 'error'}). Try Refresh.`);
          continue;
        }
        const lines = text.split('\n');
        // Newest last in the file: walk backwards.
        for (let j = lines.length - 1; j >= 0 && found < q.limit; j--) {
          const line = lines[j]!.trim();
          if (!line) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const { time, level, msg, module, name: _name, ...rest } = rec;
          if (typeof time !== 'string' || typeof level !== 'string' || typeof msg !== 'string') continue;
          const mod = typeof module === 'string' ? module : null;
          if (mod) modules.add(mod);
          if (!levels.has(level)) continue;
          if (q.module && mod !== q.module) continue;
          const t = Date.parse(time);
          if (!(t >= from && t <= to)) continue;
          const details = scrubDeep(redact(rest)) as Record<string, unknown>;
          const message = scrubText(msg);
          if (search && !`${message} ${mod ?? ''} ${JSON.stringify(details)}`.toLowerCase().includes(search)) continue;
          matches.push({ time, level: level as LogViewLevel, source, module: mod, message, details, hint: hintFor(level as LogViewLevel, message, mod) });
          found++;
        }
        if (found >= q.limit) truncated = true;
      }
    }
    matches.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    if (matches.length > q.limit) truncated = true;
    return { entries: matches.slice(0, q.limit), modules: [...modules].sort(), truncated, problems, folder: this.o.logDir };
  }
}
