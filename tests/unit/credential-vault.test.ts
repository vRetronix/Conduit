import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialVault, handleVaultRequest, type Encryptor } from '../../apps/desktop/src/credential-vault';
import { ParentPortVault } from '../../apps/server/src/app/vault';
import type { SupervisorMessage, WorkerMessage } from '@conduit/shared';

/** Stand-in for safeStorage (DPAPI) in tests: a reversible transform that never leaves plaintext on disk. */
const fakeDpapi: Encryptor = {
  unavailableReason: () => null,
  encrypt: (s) => Buffer.concat([Buffer.from('DPAPI:'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
  decrypt: (b) => Buffer.from(b.subarray(6).map((x) => x ^ 0x5a)).toString('utf8'),
};

const dirs: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-vault-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SECRET = JSON.stringify({ accessToken: 'access-SECRET-123', refreshToken: 'refresh-SECRET-456' });

describe('FileCredentialVault (desktop main process)', () => {
  it('stores only ciphertext, and round-trips', () => {
    const dir = tempDir();
    const vault = new FileCredentialVault(dir, fakeDpapi);
    vault.set('connection:0b8f0a8e-1f7e-4c55-9d5c-8d2b1f6f2a11', SECRET);
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['connection__0b8f0a8e-1f7e-4c55-9d5c-8d2b1f6f2a11.bin']);
    const raw = fs.readFileSync(path.join(dir, files[0]!));
    expect(raw.toString('latin1')).not.toContain('SECRET');
    expect(vault.get('connection:0b8f0a8e-1f7e-4c55-9d5c-8d2b1f6f2a11')).toBe(SECRET);
  });

  it('deletes credentials and returns null for missing ones', () => {
    const vault = new FileCredentialVault(tempDir(), fakeDpapi);
    vault.set('connection:a', SECRET);
    vault.delete('connection:a');
    expect(vault.get('connection:a')).toBeNull();
    vault.delete('connection:a'); // idempotent
  });

  it('rejects keys that could escape the folder', () => {
    const vault = new FileCredentialVault(tempDir(), fakeDpapi);
    for (const key of ['../evil', 'a/b', 'A', '', 'x'.repeat(200), 'c:\\x']) expect(() => vault.set(key, 'v')).toThrow(/Invalid credential key/);
  });

  it('refuses to store anything when OS encryption is unavailable (no plaintext fallback)', () => {
    const dir = tempDir();
    const vault = new FileCredentialVault(dir, { ...fakeDpapi, unavailableReason: () => 'DPAPI unavailable' });
    expect(() => vault.set('connection:a', SECRET)).toThrow('DPAPI unavailable');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('answers backend requests without echoing values in errors', () => {
    const vault = new FileCredentialVault(tempDir(), fakeDpapi);
    expect(handleVaultRequest(vault, { type: 'vault.request', id: 1, op: 'set', key: 'connection:a', value: SECRET })).toEqual({ type: 'vault.response', id: 1, ok: true, value: null });
    expect(handleVaultRequest(vault, { type: 'vault.request', id: 2, op: 'get', key: 'connection:a' })).toEqual({ type: 'vault.response', id: 2, ok: true, value: SECRET });
    expect(handleVaultRequest(vault, { type: 'vault.request', id: 3, op: 'status', key: 'status' })).toEqual({ type: 'vault.response', id: 3, ok: true, value: null });
    const bad = handleVaultRequest(vault, { type: 'vault.request', id: 4, op: 'set', key: '../x', value: SECRET });
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).not.toContain('SECRET');
  });
});

describe('ParentPortVault (backend side)', () => {
  it('round-trips through the private port to the main-process vault', async () => {
    const mainVault = new FileCredentialVault(tempDir(), fakeDpapi);
    let backend!: ParentPortVault;
    backend = new ParentPortVault({
      postMessage: (msg: WorkerMessage) => {
        if (msg.type === 'vault.request') queueMicrotask(() => backend.handleMessage(handleVaultRequest(mainVault, msg) as SupervisorMessage));
      },
    });
    expect(await backend.unavailableReason()).toBeNull();
    await backend.set('connection:x', SECRET);
    expect(await backend.get('connection:x')).toBe(SECRET);
    await backend.delete('connection:x');
    expect(await backend.get('connection:x')).toBeNull();
    await expect(backend.set('../x', 'v')).rejects.toThrow(/Invalid credential key/);
  });
});
