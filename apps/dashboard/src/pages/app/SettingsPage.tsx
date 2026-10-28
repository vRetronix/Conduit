import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { parseChangelog, type ChangelogRelease } from '@conduit/shared/app/changelog';
import type { AppInfo } from '@conduit/shared/app/desktop-bridge';
import { RELEASE_CHANNEL_LABELS, releaseChannel } from '@conduit/shared/app/version';
import { useAppInfo } from '../../hooks';
import { AppearanceSection } from './AppearanceSection';
import { Row, SystemStatus } from './SystemStatus';
import { BackupSection, LogsSection } from './SettingsMaintenance';
import './settings.css';

/**
 * CHANGELOG.md, bundled at build time (so the notes always match the build they ship with; nothing is fetched online)
 * as its own chunk, loaded when Settings opens.
 */
const loadChangelog = () => import('../../../../../CHANGELOG.md?raw').then((m) => m.default);

/**
 * Settings: this copy of CONDUIT (version, release channel, build), System status, Appearance & Themes, Backup &
 * Restore, Logs, and the release notes.
 * Loaded on demand (React.lazy in App.tsx), so it adds nothing to the startup bundle.
 */
export default function SettingsPage() {
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null);
  useEffect(() => {
    let active = true;
    void loadChangelog().then((text) => active && setReleases(parseChangelog(text)));
    return () => {
      active = false;
    };
  }, []);
  return (
    <SettingsView info={useAppInfo()} releases={releases}>
      <SystemStatus />
      <AppearanceSection />
      <BackupSection />
      <LogsSection />
    </SettingsView>
  );
}

export function SettingsView({ info, releases, children }: { info: AppInfo | null; releases: ChangelogRelease[] | null; children?: ReactNode }) {
  const version = info?.version ?? null;
  const channel = version ? releaseChannel(version) : null;
  return (
    <div className="stack">
      <section className="card about-card" aria-labelledby="about-title">
        <div className="about-head">
          <h2 id="about-title">About CONDUIT</h2>
          {version && <span className="about-version">v{version}</span>}
          {channel && <span className={`about-channel about-channel-${channel}`}>{RELEASE_CHANNEL_LABELS[channel]}</span>}
        </div>
        <dl>
          <Row label="Version">{version ?? '—'}</Row>
          <Row label="Release channel">{channel ? RELEASE_CHANNEL_LABELS[channel] : '—'}</Row>
          <Row label="Build">{info ? (info.isPackaged ? 'Installed app' : 'Development build (running from source)') : '—'}</Row>
          <Row label="Platform">{info ? (info.platform === 'win32' ? 'Windows' : info.platform) : '—'}</Row>
        </dl>
        <p className="muted small">
          {channel === 'initial-development'
            ? 'Versions below 1.0.0 are initial development: features and settings may still change between releases. '
            : ''}
          CONDUIT doesn’t check for updates online.
        </p>
      </section>
      {children}
      <ReleaseNotes releases={releases} current={version} />
    </div>
  );
}

/** The newest release open; every older one collapsed under "Earlier versions", so the page stays short. */
function ReleaseNotes({ releases, current }: { releases: ChangelogRelease[] | null; current: string | null }) {
  const shown = (releases ?? []).filter((r) => r.version !== null || r.groups.length > 0);
  const [latest, ...earlier] = shown;
  return (
    <section className="card" aria-labelledby="release-notes-title">
      <h2 id="release-notes-title">Release notes</h2>
      {releases === null ? <p className="muted">Loading…</p> : shown.length === 0 && <p className="muted">No release notes yet.</p>}
      {latest && <Release release={latest} current={current} open />}
      {earlier.length > 0 && (
        <details className="release-earlier">
          <summary>Earlier versions ({earlier.length})</summary>
          {earlier.map((r) => (
            <Release key={r.version ?? 'unreleased'} release={r} current={current} open={false} />
          ))}
        </details>
      )}
    </section>
  );
}

function Release({ release: r, current, open }: { release: ChangelogRelease; current: string | null; open: boolean }) {
  return (
    <details className="release" open={open}>
      <summary className="release-head">
        <h3>{r.version ? `v${r.version}` : 'Unreleased'}</h3>
        {r.date && <time dateTime={r.date}>{r.date}</time>}
        {r.version === null && <span className="muted small">In development: not part of a numbered release yet</span>}
        {r.version !== null && r.version === current && <span className="about-this">This version</span>}
      </summary>
      {r.notes.map((n, i) => (
        <p key={i} className="muted small">
          <Inline text={n} />
        </p>
      ))}
      {r.groups.map((g, gi) =>
        g.title === null ? (
          <GroupBody key={gi} group={g} />
        ) : (
          <details key={gi} className="release-group" open={gi === 0}>
            <summary>
              <Inline text={g.title} />
            </summary>
            <GroupBody group={g} />
          </details>
        ),
      )}
    </details>
  );
}

function GroupBody({ group }: { group: ChangelogRelease['groups'][number] }) {
  return (
    <>
      {group.notes.map((n, i) => (
        <p key={`n${i}`} className="muted small">
          <Inline text={n} />
        </p>
      ))}
      {group.sections.map((s, si) => (
        <div key={si} className="release-section">
          {s.title && <h4 className={`change-kind change-kind-${s.kind}`}>{s.title}</h4>}
          <ul>
            {s.items.map((item, ii) => (
              <li key={ii}>
                <Inline text={item.text} />
                {item.children.length > 0 && (
                  <ul>
                    {item.children.map((c, ci) => (
                      <li key={ci}>
                        <Inline text={c} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The changelog's inline Markdown — `code`, **bold**, *italic*, [links](…) (shown as text) — as React elements, never HTML. */
export function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+)\*|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const k = parts.length;
    if (m[1] !== undefined) parts.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) parts.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em key={k}>{m[3]}</em>);
    else parts.push(<Fragment key={k}>{m[4]}</Fragment>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
