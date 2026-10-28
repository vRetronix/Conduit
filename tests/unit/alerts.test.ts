/** Pop-up alerts: the feed, repeat suppression, account watchers, and the rate-limit hooks of the platform clients. */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@conduit/logger';
import { DiscordApi } from '../../apps/server/src/discord/discord-api';
import { KickChatApi } from '../../apps/server/src/kick/kick-chat-api';
import { AlertService, type WatchReading } from '../../apps/server/src/app/alert-service';
import { TestClock } from '../helpers/harness';

const logger = createLogger({ name: 'test', level: 'error', console: false });
const make = () => {
  const clock = new TestClock();
  return { clock, alerts: new AlertService({ now: clock.now, logger }) };
};

describe('AlertService', () => {
  it('first load gets only the latest id (no old alerts); later polls get what is new', () => {
    const { alerts } = make();
    alerts.push({ key: 'a', level: 'warn', title: 'Old' });
    expect(alerts.query({})).toEqual({ alerts: [], latestId: 1 });
    alerts.push({ key: 'b', level: 'error', title: 'New', detail: 'Something' });
    expect(alerts.query({ after: 1 })).toEqual({ alerts: [expect.objectContaining({ id: 2, level: 'error', title: 'New', detail: 'Something' })], latestId: 2 });
    expect(alerts.query({ after: 2 }).alerts).toEqual([]);
    expect(() => alerts.query({ after: -1 })).toThrow();
  });

  it('the same alert isn’t repeated within a minute (a burst of rate limits is one bubble)', () => {
    const { alerts, clock } = make();
    for (let i = 0; i < 5; i++) alerts.push({ key: 'discord-rate-limit', level: 'warn', title: 'Discord is rate limiting' });
    expect(alerts.query({ after: 0 }).alerts).toHaveLength(1);
    clock.advance(61_000);
    alerts.push({ key: 'discord-rate-limit', level: 'warn', title: 'Discord is rate limiting' });
    expect(alerts.query({ after: 0 }).alerts).toHaveLength(2);
  });

  it('watchers alert when an account goes down and when it comes back; the starting state is only a baseline', async () => {
    const { alerts, clock } = make();
    let healthy: boolean | null = false;
    const reading = (): WatchReading => ({ healthy, problem: { level: 'warn', title: 'Discord bot disconnected', detail: 'Network' }, recovered: 'Discord bot connected again' });
    alerts.watch('discord-bot', reading);
    await alerts.tick(); // starts disconnected: no alert (the Dashboard shows it)
    healthy = true;
    await alerts.tick();
    healthy = null; // reconnecting: nothing yet
    await alerts.tick();
    healthy = false;
    await alerts.tick();
    clock.advance(61_000);
    healthy = true;
    await alerts.tick();
    expect(alerts.query({ after: 0 }).alerts.map((a) => [a.level, a.title])).toEqual([
      ['info', 'Discord bot connected again'],
      ['warn', 'Discord bot disconnected'],
      ['info', 'Discord bot connected again'],
    ]);
  });
});

describe('rate-limit hooks', () => {
  const limited = async () => new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 3 }), { status: 429, headers: { 'retry-after': '3' } });

  it('Discord: a 429 that keeps coming is waited out twice, then fails and tells the alert hook once', async () => {
    const seen: Array<number | undefined> = [];
    const waits: number[] = [];
    let calls = 0;
    const api = new DiscordApi({
      version: 'test',
      fetch: async () => (calls++, limited()),
      onRateLimited: (s) => seen.push(s),
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(api.botGuilds('token')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 3 });
    expect([calls, waits]).toEqual([3, [3000, 3000]]);
    expect(seen).toEqual([3]);
  });

  it('Discord: a short 429 is waited out (fractions of a second included) and the request succeeds, with no alert', async () => {
    const seen: Array<number | undefined> = [];
    const waits: number[] = [];
    let calls = 0;
    const fetch = async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.35 }), { status: 429, headers: { 'retry-after': '1' } })
        : new Response(JSON.stringify([{ id: '42', name: 'Retro Server' }]), { status: 200 });
    const api = new DiscordApi({ version: 'test', fetch, onRateLimited: (s) => seen.push(s), sleep: async (ms) => void waits.push(ms) });
    await expect(api.botGuilds('token')).resolves.toEqual([expect.objectContaining({ id: '42' })]);
    expect([calls, waits, seen]).toEqual([2, [350], []]);
  });

  it('Discord: a long 429 (over 5 s) isn’t waited for: it fails at once for the caller to handle', async () => {
    const seen: Array<number | undefined> = [];
    const waits: number[] = [];
    let calls = 0;
    const fetch = async () => (calls++, new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 30 }), { status: 429 }));
    const api = new DiscordApi({ version: 'test', fetch, onRateLimited: (s) => seen.push(s), sleep: async (ms) => void waits.push(ms) });
    await expect(api.botGuilds('token')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect([calls, waits, seen]).toEqual([1, [], [30]]);
  });

  it('Kick: a 429 tells the alert hook', async () => {
    const seen: Array<number | undefined> = [];
    const api = new KickChatApi({ fetch: limited, onRateLimited: (s) => seen.push(s) });
    await expect(api.sendMessage('token', '123', 'hi')).rejects.toThrow(/rate limiting/);
    expect(seen).toEqual([3]);
  });
});
