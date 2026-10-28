// Which edition of CONDUIT this checkout builds: the "edition" field of the root package.json, or CONDUIT_EDITION to
// build another one. Each edition installs and keeps its data separately, so they can sit side by side on one PC.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const EDITIONS = {
  /** CONDUIT on GitHub: the free, self-hosted public release. */
  github: { id: 'github', productName: 'CONDUIT', appId: 'com.retronix.conduit', dataFolder: 'CONDUIT' },
};

const root = path.resolve(import.meta.dirname, '..');
const id = process.env.CONDUIT_EDITION || JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).edition;
if (!Object.hasOwn(EDITIONS, id)) {
  throw new Error(`Unknown CONDUIT edition "${id}". Set "edition" in package.json to one of: ${Object.keys(EDITIONS).join(', ')}`);
}

export const edition = EDITIONS[id];
