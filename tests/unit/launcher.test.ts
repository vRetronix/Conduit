import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronChildEnv, readLocalEnvFile } from '../../scripts/electron-env.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('electronChildEnv', () => {
  it('removes ELECTRON_RUN_AS_NODE (any casing) and keeps everything else', () => {
    const parent = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', PATH: 'C:\\bin', CONDUIT_PORT: '1' };
    expect(electronChildEnv(parent)).toEqual({ PATH: 'C:\\bin', CONDUIT_PORT: '1' });
  });

  it('adds extra variables but cannot be used to re-add the stripped one', () => {
    expect(electronChildEnv({ A: '1' }, { CONDUIT_DATA_DIR: 'D:\\x', ELECTRON_RUN_AS_NODE: '1' })).toEqual({ A: '1', CONDUIT_DATA_DIR: 'D:\\x' });
  });

  it('does not modify the parent environment', () => {
    const parent = { ELECTRON_RUN_AS_NODE: '1' };
    electronChildEnv(parent);
    expect(parent).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('really hides the variable from a child process', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'], {
      env: electronChildEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
    });
    expect(result.stdout).toBe('undefined');
  });
});

describe('readLocalEnvFile (.env.local)', () => {
  it('reads only CONDUIT_* settings, with comments and quotes', () => {
    const parsed = readLocalEnvFile(
      [
        '# Discord application',
        'CONDUIT_DISCORD_CLIENT_ID=123456789012345678',
        'CONDUIT_DISCORD_CLIENT_SECRET = "abc def"',
        "CONDUIT_OAUTH_CALLBACK_PORT='47821'",
        'ELECTRON_RUN_AS_NODE=1',
        'PATH=C:\\evil',
        'NODE_OPTIONS=--require evil.js',
        'CONDUIT_EMPTY=',
        'not a line',
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      CONDUIT_DISCORD_CLIENT_ID: '123456789012345678',
      CONDUIT_DISCORD_CLIENT_SECRET: 'abc def',
      CONDUIT_OAUTH_CALLBACK_PORT: '47821',
    });
  });

  it('cannot reintroduce ELECTRON_RUN_AS_NODE through the launcher', () => {
    expect(electronChildEnv({ ...readLocalEnvFile('ELECTRON_RUN_AS_NODE=1'), ELECTRON_RUN_AS_NODE: '1' })).toEqual({});
  });
});

describe('launcher configuration', () => {
  it('npm start and npm run dev launch Electron through the sanitizer', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const desktopPkg = JSON.parse(read('apps/desktop/package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe('node scripts/start.mjs');
    expect(pkg.scripts.dev).toBe('node scripts/dev.mjs');
    expect(desktopPkg.scripts.start).toBe('node ../../scripts/start.mjs');
    for (const script of ['scripts/start.mjs', 'scripts/dev.mjs']) {
      const src = read(script);
      expect(src, script).toMatch(/env: electronChildEnv\(\{ \.\.\.localEnv(\(\))?, \.\.\.process\.env \}/);
      expect(src, script).not.toMatch(/env: \{\s*\.\.\.process\.env/);
    }
  });

  it('packaged builds disable the RunAsNode fuse and related escape hatches', () => {
    const yml = read('apps/desktop/electron-builder.yml');
    const fuses = Object.fromEntries([...yml.matchAll(/^\s{2}(\w+):\s*(true|false)\s*$/gm)].map((m) => [m[1], m[2] === 'true']));
    expect(yml).toMatch(/^electronFuses:\s*$/m);
    expect(fuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
    });
  });
});
