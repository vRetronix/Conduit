// Production build: renderer (Vite) + main/preload/server bundles (esbuild).
import { rmSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';
import { versionProblems } from './release.mjs';
import { edition } from './edition.mjs';
import { desktopDist, desktopTargets, root, serverDist, standaloneTargets, version } from './targets.mjs';

// The app, the installer (apps/desktop/package.json) and the lockfile must all carry the same version.
const problems = versionProblems();
if (problems.length) {
  console.error(`Version mismatch — run npm run version:check:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const started = Date.now();
rmSync(desktopDist, { recursive: true, force: true });
rmSync(serverDist, { recursive: true, force: true });

console.log(`Building ${edition.productName} ${version}`);
await viteBuild({
  configFile: path.join(root, 'apps/dashboard/vite.config.ts'),
  logLevel: 'warn',
  build: { sourcemap: false },
});
console.log('  ✓ renderer');

await Promise.all(
  [...Object.values(desktopTargets), ...standaloneTargets].map((target) => esbuild.build({ ...target, minify: true })),
);
console.log('  ✓ main, preload, server, recover-admin');
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
