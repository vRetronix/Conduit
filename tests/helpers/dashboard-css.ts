/** The dashboard's whole stylesheet: every file under apps/dashboard/src/styles/, in the order styles/index.css imports them. */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(__dirname, '../../apps/dashboard/src/styles');
const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');

export const dashboardCss = [...read('index.css').matchAll(/@import '\.\/([\w-]+\.css)';/g)].map((m) => read(m[1] ?? '')).join('\n');
