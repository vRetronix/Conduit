/**
 * Receiver for Kick's event webhooks (docs.kick.com/events/webhook-security). Kick only delivers events to a public
 * URL, so the user exposes THIS listener — and nothing else — through a tunnel (Cloudflare Tunnel, ngrok). It is a
 * separate server from the CONDUIT API, bound to loopback, and accepts exactly one request shape:
 *
 *   POST /kick/webhook   with Kick-Event-Message-Id, -Message-Timestamp, -Signature, -Type, -Version headers.
 *
 * Every delivery must carry a valid signature: RSA PKCS#1 v1.5 / SHA-256 over "<message id>.<timestamp>.<raw body>",
 * checked against Kick's public key from GET /public/v1/public-key (fetched, never hard-coded; refetched once if a
 * signature fails, in case Kick rotated it). Stale or future timestamps and repeated message ids are refused, bodies
 * are size-limited, and request volume is capped. Anything else gets a bare 404/405 with no information.
 * Verified events are acknowledged immediately and processed afterwards.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@conduit/logger';

export const KICK_WEBHOOK_PATH = '/kick/webhook';
const MAX_BODY_BYTES = 64 * 1024;
/** Kick doesn't document a window; refuse deliveries older than this (replay protection) or this far in the future. */
const MAX_AGE_MS = 10 * 60_000;
const MAX_FUTURE_MS = 2 * 60_000;
const REMEMBERED_IDS = 5000;
const KEY_REFRESH_MIN_MS = 60_000;
/** Simple flood guard for an internet-facing port. */
const MAX_REQUESTS_PER_SECOND = 50;

export interface KickWebhookEvent {
  messageId: string;
  subscriptionId: string | null;
  type: string;
  version: string;
  timestamp: string;
  payload: unknown;
}

export interface KickWebhookServerOptions {
  port: number;
  logger: Logger;
  /** Kick's current public key (PEM or base64 DER). */
  fetchPublicKey: () => Promise<string>;
  onEvent: (event: KickWebhookEvent) => void;
  /** Counts rejected deliveries (forged, stale, malformed) for the status view. */
  onRejected?: (reason: string) => void;
  now?: () => number;
}

export class KickWebhookServer {
  private servers: http.Server[] = [];
  private key: crypto.KeyObject | null = null;
  private keyFetchedAt = 0;
  private keyLoading: Promise<crypto.KeyObject> | null = null;
  private readonly seen = new Set<string>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(private readonly o: KickWebhookServerOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  get listening(): boolean {
    return this.servers.some((s) => s.listening);
  }

  get port(): number {
    return (this.servers[0]?.address() as AddressInfo | null)?.port ?? this.o.port;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    const v4 = this.createServer();
    await new Promise<void>((resolve, reject) => {
      v4.once('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `The Kick webhook port ${this.o.port} is in use by another program.`
              : `Could not open the Kick webhook receiver: ${err.message}`,
          ),
        ),
      );
      v4.listen(this.o.port, '127.0.0.1', () => resolve());
    });
    this.servers.push(v4);
    // Tunnel clients may connect to "localhost" over IPv6; answer there too (still loopback only). Best effort.
    const v6 = this.createServer();
    v6.once('error', () => undefined);
    v6.listen({ port: this.port, host: '::1', ipv6Only: true }, () => this.servers.push(v6));
    this.o.logger.info('kick webhook receiver open', { port: this.port });
  }

  async close(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  }

  private createServer(): http.Server {
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 50;
    return server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(status === 200 ? 'ok' : '');
    };
    const reject = (status: number, reason: string, extra: Record<string, unknown> = {}) => {
      this.o.onRejected?.(reason);
      this.logRejection(reason, status, extra);
      req.resume();
      reply(status);
    };

    // Flood guard.
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.windowCount = 0;
    }
    if (++this.windowCount > MAX_REQUESTS_PER_SECOND) return reject(429, 'rate');

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== KICK_WEBHOOK_PATH || url.search) {
      // Diagnostics: where it was sent (path only, sanitized) and whether it looked like a Kick delivery, which tells a
      // misconfigured webhook URL in the Kick app apart from internet scanners.
      return reject(404, 'path', {
        path: url.pathname.replace(/[^A-Za-z0-9/._-]/g, '?').slice(0, 80),
        hadQuery: Boolean(url.search),
        looksLikeKick: typeof req.headers['kick-event-type'] === 'string' && typeof req.headers['kick-event-signature'] === 'string',
      });
    }
    if (req.method !== 'POST') return reject(405, 'method');

    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : null;
    };
    const messageId = header('kick-event-message-id');
    const timestamp = header('kick-event-message-timestamp');
    const signature = header('kick-event-signature');
    const type = header('kick-event-type');
    const version = header('kick-event-version');
    if (
      !messageId ||
      !/^[0-9A-Za-z_-]{10,64}$/.test(messageId) ||
      !timestamp ||
      !signature ||
      !type ||
      !/^[a-z0-9._]{1,64}$/.test(type) ||
      !version ||
      !/^\d{1,4}$/.test(version)
    ) {
      return reject(400, 'headers');
    }
    const sentAt = Date.parse(timestamp);
    if (!Number.isFinite(sentAt) || t - sentAt > MAX_AGE_MS || sentAt - t > MAX_FUTURE_MS) return reject(400, 'timestamp');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return reject(413, 'size');

    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return reject(413, 'size');
    }

    let verified: boolean;
    try {
      verified = await this.verify(`${messageId}.${timestamp}.`, raw, signature);
    } catch (err) {
      this.o.logger.warn('kick webhook key unavailable', { err });
      return reject(503, 'key');
    }
    if (!verified) return reject(401, 'signature');

    // Authentic. Duplicates are acknowledged (so Kick stops redelivering) but not processed again.
    if (this.seen.has(messageId)) {
      this.o.logger.info('kick webhook duplicate delivery acknowledged', { type });
      return reply(200);
    }
    this.seen.add(messageId);
    if (this.seen.size > REMEMBERED_IDS) this.seen.delete(this.seen.values().next().value!);

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reject(400, 'json');
    }
    reply(200);
    // Diagnostics without content: which event arrived, verified.
    this.o.logger.info('kick webhook delivery accepted', { type, version });
    const subscriptionId = header('kick-event-subscription-id');
    setImmediate(() => this.o.onEvent({ messageId, subscriptionId, type, version, timestamp, payload }));
  }

  /** Logs refused requests by reason (never headers, signatures or bodies), at most once a minute per reason. */
  private readonly lastLogged = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private logRejection(reason: string, status: number, extra: Record<string, unknown> = {}): void {
    const t = this.now();
    const last = this.lastLogged.get(reason) ?? 0;
    if (t - last < 60_000) {
      this.suppressed.set(reason, (this.suppressed.get(reason) ?? 0) + 1);
      return;
    }
    this.lastLogged.set(reason, t);
    const suppressed = this.suppressed.get(reason) ?? 0;
    this.suppressed.delete(reason);
    this.o.logger.warn('kick webhook request refused', {
      reason,
      status,
      ...extra,
      ...(suppressed ? { alsoRefusedSinceLastLog: suppressed } : {}),
    });
  }

  private async verify(prefix: string, raw: Buffer, signatureB64: string): Promise<boolean> {
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length < 64 || signature.length > 1024) return false;
    const data = Buffer.concat([Buffer.from(prefix, 'utf8'), raw]);
    const check = (key: crypto.KeyObject) => {
      try {
        return crypto.verify('sha256', data, key, signature);
      } catch {
        return false;
      }
    };
    const key = await this.getKey(false);
    if (check(key)) return true;
    // Kick may have rotated its key: refetch once (rate limited) and try again.
    if (this.now() - this.keyFetchedAt < KEY_REFRESH_MIN_MS) return false;
    return check(await this.getKey(true));
  }

  private getKey(refresh: boolean): Promise<crypto.KeyObject> {
    if (this.key && !refresh) return Promise.resolve(this.key);
    this.keyLoading ??= (async () => {
      try {
        const published = await this.o.fetchPublicKey();
        const key = parsePublicKey(published);
        this.key = key;
        this.keyFetchedAt = this.now();
        return key;
      } finally {
        this.keyLoading = null;
      }
    })();
    return this.keyLoading;
  }
}

/** Accepts a PEM public key, or bare base64 SPKI DER (the documentation doesn't state the format). */
export function parsePublicKey(published: string): crypto.KeyObject {
  const text = published.trim();
  if (text.includes('-----BEGIN')) return crypto.createPublicKey(text);
  return crypto.createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
