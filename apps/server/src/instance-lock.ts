import fs from 'node:fs';
import path from 'node:path';

/**
 * Marker the server writes into its data directory while running, so offline tools (admin recovery) can refuse
 * to touch the database while CONDUIT is open. It is advisory: the server never refuses to start because of it.
 */
export const LOCK_FILE = 'server.lock';

interface LockContents {
  pid: number;
  startedAt: string;
}

export function writeInstanceLock(dataDir: string): () => void {
  const file = path.join(dataDir, LOCK_FILE);
  const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(contents));
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as LockContents;
      if (current.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // already gone or unreadable
    }
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockState = { state: 'none' } | { state: 'running'; pid: number; startedAt: string } | { state: 'stale'; pid: number };

/** Whether a CONDUIT server appears to be running on `dataDir`. */
export function readInstanceLock(dataDir: string, alive: (pid: number) => boolean = isProcessAlive): LockState {
  const file = path.join(dataDir, LOCK_FILE);
  if (!fs.existsSync(file)) return { state: 'none' };
  let contents: LockContents;
  try {
    contents = JSON.parse(fs.readFileSync(file, 'utf8')) as LockContents;
  } catch {
    // Unreadable lock: assume running (fail safe). The operator can delete the file if CONDUIT is closed.
    return { state: 'running', pid: -1, startedAt: 'unknown' };
  }
  if (!Number.isInteger(contents.pid) || contents.pid <= 0) return { state: 'running', pid: -1, startedAt: 'unknown' };
  return alive(contents.pid) ? { state: 'running', pid: contents.pid, startedAt: contents.startedAt } : { state: 'stale', pid: contents.pid };
}
