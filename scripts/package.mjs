// Packages the built app with electron-builder (apps/desktop/electron-builder.yml), named for the edition being built:
//   node scripts/package.mjs nsis   → installer in apps/desktop/release
//   node scripts/package.mjs dir    → unpacked app, for a quick check
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { edition } from './edition.mjs';
import { root } from './targets.mjs';

const require = createRequire(import.meta.url);
// Run electron-builder's CLI with Node directly (no shell), so names with spaces stay one argument.
const electronBuilderCli = require.resolve('electron-builder/cli.js');

const target = process.argv[2];
if (target !== 'nsis' && target !== 'dir') {
  console.error('Usage: node scripts/package.mjs <nsis|dir>');
  process.exit(2);
}

console.log(`Packaging ${edition.productName} (${edition.id} edition)`);
const result = spawnSync(
  process.execPath,
  [
    electronBuilderCli,
    '--config', 'electron-builder.yml',
    '--win', target === 'dir' ? '--dir' : 'nsis',
    `-c.appId=${edition.appId}`,
    `-c.productName=${edition.productName}`,
    `-c.nsis.shortcutName=${edition.productName}`,
  ],
  { cwd: path.join(root, 'apps/desktop'), stdio: 'inherit' },
);
process.exit(result.status ?? 1);
