import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  compareVersions,
  formatVersion,
  isValidVersion,
  parseVersion,
  releaseChannel,
  RELEASE_CHANNEL_LABELS,
  tagForVersion,
} from '@conduit/shared/app/version';

describe('parseVersion', () => {
  it('parses MAJOR.MINOR.PATCH and prereleases', () => {
    expect(parseVersion('0.4.0')).toEqual({ major: 0, minor: 4, patch: 0, prerelease: [] });
    expect(parseVersion('0.5.0-beta.1')).toEqual({ major: 0, minor: 5, patch: 0, prerelease: ['beta', 1] });
    expect(formatVersion(parseVersion('1.0.0-rc.2')!)).toBe('1.0.0-rc.2');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '1', '1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0+build.1', '1.0.0-beta..1', 'latest']) {
      expect(isValidVersion(bad), bad).toBe(false);
    }
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const ordered = ['0.1.0', '0.1.1', '0.2.0', '0.10.0', '1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-beta.1', '1.0.0-rc.1', '1.0.0', '1.0.1', '2.0.0'];
    for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1]!, ordered[i]!), `${ordered[i - 1]} < ${ordered[i]}`).toBeLessThan(0);
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0);
  });
});

describe('bumpVersion', () => {
  it('follows the documented examples from 0.4.0', () => {
    expect(bumpVersion('0.4.0', 'patch')).toBe('0.4.1');
    expect(bumpVersion('0.4.1', 'patch')).toBe('0.4.2');
    expect(bumpVersion('0.4.2', 'minor')).toBe('0.5.0');
    expect(bumpVersion('0.5.0', 'minor')).toBe('0.6.0');
    expect(bumpVersion('0.6.0', 'major')).toBe('1.0.0');
    expect(bumpVersion('1.0.0', 'minor')).toBe('1.1.0');
    expect(bumpVersion('1.1.0', 'patch')).toBe('1.1.1');
    expect(bumpVersion('1.1.1', 'major')).toBe('2.0.0');
  });

  it('resets lower components: minor resets patch; major resets minor and patch', () => {
    expect(bumpVersion('0.4.7', 'minor')).toBe('0.5.0');
    expect(bumpVersion('1.4.7', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.4.7', 'patch')).toBe('1.4.8');
  });

  it('supports optional prereleases', () => {
    expect(bumpVersion('0.4.0', 'minor', 'alpha')).toBe('0.5.0-alpha.1');
    expect(bumpVersion('0.5.0-alpha.1', 'minor', 'alpha')).toBe('0.5.0-alpha.2');
    expect(bumpVersion('0.5.0-alpha.2', 'minor', 'beta')).toBe('0.5.0-beta.1');
    expect(bumpVersion('0.5.0-beta.1', 'minor', 'rc')).toBe('0.5.0-rc.1');
    expect(bumpVersion('0.5.0-rc.1', 'minor')).toBe('0.5.0');
    expect(bumpVersion('0.5.0-rc.1', 'major')).toBe('1.0.0');
  });

  it('never goes backwards', () => {
    expect(() => bumpVersion('0.5.0-beta.1', 'minor', 'alpha')).toThrow(/not be newer/);
    for (const [v, k] of [['0.1.0', 'patch'], ['0.1.0', 'minor'], ['0.1.0', 'major'], ['1.2.3-rc.1', 'patch']] as const) {
      expect(compareVersions(bumpVersion(v, k), v)).toBeGreaterThan(0);
    }
  });

  it('rejects invalid input', () => {
    expect(() => bumpVersion('banana', 'patch')).toThrow(/not a valid version/);
    expect(() => bumpVersion('0.1.0', 'huge' as never)).toThrow(/Unknown release type/);
    expect(() => bumpVersion('0.1.0', 'minor', 'gamma' as never)).toThrow(/Unknown prerelease label/);
  });
});

describe('releaseChannel', () => {
  it('comes from the version only', () => {
    expect(releaseChannel('0.1.0')).toBe('initial-development');
    expect(releaseChannel('1.0.0')).toBe('stable');
    expect(releaseChannel('2.3.4')).toBe('stable');
    expect(releaseChannel('0.5.0-alpha.1')).toBe('alpha');
    expect(releaseChannel('1.0.0-beta.2')).toBe('beta');
    expect(releaseChannel('1.0.0-rc.1')).toBe('rc');
    expect(releaseChannel('1.0.0-nightly.1')).toBe('prerelease');
    expect(RELEASE_CHANNEL_LABELS[releaseChannel('0.1.0')]).toBe('Initial development');
  });

  it('names the Git tag', () => {
    expect(tagForVersion('0.4.0')).toBe('v0.4.0');
    expect(tagForVersion('0.5.0-beta.1')).toBe('v0.5.0-beta.1');
  });
});
