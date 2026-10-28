/**
 * Server entry point. Runs either as an Electron utility process (launched by the desktop app's
 * backend supervisor) or standalone with Node.js (`npm run server`), e.g. on a VPS later.
 */
import os from 'node:os';
import path from 'node:path';
import {
  applyPendingRestore,
  checkIntegrity,
  DATABASE_FILE,
  migrate,
  migrations,
  openDatabase,
  defaultDataDirectory,
  type Database,
} from '@conduit/database';
import { createLogger } from '@conduit/logger';
import { generateToken, PasswordHasher, verifyArgon2Implementation } from '@conduit/security';
import {
  ConfigError,
  EXIT_CONFIG_ERROR,
  EXIT_RESTART,
  loadServerConfig,
  type SupervisorMessage,
  type WorkerMessage,
} from '@conduit/shared';
import { writeInstanceLock } from './instance-lock';
import { ParentPortVault, UnavailableVault, type CredentialVault } from './app/vault';
import { startServer, type RunningServer } from './server';
import { createServices } from './services';

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const notifyParent = (message: WorkerMessage) => parentPort?.postMessage(message);
/** Encrypted token storage lives in the desktop main process; a standalone server has none (nothing is stored). */
const vault: CredentialVault = parentPort ? new ParentPortVault(parentPort) : new UnavailableVault();

const version = typeof __CONDUIT_VERSION__ === 'string' ? __CONDUIT_VERSION__ : '0.0.0-dev';

async function main(): Promise<void> {
  let config;
  // An explicit data directory (always the case under the desktop app) is used as-is; otherwise the default location.
  try {
    config = loadServerConfig(process.env, { dataDir: defaultDataDirectory(process.env, os.homedir()) });
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    console.error(message);
    notifyParent({ type: 'fatal', message });
    process.exit(EXIT_CONFIG_ERROR); // The supervisor must not restart-loop on bad configuration.
  }

  const logger = createLogger({
    name: 'server',
    level: config.logLevel,
    filePath: path.join(config.dataDir, 'logs', 'server.log'),
    console: config.logToConsole,
  });
  logger.info('starting', { version, pid: process.pid, host: config.host, port: config.port, dataDir: config.dataDir });

  let db: Database | undefined;
  let server: RunningServer | undefined;
  let releaseLock: (() => void) | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    try {
      await server?.close();
      db?.close();
      releaseLock?.();
    } catch (err) {
      logger.error('error during shutdown', { err });
      exitCode ||= 1;
    }
    logger.info('stopped');
    logger.close();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  parentPort?.on('message', (e) => {
    const msg = e.data as SupervisorMessage | undefined;
    if (msg?.type === 'shutdown') void shutdown('supervisor request');
    else if (msg?.type === 'vault.response' && vault instanceof ParentPortVault) vault.handleMessage(msg);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    void shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
  });

  try {
    // A restore chosen in Settings is applied here, before the database is opened (never to an open database).
    const restored = applyPendingRestore(config.dataDir, path.join(config.dataDir, DATABASE_FILE), {
      maxSchemaVersion: Math.max(...migrations.map((m) => m.version)),
      now: new Date(),
    });
    if (restored) (restored.ok ? logger.info : logger.error)('backup restore', { ok: restored.ok, file: restored.file, message: restored.message });
    db = openDatabase(path.join(config.dataDir, DATABASE_FILE));
    releaseLock = writeInstanceLock(config.dataDir);
    const problems = checkIntegrity(db);
    if (problems.length > 0) {
      // Refuse to write to a damaged database; the operator should restore a backup.
      throw new Error(`Database integrity check failed: ${problems.slice(0, 5).join('; ')}`);
    }
    const result = migrate(db, migrations);
    logger.info('database ready', { schemaVersion: result.currentVersion, applied: result.applied });

    // Known-answer self-test: startup fails (no fallback algorithm) unless Argon2id works and is standard.
    await verifyArgon2Implementation();
    const hasher = new PasswordHasher({
      memoryKiB: config.argon2MemoryKiB,
      passes: config.argon2Passes,
      parallelism: config.argon2Parallelism,
    });

    // Account setup is dormant since Phase 2.3; without an explicit token it gets an unguessable one nobody holds.
    const setupToken = config.setupToken ?? generateToken();

    let localKey = config.localKey;
    if (!localKey) {
      localKey = generateToken();
      // Standalone server only (the desktop app supplies its own key). Printed to the console, never to the log file.
      process.stdout.write(
        `\nCONDUIT local access key (valid until restart); send it as the X-CONDUIT-Local-Key header:\n  ${localKey}\n\n`,
      );
    }

    const requestRestart = () => {
      // The supervisor restarts the backend right away (not counted as a crash); a standalone server just stops.
      notifyParent({ type: 'restart' });
      void shutdown('restart requested (restore)', EXIT_RESTART);
    };
    const services = createServices({ db, config, hasher, logger, setupToken, vault, version, requestRestart });
    server = await startServer({ config, db, logger, version, startedAt: new Date(), services, localKey });
    logger.info('listening', {
      url: `http://${config.host}:${server.port}`,
      oauthCallbackPort: config.oauthCallbackPort,
    });
    notifyParent({ type: 'ready', port: server.port });
    services.connections.startBackgroundVerification();
    void services.discord.startBot().catch((err) => logger.error('could not start the discord bot', { err }));
    void services.kickChat.start().catch((err) => logger.error('could not start kick chat', { err }));
  } catch (err) {
    logger.error('startup failed', { err });
    notifyParent({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    await shutdown('startup failure', 1);
  }
}

void main();
