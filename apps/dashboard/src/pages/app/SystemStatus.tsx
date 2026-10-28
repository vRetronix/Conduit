/**
 * Settings → System status: the backend process, the local API's health (with the database schema version) and this
 * app's version and mode.
 */
import type { ReactNode } from 'react';
import type { HealthResponse } from '@conduit/shared/app/protocol';
import { api, errorMessage } from '../../api';
import { useAppInfo, useAsync, useBackendStatus, usePolling } from '../../hooks';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function SystemStatus() {
  const app = useAppInfo();
  const backendStatus = useBackendStatus();
  const health = useAsync(() => api<HealthResponse>('GET', '/api/health'), [backendStatus?.state === 'running']);
  const { reload } = health;

  usePolling(reload, 10_000, [health.data, health.error]);

  return (
    <section className="card" aria-labelledby="system-status-title">
      <h2 id="system-status-title">System status</h2>
      <div className="status-columns">
        <section>
          <h3>Backend process</h3>
          <dl>
            <Row label="State">{backendStatus?.state ?? '—'}</Row>
            <Row label="Automatic restarts">{backendStatus?.restarts ?? 0}</Row>
            {backendStatus?.lastError && <Row label="Last error">{backendStatus.lastError}</Row>}
          </dl>
        </section>

        <section>
          <h3>API health</h3>
          {health.data === undefined && health.loading && <p className="muted">Checking…</p>}
          {health.error ? (
            <dl>
              <Row label="Status">
                <span className="text-bad">Unreachable</span>
              </Row>
              <Row label="Detail">{errorMessage(health.error)}</Row>
            </dl>
          ) : health.data ? (
            <dl>
              <Row label="Status">
                <span className={health.data.status === 'ok' ? 'text-ok' : 'text-warn'}>{health.data.status}</span>
              </Row>
              <Row label="Server version">{health.data.version}</Row>
              <Row label="Uptime">{formatUptime(health.data.uptimeSeconds)}</Row>
              <Row label="Database">
                {health.data.database.ok ? 'OK' : 'Problem'} · schema v{health.data.database.schemaVersion}
              </Row>
            </dl>
          ) : null}
        </section>

        <section>
          <h3>Application</h3>
          <dl>
            <Row label="Version">{app?.version ?? '—'}</Row>
            <Row label="Mode">{app ? (app.isPackaged ? 'Installed' : 'Development') : '—'}</Row>
            <Row label="Local API">{app?.apiBaseUrl ?? '—'} (this PC only)</Row>
          </dl>
        </section>
      </div>
    </section>
  );
}
