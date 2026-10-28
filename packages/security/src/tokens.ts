import crypto from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded

/** A new 256-bit random bearer token (session or setup token). */
export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * The stored, non-recoverable form of a token. A fast hash is appropriate here (unlike passwords) because
 * tokens carry 256 bits of entropy, so a stolen database cannot be brute-forced back into usable tokens.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison (lengths are hidden by hashing first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}
