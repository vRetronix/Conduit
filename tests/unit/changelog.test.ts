import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRelease, parseChangelog, promoteUnreleased } from '@conduit/shared/app/changelog';

const root = path.resolve(import.meta.dirname, '../..');

const SAMPLE = `# Changelog

Intro text.

## [Unreleased]

### Big batch
#### Added
- **One** thing,
  wrapped onto two lines.
  - a detail
    that wraps.
#### Compatibility
- Old data keeps working.

## [0.4.0] - 2026-11-02

First release.

### Added
- Feature.
### Breaking Changes
- Removed X.
### Security
- Hardened Y.
`;

describe('parseChangelog', () => {
  it('reads releases, groups, categories and items', () => {
    const [unreleased, v040] = parseChangelog(SAMPLE);
    expect(unreleased).toMatchObject({ version: null, date: null });
    expect(unreleased!.groups).toHaveLength(1);
    const group = unreleased!.groups[0]!;
    expect(group.title).toBe('Big batch');
    expect(group.sections.map((s) => [s.title, s.kind])).toEqual([
      ['Added', 'added'],
      ['Compatibility', 'other'],
    ]);
    expect(group.sections[0]!.items[0]).toEqual({ text: '**One** thing, wrapped onto two lines.', children: ['a detail that wraps.'] });

    expect(v040).toMatchObject({ version: '0.4.0', date: '2026-11-02', notes: ['First release.'] });
    expect(v040!.groups[0]!.title).toBeNull();
    expect(v040!.groups[0]!.sections.map((s) => s.kind)).toEqual(['added', 'breaking', 'security']);
  });

  it('finds a release by version', () => {
    expect(findRelease(SAMPLE, '0.4.0')?.date).toBe('2026-11-02');
    expect(findRelease(SAMPLE, '0.5.0')).toBeNull();
  });
});

describe('promoteUnreleased', () => {
  it('moves [Unreleased] into a dated release and leaves an empty [Unreleased]', () => {
    const next = promoteUnreleased(SAMPLE, '0.5.0', '2026-12-01');
    const releases = parseChangelog(next);
    expect(releases.map((r) => r.version)).toEqual([null, '0.5.0', '0.4.0']);
    expect(releases[0]!.groups).toHaveLength(0);
    expect(releases[1]!.date).toBe('2026-12-01');
    expect(releases[1]!.groups[0]!.title).toBe('Big batch');
    expect(next).toContain('## [Unreleased]\n\n## [0.5.0] - 2026-12-01\n\n### Big batch');
  });

  it('refuses an empty [Unreleased], a duplicate version or a bad date', () => {
    const empty = promoteUnreleased(SAMPLE, '0.5.0', '2026-12-01');
    expect(() => promoteUnreleased(empty, '0.6.0', '2026-12-02')).toThrow(/Nothing to release/);
    expect(() => promoteUnreleased(SAMPLE, '0.4.0', '2026-12-01')).toThrow(/already has an entry/);
    expect(() => promoteUnreleased(SAMPLE, '0.5.0', '01/12/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => promoteUnreleased('# Changelog\n', '0.5.0', '2026-12-01')).toThrow(/no "## \[Unreleased\]"/);
  });
});

describe('the repository CHANGELOG.md', () => {
  const text = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const releases = parseChangelog(text);

  it('has [Unreleased] first and dated, descending releases', () => {
    expect(releases[0]?.version).toBeNull();
    const dated = releases.slice(1);
    expect(dated.length).toBeGreaterThan(0);
    for (const r of dated) expect(r.date, `${r.version} has a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('documents the current package version unless it is still unreleased', () => {
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
    expect(findRelease(text, version)).not.toBeNull();
  });

  it('has no entries without a category or text', () => {
    for (const r of releases) for (const g of r.groups) for (const s of g.sections) for (const i of s.items) expect(i.text.trim()).not.toBe('');
  });
});
