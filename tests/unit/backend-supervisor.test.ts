// The desktop's backend supervisor, with Electron's utilityProcess replaced by a fake child process.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => this.emit('exit', 1));
}
const children: FakeChild[] = [];
vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
  },
}));

const { BackendSupervisor } = await import('../../apps/desktop/src/backend-supervisor');
const { EXIT_RESTART } = await import('@conduit/shared/app/supervisor-protocol');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger, close: vi.fn() };
const make = () => {
  const statuses: string[] = [];
  const s = new BackendSupervisor({ entry: 'server.cjs', serviceName: 'test', env: {}, logger: logger as never, onStatus: (st) => statuses.push(st.state) });
  return { s, statuses };
};

beforeEach(() => {
  children.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('BackendSupervisor', () => {
  it('a requested restart (to apply a backup restore) starts the backend again at once and is not counted as a crash', () => {
    const { s } = make();
    s.start();
    children[0]!.emit('message', { type: 'ready', port: 1 });
    children[0]!.emit('message', { type: 'restart' });
    children[0]!.emit('exit', EXIT_RESTART);
    expect(children).toHaveLength(2); // respawned immediately, no backoff delay
    expect(s.getStatus()).toMatchObject({ state: 'restarting', restarts: 0, lastError: null });
    children[1]!.emit('message', { type: 'ready', port: 1 });
    expect(s.getStatus().state).toBe('running');
  });

  it('an unexpected exit is still a crash, restarted with backoff', () => {
    const { s } = make();
    s.start();
    children[0]!.emit('message', { type: 'ready', port: 1 });
    children[0]!.emit('exit', 1);
    expect(children).toHaveLength(1);
    expect(s.getStatus()).toMatchObject({ state: 'restarting', restarts: 1 });
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
  });

  it('the restart exit code without a restart request is treated as a crash', () => {
    const { s } = make();
    s.start();
    children[0]!.emit('exit', EXIT_RESTART);
    expect(children).toHaveLength(1);
    expect(s.getStatus().restarts).toBe(1);
  });
});
