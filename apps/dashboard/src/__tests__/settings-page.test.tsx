// Settings: the version comes from getAppInfo (the main process), the release notes from CHANGELOG.md.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseChangelog } from '@conduit/shared/app/changelog';
import type { BackupsState } from '@conduit/shared/app/backups';
import type { AppInfo } from '@conduit/shared/app/desktop-bridge';
import changelogText from '../../../../CHANGELOG.md?raw';
import rootPackage from '../../../../package.json';
import { Inline, SettingsView } from '../pages/app/SettingsPage';

const info = (version: string, isPackaged = false): AppInfo => ({ version, platform: 'win32', isPackaged, apiBaseUrl: 'http://127.0.0.1:1' });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const NOTES = parseChangelog(`## [Unreleased]

### Next batch
#### Fixed
- A \`bug\`.

## [0.4.0] - 2026-11-02

### Added
- **Thing**.
### Breaking Changes
- Gone.
`);

describe('Settings', () => {
  it('shows the version from the app, its channel and build type', () => {
    const html = renderToStaticMarkup(<SettingsView info={info('0.4.0')} releases={NOTES} />);
    const t = text(html);
    expect(t).toContain('About CONDUIT v0.4.0');
    expect(t).not.toContain('More settings');
    expect(html).not.toMatch(/<input|<select|<textarea/);
    expect(t).toContain('Release channel Initial development');
    expect(t).toContain('Development build (running from source)');
    expect(t).toContain('Platform Windows');
    expect(t).toContain('doesn’t check for updates online');
    expect(t).not.toMatch(/update available/i);
  });

  it('labels channels only from the version', () => {
    expect(text(renderToStaticMarkup(<SettingsView info={info('1.2.0', true)} releases={[]} />))).toContain('Release channel Stable');
    expect(text(renderToStaticMarkup(<SettingsView info={info('1.3.0-beta.1', true)} releases={[]} />))).toContain('Release channel Beta');
    expect(text(renderToStaticMarkup(<SettingsView info={info('1.2.0', true)} releases={[]} />))).toContain('Build Installed app');
  });

  it('shows dashes, not a made-up version, before the app info arrives', () => {
    const html = renderToStaticMarkup(<SettingsView info={null} releases={NOTES} />);
    expect(text(html)).toContain('Version — Release channel —');
    expect(html).not.toContain('about-version');
  });

  it('lists release notes with dates and categories, marking the running version', () => {
    const html = renderToStaticMarkup(<SettingsView info={info('0.4.0')} releases={NOTES} />);
    expect(html).toContain('<time dateTime="2026-11-02">2026-11-02</time>');
    expect(html).toContain('change-kind-breaking');
    expect(html).toContain('<code>bug</code>');
    expect(html).toContain('<strong>Thing</strong>');
    expect(text(html)).toMatch(/Unreleased In development/);
    expect(text(html)).toMatch(/v0\.4\.0 2026-11-02 This version/);
  });

  it('opens only the newest release; older ones are collapsed under Earlier versions', () => {
    const releases = parseChangelog(`## [0.5.0] - 2026-11-03\n\n### New\n- New.\n\n## [0.4.0] - 2026-11-02\n\n### Old\n- Old.\n\n## [0.3.0] - 2026-11-01\n\n### Older\n- Older.\n`);
    const html = renderToStaticMarkup(<SettingsView info={info('0.5.0')} releases={releases} />);
    expect(html.match(/<details class="release" open="">/g)).toHaveLength(1);
    expect(html).toMatch(/<details class="release" open=""><summary class="release-head"><h3>v0\.5\.0<\/h3>/);
    expect(html).toMatch(/<details class="release-earlier"><summary>Earlier versions \(2\)<\/summary><details class="release"><summary class="release-head"><h3>v0\.4\.0/);
    expect(html).toContain('<h3>v0.3.0</h3>');
  });

  it('renders changelog text as text, never as HTML', () => {
    const html = renderToStaticMarkup(<Inline text={'<img src=x onerror=alert(1)> **ok** [link](javascript:void)'} />);
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong> link');
  });

  it('can show the real CHANGELOG.md, including the version this build carries', () => {
    const releases = parseChangelog(changelogText);
    const html = renderToStaticMarkup(<SettingsView info={info(rootPackage.version)} releases={releases} />);
    expect(text(html)).toContain(`v${rootPackage.version}`);
    expect(text(html)).toContain('This version');
  });
});

describe('Settings → Backup & Restore, Logs', () => {
  const backupState = (over: Partial<BackupsState> = {}): BackupsState => ({
    settings: { autoDaily: true, retention: 14, directory: null },
    directory: 'D:\data\backups',
    defaultDirectory: 'D:\data\backups',
    backups: [
      { file: 'conduit-20261014-120000-000-manual.db', kind: 'manual', createdAt: '2026-10-14T12:00:00.000Z', bytes: 380000, status: 'ok', appVersion: '0.4.0', schemaVersion: 17 },
      { file: 'conduit-20261013-030000-000-automatic.db', kind: 'automatic', createdAt: '2026-10-13T03:00:00.000Z', bytes: 1200, status: 'unverified', appVersion: null, schemaVersion: null },
    ],
    lastAutomaticAt: '2026-10-13T03:00:00.000Z',
    nextAutomaticAt: '2099-10-14T03:00:00.000Z',
    problem: null,
    running: false,
    lastRestore: null,
    ...over,
  });

  it('lists backups with type, size and status; Restore only for checked backups', async () => {
    const { BackupPanel } = await import('../pages/app/SettingsMaintenance');
    const html = renderToStaticMarkup(<BackupPanel state={backupState()} error={null} reload={() => {}} />);
    const t = text(html);
    expect(t).toContain('Back up now');
    expect(t).toMatch(/Manual 371\.1 KB OK when made/);
    expect(t).toMatch(/Automatic 1\.2 KB Unverified/);
    expect(t).toContain('Back up automatically once a day');
    expect(t).toContain('Manual and before-restore backups are never removed automatically');
    // The unverified backup's Restore button is disabled.
    expect(html.match(/<button[^>]*>Restore…<\/button>/g)!.filter((b) => b.includes('disabled'))).toHaveLength(1);
  });

  it('shows problems and the last restore result', async () => {
    const { BackupPanel } = await import('../pages/app/SettingsMaintenance');
    const t = text(
      renderToStaticMarkup(
        <BackupPanel
          state={backupState({ problem: 'The automatic backup failed: disk full', lastRestore: { at: '2026-10-14T13:00:00.000Z', ok: true, file: 'x.db', message: 'Restored x.db.', preRestoreFile: 'y.db' } })}
          error={null}
          reload={() => {}}
        />,
      ),
    );
    expect(t).toContain('The automatic backup failed: disk full');
    expect(t).toContain('Restored x.db.');
  });

  it('restore needs an explicit confirmation', async () => {
    const { RestoreConfirm } = await import('../pages/app/SettingsMaintenance');
    const html = renderToStaticMarkup(<RestoreConfirm backup={backupState().backups[0]!} pending={false} onCancel={() => {}} onConfirm={() => {}} />);
    expect(text(html)).toContain('a checked backup of the current state is made');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Restore this backup<\/button>/);
  });

  it('log entries: level, subsystem, hint and details; an empty result says so', async () => {
    const { LogList } = await import('../pages/app/SettingsMaintenance');
    const html = renderToStaticMarkup(
      <LogList
        view={{
          entries: [{ time: '2026-10-14T11:00:00.000Z', level: 'error', source: 'server', module: 'discord-bot', message: 'could not start the discord bot', details: { code: 4004 }, hint: 'Check Dashboard → Discord → Manage.' }],
          modules: ['discord-bot'],
          truncated: true,
          problems: ['desktop.log doesn’t exist yet.'],
          folder: 'D:\logs',
        }}
      />,
    );
    const t = text(html);
    expect(t).toMatch(/error discord-bot could not start the discord bot/);
    expect(t).toContain('Check Dashboard → Discord → Manage.');
    expect(html).toContain('&quot;code&quot;: 4004');
    expect(t).toContain('desktop.log doesn’t exist yet.');
    expect(t).toContain('Showing the most recent matching entries');
    expect(text(renderToStaticMarkup(<LogList view={{ entries: [], modules: [], truncated: false, problems: [], folder: '' }} />))).toContain('No log entries match these filters.');
  });
});
