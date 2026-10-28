import { useState } from 'react';
import {
  AUTOMOD_ACTION_LABEL,
  AUTOMOD_ACTIONS,
  AUTOMOD_RULE_LABEL,
  automodSettingsSchema,
  MODERATION_ACTION_LABEL,
  type AutomodAction,
  type AutomodSettings,
  type AutomodState,
  type RaidState,
  type ModerationUserHistory,
  type DiscordModerationState,
  type DiscordServerModerationView,
  type KickModerationState,
  type ModerationPlatform,
  type ModerationRecordView,
} from '@conduit/shared/community/moderation';
import {
  ANTINUKE_RESPONSE_LABEL,
  ANTINUKE_RULE_LABEL,
  BOTBAIT_ACTION_LABEL,
  type BotbaitAction,
  MESSAGE_CHECK_LABEL,
  PROTECTION_ACTION_LABEL,
  type AntinukeResponse,
  type AntinukeRule,
  type MessageCheck,
  type ProtectionAction,
  type ProtectionEventView,
} from '@conduit/shared/discord/discord-protection';
import { api, errorMessage } from '../../api';
import { Button, Loading } from '../../components/forms';
import { PlatformIcon } from '../../components/PlatformIcon';
import { Pager, usePaged } from '../../components/Pager';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';
import { BotPresenceSections } from '../discord/DiscordBotPresence';
import { LOG_CATEGORY_LABEL } from '@conduit/shared/discord/discord-logging';
import { DiscordLoggingSection } from '../discord/DiscordLoggingPage';
import { DiscordProtectionSections } from '../discord/DiscordProtection';

/**
 * Moderation pages. There are no manual action controls: actions happen through automated protection (Kick) and
 * CONDUIT's Discord moderation commands. Each page shows one platform's configuration and its own logs; both read the
 * same moderation service and the same history table, filtered by platform on the backend.
 */

const POLL_MS = 5000;

/** Polls one platform's moderation state from the backend. */
function useModeration<T>(path: '/api/moderation/kick' | '/api/moderation/discord') {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const state = useAsync(() => api<T>('GET', path), [running]);
  const { data, error, reload } = state;
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  return state;
}

function Waiting({ error, what }: { error: unknown; what: string }) {
  return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : `Loading ${what}…`} />;
}

export function KickModerationPage() {
  const { data, error, reload } = useModeration<KickModerationState>('/api/moderation/kick');
  if (!data) return <Waiting error={error} what="Kick moderation" />;
  return <KickModerationView s={data} onChanged={reload} />;
}

/** Discord Bot: the bot's settings, its protection and its logs, as tabs (the last one opened is remembered). */
export const DISCORD_BOT_TABS = [
  { id: 'bot', label: 'Settings' },
  { id: 'protection', label: 'Protection' },
  { id: 'logs', label: 'Logs' },
] as const;
export type DiscordBotTab = (typeof DISCORD_BOT_TABS)[number]['id'];
const TAB_KEY = 'conduit.discordBotTab';

function initialTab(): DiscordBotTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (DISCORD_BOT_TABS.some((t) => t.id === v)) return v as DiscordBotTab;
  } catch {
    // Not remembered: start at Settings.
  }
  return 'bot';
}

export function DiscordModerationPage() {
  const [tab, setTab] = useState<DiscordBotTab>(initialTab);
  const choose = (t: DiscordBotTab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Not remembered; it still works for this session.
    }
  };
  return <DiscordBotView tab={tab} onTab={choose} />;
}

/** The tabs and the chosen tab's content (each tab loads only what it shows). */
export function DiscordBotView({ tab, onTab }: { tab: DiscordBotTab; onTab: (t: DiscordBotTab) => void }) {
  return (
    <div className="stack">
      <div className="platform-tabs" role="tablist" aria-label="Discord bot">
        {DISCORD_BOT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`discord-bot-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`discord-bot-panel-${t.id}`}
            className={`platform-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`discord-bot-panel-${tab}`} aria-labelledby={`discord-bot-tab-${tab}`} className="stack">
        {tab === 'bot' && <BotPresenceSections />}
        {tab === 'protection' && <DiscordProtectionSections />}
        {tab === 'logs' && (
          <>
            <DiscordLoggingSection />
            <DiscordModerationData>{(s) => <DiscordLogWithHistory s={s} />}</DiscordModerationData>
          </>
        )}
      </div>
    </div>
  );
}

/** Loads the Discord moderation state for a tab. */
function DiscordModerationData({ children }: { children: (s: DiscordModerationState) => React.ReactNode }) {
  const { data, error } = useModeration<DiscordModerationState>('/api/moderation/discord');
  if (!data) return <p className="muted">{error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading…'}</p>;
  return <>{children(data)}</>;
}

// ── Kick ─────────────────────────────────────────────────────────────────────

export function KickModerationView({ s, onChanged }: { s: KickModerationState; onChanged?: () => void }) {
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const events = s.automod.kickModerationEvents;
  return (
    <div className="stack">
      <AutomodCard key={JSON.stringify(s.automod.kick)} automod={s.automod} kickConnected={s.connected} onSaved={onChanged} />
      {person ? (
        <UserHistory platform="kick" person={person} onBack={() => setPerson(null)}>
          {(h) => <LogsCard platform="kick" history={h.history} intro={`Everything recorded for ${person.name} in your Kick chat.`} />}
        </UserHistory>
      ) : (
        <LogsCard
          platform="kick"
          history={s.history}
          onUser={(id, name) => setPerson({ id, name })}
          intro="What automated protection detected and did in your Kick chat, and bans and timeouts done on Kick itself (by you, your moderators or other bots). Select a name to see everything for that person."
          extra={s.connected && !events.ok && events.problem ? <p className="small text-warn">{events.problem}</p> : undefined}
        />
      )}
    </div>
  );
}

/**
 * One person's history (from the backend, not just what the log shows): loaded when a name is selected in the Logs,
 * with a way back to everyone.
 */
function UserHistory({ platform, person, onBack, children }: { platform: 'kick' | 'discord'; person: { id: string; name: string }; onBack: () => void; children: (h: ModerationUserHistory) => React.ReactNode }) {
  const { data, error } = useAsync(() => api<ModerationUserHistory>('POST', '/api/moderation/user-history', { platform, userId: person.id }), [platform, person.id]);
  return (
    <div className="stack">
      <div className="user-history-head">
        <Button variant="secondary" className="btn-row" onClick={onBack}>
          ← Everyone
        </Button>
        <span>
          History of <strong>{person.name}</strong> <span className="muted small">({person.id})</span>
        </span>
      </div>
      {data ? children(data) : <p className="muted">{error ? errorMessage(error) : 'Loading…'}</p>}
    </div>
  );
}

/** Discord Bot → Logs → Moderation log, or one member's history when a name is selected. */
function DiscordLogWithHistory({ s }: { s: DiscordModerationState }) {
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  if (!person) return <DiscordCommandLog s={s} onUser={(id, name) => setPerson({ id, name })} />;
  return (
    <UserHistory platform="discord" person={person} onBack={() => setPerson(null)}>
      {(h) => <DiscordCommandLog s={{ ...s, history: h.history, serverHistory: h.serverHistory, protectionHistory: h.protectionHistory, loggingHistory: h.loggingHistory, loyaltyHistory: [] }} title={`History of ${person.name}`} />}
    </UserHistory>
  );
}

// ── Discord ──────────────────────────────────────────────────────────────────

/** The Discord moderation log (Discord Bot → Logs). Protection has its own tab (DiscordProtection.tsx). */
export function DiscordModerationView({ s }: { s: DiscordModerationState }) {
  return (
    <div className="stack">
      <DiscordCommandLog s={s} />
    </div>
  );
}

const SERVER_ACTION_LABEL: Record<DiscordServerModerationView['action'], string> = {
  ban: 'Ban',
  unban: 'Unban',
  kick: 'Kick',
  timeout: 'Timeout',
  untimeout: 'Timeout removed',
  automod_block: 'Message blocked',
  automod_flag: 'Message flagged',
  automod_timeout: 'Timeout',
};

/** Where a server action came from: Discord's own buttons, another bot, or AutoMod. */
export function serverEventLabel(r: DiscordServerModerationView): string {
  if (r.via === 'automod') return `AutoMod: ${r.ruleName ?? 'a rule'}`;
  if (r.via === 'bot') return `By ${r.by ?? 'another bot'} (bot)`;
  return `In Discord by ${r.by ?? 'a moderator'}`;
}

/** A CONDUIT protection entry's event, e.g. "Protection: Repeated messages" or "Anti-nuke: Channels deleted". */
export function protectionEventLabel(r: ProtectionEventView): string {
  if (r.feature === 'antiraid') return `Anti-raid: ${ANTIRAID_RULE_LABEL[r.rule] ?? r.rule}`;
  if (r.feature === 'joingate') return r.rule === 'verify' ? 'Join gate: Verify' : 'Join gate';
  if (r.feature === 'botbait') return 'Bot bait';
  if (r.feature === 'antinuke') return `Anti-nuke: ${r.rule === 'quarantine' ? 'Quarantine' : (ANTINUKE_RULE_LABEL[r.rule as AntinukeRule] ?? r.rule)}`;
  const rule = r.feature === 'message' ? (MESSAGE_CHECK_LABEL[r.rule as MessageCheck] ?? r.rule) : r.rule;
  return `Protection: ${rule}`;
}

const ANTINUKE_ACTION_LABEL: Record<string, string> = { alert: 'Alert', restore: 'Roles restored', release: 'Released' };
const ANTIRAID_RULE_LABEL: Record<string, string> = { join_burst: 'Join burst', manual: 'By hand', auto_lift: 'Quiet period' };
const ANTIRAID_ACTION_LABEL: Record<string, string> = { lockdown: 'Lockdown', lift: 'Lockdown lifted', kick: 'Kick', hold: 'Held', alert: 'Alert', verify: 'Verify' };

/** What a protection entry did: "None (log only)", "Delete the message", "Quarantine (remove their roles)"… */
function protectionActionLabel(r: ProtectionEventView): string {
  if (r.outcome === 'logged') return r.feature === 'message' ? 'None (log only)' : 'None (alert only)';
  if (r.feature === 'antiraid' || r.feature === 'joingate') return ANTIRAID_ACTION_LABEL[r.action] ?? r.action;
  if (r.feature === 'botbait') return BOTBAIT_ACTION_LABEL[r.action as BotbaitAction] ?? r.action;
  if (r.feature === 'antinuke') return ANTINUKE_ACTION_LABEL[r.action] ?? ANTINUKE_RESPONSE_LABEL[r.action as AntinukeResponse] ?? r.action;
  return PROTECTION_ACTION_LABEL[r.action as ProtectionAction] ?? r.action;
}

interface LogRow {
  id: string;
  at: string;
  event: string;
  place: string | null;
  user: string | null;
  /** Shown under the name (Loyalty & Rewards rows). */
  userId?: string | null;
  /** The person's Discord id, when known (selecting the name shows their history). */
  uid?: string | null;
  action: string;
  extra: string | null;
  reason: string | null;
  result: { label: string; pill: string };
  detail: string | null;
}

/**
 * Logs: every moderation action in the server, newest first — CONDUIT's commands (with Discord's answer) and what
 * Discord's audit log reports from outside CONDUIT: Discord's own buttons, other bots and AutoMod.
 */
export function DiscordCommandLog({ s, onUser, title }: { s: DiscordModerationState; onUser?: (userId: string, name: string) => void; title?: string }) {
  const rows: LogRow[] = [
    ...s.history.map((r) => ({
      id: r.id,
      at: r.at,
      event: eventLabel(r),
      place: r.place,
      user: r.targetUserId === 'unknown' ? null : (r.targetName ?? r.targetUserId),
      uid: r.targetUserId === 'unknown' ? null : r.targetUserId,
      action: r.action === 'flag' ? 'None (log only)' : MODERATION_ACTION_LABEL[r.action],
      extra: r.durationSeconds ? formatDuration(r.durationSeconds) : null,
      reason: r.reason,
      result: RESULT[r.outcome],
      detail: r.detail,
    })),
    ...s.serverHistory.map((r) => ({
      id: r.id,
      at: r.at,
      event: serverEventLabel(r),
      place: r.place,
      user: r.targetName ?? r.targetUserId,
      uid: r.targetUserId,
      action: SERVER_ACTION_LABEL[r.action],
      extra: r.until ? `until ${new Date(r.until).toLocaleString()}` : null,
      reason: r.reason,
      result: { label: 'Done', pill: 'pill-ok' },
      detail: null,
    })),
    ...(s.protectionHistory ?? []).map((r) => ({
      id: r.id,
      at: r.at,
      event: protectionEventLabel(r),
      place: r.place,
      user: r.userName ?? r.userId,
      uid: r.userId,
      action: protectionActionLabel(r),
      extra: null,
      reason: null,
      result: RESULT[r.outcome],
      detail: r.detail,
    })),
    // Loyalty & Rewards: points changes, XP adjustments, settings and rewards changes.
    ...(s.loyaltyHistory ?? []).map((r) => ({
      id: r.id,
      at: r.at,
      // Action: what happened ("Points adjusted"); Description: the change, with the reason and details under it.
      event: r.change ?? '',
      place: r.place,
      user: r.userName ?? r.userId,
      userId: r.userName ? r.userId : null,
      uid: r.userId,
      action: r.title,
      extra: null,
      reason: null,
      result: { label: 'Done', pill: 'pill-ok' },
      detail: [r.reason, r.detail].filter(Boolean).join(' · ') || null,
    })),
    // Everything Discord Logging posted (members, messages, server changes).
    ...(s.loggingHistory ?? []).map((r) => ({
      id: r.id,
      at: r.at,
      event: r.title,
      place: r.place,
      user: r.userName ?? r.userId,
      uid: r.userId,
      action: `${LOG_CATEGORY_LABEL[r.category]} log`,
      extra: null,
      reason: null,
      result: r.posted ? { label: 'Logged', pill: 'pill-ok' } : { label: 'Not posted', pill: 'pill-bad' },
      detail: r.detail,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 200);
  const paged = usePaged(rows);
  return (
    <section className="card" aria-labelledby="discord-logs">
      <h2 id="discord-logs">{title ?? 'Moderation log'}</h2>
      <p className="muted small">
        Everything in your server, newest first: CONDUIT’s commands (with Discord’s answer), what CONDUIT protection noticed or
        did, moderation from Discord’s audit log (Discord’s own buttons, other bots, AutoMod; the bot needs View Audit Log),
        everything Discord Logging posts — members, messages and server changes — and Loyalty &amp; Rewards: points changes,
        XP adjustments and changes to its settings and rewards.{onUser && ' Select a name to see everything for that member.'}
      </p>
      <DiscordCommandsNote s={s} />
      {rows.length === 0 ? (
        <p className="empty-note">Nothing logged yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>User</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap muted">{new Date(r.at).toLocaleString()}</td>
                  <td>
                    {r.action}
                    {r.extra && <span className="muted"> · {r.extra}</span>}
                    {r.reason && <div className="muted small">{r.reason}</div>}
                  </td>
                  <td>
                    {r.user && r.uid && onUser ? (
                      <button type="button" className="link-button" onClick={() => onUser(r.uid!, r.user!)}>
                        {r.user}
                      </button>
                    ) : (
                      (r.user ?? <span className="muted">—</span>)
                    )}
                    {r.userId && <div className="muted small">{r.userId}</div>}
                  </td>
                  <td>
                    <LogDescription event={r.event} place={r.place} platform="discord" result={r.result} detail={r.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} label="Moderation log" />
    </section>
  );
}

/** Which moderation commands exist and whether the bot can carry them out (it needs the permission too). */
function DiscordCommandsNote({ s }: { s: DiscordModerationState }) {
  // Whether the bot is connected is shown on the Dashboard only.
  if (!s.connected) return null;
  return (
    <div className="commands-note small">
      <span className="muted">Commands: </span>
      {s.commands.map((c, i) => (
        <span key={c.name}>
          {i > 0 && ', '}
          <code>/{c.name}</code>
        </span>
      ))}
      <span className="muted"> — Discord shows each one only to members with its permission. </span>
      {s.guilds.map((g) => {
        const missing = [...new Set(s.commands.filter((c) => c.missingIn.includes(g.id)).map((c) => c.permission))];
        return (
          <span key={g.id} className={missing.length ? 'text-warn' : 'text-ok'}>
            {missing.length
              ? `In ${g.name} the bot still needs ${missing.join(' and ')} (Server Settings → Roles).`
              : `In ${g.name} the bot has the permissions it needs.`}{' '}
          </span>
        );
      })}
    </div>
  );
}

// ── automated protection (Kick) ──────────────────────────────────────────────

type RuleKey = 'blockedTerms' | 'links' | 'caps' | 'emotes' | 'symbols' | 'longMessage' | 'repeat' | 'spam';
/** The six spam-type checks: one row, with a table of them (like Discord's Message checks). */
type SpamKey = Exclude<RuleKey, 'blockedTerms' | 'links'>;
export type KickRow = 'blockedTerms' | 'links' | 'spamChecks' | 'raid' | 'ignored';
const RULES: ReadonlyArray<{ key: 'blockedTerms' | 'links'; label: string; what: string }> = [
  { key: 'blockedTerms', label: AUTOMOD_RULE_LABEL.blocked_terms, what: 'Messages with words, phrases or patterns from your list.' },
  { key: 'links', label: AUTOMOD_RULE_LABEL.links, what: 'Links, except to sites you allow.' },
];
const SPAM_CHECKS: ReadonlyArray<{ key: SpamKey; label: string }> = [
  { key: 'caps', label: AUTOMOD_RULE_LABEL.caps },
  { key: 'emotes', label: AUTOMOD_RULE_LABEL.emotes },
  { key: 'symbols', label: AUTOMOD_RULE_LABEL.symbols },
  { key: 'longMessage', label: AUTOMOD_RULE_LABEL.long_message },
  { key: 'repeat', label: AUTOMOD_RULE_LABEL.repeat },
  { key: 'spam', label: AUTOMOD_RULE_LABEL.spam },
];

/** The spam checks together: how many are on, and whether any acts (green) or they only log (amber). */
export function spamSummary(s: AutomodSettings): { text: string; tone: 'muted' | 'info' | 'warn' } {
  const on = SPAM_CHECKS.filter(({ key }) => s[key].enabled);
  if (!s.enabled || on.length === 0) return { text: 'Off', tone: 'muted' };
  return { text: `${on.length} of ${SPAM_CHECKS.length} on`, tone: on.some(({ key }) => s[key].action !== 'log') ? 'warn' : 'info' };
}

/** What a rule does right now, in a few words (shown next to its name). */
export function ruleSummary(s: AutomodSettings, rule: RuleKey): { text: string; tone: 'muted' | 'info' | 'warn' } {
  const r = s[rule];
  if (!s.enabled || !r.enabled) return { text: 'Off', tone: 'muted' };
  if (rule === 'blockedTerms' && s.blockedTerms.terms.length === 0 && s.blockedTerms.regexPatterns.length === 0) return { text: 'No words yet', tone: 'muted' };
  if (r.action === 'log') return { text: 'Log only', tone: 'info' };
  if (r.action === 'delete_message') return { text: 'Deletes the message', tone: 'warn' };
  return { text: `Times out for ${r.timeoutMinutes} min`, tone: 'warn' };
}

/** Raid mode's status: off, learning the regulars, waiting, or on until a time. */
export function raidSummary(s: AutomodSettings, raid: RaidState): { text: string; tone: 'muted' | 'info' | 'warn' | 'bad' } {
  if (!s.enabled || !s.raid.enabled) return { text: 'Off', tone: 'muted' };
  if (raid.activeUntil) return { text: `On until ${new Date(raid.activeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, tone: 'bad' };
  if (raid.learning) return { text: 'Learning your regulars', tone: 'info' };
  return { text: 'Watching', tone: 'warn' };
}

/** The status pill, like Discord Bot → Protection: grey when off, amber when only logging, green when it acts. */
const TONE_PILL: Record<'muted' | 'info' | 'warn' | 'bad', string> = { muted: 'pill-muted', info: 'pill-warn', warn: 'pill-ok', bad: 'pill-bad' };

const lines = (text: string) =>
  text
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

/** Saves the whole settings object (or calls another protection endpoint); the error shows on the card. */
function useKickSave(onSaved?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const call = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved?.();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = (next: AutomodSettings) => call(() => api<AutomodState>('POST', '/api/moderation/automod', next));
  return { busy, error, save, call };
}

/**
 * Kick Moderation → Automated Protection, laid out like Discord Bot → Protection: one compact list with a row per check
 * (what it does, its status, an on/off switch and Configure, which opens its settings below its row, one at a time).
 * The switches save straight away; each check's settings have their own Save.
 */
export function AutomodCard({
  automod,
  kickConnected,
  onSaved,
  initialOpen = null,
}: {
  automod: AutomodState;
  kickConnected: boolean;
  onSaved?: () => void;
  /** The check whose settings start open (tests). */
  initialOpen?: KickRow | null;
}) {
  const saved = automod.kick;
  const [open, setOpen] = useState<KickRow | null>(initialOpen);
  const { busy, error, save } = useKickSave(onSaved);
  const unavailable = AUTOMOD_ACTIONS.filter((a) => !automod.kickActions[a].available);
  const ignoredStatus = [saved.exemptModerators ? 'Moderators' : null, saved.ignoredUsers.length ? `${saved.ignoredUsers.length} user${saved.ignoredUsers.length === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .join(' · ');
  const raid = raidSummary(saved, automod.raid);
  const toggle = (row: KickRow) => setOpen(open === row ? null : row);
  const row = (key: KickRow, label: string, what: string, status: { text: string; tone: keyof typeof TONE_PILL }, on: boolean | null, onSwitch: (on: boolean) => void, panel: React.ReactNode) => (
    <li key={key} className={`protection-row${open === key ? ' is-open' : ''}`}>
      <div className="protection-row-head">
        <span className="protection-switch">
          {on !== null && (
            <label className="switch switch-onoff">
              <input type="checkbox" aria-label={`${label} ${on ? 'on' : 'off'}`} checked={on} disabled={busy} onChange={(e) => onSwitch(e.target.checked)} />
            </label>
          )}
        </span>
        <div className="protection-row-text">
          <strong>{label}</strong>
          <span className="muted small">{what}</span>
        </div>
        <span className={`pill ${TONE_PILL[status.tone]}`}>{status.text}</span>
        <Button variant="secondary" className="btn-row" aria-expanded={open === key} onClick={() => toggle(key)}>
          {open === key ? 'Close' : 'Configure'}
        </Button>
      </div>
      {open === key && panel}
    </li>
  );
  return (
    <section className="card" aria-labelledby="kick-automod">
      <div className="card-head">
        <div>
          <h2 id="kick-automod">Automated Protection</h2>
          <p className="muted small">Checks each new message in your Kick chat. Off until you switch it on; each check only logs until you choose an action.</p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-label={`Automated Protection ${saved.enabled ? 'on' : 'off'}`}
            checked={saved.enabled}
            disabled={!kickConnected || busy}
            onChange={(e) => void save({ ...saved, enabled: e.target.checked })}
          />
          <span>{saved.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      {error !== null && (
        <p className="connection-note note-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <ul className={`protection-list${saved.enabled ? '' : ' rules-off'}`}>
        {RULES.map(({ key, label, what }) =>
          row(
            key,
            label,
            what,
            ruleSummary(saved, key),
            saved[key].enabled,
            (on) => void save({ ...saved, [key]: { ...saved[key], enabled: on } }),
            <KickRulePanel key={JSON.stringify(saved)} rule={key} saved={saved} automod={automod} onSaved={onSaved} />,
          ),
        )}
        {row(
          'spamChecks',
          'Spam checks',
          'Caps, emote and symbol spam, long messages, repeats and flooding.',
          spamSummary(saved),
          null,
          () => {},
          <KickSpamPanel key={JSON.stringify(saved)} saved={saved} automod={automod} onSaved={onSaved} />,
        )}
        {row(
          'raid',
          AUTOMOD_RULE_LABEL.raid,
          'When many first-time chatters arrive at once, CONDUIT is stricter with them for a few minutes.',
          raid,
          saved.raid.enabled,
          (on) => void save({ ...saved, raid: { ...saved.raid, enabled: on } }),
          <KickRaidPanel key={JSON.stringify([saved, automod.raid])} saved={saved} automod={automod} onSaved={onSaved} />,
        )}
        {row(
          'ignored',
          'Ignored users',
          'People the checks skip. You and the chatbot are always skipped.',
          { text: ignoredStatus || 'Nobody else', tone: 'muted' },
          null,
          () => {},
          <KickIgnoredPanel key={JSON.stringify(saved)} saved={saved} onSaved={onSaved} />,
        )}
      </ul>
      {unavailable.length > 0 && kickConnected && (
        <p className="small text-warn">{unavailable.map((a) => `${AUTOMOD_ACTION_LABEL[a]}: ${automod.kickActions[a].problem}`).join(' ')}</p>
      )}
      <p className="muted small">
        {automod.stats.checked} checked · {automod.stats.matched} matched since CONDUIT started
      </p>
    </section>
  );
}

/** Field errors from the schema, by their path ("blockedTerms.terms.2" → "blockedTerms.terms"). */
function schemaErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  return Object.fromEntries(issues.map((i) => [i.path.filter((x) => typeof x !== 'number').map(String).join('.'), i.message]));
}

/** Save / Discard for one check's settings, with the warning that saving lets CONDUIT act. */
function PanelFoot({ changed, acting, busy, message, onSave, onDiscard }: { changed: boolean; acting: boolean; busy: boolean; message: { ok: boolean; text: string } | null; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="form-actions">
      <Button disabled={!changed || busy} busy={busy} onClick={onSave}>
        Save
      </Button>
      {changed && (
        <Button variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      )}
      {changed && acting && <span className="small text-warn">Saving lets CONDUIT act on Kick automatically.</span>}
      {message && (
        <span className={`small ${message.ok ? 'text-ok' : 'text-bad'}`} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </span>
      )}
    </div>
  );
}

/** Saves a panel's version of the settings after checking it with the shared rules. */
function usePanelSave(onSaved?: () => void) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, error, save } = useKickSave(onSaved);
  const submit = async (next: AutomodSettings) => {
    const checked = automodSettingsSchema.safeParse(next);
    if (!checked.success) {
      setErrors(schemaErrors(checked.error.issues));
      setMessage(null);
      return;
    }
    setErrors({});
    const ok = await save(checked.data);
    setMessage(ok ? { ok: true, text: 'Saved.' } : { ok: false, text: errorMessage(error) || 'Not saved.' });
  };
  const fieldError = (prefix: string) => Object.entries(errors).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1];
  return { busy, errors, setErrors, message, setMessage, submit, fieldError };
}

const num = (label: string, value: number, min: number, max: number, onChange: (n: number) => void) => (
  <input aria-label={label} className="num" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
);

/** One check's settings: what it looks for and what it does. */
function KickRulePanel({ rule, saved, automod, onSaved }: { rule: 'blockedTerms' | 'links'; saved: AutomodSettings; automod: AutomodState; onSaved?: () => void }) {
  const [draft, setDraft] = useState<AutomodSettings[RuleKey]>(saved[rule]);
  const [terms, setTerms] = useState(saved.blockedTerms.terms.join('\n'));
  const [patterns, setPatterns] = useState(saved.blockedTerms.regexPatterns.join('\n'));
  const [allowed, setAllowed] = useState(saved.blockedTerms.allowList.join('\n'));
  const [sites, setSites] = useState(saved.links.allowedSites.join('\n'));
  const p = usePanelSave(onSaved);
  const value =
    rule === 'blockedTerms'
      ? { ...(draft as AutomodSettings['blockedTerms']), terms: lines(terms), regexPatterns: lines(patterns), allowList: lines(allowed) }
      : rule === 'links'
        ? { ...(draft as AutomodSettings['links']), allowedSites: lines(sites) }
        : draft;
  const next = { ...saved, [rule]: value } as AutomodSettings;
  const changed = JSON.stringify(next[rule]) !== JSON.stringify(saved[rule]);
  const set = (patch: Record<string, unknown>) => (setDraft({ ...draft, ...patch } as AutomodSettings[RuleKey]), p.setMessage(null));
  const text = (label: string, v: string, onChange: (v: string) => void, rows = 4) => (
    <label className="field rule-terms">
      <span className="field-label">{label}</span>
      <textarea rows={rows} value={v} onChange={(e) => (onChange(e.target.value), p.setMessage(null))} />
    </label>
  );
  return (
    <div className="protection-panel">
      {rule === 'blockedTerms' && (
        <>
          <div className="form-grid">
            {text('Words and phrases, one per line (* as a wildcard)', terms, setTerms)}
            {text('Regular expressions, one per line (up to 10)', patterns, setPatterns)}
          </div>
          <p className="muted small">
            <code>cat</code> matches the word “cat”; <code>cat*</code> words starting with it, <code>*cat</code> words ending with it, <code>*cat*</code> anywhere.
            Capital letters and fancy fonts don’t matter.
          </p>
          {text('Allowed words (never matched; one per line)', allowed, setAllowed, 2)}
        </>
      )}
      {rule === 'links' && (
        <>
          {text('Allowed sites, one per line (their subdomains too)', sites, setSites, 3)}
          <p className="muted small">Any other link counts: with http(s)://, www., or a site like example.com.</p>
        </>
      )}
      <ActionFields
        action={draft.action}
        timeoutMinutes={draft.timeoutMinutes}
        automod={automod}
        actions={AUTOMOD_ACTIONS}
        onChange={(patch) => set(patch)}
      />
      {p.fieldError(rule) && <span className="field-error">{p.fieldError(rule)}</span>}
      <PanelFoot
        changed={changed}
        acting={saved.enabled && next[rule].enabled && next[rule].action !== 'log'}
        busy={p.busy}
        message={p.message}
        onSave={() => void p.submit(next)}
        onDiscard={() => (
          setDraft(saved[rule]),
          setTerms(saved.blockedTerms.terms.join('\n')),
          setPatterns(saved.blockedTerms.regexPatterns.join('\n')),
          setAllowed(saved.blockedTerms.allowList.join('\n')),
          setSites(saved.links.allowedSites.join('\n')),
          p.setErrors({}),
          p.setMessage(null)
        )}
      />
    </div>
  );
}

/** "Then …" and, for timeouts, for how long. */
function ActionFields({
  action,
  timeoutMinutes,
  automod,
  actions,
  onChange,
}: {
  action: AutomodAction;
  timeoutMinutes: number;
  automod: AutomodState;
  actions: readonly AutomodAction[];
  onChange: (patch: { action?: AutomodAction; timeoutMinutes?: number }) => void;
}) {
  return (
    <div className="rule-actions">
      <label className="field">
        <span className="field-label">Then</span>
        <select value={action} onChange={(e) => onChange({ action: e.target.value as AutomodAction })}>
          {actions.map((a) => (
            <option key={a} value={a} disabled={!automod.kickActions[a].available}>
              {AUTOMOD_ACTION_LABEL[a]}
              {!automod.kickActions[a].available ? ' (unavailable)' : ''}
            </option>
          ))}
        </select>
      </label>
      {action === 'timeout' && (
        <label className="field field-narrow">
          <span className="field-label">For (minutes)</span>
          <input type="number" min={1} max={10080} value={timeoutMinutes} onChange={(e) => onChange({ timeoutMinutes: Number(e.target.value) })} />
        </label>
      )}
    </div>
  );
}

/** The spam checks as one table (like Discord's Message checks): on/off, what each matches, and what it does. One Save. */
function KickSpamPanel({ saved, automod, onSaved }: { saved: AutomodSettings; automod: AutomodState; onSaved?: () => void }) {
  const pick = (s: AutomodSettings) => Object.fromEntries(SPAM_CHECKS.map(({ key }) => [key, s[key]])) as Pick<AutomodSettings, SpamKey>;
  const [draft, setDraft] = useState(pick(saved));
  const p = usePanelSave(onSaved);
  const next: AutomodSettings = { ...saved, ...draft };
  const changed = JSON.stringify(draft) !== JSON.stringify(pick(saved));
  const set = <K extends SpamKey>(key: K, patch: Partial<AutomodSettings[K]>) => (setDraft({ ...draft, [key]: { ...draft[key], ...patch } }), p.setMessage(null));
  const n = (key: SpamKey, field: string, label: string, min: number, max: number) =>
    num(label, (draft[key] as unknown as Record<string, number>)[field]!, min, max, (v) => set(key, { [field]: v } as Partial<AutomodSettings[SpamKey]>));
  const acting = saved.enabled && SPAM_CHECKS.some(({ key }) => draft[key].enabled && draft[key].action !== 'log');
  return (
    <div className="protection-panel">
      <div className="table-scroll">
        <table className="table commands-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">On / off</span>
              </th>
              <th scope="col">Check</th>
              <th scope="col">Matches when</th>
              <th scope="col">Then</th>
            </tr>
          </thead>
          <tbody>
            {SPAM_CHECKS.map(({ key, label }) => (
              <tr key={key}>
                <td className="cell-toggle">
                  <label className="switch switch-onoff">
                    <input type="checkbox" aria-label={`${label} ${draft[key].enabled ? 'on' : 'off'}`} checked={draft[key].enabled} onChange={(e) => set(key, { enabled: e.target.checked })} />
                  </label>
                </td>
                <td>{label}</td>
                <td className="small">
                  {key === 'caps' && (
                    <>
                      {n('caps', 'percent', 'Capital letters (%)', 50, 100)}% capitals, in messages with at least {n('caps', 'minLetters', 'Minimum letters', 5, 500)} letters
                    </>
                  )}
                  {key === 'emotes' && <>More than {n('emotes', 'maxEmotes', 'Emotes', 1, 100)} emotes (Kick emotes and emoji) in one message</>}
                  {key === 'symbols' && <>{n('symbols', 'percent', 'Symbols (%)', 30, 100)}% symbols (10+ characters), or stacked accent marks</>}
                  {key === 'longMessage' && <>More than {n('longMessage', 'maxLength', 'Characters', 20, 500)} characters (an emote counts as one)</>}
                  {key === 'repeat' && (
                    <>
                      The same message {n('repeat', 'count', 'Repeats', 2, 20)} times within {n('repeat', 'windowSeconds', 'Repeat window (seconds)', 5, 600)} s
                    </>
                  )}
                  {key === 'spam' && (
                    <>
                      More than {n('spam', 'maxMessages', 'Messages', 3, 50)} messages within {n('spam', 'windowSeconds', 'Flood window (seconds)', 3, 120)} s
                    </>
                  )}
                  {p.fieldError(key) && <div className="field-error">{p.fieldError(key)}</div>}
                </td>
                <td className="small">
                  <select aria-label={`${label} action`} value={draft[key].action} onChange={(e) => set(key, { action: e.target.value as AutomodAction })}>
                    {AUTOMOD_ACTIONS.map((a) => (
                      <option key={a} value={a} disabled={!automod.kickActions[a].available}>
                        {AUTOMOD_ACTION_LABEL[a]}
                        {!automod.kickActions[a].available ? ' (unavailable)' : ''}
                      </option>
                    ))}
                  </select>
                  {draft[key].action === 'timeout' && <div>for {n(key, 'timeoutMinutes', `${label} timeout (minutes)`, 1, 10_080)} min</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PanelFoot
        changed={changed}
        acting={acting}
        busy={p.busy}
        message={p.message}
        onSave={() => void p.submit(next)}
        onDiscard={() => (setDraft(pick(saved)), p.setErrors({}), p.setMessage(null))}
      />
    </div>
  );
}

/** Raid mode: when it starts, how long it lasts, what it does to newcomers, and the chat message. Start/End now. */
function KickRaidPanel({ saved, automod, onSaved }: { saved: AutomodSettings; automod: AutomodState; onSaved?: () => void }) {
  const [draft, setDraft] = useState(saved.raid);
  const p = usePanelSave(onSaved);
  const now = useKickSave(onSaved);
  const next = { ...saved, raid: draft };
  const changed = JSON.stringify(draft) !== JSON.stringify(saved.raid);
  const set = (patch: Partial<AutomodSettings['raid']>) => (setDraft({ ...draft, ...patch }), p.setMessage(null));
  const active = automod.raid.activeUntil !== null;
  return (
    <div className="protection-panel">
      <div className="rule-inline">
        <span className="muted small">Starts when</span>
        {num('First-time chatters', draft.newChatters, 3, 200, (newChatters) => set({ newChatters }))}
        <span className="muted small">people chat for the first time within</span>
        {num('Seconds', draft.windowSeconds, 10, 600, (windowSeconds) => set({ windowSeconds }))}
        <span className="muted small">seconds, and lasts</span>
        {num('Minutes', draft.durationMinutes, 1, 60, (durationMinutes) => set({ durationMinutes }))}
        <span className="muted small">minutes</span>
      </div>
      <p className="muted small">
        While it’s on, a first-time chatter’s message with a link, or that any check above matches (even one set to Log only), is acted on. Kick doesn’t
        let apps change its chat modes (like slow or followers-only), so CONDUIT doesn’t.
        {automod.raid.learning && ` It starts working once CONDUIT has seen enough of your chat to know your regulars (${automod.raid.knownChatters} chatters so far).`}
      </p>
      <ActionFields
        action={draft.action}
        timeoutMinutes={draft.timeoutMinutes}
        automod={automod}
        actions={['delete_message', 'timeout']}
        onChange={(patch) => set(patch as Partial<AutomodSettings['raid']>)}
      />
      <label className="field">
        <span className="field-label">The chatbot says, when raid mode starts (empty: nothing)</span>
        <input value={draft.announcement} maxLength={300} onChange={(e) => set({ announcement: e.target.value })} />
      </label>
      {p.fieldError('raid') && <span className="field-error">{p.fieldError('raid')}</span>}
      <PanelFoot
        changed={changed}
        acting={saved.enabled && draft.enabled}
        busy={p.busy}
        message={p.message}
        onSave={() => void p.submit(next)}
        onDiscard={() => (setDraft(saved.raid), p.setErrors({}), p.setMessage(null))}
      />
      {saved.enabled && saved.raid.enabled && (
        <div className="button-row">
          <Button variant={active ? 'secondary' : 'danger'} busy={now.busy} onClick={() => void now.call(() => api('POST', '/api/moderation/raid', { active: !active }))}>
            {active ? 'End raid mode' : 'Start raid mode now'}
          </Button>
          {now.error !== null && <span className="small text-bad">{errorMessage(now.error)}</span>}
        </div>
      )}
    </div>
  );
}

/** Who the checks skip: Kick usernames, and optionally moderators. */
function KickIgnoredPanel({ saved, onSaved }: { saved: AutomodSettings; onSaved?: () => void }) {
  const [ignored, setIgnored] = useState(saved.ignoredUsers.join('\n'));
  const [moderators, setModerators] = useState(saved.exemptModerators);
  const p = usePanelSave(onSaved);
  const next: AutomodSettings = { ...saved, ignoredUsers: lines(ignored), exemptModerators: moderators };
  const changed = JSON.stringify(next) !== JSON.stringify(saved);
  return (
    <div className="protection-panel">
      <label className="field rule-terms">
        <span className="field-label">Kick usernames, one per line</span>
        <textarea rows={3} value={ignored} onChange={(e) => (setIgnored(e.target.value), p.setMessage(null))} />
      </label>
      {p.fieldError('ignoredUsers') && <span className="field-error">{p.fieldError('ignoredUsers')}</span>}
      <label className="inline-check">
        <input type="checkbox" checked={moderators} onChange={(e) => (setModerators(e.target.checked), p.setMessage(null))} /> Ignore moderators
      </label>
      <PanelFoot
        changed={changed}
        acting={false}
        busy={p.busy}
        message={p.message}
        onSave={() => void p.submit(next)}
        onDiscard={() => (setIgnored(saved.ignoredUsers.join('\n')), setModerators(saved.exemptModerators), p.setErrors({}), p.setMessage(null))}
      />
    </div>
  );
}

// ── logs ─────────────────────────────────────────────────────────────────────

/** Done = the platform confirmed it; Failed = attempted and refused; Detected = a rule matched in "log only" mode. */
const RESULT: Record<ModerationRecordView['outcome'], { label: string; pill: string }> = {
  success: { label: 'Done', pill: 'pill-ok' },
  failed: { label: 'Failed', pill: 'pill-bad' },
  logged: { label: 'Detected only', pill: 'pill-muted' },
};

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** What started it: an automated rule, a Discord command ("name via /ban" → "/ban by name"), or the account used. */
export function eventLabel(r: ModerationRecordView): string {
  if (r.source === 'automod') return r.rule ? AUTOMOD_RULE_LABEL[r.rule] : 'Automated protection';
  // Done on Kick itself (Kick's own buttons or another bot), from Kick's ban and timeout events.
  if (r.source === 'platform') return `On Kick by ${r.actor ?? 'a moderator'}`;
  const via = r.actor ? /^(.*) via \/([a-z]+)$/.exec(r.actor) : null;
  if (via) return `/${via[2]} by ${via[1]}`;
  return r.actor ? `Dashboard (${r.actor})` : 'Dashboard';
}

/** Results not worth a tag: it simply happened. Anything else (Failed, Not posted, Detected only…) is tagged. */
const UNTAGGED_RESULTS = new Set(['Done', 'Logged']);

/** A log row's Description: what happened and where, its result (when it's worth noting), and any details. */
function LogDescription({ event, place, platform, result, detail }: { event: string; place: string | null; platform: ModerationPlatform; result: { label: string; pill: string }; detail: string | null }) {
  const tagged = !UNTAGGED_RESULTS.has(result.label);
  return (
    <>
      {(event || tagged) && (
        <div className="log-description-head">
          {event && <span>{event}</span>} {tagged && <span className={`pill ${result.pill}`}>{result.label}</span>}
        </div>
      )}
      {place && (
        <div className="muted small inline-platform">
          <PlatformIcon platform={platform} size={12} /> {place}
        </div>
      )}
      {detail && <div className="muted small history-detail">{detail}</div>}
    </>
  );
}

export function LogsCard({
  platform,
  history,
  intro,
  extra,
  onUser,
}: {
  platform: ModerationPlatform;
  history: ModerationRecordView[];
  intro: string;
  extra?: React.ReactNode;
  /** Selecting a name shows that person's history. */
  onUser?: (userId: string, name: string) => void;
}) {
  const paged = usePaged(history);
  return (
    <section className="card" aria-labelledby={`${platform}-logs`}>
      <h2 id={`${platform}-logs`}>Logs</h2>
      <p className="muted small">{intro}</p>
      {extra}
      {history.length === 0 ? (
        <p className="empty-note">Nothing logged yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>User</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap muted">{new Date(r.at).toLocaleString()}</td>
                  <td>
                    {r.action === 'flag' ? <span className="muted">None (log only)</span> : MODERATION_ACTION_LABEL[r.action]}
                    {r.durationSeconds ? <span className="muted"> · {formatDuration(r.durationSeconds)}</span> : null}
                    {r.reason && <div className="muted small">{r.reason}</div>}
                  </td>
                  <td>
                    {r.targetUserId === 'unknown' ? (
                      <span className="muted">—</span>
                    ) : onUser ? (
                      <button type="button" className="link-button" onClick={() => onUser(r.targetUserId, r.targetName ?? r.targetUserId)}>
                        {r.targetName ?? r.targetUserId}
                      </button>
                    ) : (
                      (r.targetName ?? r.targetUserId)
                    )}
                  </td>
                  <td>
                    <LogDescription event={eventLabel(r)} place={r.place} platform={r.platform} result={RESULT[r.outcome]} detail={r.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} label="Logs" />
    </section>
  );
}
