/**
 * Where CONDUIT keeps its data. The desktop app uses Electron's userData folder (%APPDATA%\CONDUIT) unless
 * CONDUIT_DATA_DIR says otherwise; the standalone server and the recovery CLI use the same default without Electron.
 */
import path from 'node:path';

/** Database file name inside the data directory. */
export const DATABASE_FILE = 'conduit.db';

/** Default data folder without Electron: %APPDATA%\CONDUIT on Windows, ~/.conduit elsewhere. */
export function defaultDataDirectory(env: NodeJS.ProcessEnv, homedir: string): string {
  return env.APPDATA ? path.join(env.APPDATA, 'CONDUIT') : path.join(homedir, '.conduit');
}
