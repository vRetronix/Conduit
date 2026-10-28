import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARGON2_PARAMS,
  FailureLimiter,
  generateToken,
  hashToken,
  HashingBusyError,
  isWellFormedToken,
  PasswordHasher,
  safeEqual,
  verifyArgon2Implementation,
} from '@conduit/security';

const fast = { memoryKiB: 256, passes: 1, parallelism: 1 };

/** OpenSSL-backed Argon2 is present in plain Node 24.7+, but not in Electron (BoringSSL). */
function opensslArgon2Supported(): boolean {
  try {
    crypto.argon2Sync('argon2id', { message: Buffer.from('x'), nonce: Buffer.alloc(16), parallelism: 1, tagLength: 32, memory: 64, passes: 1 });
    return true;
  } catch {
    return false;
  }
}

describe('Argon2id implementation', () => {
  it('passes the startup known-answer self-test', async () => {
    await expect(verifyArgon2Implementation()).resolves.toBeUndefined();
  });

  it.skipIf(!opensslArgon2Supported())('is interoperable with OpenSSL Argon2id in both directions', async () => {
    const hasher = new PasswordHasher(fast);
    // A hash created by CONDUIT verifies with OpenSSL…
    const ours = await hasher.hash('interop passphrase');
    const [, , , , saltB64, hashB64] = ours.split('$');
    const openssl = crypto.argon2Sync('argon2id', {
      message: Buffer.from('interop passphrase'),
      nonce: Buffer.from(saltB64!, 'base64'),
      parallelism: 1,
      tagLength: 32,
      memory: 256,
      passes: 1,
    });
    expect(openssl.toString('base64').replace(/=+$/, '')).toBe(hashB64);
    // …and a hash created by OpenSSL verifies with CONDUIT.
    const salt = crypto.randomBytes(16);
    const tag = crypto.argon2Sync('argon2id', { message: Buffer.from('other passphrase'), nonce: salt, parallelism: 1, tagLength: 32, memory: 256, passes: 1 });
    const phc = `$argon2id$v=19$m=256,t=1,p=1$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`;
    expect(await hasher.verify(phc, 'other passphrase')).toBe(true);
    expect(await hasher.verify(phc, 'wrong passphrase')).toBe(false);
  });
});

describe('PasswordHasher (Argon2id)', () => {
  it('produces salted PHC-format Argon2id hashes that never contain the password', async () => {
    const hasher = new PasswordHasher(fast);
    const a = await hasher.hash('correct horse battery staple');
    const b = await hasher.hash('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=256,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b); // unique salts
    expect(a).not.toContain('correct horse');
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const hasher = new PasswordHasher(fast);
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse battery stapl')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('treats Unicode-equivalent passwords as equal (NFC)', async () => {
    const hasher = new PasswordHasher(fast);
    const hash = await hasher.hash('café au lait 123');
    expect(await hasher.verify(hash, 'café au lait 123')).toBe(true);
  });

  it('returns false instead of throwing for malformed or foreign hashes', async () => {
    const hasher = new PasswordHasher(fast);
    for (const bad of ['', 'plaintext', '$2b$10$abcdefghijklmnopqrstuv', '$argon2i$v=19$m=256,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', '$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA']) {
      expect(await hasher.verify(bad, 'whatever')).toBe(false);
    }
  });

  it('flags hashes made with weaker parameters for rehashing', async () => {
    const weak = await new PasswordHasher(fast).hash('password-1234');
    const strong = new PasswordHasher({ ...fast, memoryKiB: 512 });
    expect(strong.needsRehash(weak)).toBe(true);
    expect(strong.needsRehash(await strong.hash('password-1234'))).toBe(false);
  });

  it('uses the OWASP minimum parameters by default', () => {
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ memoryKiB: 19_456, passes: 2, parallelism: 1 });
  });

  it('caps concurrent hashing and fails fast when the queue is full', async () => {
    const hasher = new PasswordHasher(fast, 1, 1);
    const results = await Promise.allSettled([hasher.hash('a-long-password'), hasher.hash('a-long-password'), hasher.hash('a-long-password')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(HashingBusyError);
  });
});

describe('tokens', () => {
  it('generates 256-bit base64url tokens', () => {
    const t = generateToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(t);
  });

  it('stores only a one-way hash', () => {
    const t = generateToken();
    const hashed = hashToken(t);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(t);
  });

  it('rejects malformed tokens', () => {
    for (const bad of [undefined, '', 'abc', `${generateToken()}x`, 'a'.repeat(42) + '=', 42]) expect(isWellFormedToken(bad)).toBe(false);
  });

  it('compares secrets without length shortcuts', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('FailureLimiter', () => {
  it('blocks after the limit and unblocks as failures age out', () => {
    let now = 0;
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('k').allowed).toBe(true);
      limiter.recordFailure('k');
      now += 100;
    }
    const blocked = limiter.check('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.retryAfterMs).toBe(700);
    expect(limiter.check('other').allowed).toBe(true);
    now += 701;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('reset clears a key', () => {
    const limiter = new FailureLimiter({ maxFailures: 1, windowMs: 1000 });
    limiter.recordFailure('k');
    expect(limiter.check('k').allowed).toBe(false);
    limiter.reset('k');
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('bounds memory by evicting the oldest keys', () => {
    const limiter = new FailureLimiter({ maxFailures: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.recordFailure('a');
    limiter.recordFailure('b');
    limiter.recordFailure('c');
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(false);
  });
});
