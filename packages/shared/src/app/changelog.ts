/**
 * CHANGELOG.md structure (Keep a Changelog style), shared by the desktop's Release notes view and the release script:
 *
 *   ## [Unreleased]                       work not released yet
 *   ### <Group title>                     optional: a named batch of work (e.g. a development phase)
 *   #### Added | Changed | Fixed | …      categories inside a group
 *   ## [0.4.0] - 2026-11-02               a release, with the date it was released
 *   ### Added | Changed | Fixed | Security | Breaking Changes | …
 *
 * Environment-neutral and self-contained (no imports), so scripts/release.mjs can load it with Node's type stripping.
 */

export type ChangeKind = 'added' | 'changed' | 'fixed' | 'security' | 'breaking' | 'removed' | 'deprecated' | 'other';

const KINDS: Record<string, ChangeKind> = {
  added: 'added',
  changed: 'changed',
  improved: 'changed',
  improvements: 'changed',
  fixed: 'fixed',
  security: 'security',
  'breaking changes': 'breaking',
  breaking: 'breaking',
  removed: 'removed',
  deprecated: 'deprecated',
};

export interface ChangeItem {
  text: string;
  /** Nested bullet points under this item. */
  children: string[];
}

export interface ChangelogSection {
  /** The heading as written ("Added", "Breaking Changes", "Compatibility", …). */
  title: string;
  kind: ChangeKind;
  items: ChangeItem[];
}

export interface ChangelogGroup {
  /** Null for categories written directly under the release heading. */
  title: string | null;
  notes: string[];
  sections: ChangelogSection[];
}

export interface ChangelogRelease {
  /** Null for [Unreleased]. */
  version: string | null;
  /** YYYY-MM-DD; null for [Unreleased]. */
  date: string | null;
  notes: string[];
  groups: ChangelogGroup[];
}

const RELEASE_RE = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const UNRELEASED = 'unreleased';

export function changeKind(title: string): ChangeKind {
  return KINDS[title.trim().toLowerCase()] ?? 'other';
}

/** Parses every `## [..]` release. Text before the first release (title, introduction) is ignored. */
export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let group: ChangelogGroup | null = null;
  let section: ChangelogSection | null = null;
  let item: ChangeItem | null = null;
  // Where a wrapped (indented) line continues: the last item, or its last child.
  let continueChild = false;

  const ensureGroup = (): ChangelogGroup => {
    if (!group) {
      group = { title: null, notes: [], sections: [] };
      release!.groups.push(group);
    }
    return group;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const rel = RELEASE_RE.exec(line);
    if (rel) {
      const name = rel[1]!.trim();
      release = { version: name.toLowerCase() === UNRELEASED ? null : name, date: rel[2] ?? null, notes: [], groups: [] };
      releases.push(release);
      group = section = item = null;
      continue;
    }
    if (!release) continue;

    const h3 = /^### (.+)$/.exec(line);
    const h4 = /^#### (.+)$/.exec(line);
    if (h3) {
      const title = h3[1]!.trim();
      item = null;
      if (changeKind(title) !== 'other' && (!group || group.title === null)) {
        // A category directly under the release.
        section = { title, kind: changeKind(title), items: [] };
        ensureGroup().sections.push(section);
      } else {
        group = { title, notes: [], sections: [] };
        release.groups.push(group);
        section = null;
      }
      continue;
    }
    if (h4) {
      const title = h4[1]!.trim();
      section = { title, kind: changeKind(title), items: [] };
      ensureGroup().sections.push(section);
      item = null;
      continue;
    }
    if (line.trim() === '') continue;

    const bullet = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet && bullet[1] === '') {
      if (!section) {
        section = { title: '', kind: 'other', items: [] };
        ensureGroup().sections.push(section);
      }
      item = { text: bullet[2]!, children: [] };
      section.items.push(item);
      continueChild = false;
    } else if (bullet && item) {
      item.children.push(bullet[2]!);
      continueChild = true;
    } else if (/^\s/.test(line) && item) {
      const more = line.trim();
      if (continueChild) item.children[item.children.length - 1] += ` ${more}`;
      else item.text += ` ${more}`;
    } else {
      // A plain paragraph: a note on the group (or release) it belongs to.
      item = null;
      const target = section ? null : group ? group.notes : release.notes;
      if (target) target.push(line.trim());
      else section!.items.push((item = { text: line.trim(), children: [] }));
    }
  }
  return releases;
}

/** The `## [version] - date` release, or null. */
export function findRelease(text: string, version: string): ChangelogRelease | null {
  return parseChangelog(text).find((r) => r.version === version) ?? null;
}

/**
 * Turns the [Unreleased] notes into the release `version` dated `date`, leaving an empty [Unreleased] above it.
 * Throws if there is nothing under [Unreleased], or the version already has an entry.
 */
export function promoteUnreleased(text: string, version: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Release date must be YYYY-MM-DD, got "${date}"`);
  if (findRelease(text, version)) throw new Error(`CHANGELOG.md already has an entry for ${version}`);
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = lines.findIndex((l) => /^## \[unreleased\]\s*$/i.test(l));
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  if (!body.some((l) => l.trim() !== '')) throw new Error('Nothing to release: the [Unreleased] section of CHANGELOG.md is empty');
  while (body.length && body[body.length - 1]!.trim() === '') body.pop();
  while (body.length && body[0]!.trim() === '') body.shift();
  const out = [...lines.slice(0, start), '## [Unreleased]', '', `## [${version}] - ${date}`, '', ...body, '', ...lines.slice(end)];
  return out.join(eol);
}
