import { utilityProcess, type UtilityProcess } from 'electron';
import type { Logger } from '@conduit/logger';
import type { BackendStatus } from '@conduit/shared/app/desktop-bridge';
import { EXIT_CONFIG_ERROR, EXIT_RESTART, type SupervisorMessage, type WorkerMessage } from '@conduit/shared/app/supervisor-protocol';

const READY_TIMEOUT_MS = 20_000;
const CRASH_WINDOW_MS = 2 * 60_000;
const MAX_CRASHES_IN_WINDOW = 5;
const MAX_BACKOFF_MS = 30_000;

export interface SupervisorOptions {
  /** Absolute path of the bundled process entry (e.g. dist/server.cjs). */
  entry: string;
  serviceName: string;
  env: Record<string, string>;
  logger: Logger;
  onStatus: (status: BackendStatus) => void;
  /** Answers a credential-vault request from the backend (the reply goes back on the same private port). */
  onVaultRequest?: (request: Extract<WorkerMessage, { type: 'vault.request' }>) => SupervisorMessage;
}

/**
 * Runs a backend process as an Electron utility process and restarts it with exponential backoff
 * when it crashes. Gives up (state "failed") after repeated crashes or on a configuration error.
 */
export class BackendSupervisor {
  private child: UtilityProcess | null = null;
  private status: BackendStatus = { state: 'stopped', restarts: 0, lastError: null };
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private fatalMessage: string | null = null;
  private stopping = false;
  /** The backend asked to be restarted (to apply a backup restore): start it again at once, not as a crash. */
  private restartRequested = false;

  constructor(private readonly opts: SupervisorOptions) {}

  getStatus(): BackendStatus {
    return { ...this.status };
  }

  start(): void {
    this.stopping = false;
    this.crashTimes = [];
    this.spawn();
  }

  private setStatus(patch: Partial<BackendStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.getStatus());
  }

  private spawn(): void {
    this.restartTimer = null;
    this.fatalMessage = null;
    if (this.status.state !== 'restarting') this.setStatus({ state: 'starting' });

    const child = utilityProcess.fork(this.opts.entry, [], {
      serviceName: this.opts.serviceName,
      env: { ...process.env, ...this.opts.env } as Record<string, string>,
      stdio: 'inherit',
    });
    this.child = child;
    this.opts.logger.info('backend process spawned', { entry: this.opts.entry });

    this.readyTimer = setTimeout(() => {
      this.opts.logger.error('backend did not become ready in time; killing it');
      this.fatalMessage = 'Server did not start within the expected time.';
      child.kill();
    }, READY_TIMEOUT_MS);

    child.on('message', (message: WorkerMessage) => {
      if (message?.type === 'ready') {
        this.clearReadyTimer();
        this.opts.logger.info('backend ready', { port: message.port });
        this.setStatus({ state: 'running', lastError: null });
      } else if (message?.type === 'restart') {
        this.restartRequested = true;
      } else if (message?.type === 'fatal') {
        this.fatalMessage = String(message.message).slice(0, 500);
      } else if (message?.type === 'vault.request' && this.opts.onVaultRequest && Number.isInteger(message.id)) {
        child.postMessage(this.opts.onVaultRequest(message));
      }
    });
    child.on('exit', (code) => this.onExit(child, code));
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    this.clearReadyTimer();

    if (this.stopping) {
      this.opts.logger.info('backend stopped', { code });
      this.setStatus({ state: 'stopped' });
      return;
    }

    if (this.restartRequested && code === EXIT_RESTART) {
      this.restartRequested = false;
      this.opts.logger.info('backend restarting on request', { code });
      this.setStatus({ state: 'restarting', lastError: null });
      this.spawn();
      return;
    }
    this.restartRequested = false;

    const reason = this.fatalMessage ?? `Server exited unexpectedly (code ${code}).`;
    this.opts.logger.warn('backend exited', { code, reason });

    if (code === EXIT_CONFIG_ERROR) {
      this.setStatus({ state: 'failed', lastError: reason });
      return;
    }

    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashTimes.length > MAX_CRASHES_IN_WINDOW) {
      this.opts.logger.error('backend crashed repeatedly; giving up', { crashes: this.crashTimes.length });
      this.setStatus({ state: 'failed', lastError: reason });
      return;
    }

    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.crashTimes.length - 1));
    this.setStatus({ state: 'restarting', restarts: this.status.restarts + 1, lastError: reason });
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  /** Asks the process to shut down gracefully, killing it if it has not exited within `timeoutMs`. */
  stop(timeoutMs = 6000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.setStatus({ state: 'stopped' });
      return Promise.resolve();
    }
    this.setStatus({ state: 'stopping' });
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        this.opts.logger.warn('backend did not stop in time; killing it');
        child.kill();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.postMessage({ type: 'shutdown' });
    });
  }
}
