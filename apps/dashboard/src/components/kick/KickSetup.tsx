import { useState } from 'react';
import type { DisconnectResult } from '@conduit/shared/app/connections';
import type {
  KickAccountState,
  KickChatbotMode,
  KickChatReceiveStatus,
  KickSendResult,
  KickSetupState,
} from '@conduit/shared/kick/kick-setup';
import { api, ApiClientError, errorMessage } from '../../api';
import { useAsync, useBackendStatus, usePolling, type AsyncState } from '../../hooks';
import { bridgeCall, useDiscordAction } from '../discord/DiscordSetup';
import { EntityIcon } from '../EntityIcon';
import { CopyButton } from '../CopyButton';
import { Button, fieldError } from '../forms';
import { PlatformIcon } from '../PlatformIcon';
import { KickBotAccountCard } from './KickBotAccountCard';
import { SetupWizard, SummaryItem, type WizardStep } from '../SetupWizard';

const BUSY_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

export const CHAT_STATUS_LABEL: Record<KickChatReceiveStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
  permission_required: 'Permission required',
};

const CHAT_STATUS_TONE: Record<KickChatReceiveStatus, string> = {
  disconnected: 'muted',
  connecting: 'text-warn',
  connected: 'text-ok',
  reconnecting: 'text-warn',
  error: 'text-bad',
  permission_required: 'text-warn',
};

/** The backend's Kick state (GET /api/kick/setup): polled quickly while a browser approval is pending. */
export function useKickSetup(fast = false): AsyncState<KickSetupState> {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const setup = useAsync(() => api<KickSetupState>('GET', '/api/kick/setup'), [running]);
  const { reload, data, error } = setup;
  const busy = data && (data.primary.pending || data.bot.pending);
  usePolling(reload, error ? 2000 : busy || fast ? BUSY_POLL_MS : IDLE_POLL_MS, [data, error]);
  return setup;
}

const connectKick = (role: 'primary' | 'bot') => bridgeCall((b) => b.connections.connect('kick', role));
const cancelKick = (role: 'primary' | 'bot') => api('POST', '/api/connections/kick/cancel', { role });
const disconnectKick = async (role: 'primary' | 'bot') =>
  (await api<DisconnectResult>('POST', '/api/connections/kick/disconnect', { role })).message;

/** An account's picture and name (with its channel slug), or its state when not connected. */
function AccountLine({ a }: { a: KickAccountState }) {
  if (!a.name) return <span className="muted">Not Connected</span>;
  return (
    <span className="account-cell">
      <EntityIcon src={a.avatarDataUrl} name={a.name} />
      <span>
        {a.name}
        {a.handle && a.handle.toLowerCase() !== a.name.toLowerCase() && <span className="muted"> @{a.handle}</span>}
        {a.status === 'needs_reauth' && <span className="text-bad"> · Needs reconnect</span>}
      </span>
    </span>
  );
}

// ── card ──────────────────────────────────────────────────────────────────────

export interface KickCardProps {
  state: KickSetupState;
  busy?: boolean;
  actionError?: string | null;
  actionNotice?: string | null;
  onOpen?: () => void;
  onConnect?: (role: 'primary' | 'bot') => void;
  onCancel?: (role: 'primary' | 'bot') => void;
  onDisconnect?: () => void;
}

/**
 * The dashboard tag: the main account's verified authorization (not just saved app credentials). While an approval
 * is pending, or the connected account's chat is still connecting, it says Connecting (yellow).
 */
export function kickConnectionTag(s: KickSetupState): { label: string; pill: string } {
  const chat = s.chat.receive.status;
  if (s.primary.pending || s.bot.pending) return { label: 'Connecting', pill: 'pill-warn' };
  if (s.primary.status === 'connected' && (chat === 'connecting' || chat === 'reconnecting')) return { label: 'Connecting', pill: 'pill-warn' };
  if (s.primary.status === 'connected') return { label: 'Connected', pill: 'pill-ok' };
  if (s.primary.status === 'needs_reauth') return { label: 'Needs Reconnect', pill: 'pill-bad' };
  return { label: 'Not Connected', pill: 'pill-muted' };
}

/** The dashboard's Kick card: the streamer's account and the account the chatbot uses. */
export function KickCard({ state: s, busy, actionError, actionNotice, onOpen, onConnect, onCancel, onDisconnect }: KickCardProps) {
  const p = s.primary;
  const b = s.bot;
  const separate = s.chatbot.mode === 'separate';
  const pending = p.pending ? 'primary' : b.pending ? 'bot' : null;
  const tag = kickConnectionTag(s);
  return (
    <article className="connection-card" data-platform="kick" aria-label="Kick" aria-busy={busy || pending !== null || undefined}>
      <header className="connection-head">
        <PlatformIcon platform="kick" />
        <h3>Kick</h3>
        <span className={`pill ${tag.pill}`}>{tag.label}</span>
      </header>

      <dl className="connection-details">
        <div className="row">
          <dt>Account</dt>
          <dd>
            <AccountLine a={p} />
          </dd>
        </div>
        <div className="row">
          <dt>Chatbot</dt>
          <dd>
            {!separate ? (
              p.name ? (
                <AccountLine a={p} />
              ) : (
                <span className="muted">Main account</span>
              )
            ) : b.name ? (
              <AccountLine a={b} />
            ) : (
              <span className="muted">No bot account</span>
            )}
          </dd>
        </div>
      </dl>

      {pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT on Kick in your browser…
        </p>
      )}
      {!pending && (p.problem || (separate && b.problem)) && (
        <p className="connection-note note-warn" role="status">
          {p.problem ?? b.problem}
        </p>
      )}
      {actionError && (
        <p className="connection-note note-error" role="alert">
          {actionError}
        </p>
      )}
      {actionNotice && (
        <p className="connection-note note-warn" role="status">
          {actionNotice}
        </p>
      )}

      <div className="connection-actions stack-actions">
        {pending ? (
          <Button variant="secondary" busy={busy} onClick={() => onCancel?.(pending)}>
            Cancel
          </Button>
        ) : p.status === 'not_connected' ? (
          <Button busy={busy} onClick={onOpen}>
            Connect Kick
          </Button>
        ) : (
          <>
            {p.status === 'needs_reauth' && (
              <Button busy={busy} onClick={() => onConnect?.('primary')}>
                Reconnect
              </Button>
            )}
            {separate && b.status === 'not_connected' && (
              <Button variant="secondary" busy={busy} onClick={() => onConnect?.('bot')}>
                Add Bot Account
              </Button>
            )}
            {separate && b.status === 'needs_reauth' && (
              <Button variant="secondary" busy={busy} onClick={() => onConnect?.('bot')}>
                Reconnect Bot Account
              </Button>
            )}
            <Button variant="secondary" busy={busy} onClick={onOpen}>
              Manage
            </Button>
            <Button variant="ghost" busy={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/** Loads Kick state, keeps it current, and hosts the setup dialog. */
export function KickConnect() {
  const [open, setOpen] = useState(false);
  const setup = useKickSetup(open);
  const { data, reload } = setup;
  const { busy, error, notice, run } = useDiscordAction(reload);

  if (!data) {
    return (
      <article className="connection-card" data-platform="kick" aria-label="Kick">
        <header className="connection-head">
          <PlatformIcon platform="kick" />
          <h3>Kick</h3>
        </header>
        <p className="muted small">{setup.error ? `Waiting for the CONDUIT backend… (${errorMessage(setup.error)})` : 'Loading…'}</p>
      </article>
    );
  }
  return (
    <>
      <KickCard
        state={data}
        busy={busy}
        actionError={error}
        actionNotice={notice}
        onOpen={() => setOpen(true)}
        onConnect={(role) => void run(async () => void (await connectKick(role)))}
        onCancel={(role) => void run(async () => void (await cancelKick(role)))}
        onDisconnect={() => void run(() => disconnectKick('primary'))}
      />
      {open && <KickSetupDialog state={data} onChanged={reload} onClose={() => setOpen(false)} />}
    </>
  );
}

// ── setup dialog ──────────────────────────────────────────────────────────────

export type KickWizardStep = 'app' | 'account' | 'chatbot' | 'chat';

/** Kick's steps: complete only from verified backend state; each opens once what it depends on is done. */
export function kickWizardSteps(s: KickSetupState): Array<WizardStep<KickWizardStep>> {
  const app = s.application.configured;
  const account = s.primary.status === 'connected';
  const chatbotDone = s.chatbot.mode === 'primary' ? account : s.bot.status === 'connected';
  return [
    { id: 'app', label: 'Kick App', description: 'Your own Kick app: its Client ID and Client Secret from Kick’s developer settings.', complete: app, reachable: true },
    {
      id: 'account',
      label: 'Your Account',
      description: 'Connect your main Kick account — the streamer’s channel.',
      complete: account,
      reachable: app,
    },
    {
      id: 'chatbot',
      label: 'Chatbot',
      description: 'Which Kick account CONDUIT’s chatbot posts as: your main account, or a separate bot account.',
      complete: chatbotDone,
      reachable: app && s.primary.status !== 'not_connected',
    },
    {
      id: 'chat',
      label: 'Live Chat',
      description: 'Receive your channel’s chat (through a webhook tunnel) and check that messages arrive.',
      complete: s.chat.receive.status === 'connected',
      reachable: app && account,
    },
  ];
}

/** Where the wizard opens: the first step that isn't done yet (or the last one). */
export function firstOpenKickStep(s: KickSetupState): KickWizardStep {
  const steps = kickWizardSteps(s);
  return (steps.find((x) => !x.complete && x.reachable) ?? steps[steps.length - 1]!).id;
}

export function KickSetupDialog({
  state: s,
  onChanged,
  onClose,
  initialStep,
}: {
  state: KickSetupState;
  onChanged: () => void;
  onClose: () => void;
  /** Defaults to the first step that isn't done yet. */
  initialStep?: KickWizardStep;
}) {
  const [step, setStep] = useState<KickWizardStep>(() => initialStep ?? firstOpenKickStep(s));
  return (
    <SetupWizard platform="kick" title="Kick setup" steps={kickWizardSteps(s)} current={step} onStep={setStep} onClose={onClose}>
      {step === 'app' && <KickAppSection s={s} onChanged={onChanged} />}
      {step === 'account' && <KickPrimarySection s={s} onChanged={onChanged} />}
      {step === 'chatbot' && <KickChatbotSection s={s} onChanged={onChanged} />}
      {step === 'chat' && (
        <>
          <KickSummary s={s} />
          <KickChatSection s={s} onChanged={onChanged} />
        </>
      )}
    </SetupWizard>
  );
}

/** The verified result, like Discord's: main account, chatbot and live chat. */
function KickSummary({ s }: { s: KickSetupState }) {
  const steps = kickWizardSteps(s);
  const done = steps.every((x) => x.complete);
  const chatbot = s.chatbot.mode === 'primary' ? s.primary : s.bot;
  return (
    <div className={`setup-summary${done ? ' setup-done' : ''}`} role="status" aria-label="Setup status">
      <p className="setup-summary-title">{done ? 'Kick is set up.' : 'Not finished yet'}</p>
      <div className="summary-grid">
        <SummaryItem label="Main Account" ok={s.primary.status === 'connected'}>
          <AccountLine a={s.primary} />
        </SummaryItem>
        <SummaryItem label="Chatbot" ok={chatbot.status === 'connected'}>
          <AccountLine a={chatbot} />
        </SummaryItem>
        <SummaryItem label="Live Chat" ok={s.chat.receive.status === 'connected'}>
          <span className={CHAT_STATUS_TONE[s.chat.receive.status]}>{CHAT_STATUS_LABEL[s.chat.receive.status]}</span>
        </SummaryItem>
      </div>
    </div>
  );
}

function useAction(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
      after();
    }
  };
  return { busy, error, run };
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="connection-note note-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

/** Client-side checks with actionable messages; the server re-validates and checks the pair with Kick. */
export function checkKickAppForm(f: { clientId: string; clientSecret: string }, secretStored: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const id = f.clientId.trim();
  if (!id) errors.clientId = 'Paste the Client ID of your Kick app.';
  else if (id.length < 8 || !/^[A-Za-z0-9_-]+$/.test(id))
    errors.clientId = 'This does not look like a Kick Client ID. Copy it again from your Kick app.';
  const secret = f.clientSecret.trim();
  if (!secret && !secretStored) errors.clientSecret = 'Paste the Client Secret of your Kick app.';
  else if (secret && (secret.length < 16 || /\s/.test(secret)))
    errors.clientSecret = 'This does not look like a Kick Client Secret. Copy it again.';
  return errors;
}

function KickAppSection({ s, onChanged }: { s: KickSetupState; onChanged: () => void }) {
  const [editing, setEditing] = useState(!s.application.configured);
  const [clientId, setClientId] = useState(s.application.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [shown, setShown] = useState(false);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const save = useAction(onChanged);
  const portal = useAction(() => {});
  const secretStored = clientId.trim() === s.application.clientId && s.application.clientSecretStored;
  const err = (field: string) => fieldError(field, clientErrors, save.error);

  async function submit() {
    const errors = checkKickAppForm({ clientId, clientSecret }, secretStored);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const ok = await save.run(() =>
      api('POST', '/api/kick/application', {
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      }),
    );
    setClientSecret(''); // the secret leaves the page as soon as it is sent
    if (ok) setEditing(false);
  }

  return (
    <section className="stack" aria-label="Kick app">
      {!editing ? (
        <p>
          Configured <span className="muted">(Client ID {s.application.clientId}; Client Secret stored encrypted)</span>{' '}
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        </p>
      ) : (
        <>
          <p className="small">
            CONDUIT connects through <strong>your own</strong> Kick app — there is no shared CONDUIT app. In Kick, open Account Settings
            → Developer (two-factor authentication must be on), create an app, and set its redirect URL to exactly:
          </p>
          <div className="copy-row">
            <code className="selectable">{s.redirectUri}</code>
            <CopyButton text={s.redirectUri} />
          </div>
          <div className="button-row">
            <Button
              variant="secondary"
              busy={portal.busy}
              onClick={() => void portal.run(() => bridgeCall((b) => b.kick.openDeveloperSettings()))}
            >
              Open Kick developer settings
            </Button>
          </div>
          <ErrorLine error={portal.error} />
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor="kick-client-id">
                Client ID <span className="portal-tag">Kick · Developer settings</span>
              </label>
              <input
                id="kick-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={err('clientId') ? true : undefined}
                aria-describedby="kick-client-id-note"
              />
              <span id="kick-client-id-note" className={err('clientId') ? 'field-error' : 'field-hint'}>
                {err('clientId') ?? 'Shown for your app in Kick’s developer settings.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="kick-client-secret">
                Client Secret <span className="portal-tag">Kick · Developer settings</span>
              </label>
              <div className="secret-input">
                <input
                  id="kick-client-secret"
                  type={shown ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secretStored ? 'Saved securely — leave blank to keep it' : ''}
                  aria-invalid={err('clientSecret') ? true : undefined}
                  aria-describedby="kick-client-secret-note"
                />
                <Button
                  variant="ghost"
                  onClick={() => setShown((v) => !v)}
                  aria-pressed={shown}
                  disabled={!clientSecret}
                  aria-label={`${shown ? 'Hide' : 'Show'} Client Secret`}
                >
                  {shown ? 'Hide' : 'Show'}
                </Button>
              </div>
              <span id="kick-client-secret-note" className={err('clientSecret') ? 'field-error' : 'field-hint'}>
                {err('clientSecret') ?? 'Checked with Kick, then stored encrypted with Windows (DPAPI). It is never shown again.'}
              </span>
            </div>
            {save.error && !(save.error instanceof ApiClientError && save.error.issues.length > 0) ? (
              <ErrorLine error={save.error} />
            ) : null}
            <div className="button-row">
              <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy || undefined}>
                {save.busy ? 'Checking with Kick…' : 'Verify and save'}
              </button>
              {s.application.configured && (
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Keep current
                </Button>
              )}
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function KickPrimarySection({ s, onChanged }: { s: KickSetupState; onChanged: () => void }) {
  const action = useAction(onChanged);
  const p = s.primary;
  return (
    <section className="stack" aria-label="Your Kick account">
      <p className="small">
        Connect your <strong>main Kick account</strong> — the streamer’s channel. Kick’s own page opens in your browser and asks only to
        read your profile and channel ({s.scopes.primary.join(', ')}). CONDUIT never sees your Kick password.
      </p>
      {p.status !== 'not_connected' && <AccountLine a={p} />}
      {p.pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT on Kick in your browser…
        </p>
      )}
      {p.problem && !p.pending && (
        <p className="connection-note note-warn" role="status">
          {p.problem}
        </p>
      )}
      <ErrorLine error={action.error} />
      <div className="button-row">
        {p.pending ? (
          <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => cancelKick('primary'))}>
            Cancel
          </Button>
        ) : p.status === 'connected' ? (
          <Button variant="ghost" busy={action.busy} onClick={() => void action.run(() => disconnectKick('primary'))}>
            Disconnect main account
          </Button>
        ) : (
          <Button busy={action.busy} onClick={() => void action.run(() => connectKick('primary'))}>
            {p.status === 'needs_reauth' ? 'Reconnect' : 'Connect Kick account'}
          </Button>
        )}
      </div>
    </section>
  );
}

function KickChatbotSection({ s, onChanged }: { s: KickSetupState; onChanged: () => void }) {
  const action = useAction(onChanged);
  const b = s.bot;
  const setMode = (mode: KickChatbotMode) => void action.run(() => api('POST', '/api/kick/chatbot', { mode }));
  return (
    <section className="stack" aria-label="Chatbot account">
      <fieldset className="choice-list" disabled={action.busy}>
        <legend className="small muted">Which Kick account should CONDUIT’s chatbot use?</legend>
        <label>
          <input type="radio" name="kick-chatbot" checked={s.chatbot.mode === 'primary'} onChange={() => setMode('primary')} /> Use my main
          account
          <span className="muted small"> — simplest; nothing else to set up</span>
        </label>
        <label>
          <input type="radio" name="kick-chatbot" checked={s.chatbot.mode === 'separate'} onChange={() => setMode('separate')} /> Use a
          separate bot account
          <span className="muted small"> — a second Kick account you own</span>
        </label>
      </fieldset>

      {s.chatbot.mode === 'separate' && (
        <>
          {b.status !== 'not_connected' && <AccountLine a={b} />}
          <p className="small muted">
            Kick signs in whoever is logged in to kick.com in your browser. Log in as the bot account first (or use a private window), then
            select Add Bot Account.
          </p>
          {b.pending && (
            <p className="connection-note" role="status">
              <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT with the bot account…
            </p>
          )}
          {b.problem && !b.pending && (
            <p className="connection-note note-warn" role="status">
              {b.problem}
            </p>
          )}
          <div className="button-row">
            {b.pending ? (
              <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => cancelKick('bot'))}>
                Cancel
              </Button>
            ) : b.status === 'not_connected' ? (
              <Button busy={action.busy} onClick={() => void action.run(() => connectKick('bot'))}>
                Add Bot Account
              </Button>
            ) : (
              <>
                <Button
                  variant={b.status === 'needs_reauth' ? 'primary' : 'secondary'}
                  busy={action.busy}
                  onClick={() => void action.run(() => connectKick('bot'))}
                >
                  {b.status === 'needs_reauth' ? 'Reconnect bot account' : 'Replace bot account'}
                </Button>
                <Button variant="ghost" busy={action.busy} onClick={() => void action.run(() => disconnectKick('bot'))}>
                  Disconnect bot account
                </Button>
              </>
            )}
          </div>
        </>
      )}
      <p className="muted small">{s.chatbot.note}</p>
      <ErrorLine error={action.error} />
      {/* The bot account as Kick verified it, separate from the main account (no tokens). */}
      <KickBotAccountCard s={s} />
    </section>
  );
}

// ── live chat ─────────────────────────────────────────────────────────────────

function KickChatSection({ s, onChanged }: { s: KickSetupState; onChanged: () => void }) {
  const r = s.chat.receive;
  const send = s.chat.send;
  const action = useAction(onChanged);
  const [content, setContent] = useState('');
  const [result, setResult] = useState<KickSendResult | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const publicPath = r.webhookPath;

  async function sendTest() {
    setResult(null);
    setSendError(null);
    setSending(true);
    try {
      // Explicit user action only; the backend validates the text and reports Kick's real result.
      setResult(await api<KickSendResult>('POST', '/api/kick/chat/send', { content }));
      setContent('');
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
      onChanged();
    }
  }

  return (
    <section className="stack" aria-label="Live chat">

      <p role="status">
        Receiving {s.primary.handle ?? s.primary.name}'s chat:{' '}
        <strong className={CHAT_STATUS_TONE[r.status]}>{CHAT_STATUS_LABEL[r.status]}</strong>
        {r.status === 'connected' && (
          <span className="muted small">
            {' '}
            {r.delivery === 'confirmed'
              ? `— ${r.messagesReceived} message${r.messagesReceived === 1 ? '' : 's'} received`
              : '— subscribed; waiting for the first message to confirm your tunnel'}
          </span>
        )}
      </p>
      {r.problem && (
        <p className={`connection-note ${r.status === 'error' ? 'note-error' : 'note-warn'}`} role="status">
          {r.problem}
        </p>
      )}
      {r.rejected > 0 && (
        <p className="connection-note note-warn" role="status">
          {r.rejected} delivery attempt{r.rejected === 1 ? ' was' : 's were'} refused (not signed by Kick, too old or malformed).
        </p>
      )}
      <div className="button-row">
        {r.status === 'permission_required' && (
          <Button busy={action.busy} onClick={() => void action.run(() => connectKick('primary'))}>
            Reauthorize main account
          </Button>
        )}
        {r.status !== 'connecting' && r.status !== 'permission_required' && (
          <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => api('POST', '/api/kick/chat/retry'))}>
            {r.status === 'error' || r.status === 'reconnecting' ? 'Retry' : 'Check subscription'}
          </Button>
        )}
      </div>

      <details className="tunnel-help" open={r.delivery !== 'confirmed'}>
        <summary>Set up the webhook tunnel (Kick only sends chat to a public address)</summary>
        <ol className="portal-steps">
          <li>
            Start a tunnel to CONDUIT's chat receiver on this PC — only this address is exposed, nothing else:
            <div className="copy-row">
              <code className="selectable">cloudflared tunnel --url {r.localTarget}</code>
              <CopyButton text={`cloudflared tunnel --url ${r.localTarget}`} />
            </div>
            <span className="muted small">
              (or <code>ngrok http {r.localTarget}</code>). Keep the tunnel running while you stream.
            </span>
          </li>
          <li>
            In Kick → Account Settings → Developer → your app → Edit, turn <strong>Enable Webhooks</strong> on and set the URL to the
            tunnel's public https address followed by:
            <div className="copy-row">
              <code className="selectable">{publicPath}</code>
              <CopyButton text={publicPath} />
            </div>
            <span className="muted small">
              Example: https://example.trycloudflare.com{publicPath}. A free quick tunnel's address changes each time it starts.
            </span>
          </li>
          <li>Send a message in your Kick chat. It appears below once Kick delivers it.</li>
        </ol>
      </details>

      {s.chat.recent.length > 0 ? (
        <ul className="chat-recent" aria-label="Recent chat messages">
          {[...s.chat.recent]
            .reverse()
            .slice(0, 10)
            .map((m) => (
              <li key={m.messageId}>
                <strong style={m.senderColor ? { color: m.senderColor } : undefined}>{m.senderUsername}</strong>
                {m.badges.length > 0 && <span className="muted small"> [{m.badges.join(', ')}]</span>}: <span>{m.content}</span>
              </li>
            ))}
        </ul>
      ) : (
        r.status === 'connected' && <p className="muted small">No messages received yet this session.</p>
      )}

      <h4>Send a test message</h4>
      {send.account ? (
        <p className="small">
          Sends as <strong>{send.accountName}</strong> ({send.account === 'bot' ? 'bot account' : 'main account'}) to{' '}
          <strong>{send.channel}</strong>'s live chat. Nothing is ever posted automatically.
        </p>
      ) : null}
      {send.problem && (
        <p className="connection-note note-warn" role="status">
          {send.problem}
        </p>
      )}
      {send.missingScope && send.account && (
        <>
          {send.account === 'bot' && (
            <p className="muted small">
              Kick asks whoever is signed in to kick.com: log in as {send.accountName} first (or use a private window). The extra permission
              lets CONDUIT post chat messages as {send.accountName}.
            </p>
          )}
          <div className="button-row">
            <Button busy={action.busy} onClick={() => void action.run(() => connectKick(send.account!))}>
              {send.account === 'bot' ? 'Reauthorize bot account' : 'Reauthorize main account'}
            </Button>
          </div>
        </>
      )}
      {send.ready && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void sendTest();
          }}
        >
          <div className="secret-input">
            <input
              aria-label={`Message to send as ${send.accountName}`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={500}
              placeholder="Hello from CONDUIT!"
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={sending || !content.trim()} aria-busy={sending || undefined}>
              {sending ? 'Sending…' : 'Send to live chat'}
            </button>
          </div>
        </form>
      )}
      {result && (
        <p className="connection-note text-ok" role="status">
          Kick confirmed the message was posted as {result.as} in {result.channel}'s chat.
        </p>
      )}
      <ErrorLine error={sendError} />
      <ErrorLine error={action.error} />
    </section>
  );
}

