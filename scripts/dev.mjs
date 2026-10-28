// Development: Vite dev server for the renderer, esbuild watch for main/preload/server,
// and Electron relaunched whenever a main-process or server bundle changes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import { electronChildEnv, readLocalEnvFile } from './electron-env.mjs';
import { desktopTargets, root } from './targets.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // resolves to the Electron executable path
const dataDir = path.join(root, '.devdata');
mkdirSync(dataDir, { recursive: true });

const vite = await createServer({ configFile: path.join(root, 'apps/dashboard/vite.config.ts') });
await vite.listen();
const rendererUrl = vite.resolvedUrls?.local[0];
if (!rendererUrl) throw new Error('Vite dev server did not report a URL');
console.log(`[dev] renderer at ${rendererUrl}`);

let electron = null;
let relaunchTimer = null;
let shuttingDown = false;

// Optional git-ignored settings such as CONDUIT_DISCORD_CLIENT_ID / _SECRET (see docs/SETUP.md). Re-read on every
// relaunch so edits take effect without restarting the dev session.
const localEnv = () => {
  const file = path.join(root, '.env.local');
  return existsSync(file) ? readLocalEnvFile(readFileSync(file, 'utf8')) : {};
};

function launchElectron() {
  electron = spawn(electronBinary, [path.join(root, 'apps/desktop')], {
    stdio: 'inherit',
    env: electronChildEnv({ ...localEnv(), ...process.env }, { CONDUIT_RENDERER_URL: rendererUrl, CONDUIT_DATA_DIR: dataDir }),
  });
  const self = electron;
  self.on('exit', () => {
    // Closing the app window ends the dev session; relaunches swap `electron` before the old one exits.
    if (electron === self && !shuttingDown) void shutdown();
  });
}

function scheduleRelaunch() {
  clearTimeout(relaunchTimer);
  relaunchTimer = setTimeout(() => {
    const previous = electron;
    if (previous && previous.exitCode === null) {
      console.log('[dev] bundles changed; restarting Electron');
      electron = null;
      previous.once('exit', launchElectron);
      previous.kill();
    } else {
      launchElectron();
    }
  }, 300);
}

const relaunchPlugin = {
  name: 'relaunch-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) scheduleRelaunch();
    });
  },
};

const contexts = await Promise.all(
  Object.values(desktopTargets).map((target) => esbuild.context({ ...target, plugins: [relaunchPlugin] })),
);
await Promise.all(contexts.map((ctx) => ctx.watch()));

async function shutdown() {
  shuttingDown = true;
  clearTimeout(relaunchTimer);
  if (electron && electron.exitCode === null) electron.kill();
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  await vite.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
