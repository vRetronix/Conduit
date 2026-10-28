/**
 * Bot avatars and server icons from Discord's CDN, as data: URLs. The renderer's CSP allows images only from 'self' and
 * data:, so it never contacts Discord itself; the backend fetches the image named by the real avatar/icon hash Discord
 * reported (gateway or API), with size and type limits, and caches it in memory.
 *
 * get() never waits for the network: it returns what is cached (or null) and fetches in the background, so status
 * polls stay fast. Failures are remembered for a while to avoid hammering the CDN, and the UI shows a fallback icon.
 */
import type { FetchLike } from '../app/types';

const CDN = 'https://cdn.discordapp.com';
const MAX_BYTES = 128 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const RETRY_FAILED_MS = 10 * 60_000;
const MAX_ENTRIES = 200;
const HASH = /^(a_)?[0-9a-f]{32}$/;
const ID = /^\d{1,25}$/;

export type ImageKind = 'avatar' | 'icon';

interface Entry {
  dataUrl: string | null;
  failedAt: number | null;
}

export class DiscordImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly fetchImpl: FetchLike;

  constructor(private readonly o: { version: string; fetch?: FetchLike; now?: () => number }) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** A user's avatar (`avatar`) or a server's icon (`icon`) as a data: URL, if cached. Null hash means none set. */
  get(kind: ImageKind, id: string, hash: string | null | undefined): string | null {
    if (!hash || !HASH.test(hash) || !ID.test(id)) return null;
    const key = `${kind}/${id}/${hash}`;
    const entry = this.entries.get(key);
    const now = this.o.now?.() ?? Date.now();
    if (entry?.dataUrl) return entry.dataUrl;
    if (!entry || (entry.failedAt !== null && now - entry.failedAt > RETRY_FAILED_MS)) void this.load(key, kind, id, hash);
    return null;
  }

  /** Resolves once pending fetches have finished (tests, and callers that can wait). */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }

  private load(key: string, kind: ImageKind, id: string, hash: string): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const dataUrl = await this.download(`${CDN}/${kind === 'avatar' ? 'avatars' : 'icons'}/${id}/${hash}.png?size=64`);
      if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { dataUrl, failedAt: dataUrl ? null : (this.o.now?.() ?? Date.now()) });
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async download(url: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': `DiscordBot (https://github.com/vRetronix/CONDUIT, ${this.o.version}) CONDUIT` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!res.ok || !TYPES.has(type)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
      return `data:${type};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
