import crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';

/*
 * Argon2id via hash-wasm (the Argon2 reference implementation compiled to WebAssembly).
 *
 * Why not Node's built-in crypto.argon2: Electron builds Node against BoringSSL, so in the packaged app
 * crypto.argon2 exists as a function but throws ERR_CRYPTO_ARGON2_NOT_SUPPORTED when called. hash-wasm runs
 * identically in Node, Electron and tests, needs no native module, and its output is byte-identical to
 * OpenSSL's Argon2id (verified; see KNOWN_ANSWER below and tests/unit/security.test.ts).
 *
 * Trade-off: WebAssembly runs on the calling thread, so each hash blocks the server's event loop for its
 * duration (~30 ms at the default cost). Hashing is serialized (one at a time) and queue-limited.
 */

export interface Argon2Params {
  /** Memory cost in KiB. */
  memoryKiB: number;
  /** Time cost (iterations). */
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const ARGON2_VERSION = 19; // 0x13

/**
 * Known-answer vector, cross-checked against OpenSSL's Argon2id (Node crypto.argon2Sync) and hash-wasm in both
 * Node 24 and Electron 44: Argon2id v19, m=19456, t=2, p=1, 32-byte tag.
 */
const KNOWN_ANSWER = {
  password: 'correct horse battery staple',
  salt: '0123456789abcdef',
  params: DEFAULT_ARGON2_PARAMS,
  hex: '832e52b959b967b570ee4781f6c7bda7ced019ca266ac781fd2d94d4e853b0cd',
} as const;

async function derive(password: string, salt: Uint8Array, params: Argon2Params): Promise<Buffer> {
  const out = await argon2id({
    // NFC so the same visible password always produces the same bytes.
    password: password.normalize('NFC'),
    salt,
    parallelism: params.parallelism,
    iterations: params.passes,
    memorySize: params.memoryKiB,
    hashLength: TAG_BYTES,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

/**
 * Proves the Argon2id implementation works in this runtime and produces standard output. The server calls
 * this at startup and refuses to start if it fails — there is deliberately no fallback algorithm.
 */
export async function verifyArgon2Implementation(): Promise<void> {
  const actual = (await derive(KNOWN_ANSWER.password, Buffer.from(KNOWN_ANSWER.salt), KNOWN_ANSWER.params)).toString('hex');
  if (actual !== KNOWN_ANSWER.hex) throw new Error('Argon2id self-test failed: output does not match the known-answer vector');
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

/** PHC string format: $argon2id$v=19$m=<KiB>,t=<passes>,p=<parallelism>$<salt>$<hash> (unpadded base64). */
const PHC_PATTERN = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const m = PHC_PATTERN.exec(encoded);
  if (!m || Number(m[1]) !== ARGON2_VERSION) return null;
  const params = { memoryKiB: Number(m[2]), passes: Number(m[3]), parallelism: Number(m[4]) };
  // Bound parameters read from storage so a tampered row cannot request absurd resources.
  if (params.memoryKiB < 8 || params.memoryKiB > 1_048_576 || params.passes < 1 || params.passes > 64) return null;
  if (params.parallelism < 1 || params.parallelism > 16 || params.memoryKiB < 8 * params.parallelism) return null;
  const salt = Buffer.from(m[5]!, 'base64');
  const hash = Buffer.from(m[6]!, 'base64');
  if (salt.length < 8 || hash.length < 16) return null;
  return { params, salt, hash };
}

export class HashingBusyError extends Error {
  constructor() {
    super('Too many concurrent password operations');
    this.name = 'HashingBusyError';
  }
}

/**
 * Argon2id password hashing with bounded concurrency: each hash uses `memoryKiB` of RAM and CPU time on the
 * event loop, so requests are serialized and fail fast with HashingBusyError once the queue is full.
 */
export class PasswordHasher {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private dummy: Promise<string> | null = null;

  constructor(
    readonly params: Argon2Params = DEFAULT_ARGON2_PARAMS,
    private readonly maxConcurrent = 1,
    private readonly maxQueued = 16,
  ) {}

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueued) throw new HashingBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  hash(password: string): Promise<string> {
    return this.withSlot(async () => {
      const salt = crypto.randomBytes(SALT_BYTES);
      const hash = await derive(password, salt, this.params);
      const { memoryKiB: m, passes: t, parallelism: p } = this.params;
      return `$argon2id$v=${ARGON2_VERSION}$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
    });
  }

  /** Constant-time comparison. Returns false (never throws) for a wrong password or an unparseable hash. */
  verify(encoded: string, password: string): Promise<boolean> {
    const parsed = parse(encoded);
    if (!parsed) return Promise.resolve(false);
    return this.withSlot(async () => {
      let candidate: Buffer;
      try {
        candidate = await derive(password, parsed.salt, parsed.params);
      } catch {
        return false; // e.g. empty input, which hash-wasm refuses
      }
      return candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
    });
  }

  /** True when a stored hash uses weaker parameters than the current configuration. */
  needsRehash(encoded: string): boolean {
    const parsed = parse(encoded);
    if (!parsed) return true;
    const { params } = parsed;
    return (
      params.memoryKiB < this.params.memoryKiB ||
      params.passes < this.params.passes ||
      params.parallelism !== this.params.parallelism ||
      parsed.hash.length !== TAG_BYTES
    );
  }

  /**
   * A valid hash of a random secret. Verifying against it when a username does not exist makes unknown-user
   * and wrong-password attempts take the same time, so response timing does not reveal which accounts exist.
   */
  dummyHash(): Promise<string> {
    this.dummy ??= this.hash(crypto.randomBytes(32).toString('hex'));
    return this.dummy;
  }
}
