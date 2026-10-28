import { useEffect, useState } from 'react';
import {
  BACKUP_RETENTION_MAX,
  LOG_VIEW_LEVELS,
  type BackupCheck,
  type BackupsState,
  type BackupView,
  type LogEntryView,
  type LogsView,
  type LogViewLevel,
} from '@conduit/shared/app/backups';
import { api, errorMessage } from '../../api';
import { bridge } from '../../bridge';
import { Button } from '../../components/forms';
import { useAsync, useBackendStatus } from '../../hooks';

const KIND_LABEL: Record<BackupView['kind'], string> = { manual: 'Manual', automatic: 'Automatic', 'pre-restore': 'Before a restore' };
const LEVEL_LABEL: Record<LogViewLevel, string> = { error: 'Errors', warn: 'Warnings', info: 'Info', debug: 'Debug' };

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ── Backup & Restore ─────────────────────────────────────────────────────────

export function BackupSection() {
  const backend = useBackendStatus();
  const state = useAsync(() => api<BackupsState>('GET', '/api/backups'), [backend?.state === 'running']);
  return <BackupPanel state={state.data ?? null} error={state.error ? errorMessage(state.error) : null} reload={state.reload} />;
}

export function BackupPanel({ state, error, reload }: { state: BackupsState | null; error: string | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [checks, setChecks] = useState<Record<string, BackupCheck>>({});
  const [restoring, setRestoring] = useState<BackupView | null>(null);
  const [restartPending, setRestartPending] = useState(false);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await fn() });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <section className="card" aria-labelledby="backup-title">
      <div className="about-head">
        <h2 id="backup-title">Backup &amp; Restore</h2>
      </div>
      <p className="muted small">
        A backup is a checked copy of everything you’ve set up in CONDUIT: commands, giveaways, notifications, moderation, settings and history. Your Discord and Kick
        sign-ins aren’t in it: they stay encrypted on this PC and keep working after a restore.
      </p>
      {error && <p className="text-bad small">{error}</p>}
      {!state && !error && <p className="muted">Loading…</p>}
      {state && (
        <>
          <div className="maint-status">
            <span>
              Last automatic backup: <strong>{state.lastAutomaticAt ? formatTime(state.lastAutomaticAt) : 'none yet'}</strong>
            </span>
            <span>
              Next: <strong>{state.nextAutomaticAt ? (Date.parse(state.nextAutomaticAt) <= Date.now() ? 'shortly' : formatTime(state.nextAutomaticAt)) : 'automatic backups are off'}</strong>
            </span>
          </div>
          {state.problem && (
            <p className="text-bad small" role="alert">
              {state.problem}
            </p>
          )}
          {state.lastRestore && (
            <p className={`small ${state.lastRestore.ok ? 'text-ok' : 'text-bad'}`}>
              Last restore ({formatTime(state.lastRestore.at)}): {state.lastRestore.message}
            </p>
          )}
          <div className="button-row">
            <Button busy={busy || state.running} onClick={() => void act(async () => `Backup made: ${(await api<BackupView>('POST', '/api/backups')).file}`)}>
              Back up now
            </Button>
            {bridge?.files && (
              <Button variant="ghost" onClick={() => void bridge!.files!.openBackupsFolder().then((r) => !r.ok && setMessage({ ok: false, text: r.error.message }))}>
                Open backup folder
              </Button>
            )}
          </div>
          {message && (
            <p className={`small ${message.ok ? 'text-ok' : 'text-bad'}`} role="status">
              {message.text}
            </p>
          )}
          <BackupSettingsForm state={state} onSaved={reload} />
          <h3 className="maint-subtitle">Backups</h3>
          {state.backups.length === 0 ? (
            <p className="muted">No backups yet in {state.directory}.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Made</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {state.backups.map((b) => {
                    const c = checks[b.file];
                    return (
                      <tr key={b.file}>
                        <td title={b.file}>{formatTime(b.createdAt)}</td>
                        <td>{KIND_LABEL[b.kind]}</td>
                        <td>{formatBytes(b.bytes)}</td>
                        <td>
                          {c ? (
                            <span className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? 'Checked: OK' : `Problem: ${c.message}`}</span>
                          ) : b.status === 'ok' ? (
                            'OK when made'
                          ) : (
                            <span className="text-warn">Unverified</span>
                          )}
                        </td>
                        <td className="actions">
                          <Button
                            variant="ghost"
                            className="btn btn-ghost btn-small"
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const r = await api<BackupCheck>('POST', '/api/backups/verify', { file: b.file });
                                setChecks((x) => ({ ...x, [b.file]: r }));
                                return r.ok ? 'The backup checked out.' : `The backup has a problem: ${r.message}`;
                              })
                            }
                          >
                            Check
                          </Button>
                          <Button variant="ghost" className="btn btn-ghost btn-small" disabled={busy || b.status !== 'ok'} onClick={() => setRestoring(b)}>
                            Restore…
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            Folder: <code>{state.directory}</code>. Automatic backups beyond the number to keep are removed, oldest first. Manual and before-restore backups are never
            removed automatically.
          </p>
          {restoring && (
            <RestoreConfirm
              backup={restoring}
              pending={restartPending}
              onCancel={() => setRestoring(null)}
              onConfirm={() =>
                void act(async () => {
                  const r = await api<{ restarting: boolean; preRestoreFile: string }>('POST', '/api/backups/restore', { file: restoring.file });
                  setRestartPending(true);
                  setRestoring(null);
                  return `Restoring. The current state was backed up first (${r.preRestoreFile}). CONDUIT is restarting its background service; this page updates when it’s back.`;
                })
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function BackupSettingsForm({ state, onSaved }: { state: BackupsState; onSaved: () => void }) {
  const [autoDaily, setAutoDaily] = useState(state.settings.autoDaily);
  const [retention, setRetention] = useState(String(state.settings.retention));
  const [directory, setDirectory] = useState(state.settings.directory ?? '');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setAutoDaily(state.settings.autoDaily);
    setRetention(String(state.settings.retention));
    setDirectory(state.settings.directory ?? '');
  }, [state.settings.autoDaily, state.settings.retention, state.settings.directory]);

  const save = async () => {
    setResult(null);
    try {
      await api('PATCH', '/api/backups/settings', { autoDaily, retention: Number(retention), directory: directory.trim() || null });
      setResult({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    }
  };

  return (
    <fieldset className="editor-block">
      <legend>Backup settings</legend>
      <label className="inline-check">
        <input type="checkbox" checked={autoDaily} onChange={(e) => setAutoDaily(e.target.checked)} /> Back up automatically once a day
      </label>
      <div className="editor-grid">
        <label className="field">
          <span className="field-label">Automatic backups to keep</span>
          <input type="number" min={1} max={BACKUP_RETENTION_MAX} value={retention} onChange={(e) => setRetention(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Backup folder</span>
          <input value={directory} placeholder={state.defaultDirectory} onChange={(e) => setDirectory(e.target.value)} />
        </label>
      </div>
      <div className="button-row">
        {bridge?.files && (
          <Button
            variant="ghost"
            onClick={() =>
              void bridge!.files!.chooseFolder().then((r) => {
                if (r.ok && r.data.path) setDirectory(r.data.path);
              })
            }
          >
            Choose folder…
          </Button>
        )}
        <Button variant="ghost" disabled={!directory} onClick={() => setDirectory('')}>
          Use default folder
        </Button>
        <Button variant="secondary" onClick={() => void save()}>
          Save backup settings
        </Button>
        {result && <span className={`small ${result.ok ? 'text-ok' : 'text-bad'}`}>{result.text}</span>}
      </div>
      <p className="muted small">Leave the folder empty to use the default ({state.defaultDirectory}). Existing backups stay where they are when you change it.</p>
    </fieldset>
  );
}

export function RestoreConfirm({ backup, pending, onCancel, onConfirm }: { backup: BackupView; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [understood, setUnderstood] = useState(false);
  return (
    <div className="restore-confirm" role="group" aria-label="Confirm restore">
      <p>
        <strong>Restore the backup from {formatTime(backup.createdAt)}?</strong>
      </p>
      <ul>
        <li>Everything you’ve set up in CONDUIT goes back to how it was then. Changes made since are replaced.</li>
        <li>First, a checked backup of the current state is made, so you can go back.</li>
        <li>CONDUIT restarts its background service for a few seconds; Discord and Kick reconnect by themselves. Your sign-ins aren’t affected.</li>
      </ul>
      <label className="inline-check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that the current setup will be replaced
      </label>
      <div className="button-row">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!understood || pending} onClick={onConfirm}>
          Restore this backup
        </Button>
      </div>
    </div>
  );
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export function LogsSection() {
  const [levels, setLevels] = useState<LogViewLevel[]>(['error', 'warn', 'info']);
  const [source, setSource] = useState<'' | 'server' | 'desktop'>('');
  const [module, setModule] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(0);
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const logs = useAsync(
    () => api<LogsView>('POST', '/api/logs/query', { levels, source: source || null, module: module || null, from: iso(from), to: iso(to), search, limit: 300 }),
    // Re-query when a filter changes (search waits for Refresh/Enter).
    [levels.join(), source, module, from, to, query],
  );
  return (
    <section className="card" aria-labelledby="logs-title">
      <div className="about-head">
        <h2 id="logs-title">Logs</h2>
      </div>
      <p className="muted small">What CONDUIT recorded while running, newest first. Secrets (tokens, passwords, keys) are always removed before anything is shown.</p>
      <div className="log-filters">
        {LOG_VIEW_LEVELS.map((l) => (
          <label key={l} className="inline-check">
            <input type="checkbox" checked={levels.includes(l)} onChange={(e) => setLevels(e.target.checked ? [...levels, l] : levels.filter((x) => x !== l))} /> {LEVEL_LABEL[l]}
          </label>
        ))}
        <label className="field">
          <span className="field-label">Part of CONDUIT</span>
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="">All</option>
            <option value="server">Background service</option>
            <option value="desktop">Desktop app</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Subsystem</span>
          <select value={module} onChange={(e) => setModule(e.target.value)}>
            <option value="">All</option>
            {(logs.data?.modules ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">From</span>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">To</span>
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field log-search">
          <span className="field-label">Search</span>
          <input value={search} placeholder="Text in the message or details" onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery((n) => n + 1)} />
        </label>
      </div>
      <div className="button-row">
        <Button variant="secondary" onClick={() => setQuery((n) => n + 1)}>
          Refresh
        </Button>
        {bridge?.files && (
          <Button variant="ghost" onClick={() => void bridge!.files!.openLogsFolder()}>
            Open log folder
          </Button>
        )}
      </div>
      {logs.error ? <p className="text-bad small">The logs couldn’t be read: {errorMessage(logs.error)}</p> : null}
      {!logs.data && logs.loading && <p className="muted">Loading…</p>}
      {logs.data && <LogList view={logs.data} />}
    </section>
  );
}

export function LogList({ view }: { view: LogsView }) {
  return (
    <>
      {view.problems.map((p) => (
        <p key={p} className="muted small">
          {p}
        </p>
      ))}
      {view.entries.length === 0 ? (
        <p className="muted">No log entries match these filters.</p>
      ) : (
        <ol className="log-list">
          {view.entries.map((e, i) => (
            <LogRow key={`${e.time}-${i}`} entry={e} />
          ))}
        </ol>
      )}
      {view.truncated && <p className="muted small">Showing the most recent matching entries. Older ones are in the log files.</p>}
    </>
  );
}

function LogRow({ entry: e }: { entry: LogEntryView }) {
  const hasDetails = Object.keys(e.details).length > 0;
  return (
    <li className={`log-entry log-${e.level}`}>
      <div className="log-line">
        <time dateTime={e.time}>{new Date(e.time).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })}</time>
        <span className={`log-level log-level-${e.level}`}>{e.level === 'warn' ? 'warning' : e.level}</span>
        <span className="log-where">{e.module ?? (e.source === 'desktop' ? 'desktop' : 'server')}</span>
        <span className="log-message">{e.message}</span>
      </div>
      {e.hint && <p className="log-hint small">{e.hint}</p>}
      {hasDetails && (
        <details className="log-details">
          <summary>Details</summary>
          <pre>{JSON.stringify(e.details, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}
