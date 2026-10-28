/**
 * Public data from Kick's own website API (kick.com/api/v2/…) that Kick's official public API doesn't offer:
 * - a viewer's follow date, for !followage.
 *
 * This API is unofficial and undocumented: Kick can change or block it at any time. So everything here is best effort
 * and fails softly — any problem gives null (the caller then uses a fallback or says it couldn't check), never an error:
 * - only public, read-only lookups; no tokens or credentials are ever sent;
 * - names are checked before they're put in a URL, so a chat message can't steer the request anywhere else;
 * - short time limit and size cap; answers are cached for a few minutes, so commands don't hit Kick each time;
 * - when Kick refuses (403 / 429 / 5xx), lookups pause for a while instead of retrying.
 */
import type { FetchLike } from '../app/types';

const BASE = 'https://kick.com/api/v2/channels';
const NAME = /^[A-Za-z0-9_-]{1,25}$/;
const CACHE_MS = 5 * 60_000;
const PAUSE_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 500;

export interface KickWebViewer {
  /** When they started following the channel (ISO), or null when they don't follow it. */
  followingSince: string | null;
  /** Subscriber months, when Kick says. */
  subscribedFor: number | null;
}

export class KickWebData {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private pausedUntil = 0;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly o: { now: () => Date; fetch?: FetchLike; onProblem?: (detail: string) => void }) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** A viewer's relationship to a channel: follow date and subscriber months. */
  async viewer(channelSlug: string, username: string): Promise<KickWebViewer | null> {
    if (!NAME.test(channelSlug) || !NAME.test(username)) return null;
    const body = await this.get(`${BASE}/${channelSlug.toLowerCase()}/users/${username.toLowerCase()}`);
    if (!body) return null;
    const since = typeof body.following_since === 'string' && Number.isFinite(Date.parse(body.following_since)) ? body.following_since : null;
    const months = Number(body.subscribed_for);
    return { followingSince: since, subscribedFor: Number.isInteger(months) && months > 0 ? months : null };
  }

  private async get(url: string): Promise<Record<string, unknown> | null> {
    const now = this.o.now().getTime();
    const hit = this.cache.get(url);
    if (hit && now - hit.at < CACHE_MS) return hit.value as Record<string, unknown> | null;
    if (now < this.pausedUntil) return null;
    let value: Record<string, unknown> | null = null;
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        this.pausedUntil = now + PAUSE_MS;
        this.o.onProblem?.(`Kick's website refused the request (HTTP ${res.status}); lookups pause for 10 minutes.`);
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (res.ok) {
        const text = await res.text();
        if (text.length <= MAX_BYTES) {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
    } catch {
      value = null; // network problem, timeout or not JSON: no value this time
    }
    this.cache.set(url, { at: now, value });
    if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
