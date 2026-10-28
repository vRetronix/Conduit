import { useId, useState } from 'react';
import type { DisconnectResult } from '@conduit/shared/app/connections';
import type { ApiResult } from '@conduit/shared/app/desktop-bridge';
import { BOT_INSTALL_PERMISSIONS } from '@conduit/shared/discord/discord-permissions';
import type { DiscordPortalPage, DiscordSetupState, DiscordSetupStep } from '@conduit/shared/discord/discord-setup';
import { api, ApiClientError, errorMessage } from '../../api';
import { bridge } from '../../bridge';
import { useAsync, useBackendStatus, usePolling, type AsyncState } from '../../hooks';
import { EntityIcon } from '../EntityIcon';
import { CopyButton } from '../CopyButton';
import { Button, fieldError } from '../forms';
import { PlatformIcon } from '../PlatformIcon';
import { SetupWizard, SummaryItem, type WizardStep } from '../SetupWizard';

/** Poll quickly while something is in progress (browser approval, bot connecting), slowly otherwise. */
const BUSY_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

/**
 * The wizard's three steps. The backend still tracks five (application, account, install, bot, done); the last three
 * are shown together as "Add & Start the Bot". Developer Portal comes first because signing in with Discord uses your
 * own application's Client ID and Secret.
 */
export type DiscordWizardStep = 'application' | 'account' | 'bot';

export function wizardStepFor(step: DiscordSetupStep): DiscordWizardStep {
  return step === 'application' || step === 'account' ? step : 'bot';
}

export function discordWizardSteps(s: DiscordSetupState): Array<WizardStep<DiscordWizardStep>> {
  const at = ['application', 'account', 'bot'].indexOf(wizardStepFor(s.nextStep));
  const steps: Array<Omit<WizardStep<DiscordWizardStep>, 'reachable'>> = [
    {
      id: 'application',
      label: 'Developer Portal',
      description: 'Your own Discord application and bot, with three values copied from the Discord Developer Portal.',
      complete: s.application.configured,
    },
    {
      id: 'account',
      label: 'Your Account',
      description: 'Sign in with Discord so CONDUIT knows which account is yours.',
      complete: s.account.connected,
    },
    {
      id: 'bot',
      label: 'Add & Start the Bot',
      description: 'Add the bot to your server, start it, and check that everything is connected.',
      complete: s.nextStep === 'done',
    },
  ];
  return steps.map((x, i) => ({ ...x, reachable: i <= at || x.complete }));
}

/** The dashboard tag: the bot's live gateway connection, not just saved credentials. */
export function discordConnectionTag(s: DiscordSetupState): { label: string; pill: string } {
  if (s.bot.status === 'connected') return { label: 'Connected', pill: 'pill-ok' };
  if (s.application.configured && (s.bot.status === 'connecting' || s.bot.status === 'reconnecting')) return { label: 'Connecting', pill: 'pill-warn' };
  return { label: 'Not Connected', pill: 'pill-muted' };
}

export const BOT_LABEL: Record<DiscordSetupState['bot']['status'], string> = {
  not_configured: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  error: 'Disconnected',
};

export const INSTALL_LABEL: Record<DiscordSetupState['installation']['status'], string> = {
  installed: 'Installed',
  not_installed: 'Not Installed',
  unable_to_verify: 'Unable to Verify',
  unknown: 'Not Installed',
};

export const COMMANDS_LABEL: Record<DiscordSetupState['commands']['status'], string> = {
  not_registered: 'Not Registered',
  registering: 'Registering…',
  registered: 'Registered',
  partial: 'Partly Registered',
  failed: 'Registration Failed',
};

function busyState(s: DiscordSetupState): boolean {
  return (
    s.account.pending ||
    s.installation.pending ||
    s.bot.status === 'connecting' ||
    s.bot.status === 'reconnecting' ||
    s.commands.status === 'registering'
  );
}

/** Calls a desktop bridge action (main process validates and performs it). Throws ApiClientError on failure. */
export async function bridgeCall<T>(fn: (b: NonNullable<typeof bridge>) => Promise<ApiResult<T>>): Promise<T> {
  if (!bridge) throw new Error('CONDUIT must be opened from the desktop app.');
  const result = await fn(bridge);
  if (!result.ok) throw new ApiClientError(result.status, result.error);
  return result.data;
}

export const openPortal = (page: DiscordPortalPage) => bridgeCall((b) => b.discord.openPortal(page));

// ── card ──────────────────────────────────────────────────────────────────────

export interface DiscordCardProps {
  state: DiscordSetupState;
  busy?: boolean;
  actionError?: string | null;
  actionNotice?: string | null;
  onOpen?: (step?: DiscordSetupStep) => void;
  onReconnectBot?: () => void;
  onDisconnect?: () => void;
}

/** The dashboard's Discord card: your account, your bot and its server — each with its real picture and name. */
export function DiscordCard({ state: s, busy, actionError, actionNotice, onOpen, onReconnectBot, onDisconnect }: DiscordCardProps) {
  const done = s.nextStep === 'done';
  const configured = s.application.configured;
  const botDown = configured && (s.bot.status === 'disconnected' || s.bot.status === 'error');
  const botName = configured ? (s.bot.username ?? s.application.botUsername) : null;
  const servers = s.installation.status === 'installed' ? s.installation.guilds : [];
  const tag = discordConnectionTag(s);

  return (
    <article className="connection-card" data-platform="discord" aria-label="Discord" aria-busy={busy || undefined}>
      <header className="connection-head">
        <PlatformIcon platform="discord" />
        <h3>Discord</h3>
        <span className={`pill ${tag.pill}`}>{tag.label}</span>
      </header>

      <dl className="connection-details">
        <div className="row">
          <dt>Account</dt>
          <dd>
            {s.account.connected && s.account.name ? (
              <span className="account-cell">
                <EntityIcon src={s.account.avatarDataUrl} name={s.account.name} />
                <span>{s.account.name}</span>
              </span>
            ) : (
              <span className="muted">Not Connected</span>
            )}
          </dd>
        </div>
        <div className="row">
          <dt>Bot</dt>
          <dd>
            {botName ? (
              <span className="account-cell">
                <EntityIcon src={s.bot.avatarDataUrl} name={botName} />
                <span>
                  {botName}
                  {/* Connecting shows in the yellow tag above, not as gray text here. */}
                  {s.bot.status !== 'connected' && s.bot.status !== 'connecting' && s.bot.status !== 'reconnecting' && (
                    <span className={s.bot.status === 'error' ? 'text-bad' : 'muted'}> · {BOT_LABEL[s.bot.status]}</span>
                  )}
                </span>
              </span>
            ) : s.bot.status === 'connecting' || s.bot.status === 'reconnecting' ? (
              <span className="muted">—</span>
            ) : (
              <span className="muted">{BOT_LABEL[s.bot.status]}</span>
            )}
          </dd>
        </div>
        <div className="row">
          <dt>Server</dt>
          <dd>
            {servers.length > 0 ? (
              <span className="account-cell">
                <EntityIcon src={servers[0]!.iconDataUrl} name={servers[0]!.name} shape="rounded" />
                <span>
                  {servers[0]!.name}
                  {servers.length > 1 && <span className="muted"> +{servers.length - 1} more</span>}
                </span>
              </span>
            ) : (
              <span className={s.installation.status === 'unable_to_verify' ? 'text-warn' : 'muted'}>{INSTALL_LABEL[s.installation.status]}</span>
            )}
          </dd>
        </div>
      </dl>

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
        {!configured ? (
          <Button busy={busy} onClick={() => onOpen?.()}>
            Connect
          </Button>
        ) : !done ? (
          <Button busy={busy} onClick={() => onOpen?.()}>
            Continue Setup
          </Button>
        ) : null}
        {botDown && s.bot.retryable && (
          <Button variant="secondary" busy={busy} onClick={onReconnectBot}>
            Reconnect
          </Button>
        )}
        {configured && (
          <Button variant="secondary" busy={busy} onClick={() => onOpen?.('application')}>
            Manage
          </Button>
        )}
        {s.account.connected && (
          <Button variant="ghost" busy={busy} onClick={onDisconnect}>
            Disconnect
          </Button>
        )}
      </div>
    </article>
  );
}

// ── container ─────────────────────────────────────────────────────────────────

/**
 * The backend's Discord state (GET /api/discord/setup): the single source for the Dashboard card, Bot Accounts and
 * Commands. Re-fetched when the backend restarts, quickly while anything is changing (bot connecting or reconnecting,
 * registration in progress, browser approval pending) and every few seconds otherwise.
 */
export function useDiscordSetup(fast = false): AsyncState<DiscordSetupState> {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const setup = useAsync(() => api<DiscordSetupState>('GET', '/api/discord/setup'), [running]);
  const { reload, data, error } = setup;
  usePolling(reload, error ? 2000 : data && (busyState(data) || fast) ? BUSY_POLL_MS : IDLE_POLL_MS, [data, error]);
  return setup;
}

/** Runs a user action, keeping its error or notice for display, then refreshes the state. */
export function useDiscordAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(action: () => Promise<string | null | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const n = await action();
      if (n) setNotice(n);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      reload();
    }
  }
  return { busy, error, notice, run };
}

/** Loads the setup state, keeps it current, and hosts the wizard. */
export function DiscordConnect() {
  const [wizardStep, setWizardStep] = useState<DiscordWizardStep | null>(null);
  const setup = useDiscordSetup(wizardStep !== null);
  const { reload, data } = setup;
  const { busy, error, notice, run } = useDiscordAction(reload);

  if (!data) {
    return (
      <article className="connection-card" data-platform="discord" aria-label="Discord">
        <header className="connection-head">
          <PlatformIcon platform="discord" />
          <h3>Discord</h3>
        </header>
        <p className="muted small">{setup.error ? `Waiting for the CONDUIT backend… (${errorMessage(setup.error)})` : 'Loading…'}</p>
      </article>
    );
  }

  return (
    <>
      <DiscordCard
        state={data}
        busy={busy}
        actionError={error}
        actionNotice={notice}
        onOpen={(step) => setWizardStep(wizardStepFor(step ?? data.nextStep))}
        onReconnectBot={() => void run(async () => void (await api('POST', '/api/discord/bot/restart')))}
        onDisconnect={() => void run(async () => (await api<DisconnectResult>('POST', '/api/connections/discord/disconnect')).message)}
      />
      {wizardStep && (
        <DiscordSetupWizard state={data} step={wizardStep} onStep={setWizardStep} onChanged={reload} onClose={() => setWizardStep(null)} />
      )}
    </>
  );
}

// ── wizard ────────────────────────────────────────────────────────────────────

export interface DiscordSetupWizardProps {
  state: DiscordSetupState;
  step: DiscordWizardStep;
  onStep: (step: DiscordWizardStep) => void;
  onChanged: () => void;
  onClose: () => void;
}

export function DiscordSetupWizard({ state: s, step, onStep, onChanged, onClose }: DiscordSetupWizardProps) {
  return (
    <SetupWizard platform="discord" title="Discord setup" steps={discordWizardSteps(s)} current={step} onStep={onStep} onClose={onClose} hideContinue={step === 'application' && !s.application.configured}>
      {step === 'application' && <ApplicationStep state={s} onSaved={() => (onChanged(), onStep('account'))} onRemoved={onChanged} />}
      {step === 'account' && <AccountStep state={s} onChanged={onChanged} />}
      {step === 'bot' && <AddAndStartStep state={s} onChanged={onChanged} />}
    </SetupWizard>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
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
      after?.();
    }
  };
  return { busy, error, run, setError };
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="connection-note note-error" role="alert">
      {error instanceof ApiClientError && error.code === 'validation_error' && error.issues.length > 0
        ? `${error.message}. See the highlighted fields.`
        : errorMessage(error)}
    </p>
  );
}

function SecretField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  stored: boolean;
  error?: string;
  hint: string;
  /** Where the value comes from (shown as a tag next to the label). */
  source?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = props.error ? `${id}-error` : `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label} {props.source && <span className="portal-tag">{props.source}</span>}
      </label>
      <div className="secret-input">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={props.stored ? 'Saved securely — leave blank to keep it' : ''}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy}
        />
        <Button
          variant="ghost"
          onClick={() => setShown((v) => !v)}
          aria-pressed={shown}
          aria-label={`${shown ? 'Hide' : 'Show'} ${props.label}`}
          disabled={!props.value}
        >
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {props.error ? (
        <span id={`${id}-error`} className="field-error">
          {props.error}
        </span>
      ) : (
        <span id={`${id}-hint`} className="field-hint">
          {props.hint}
        </span>
      )}
    </div>
  );
}

function PortalButton({ page, children }: { page: DiscordPortalPage; children: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() =>
          void openPortal(page).then(
            () => setError(null),
            (err) => setError(errorMessage(err)),
          )
        }
      >
        {children}
      </Button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

const APP_ID_PATTERN = /^\d{15,25}$/;

/** Client-side checks with actionable messages; the server re-validates everything and checks with Discord. */
export function checkApplicationForm(
  f: { applicationId: string; clientSecret: string; botToken: string },
  stored: { secret: boolean; token: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const id = f.applicationId.trim();
  if (!id) errors.applicationId = 'Paste the Application ID from the General Information page.';
  else if (!APP_ID_PATTERN.test(id))
    errors.applicationId = 'The Application ID is a long number (15–25 digits). Copy it with the Copy button on General Information.';
  const secret = f.clientSecret.trim();
  if (!secret && !stored.secret)
    errors.clientSecret = 'Paste the Client Secret from the OAuth2 page (select Reset Secret if you have not copied it before).';
  else if (secret && (secret.length < 16 || /\s/.test(secret)))
    errors.clientSecret = 'This does not look like a Client Secret. Copy it again from the OAuth2 page.';
  const token = f.botToken.trim();
  if (!token && !stored.token) errors.botToken = 'Paste the bot token from the Bot page (select Reset Token to get one).';
  else if (token && (token.split('.').length !== 3 || token.length < 50 || !/^[A-Za-z0-9_\-.]+$/.test(token))) {
    errors.botToken = 'This does not look like a bot token (three parts separated by dots). Copy it again from the Bot page.';
  }
  return errors;
}

function ApplicationStep({ state: s, onSaved, onRemoved }: { state: DiscordSetupState; onSaved: () => void; onRemoved: () => void }) {
  const [applicationId, setApplicationId] = useState(s.application.applicationId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useAction();
  const remove = useAction();
  const sameApp = applicationId.trim() === s.application.applicationId;
  const stored = {
    secret: sameApp && s.application.clientSecretStored,
    token: sameApp && s.application.botTokenStored,
  };
  const err = (field: string) => fieldError(field, clientErrors, save.error);

  async function submit() {
    const errors = checkApplicationForm({ applicationId, clientSecret, botToken }, stored);
    setClientErrors(errors);
    save.setError(null);
    if (Object.keys(errors).length > 0) return;
    const ok = await save.run(() =>
      api('POST', '/api/discord/application', {
        applicationId: applicationId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      }),
    );
    // Secrets leave the page as soon as they are saved.
    setClientSecret('');
    setBotToken('');
    if (ok) onSaved();
  }

  return (
    <div className="stack">
      <p>
        CONDUIT uses <strong>your own</strong> Discord application and bot — there is no shared CONDUIT bot. Create one in the Discord
        Developer Portal (or use an existing one), then copy the three values marked <span className="portal-tag">Developer Portal</span>{' '}
        below. This comes first because signing in with Discord uses your application.
      </p>
      <ol className="portal-steps">
        <li>
          Open the Developer Portal and select <strong>New Application</strong> (or pick yours). Copy the <strong>Application ID</strong>{' '}
          from <em>General Information</em>.
        </li>
        <li>
          On <em>OAuth2</em>, add this exact <strong>Redirect</strong>, save, then copy the <strong>Client Secret</strong> (Reset Secret
          shows a new one):
          <div className="copy-row">
            <code className="selectable">{s.redirectUri}</code>
            <CopyButton text={s.redirectUri} />
          </div>
        </li>
        <li>
          On <em>Bot</em>, select <strong>Reset Token</strong> and copy the <strong>bot token</strong>. Under <em>Privileged Gateway Intents</em>,
          turn on <strong>Presence Intent</strong>, <strong>Server Members Intent</strong> and <strong>Message Content Intent</strong> (all three are
          required) and save.
        </li>
      </ol>
      <div className="button-row">
        <PortalButton page="applications">Open Developer Portal</PortalButton>
        {s.application.applicationId && <PortalButton page="oauth2">OAuth2 page</PortalButton>}
        {s.application.applicationId && <PortalButton page="bot">Bot page</PortalButton>}
      </div>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="discord-app-id">
            Application ID <span className="portal-tag">Developer Portal · General Information</span>
          </label>
          <input
            id="discord-app-id"
            value={applicationId}
            onChange={(e) => setApplicationId(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={err('applicationId') ? true : undefined}
            aria-describedby="discord-app-id-note"
          />
          <span id="discord-app-id-note" className={err('applicationId') ? 'field-error' : 'field-hint'}>
            {err('applicationId') ?? 'Also used as the OAuth2 Client ID (Discord shows the same number on the OAuth2 page).'}
          </span>
        </div>
        <SecretField
          label="Client Secret"
          source="Developer Portal · OAuth2"
          value={clientSecret}
          onChange={setClientSecret}
          stored={stored.secret}
          error={err('clientSecret')}
          hint="From the OAuth2 page. Used only to sign you in with Discord."
        />
        <SecretField
          label="Bot Token"
          source="Developer Portal · Bot"
          value={botToken}
          onChange={setBotToken}
          stored={stored.token}
          error={err('botToken')}
          hint="From the Bot page. Used only by your bot. Never share it."
        />
        <p className="muted small">
          CONDUIT checks each value with Discord, then stores the secret and token encrypted with Windows (DPAPI). They are never shown
          again.
        </p>
        <ErrorLine error={save.error} />
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy || undefined}>
            {save.busy ? 'Checking with Discord…' : s.application.configured ? 'Save and verify' : 'Verify and save'}
          </button>
        </div>
      </form>

      {s.application.configured && (
        <div className="danger-zone">
          {confirmRemove ? (
            <>
              <p className="small">
                Remove the whole Discord setup? CONDUIT signs out of your Discord account, stops the bot and deletes the stored secret and
                token. Your application and the bot's servers on Discord are not changed.
              </p>
              <div className="button-row">
                <Button
                  variant="danger"
                  busy={remove.busy}
                  onClick={() => void remove.run(() => api('POST', '/api/discord/reset'), onRemoved)}
                >
                  Remove setup
                </Button>
                <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </Button>
              </div>
              <ErrorLine error={remove.error} />
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove Discord setup…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AccountStep({ state: s, onChanged }: { state: DiscordSetupState; onChanged: () => void }) {
  const action = useAction();
  const a = s.account;
  return (
    <div className="stack">
      <p>
        Discord's own page opens in your browser and asks only to see your
        username and avatar (the <code>identify</code> permission). CONDUIT never sees your Discord password.
      </p>
      {a.connected ? (
        <div className="account-cell left">
          {a.avatarDataUrl && <img className="account-avatar" src={a.avatarDataUrl} alt="" width={28} height={28} />}
          <span>
            Connected as <strong>{a.name}</strong>
            {a.handle && a.handle !== a.name && <span className="muted"> @{a.handle}</span>}
          </span>
        </div>
      ) : a.pending ? (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to approve CONDUIT in your browser…
        </p>
      ) : (
        a.problem && (
          <p className="connection-note note-warn" role="status">
            {a.problem}
          </p>
        )
      )}
      <ErrorLine error={action.error} />
      <div className="button-row">
        {a.pending ? (
          <Button
            variant="secondary"
            busy={action.busy}
            onClick={() => void action.run(() => api('POST', '/api/connections/discord/cancel'), onChanged)}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant={a.connected ? 'secondary' : 'primary'}
            busy={action.busy}
            onClick={() => void action.run(() => bridgeCall((b) => b.connections.connect('discord')), onChanged)}
          >
            {a.connected ? 'Sign in again' : a.problem ? 'Try again' : 'Connect Discord account'}
          </Button>
        )}
      </div>
      <p className="muted small">Signing in does not check or start the bot; that's the next step.</p>
    </div>
  );
}

/** Add & Start the Bot: add it to a server, start it, then the verified result (account, bot, server). */
function AddAndStartStep({ state: s, onChanged }: { state: DiscordSetupState; onChanged: () => void }) {
  return (
    <div className="stack">
      <SetupSummary state={s} />
      <section className="substep" aria-labelledby="discord-add-title">
        <h4 id="discord-add-title">
          <span className={`substep-mark${s.installation.status === 'installed' ? ' done' : ''}`}>{s.installation.status === 'installed' ? '✓' : 'a'}</span> Add the bot to your server
        </h4>
        <InstallStep state={s} onChanged={onChanged} />
      </section>
      <section className="substep" aria-labelledby="discord-start-title">
        <h4 id="discord-start-title">
          <span className={`substep-mark${s.bot.status === 'connected' ? ' done' : ''}`}>{s.bot.status === 'connected' ? '✓' : 'b'}</span> Start the bot
        </h4>
        <BotStep state={s} onChanged={onChanged} />
      </section>
    </div>
  );
}

/**
 * The verified result of the setup. Every value comes from what Discord confirmed: the signed-in account (OAuth), the
 * bot's live gateway session and its application, and the servers Discord lists the bot in. Nothing is assumed.
 */
export function SetupSummary({ state: s }: { state: DiscordSetupState }) {
  const done = s.nextStep === 'done';
  const botName = s.bot.username ?? s.application.botUsername;
  const servers = s.installation.status === 'installed' ? s.installation.guilds : [];
  return (
    <div className={`setup-summary${done ? ' setup-done' : ''}`} role="status" aria-label="Setup status">
      <p className="setup-summary-title">{done ? 'Discord is set up.' : 'Not finished yet'}</p>
      <div className="summary-grid">
        <SummaryItem label="User Account" ok={s.account.connected}>
          {s.account.connected && s.account.name ? (
            <span className="account-cell left">
              <EntityIcon src={s.account.avatarDataUrl} name={s.account.name} />
              {s.account.name}
            </span>
          ) : (
            <span className="muted">Not connected</span>
          )}
        </SummaryItem>
        <SummaryItem label="Bot (Application)" ok={s.bot.status === 'connected'}>
          {botName ? (
            <span className="account-cell left">
              <EntityIcon src={s.bot.avatarDataUrl} name={botName} />
              <span>
                {botName}
                {s.application.applicationName && <span className="muted"> ({s.application.applicationName})</span>}
                {s.bot.status !== 'connected' && <span className="text-warn"> · {BOT_LABEL[s.bot.status]}</span>}
              </span>
            </span>
          ) : (
            <span className="muted">Not set up</span>
          )}
        </SummaryItem>
        <SummaryItem label="Server" ok={servers.length > 0}>
          {servers.length > 0 ? (
            <span className="account-cell left">
              <EntityIcon src={servers[0]!.iconDataUrl} name={servers[0]!.name} shape="rounded" />
              <span>
                {servers[0]!.name}
                {servers.length > 1 && <span className="muted"> +{servers.length - 1} more</span>}
              </span>
            </span>
          ) : (
            <span className={s.installation.status === 'unable_to_verify' ? 'text-warn' : 'muted'}>{INSTALL_LABEL[s.installation.status]}</span>
          )}
        </SummaryItem>
      </div>
    </div>
  );
}

function InstallStep({ state: s, onChanged }: { state: DiscordSetupState; onChanged: () => void }) {
  const action = useAction();
  const i = s.installation;
  return (
    <div className="stack">
      <p>Add your bot to the Discord server you stream for. You need the Manage Server permission there.</p>
      <ul className="facts">
        <li>
          Permissions requested ({s.installPermissions}): <strong>{BOT_INSTALL_PERMISSIONS.map((p) => p.name).join(', ')}</strong> —
          what CONDUIT’s features use, and nothing else. CONDUIT never asks for Administrator. A bot added before this keeps its
          old role: add it again with this link, or give its role these permissions under Server Settings → Roles.
        </li>
        <li>
          Gateway intents: {s.intents.map((x) => `${x.name}${x.privileged ? ' (privileged)' : ''}`).join(', ')}.{' '}
          {s.intents.some((x) => x.privileged)
            ? 'The privileged ones are required: turn them on under Bot → Privileged Gateway Intents.'
            : 'None are privileged, so no portal toggles are needed.'}
        </li>
        <li>
          On your application's <em>Installation</em> page, <em>Guild Install</em> must be enabled (the default). <em>Public Bot</em> can be
          turned off on the Bot page, since only you need to add it.
        </li>
      </ul>

      <p className="install-status" role="status">
        Server:{' '}
        <strong className={i.status === 'installed' ? 'text-ok' : i.status === 'unable_to_verify' ? 'text-warn' : ''}>
          {INSTALL_LABEL[i.status]}
        </strong>
        {i.guilds.length > 0 && <span> — {i.guilds.map((g) => g.name).join(', ')}</span>}
        {i.checkedAt && <span className="muted small"> (checked {i.source === 'gateway' ? 'live by the bot' : 'with Discord'})</span>}
      </p>
      {i.pending && (
        <p className="connection-note" role="status">
          <span className="spinner" aria-hidden="true" /> Waiting for you to pick a server in your browser…
        </p>
      )}
      {i.problem && !i.pending && (
        <p className="connection-note note-warn" role="status">
          {i.problem}
        </p>
      )}
      <ErrorLine error={action.error} />
      <div className="button-row">
        {i.pending ? (
          <Button
            variant="secondary"
            busy={action.busy}
            onClick={() => void action.run(() => api('POST', '/api/discord/install/cancel'), onChanged)}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant={i.status === 'installed' ? 'secondary' : 'primary'}
            busy={action.busy}
            onClick={() => void action.run(() => bridgeCall((b) => b.discord.installBot()), onChanged)}
          >
            {i.status === 'installed' ? 'Add to another server' : 'Add bot to server'}
          </Button>
        )}
        <Button
          variant="secondary"
          busy={action.busy}
          onClick={() => void action.run(() => api('POST', '/api/discord/installation/check'), onChanged)}
        >
          Check again
        </Button>
      </div>
      <p className="muted small">
        CONDUIT shows Installed only after Discord confirms the bot is in a server, not just because the page opened.
      </p>
    </div>
  );
}

function BotStep({ state: s, onChanged }: { state: DiscordSetupState; onChanged: () => void }) {
  const action = useAction();
  const b = s.bot;
  return (
    <div className="stack">
      <p>CONDUIT runs your bot while the app is open and checks its connection to Discord.</p>
      <p role="status">
        Bot:{' '}
        <strong className={b.status === 'connected' ? 'text-ok' : b.status === 'error' ? 'text-bad' : ''}>
          {(b.status === 'connecting' || b.status === 'reconnecting') && <span className="spinner" aria-hidden="true" />}
          {BOT_LABEL[b.status]}
        </strong>
        {b.status === 'connected' && b.username && <span> as {b.username}</span>}
      </p>
      {b.problem && (
        <p className={`connection-note ${b.status === 'error' ? 'note-error' : 'note-warn'}`} role="status">
          {b.problem}
        </p>
      )}
      <ErrorLine error={action.error} />
      {b.status !== 'connected' && b.status !== 'connecting' && (
        <div className="button-row">
          <Button busy={action.busy} onClick={() => void action.run(() => api('POST', '/api/discord/bot/restart'), onChanged)}>
            Reconnect
          </Button>
        </div>
      )}
      <CommandsPanel state={s} onChanged={onChanged} />
    </div>
  );
}

/** Slash command registration: its own status, separate from the bot connection. */
export function CommandsPanel({ state: s, onChanged }: { state: DiscordSetupState; onChanged: () => void }) {
  const action = useAction();
  const c = s.commands;
  return (
    <section className="commands-panel" aria-labelledby="discord-commands-title">
      <h3 id="discord-commands-title">Slash commands</h3>
      <p role="status">
        Commands:{' '}
        <strong
          className={c.status === 'registered' ? 'text-ok' : c.status === 'failed' ? 'text-bad' : c.status === 'partial' ? 'text-warn' : ''}
        >
          {c.status === 'registering' && <span className="spinner" aria-hidden="true" />}
          {COMMANDS_LABEL[c.status]}
        </strong>{' '}
        <span className="muted small">({c.names.map((n) => `/${n}`).join(', ')})</span>
      </p>
      <p className="muted small">
        For {c.botUsername ?? 'your bot'}
        {c.applicationId && <> (application {c.applicationId})</>}, registered in each server so they appear right away. The bot can be
        online while its commands are not registered.
      </p>
      {c.guilds.length > 0 && (
        <ul className="facts">
          {c.guilds.map((g) => (
            <li key={g.id}>
              {g.name}:{' '}
              <span className={g.status === 'registered' ? 'text-ok' : g.status === 'failed' ? 'text-bad' : 'muted'}>
                {g.status === 'registered' ? 'Registered' : g.status === 'failed' ? 'Failed' : 'Not registered yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.problem && (
        <p className={`connection-note ${c.status === 'failed' ? 'note-error' : 'note-warn'}`} role="status">
          {c.problem}
        </p>
      )}
      {c.lastAttemptAt && <p className="muted small">Last attempt: {new Date(c.lastAttemptAt).toLocaleString()}</p>}
      <ErrorLine error={action.error} />
      {c.canRegister && (
        <div className="button-row">
          <Button
            variant={c.status === 'registered' ? 'secondary' : 'primary'}
            busy={action.busy}
            onClick={() => void action.run(() => api('POST', '/api/discord/commands/register'), onChanged)}
          >
            {c.status === 'registered' ? 'Register again' : c.status === 'not_registered' ? 'Register commands' : 'Retry'}
          </Button>
        </div>
      )}
    </section>
  );
}
