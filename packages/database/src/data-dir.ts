/**
 * Where CONDUIT keeps its data. The desktop app uses Electron's userData folder (%APPDATA%\CONDUIT) unless
 * CONDUIT_DATA_DIR says otherwise; the standalone server and the recovery CLI use the same default without Electron.
 */
import path from 'node:path';

/** Database file name inside the data directory. */
export const DATABASE_FILE = 'conduit.db';

/** The edition's data folder name; "CONDUIT" where no edition is built in (tests). */
const dataFolder = typeof __CONDUIT_EDITION__ === 'object' ? __CONDUIT_EDITION__.dataFolder : 'CONDUIT';

/** Default data folder without Electron: %APPDATA%\<edition data folder> on Windows, ~/.conduit elsewhere. */
export function defaultDataDirectory(env: NodeJS.ProcessEnv, homedir: string): string {
  return env.APPDATA ? path.join(env.APPDATA, dataFolder) : path.join(homedir, '.conduit');
}
