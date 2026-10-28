/** Messages between the desktop backend supervisor and a supervised process (Electron utility process). */

/**
 * Credential vault operations. The backend asks the desktop main process, the only place where OS-backed
 * encryption (Electron safeStorage / Windows DPAPI) is available, to store, read or delete a credential.
 * The channel is the private parent ↔ utility-process port; it is not reachable by the renderer or other programs.
 */
export type VaultOperation = 'get' | 'set' | 'delete' | 'status';

export type SupervisorMessage =
  | { type: 'shutdown' }
  | { type: 'vault.response'; id: number; ok: true; value: string | null }
  | { type: 'vault.response'; id: number; ok: false; error: string };

export type WorkerMessage =
  | { type: 'ready'; port: number }
  /** Unrecoverable startup failure (bad config, damaged database, port in use). */
  | { type: 'fatal'; message: string }
  /** About to exit so a staged backup restore can be applied: start again right away. */
  | { type: 'restart' }
  | { type: 'vault.request'; id: number; op: VaultOperation; key: string; value?: string };

/** Credential keys: lower-case letters, digits and `:_-`, so they are always safe file names. */
export const VAULT_KEY_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/;

/** Exit code for invalid configuration; the supervisor does not restart on it. */
export const EXIT_CONFIG_ERROR = 78;
/** Exit code for a requested restart (e.g. to apply a backup restore); not a crash. */
export const EXIT_RESTART = 75;
