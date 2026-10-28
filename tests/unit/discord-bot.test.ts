import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@conduit/logger';
import { DiscordBotRunner } from '../../apps/server/src/discord/discord-bot';
import { BOT_TOKEN } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';

const logger = createLogger({ name: 'test', level: 'error', console: false });
let gateway: FakeGateway;
let runner: DiscordBotRunner;
let reported: Array<Array<{ id: string; name: string }>>;

beforeEach(() => {
  vi.useFakeTimers();
  gateway = new FakeGateway();
  reported = [];
  runner = new DiscordBotRunner({ logger, now: () => new Date(), factory: gateway.factory, onGuilds: (g) => reported.push(g) });
});
afterEach(async () => {
  await runner.stop();
  vi.useRealTimers();
});

describe('DiscordBotRunner', () => {
  it('connects, reports the bot identity and its servers', async () => {
    gateway.guilds = [{ id: '1', name: 'Server' }];
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status()).toMatchObject({ status: 'connected', username: 'RetroBot' });
    expect(runner.liveGuilds()).toEqual([{ id: '1', name: 'Server' }]);
    expect(reported.at(-1)).toEqual([{ id: '1', name: 'Server' }]);
  });

  it('does not open a second connection for the same token', async () => {
    await runner.start(BOT_TOKEN);
    await runner.start(BOT_TOKEN);
    expect(gateway.logins).toBe(1);
    expect(gateway.clients).toHaveLength(1);
  });

  it('retries network failures with backoff, and gives up after several attempts', async () => {
    gateway.outcome = 'network';
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status()).toMatchObject({ status: 'disconnected', retryable: true, problem: expect.stringMatching(/retrying in 10 seconds/) });
    expect(gateway.logins).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateway.logins).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gateway.logins).toBe(3);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gateway.logins).toBe(8);
    expect(runner.status()).toMatchObject({ status: 'error', retryable: true, problem: expect.stringMatching(/after several attempts/) });
    // Every failed client was destroyed: never more than one live connection.
    expect(gateway.destroyed).toBe(8);
  });

  it('recovers when a retry succeeds', async () => {
    gateway.outcome = 'network';
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    gateway.outcome = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.status().status).toBe('connected');
  });

  it('never retries a rejected token (it would only burn identify attempts)', async () => {
    gateway.outcome = 'invalid_token';
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gateway.logins).toBe(1);
    expect(runner.status()).toMatchObject({ status: 'error', retryable: false });
  });

  it('ignores events from a connection that was stopped', async () => {
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    const old = gateway.clients[0]!;
    await runner.stop();
    old.destroyed = false; // simulate a late event from the old session
    old.emit('resumed');
    expect(runner.status().status).toBe('not_configured');
  });

  it('a retry scheduled before stop() never fires', async () => {
    gateway.outcome = 'network';
    await runner.start(BOT_TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gateway.logins).toBe(1);
  });
});
