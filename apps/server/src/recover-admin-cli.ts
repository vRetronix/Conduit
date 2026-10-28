/**
 * Node.js entry for offline administrator recovery (development and standalone-server installs):
 *   npm run recover-admin -- --username <admin> --confirm [--data-dir <folder>]
 * Packaged desktop installs use `CONDUIT.exe --recover-admin …` instead (see docs/SETUP.md).
 */
import os from 'node:os';
import path from 'node:path';
import { defaultDataDirectory } from '@conduit/database';
import { createLogger } from '@conduit/logger';
import { envValue } from '@conduit/shared';
import { parseRecoveryArgs, RECOVERY_USAGE, recoverAdminPassword } from './recovery';
import { formatRecoveryResult } from './recovery-output';

async function run(): Promise<number> {
  const args = parseRecoveryArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`${args.error}\n${RECOVERY_USAGE}\n`);
    return 2;
  }
  const dataDir =
    args.dataDir ??
    envValue(process.env, 'CONDUIT_DATA_DIR') ??
    defaultDataDirectory(process.env, os.homedir());
  const logger = createLogger({ name: 'recovery', filePath: path.join(dataDir, 'logs', 'server.log'), console: false });
  try {
    const result = await recoverAdminPassword({ dataDir, username: args.username!, confirm: args.confirm, logger });
    const { text, exitCode } = formatRecoveryResult(result, dataDir);
    (exitCode === 0 ? process.stdout : process.stderr).write(`${text}\n`);
    return exitCode;
  } finally {
    logger.close();
  }
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Recovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
