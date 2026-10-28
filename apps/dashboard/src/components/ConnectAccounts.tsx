import { useState } from 'react';
import type { DisconnectResult, Platform, PlatformConnectionSummary } from '@conduit/shared/app/connections';
import { api, ApiClientError, errorMessage } from '../api';
import { bridge } from '../bridge';
import { useAsync, useBackendStatus, usePolling } from '../hooks';
import { DiscordConnect } from './discord/DiscordSetup';
import { KickConnect } from './kick/KickSetup';
import { Button } from './forms';
import { PlatformIcon } from './PlatformIcon';

/** Poll quickly while waiting for the browser to return, slowly otherwise (to pick up background checks). */
const PENDING_POLL_MS = 1500;
const IDLE_POLL_MS = 15_000;

export interface ConnectionCardProps {
  connection: PlatformConnectionSummary;
  busy?: boolean;
  /** Result of the user's last action on this card (failed connect/disconnect, or a disconnect notice). */
  actionError?: string | null;
  actionNotice?: string | null;
  onConnect?: () => void;
  onCancel?: () => void;
  onDisconnect?: () => void;
}

function Avatar({ account }: { account: NonNullable<PlatformConnectionSummary['account']> }) {
  if (account.avatarDataUrl) return <img className="account-avatar" src={account.avatarDataUrl} alt="" width={28} height={28} />;
  return (
    <span className="account-avatar account-avatar-initial" aria-hidden="true">
      {account.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * One platform's card (YouTube and Twitch; Discord and Kick have their own). Laid out like Kick's: the Account and
 * Chatbot sections, then notes, with why connecting isn't available yet just above the button. Purely presentational:
 * everything shown comes from the backend summary.
 */
export function ConnectionCard({ connection: c, busy, actionError, actionNotice, onConnect, onCancel, onDisconnect }: ConnectionCardProps) {
  const connected = c.status === 'connected';
  const failure = actionError ?? (c.lastAttempt && !c.pending ? c.lastAttempt.message : null);
  return (
    <article
      className="connection-card"
      data-platform={c.platform}
      aria-label={`${c.name}: ${connected ? 'Connected' : c.pending ? 'Connecting' : 'Not Connected'}`}
      aria-busy={c.pending || busy || undefined}
    >
      <header className="connection-head">
        <PlatformIcon platform={c.platform} />
        <h3>{c.name}</h3>
        <span className={`pill ${connected ? 'pill-ok' : c.pending ? 'pill-warn' : 'pill-muted'}`}>{connected ? 'Connected' : c.pending ? 'Connecting' : 'Not Connected'}</span>
      </header>

      <dl className="connection-details">
        <div className="row">
          <dt>Account</dt>
          <dd className="account-cell">
            {c.account ? (
              <>
                <Avatar account={c.account} />
                <span>
                  {c.account.name}
                  {c.account.handle && c.account.handle !== c.account.name && <span className="muted"> @{c.account.handle}</span>}
                  {c.additionalAccounts > 0 && <span className="muted"> +{c.additionalAccounts} more</span>}
                </span>
              </>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
        </div>
        <div className="row">
          <dt>Chatbot</dt>
          <dd>
            <span className="muted">—</span>
          </dd>
        </div>
      </dl>

      {c.pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT in your browser…
        </p>
      )}
      {c.problem && !c.pending && (
        <p className="connection-note note-warn" role="status">
          {c.problem}
        </p>
      )}
      {failure && (
        <p className="connection-note note-error" role="alert">
          {failure}
        </p>
      )}
      {actionNotice && (
        <p className="connection-note note-warn" role="status">
          {actionNotice}
        </p>
      )}
      <div className="connection-bottom">
        {!c.authorizationAvailable && !connected && !failure && c.unavailableReason && <p className="connection-note muted">{c.unavailableReason}</p>}
        <div className="connection-actions">
          {c.pending ? (
            <Button variant="secondary" busy={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : connected ? (
            <Button variant="secondary" busy={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button busy={busy} onClick={onConnect}>
              {failure || c.problem ? 'Try again' : 'Connect'}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * The Connect Accounts section: live connection state for Discord, Kick, YouTube and Twitch from the backend.
 * It never assumes a connection: while loading or when the backend is unreachable it says so instead.
 */
export function ConnectAccounts() {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const connections = useAsync(() => api<PlatformConnectionSummary[]>('GET', '/api/connections'), [running]);
  const [busy, setBusy] = useState<Platform | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Platform, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<Platform, string>>>({});
  const { reload } = connections;
  const anyPending = connections.data?.some((c) => c.pending) ?? false;

  // Keep the cards current: fast while an authorization is in progress, slow otherwise, retrying while starting.
  usePolling(reload, connections.error ? 2000 : anyPending ? PENDING_POLL_MS : IDLE_POLL_MS, [connections.data, connections.error]);

  async function run(platform: Platform, action: () => Promise<string | null | void>) {
    setBusy(platform);
    setErrors((e) => ({ ...e, [platform]: undefined }));
    setNotices((n) => ({ ...n, [platform]: undefined }));
    try {
      const notice = await action();
      if (notice) setNotices((n) => ({ ...n, [platform]: notice }));
    } catch (err) {
      setErrors((e) => ({ ...e, [platform]: errorMessage(err) }));
    } finally {
      setBusy(null);
      reload();
    }
  }

  const connect = (platform: Platform) =>
    run(platform, async () => {
      if (!bridge) throw new Error('CONDUIT must be opened from the desktop app.');
      const result = await bridge.connections.connect(platform);
      if (!result.ok) throw new ApiClientError(result.status, result.error);
    });
  const cancel = (platform: Platform) => run(platform, async () => void (await api('POST', `/api/connections/${platform}/cancel`)));
  const disconnect = (platform: Platform) =>
    run(platform, async () => (await api<DisconnectResult>('POST', `/api/connections/${platform}/disconnect`)).message);

  return (
    <section className="connect-accounts" aria-label="Connect Accounts">
      {connections.data ? (
        <div className="connection-grid">
          {connections.data.map((c) =>
            // Discord has its own card: account, application, bot and server statuses, and the setup wizard.
            c.platform === 'kick' ? (
              <KickConnect key={c.platform} />
            ) : c.platform === 'discord' ? (
              <DiscordConnect key={c.platform} />
            ) : (
              <ConnectionCard
                key={c.platform}
                connection={c}
                busy={busy === c.platform}
                actionError={errors[c.platform] ?? null}
                actionNotice={notices[c.platform] ?? null}
                onConnect={() => void connect(c.platform)}
                onCancel={() => void cancel(c.platform)}
                onDisconnect={() => void disconnect(c.platform)}
              />
            ),
          )}
        </div>
      ) : connections.error ? (
        <p className="muted">Waiting for the CONDUIT backend… ({errorMessage(connections.error)})</p>
      ) : (
        <p className="muted">Loading connections…</p>
      )}
    </section>
  );
}
