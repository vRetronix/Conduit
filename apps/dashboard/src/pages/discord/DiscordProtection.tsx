/**
 * Discord Bot → Protection, all CONDUIT's own, running while CONDUIT is open:
 *
 * 1. AutoMod — CONDUIT's own rules (custom words, mention spam, member names). Discord's built-in AutoMod isn't used.
 * 2. CONDUIT protection — CONDUIT's own checks on the bot's message events, acting through Discord's REST API (delete,
 *    time out). Only while CONDUIT runs; off by default and every check starts on "Log only".
 * 3. CONDUIT protection — anti-nuke on the audit log, with its quarantine list. Off by default; starts on "Alert only".
 * 4. CONDUIT protection — anti-raid (join bursts, lockdown) and the join gate. Off by default.
 * 5. CONDUIT protection — bot bait: trap channels. Off by default; "Alert only" until an action is chosen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  BOTBAIT_ACTION_LABEL,
  BOTBAIT_ACTIONS,
  botbaitSchema,
  botbaitWarning,
  type BotbaitAction,
  type BotbaitSettings,
  ANTIRAID_PRESETS,
  antiraidSchema,
  applyAntiraidPreset,
  JOIN_GATE_RESPONSE_LABEL,
  JOIN_GATE_RESPONSES,
  LOCKDOWN_VERIFICATION_LEVELS,
  matchingAntiraidPreset,
  VERIFICATION_LEVEL_LABEL,
  ANTINUKE_MODE_LABEL,
  ANTINUKE_MODES,
  ANTINUKE_PRESET_LABEL,
  ANTINUKE_PRESETS,
  ANTINUKE_RESPONSE_LABEL,
  ANTINUKE_RESPONSES,
  ANTINUKE_RULE_LABEL,
  ANTINUKE_RULES,
  antinukePreset,
  antinukeSchema,
  matchingAntinukePreset,
  AUTOMOD_ACTIONS_ALLOWED,
  AUTOMOD_RULES_MAX,
  AUTOMOD_TRIGGER_HELP,
  AUTOMOD_TRIGGER_LABEL,
  AUTOMOD_TRIGGERS,
  automodActionLabel,
  automodRuleSchema,
  MESSAGE_CHECK_LABEL,
  messageChecksSchema,
  PROTECTION_ACTION_LABEL,
  PROTECTION_ACTIONS,
  type AntiraidSettings,
  type JoinGateResponse,
  type AntinukeMode,
  type AntinukeResponse,
  type AntinukeRule,
  type AntinukeSettings,
  type AutomodRuleInput,
  type AutomodTrigger,
  type DiscordAutomodGuild,
  type DiscordAutomodAction,
  type DiscordAutomodRule,
  type DiscordProtectionState,
  type MessageCheck,
  type MessageChecks,
  type ProtectionAction,
  type QuarantineView,
} from '@conduit/shared/discord/discord-protection';
import { api, errorMessage } from '../../api';
import { Button, ErrorBanner, Field, schemaFieldErrors as problems } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

/** Loads the protection state (polled slowly, for the lockdown and quarantine lists). */
export function DiscordProtectionSections() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<DiscordProtectionState>('GET', '/api/discord/protection'), [backend?.state === 'running']);
  usePolling(reload, error ? 3000 : 30_000, [data, error]);
  if (!data) return <p className="muted">{error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading protection…'}</p>;
  return <DiscordProtectionView s={data} onChanged={reload} />;
}

type Feature = 'automod' | 'messages' | 'antinuke' | 'antiraid' | 'botbait';
const OPEN_KEY = 'conduit.protectionOpen';
const FEATURES: readonly Feature[] = ['automod', 'messages', 'antinuke', 'antiraid', 'botbait'];

function readOpen(): Feature | null {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return FEATURES.includes(v as Feature) ? (v as Feature) : null;
  } catch {
    return null;
  }
}

/**
 * Protection as one compact list: each feature in a row with what it does, its status and an on/off switch. Its settings
 * open below the row (one at a time). Lockdowns and quarantines in effect show above the list.
 */
export function DiscordProtectionView({ s, onChanged, initialOpen }: { s: DiscordProtectionState; onChanged?: () => void; initialOpen?: Feature | null }) {
  const [open, setOpen] = useState<Feature | null>(initialOpen === undefined ? null : initialOpen);
  useEffect(() => {
    if (initialOpen === undefined) setOpen(readOpen());
  }, [initialOpen]);
  const toggleOpen = (f: Feature) => {
    const next = open === f ? null : f;
    setOpen(next);
    try {
      if (next) localStorage.setItem(OPEN_KEY, next);
      else localStorage.removeItem(OPEN_KEY);
    } catch {
      // not remembered
    }
  };
  const { busy, error, run } = useAction(onChanged);
  const status = protectionStatus(s);
  const switchTo = (f: Feature, on: boolean) =>
    void run(() => {
      if (f === 'messages') return api('POST', '/api/discord/protection/messages', { ...s.messageChecks, enabled: on });
      if (f === 'antinuke') return api('POST', '/api/discord/protection/antinuke', { ...s.antinuke, enabled: on });
      if (f === 'antiraid') return api('POST', '/api/discord/protection/antiraid', { ...s.antiraid, enabled: on });
      return api('POST', '/api/discord/protection/botbait', { ...s.botbait, enabled: on });
    });
  const rows: Array<{ f: Feature; title: string; what: string; on: boolean | null; panel: ReactNode }> = [
    {
      f: 'automod',
      title: 'AutoMod',
      what: 'Your own rules for words, mention spam and member names.',
      on: null,
      panel: <DiscordAutomodSection s={s} onChanged={onChanged} />,
    },
    {
      f: 'messages',
      title: 'Message checks',
      what: 'Repeated messages, flooding, caps and invite links.',
      on: s.messageChecks.enabled,
      panel: <MessageChecksSection key={JSON.stringify(s.messageChecks)} s={s} onSaved={onChanged} />,
    },
    {
      f: 'antinuke',
      title: 'Anti-nuke',
      what: 'Stops mass deleting, banning and rogue bots.',
      on: s.antinuke.enabled,
      panel: <AntiNukeSection key={JSON.stringify(s.antinuke)} s={s} onSaved={onChanged} />,
    },
    {
      f: 'antiraid',
      title: 'Anti-raid',
      what: 'Spots join bursts, can lock the server down, and checks new accounts (join gate).',
      on: s.antiraid.enabled,
      panel: <AntiRaidSection key={JSON.stringify(s.antiraid)} s={s} onSaved={onChanged} />,
    },
    {
      f: 'botbait',
      title: 'Bot bait',
      what: 'Trap channels: anyone who posts there is treated as a spam bot.',
      on: s.botbait.enabled,
      panel: <BotBaitSection key={JSON.stringify(s.botbait)} s={s} onSaved={onChanged} />,
    },
  ];
  return (
    <>
      <LockdownSection s={s} onChanged={onChanged} />
      <QuarantineSection s={s} onChanged={onChanged} />
      <section className="card" aria-labelledby="protection-overview">
        <h2 id="protection-overview">Protection</h2>
        <p className="muted small">Everything runs while CONDUIT is open. All activity is in the Logs tab.</p>
        <ErrorBanner error={error} />
        <ul className="protection-list">
          {rows.map((r) => (
            <li key={r.f} className={`protection-row${open === r.f ? ' is-open' : ''}`}>
              <div className="protection-row-head">
                <span className="protection-switch">
                  {r.on !== null && (
                    <label className="switch switch-onoff">
                      <input type="checkbox" aria-label={`${r.title} ${r.on ? 'on' : 'off'}`} checked={r.on} disabled={busy} onChange={(e) => switchTo(r.f, e.target.checked)} />
                    </label>
                  )}
                </span>
                <div className="protection-row-text">
                  <strong>{r.title}</strong>
                  <span className="muted small">{r.what}</span>
                </div>
                <span className={`pill ${status[r.f].pill}`}>{status[r.f].label}</span>
                <Button variant="secondary" className="btn-row" aria-expanded={open === r.f} onClick={() => toggleOpen(r.f)}>
                  {open === r.f ? 'Close' : r.f === 'automod' ? 'Manage' : 'Configure'}
                </Button>
              </div>
              {open === r.f && r.panel}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const BOTBAIT_SHORT: Record<BotbaitAction, string> = { alert: 'alert', delete: 'delete', timeout: 'time out', kick: 'kick', softban: 'softban', ban: 'ban' };

const GATE_WORD: Record<JoinGateResponse, string> = { alert: 'alerts', hold: 'holds', kick: 'kicks' };

/** Anti-raid's status: a lockdown in effect first, then join bursts and the join gate ("Enforcing · gate kicks"). */
function antiraidStatus(s: DiscordProtectionState, off: { label: string; pill: string }): { label: string; pill: string } {
  if (s.lockdowns.length) return { label: 'Locked down', pill: 'pill-bad' };
  const a = s.antiraid;
  if (!a.enabled && !a.gate.enabled) return off;
  const bursts = a.enabled ? (a.mode === 'enforce' ? 'Enforcing' : 'Alert only') : null;
  const gate = a.gate.enabled ? GATE_WORD[a.gate.response] : null;
  const label = bursts && gate ? `${bursts} · gate ${gate}` : (bursts ?? `Join gate ${gate}`);
  const acting = (a.enabled && a.mode === 'enforce') || (a.gate.enabled && a.gate.response !== 'alert');
  return { label, pill: acting ? 'pill-ok' : 'pill-warn' };
}

/** One short status per feature for the overview. */
export function protectionStatus(s: DiscordProtectionState): Record<Feature, { label: string; pill: string }> {
  const off = { label: 'Off', pill: 'pill-muted' };
  const rules = s.automod.guilds.flatMap((g) => g.rules);
  const on = rules.filter((r) => r.enabled).length;
  const automod =
    s.automod.guilds.length === 0
      ? { label: 'No server', pill: 'pill-muted' }
      : { label: rules.length === 0 ? 'No rules' : `${on} of ${rules.length} rule${rules.length === 1 ? '' : 's'} on`, pill: on ? 'pill-ok' : 'pill-muted' };
  const m = s.messageChecks;
  const acting = (['repeat', 'flood', 'caps', 'invites'] as const).some((c) => m[c].enabled && m[c].action !== 'log');
  const mode = (enabled: boolean, enforce: boolean, enforceLabel: string) => (!enabled ? off : enforce ? { label: enforceLabel, pill: 'pill-ok' } : { label: 'Alert only', pill: 'pill-warn' });
  const shortResponse: Record<AntinukeResponse, string> = { quarantine: 'quarantine', timeout: 'time out', kick: 'kick', ban: 'ban' };
  return {
    automod,
    messages: !m.enabled ? off : acting ? { label: 'On', pill: 'pill-ok' } : { label: 'Log only', pill: 'pill-warn' },
    antinuke: mode(s.antinuke.enabled, s.antinuke.mode === 'enforce', `Enforcing: ${shortResponse[s.antinuke.response]}`),
    antiraid: antiraidStatus(s, off),
    botbait: !s.botbait.enabled
      ? off
      : s.botbait.channels.length === 0
        ? { label: 'No channels', pill: 'pill-warn' }
        : s.botbait.action === 'alert'
          ? { label: 'Alert only', pill: 'pill-warn' }
          : { label: `Enforcing: ${BOTBAIT_SHORT[s.botbait.action]}`, pill: 'pill-ok' },
  };
}

function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone?.();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}


// ── 1. AutoMod (CONDUIT's own rules) ─────────────────────────────────────────

function DiscordAutomodSection({ s, onChanged }: { s: DiscordProtectionState; onChanged?: () => void }) {
  const guilds = s.automod.guilds;
  return (
    <div className="protection-panel">
      <p className="muted small">
        CONDUIT’s own rules, checked while CONDUIT is open. Bot needs: Manage Messages to delete, Timeout Members or Kick Members to punish. Discord’s
        built-in AutoMod isn’t changed.
      </p>
      {!s.messageContent && (
        <p className="small text-warn">Custom words need the Message Content intent (Developer Portal → Bot). Mention spam and member names work without it.</p>
      )}
      {s.automod.problem && <p className="small text-warn">{s.automod.problem}</p>}
      {guilds.length === 0 && !s.automod.problem && <p className="empty-note">The bot isn’t in a server yet.</p>}
      {guilds.map((g) => (
        <AutomodGuild key={g.id} g={g} showName={guilds.length > 1} onChanged={onChanged} />
      ))}
    </div>
  );
}

const ACTION_SUMMARY = (r: DiscordAutomodRule, g: DiscordAutomodGuild): string => {
  const parts = [r.action === 'timeout' ? `${automodActionLabel(r.trigger, r.action)} ${formatMinutes(r.timeoutMinutes)}` : automodActionLabel(r.trigger, r.action)];
  if (r.alertChannelId) {
    const ch = g.channels.find((c) => c.id === r.alertChannelId);
    parts.push(ch ? `Alert #${ch.name}` : 'Alert: unknown channel');
  }
  return parts.join(' · ');
};

function formatMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} d`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

function AutomodGuild({ g, showName, onChanged }: { g: DiscordAutomodGuild; showName: boolean; onChanged?: () => void }) {
  const [editing, setEditing] = useState<{ rule: DiscordAutomodRule | null; trigger: AutomodTrigger } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newTrigger, setNewTrigger] = useState<AutomodTrigger>('keyword');
  const { busy, error, run } = useAction(onChanged);
  const base = `/api/discord/protection/automod/${g.id}`;
  const full = g.rules.length >= AUTOMOD_RULES_MAX;
  return (
    <div className="stack">
      {showName && <h3>{g.name}</h3>}
      {g.rules.length === 0 ? (
        <p className="empty-note">No AutoMod rules in this server yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table commands-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">On / off</span>
                </th>
                <th scope="col">Rule</th>
                <th scope="col">Kind</th>
                <th scope="col">Does</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {g.rules.map((r) => (
                <tr key={r.id}>
                  <td className="cell-toggle">
                    <label className="switch switch-onoff">
                      <input
                        type="checkbox"
                        aria-label={`${r.name} ${r.enabled ? 'on' : 'off'}`}
                        checked={r.enabled}
                        disabled={busy}
                        onChange={(e) => void run(() => api('POST', `${base}/${r.id}/enabled`, { enabled: e.target.checked }))}
                      />
                    </label>
                  </td>
                  <td>
                    {r.name}
                    {(r.exemptRoles.length > 0 || r.exemptChannels.length > 0) && (
                      <div className="muted small">
                        Exempt: {[r.exemptRoles.length && `${r.exemptRoles.length} role${r.exemptRoles.length === 1 ? '' : 's'}`, r.exemptChannels.length && `${r.exemptChannels.length} channel${r.exemptChannels.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="small">{AUTOMOD_TRIGGER_LABEL[r.trigger]}</td>
                  <td className="small">{ACTION_SUMMARY(r, g)}</td>
                  <td className="actions">
                    {confirmDelete === r.id ? (
                      <span className="row-actions">
                        <span className="small">Delete {r.name}?</span>
                        <Button variant="danger" className="btn-row" busy={busy} onClick={() => void run(() => api('DELETE', `${base}/${r.id}`)).then(() => setConfirmDelete(null))}>
                          Delete
                        </Button>
                        <Button variant="secondary" className="btn-row" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <span className="row-actions">
                        <Button variant="secondary" className="btn-row" onClick={() => setEditing({ rule: r, trigger: r.trigger })}>
                          Edit
                        </Button>
                        <Button variant="secondary" className="btn-row btn-row-delete" onClick={() => setConfirmDelete(r.id)}>
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
      <ErrorBanner error={error} />
      {editing === null && (
        <div className="editor-row">
          <select aria-label="Kind of rule" value={newTrigger} onChange={(e) => setNewTrigger(e.target.value as AutomodTrigger)}>
            {AUTOMOD_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {AUTOMOD_TRIGGER_LABEL[t]}
              </option>
            ))}
          </select>
          <Button variant="secondary" disabled={full} onClick={() => setEditing({ rule: null, trigger: newTrigger })}>
            New rule
          </Button>
          <span className="muted small">{full ? `A server can have up to ${AUTOMOD_RULES_MAX} rules.` : AUTOMOD_TRIGGER_HELP[newTrigger]}</span>
        </div>
      )}
      {editing && (
        <AutomodRuleEditor
          key={editing.rule?.id ?? `new-${editing.trigger}`}
          g={g}
          rule={editing.rule}
          trigger={editing.trigger}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

const lines = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const DEFAULT_NAMES: Record<AutomodTrigger, string> = {
  keyword: 'Blocked words',
  mention_spam: 'Mention spam',
  member_profile: 'Member names',
};

export function AutomodRuleEditor({
  g,
  rule,
  trigger,
  onClose,
  onSaved,
}: {
  g: DiscordAutomodGuild;
  rule: DiscordAutomodRule | null;
  trigger: AutomodTrigger;
  onClose: () => void;
  onSaved: () => void;
}) {
  const allowed = AUTOMOD_ACTIONS_ALLOWED[trigger];
  const [name, setName] = useState(rule?.name ?? DEFAULT_NAMES[trigger]);
  const [keywords, setKeywords] = useState((rule?.keywords ?? []).join('\n'));
  const [regex, setRegex] = useState((rule?.regexPatterns ?? []).join('\n'));
  const [allowList, setAllowList] = useState((rule?.allowList ?? []).join('\n'));
  const [mentionLimit, setMentionLimit] = useState(rule?.mentionLimit ?? 5);
  const [action, setAction] = useState<DiscordAutomodAction>(rule?.action ?? (trigger === 'member_profile' ? 'log' : 'delete_message'));
  const [timeoutMinutes, setTimeoutMinutes] = useState(rule?.timeoutMinutes ?? 10);
  const [alertChannelId, setAlertChannelId] = useState(rule?.alertChannelId ?? '');
  const [exemptModerators, setExemptModerators] = useState(rule?.exemptModerators ?? true);
  const [exemptRoles, setExemptRoles] = useState(rule?.exemptRoles ?? []);
  const [exemptChannels, setExemptChannels] = useState(rule?.exemptChannels ?? []);
  const { busy, error, run } = useAction(onSaved);
  const words = trigger === 'keyword' || trigger === 'member_profile';
  const onMessages = trigger !== 'member_profile';
  const input: AutomodRuleInput = {
    name,
    enabled: rule?.enabled ?? true,
    trigger,
    keywords: words ? lines(keywords) : [],
    regexPatterns: words ? lines(regex) : [],
    allowList: words ? lines(allowList) : [],
    mentionLimit: trigger === 'mention_spam' ? mentionLimit : null,
    action,
    timeoutMinutes,
    alertChannelId: alertChannelId || null,
    exemptModerators: onMessages ? exemptModerators : false,
    exemptRoles,
    exemptChannels: onMessages ? exemptChannels : [],
  };
  const p = problems(automodRuleSchema, input);
  return (
    <div className="card editor-card" role="group" aria-label={rule ? `Edit ${rule.name}` : 'New AutoMod rule'}>
      <h3>
        {rule ? 'Edit rule' : 'New rule'} · {AUTOMOD_TRIGGER_LABEL[trigger]}
      </h3>
      <p className="muted small">{AUTOMOD_TRIGGER_HELP[trigger]}</p>
      <div className="form-grid">
        <Field label="Rule name" value={name} onChange={setName} maxLength={100} error={p.name} />
        {trigger === 'mention_spam' && (
          <Field
            label="Most mentions allowed (per message)"
            type="number"
            min={1}
            max={50}
            value={String(mentionLimit)}
            onChange={(v) => setMentionLimit(Number(v))}
            error={p.mentionLimit}
          />
        )}
      </div>
      {words && (
        <>
          <div className="form-grid">
            <TextList label="Words and phrases (one per line; * as a wildcard)" value={keywords} onChange={setKeywords} error={p.keywords} />
            <TextList label="Regular expressions (one per line, up to 10)" value={regex} onChange={setRegex} error={p.regexPatterns} />
          </div>
          <p className="muted small">
            <code>cat</code> matches the word “cat”; <code>cat*</code> words starting with it, <code>*cat</code> words ending with it, <code>*cat*</code> anywhere.
            Capital letters and fancy fonts don’t matter.
          </p>
          <TextList label="Allowed words (never matched; one per line)" value={allowList} onChange={setAllowList} error={p.allowList} />
        </>
      )}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">When it matches</span>
          <select value={action} onChange={(e) => setAction(e.target.value as DiscordAutomodAction)} aria-invalid={p.action ? true : undefined}>
            {allowed.map((a) => (
              <option key={a} value={a}>
                {automodActionLabel(trigger, a)}
              </option>
            ))}
          </select>
          {p.action && <span className="field-error">{p.action}</span>}
        </label>
        {action === 'timeout' && (
          <Field
            label="Time out for (minutes)"
            type="number"
            min={1}
            max={40_320}
            value={String(timeoutMinutes)}
            onChange={(v) => setTimeoutMinutes(Number(v))}
            error={p.timeoutMinutes}
          />
        )}
        <label className="field">
          <span className="field-label">Send an alert to</span>
          <select value={alertChannelId} onChange={(e) => setAlertChannelId(e.target.value)}>
            <option value="">No alert</option>
            {/* A channel that no longer exists (or the bot can't list) still shows, so it can be changed. */}
            {alertChannelId && !g.channels.some((c) => c.id === alertChannelId) && <option value={alertChannelId}>Unknown channel (no longer exists?)</option>}
            {g.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {onMessages && (
        <label className="inline-check">
          <input type="checkbox" checked={exemptModerators} onChange={(e) => setExemptModerators(e.target.checked)} /> Don’t check moderators (Manage Messages,
          Timeout, Kick or Ban Members, Administrator)
        </label>
      )}
      <IdChips label="Exempt roles" noun="role" items={g.roles.map((r) => ({ id: r.id, label: `@${r.name}` }))} value={exemptRoles} onChange={setExemptRoles} max={50} />
      {onMessages && (
        <IdChips label="Exempt channels" noun="channel" items={g.channels.map((c) => ({ id: c.id, label: `#${c.name}` }))} value={exemptChannels} onChange={setExemptChannels} max={100} />
      )}
      <ErrorBanner error={error} />
      <div className="form-actions">
        <Button
          busy={busy}
          disabled={Object.keys(p).length > 0}
          onClick={() => void run(() => (rule ? api('PATCH', `/api/discord/protection/automod/${g.id}/${rule.id}`, input) : api('POST', `/api/discord/protection/automod/${g.id}`, input)))}
        >
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TextList({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea rows={5} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/**
 * Picks roles or channels: the chosen ones as removable chips, with an "Add" menu (type to jump) for the rest on its own
 * line below. Ids that no longer exist (or can't be listed right now) still show, so they can be removed.
 */
function IdChips({
  label,
  noun,
  items,
  value,
  onChange,
  max,
  hint,
}: {
  label: string;
  noun: 'role' | 'channel';
  items: Array<{ id: string; label: string; group?: string }>;
  value: string[];
  onChange: (v: string[]) => void;
  max: number;
  hint?: string;
}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const left = items.filter((i) => !value.includes(i.id));
  const groups = [...new Set(left.map((i) => i.group ?? ''))];
  const full = value.length >= max;
  const option = (i: { id: string; label: string }) => (
    <option key={i.id} value={i.id}>
      {i.label}
    </option>
  );
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="id-chips">
        {value.length === 0 && <span className="muted small">No {noun}s yet.</span>}
        {value.map((id) => {
          const item = byId.get(id);
          return (
            <span key={id} className={`id-chip id-chip-${noun}${item ? '' : ' is-missing'}`} title={item?.group}>
              {item?.label ?? (noun === 'role' ? 'Unknown role' : 'Unknown channel')}
              <button type="button" className="id-chip-remove" aria-label={`Remove ${item?.label ?? id}`} onClick={() => onChange(value.filter((v) => v !== id))}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <select
        className="id-chips-add"
        aria-label={`Add a ${noun} to ${label}`}
        value=""
        disabled={full || left.length === 0}
        onChange={(e) => e.target.value && onChange([...value, e.target.value])}
      >
        <option value="">{full ? `Limit reached (${max})` : left.length === 0 ? `No more ${noun}s` : `+ Add ${noun}…`}</option>
        {groups.map((grp) =>
          grp ? (
            <optgroup key={grp} label={grp}>
              {left.filter((i) => i.group === grp).map(option)}
            </optgroup>
          ) : (
            left.filter((i) => !i.group).map(option)
          ),
        )}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

// ── 2. CONDUIT protection: message checks (gateway + REST) ───────────────────

export function MessageChecksSection({ s, onSaved }: { s: DiscordProtectionState; onSaved?: () => void }) {
  const [v, setV] = useState<MessageChecks>(s.messageChecks);
  const { busy, error, run } = useAction(onSaved);
  const p = problems(messageChecksSchema, v);
  const dirty = JSON.stringify(v) !== JSON.stringify(s.messageChecks);
  const set = <K extends MessageCheck>(check: K, patch: Partial<MessageChecks[K]>) => setV({ ...v, [check]: { ...v[check], ...patch } });
  const multi = s.automod.guilds.length > 1;
  const roles = s.automod.guilds.flatMap((g) => g.roles.map((r) => ({ id: r.id, label: `@${r.name}`, group: multi ? g.name : undefined })));
  const channels = s.automod.guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}`, group: multi ? g.name : undefined })));
  const anyAction = (['repeat', 'flood', 'caps', 'invites'] as const).some((c) => v[c].enabled && v[c].action !== 'log');
  return (
    <div className="protection-panel">
      <p className="muted small">Bot needs: Manage Messages to delete, Timeout Members to time out. Message text is checked in memory, never stored.</p>
      {s.stats.checked > 0 && (
        <p className="muted small">
          Since {new Date(s.stats.since).toLocaleString()}: {s.stats.checked} message{s.stats.checked === 1 ? '' : 's'} checked, {s.stats.matched} matched.
        </p>
      )}
      {v.enabled && !s.messageContent && (
        <p className="small text-warn">The bot isn’t receiving message text right now, so caps and invite checks can’t run (repeats and flooding still can).</p>
      )}
      <label className="inline-check">
        <input type="checkbox" checked={v.exemptModerators} onChange={(e) => setV({ ...v, exemptModerators: e.target.checked })} /> Never check moderators
        (Manage Messages, Timeout, Kick or Ban Members, Administrator)
      </label>
      <IdChips label="Exempt roles" noun="role" items={roles} value={v.exemptRoles} onChange={(exemptRoles) => setV({ ...v, exemptRoles })} max={50} />
      <IdChips label="Exempt channels" noun="channel" items={channels} value={v.exemptChannels} onChange={(exemptChannels) => setV({ ...v, exemptChannels })} max={100} />
      <div className="table-scroll">
        <table className="table commands-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">On / off</span>
              </th>
              <th scope="col">Check</th>
              <th scope="col">Matches when</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {(['repeat', 'flood', 'caps', 'invites'] as const).map((c) => (
              <tr key={c}>
                <td className="cell-toggle">
                  <label className="switch switch-onoff">
                    <input type="checkbox" aria-label={`${MESSAGE_CHECK_LABEL[c]} ${v[c].enabled ? 'on' : 'off'}`} checked={v[c].enabled} onChange={(e) => set(c, { enabled: e.target.checked })} />
                  </label>
                </td>
                <td>{MESSAGE_CHECK_LABEL[c]}</td>
                <td className="small">
                  {c === 'repeat' && (
                    <>
                      The same message <Num value={v.repeat.count} min={2} max={20} label="Repeats" onChange={(count) => set('repeat', { count })} /> times within{' '}
                      <Num value={v.repeat.windowSeconds} min={5} max={600} label="Repeat window (seconds)" onChange={(windowSeconds) => set('repeat', { windowSeconds })} /> s
                    </>
                  )}
                  {c === 'flood' && (
                    <>
                      More than <Num value={v.flood.maxMessages} min={3} max={50} label="Messages" onChange={(maxMessages) => set('flood', { maxMessages })} /> messages within{' '}
                      <Num value={v.flood.windowSeconds} min={3} max={120} label="Flood window (seconds)" onChange={(windowSeconds) => set('flood', { windowSeconds })} /> s
                    </>
                  )}
                  {c === 'caps' && (
                    <>
                      <Num value={v.caps.percent} min={50} max={100} label="Capital letters (%)" onChange={(percent) => set('caps', { percent })} />% capitals, in messages with at
                      least <Num value={v.caps.minLetters} min={5} max={500} label="Minimum letters" onChange={(minLetters) => set('caps', { minLetters })} /> letters
                    </>
                  )}
                  {c === 'invites' && <>A Discord invite link (discord.gg/…)</>}
                  {Object.entries(p)
                    .filter(([k]) => k.startsWith(`${c}.`))
                    .map(([k, m]) => (
                      <div key={k} className="field-error">
                        {m}
                      </div>
                    ))}
                </td>
                <td className="small">
                  <select aria-label={`${MESSAGE_CHECK_LABEL[c]} action`} value={v[c].action} onChange={(e) => set(c, { action: e.target.value as ProtectionAction })}>
                    {PROTECTION_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {PROTECTION_ACTION_LABEL[a]}
                      </option>
                    ))}
                  </select>
                  {v[c].action === 'timeout' && (
                    <div>
                      for <Num value={v[c].timeoutMinutes} min={1} max={40_320} label={`${MESSAGE_CHECK_LABEL[c]} timeout (minutes)`} onChange={(timeoutMinutes) => set(c, { timeoutMinutes })} /> min
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {v.enabled && !anyAction && <p className="muted small">Every check is on “Log only”: matches are recorded in Logs and nothing is deleted.</p>}
      <ErrorBanner error={error} />
      <div className="form-actions">
        <Button busy={busy} disabled={!dirty || Object.keys(p).length > 0} onClick={() => void run(() => api('POST', '/api/discord/protection/messages', v))}>
          Save message checks
        </Button>
        {dirty && (
          <Button variant="secondary" onClick={() => setV(s.messageChecks)}>
            Discard changes
          </Button>
        )}
      </div>
    </div>
  );
}

function Num({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (v: number) => void }) {
  return <input aria-label={label} className="num" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

// ── 3. CONDUIT protection: anti-nuke (audit log + REST) ──────────────────────

export function AntiNukeSection({ s, onSaved }: { s: DiscordProtectionState; onSaved?: () => void }) {
  const [v, setV] = useState<AntinukeSettings>(s.antinuke);
  const [trustedText, setTrustedText] = useState(s.antinuke.trustedUsers.join('\n'));
  const { busy, error, run } = useAction(onSaved);
  const next: AntinukeSettings = { ...v, trustedUsers: lines(trustedText) };
  const p = problems(antinukeSchema, next);
  const dirty = JSON.stringify(next) !== JSON.stringify(s.antinuke);
  const preset = matchingAntinukePreset(v.rules);
  const multi = s.automod.guilds.length > 1;
  const roles = s.automod.guilds.flatMap((g) => g.roles.map((r) => ({ id: r.id, label: `@${r.name}`, group: multi ? g.name : undefined })));
  const setRule = (r: AntinukeRule, patch: Partial<AntinukeSettings['rules'][AntinukeRule]>) => setV({ ...v, rules: { ...v.rules, [r]: { ...v.rules[r], ...patch } } });
  const alertValue = v.alertChannel ? `${v.alertChannel.guildId}:${v.alertChannel.channelId}` : '';
  return (
    <div className="protection-panel">
      <p className="muted small">
        Never acts on the server owner, CONDUIT’s bot, or trusted people and roles. Bot needs: View Audit Log, plus Manage Roles to quarantine (or Timeout,
        Kick or Ban Members).
      </p>
      {next.enabled && next.mode === 'enforce' && next.trustedUsers.length === 0 && next.trustedRoles.length === 0 && (
        <p className="small text-warn">Enforcing with no trusted people or roles: any admin or bot that trips a rule is acted on (the server owner never is).</p>
      )}
      {next.enabled && !next.alertChannel && <p className="small text-warn">No alert channel: trips are only recorded in Logs.</p>}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Mode</span>
          <select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value as AntinukeMode })}>
            {ANTINUKE_MODES.map((m) => (
              <option key={m} value={m}>
                {ANTINUKE_MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Response (Enforce)</span>
          <select value={v.response} onChange={(e) => setV({ ...v, response: e.target.value as AntinukeResponse })}>
            {ANTINUKE_RESPONSES.map((r) => (
              <option key={r} value={r}>
                {ANTINUKE_RESPONSE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {v.response === 'timeout' && (
          <Field
            label="Timeout (minutes)"
            type="number"
            min={1}
            max={40_320}
            value={String(v.timeoutMinutes)}
            onChange={(x) => setV({ ...v, timeoutMinutes: Number(x) })}
            error={p.timeoutMinutes}
          />
        )}
        <label className="field">
          <span className="field-label">Alert channel</span>
          <select
            value={alertValue}
            onChange={(e) => {
              const [guildId = '', channelId = ''] = e.target.value.split(':');
              setV({ ...v, alertChannel: guildId && channelId ? { guildId, channelId } : null });
            }}
          >
            <option value="">No alerts</option>
            {s.automod.guilds.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.channels.map((c) => (
                  <option key={c.id} value={`${g.id}:${c.id}`}>
                    #{c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={v.removeAddedBots} onChange={(e) => setV({ ...v, removeAddedBots: e.target.checked })} /> Enforce: also remove
        bots added by someone who trips “Bots added”
      </label>
      <div className="form-grid">
        <TextList label="Trusted people (Discord user IDs, one per line)" value={trustedText} onChange={setTrustedText} error={Object.entries(p).find(([k]) => k.startsWith('trustedUsers'))?.[1]} />
      </div>
      <IdChips label="Trusted roles" noun="role" items={roles} value={v.trustedRoles} onChange={(trustedRoles) => setV({ ...v, trustedRoles })} max={50} />
      <div className="editor-row">
        <span className="small">Preset:</span>
        {ANTINUKE_PRESETS.map((x) => (
          <Button key={x} variant={preset === x ? 'primary' : 'secondary'} className="btn-row" onClick={() => setV({ ...v, rules: antinukePreset(x) })}>
            {ANTINUKE_PRESET_LABEL[x]}
          </Button>
        ))}
        {!preset && <span className="muted small">Custom</span>}
      </div>
      <div className="table-scroll">
        <table className="table commands-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">On / off</span>
              </th>
              <th scope="col">Rule</th>
              <th scope="col">Trips at</th>
            </tr>
          </thead>
          <tbody>
            {ANTINUKE_RULES.map((r) => (
              <tr key={r}>
                <td className="cell-toggle">
                  <label className="switch switch-onoff">
                    <input type="checkbox" aria-label={`${ANTINUKE_RULE_LABEL[r]} ${v.rules[r].enabled ? 'on' : 'off'}`} checked={v.rules[r].enabled} onChange={(e) => setRule(r, { enabled: e.target.checked })} />
                  </label>
                </td>
                <td>{ANTINUKE_RULE_LABEL[r]}</td>
                <td className="small">
                  <Num value={v.rules[r].threshold} min={1} max={50} label={`${ANTINUKE_RULE_LABEL[r]} threshold`} onChange={(threshold) => setRule(r, { threshold })} /> or more within{' '}
                  <Num value={v.rules[r].windowSeconds} min={5} max={3600} label={`${ANTINUKE_RULE_LABEL[r]} window (seconds)`} onChange={(windowSeconds) => setRule(r, { windowSeconds })} /> s
                  {Object.entries(p)
                    .filter(([k]) => k.startsWith(`rules.${r}.`))
                    .map(([k, m]) => (
                      <div key={k} className="field-error">
                        {m}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBanner error={error} />
      <div className="form-actions">
        <Button busy={busy} disabled={!dirty || Object.keys(p).length > 0} onClick={() => void run(() => api('POST', '/api/discord/protection/antinuke', next))}>
          Save anti-nuke
        </Button>
        {dirty && (
          <Button
            variant="secondary"
            onClick={() => {
              setV(s.antinuke);
              setTrustedText(s.antinuke.trustedUsers.join('\n'));
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
      <QuarantineSection s={s} onChanged={onSaved} variant="panel" />
    </div>
  );
}

const QUARANTINE_STATUS: Record<QuarantineView['status'], { label: string; pill: string }> = {
  active: { label: 'Quarantined', pill: 'pill-bad' },
  restored: { label: 'Roles restored', pill: 'pill-ok' },
  released: { label: 'Released', pill: 'pill-muted' },
};

/** Members anti-nuke quarantined: give their roles back, or close the entry without doing so. */
export function QuarantineSection({ s, onChanged, variant = 'card' }: { s: DiscordProtectionState; onChanged?: () => void; variant?: 'card' | 'panel' }) {
  const { busy, error, run } = useAction(onChanged);
  const list = variant === 'card' ? s.quarantine.filter((q) => q.status === 'active') : s.quarantine;
  if (list.length === 0) return null;
  return (
    <Frame variant={variant} id="conduit-quarantine" title={variant === 'card' ? 'Quarantined members' : 'Quarantine history'}>
      <p className="muted small">
        <strong>Restore</strong> gives back the roles CONDUIT removed; <strong>Release</strong> closes the entry without giving them back.
      </p>
      <ErrorBanner error={error} />
      <div className="table-scroll">
        <table className="table history-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Member</th>
              <th>Roles removed</th>
              <th>Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((q) => (
              <tr key={q.id}>
                <td className="nowrap muted">{new Date(q.at).toLocaleString()}</td>
                <td>
                  {q.userName ?? q.userId}
                  {q.place && <div className="muted small">{q.place}</div>}
                  <div className="muted small">{q.reason}</div>
                </td>
                <td className="small">{q.roles.map((r) => (r.name ? `@${r.name}` : r.id)).join(', ') || '—'}</td>
                <td>
                  <span className={`pill ${QUARANTINE_STATUS[q.status].pill}`}>{QUARANTINE_STATUS[q.status].label}</span>
                </td>
                <td className="actions">
                  {q.status === 'active' && (
                    <span className="row-actions">
                      <Button variant="secondary" className="btn-row" busy={busy} onClick={() => void run(() => api('POST', `/api/discord/protection/quarantine/${q.id}/restore`))}>
                        Restore
                      </Button>
                      <Button variant="secondary" className="btn-row" busy={busy} onClick={() => void run(() => api('POST', `/api/discord/protection/quarantine/${q.id}/release`))}>
                        Release
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

// ── 4. CONDUIT protection: anti-raid, lockdown, join gate ────────────────────

export function AntiRaidSection({ s, onSaved }: { s: DiscordProtectionState; onSaved?: () => void }) {
  const [v, setV] = useState<AntiraidSettings>(s.antiraid);
  const { busy, error, run } = useAction(onSaved);
  const p = problems(antiraidSchema, v);
  const dirty = JSON.stringify(v) !== JSON.stringify(s.antiraid);
  const preset = matchingAntiraidPreset(v);
  const multi = s.automod.guilds.length > 1;
  const channels = s.automod.guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}`, group: multi ? g.name : undefined })));
  const alertValue = v.alertChannel ? `${v.alertChannel.guildId}:${v.alertChannel.channelId}` : '';
  const setGate = (patch: Partial<AntiraidSettings['gate']>) => setV({ ...v, gate: { ...v.gate, ...patch } });
  return (
    <div className="protection-panel">
      <p className="muted small">
        Lifting a lockdown puts back exactly what was there before. Bot needs: Manage Server (verification level), Manage Roles (locking channels), Kick
        Members (join gate kicks).
      </p>
      {(v.enabled || v.gate.enabled) && !v.alertChannel && <p className="small text-warn">No alert channel: raids and flagged members are only recorded in Logs.</p>}
      {v.enabled && v.mode === 'enforce' && !v.raiseVerification && v.lockChannels.length === 0 && (
        <p className="small text-warn">Enforce is on, but the lockdown does nothing: raise the verification level and/or choose channels to lock.</p>
      )}
      <div className="editor-row">
        <span className="small">Preset:</span>
        {ANTIRAID_PRESETS.map((x) => (
          <Button key={x} variant={preset === x ? 'primary' : 'secondary'} className="btn-row" onClick={() => setV(applyAntiraidPreset(v, x))}>
            {ANTINUKE_PRESET_LABEL[x]}
          </Button>
        ))}
        {!preset && <span className="muted small">Custom</span>}
      </div>
      <label className="field">
        <span className="field-label">Alert channel</span>
        <select
          value={alertValue}
          onChange={(e) => {
            const [guildId = '', channelId = ''] = e.target.value.split(':');
            setV({ ...v, alertChannel: guildId && channelId ? { guildId, channelId } : null });
          }}
        >
          <option value="">No alerts</option>
          {s.automod.guilds.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.channels.map((c) => (
                <option key={c.id} value={`${g.id}:${c.id}`}>
                  #{c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <p className="small">
        <Num value={v.joinThreshold} min={2} max={100} label="Joins" onChange={(joinThreshold) => setV({ ...v, joinThreshold })} /> or more members joining
        within <Num value={v.joinWindowSeconds} min={5} max={300} label="Join window (seconds)" onChange={(joinWindowSeconds) => setV({ ...v, joinWindowSeconds })} /> s
        is a raid.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Mode</span>
          <select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value as AntinukeMode })}>
            <option value="alert">Alert only (dry run)</option>
            <option value="enforce">Enforce: start a lockdown</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Lift an automatic lockdown after</span>
          <select value={v.autoLiftMinutes} onChange={(e) => setV({ ...v, autoLiftMinutes: Number(e.target.value) })}>
            <option value={0}>Only by hand</option>
            {[5, 10, 15, 30, 60, 120, 360].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`} without new joins
              </option>
            ))}
            {![0, 5, 10, 15, 30, 60, 120, 360].includes(v.autoLiftMinutes) && <option value={v.autoLiftMinutes}>{v.autoLiftMinutes} min without new joins</option>}
          </select>
        </label>
      </div>
      <fieldset className="field">
        <legend className="field-label">Lockdown</legend>
        <label className="inline-check">
          <input type="checkbox" checked={v.raiseVerification} onChange={(e) => setV({ ...v, raiseVerification: e.target.checked })} /> Raise the verification
          level to{' '}
          <select aria-label="Lockdown verification level" value={v.verificationLevel} onChange={(e) => setV({ ...v, verificationLevel: e.target.value as AntiraidSettings['verificationLevel'] })}>
            {LOCKDOWN_VERIFICATION_LEVELS.map((l) => (
              <option key={l} value={l}>
                {VERIFICATION_LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </label>
        <IdChips
          label="Lock these channels"
          noun="channel"
          hint="@everyone can’t send messages, create threads or react there during a lockdown."
          items={channels}
          value={v.lockChannels}
          onChange={(lockChannels) => setV({ ...v, lockChannels })}
          max={50}
        />
      </fieldset>
      <fieldset className="field">
        <legend className="field-label">Join gate</legend>
        <label className="inline-check">
          <input type="checkbox" checked={v.gate.enabled} onChange={(e) => setGate({ enabled: e.target.checked })} /> <strong>Check new accounts</strong> (only new joins)
        </label>
        <p className="small">
          Flag accounts younger than{' '}
          <Num value={v.gate.minAccountAgeDays} min={0} max={365} label="Minimum account age (days)" onChange={(minAccountAgeDays) => setGate({ minAccountAgeDays })} /> days{' '}
          <label className="inline-check">
            <input type="checkbox" checked={v.gate.requireAvatar} onChange={(e) => setGate({ requireAvatar: e.target.checked })} /> or without a profile picture
          </label>
        </p>
        <label className="field">
          <span className="field-label">Flagged members</span>
          <select value={v.gate.response} onChange={(e) => setGate({ response: e.target.value as JoinGateResponse })}>
            {JOIN_GATE_RESPONSES.map((r) => (
              <option key={r} value={r}>
                {JOIN_GATE_RESPONSE_LABEL[r]}
              </option>
            ))}
          </select>
          {p['gate.minAccountAgeDays'] && <span className="field-error">{p['gate.minAccountAgeDays']}</span>}
          <span className="field-hint">“Hold” works with buttons that use the Verify action (Discord → Embed Creator → Buttons & Menus).</span>
        </label>
      </fieldset>

      <ErrorBanner error={error} />
      <div className="form-actions">
        <Button busy={busy} disabled={!dirty || Object.keys(p).length > 0} onClick={() => void run(() => api('POST', '/api/discord/protection/antiraid', v))}>
          Save anti-raid
        </Button>
        {dirty && (
          <Button variant="secondary" onClick={() => setV(s.antiraid)}>
            Discard changes
          </Button>
        )}
      </div>
      <LockdownSection s={s} onChanged={onSaved} variant="panel" />
    </div>
  );
}

/** Lockdowns in effect (with Lift), and raising one by hand with a preview of what it would do. */
export function LockdownSection({ s, onChanged, variant = 'card' }: { s: DiscordProtectionState; onChanged?: () => void; variant?: 'card' | 'panel' }) {
  const { busy, error, run } = useAction(onChanged);
  const [preview, setPreview] = useState<{ guildId: string; lines: string[] } | null>(null);
  const locked = new Map(s.lockdowns.map((l) => [l.guildId, l]));
  // At the top of the page only while a server is locked down; inside Anti-raid, every server (to lock one by hand).
  const guilds = variant === 'card' ? s.automod.guilds.filter((g) => locked.has(g.id)) : s.automod.guilds;
  if (guilds.length === 0) return null;
  return (
    <Frame variant={variant} id={`conduit-lockdown-${variant}`} title={variant === 'card' ? 'Lockdown in effect' : 'Lockdown by hand'}>
      {variant === 'panel' && <p className="muted small">A lockdown raised by hand stays until you lift it.</p>}
      <ErrorBanner error={error} />
      <ul className="item-list">
        {guilds.map((g) => {
          const l = locked.get(g.id);
          return (
            <li key={g.id} className="item">
              <div className="item-main">
                <div className="item-title">
                  <strong>{g.name}</strong>
                  {l ? <span className="pill pill-bad">Locked down</span> : <span className="pill pill-muted">Normal</span>}
                </div>
                {l && (
                  <div className="small">
                    Since {new Date(l.since).toLocaleString()} · {l.reason}
                    {l.verification && <div className="muted">Verification raised from {VERIFICATION_LEVEL_LABEL[l.verification.from]} to {VERIFICATION_LEVEL_LABEL[l.verification.to]}.</div>}
                    {l.lockedChannels.length > 0 && <div className="muted">Locked: {l.lockedChannels.map((c) => `#${c.name ?? c.id}`).join(', ')}</div>}
                    {l.liftAt && <div className="muted">Lifts at {new Date(l.liftAt).toLocaleTimeString()} if no one else joins.</div>}
                    {l.problems.map((x) => (
                      <div key={x} className="text-warn">
                        {x}
                      </div>
                    ))}
                  </div>
                )}
                {preview?.guildId === g.id && (
                  <ul className="small">
                    {preview.lines.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="item-side">
                {l ? (
                  <Button busy={busy} onClick={() => void run(() => api('POST', `/api/discord/protection/lockdown/${g.id}/lift`))}>
                    Lift lockdown
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      className="btn-row"
                      busy={busy}
                      onClick={() => void run(async () => setPreview({ guildId: g.id, lines: (await api<{ lines: string[] }>('POST', `/api/discord/protection/lockdown/${g.id}/preview`)).lines }))}
                    >
                      Preview
                    </Button>
                    <Button variant="danger" className="btn-row" busy={busy} onClick={() => void run(() => api('POST', `/api/discord/protection/lockdown/${g.id}`, { reason: 'Raised by hand.' }))}>
                      Lock down now
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

/** A section either as its own card (top of the page) or inside an open feature panel. */
function Frame({ variant, id, title, children }: { variant: 'card' | 'panel'; id: string; title: string; children: ReactNode }) {
  if (variant === 'panel')
    return (
      <div className="stack" aria-labelledby={id} role="group">
        <h3 id={id}>{title}</h3>
        {children}
      </div>
    );
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

// ── 5. CONDUIT protection: bot bait ──────────────────────────────────────────

const DELETE_HOURS: Array<[number, string]> = [
  [0, 'Don’t delete their messages'],
  [1, 'Delete their last hour of messages'],
  [6, 'Delete their last 6 hours'],
  [24, 'Delete their last day'],
  [72, 'Delete their last 3 days'],
  [168, 'Delete their last 7 days'],
];

export function BotBaitSection({ s, onSaved }: { s: DiscordProtectionState; onSaved?: () => void }) {
  const [v, setV] = useState<BotbaitSettings>(s.botbait);
  const { busy, error, run } = useAction(onSaved);
  const warn = useAction();
  const [warned, setWarned] = useState<string | null>(null);
  const p = problems(botbaitSchema, v);
  const dirty = JSON.stringify(v) !== JSON.stringify(s.botbait);
  const multi = s.automod.guilds.length > 1;
  const channels = s.automod.guilds.flatMap((g) => g.channels.map((c) => ({ id: c.id, label: `#${c.name}`, group: multi ? g.name : undefined })));
  const roles = s.automod.guilds.flatMap((g) => g.roles.map((r) => ({ id: r.id, label: `@${r.name}`, group: multi ? g.name : undefined })));
  const channelName = (id: string) => channels.find((c) => c.id === id)?.label ?? 'a channel that no longer exists';
  const alertValue = v.alertChannel ? `${v.alertChannel.guildId}:${v.alertChannel.channelId}` : '';
  const warning = botbaitWarning(s.botbait.action);
  return (
    <div className="protection-panel">
      <p className="muted small">
        Tell members not to post in these channels; anyone who does (bots, moderators and exempt roles aside) is treated as a spam account. Bot needs: View
        Channel and Manage Messages there, plus Timeout, Kick or Ban Members for those actions.
      </p>
      {v.enabled && v.channels.length === 0 && <p className="small text-warn">Choose at least one bait channel: nothing is watched yet.</p>}
      {v.enabled && !v.alertChannel && <p className="small text-warn">No alert channel: catches are only recorded in Logs.</p>}
      <IdChips
        label="Bait channels"
        noun="channel"
        hint="Use channels no real member has a reason to post in, e.g. a new #do-not-post channel."
        items={channels}
        value={v.channels}
        onChange={(c) => setV({ ...v, channels: c })}
        max={10}
      />
      <div className="form-grid">
        <label className="field">
          <span className="field-label">When someone posts there</span>
          <select value={v.action} onChange={(e) => setV({ ...v, action: e.target.value as BotbaitAction })}>
            {BOTBAIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {BOTBAIT_ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        {v.action === 'timeout' && (
          <Field label="Timeout (minutes)" type="number" min={1} max={40_320} value={String(v.timeoutMinutes)} onChange={(x) => setV({ ...v, timeoutMinutes: Number(x) })} error={p.timeoutMinutes} />
        )}
        {(v.action === 'ban' || v.action === 'softban') && (
          <label className="field">
            <span className="field-label">Their other messages</span>
            <select value={v.deleteMessageHours} onChange={(e) => setV({ ...v, deleteMessageHours: Number(e.target.value) })}>
              {DELETE_HOURS.map(([h, label]) => (
                <option key={h} value={h}>
                  {label}
                </option>
              ))}
              {!DELETE_HOURS.some(([h]) => h === v.deleteMessageHours) && <option value={v.deleteMessageHours}>Delete their last {v.deleteMessageHours} hours</option>}
            </select>
          </label>
        )}
        <label className="field">
          <span className="field-label">Alert channel</span>
          <select
            value={alertValue}
            onChange={(e) => {
              const [guildId = '', channelId = ''] = e.target.value.split(':');
              setV({ ...v, alertChannel: guildId && channelId ? { guildId, channelId } : null });
            }}
          >
            <option value="">No alerts</option>
            {s.automod.guilds.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.channels.map((c) => (
                  <option key={c.id} value={`${g.id}:${c.id}`}>
                    #{c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={v.exemptModerators} onChange={(e) => setV({ ...v, exemptModerators: e.target.checked })} /> Never act on moderators (Manage
        Messages, Timeout, Kick or Ban Members, Administrator)
      </label>
      <IdChips label="Exempt roles" noun="role" items={roles} value={v.exemptRoles} onChange={(exemptRoles) => setV({ ...v, exemptRoles })} max={50} />
      <ErrorBanner error={error} />
      <div className="form-actions">
        <Button busy={busy} disabled={!dirty || Object.keys(p).length > 0} onClick={() => void run(() => api('POST', '/api/discord/protection/botbait', v))}>
          Save bot bait
        </Button>
        {dirty && (
          <Button variant="secondary" onClick={() => setV(s.botbait)}>
            Discard changes
          </Button>
        )}
      </div>
      {s.botbait.channels.length > 0 && (
        <div className="stack">
          <h3>Warning message</h3>
          <p className="muted small">
            Post a notice in a bait channel so real members stay out: “<strong>{warning.title}</strong> — {warning.description}”
          </p>
          <div className="editor-row">
            {s.botbait.channels.map((id) => (
              <Button
                key={id}
                variant="secondary"
                className="btn-row"
                busy={warn.busy}
                onClick={() =>
                  void warn.run(async () => {
                    await api('POST', '/api/discord/protection/botbait/warning', { channelId: id });
                    setWarned(id);
                  })
                }
              >
                Post in {channelName(id)}
              </Button>
            ))}
          </div>
          {warned && !warn.error && <p className="small text-ok">Posted in {channelName(warned)}.</p>}
          <ErrorBanner error={warn.error} />
        </div>
      )}
    </div>
  );
}
