/**
 * Semantic versioning (https://semver.org) for CONDUIT: MAJOR.MINOR.PATCH with an optional prerelease such as
 * 0.5.0-beta.1. The version itself lives in the root package.json (the single source of truth); this module only
 * parses, compares and bumps it, and names its release channel.
 *
 * Environment-neutral and self-contained (no imports): the release script (scripts/release.mjs) loads it directly
 * with Node's type stripping, so it must use erasable TypeScript only.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, e.g. ['beta', 1] for 0.5.0-beta.1; empty for a normal release. */
  prerelease: (string | number)[];
}

export type BumpKind = 'major' | 'minor' | 'patch';
export const BUMP_KINDS: readonly BumpKind[] = ['major', 'minor', 'patch'];

/** The prerelease labels CONDUIT uses, in order. */
export type PrereleaseLabel = 'alpha' | 'beta' | 'rc';
export const PRERELEASE_LABELS: readonly PrereleaseLabel[] = ['alpha', 'beta', 'rc'];

const NUMERIC = '0|[1-9]\\d*';
const IDENTIFIER = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
// No build metadata (+...): CONDUIT doesn't use it, and it would make two different builds look like one version.
const SEMVER_RE = new RegExp(`^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`);

export function parseVersion(text: string): SemVer | null {
  const m = SEMVER_RE.exec(text.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const prerelease = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

export function formatVersion(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join('.')}` : core;
}

function mustParse(text: string): SemVer {
  const v = parseVersion(text);
  if (!v) throw new Error(`"${text}" is not a valid version (expected MAJOR.MINOR.PATCH, e.g. 0.4.0 or 0.5.0-beta.1)`);
  return v;
}

/** Semver precedence: negative if a < b, 0 if equal, positive if a > b. 1.0.0-rc.1 < 1.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = mustParse(a);
  const y = mustParse(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The next version.
 * - patch: 0.4.0 → 0.4.1; minor: 0.4.1 → 0.5.0; major: 0.5.0 → 1.0.0.
 * - With a prerelease label, the target version gets "-label.1": minor + beta on 0.4.0 → 0.5.0-beta.1.
 * - From a prerelease, the same kind finishes or continues it instead of skipping a version:
 *   minor on 0.5.0-beta.2 → 0.5.0; minor + beta on 0.5.0-beta.2 → 0.5.0-beta.3; minor + rc → 0.5.0-rc.1.
 */
export function bumpVersion(current: string, kind: BumpKind, label?: PrereleaseLabel): string {
  const v = mustParse(current);
  if (!BUMP_KINDS.includes(kind)) throw new Error(`Unknown release type "${kind}" (use major, minor or patch)`);
  if (label !== undefined && !PRERELEASE_LABELS.includes(label)) throw new Error(`Unknown prerelease label "${label}" (use alpha, beta or rc)`);

  // A prerelease of exactly the version this bump would produce: finish it or continue its series.
  if (v.prerelease.length && prereleaseTargets(v, kind)) {
    const target = { ...v, prerelease: [] };
    if (!label) return formatVersion(target);
    const [curLabel, curNum] = v.prerelease;
    if (curLabel === label && typeof curNum === 'number' && v.prerelease.length === 2) return formatVersion({ ...v, prerelease: [label, curNum + 1] });
    const next = formatVersion({ ...target, prerelease: [label, 1] });
    if (compareVersions(next, current) <= 0) throw new Error(`${next} would not be newer than ${current}`);
    return next;
  }

  const base =
    kind === 'major'
      ? { major: v.major + 1, minor: 0, patch: 0 }
      : kind === 'minor'
        ? { major: v.major, minor: v.minor + 1, patch: 0 }
        : { major: v.major, minor: v.minor, patch: v.patch + 1 };
  return formatVersion({ ...base, prerelease: label ? [label, 1] : [] });
}

/** Whether a prerelease is already a prerelease *of* the version a `kind` bump targets (e.g. 0.5.0-beta.1 for minor). */
function prereleaseTargets(v: SemVer, kind: BumpKind): boolean {
  if (kind === 'major') return v.minor === 0 && v.patch === 0;
  if (kind === 'minor') return v.patch === 0;
  return true;
}

export type ReleaseChannel = 'stable' | 'initial-development' | 'alpha' | 'beta' | 'rc' | 'prerelease';

/**
 * The channel a version belongs to, read only from the version itself (never from a Git branch):
 * a prerelease label → Alpha / Beta / Release candidate; 0.x.y → Initial development (semver: anything may still
 * change); 1.0.0 and later → Stable.
 */
export function releaseChannel(version: string): ReleaseChannel {
  const v = parseVersion(version);
  if (!v) return 'prerelease';
  const label = v.prerelease[0];
  if (label !== undefined) return label === 'alpha' || label === 'beta' || label === 'rc' ? label : 'prerelease';
  return v.major === 0 ? 'initial-development' : 'stable';
}

export const RELEASE_CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  stable: 'Stable',
  'initial-development': 'Initial development',
  alpha: 'Alpha',
  beta: 'Beta',
  rc: 'Release candidate',
  prerelease: 'Pre-release',
};

/** The Git tag for a version: v0.4.0. */
export function tagForVersion(version: string): string {
  return `v${formatVersion(mustParse(version))}`;
}
