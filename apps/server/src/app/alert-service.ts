/**
 * Pop-up alerts for the dashboard (see @conduit/shared alerts): kept in memory (the newest 50), never secrets.
 *
 * - push(): one alert; the same key isn't repeated within a minute (a burst of rate-limited requests is one bubble).
 * - watch(): a status read every few seconds; when it goes from healthy to a problem, or back, one alert says so. The
 *   first reading is only a baseline (starting CONDUIT doesn't announce the state the Dashboard already shows).
 */
import type { Logger } from '@conduit/logger';
import { alertQuerySchema, type AlertFeed, type AlertLevel, type AlertView } from '@conduit/shared';
import { parseInput } from '../validation';

const KEPT = 50;
const RETURNED = 20;
const REPEAT_WITHIN_MS = 60_000;
const WATCH_INTERVAL_MS = 5_000;

/** What a watcher sees: healthy or not (null = in between, e.g. connecting — no alert either way). */
export interface WatchReading {
  healthy: boolean | null;
  /** Shown when it becomes unhealthy. */
  problem: { level: AlertLevel; title: string; detail: string | null };
  /** Shown when it is healthy again. */
  recovered: string;
}

interface Watcher {
  key: string;
  read: () => WatchReading | null | Promise<WatchReading | null>;
  healthy: boolean | null;
  baseline: boolean;
}

export class AlertService {
  private readonly items: AlertView[] = [];
  private nextId = 1;
  private readonly lastByKey = new Map<string, number>();
  private readonly watchers: Watcher[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: { now: () => Date; logger: Logger }) {}

  push(a: { key: string; level: AlertLevel; title: string; detail?: string | null }): void {
    const now = this.o.now().getTime();
    const last = this.lastByKey.get(a.key);
    if (last !== undefined && now - last < REPEAT_WITHIN_MS) return;
    // Keys older than the repeat window no longer matter: forget them, so varied alerts can't grow this map forever.
    for (const [key, at] of this.lastByKey) if (now - at >= REPEAT_WITHIN_MS) this.lastByKey.delete(key);
    this.lastByKey.set(a.key, now);
    this.items.push({ id: this.nextId++, at: new Date(now).toISOString(), level: a.level, title: a.title, detail: a.detail ?? null });
    if (this.items.length > KEPT) this.items.shift();
    this.o.logger.info('alert', { key: a.key, level: a.level, title: a.title });
  }

  watch(key: string, read: Watcher['read']): void {
    this.watchers.push({ key, read, healthy: null, baseline: true });
  }

  query(raw: unknown): AlertFeed {
    const { after } = parseInput(alertQuerySchema, raw ?? {});
    const latestId = this.nextId - 1;
    if (after === null) return { alerts: [], latestId };
    return { alerts: this.items.filter((a) => a.id > after).slice(-RETURNED), latestId };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads every watcher once. Public for tests. */
  async tick(): Promise<void> {
    for (const w of this.watchers) {
      let r: WatchReading | null;
      try {
        r = await w.read();
      } catch (err) {
        this.o.logger.warn('alert watcher failed', { key: w.key, err });
        continue;
      }
      if (!r || r.healthy === null) continue;
      const was = w.healthy;
      w.healthy = r.healthy;
      if (w.baseline) {
        w.baseline = false;
        continue;
      }
      if (was === true && !r.healthy) this.push({ key: `${w.key}:down`, ...r.problem });
      else if (was === false && r.healthy) this.push({ key: `${w.key}:up`, level: 'info', title: r.recovered });
    }
  }
}
