import { useEffect, useRef, useState } from 'react';
import {
  COMMAND_PERMISSIONS,
  COOLDOWN_DEFAULT_SECONDS,
  COOLDOWN_MAX_SECONDS,
  COOLDOWN_MIN_SECONDS,
  createCommandSchema,
  PERMISSION_HELP,
  renderCommand,
  type CommandPermission,
  type CommandPlatform,
  type CommandsHubState,
  type CooldownMode,
  type CustomCommandView,
  type DefaultCommandView,
} from '@conduit/shared/community/custom-commands';
import { counterOps, VARIABLE_GROUP_LABEL, VARIABLE_GROUPS, VARIABLES, type VariableData } from '@conduit/shared/community/command-variables';
import {
  ACCESS_GROUP_HELP,
  ACCESS_GROUP_RANK,
  DISCORD_ACCESS_GROUPS,
  type CommandAccess,
  type DiscordAccessGroup,
  type DiscordCommandsOverview,
} from '@conduit/shared/discord/discord-commands';
import { api, ApiClientError, errorMessage } from '../../api';
import { BrowserTabs } from '../../components/BrowserTabs';
import { DiscordMarkdown } from '../../components/discord/DiscordMarkdown';
import { Button, ErrorBanner, fieldError, issuesToFieldErrors, Loading } from '../../components/forms';
import { PlatformIcon } from '../../components/PlatformIcon';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 4000;
const PLATFORM_LABEL: Record<CommandPlatform, string> = { discord: 'Discord', kick: 'Kick' };

const OUTCOME_LABEL: Record<NonNullable<CustomCommandView['lastRun']>['outcome'], string> = {
  sent: 'Replied (confirmed)',
  failed: 'Reply failed',
  unconfirmed: 'Reply not confirmed',
  blocked: 'Blocked',
};
const OUTCOME_TONE: Record<NonNullable<CustomCommandView['lastRun']>['outcome'], string> = {
  sent: 'text-ok',
  failed: 'text-bad',
  unconfirmed: 'text-warn',
  blocked: 'muted',
};

/** Commands: one place for Discord and Kick commands — built-in (default) and your own (custom). */
export function CommandsPage() {
  const [platform, setPlatform] = useState<CommandPlatform>('discord');
  return (
    <div className="stack">
      <div className="platform-tabs" role="tablist" aria-label="Platform">
        {(['discord', 'kick'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            id={`commands-tab-${p}`}
            aria-selected={platform === p}
            aria-controls={`commands-panel-${p}`}
            className={`platform-tab${platform === p ? ' active' : ''}`}
            onClick={() => setPlatform(p)}
          >
            <PlatformIcon platform={p} size={16} />
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`commands-panel-${platform}`} aria-labelledby={`commands-tab-${platform}`}>
        {platform === 'discord' ? <DiscordCommands /> : <PlatformCommands key={platform} platform={platform} />}
      </div>
    </div>
  );
}

function PlatformCommands({ platform }: { platform: CommandPlatform }) {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const state = useAsync(() => api<CommandsHubState>('GET', `/api/commands/${platform}`), [running, platform]);
  const { data, error, reload } = state;
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading commands…'} />;
  return <CommandsView s={data} onChanged={reload} />;
}

// ── Discord ───────────────────────────────────────────────────────────────────

/** Loads the Discord commands (with each default command's access and status). */
function DiscordCommands() {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const hub = useAsync(() => api<CommandsHubState>('GET', '/api/commands/discord'), [running]);
  const overview = useAsync(() => api<DiscordCommandsOverview>('GET', '/api/discord/commands'), [running]);
  const error = hub.error ?? overview.error;
  usePolling(
    () => {
      hub.reload();
      overview.reload();
    },
    error ? 2000 : POLL_MS,
    [hub.data, overview.data, error],
  );
  if (!hub.data || !overview.data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading commands…'} />;
  return (
    <CommandsView
      s={hub.data}
      discordDefaults={overview.data}
      onChanged={() => {
        hub.reload();
        overview.reload();
      }}
    />
  );
}

const groupLabel = (g: DiscordAccessGroup) => ACCESS_GROUP_HELP[g].label;

/** One default command row, the same on both tabs: on / off | Command | Access | Message. */
interface DefaultRow {
  trigger: string;
  access: string;
  /** What the command does: shown when hovering over it. */
  description: string;
  /** What it answers, with {variables} where the details go; null when it doesn't reply. */
  message: string | null;
  /** A filled-in example of using it, under the message. */
  example: string | null;
  enabled: boolean;
  /** False for built-ins that can't be switched off (e.g. !enter): their switch stays on. */
  canToggle: boolean;
  /** On, but not answering right now, and why (e.g. Loyalty & Rewards is off). */
  note: string | null;
}

/** The default commands table (Kick and Discord look exactly alike); each row starts with its on / off switch. */
function DefaultCommandsTable({
  rows,
  busy,
  onToggle,
  accessCell,
}: {
  rows: readonly DefaultRow[];
  busy: boolean;
  onToggle: (r: DefaultRow, on: boolean) => void;
  /** Edit mode: a menu instead of the plain Access text. */
  accessCell?: (r: DefaultRow) => React.ReactNode;
}) {
  return (
    <table className="table commands-table">
      <thead>
        <tr>
          <th scope="col">
            <span className="visually-hidden">On / off</span>
          </th>
          <th scope="col">Command</th>
          <th scope="col">Access</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.trigger}>
            <td className="cell-toggle">
              <label className="switch switch-onoff" title={r.canToggle ? undefined : 'Always on'}>
                <input
                  type="checkbox"
                  aria-label={`${r.trigger} ${r.enabled ? 'on' : 'off'}`}
                  checked={r.enabled}
                  disabled={busy || !r.canToggle}
                  onChange={(e) => onToggle(r, e.target.checked)}
                />
              </label>
            </td>
            <td>
              <code title={r.description}>{r.trigger}</code>
            </td>
            <td className="small">{accessCell ? accessCell(r) : r.access}</td>
            <td className="cell-wrap">
              {r.message ? <MessageTemplate text={r.message} /> : <span className="muted">No reply in chat</span>}
              {r.example && (
                <div className="muted small command-example">
                  Example: <code>{r.example}</code>
                </div>
              )}
              {r.note && <div className="field-hint">{r.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A reply as it reads in chat, with each {variable} marked where the details go. */
function MessageTemplate({ text }: { text: string }) {
  const parts = text.split(/(\{[a-z_.]+\})/i);
  return (
    <span className="command-message">
      {parts.map((p, i) => (/^\{[a-z_.]+\}$/i.test(p) ? <code key={i} className="command-var">{p}</code> : p))}
    </span>
  );
}

/** Discord's default commands as table rows (a note when one is on but its feature is off). */
function discordRows(o: DiscordCommandsOverview): DefaultRow[] {
  return o.commands.map((c) => ({
    trigger: `/${c.name}`,
    access: groupLabel(c.group),
    description: c.description,
    message: c.message,
    example: c.example,
    enabled: c.enabled,
    canToggle: true,
    note: c.enabled && !c.active ? c.inactiveReason : null,
  }));
}

/** Kick's (and the hub's) default commands as table rows. */
function defaultRows(platform: CommandPlatform, defaults: readonly DefaultCommandView[]): DefaultRow[] {
  return defaults.map((d) => ({
    trigger: d.trigger,
    access: PERMISSION_HELP[platform][d.permission].label,
    description: d.description,
    message: d.message,
    example: d.example,
    enabled: d.enabled,
    canToggle: d.canDisable,
    note: d.enabled ? d.inactiveReason : null,
  }));
}

/**
 * Turning default commands on or off (and, on Discord, who may use them), saved straight away. The backend enforces
 * them on every use (Discord: a command switched off is removed from Discord). The switch moves at once; the page then
 * reloads what was saved.
 */
function useDefaultsSaving(s: CommandsHubState, discordDefaults: DiscordCommandsOverview | undefined, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => setPending({}), [s, discordDefaults]);

  async function save(request: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await request();
      onChanged?.();
    } catch (err) {
      setError(err);
      setPending({});
    } finally {
      setBusy(false);
    }
  }

  function discordAccess(o: DiscordCommandsOverview, patch: { name: string; group?: DiscordAccessGroup; enabled?: boolean }): CommandAccess {
    return {
      groups: Object.fromEntries(o.commands.map((x) => [x.name, x.name === patch.name && patch.group ? patch.group : x.group])),
      disabled: o.commands.filter((x) => !(x.name === patch.name && patch.enabled !== undefined ? patch.enabled : (pending[`/${x.name}`] ?? x.enabled))).map((x) => x.name),
    };
  }

  function toggle(r: DefaultRow, on: boolean) {
    setPending((p) => ({ ...p, [r.trigger]: on }));
    if (discordDefaults) {
      const next = discordAccess(discordDefaults, { name: r.trigger.slice(1), enabled: on });
      return void save(() => api('POST', '/api/discord/command-access', next));
    }
    const disabled = s.defaults.filter((d) => d.canDisable && !(d.trigger === r.trigger ? on : (pending[d.trigger] ?? d.enabled))).map((d) => d.trigger);
    void save(() => api('POST', '/api/kick/default-commands', { disabled }));
  }

  function setGroup(name: string, group: DiscordAccessGroup) {
    if (discordDefaults) void save(() => api('POST', '/api/discord/command-access', discordAccess(discordDefaults, { name, group })));
  }

  return { busy, error, pending, toggle, setGroup };
}

export function CommandsView({
  s,
  onChanged,
  discordDefaults,
  initialEditingAccess = false,
  initialSection = 'defaults',
}: {
  s: CommandsHubState;
  onChanged?: () => void;
  discordDefaults?: DiscordCommandsOverview;
  initialEditingAccess?: boolean;
  initialSection?: 'defaults' | 'custom';
}) {
  const name = PLATFORM_LABEL[s.platform];
  const [editingAccess, setEditingAccess] = useState(initialEditingAccess);
  const [section, setSection] = useState<'defaults' | 'custom'>(initialSection);
  const saving = useDefaultsSaving(s, discordDefaults, onChanged);
  const rows: DefaultRow[] = (discordDefaults ? discordRows(discordDefaults) : defaultRows(s.platform, s.defaults)).map((r) => ({
    ...r,
    enabled: saving.pending[r.trigger] ?? r.enabled,
  }));
  const byTrigger = new Map(discordDefaults?.commands.map((c) => [`/${c.name}`, c]));
  return (
    <div className="stack">
      {/* Default Commands and Custom Commands: browser-style tabs on one card (both stay rendered, so switching keeps an
          unsaved command editor as it was). */}
      <BrowserTabs
        idPrefix="commands"
        scope={s.platform}
        label={`${name} commands`}
        tabs={[
          { id: 'defaults', label: 'Default Commands', count: discordDefaults ? discordDefaults.commands.length : s.defaults.length },
          { id: 'custom', label: 'Custom Commands', count: s.custom.length },
        ]}
        active={section}
        onChange={setSection}
        panels={{
          defaults: (
            <>
        {discordDefaults && (
          <div className="commands-actions">
            <Button variant="ghost" onClick={() => setEditingAccess((e) => !e)}>
              {editingAccess ? 'Done' : 'Edit access'}
            </Button>
          </div>
        )}
        {rows.length === 0 ? (
          <p className="muted">No built-in {name} commands yet.</p>
        ) : (
          <DefaultCommandsTable
            rows={rows}
            busy={saving.busy}
            onToggle={saving.toggle}
            accessCell={
              discordDefaults && editingAccess
                ? (r) => {
                    const c = byTrigger.get(r.trigger)!;
                    return (
                      <select aria-label={`Access for ${r.trigger}`} value={c.group} disabled={saving.busy} onChange={(e) => saving.setGroup(c.name, e.target.value as DiscordAccessGroup)}>
                        {DISCORD_ACCESS_GROUPS.filter((g) => ACCESS_GROUP_RANK[g] >= ACCESS_GROUP_RANK[c.minimumGroup]).map((g) => (
                          <option key={g} value={g}>
                            {groupLabel(g)}
                          </option>
                        ))}
                      </select>
                    );
                  }
                : undefined
            }
          />
        )}
        <ErrorBanner error={saving.error} />
        {(!discordDefaults || editingAccess) && (
          <p className="muted small">
            {discordDefaults
              ? `Admin: ${ACCESS_GROUP_HELP.admin.who.toLowerCase()}. Moderator: ${ACCESS_GROUP_HELP.moderator.who.toLowerCase()}. Anyone: everyone. Moderation commands also need their Discord permission.`
              : 'Built into CONDUIT; a command switched off is ignored in chat. A custom command with the same trigger answers instead of the default. Moderator commands act with your main Kick account.'}
          </p>
        )}
            </>
          ),
          custom: <CustomCommandsPanel s={s} onChanged={onChanged} />,
        }}
      />

      {s.recent.length > 0 && (
        <section className="card" aria-labelledby={`recent-${s.platform}`}>
          <h2 id={`recent-${s.platform}`}>Recent runs</h2>
          <ul className="facts">
            {s.recent.slice(0, 10).map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <code>{r.trigger}</code> — <span className={OUTCOME_TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</span>{' '}
                <span className="muted small">{new Date(r.at).toLocaleTimeString()}</span>
                {r.outcome !== 'sent' && r.detail && <span className="muted small"> · {r.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CustomCommandsPanel({ s, onChanged }: { s: CommandsHubState; onChanged?: () => void }) {
  const [editing, setEditing] = useState<CustomCommandView | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/commands/${s.platform}`;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      onChanged?.();
    }
  }

  return (
    <>
      {editing === null && (
        <div className="commands-actions">
          <Button onClick={() => setEditing('new')}>New command</Button>
        </div>
      )}

      {editing !== null && (
        <CommandEditor
          platform={s.platform}
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged?.();
          }}
        />
      )}

      {s.custom.length === 0 ? (
        editing === null && (
          <div className="empty-state">
            <p>No custom {PLATFORM_LABEL[s.platform]} commands yet.</p>
            <p className="muted small">
              {s.platform === 'kick'
                ? 'For example !discord → “Join our Discord community, {user}!”.'
                : 'For example /discord → “Join our Discord community, {user}!”.'}
            </p>
          </div>
        )
      ) : (
        <div className="table-scroll">
          <table className="table commands-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">On / off</span>
                </th>
                <th scope="col">Command</th>
                <th scope="col">Access</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.custom.map((c) => (
                <tr key={c.id}>
                  <td className="cell-toggle">
                    {/* On (green) / off (red): enables or disables the command straight away. */}
                    <label className="switch switch-onoff">
                      <input
                        type="checkbox"
                        aria-label={`${c.trigger} ${c.enabled ? 'on' : 'off'}`}
                        checked={c.enabled}
                        disabled={busy}
                        onChange={(e) => void run(() => api('PATCH', `${base}/${c.id}`, { enabled: e.target.checked }))}
                      />
                    </label>
                  </td>
                  <td>
                    <code>{c.trigger}</code>
                  </td>
                  <td className="small">{c.access}</td>
                  <td className="cell-wrap">
                    {/* Discord: its description; Kick commands have none, so the reply is shown. */}
                    {c.description ?? c.response}
                    {c.unknownVariables.length > 0 && (
                      <div className="field-hint text-warn">
                        {c.unknownVariables.join(', ')} isn’t a variable for {PLATFORM_LABEL[s.platform]} commands; it’s posted as written. See
                        Variables in the editor.
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${!c.valid ? 'pill-bad' : c.enabled ? 'pill-ok' : 'pill-muted'}`} title={c.problem ?? undefined}>
                      {!c.valid ? 'Invalid' : c.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="actions">
                    {confirmDelete === c.id ? (
                      <span className="row-actions">
                        <span className="small">Delete {c.trigger}?</span>
                        <Button
                          variant="danger"
                          className="btn-row"
                          busy={busy}
                          onClick={() =>
                            void run(async () => {
                              await api('DELETE', `${base}/${c.id}`);
                              setConfirmDelete(null);
                            })
                          }
                        >
                          Delete
                        </Button>
                        <Button variant="secondary" className="btn-row" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <span className="row-actions">
                        <Button variant="secondary" className="btn-row" onClick={() => setEditing(c)}>
                          Edit
                        </Button>
                        <Button variant="secondary" className="btn-row btn-row-delete" onClick={() => setConfirmDelete(c.id)}>
                          Delete
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <p className="connection-note note-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Field errors from the shared schema (the same rules the backend applies). */
export function checkCommandForm(
  platform: CommandPlatform,
  f: {
    trigger: string;
    response: string;
    description?: string;
    permission?: CommandPermission;
    cooldownMode?: CooldownMode;
    cooldownSeconds?: number;
  },
): Record<string, string> {
  const parsed = createCommandSchema(platform).safeParse({
    trigger: f.trigger,
    response: f.response,
    ...(platform === 'discord' ? { description: f.description ?? '' } : {}),
    ...(f.permission ? { permission: f.permission } : {}),
    ...(f.cooldownMode ? { cooldownMode: f.cooldownMode } : {}),
    ...(f.cooldownSeconds !== undefined ? { cooldownSeconds: f.cooldownSeconds } : {}),
  });
  return parsed.success ? {} : issuesToFieldErrors(parsed.error.issues);
}

/** Example values for the editor preview — clearly labelled as examples, never used for real replies. */
export const PREVIEW_VALUES: Record<CommandPlatform, { user: string; channel: string; args: string }> = {
  kick: { user: 'ExampleViewer', channel: 'yourchannel', args: 'hi there' },
  discord: { user: 'exampleviewer', channel: 'general', args: 'hi there' },
};

/** Sample data for every variable in the preview (fixed, so the preview doesn't change while typing). */
export function previewData(platform: CommandPlatform, template: string, name: string): VariableData {
  const ex = PREVIEW_VALUES[platform];
  const counters: Record<string, number> = {};
  for (const op of counterOps(template)) counters[op.name] = op.op === 'set' ? op.amount : (counters[op.name] ?? 7) + op.amount;
  return {
    user: ex.user,
    userId: platform === 'kick' ? '12345678' : '123456789012345678',
    channel: ex.channel,
    args: ex.args,
    message: `${name} ${ex.args}`,
    stream: { streamer: 'YourChannel', url: 'https://kick.com/yourchannel', live: true, title: 'Example stream title', category: 'Example category', viewers: 128, startedAt: new Date(Date.now() - (2 * 60 + 15) * 60_000).toISOString() },
    commands: platform === 'kick' ? ['!enter', name] : ['/ping', name],
    count: 42,
    counters,
    randomUser: 'SomeViewer',
    roles: ['Moderator', 'Subscriber'],
    subMonths: 6,
    mention: '@exampleviewer',
    server: 'Example Server',
    memberCount: 250,
    loyalty: { points: '1,200 points', level: 5, xp: 860, rank: 3 },
    random: () => 0.42,
  };
}

export function CommandEditor({
  platform,
  initial,
  onCancel,
  onSaved,
}: {
  platform: CommandPlatform;
  initial: CustomCommandView | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [trigger, setTrigger] = useState(initial?.trigger ?? (platform === 'kick' ? '!' : '/'));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [response, setResponse] = useState(initial?.response ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [permission, setPermission] = useState<CommandPermission>(initial?.permission ?? 'everyone');
  const [cooldownMode, setCooldownMode] = useState<CooldownMode>(initial?.cooldownMode ?? 'none');
  const [cooldownSeconds, setCooldownSeconds] = useState<string>(String(initial?.cooldownSeconds || COOLDOWN_DEFAULT_SECONDS));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const responseRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const err = (field: string) => fieldError(field, errors, serverError);
  const base = `/api/commands/${platform}`;

  /** Inserts a variable at the cursor (or the end) of the response field. */
  function insert(token: string) {
    const el = responseRef.current;
    const start = el?.selectionStart ?? response.length;
    const end = el?.selectionEnd ?? response.length;
    const next = response.slice(0, start) + token + response.slice(end);
    setResponse(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    const seconds = cooldownMode === 'none' ? 0 : Number(cooldownSeconds);
    const found = checkCommandForm(platform, { trigger, response, description, permission, cooldownMode, cooldownSeconds: seconds });
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    const body = {
      trigger,
      response,
      enabled,
      permission,
      cooldownMode,
      cooldownSeconds: seconds,
      ...(platform === 'discord' ? { description } : {}),
    };
    try {
      if (initial) await api('PATCH', `${base}/${initial.id}`, body);
      else await api('POST', base, body);
      onSaved();
    } catch (e) {
      setServerError(e);
    } finally {
      setSaving(false);
    }
  }

  const ex = PREVIEW_VALUES[platform];
  const name = trigger.trim() || (platform === 'kick' ? '!command' : '/command');
  const preview = response.trim() ? renderCommand(response, previewData(platform, response, name), platform) : '';

  return (
    <form
      className="command-editor"
      aria-label={initial ? `Edit ${initial.trigger}` : 'New command'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="command-trigger">{platform === 'kick' ? 'Trigger' : 'Command name'}</label>
          <input
            id="command-trigger"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={33}
            aria-invalid={err('trigger') ? true : undefined}
            aria-describedby="command-trigger-note"
          />
          <span id="command-trigger-note" className={err('trigger') ? 'field-error' : 'field-hint'}>
            {err('trigger') ??
              (platform === 'kick'
                ? 'For example !discord. Letters, numbers, - and _; upper/lower case doesn’t matter.'
                : 'For example /discord (people type / in Discord and pick it). Lower-case letters, numbers, - and _.')}
          </span>
        </div>
        {platform === 'discord' && (
          <div className="field">
            <label htmlFor="command-description">Description</label>
            <input
              id="command-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={100}
              aria-invalid={err('description') ? true : undefined}
              aria-describedby="command-description-note"
            />
            <span id="command-description-note" className={err('description') ? 'field-error' : 'field-hint'}>
              {err('description') ?? 'Shown in Discord’s command list (required by Discord).'}
            </span>
          </div>
        )}
        <div className="field">
          <label htmlFor="command-response">Response</label>
          {platform === 'kick' ? (
            <input
              id="command-response"
              ref={responseRef}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              autoComplete="off"
              maxLength={500}
              aria-invalid={err('response') ? true : undefined}
              aria-describedby="command-response-note"
            />
          ) : (
            <textarea
              id="command-response"
              ref={responseRef}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              rows={4}
              maxLength={2000}
              aria-invalid={err('response') ? true : undefined}
              aria-describedby="command-response-note"
            />
          )}
          <span id="command-response-note" className={err('response') ? 'field-error' : 'field-hint'}>
            {err('response') ??
              (platform === 'kick'
                ? 'Plain text, up to 500 characters, with variables from the panel.'
                : 'Up to 2000 characters, with variables from the panel. Discord markdown works: **bold**, *italic*, __underline__, ~~strikethrough~~, ||spoiler||, `code`, [links](https://…), and on their own lines # headings, -# small text, > quotes, - lists and ``` code blocks.')}
          </span>
        </div>
        {preview &&
          (platform === 'kick' ? (
            <p className="small">
              <span className="muted">Preview with example values (</span>
              <span className="muted">
                user “{ex.user}”, channel “{ex.channel}”, text “{ex.args}”):
              </span>{' '}
              <span className="command-preview">{preview}</span>
            </p>
          ) : (
            <div className="small">
              <span className="muted">
                Preview with example values (user “{ex.user}”, channel “{ex.channel}”, text “{ex.args}”):
              </span>
              <div className="command-preview md-preview">
                <DiscordMarkdown text={preview} />
              </div>
            </div>
          ))}
        <fieldset className="choice-list access-section">
          <legend>Permissions</legend>
          {COMMAND_PERMISSIONS.map((p) => {
            const help = PERMISSION_HELP[platform][p];
            return (
              <label key={p} className={help.available ? undefined : 'muted'}>
                <input
                  type="radio"
                  name="command-permission"
                  value={p}
                  checked={permission === p}
                  disabled={!help.available}
                  onChange={() => setPermission(p)}
                />{' '}
                {help.label}
                <span className="muted small"> — {help.who}</span>
              </label>
            );
          })}
          {err('permission') && <span className="field-error">{err('permission')}</span>}
        </fieldset>

        <fieldset className="choice-list access-section">
          <legend>Cooldown</legend>
          <div className="cooldown-row">
            <label htmlFor="command-cooldown-mode" className="visually-hidden">
              Cooldown type
            </label>
            <select id="command-cooldown-mode" value={cooldownMode} onChange={(e) => setCooldownMode(e.target.value as CooldownMode)}>
              <option value="none">No cooldown</option>
              <option value="user">Per user — each person waits between uses</option>
              <option value="global">Global — everyone waits after anyone uses it</option>
            </select>
            {cooldownMode !== 'none' && (
              <>
                <label htmlFor="command-cooldown-seconds" className="visually-hidden">
                  Cooldown in seconds
                </label>
                <input
                  id="command-cooldown-seconds"
                  type="number"
                  inputMode="numeric"
                  min={COOLDOWN_MIN_SECONDS}
                  max={COOLDOWN_MAX_SECONDS}
                  step={1}
                  value={cooldownSeconds}
                  onChange={(e) => setCooldownSeconds(e.target.value)}
                  aria-invalid={err('cooldownSeconds') ? true : undefined}
                  aria-describedby="command-cooldown-note"
                />
                <span>seconds</span>
              </>
            )}
          </div>
          <span id="command-cooldown-note" className={err('cooldownSeconds') ? 'field-error' : 'field-hint'}>
            {err('cooldownSeconds') ??
              (cooldownMode === 'none'
                ? 'The command can be used again right away.'
                : `${COOLDOWN_MIN_SECONDS}–${COOLDOWN_MAX_SECONDS} seconds. Blocked uses get no reply in chat${platform === 'discord' ? ' (Discord shows the user a private note)' : ''}; cooldowns reset when CONDUIT restarts.`)}
          </span>
        </fieldset>

        <label className="hello-toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        {serverError && !(serverError instanceof ApiClientError && serverError.issues.length > 0) ? (
          <p className="connection-note note-error" role="alert">
            {errorMessage(serverError)}
          </p>
        ) : null}
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving || undefined}>
            {saving ? 'Saving…' : initial ? 'Save changes' : 'Create command'}
          </button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>

      <aside className="variables-help" aria-labelledby="variables-title">
        <h3 id="variables-title">Variables</h3>
        <p className="muted small">
          Click one to insert it. It’s replaced with the real value when the command is used. Add <code>|text</code> for a fallback
          when there’s no value, e.g. <code>{'{touser|everyone}'}</code>.
        </p>
        {VARIABLE_GROUPS.map((group) => {
          const list = VARIABLES.filter((v) => v.group === group && v.platforms.includes(platform));
          if (list.length === 0) return null;
          return (
            <details key={group} className="variable-group" open={group === 'input'}>
              <summary>{VARIABLE_GROUP_LABEL[group]}</summary>
              <ul>
                {list.map((v) => (
                  <li key={v.name}>
                    <button type="button" className="variable-chip" onClick={() => insert(v.insert)} aria-label={`Insert ${v.insert}`}>
                      {v.insert}
                    </button>
                    <span className="small"> {v.description}</span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
        <h4>Examples</h4>
        <ul className="muted small">
          {platform === 'kick' ? (
            <>
              <li>
                <code>
                  Hello {'{user}'}, welcome to {'{channel}'}!
                </code>
              </li>
              <li>
                <code>!so</code> →{' '}
                <code>
                  Go follow {'{args}'} at kick.com/{'{args}'}
                </code>
              </li>
            </>
          ) : (
            <>
              <li>
                <code>
                  Hello {'{user}'}, welcome to #{'{channel}'}!
                </code>
              </li>
              <li>
                <code>/say</code> →{' '}
                <code>
                  {'{user}'} says: {'{args}'}
                </code>{' '}
                (adds a “text” box to the command)
              </li>
            </>
          )}
        </ul>
        <p className="muted small">
          If nothing is given, {'{args}'} is empty. Only these variables work; anything else in braces is rejected. More examples:{' '}
          <code>{'{user} rolled {random:1-6}'}</code>, <code>{'Deaths: {counter:deaths+1}'}</code>, <code>{'{touser} is {pick:cool;awesome;legendary}'}</code>.
        </p>
      </aside>
    </form>
  );
}
