// Release helper: semantic versioning for CONDUIT. You choose the release type; nothing here pushes to GitHub.
//
//   npm run release:status                       branch, working tree, current version, changes since the last tag
//   npm run version:check                        every version agrees (also run by `npm run build`)
//   npm run release:prepare -- minor             bump the version and date the [Unreleased] changelog notes
//   npm run release:prepare -- patch --pre beta  …or a prerelease (0.4.1-beta.1)
//   npm run release:tag                          after the release commit: annotated tag vX.Y.Z, then verified
//
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRelease, promoteUnreleased } from '../packages/shared/src/app/changelog.ts';
import {
  BUMP_KINDS,
  PRERELEASE_LABELS,
  RELEASE_CHANNEL_LABELS,
  bumpVersion,
  compareVersions,
  isValidVersion,
  releaseChannel,
  tagForVersion,
} from '../packages/shared/src/app/version.ts';

const root = path.resolve(import.meta.dirname, '..');
const RELEASE_BRANCH = 'main';
const rel = (file) => path.relative(root, file).replaceAll('\\', '/');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The root package.json and every workspace package.json (apps/*, packages/*). */
export function packageFiles(dir = root) {
  const files = [path.join(dir, 'package.json')];
  for (const pattern of readJson(files[0]).workspaces ?? []) {
    const base = path.join(dir, pattern.replace(/\/\*$/, ''));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = path.join(base, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Problems that would let versions drift apart; empty when everything agrees with the root package.json. */
export function versionProblems(dir = root) {
  const version = readJson(path.join(dir, 'package.json')).version;
  const problems = [];
  if (!isValidVersion(String(version))) problems.push(`package.json: "${version}" is not a valid MAJOR.MINOR.PATCH version`);
  for (const file of packageFiles(dir).slice(1)) {
    const v = readJson(file).version;
    if (v !== version) problems.push(`${path.relative(dir, file).replaceAll('\\', '/')}: version ${v}, expected ${version}`);
  }
  // electron-builder reads the Windows installer/exe version from the desktop package.json (checked above).
  const lockFile = path.join(dir, 'package-lock.json');
  if (existsSync(lockFile)) {
    const lock = readJson(lockFile);
    if (lock.version !== version) problems.push(`package-lock.json: version ${lock.version}, expected ${version}`);
    for (const file of packageFiles(dir)) {
      const key = path.relative(dir, path.dirname(file)).replaceAll('\\', '/');
      const entry = lock.packages?.[key];
      if (entry && entry.version !== version) problems.push(`package-lock.json "${key || '(root)'}": version ${entry.version}, expected ${version}`);
    }
  }
  const changelog = path.join(dir, 'CHANGELOG.md');
  if (!existsSync(changelog) || !/^## \[Unreleased\]\s*$/im.test(readFileSync(changelog, 'utf8'))) problems.push('CHANGELOG.md: no "## [Unreleased]" section');
  return problems;
}

/** Sets the version in every package.json and package-lock.json, changing only the version lines. */
function writeVersion(version) {
  for (const file of packageFiles()) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
    if (next === text && readJson(file).version !== version) throw new Error(`Could not update the version in ${rel(file)}`);
    writeFileSync(file, next);
  }
  const lockFile = path.join(root, 'package-lock.json');
  const lock = readJson(lockFile);
  lock.version = version;
  for (const file of packageFiles()) {
    const key = rel(path.dirname(file)).replace(/^\.$/, '');
    if (lock.packages?.[key]) lock.packages[key].version = version;
  }
  const eol = readFileSync(lockFile, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(lockFile, (JSON.stringify(lock, null, 2) + '\n').replace(/\n/g, eol));
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tagExists = (tag) => git('tag', '--list', tag) === tag;
const versionTags = () =>
  git('tag', '--list', 'v*')
    .split('\n')
    .filter((t) => isValidVersion(t.slice(1)))
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function requireReleaseState({ allowBranch, allowChanges = false }) {
  const branch = git('branch', '--show-current');
  if (branch !== RELEASE_BRANCH && !allowBranch) fail(`Releases are made from "${RELEASE_BRANCH}", but you're on "${branch || '(detached)'}". Pass --any-branch to override.`);
  const dirty = git('status', '--porcelain');
  if (dirty && allowChanges) {
    console.log('Note: there are uncommitted changes (--with-changes): commit them together with the version bump.');
  } else if (dirty) {
    fail(
      'The working tree has uncommitted changes, so they could end up in (or be missing from) the release.\n' +
        '  Commit or finish them first. `git status` lists them:\n' +
        dirty
          .split('\n')
          .slice(0, 15)
          .map((l) => `    ${l}`)
          .join('\n'),
    );
  }
  const problems = versionProblems();
  if (problems.length) fail(`Versions don't agree:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

const currentVersion = () => readJson(path.join(root, 'package.json')).version;

function status() {
  const version = currentVersion();
  const tags = versionTags();
  const last = tags.at(-1);
  const dirty = git('status', '--porcelain');
  console.log(`CONDUIT ${version} (${RELEASE_CHANNEL_LABELS[releaseChannel(version)]})`);
  console.log(`Branch:        ${git('branch', '--show-current') || '(detached)'}`);
  console.log(`Working tree:  ${dirty ? `${dirty.split('\n').length} uncommitted change(s) — commit them before releasing` : 'clean'}`);
  console.log(`Last tag:      ${last ?? 'none yet'}${tagExists(tagForVersion(version)) ? '' : `  (${tagForVersion(version)} is not tagged)`}`);
  const problems = versionProblems();
  console.log(`Versions:      ${problems.length ? 'MISMATCH' : 'all agree'}`);
  for (const p of problems) console.log(`  - ${p}`);
  const log = git('log', '--oneline', '--no-decorate', ...(last ? [`${last}..HEAD`] : ['-n', '30']));
  console.log(`\nCommits ${last ? `since ${last}` : '(latest 30; no release tag yet)'}:`);
  console.log(log ? log.split('\n').map((l) => `  ${l}`).join('\n') : '  (none)');
  console.log('\nNext version if you choose:');
  for (const kind of BUMP_KINDS) console.log(`  ${kind.padEnd(6)} → ${bumpVersion(version, kind)}`);
  console.log('\nReview the [Unreleased] notes in CHANGELOG.md, then: npm run release:prepare -- <major|minor|patch>');
}

function check() {
  const problems = versionProblems();
  if (problems.length) fail(`Versions don't agree with package.json:\n${problems.map((p) => `  - ${p}`).join('\n')}\n  Fix them (npm run release:prepare sets all of them), then retry.`);
  console.log(`✓ Version ${currentVersion()} is consistent (package.json files, package-lock.json, installer metadata, CHANGELOG.md).`);
}

function prepare(args) {
  const allowBranch = args.includes('--any-branch');
  // --with-changes: bump the version alongside uncommitted work, to be committed together (the tag step still needs a clean tree).
  const allowChanges = args.includes('--with-changes');
  const rest = args.filter((a) => a !== '--any-branch' && a !== '--with-changes');
  const label = option(rest, '--pre');
  const date = option(rest, '--date') ?? today();
  const [kind, extra] = rest;
  if (!kind || extra) fail('Usage: npm run release:prepare -- <major|minor|patch> [--pre alpha|beta|rc] [--date YYYY-MM-DD] [--with-changes]');
  if (!BUMP_KINDS.includes(kind)) fail(`"${kind}" is not a release type. Choose major, minor or patch.`);
  if (label !== undefined && !PRERELEASE_LABELS.includes(label)) fail(`--pre must be one of: ${PRERELEASE_LABELS.join(', ')}`);
  requireReleaseState({ allowBranch, allowChanges });

  const current = currentVersion();
  let next;
  try {
    next = bumpVersion(current, kind, label);
  } catch (e) {
    fail(e.message);
  }
  if (compareVersions(next, current) <= 0) fail(`${next} is not newer than ${current}; versions never go down or repeat.`);
  const tag = tagForVersion(next);
  if (tagExists(tag)) fail(`Tag ${tag} already exists: ${next} was released before. Pick another release type.`);
  const higher = versionTags().filter((t) => compareVersions(t.slice(1), next) >= 0);
  if (higher.length) fail(`${next} would not be newer than the existing tag ${higher.at(-1)}.`);

  const changelogFile = path.join(root, 'CHANGELOG.md');
  let changelog;
  try {
    changelog = promoteUnreleased(readFileSync(changelogFile, 'utf8'), next, date);
  } catch (e) {
    fail(e.message);
  }
  writeVersion(next);
  writeFileSync(changelogFile, changelog);
  const problems = versionProblems();
  if (problems.length) fail(`Version files are inconsistent after the update:\n${problems.join('\n')}`);

  console.log(`✓ ${current} → ${next} (${kind}${label ? `, ${label}` : ''}), changelog dated ${date}.\n`);
  console.log('Next:');
  console.log('  1. Review CHANGELOG.md and the diff:   git diff');
  console.log('  2. Run every check:                    npm run verify');
  console.log(`  3. Commit the release:                 git add CHANGELOG.md package.json package-lock.json apps/*/package.json packages/*/package.json`);
  console.log(`                                         git commit -m "chore(release): ${tag}"`);
  console.log('  4. Tag it:                             npm run release:tag');
}

function tag(args) {
  requireReleaseState({ allowBranch: args.includes('--any-branch') });
  const version = currentVersion();
  const name = tagForVersion(version);
  if (tagExists(name)) fail(`Tag ${name} already exists. Each version is released once; prepare a new version instead.`);
  const entry = findRelease(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!entry || !entry.date) fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry. Run npm run release:prepare first.`);
  const higher = versionTags().filter((t) => compareVersions(t.slice(1), version) >= 0);
  if (higher.length) fail(`${version} is not newer than the existing tag ${higher.at(-1)}.`);

  const head = git('rev-parse', 'HEAD');
  git('tag', '-a', name, '-m', `CONDUIT ${name}`);
  // Verify: annotated, on this commit, and matching package.json.
  const type = git('cat-file', '-t', name);
  const target = git('rev-parse', `${name}^{commit}`);
  const tagged = execFileSync('git', ['show', `${name}:package.json`], { cwd: root, encoding: 'utf8' });
  if (type !== 'tag' || target !== head || JSON.parse(tagged).version !== version) fail(`Tag ${name} did not verify (type ${type}, commit ${target}). Inspect it with: git show ${name}`);
  console.log(`✓ Created annotated tag ${name} on ${head.slice(0, 7)}; its package.json says ${version}.`);
  console.log(`\nNothing was pushed. When you're ready:  git push origin ${RELEASE_BRANCH} ${name}`);
  console.log('Optional Windows installer:            npm run dist   (apps/desktop/release/)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'status') status();
    else if (command === 'check') check();
    else if (command === 'prepare') prepare(args);
    else if (command === 'tag') tag(args);
    else fail('Usage: node scripts/release.mjs <status|check|prepare|tag>');
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
