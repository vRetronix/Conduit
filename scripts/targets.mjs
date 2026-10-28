// esbuild bundle definitions shared by build.mjs and dev.mjs.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
export const version = pkg.version;

export const desktopDist = path.join(root, 'apps/desktop/dist');
export const serverDist = path.join(root, 'apps/server/dist');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron 44 bundles Node 24; standalone server mode requires Node >= 24.7.
  target: 'node24',
  sourcemap: 'linked',
  logLevel: 'warning',
  define: { __CONDUIT_VERSION__: JSON.stringify(version) },
};

/** Builds everything into the desktop app's dist folder (what Electron loads and electron-builder packages). */
export const desktopTargets = {
  main: {
    ...common,
    entryPoints: [path.join(root, 'apps/desktop/src/main.ts')],
    outfile: path.join(desktopDist, 'main.cjs'),
    // `ws` (bundled) optionally loads these native accelerators; it works without them.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  },
  preload: {
    ...common,
    entryPoints: [path.join(root, 'apps/desktop/src/preload.ts')],
    outfile: path.join(desktopDist, 'preload.cjs'),
    external: ['electron'],
    sourcemap: false,
  },
  server: {
    ...common,
    entryPoints: [path.join(root, 'apps/server/src/main.ts')],
    outfile: path.join(desktopDist, 'server.cjs'),
    // Optional native accelerators for `ws`; it falls back to pure JS without them.
    external: ['bufferutil', 'utf-8-validate'],
  },
  /** Offline administrator recovery, launched by `CONDUIT.exe --recover-admin`. */
  recoverAdmin: {
    ...common,
    entryPoints: [path.join(root, 'apps/server/src/recover-admin-cli.ts')],
    outfile: path.join(desktopDist, 'recover-admin.cjs'),
  },
};

/** Standalone bundles for plain Node.js (`npm run server`, `npm run recover-admin`, future VPS hosting). */
export const standaloneTargets = [
  { ...desktopTargets.server, outfile: path.join(serverDist, 'server.cjs') },
  { ...desktopTargets.recoverAdmin, outfile: path.join(serverDist, 'recover-admin.cjs') },
];
