// `npm start`: runs the built desktop app (apps/desktop/dist) with a sanitized environment. See electron-env.mjs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { electronChildEnv, readLocalEnvFile } from './electron-env.mjs';
import { root } from './targets.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // resolves to the Electron executable path
const appDir = path.join(root, 'apps/desktop');

if (!existsSync(path.join(appDir, 'dist', 'main.cjs'))) {
  console.error('The desktop app has not been built yet. Run `npm run build` first.');
  process.exit(1);
}

// Optional git-ignored settings (e.g. CONDUIT_DISCORD_CLIENT_ID / _SECRET); the real environment wins.
const envFile = path.join(root, '.env.local');
const localEnv = existsSync(envFile) ? readLocalEnvFile(readFileSync(envFile, 'utf8')) : {};

const child = spawn(electronBinary, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: electronChildEnv({ ...localEnv, ...process.env }),
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
