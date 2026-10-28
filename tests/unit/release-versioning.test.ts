// The version has one source (the root package.json) and every consumer agrees with it.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isValidVersion } from '@conduit/shared/app/version';
// @ts-expect-error: plain JavaScript build/release scripts, without type declarations.
import { packageFiles, versionProblems } from '../../scripts/release.mjs';
// @ts-expect-error: as above.
import { version as buildVersion } from '../../scripts/targets.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const rootVersion = JSON.parse(read('package.json')).version as string;

describe('the repository version', () => {
  it('is a valid semantic version', () => {
    expect(isValidVersion(rootVersion)).toBe(true);
  });

  it('agrees everywhere (workspaces, lockfile, installer metadata, changelog)', () => {
    expect(versionProblems(root)).toEqual([]);
  });

  it('is what the build bakes into the app (__CONDUIT_VERSION__)', () => {
    expect(buildVersion).toBe(rootVersion);
    expect(read('scripts/targets.mjs')).toContain('__CONDUIT_VERSION__: JSON.stringify(version)');
  });

  it('is what the Windows installer uses: electron-builder reads the desktop package.json and does not override it', () => {
    expect(JSON.parse(read('apps/desktop/package.json')).version).toBe(rootVersion);
    expect(read('apps/desktop/electron-builder.yml')).not.toMatch(/^\s*(buildVersion|version|extraMetadata)\s*:/m);
  });

  it('reaches the renderer only through the getAppInfo IPC handler, from the build-time constant', () => {
    const main = read('apps/desktop/src/main.ts');
    expect(main).toContain('const version = __CONDUIT_VERSION__;');
    expect(main).toMatch(/handle\(IPC_CHANNELS\.getAppInfo, \(\): AppInfo => \(\{ version,/);
    expect(read('apps/desktop/src/preload.ts')).toContain('getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo)');
  });

  it('is checked before every production build', () => {
    expect(read('scripts/build.mjs')).toMatch(/versionProblems\(\)[\s\S]*process\.exit\(1\)[\s\S]*viteBuild/);
  });
});

describe('versionProblems', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fixture = (versions: { root: string; desktop: string; lock: string; lockDesktop: string }, changelog = '## [Unreleased]\n') => {
    dir = mkdtempSync(path.join(tmpdir(), 'conduit-version-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'conduit', version: versions.root, workspaces: ['apps/*'] }));
    mkdirSync(path.join(dir, 'apps/desktop'), { recursive: true });
    writeFileSync(path.join(dir, 'apps/desktop/package.json'), JSON.stringify({ name: '@conduit/desktop', version: versions.desktop }));
    writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ version: versions.lock, packages: { '': { version: versions.lock }, 'apps/desktop': { version: versions.lockDesktop } } }),
    );
    writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    return dir;
  };

  it('accepts matching versions', () => {
    const d = fixture({ root: '0.4.0', desktop: '0.4.0', lock: '0.4.0', lockDesktop: '0.4.0' });
    expect(packageFiles(d).map((f: string) => path.relative(d, f).replaceAll('\\', '/'))).toEqual(['package.json', 'apps/desktop/package.json']);
    expect(versionProblems(d)).toEqual([]);
  });

  it('reports every place that drifted', () => {
    const d = fixture({ root: '0.4.0', desktop: '0.3.9', lock: '0.4.0', lockDesktop: '0.3.9' }, '# Changelog\n');
    expect(versionProblems(d)).toEqual([
      'apps/desktop/package.json: version 0.3.9, expected 0.4.0',
      'package-lock.json "apps/desktop": version 0.3.9, expected 0.4.0',
      'CHANGELOG.md: no "## [Unreleased]" section',
    ]);
  });

  it('rejects an invalid root version', () => {
    const d = fixture({ root: '4', desktop: '4', lock: '4', lockDesktop: '4' });
    expect(versionProblems(d)).toEqual(['package.json: "4" is not a valid MAJOR.MINOR.PATCH version']);
  });
});
