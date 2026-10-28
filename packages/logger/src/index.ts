import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
  /** Flushes and closes the log file. Further writes go to the console only. */
  close(): void;
}

export interface LoggerOptions {
  /** Component name, e.g. "server" or "desktop". */
  name: string;
  level?: LogLevel;
  /** Absolute path of the log file. Omit to log to the console only. */
  filePath?: string;
  /** Rotate when the file would exceed this size. Default 5 MiB. */
  maxBytes?: number;
  /** Number of rotated files to keep (file.1 … file.N). Default 5. */
  maxFiles?: number;
  console?: boolean;
}

export const REDACTED = '[REDACTED]';

/** Field names whose values must never be written to logs. */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|session[-_]?id|signature/i;

const MAX_DEPTH = 6;

/** Deep-copies `value`, replacing values under sensitive keys and serializing errors safely. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: LogFields = { name: value.name, message: value.message };
    if (value.stack) out.stack = value.stack;
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();

  const out: LogFields = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

class RotatingFile {
  private fd: number | null = null;
  private size = 0;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.open();
  }

  private open(): void {
    this.fd = fs.openSync(this.filePath, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  write(line: string): void {
    if (this.fd === null) return;
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.writeSync(this.fd, line);
    this.size += bytes;
  }

  private rotate(): void {
    this.closeFd();
    fs.rmSync(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
    }
    fs.renameSync(this.filePath, `${this.filePath}.1`);
    this.open();
  }

  private closeFd(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  close(): void {
    this.closeFd();
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const minRank = LEVEL_RANK[options.level ?? 'info'];
  const useConsole = options.console ?? true;
  let file: RotatingFile | null = null;
  if (options.filePath) {
    try {
      file = new RotatingFile(options.filePath, options.maxBytes ?? 5 * 1024 * 1024, Math.max(1, options.maxFiles ?? 5));
    } catch (err) {
      // Logging must never take the application down; fall back to console output.
      console.error(`[logger] cannot open ${options.filePath}:`, err);
    }
  }

  const write = (level: LogLevel, bindings: LogFields, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < minRank) return;
    const record = {
      time: new Date().toISOString(),
      level,
      name: options.name,
      msg,
      ...(redact({ ...bindings, ...fields }) as LogFields),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (file) {
      try {
        file.write(line);
      } catch (err) {
        console.error('[logger] write failed:', err);
      }
    }
    if (useConsole) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  };

  const make = (bindings: LogFields): Logger => ({
    debug: (msg, fields) => write('debug', bindings, msg, fields),
    info: (msg, fields) => write('info', bindings, msg, fields),
    warn: (msg, fields) => write('warn', bindings, msg, fields),
    error: (msg, fields) => write('error', bindings, msg, fields),
    child: (more) => make({ ...bindings, ...more }),
    close: () => {
      file?.close();
      file = null;
    },
  });

  return make({});
}
