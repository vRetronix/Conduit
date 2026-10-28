import path from 'node:path';
import { app, dialog, utilityProcess } from 'electron';

/**
 * `CONDUIT.exe --recover-admin --username <admin> --confirm`
 *
 * Offline administrator password recovery for packaged installs. Runs instead of the normal app: no window and no
 * backend. The caller has already acquired the single-instance lock, so CONDUIT cannot be running meanwhile. The
 * bundled recovery tool (apps/server/src/recover-admin-cli.ts) does the work against the resolved data folder. Its
 * result is shown in a dialog and echoed to stdout; the temporary password is never written to any log.
 */
export async function runRecoveryMode(argv: readonly string[], dataDir: string): Promise<number> {
  const flagIndex = argv.indexOf('--recover-admin');
  const userArgs = argv.slice(flagIndex + 1);
  const args = userArgs.includes('--data-dir') ? userArgs : [...userArgs, '--data-dir', dataDir];

  const child = utilityProcess.fork(path.join(__dirname, 'recover-admin.cjs'), args, {
    serviceName: 'CONDUIT Recovery',
    stdio: 'pipe',
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const code = await new Promise<number>((resolve) => child.once('exit', resolve));

  const text = output.trim() || `Recovery tool exited with code ${code}.`;
  process.stdout.write(`${text}\n`);
  await dialog.showMessageBox({
    type: code === 0 ? 'info' : 'error',
    title: 'CONDUIT administrator recovery',
    message: code === 0 ? 'Administrator password reset' : 'Recovery did not run',
    detail: text,
    buttons: ['Close'],
  });
  return code;
}

export function isRecoveryInvocation(argv: readonly string[]): boolean {
  return argv.includes('--recover-admin');
}

/** Shown when recovery is requested while CONDUIT is already open. */
export async function refuseRecoveryWhileRunning(): Promise<void> {
  const text = 'CONDUIT is running. Close every CONDUIT window and run the recovery command again.';
  process.stdout.write(`${text}\n`);
  await app.whenReady();
  await dialog.showMessageBox({ type: 'error', title: 'CONDUIT administrator recovery', message: 'Recovery did not run', detail: text, buttons: ['Close'] });
}
