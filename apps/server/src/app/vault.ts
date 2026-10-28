/**
 * Credential vault as seen by the backend. Tokens are encrypted at rest by the desktop main process with Electron
 * safeStorage (Windows DPAPI); the backend reaches it over the private utility-process port. Without the desktop app
 * (standalone server) there is no OS-backed encryption, so platform connections are unavailable rather than stored
 * insecurely.
 */
import { VAULT_KEY_PATTERN, type SupervisorMessage, type VaultOperation, type WorkerMessage } from '@conduit/shared';

export interface CredentialVault {
  /** Null when the vault can be used; otherwise why not. */
  unavailableReason(): Promise<string | null>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function checkKey(key: string): void {
  if (!VAULT_KEY_PATTERN.test(key)) throw new VaultError('Invalid credential key');
}

interface PortLike {
  postMessage(message: WorkerMessage): void;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Vault backed by the desktop main process. `handleMessage` must receive every message from the parent port. */
export class ParentPortVault implements CredentialVault {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: string | null) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly port: PortLike) {}

  handleMessage(message: SupervisorMessage): void {
    if (message.type !== 'vault.response') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new VaultError(message.error));
  }

  private request(op: VaultOperation, key: string, value?: string): Promise<string | null> {
    if (op !== 'status') checkKey(key);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VaultError('The credential vault did not respond'));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ type: 'vault.request', id, op, key, ...(value !== undefined ? { value } : {}) });
    });
  }

  async unavailableReason(): Promise<string | null> {
    try {
      return await this.request('status', 'status');
    } catch (err) {
      return err instanceof Error ? err.message : 'The credential vault is unavailable';
    }
  }
  get(key: string): Promise<string | null> {
    return this.request('get', key);
  }
  async set(key: string, value: string): Promise<void> {
    await this.request('set', key, value);
  }
  async delete(key: string): Promise<void> {
    await this.request('delete', key);
  }
}

/** Standalone server: no OS-backed encryption, so nothing is ever stored. */
export class UnavailableVault implements CredentialVault {
  private static readonly REASON =
    'Secure credential storage needs the CONDUIT desktop app (Windows DPAPI). Platform connections are not available in the standalone server.';
  async unavailableReason(): Promise<string> {
    return UnavailableVault.REASON;
  }
  async get(): Promise<string | null> {
    throw new VaultError(UnavailableVault.REASON);
  }
  async set(): Promise<void> {
    throw new VaultError(UnavailableVault.REASON);
  }
  async delete(): Promise<void> {
    throw new VaultError(UnavailableVault.REASON);
  }
}

/** In-memory vault for automated tests only. */
export class MemoryVault implements CredentialVault {
  readonly entries = new Map<string, string>();
  async unavailableReason(): Promise<string | null> {
    return null;
  }
  async get(key: string): Promise<string | null> {
    checkKey(key);
    return this.entries.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    checkKey(key);
    this.entries.set(key, value);
  }
  async delete(key: string): Promise<void> {
    checkKey(key);
    this.entries.delete(key);
  }
}
