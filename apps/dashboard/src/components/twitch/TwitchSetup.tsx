import { useState } from 'react';
import type { DisconnectResult } from '@conduit/shared/app/connections';
import type { TwitchAccountState, TwitchChatbotMode, TwitchSendResult, TwitchSetupState } from '@conduit/shared/twitch/twitch-setup';
import { api, ApiClientError, errorMessage } from '../../api';
import { useAsync, useBackendStatus, usePolling, type AsyncState } from '../../hooks';
import { bridgeCall, useDiscordAction } from '../discord/DiscordSetup';
import { EntityIcon } from '../EntityIcon';
import { CopyButton } from '../CopyButton';
import { CHAT_STATUS_LABEL, CHAT_STATUS_TONE } from '../kick/KickSetup';
import { Button, fieldError } from '../forms';
import { PlatformIcon } from '../PlatformIcon';
import { SetupWizard, SummaryItem, type WizardStep } from '../SetupWizard';

const BUSY_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

/** The backend's Twitch state (GET /api/twitch/setup): polled quickly while a browser approval is pending. */
export function useTwitchSetup(fast = false): AsyncState<TwitchSetupState> {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const setup = useAsync(() => api<TwitchSetupState>('GET', '/api/twitch/setup'), [running]);
  const { reload, data, error } = setup;
  const busy = data && (data.primary.pending || data.bot.pending);
  usePolling(reload, error ? 2000 : busy || fast ? BUSY_POLL_MS : IDLE_POLL_MS, [data, error]);
  return setup;
}

const openDeveloperConsole = () =>
  bridgeCall((b) => (b.twitch ? b.twitch.openDeveloperConsole() : Promise.reject(new Error('Update the CONDUIT desktop app to open the Twitch Developer Console from here.'))));
type Role = 'primary' | 'bot';
const connectTwitch = (role: Role) => bridgeCall((b) => b.connections.connect('twitch', role));
const cancelTwitch = (role: Role) => api('POST', '/api/connections/twitch/cancel', { role });
const disconnectTwitch = async (role: Role) => (await api<DisconnectResult>('POST', '/api/connections/twitch/disconnect', { role })).message;

/** The account's picture and name (with its login), or its state when not connected. */
function AccountLine({ a }: { a: TwitchAccountState }) {
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

/** The dashboard tag: the account's verified authorization (not just saved app credentials). */
export function twitchConnectionTag(s: TwitchSetupState): { label: string; pill: string } {
  if (s.primary.pending) return { label: 'Connecting', pill: 'pill-warn' };
  if (s.primary.status === 'connected') return { label: 'Connected', pill: 'pill-ok' };
  if (s.primary.status === 'needs_reauth') return { label: 'Needs Reconnect', pill: 'pill-bad' };
  return { label: 'Not Connected', pill: 'pill-muted' };
}

export interface TwitchCardProps {
  state: TwitchSetupState;
  busy?: boolean;
  actionError?: string | null;
  actionNotice?: string | null;
  onOpen?: () => void;
  onConnect?: (role: Role) => void;
  onCancel?: (role: Role) => void;
  onDisconnect?: () => void;
}

/** The dashboard's Twitch card: the streamer's account and the chatbot. */
export function TwitchCard({ state: s, busy, actionError, actionNotice, onOpen, onConnect, onCancel, onDisconnect }: TwitchCardProps) {
  const p = s.primary;
  const b = s.bot;
  const separate = s.chatbot.mode === 'separate';
  const pending = p.pending ? 'primary' : b.pending ? 'bot' : null;
  // Connected before chat existed (1.1.0): the account must be connected again to allow chat.
  const needsChatPermission = p.status === 'connected' && s.chat.receive.status === 'permission_required';
  const tag = twitchConnectionTag(s);
  return (
    <article className="connection-card" data-platform="twitch" aria-label="Twitch" aria-busy={busy || pending !== null || undefined}>
      <header className="connection-head">
        <PlatformIcon platform="twitch" />
        <h3>Twitch</h3>
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
        <div className="row">
          <dt>App</dt>
          <dd>{s.application.configured ? <span>Set up</span> : <span className="muted">Not set up</span>}</dd>
        </div>
      </dl>

      {pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT on Twitch in your browser…
        </p>
      )}
      {!pending && (p.problem || (separate && b.problem)) && (
        <p className="connection-note note-warn" role="status">
          {p.problem ?? b.problem}
        </p>
      )}
      {!pending && !p.problem && needsChatPermission && (
        <p className="connection-note note-warn" role="status">
          Connect your Twitch account again to allow chat (commands and timed messages in your Twitch chat).
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
            Connect Twitch
          </Button>
        ) : (
          <>
            {(p.status === 'needs_reauth' || needsChatPermission) && (
              <Button busy={busy} onClick={() => onConnect?.('primary')}>
                {needsChatPermission ? 'Allow Chat' : 'Reconnect'}
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

/** Loads Twitch state, keeps it current, and hosts the setup dialog. */
export function TwitchConnect() {
  const [open, setOpen] = useState(false);
  const setup = useTwitchSetup(open);
  const { data, reload } = setup;
  const { busy, error, notice, run } = useDiscordAction(reload);

  if (!data) {
    return (
      <article className="connection-card" data-platform="twitch" aria-label="Twitch">
        <header className="connection-head">
          <PlatformIcon platform="twitch" />
          <h3>Twitch</h3>
        </header>
        <p className="muted small">{setup.error ? `Waiting for the CONDUIT backend… (${errorMessage(setup.error)})` : 'Loading…'}</p>
      </article>
    );
  }
  return (
    <>
      <TwitchCard
        state={data}
        busy={busy}
        actionError={error}
        actionNotice={notice}
        onOpen={() => setOpen(true)}
        onConnect={(role) => void run(async () => void (await connectTwitch(role)))}
        onCancel={(role) => void run(async () => void (await cancelTwitch(role)))}
        onDisconnect={() => void run(() => disconnectTwitch('primary'))}
      />
      {open && <TwitchSetupDialog state={data} onChanged={reload} onClose={() => setOpen(false)} />}
    </>
  );
}

// ── setup dialog ──────────────────────────────────────────────────────────────

export type TwitchWizardStep = 'app' | 'account' | 'chatbot' | 'chat';

/** Twitch's steps: complete only from verified backend state; each opens once what it depends on is done. */
export function twitchWizardSteps(s: TwitchSetupState): Array<WizardStep<TwitchWizardStep>> {
  const app = s.application.configured;
  const account = s.primary.status === 'connected';
  return [
    { id: 'app', label: 'Twitch App', complete: app, reachable: true },
    { id: 'account', label: 'Your Account', complete: account, reachable: app },
    {
      id: 'chatbot',
      label: 'Chatbot',
      complete: s.chatbot.ready,
      reachable: app && s.primary.status !== 'not_connected',
    },
    {
      id: 'chat',
      label: 'Live Chat',
      complete: s.chat.receive.status === 'connected',
      reachable: app && account,
    },
  ];
}

/** Where the wizard opens: the first step that isn't done yet (or the last one). */
export function firstOpenTwitchStep(s: TwitchSetupState): TwitchWizardStep {
  const steps = twitchWizardSteps(s);
  return (steps.find((x) => !x.complete && x.reachable) ?? steps[steps.length - 1]!).id;
}

export function TwitchSetupDialog({ state: s, onChanged, onClose, initialStep }: { state: TwitchSetupState; onChanged: () => void; onClose: () => void; initialStep?: TwitchWizardStep }) {
  const [step, setStep] = useState<TwitchWizardStep>(() => initialStep ?? firstOpenTwitchStep(s));
  return (
    <SetupWizard platform="twitch" title="Twitch setup" steps={twitchWizardSteps(s)} current={step} onStep={setStep} onClose={onClose}>
      {step === 'app' && <TwitchAppSection s={s} onChanged={onChanged} />}
      {step === 'account' && <TwitchAccountSection s={s} onChanged={onChanged} />}
      {step === 'chatbot' && <TwitchChatbotSection s={s} onChanged={onChanged} />}
      {step === 'chat' && (
        <>
          <TwitchSummary s={s} />
          <TwitchChatSection s={s} onChanged={onChanged} />
        </>
      )}
    </SetupWizard>
  );
}

/** The verified result: the app, the main account, the chatbot and live chat. */
function TwitchSummary({ s }: { s: TwitchSetupState }) {
  const done = twitchWizardSteps(s).every((x) => x.complete);
  const chatbot = s.chatbot.mode === 'primary' ? s.primary : s.bot;
  return (
    <div className={`setup-summary${done ? ' setup-done' : ''}`} role="status" aria-label="Setup status">
      <p className="setup-summary-title">{done ? 'Twitch is set up.' : 'Not finished yet'}</p>
      <div className="summary-grid">
        <SummaryItem label="Twitch App" ok={s.application.configured}>
          <span>{s.application.configured ? 'Set up' : 'Not set up'}</span>
        </SummaryItem>
        <SummaryItem label="Main Account" ok={s.primary.status === 'connected'}>
          <AccountLine a={s.primary} />
        </SummaryItem>
        <SummaryItem label="Chatbot" ok={s.chatbot.ready}>
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

/** Client-side checks with actionable messages; the server re-validates and checks the pair with Twitch. */
export function checkTwitchAppForm(f: { clientId: string; clientSecret: string }, secretStored: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const id = f.clientId.trim();
  if (!id) errors.clientId = 'Paste the Client ID of your Twitch app.';
  else if (id.length < 20 || !/^[A-Za-z0-9]+$/.test(id)) errors.clientId = 'This does not look like a Twitch Client ID. Copy it again from your Twitch app.';
  const secret = f.clientSecret.trim();
  if (!secret && !secretStored) errors.clientSecret = 'Paste the Client Secret of your Twitch app.';
  else if (secret && (secret.length < 20 || !/^[A-Za-z0-9]+$/.test(secret))) errors.clientSecret = 'This does not look like a Twitch Client Secret. Copy it again.';
  return errors;
}

function TwitchAppSection({ s, onChanged }: { s: TwitchSetupState; onChanged: () => void }) {
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
    const errors = checkTwitchAppForm({ clientId, clientSecret }, secretStored);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const ok = await save.run(() => api('POST', '/api/twitch/application', { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }));
    setClientSecret(''); // the secret leaves the page as soon as it is sent
    if (ok) setEditing(false);
  }

  return (
    <section className="stack" aria-label="Twitch app">
      {!editing ? (
        <p>
          Client ID <code>{s.application.clientId}</code>{' '}
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        </p>
      ) : (
        <>
          <p className="small">
            In the Twitch Developer Console, select <strong>Register Your Application</strong> (client type <strong>Confidential</strong>) with this OAuth
            Redirect URL:
          </p>
          <div className="copy-row">
            <code className="selectable">{s.redirectUri}</code>
            <CopyButton text={s.redirectUri} />
          </div>
          <div className="button-row">
            <Button variant="secondary" busy={portal.busy} onClick={() => void portal.run(openDeveloperConsole)}>
              Open Twitch Developer Console
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
              <label htmlFor="twitch-client-id">
                Client ID <span className="portal-tag">Twitch · Developer Console</span>
              </label>
              <input
                id="twitch-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={err('clientId') ? true : undefined}
                aria-describedby="twitch-client-id-note"
              />
              {err('clientId') && (
                <span id="twitch-client-id-note" className="field-error">
                  {err('clientId')}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="twitch-client-secret">
                Client Secret <span className="portal-tag">Twitch · Developer Console</span>
              </label>
              <div className="secret-input">
                <input
                  id="twitch-client-secret"
                  type={shown ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secretStored ? 'Saved securely — leave blank to keep it' : ''}
                  aria-invalid={err('clientSecret') ? true : undefined}
                  aria-describedby="twitch-client-secret-note"
                />
                <Button variant="ghost" onClick={() => setShown((v) => !v)} aria-pressed={shown} disabled={!clientSecret} aria-label={`${shown ? 'Hide' : 'Show'} Client Secret`}>
                  {shown ? 'Hide' : 'Show'}
                </Button>
              </div>
              {err('clientSecret') && (
                <span id="twitch-client-secret-note" className="field-error">
                  {err('clientSecret')}
                </span>
              )}
            </div>
            {save.error && !(save.error instanceof ApiClientError && save.error.issues.length > 0) ? <ErrorLine error={save.error} /> : null}
            <div className="button-row">
              <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy || undefined}>
                {save.busy ? 'Checking with Twitch…' : 'Verify and save'}
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

function TwitchAccountSection({ s, onChanged }: { s: TwitchSetupState; onChanged: () => void }) {
  const action = useAction(onChanged);
  const p = s.primary;
  return (
    <section className="stack" aria-label="Your Twitch account">
      {p.status !== 'not_connected' && <AccountLine a={p} />}
      {p.pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT on Twitch in your browser…
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
          <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => cancelTwitch('primary'))}>
            Cancel
          </Button>
        ) : p.status === 'connected' ? (
          <Button variant="ghost" busy={action.busy} onClick={() => void action.run(() => disconnectTwitch('primary'))}>
            Disconnect main account
          </Button>
        ) : (
          <Button busy={action.busy} onClick={() => void action.run(() => connectTwitch('primary'))}>
            {p.status === 'needs_reauth' ? 'Reconnect' : 'Connect Twitch account'}
          </Button>
        )}
      </div>
    </section>
  );
}

function TwitchChatbotSection({ s, onChanged }: { s: TwitchSetupState; onChanged: () => void }) {
  const action = useAction(onChanged);
  const b = s.bot;
  const setMode = (mode: TwitchChatbotMode) => void action.run(() => api('POST', '/api/twitch/chatbot', { mode }));
  return (
    <section className="stack" aria-label="Chatbot account">
      <fieldset className="choice-list" disabled={action.busy}>
        <legend className="small">Chatbot account</legend>
        <label>
          <input type="radio" name="twitch-chatbot" checked={s.chatbot.mode === 'primary'} onChange={() => setMode('primary')} /> Use my main account
        </label>
        <label>
          <input type="radio" name="twitch-chatbot" checked={s.chatbot.mode === 'separate'} onChange={() => setMode('separate')} /> Use a separate bot
          account
        </label>
      </fieldset>

      {s.chatbot.mode === 'separate' && (
        <>
          {b.status !== 'not_connected' && <AccountLine a={b} />}
          {b.status === 'not_connected' && <p className="small">Log in to twitch.tv as the bot account first, or use a private window.</p>}
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
              <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => cancelTwitch('bot'))}>
                Cancel
              </Button>
            ) : b.status === 'not_connected' ? (
              <Button busy={action.busy} onClick={() => void action.run(() => connectTwitch('bot'))}>
                Add Bot Account
              </Button>
            ) : (
              <>
                <Button variant={b.status === 'needs_reauth' ? 'primary' : 'secondary'} busy={action.busy} onClick={() => void action.run(() => connectTwitch('bot'))}>
                  {b.status === 'needs_reauth' ? 'Reconnect bot account' : 'Replace bot account'}
                </Button>
                <Button variant="ghost" busy={action.busy} onClick={() => void action.run(() => disconnectTwitch('bot'))}>
                  Disconnect bot account
                </Button>
              </>
            )}
          </div>
        </>
      )}
      {s.chatbot.mode === 'primary' && s.chat.send.missingScope && s.primary.status === 'connected' && (
        <div className="button-row">
          <Button busy={action.busy} onClick={() => void action.run(() => connectTwitch('primary'))}>
            Reconnect main account
          </Button>
        </div>
      )}
      {!s.chatbot.ready && <p className="small text-warn">{s.chatbot.note}</p>}
      <ErrorLine error={action.error} />
    </section>
  );
}

// ── live chat ─────────────────────────────────────────────────────────────────

function TwitchChatSection({ s, onChanged }: { s: TwitchSetupState; onChanged: () => void }) {
  const r = s.chat.receive;
  const send = s.chat.send;
  const action = useAction(onChanged);
  const [content, setContent] = useState('');
  const [result, setResult] = useState<TwitchSendResult | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);

  async function sendTest() {
    setResult(null);
    setSendError(null);
    setSending(true);
    try {
      // Explicit user action only; the backend validates the text and reports Twitch's real result.
      setResult(await api<TwitchSendResult>('POST', '/api/twitch/chat/send', { content }));
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
        Receiving {s.primary.handle ?? s.primary.name}'s chat: <strong className={CHAT_STATUS_TONE[r.status]}>{CHAT_STATUS_LABEL[r.status]}</strong>
        {r.status === 'connected' && (
          <span className="muted small">
            {' '}
            — {r.messagesReceived} message{r.messagesReceived === 1 ? '' : 's'} received
          </span>
        )}
      </p>
      {r.problem && (
        <p className={`connection-note ${r.status === 'error' ? 'note-error' : 'note-warn'}`} role="status">
          {r.problem}
        </p>
      )}
      <div className="button-row">
        {r.status === 'permission_required' && (
          <Button busy={action.busy} onClick={() => void action.run(() => connectTwitch('primary'))}>
            Reconnect main account
          </Button>
        )}
        {r.status !== 'connecting' && r.status !== 'permission_required' && (
          <Button variant="secondary" busy={action.busy} onClick={() => void action.run(() => api('POST', '/api/twitch/chat/retry'))}>
            {r.status === 'connected' ? 'Reconnect chat' : 'Retry'}
          </Button>
        )}
      </div>

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
        r.status === 'connected' && <p className="muted small">No messages yet.</p>
      )}

      <h4>Send a test message</h4>
      {send.problem && (
        <p className="connection-note note-warn" role="status">
          {send.problem}
        </p>
      )}
      {send.missingScope && send.account && (
        <div className="button-row">
          <Button busy={action.busy} onClick={() => void action.run(() => connectTwitch(send.account!))}>
            {send.account === 'bot' ? 'Reconnect bot account' : 'Reconnect main account'}
          </Button>
        </div>
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
              {sending ? 'Sending…' : `Send as ${send.accountName}`}
            </button>
          </div>
        </form>
      )}
      {result && (
        <p className="connection-note text-ok" role="status">
          Posted as {result.as}.
        </p>
      )}
      <ErrorLine error={sendError} />
      <ErrorLine error={action.error} />
    </section>
  );
}
