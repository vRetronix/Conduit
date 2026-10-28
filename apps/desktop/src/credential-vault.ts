/**
 * Encrypted credential storage in the desktop main process — the only process with OS-backed encryption
 * (Electron safeStorage, which uses Windows DPAPI). Each credential is one file under <data>/credentials, holding
 * only ciphertext. The backend reaches this over the private utility-process port (see handleVaultRequest).
 * Kept free of Electron imports (the encryptor is injected) so it can be unit-tested.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  VAULT_KEY_PATTERN,
  type SupervisorMessage,
  type WorkerMessage,
} from '@conduit/shared/app/supervisor-protocol';

export interface Encryptor {
  /** Null when encryption works; otherwise why not. */
  unavailableReason(): string | null;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

const MAX_VALUE_BYTES = 64 * 1024;

export class FileCredentialVault {
  constructor(
    private readonly dir: string,
    private readonly encryptor: Encryptor,
  ) {}

  private file(key: string): string {
    if (!VAULT_KEY_PATTERN.test(key)) throw new Error('Invalid credential key');
    // ':' is not allowed in Windows file names.
    return path.join(this.dir, `${key.replace(/:/g, '__')}.bin`);
  }

  unavailableReason(): string | null {
    return this.encryptor.unavailableReason();
  }

  get(key: string): string | null {
    const file = this.file(key);
    if (!fs.existsSync(file)) return null;
    return this.encryptor.decrypt(fs.readFileSync(file));
  }

  set(key: string, value: string): void {
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error('Credential too large');
    const reason = this.encryptor.unavailableReason();
    if (reason) throw new Error(reason);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(key);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, this.encryptor.encrypt(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  delete(key: string): void {
    fs.rmSync(this.file(key), { force: true });
  }
}

/** Serves one vault request from the backend. Errors are reported without echoing values. */
export function handleVaultRequest(vault: FileCredentialVault, msg: Extract<WorkerMessage, { type: 'vault.request' }>): SupervisorMessage {
  try {
    switch (msg.op) {
      case 'status':
        return { type: 'vault.response', id: msg.id, ok: true, value: vault.unavailableReason() };
      case 'get':
        return { type: 'vault.response', id: msg.id, ok: true, value: vault.get(msg.key) };
      case 'set':
        if (typeof msg.value !== 'string') throw new Error('Missing value');
        vault.set(msg.key, msg.value);
        return { type: 'vault.response', id: msg.id, ok: true, value: null };
      case 'delete':
        vault.delete(msg.key);
        return { type: 'vault.response', id: msg.id, ok: true, value: null };
      default:
        throw new Error('Unknown vault operation');
    }
  } catch (err) {
    return { type: 'vault.response', id: msg.id, ok: false, error: err instanceof Error ? err.message : 'Vault error' };
  }
}
