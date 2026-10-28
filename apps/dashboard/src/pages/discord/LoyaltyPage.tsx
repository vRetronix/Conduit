import { useState } from 'react';
import {
  DEFAULT_LEVEL_UP_TEMPLATE,
  formatPoints,
  LEVEL_UP_VARIABLE_HELP,
  LEVEL_UP_VARIABLES,
  loyaltySettingsSchema,
  pointsAdjustmentSchema,
  rewardSchema,
  totalXpForLevel,
  xpAdjustmentSchema,
  xpForNextLevel,
  type LoyaltyGuild,
  type LoyaltyMember,
  type LoyaltyMemberHistory,
  type LoyaltyMemberPage,
  type LoyaltyProgress,
  type LoyaltyRedemptionView,
  type LoyaltyRewardView,
  type LoyaltyRoleOptions,
  type LoyaltySettings,
  type LoyaltyState,
  type LoyaltyTransactionView,
} from '@conduit/shared/discord/loyalty';
import { EMPTY_EMBED, fillTemplate, type DiscordEmbed } from '@conduit/shared/discord/embeds';
import { api, ApiClientError, errorMessage } from '../../api';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { EmbedEditor, EmbedPreview } from '../../components/discord/EmbedEditor';
import { Button, Loading } from '../../components/forms';
import { PlatformIcon } from '../../components/PlatformIcon';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 5000;
type Tab = 'overview' | 'levels' | 'members' | 'points' | 'rewards' | 'redemptions';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'levels', label: 'Levels & XP' },
  { id: 'members', label: 'Members' },
  { id: 'points', label: 'Points & Earning' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'redemptions', label: 'Redemptions' },
];
const KIND_LABEL: Record<LoyaltyTransactionView['kind'], string> = { chat: 'Message', adjustment: 'Adjustment', redemption: 'Redemption', refund: 'Refund' };

/** Discord → Loyalty & Rewards: XP and levels, a separate points balance, rewards and redemptions. */
export function LoyaltyPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<LoyaltyState>('GET', '/api/loyalty'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading loyalty…'} />;
  return <LoyaltyView s={data} onChanged={reload} />;
}

export function LoyaltyView({ s, onChanged, initialTab = 'overview' }: { s: LoyaltyState; onChanged?: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="stack">
      {!s.settings.enabled && (
        <p className="connection-note note-warn" role="status">
          Loyalty is off: no XP or points are earned and the Discord commands don’t answer. Levels, balances and history are kept.
        </p>
      )}
      <div className="platform-tabs loyalty-tabs" role="tablist" aria-label="Loyalty">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`loyalty-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`loyalty-panel-${t.id}`} className={`platform-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'redemptions' && s.stats.pending > 0 && <span className="pill pill-warn">{s.stats.pending}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`loyalty-panel-${tab}`} aria-labelledby={`loyalty-tab-${tab}`}>
        {tab === 'overview' ? (
          <OverviewPanel s={s} onChanged={onChanged} />
        ) : tab === 'levels' ? (
          <LevelsPanel s={s} onChanged={onChanged} />
        ) : tab === 'members' ? (
          <MembersPanel s={s} onChanged={onChanged} />
        ) : tab === 'points' ? (
          <PointsPanel s={s} onChanged={onChanged} />
        ) : tab === 'rewards' ? (
          <RewardsPanel s={s} onChanged={onChanged} />
        ) : (
          <RedemptionsPanel s={s} onChanged={onChanged} />
        )}
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function useAction(onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged?.();
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <span className="small text-bad" role="alert">
      {error}
    </span>
  ) : null;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="summary-item">
      <span className="summary-label">{label}</span>
      <span className={`loyalty-stat${tone ? ` ${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function Who({ name, id }: { name: string | null | undefined; id: string }) {
  return (
    <span className="loyalty-who">
      <PlatformIcon platform="discord" size={14} />
      <span>{name ?? id}</span>
    </span>
  );
}

function ProgressBar({ p }: { p: LoyaltyProgress }) {
  const pct = Math.min(100, Math.round((p.xpIntoLevel / p.xpForNext) * 100));
  return (
    <span className="loyalty-progress" title={`${p.xpIntoLevel.toLocaleString('en-US')} / ${p.xpForNext.toLocaleString('en-US')} XP to level ${p.level + 1}`}>
      <span className="loyalty-progress-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="muted small">
        {p.xpIntoLevel.toLocaleString('en-US')} / {p.xpForNext.toLocaleString('en-US')}
      </span>
    </span>
  );
}

const guildName = (guilds: readonly LoyaltyGuild[], id: string) => guilds.find((g) => g.id === id)?.name ?? `Server ${id}`;
const num = (n: number) => n.toLocaleString('en-US');

/** Saves the whole settings object (each tab edits its own part of a copy). */
function useSettingsDraft(s: LoyaltyState, onChanged?: () => void) {
  const [d, setD] = useState<LoyaltySettings>(s.settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const action = useAction(onChanged);
  const save = async () => {
    setSaved(false);
    const checked = loyaltySettingsSchema.safeParse(d);
    if (!checked.success) return setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
    setErrors({});
    if (await action.run(() => api('POST', '/api/loyalty/settings', d))) setSaved(true);
  };
  return { d, setD, errors, saved, save, ...action };
}

function SaveRow({ busy, error, saved, onSave }: { busy: boolean; error: string | null; saved: boolean; onSave: () => void }) {
  return (
    <div className="card-foot">
      <ErrorLine error={error} />
      {saved && (
        <span className="small text-ok" role="status">
          Saved.
        </span>
      )}
      <div className="button-row">
        <Button busy={busy} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const { busy, error, run } = useAction(onChanged);
  const name = s.settings.pointsName;
  return (
    <div className="stack">
      <section className="card" aria-labelledby="loyalty-overview-title">
        <div className="card-head">
          <div>
            <h2 id="loyalty-overview-title">Discord loyalty</h2>
            <p className="muted small">
              Members earn <strong>XP</strong> for chatting and level up (XP is never spent). <strong>{capitalize(name)}</strong> are a separate balance they spend on rewards. XP and {name} are never converted into each other.
            </p>
          </div>
          <label className="switch">
            <input type="checkbox" aria-label={`Loyalty: ${s.settings.enabled ? 'on' : 'off'}`} checked={s.settings.enabled} disabled={busy} onChange={(e) => void run(() => api('POST', '/api/loyalty/settings', { ...s.settings, enabled: e.target.checked }))} />
          </label>
        </div>
        <ErrorLine error={error} />
        <div className="summary-grid">
          <Stat label="Members with XP" value={num(s.stats.members)} />
          <Stat label="Total XP" value={num(s.stats.totalXp)} />
          <Stat label={`Members with ${name}`} value={num(s.stats.viewers)} />
          <Stat label={`${capitalize(name)} held`} value={num(s.stats.outstanding)} />
          <Stat label="Redemptions waiting" value={num(s.stats.pending)} tone={s.stats.pending > 0 ? 'text-warn' : undefined} />
          <Stat label="Rewards" value={`${s.rewards.filter((r) => r.enabled).length} on / ${s.rewards.length}`} />
        </div>
      </section>
      <section className="card" aria-labelledby="loyalty-status-title">
        <h2 id="loyalty-status-title">Status</h2>
        <ul className="loyalty-status">
          <li className="small">
            XP {s.settings.xp.enabled ? 'on' : 'off'} · {name} from messages {s.settings.discord.earn ? 'on' : 'off'} · commands {s.settings.discord.commands ? 'on' : 'off'} · level-up announcements {s.settings.xp.announce.enabled ? 'on' : 'off'} · {s.roleRewards.length} role reward{s.roleRewards.length === 1 ? '' : 's'}
          </li>
          {s.discord.commandConflicts.length > 0 && <li className="small text-warn">Your custom {s.discord.commandConflicts.join(', ')} command is used instead of the loyalty one.</li>}
          {s.stats.legacyKick.accounts > 0 && (
            <li className="small muted">
              Loyalty is Discord-only. {num(s.stats.legacyKick.accounts)} older Kick balance{s.stats.legacyKick.accounts === 1 ? '' : 's'} ({num(s.stats.legacyKick.points)} {name}) are kept as history and can’t be earned or spent.
            </li>
          )}
        </ul>
        {s.problems.length > 0 && (
          <>
            <h3>Recent problems</h3>
            <ul className="loyalty-problems">
              {s.problems.map((p, i) => (
                <li key={`${p.at}-${i}`} className="small">
                  <span className="muted">{new Date(p.at).toLocaleString()}</span> <span className="text-warn">{p.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

// ── Levels & XP ──────────────────────────────────────────────────────────────

function LevelsPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const { d, setD, errors, saved, save, busy, error } = useSettingsDraft(s, onChanged);
  const channels = useDiscordChannels();
  const xp = d.xp;
  const setXp = (patch: Partial<LoyaltySettings['xp']>) => setD({ ...d, xp: { ...d.xp, ...patch } });
  const setAnnounce = (patch: Partial<LoyaltySettings['xp']['announce']>) => setXp({ announce: { ...xp.announce, ...patch } });
  // Kept while "Include an embed" is switched off, so switching it back on restores it.
  const [embedDraft, setEmbedDraft] = useState<DiscordEmbed>(xp.announce.embed ?? { ...EMPTY_EMBED, title: 'Level up!', description: '{user} reached level {level}.' });
  const err = (p: string) => errors[`xp.${p}`];
  return (
    <div className="stack">
      <section className="card" aria-labelledby="xp-title">
        <h2 id="xp-title">XP from messages</h2>
        <label className="inline-check">
          <input type="checkbox" checked={xp.enabled} onChange={(e) => setXp({ enabled: e.target.checked })} /> Members earn XP for messages (switching off keeps everyone’s XP and levels)
        </label>
        <div className="editor-row">
          <input aria-label="Minimum XP" className="num" type="number" min={1} max={1000} value={xp.minXp} disabled={!xp.enabled} onChange={(e) => setXp({ minXp: Number(e.target.value) })} />
          <span className="muted small">to</span>
          <input aria-label="Maximum XP" className="num" type="number" min={1} max={1000} value={xp.maxXp} disabled={!xp.enabled} onChange={(e) => setXp({ maxXp: Number(e.target.value) })} />
          <span className="muted small">XP per message (random), at most once every</span>
          <input aria-label="XP cooldown seconds" className="num" type="number" min={10} max={3600} value={xp.cooldownSeconds} disabled={!xp.enabled} onChange={(e) => setXp({ cooldownSeconds: Number(e.target.value) })} />
          <span className="muted small">seconds per member</span>
        </div>
        {(err('minXp') || err('maxXp') || err('cooldownSeconds')) && <span className="field-error">{err('minXp') ?? err('maxXp') ?? err('cooldownSeconds')}</span>}
        <label className="inline-check">
          <input type="checkbox" checked={xp.ignoreRepeats} disabled={!xp.enabled} onChange={(e) => setXp({ ignoreRepeats: e.target.checked })} /> No XP for repeating the same message
        </label>
        <p className="muted small">
          {s.discord.contentAvailable
            ? 'Repeats are recognised (the bot receives message text).'
            : 'Repeats can only be recognised while the bot receives message text (the Message Content intent, e.g. turned on for Discord Logging). CONDUIT never turns it on for this; the cooldown always applies.'}{' '}
          Bots, webhooks and system messages never earn. XP is kept per server, also when a member leaves and comes back.
        </p>
        <LevelTable />
      </section>

      <section className="card" aria-labelledby="announce-title">
        <h2 id="announce-title">Level-up announcements</h2>
        <label className="inline-check">
          <input type="checkbox" checked={xp.announce.enabled} onChange={(e) => setAnnounce({ enabled: e.target.checked })} /> Announce when a member reaches a new level
        </label>
        <div className="segmented" role="radiogroup" aria-label="Where to announce">
          {(['same', 'fixed'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={(xp.announce.channelId === null) === (m === 'same')}
              className={`segment${(xp.announce.channelId === null) === (m === 'same') ? ' active' : ''}`}
              disabled={!xp.announce.enabled}
              onClick={() => (m === 'same' ? setAnnounce({ guildId: null, channelId: null }) : setAnnounce({ guildId: channels?.guilds[0]?.id ?? '', channelId: '' }))}
            >
              {m === 'same' ? 'In the channel where it happened' : 'In one channel'}
            </button>
          ))}
        </div>
        {xp.announce.channelId !== null && (
          <DiscordChannelPicker
            channels={channels}
            guildId={xp.announce.guildId ?? ''}
            channelId={xp.announce.channelId}
            needs={['viewChannel', 'sendMessages', ...(xp.announce.embed ? (['embedLinks'] as const) : [])]}
            onChange={(guildId, channelId) => setAnnounce({ guildId, channelId })}
            error={err('announce.channelId')}
          />
        )}
        <label className="field">
          <span className="field-label">Message text ({LEVEL_UP_VARIABLES.join(', ')}){xp.announce.embed ? ' — optional with an embed' : ''}</span>
          <textarea rows={2} value={xp.announce.template} maxLength={2000} disabled={!xp.announce.enabled} onChange={(e) => setAnnounce({ template: e.target.value })} placeholder={DEFAULT_LEVEL_UP_TEMPLATE} />
          {err('announce.template') && <span className="field-error">{err('announce.template')}</span>}
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={xp.announce.embed !== null} disabled={!xp.announce.enabled} onChange={(e) => setAnnounce({ embed: e.target.checked ? embedDraft : null })} /> Include an embed
        </label>
        {xp.announce.embed ? (
          <EmbedEditor
            value={xp.announce.embed}
            onChange={(embed) => {
              setEmbedDraft(embed);
              setAnnounce({ embed });
            }}
            variables={LEVEL_UP_VARIABLE_HELP}
            previewVars={LEVEL_UP_PREVIEW}
            preview={{ content: renderPreview(xp.announce.template), note: 'Sample values: alice reaching level 5.' }}
          />
        ) : (
          xp.announce.template && <EmbedPreview embed={null} content={renderPreview(xp.announce.template)} note="Sample values: alice reaching level 5." />
        )}
        {err('announce.embed') && <span className="field-error">{err('announce.embed')}</span>}
        <p className="muted small">Each level is announced once, even after a restart. {'{user}'} shows as a mention without notifying anyone. If a post fails, the XP and level are kept and the problem is shown on Overview.</p>
        <SaveRow busy={busy} error={error} saved={saved} onSave={() => void save()} />
      </section>

      <RoleRewardsSection s={s} onChanged={onChanged} />
    </div>
  );
}

/** Sample values for the announcement preview ({user} shows as the name, as Discord displays a mention). */
const LEVEL_UP_PREVIEW: Record<string, string> = { user: '@alice', username: 'alice', level: '5' };
const renderPreview = (text: string) => fillTemplate(text, LEVEL_UP_PREVIEW);

function LevelTable() {
  const levels = [1, 2, 3, 5, 10, 20, 30, 50];
  return (
    <details className="loyalty-formula">
      <summary className="small">How levels work</summary>
      <p className="small muted">
        Going from level L to the next takes 5 × L² + 50 × L + 100 XP (100, 155, 220, 295, …). A member’s level always follows from their total XP, so it is recalculated after any adjustment.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">Total XP needed</th>
            <th scope="col">XP for the next level</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => (
            <tr key={l}>
              <td>{l}</td>
              <td>{num(totalXpForLevel(l))}</td>
              <td>{num(xpForNextLevel(l))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function RoleRewardsSection({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const options = useAsync(() => api<LoyaltyRoleOptions>('GET', '/api/loyalty/roles'), []);
  const [guildId, setGuildId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [level, setLevel] = useState(5);
  const add = useAction(() => {
    setRoleId('');
    onChanged?.();
  });
  const guilds = options.data?.guilds ?? [];
  const guild = guilds.find((g) => g.id === guildId) ?? guilds[0];
  return (
    <section className="card" aria-labelledby="role-rewards-title">
      <h2 id="role-rewards-title">Role rewards</h2>
      <p className="muted small">
        Give a Discord role when a member reaches a level. The bot needs <strong>Manage Roles</strong>, and its own highest role must be above the role. Removing a role reward never takes the role away from members who already have it.
      </p>
      {s.roleRewards.length === 0 ? (
        <p className="empty-note">No role rewards yet.</p>
      ) : (
        <ul className="item-list">
          {s.roleRewards.map((r) => (
            <RoleRewardRow key={r.id} r={r} guilds={s.guilds} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {options.error ? (
        <p className="small text-bad" role="alert">
          {errorMessage(options.error)}
        </p>
      ) : !options.data ? (
        <p className="muted small">Loading roles…</p>
      ) : options.data.problem && guilds.length === 0 ? (
        <p className="small text-warn">{options.data.problem}</p>
      ) : (
        guild && (
          <div className="editor-row">
            {guilds.length > 1 && (
              <select aria-label="Server" value={guild.id} onChange={(e) => (setGuildId(e.target.value), setRoleId(''))}>
                {guilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            <select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Choose a role…</option>
              {guild.roles.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.assignable}>
                  {r.name}
                  {r.problem ? ` — ${r.problem}` : ''}
                </option>
              ))}
            </select>
            <span className="muted small">at level</span>
            <input aria-label="Level" className="num" type="number" min={1} max={1000} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
            <Button busy={add.busy} disabled={!roleId} onClick={() => void add.run(() => api('POST', '/api/loyalty/role-rewards', { guildId: guild.id, roleId, level }))}>
              Add role reward
            </Button>
          </div>
        )
      )}
      <ErrorLine error={add.error} />
    </section>
  );
}

function RoleRewardRow({ r, guilds, onChanged }: { r: LoyaltyState['roleRewards'][number]; guilds: readonly LoyaltyGuild[]; onChanged?: () => void }) {
  const { busy, error, run } = useAction(onChanged);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="item">
      <div className="item-main">
        <div className="item-title">
          <strong>Level {r.level}</strong>
          <span>→ {r.roleName ? `@${r.roleName}` : `Role ${r.roleId}`}</span>
          {guilds.length > 1 && <span className="muted small">in {guildName(guilds, r.guildId)}</span>}
        </div>
        {r.problem && <span className="small text-warn">{r.problem}</span>}
        <ErrorLine error={error} />
      </div>
      <div className="item-side">
        {confirm ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('DELETE', `/api/loyalty/role-rewards/${r.id}`))}>
            Remove
          </Button>
        ) : (
          <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setConfirm(true)}>
            Remove…
          </Button>
        )}
      </div>
    </li>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

function MembersPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const [guildId, setGuildId] = useState<string | null>(s.guilds[0]?.id ?? null);
  const [sort, setSort] = useState<'xp' | 'points'>('xp');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<LoyaltyMember | null>(null);
  const page = useAsync(() => api<LoyaltyMemberPage>('POST', '/api/loyalty/members/query', { guildId, sort, query: query || null, offset }), [guildId, sort, query, offset]);
  const refresh = () => {
    page.reload();
    onChanged?.();
  };
  const name = s.settings.pointsName;
  return (
    <div className="stack">
      <section className="card" aria-labelledby="members-title">
        <div className="card-head">
          <div>
            <h2 id="members-title">Members</h2>
            <p className="muted small">The leaderboard for a server. XP and levels are per server; {name} are one balance per Discord account.</p>
          </div>
        </div>
        <div className="editor-row">
          {s.guilds.length > 1 && (
            <select aria-label="Server" value={guildId ?? ''} onChange={(e) => (setGuildId(e.target.value), setOffset(0))}>
              {s.guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name ?? `Server ${g.id}`}
                </option>
              ))}
            </select>
          )}
          <input aria-label="Search members" placeholder="Search by name or id" value={query} maxLength={100} onChange={(e) => (setQuery(e.target.value), setOffset(0))} />
          <div className="segmented" role="radiogroup" aria-label="Sort">
            {(['xp', 'points'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={sort === k} className={`segment${sort === k ? ' active' : ''}`} onClick={() => (setSort(k), setOffset(0))}>
                {k === 'xp' ? 'By XP' : `By ${name}`}
              </button>
            ))}
          </div>
        </div>
        {page.error ? (
          <p className="small text-bad" role="alert">
            {errorMessage(page.error)}
          </p>
        ) : !page.data ? (
          <p className="muted">Loading members…</p>
        ) : page.data.members.length === 0 ? (
          <p className="empty-note">{query ? 'No members match.' : 'No members yet. They appear here after they chat while Loyalty is on.'}</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Member</th>
                    <th scope="col">Level</th>
                    <th scope="col">XP</th>
                    <th scope="col">Progress</th>
                    <th scope="col">{capitalize(name)}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {page.data.members.map((m) => (
                    <tr key={m.userId}>
                      <td className="muted small">{m.rank || '—'}</td>
                      <td>
                        <Who name={m.displayName} id={m.userId} />
                      </td>
                      <td>{m.progress.level}</td>
                      <td>{num(m.xp)}</td>
                      <td>
                        <ProgressBar p={m.progress} />
                      </td>
                      <td>{num(m.points)}</td>
                      <td className="actions">
                        <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setSelected(m)}>
                          History &amp; adjust
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="button-row">
              <span className="muted small">
                {page.data.offset + 1}–{page.data.offset + page.data.members.length} of {page.data.total}
              </span>
              <Button variant="ghost" disabled={page.data.offset === 0} onClick={() => setOffset(Math.max(0, offset - page.data!.pageSize))}>
                Previous
              </Button>
              <Button variant="ghost" disabled={page.data.offset + page.data.members.length >= page.data.total} onClick={() => setOffset(offset + page.data!.pageSize)}>
                Next
              </Button>
            </div>
          </>
        )}
      </section>
      {selected && <MemberDetail key={selected.userId} member={selected} s={s} onClose={() => setSelected(null)} onChanged={refresh} />}
    </div>
  );
}

function MemberDetail({ member, s, onClose, onChanged }: { member: LoyaltyMember; s: LoyaltyState; onClose: () => void; onChanged: () => void }) {
  const history = useAsync(() => api<LoyaltyMemberHistory>('POST', '/api/loyalty/members/history', { userId: member.userId }), [member.userId]);
  const name = s.settings.pointsName;
  const h = history.data;
  const reload = () => {
    history.reload();
    onChanged();
  };
  return (
    <section className="card editor-card" aria-labelledby="member-detail-title">
      <div className="card-head">
        <div>
          <h2 id="member-detail-title">
            <Who name={h?.displayName ?? member.displayName} id={member.userId} />
          </h2>
          <p className="muted small">
            {h ? `${formatPoints(h.points.balance, name)} · earned ${num(h.points.lifetimeEarned)} in total · ` : ''}Discord id {member.userId}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {h && h.levels.length > 0 && (
        <ul className="loyalty-status">
          {h.levels.map((l) => (
            <li key={l.guildId} className="small">
              {guildName(s.guilds, l.guildId)}: level {l.progress.level}, {num(l.xp)} XP{l.rank ? ` (rank #${l.rank})` : ''} <ProgressBar p={l.progress} />
            </li>
          ))}
        </ul>
      )}
      <Adjuster
        legend={`Adjust ${name}`}
        unit={name}
        schema={(amount, reason) => pointsAdjustmentSchema.safeParse({ userId: member.userId, amount, reason })}
        submit={(body) => api('POST', '/api/loyalty/members/points', body)}
        onDone={reload}
      />
      <Adjuster
        legend={`Adjust XP in ${guildName(s.guilds, member.guildId)}`}
        unit="XP"
        note="The level is recalculated from the new total; role rewards follow if it goes up. Adjustments are never announced."
        schema={(amount, reason) => xpAdjustmentSchema.safeParse({ guildId: member.guildId, userId: member.userId, amount, reason })}
        submit={(body) => api('POST', '/api/loyalty/members/xp', body)}
        onDone={reload}
      />
      {history.error ? (
        <p className="small text-bad" role="alert">
          {errorMessage(history.error)}
        </p>
      ) : !h ? (
        <p className="muted">Loading history…</p>
      ) : (
        <div className="status-columns">
          <div>
            <h3>{capitalize(name)}</h3>
            {h.transactions.length === 0 ? (
              <p className="empty-note">No {name} changes yet.</p>
            ) : (
              <table className="table">
                <tbody>
                  {h.transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="small muted">{new Date(t.createdAt).toLocaleString()}</td>
                      <td className="small">{t.reason ?? KIND_LABEL[t.kind]}</td>
                      <td className={t.amount > 0 ? 'text-ok' : 'text-bad'}>{signed(t.amount)}</td>
                      <td>{num(t.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3>XP</h3>
            {h.xpEvents.length === 0 ? (
              <p className="empty-note">No XP yet.</p>
            ) : (
              <table className="table">
                <tbody>
                  {h.xpEvents.map((e) => (
                    <tr key={e.id}>
                      <td className="small muted">{new Date(e.createdAt).toLocaleString()}</td>
                      <td className="small">{e.kind === 'message' ? 'Message' : (e.reason ?? 'Adjustment')}</td>
                      <td className={e.amount > 0 ? 'text-ok' : 'text-bad'}>{signed(e.amount)}</td>
                      <td className="small">level {e.levelAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Adjuster({
  legend,
  unit,
  note,
  schema,
  submit,
  onDone,
}: {
  legend: string;
  unit: string;
  note?: string;
  schema: (amount: number, reason: string) => { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  submit: (body: unknown) => Promise<unknown>;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction(onDone);
  const go = async (sign: 1 | -1) => {
    setDone(null);
    const value = Math.trunc(Number(amount));
    if (!(value > 0)) return setFieldErrors({ amount: `Enter a number of ${unit} above 0` });
    const checked = schema(sign * value, reason);
    if (!checked.success) return setFieldErrors(Object.fromEntries(checked.error.issues.map((i) => [String(i.path[0]), i.message])));
    setFieldErrors({});
    if (await run(() => submit(checked.data))) {
      setDone(`${sign > 0 ? 'Added' : 'Removed'} ${num(value)} ${unit}.`);
      setAmount('');
      setReason('');
    }
  };
  return (
    <fieldset className="editor-block">
      <legend>{legend}</legend>
      <div className="editor-row">
        <input aria-label={`${legend}: amount`} className="num" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={unit} />
        <input aria-label={`${legend}: reason`} placeholder="Reason (required, kept in the history)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        <Button busy={busy} onClick={() => void go(1)}>
          Add
        </Button>
        <Button variant="secondary" busy={busy} onClick={() => void go(-1)}>
          Remove
        </Button>
      </div>
      {note && <p className="muted small">{note}</p>}
      {fieldErrors.amount && <span className="field-error">{fieldErrors.amount}</span>}
      {fieldErrors.reason && <span className="field-error">{fieldErrors.reason}</span>}
      <ErrorLine error={error} />
      {done && (
        <span className="small text-ok" role="status">
          {done}
        </span>
      )}
    </fieldset>
  );
}

// ── Points & Earning ─────────────────────────────────────────────────────────

function PointsPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const { d, setD, errors, saved, save, busy, error } = useSettingsDraft(s, onChanged);
  const c = d.discord;
  const set = (patch: Partial<LoyaltySettings['discord']>) => setD({ ...d, discord: { ...d.discord, ...patch } });
  return (
    <section className="card" aria-labelledby="points-title">
      <h2 id="points-title">{capitalize(d.pointsName || 'points')} &amp; earning</h2>
      <p className="muted small">
        {capitalize(d.pointsName || 'points')} are spent on rewards. They are separate from XP: earning XP never gives {d.pointsName}, and spending {d.pointsName} never takes XP. Administrators can always add or remove {d.pointsName} under Members.
      </p>
      <label className="field">
        <span className="field-label">What points are called</span>
        <input value={d.pointsName} maxLength={20} onChange={(e) => setD({ ...d, pointsName: e.target.value })} />
        {errors.pointsName && <span className="field-error">{errors.pointsName}</span>}
      </label>
      <fieldset className="editor-block">
        <legend>From messages</legend>
        <label className="inline-check">
          <input type="checkbox" checked={c.earn} onChange={(e) => set({ earn: e.target.checked })} /> Messages also earn {d.pointsName} (in addition to XP)
        </label>
        <div className="editor-row">
          <input aria-label="Points per message" className="num" type="number" min={1} max={1000} value={c.pointsPerMessage} disabled={!c.earn} onChange={(e) => set({ pointsPerMessage: Number(e.target.value) })} />
          <span className="muted small">per message, at most once every</span>
          <input aria-label="Points cooldown seconds" className="num" type="number" min={10} max={3600} value={c.cooldownSeconds} disabled={!c.earn} onChange={(e) => set({ cooldownSeconds: Number(e.target.value) })} />
          <span className="muted small">seconds per member</span>
        </div>
        <div className="editor-row">
          <span className="muted small">Daily limit per member</span>
          <input aria-label="Points daily limit" className="num" type="number" min={0} value={c.dailyLimit} disabled={!c.earn} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} />
          <span className="muted small">(0 = no limit; days are UTC)</span>
        </div>
        {Object.entries(errors)
          .filter(([k]) => k.startsWith('discord.'))
          .map(([k, m]) => (
            <span key={k} className="field-error">
              {m}
            </span>
          ))}
      </fieldset>
      <fieldset className="editor-block">
        <legend>Discord commands</legend>
        <label className="inline-check">
          <input type="checkbox" checked={c.commands} onChange={(e) => set({ commands: e.target.checked })} /> Register <code>/points</code>, <code>/rewards</code>, <code>/redeem</code>
          {d.xp.enabled && (
            <>
              , <code>/level</code> and <code>/leaderboard</code>
            </>
          )}{' '}
          (private replies)
        </label>
        {s.discord.commandConflicts.length > 0 && <span className="small text-warn">Your custom {s.discord.commandConflicts.join(', ')} command is used instead of the loyalty one.</span>}
      </fieldset>
      <SaveRow busy={busy} error={error} saved={saved} onSave={() => void save()} />
    </section>
  );
}

// ── Rewards ──────────────────────────────────────────────────────────────────

type Editing = { mode: 'new' } | { mode: 'edit'; reward: LoyaltyRewardView } | null;

function RewardsPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <div className="stack">
      <section className="card" aria-labelledby="rewards-title">
        <div className="card-head">
          <div>
            <h2 id="rewards-title">Rewards</h2>
            <p className="muted small">
              Members redeem with <code>/redeem</code> on Discord. You deliver each reward yourself; CONDUIT only takes the {s.settings.pointsName} and lists the redemption.
            </p>
          </div>
          {!editing && <Button onClick={() => setEditing({ mode: 'new' })}>New reward</Button>}
        </div>
        {s.rewards.length === 0 && !editing ? (
          <p className="empty-note">No rewards yet.</p>
        ) : (
          <ul className="item-list">
            {s.rewards.map((r) => (
              <RewardRow key={r.id} r={r} pointsName={s.settings.pointsName} onEdit={() => setEditing({ mode: 'edit', reward: r })} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <RewardEditor
          key={editing.mode === 'edit' ? editing.reward.id : 'new'}
          initial={editing.mode === 'edit' ? editing.reward : null}
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

function RewardRow({ r, pointsName, onEdit, onChanged }: { r: LoyaltyRewardView; pointsName: string; onEdit: () => void; onChanged?: () => void }) {
  const { busy, error, run } = useAction(onChanged);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className={`item${r.enabled ? '' : ' item-off'}`}>
      <label className="switch">
        <input type="checkbox" aria-label={`${r.name}: ${r.enabled ? 'on' : 'off'}`} checked={r.enabled} disabled={busy} onChange={(e) => void run(() => api('PATCH', `/api/loyalty/rewards/${r.id}`, { enabled: e.target.checked }))} />
      </label>
      <div className="item-main">
        <div className="item-title">
          <strong>{r.name}</strong>
          <span className="muted small">{formatPoints(r.cost, pointsName)}</span>
        </div>
        {r.description && <div className="muted small">{r.description}</div>}
        <ErrorLine error={error} />
      </div>
      <div className="item-side">
        <span className={`pill ${r.stock === 0 ? 'pill-bad' : 'pill-muted'}`}>{r.stock === null ? 'Unlimited' : r.stock === 0 ? 'Sold out' : `${r.stock} left`}</span>
        <Button variant="ghost" className="btn btn-ghost btn-small" onClick={onEdit}>
          Edit
        </Button>
        {confirm ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('DELETE', `/api/loyalty/rewards/${r.id}`))}>
            Remove
          </Button>
        ) : (
          <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setConfirm(true)}>
            Remove…
          </Button>
        )}
      </div>
    </li>
  );
}

function RewardEditor({ initial, onClose, onSaved }: { initial: LoyaltyRewardView | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [cost, setCost] = useState(initial?.cost ?? 500);
  const [limited, setLimited] = useState(initial ? initial.stock !== null : false);
  const [stock, setStock] = useState(initial?.stock ?? 10);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setFailure(null);
    const body = { name, description: description || null, cost, enabled, stock: limited ? stock : null };
    const checked = rewardSchema.safeParse(body);
    if (!checked.success) return setErrors(Object.fromEntries(checked.error.issues.map((i) => [String(i.path[0]), i.message])));
    setErrors({});
    setBusy(true);
    try {
      if (initial) await api('PATCH', `/api/loyalty/rewards/${initial.id}`, body);
      else await api('POST', '/api/loyalty/rewards', body);
      onSaved();
    } catch (e) {
      if (e instanceof ApiClientError && e.issues.length) setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card editor-card" aria-labelledby="reward-editor-title">
      <h2 id="reward-editor-title">{initial ? `Edit “${initial.name}”` : 'New reward'}</h2>
      <div className="editor-grid">
        <label className="field">
          <span className="field-label">Name (what members type in /redeem)</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>
        <label className="field">
          <span className="field-label">Cost</span>
          <input className="num" type="number" min={1} value={cost} onChange={(e) => setCost(Number(e.target.value))} />
          {errors.cost && <span className="field-error">{errors.cost}</span>}
        </label>
      </div>
      <label className="field">
        <span className="field-label">Description (optional, shown here only)</span>
        <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        {errors.description && <span className="field-error">{errors.description}</span>}
      </label>
      <div className="editor-row">
        <label className="inline-check">
          <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /> Limited quantity
        </label>
        <input aria-label="Quantity left" className="num" type="number" min={0} value={stock} disabled={!limited} onChange={(e) => setStock(Number(e.target.value))} />
        <span className="muted small">left (a rejected redemption puts one back)</span>
      </div>
      {errors.stock && <span className="field-error">{errors.stock}</span>}
      <div className="card-foot">
        <label className="inline-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Available
        </label>
        <ErrorLine error={failure} />
        <div className="button-row">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Redemptions ──────────────────────────────────────────────────────────────

function RedemptionsPanel({ s, onChanged }: { s: LoyaltyState; onChanged?: () => void }) {
  const pending = s.redemptions.filter((r) => r.status === 'pending');
  const done = s.redemptions.filter((r) => r.status !== 'pending');
  return (
    <div className="stack">
      <section className="card" aria-labelledby="pending-title">
        <h2 id="pending-title">Waiting for you</h2>
        <p className="muted small">The {s.settings.pointsName} are taken when a member redeems. Deliver the reward yourself, then mark it fulfilled — or reject it to give the {s.settings.pointsName} back.</p>
        {pending.length === 0 ? (
          <p className="empty-note">No redemptions waiting.</p>
        ) : (
          <ul className="item-list">
            {pending.map((r) => (
              <PendingRow key={r.id} r={r} pointsName={s.settings.pointsName} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="resolved-title">
        <h2 id="resolved-title">Fulfilled and rejected</h2>
        {done.length === 0 ? (
          <p className="empty-note">Nothing handled yet.</p>
        ) : (
          <ul className="item-list">
            {done.map((r) => (
              <li key={r.id} className="item item-off">
                <div className="item-main">
                  <div className="item-title">
                    <Who name={r.displayName} id={r.userId} />
                    <span className="small">{r.rewardName}</span>
                    {r.platform === 'kick' && <span className="muted small">(older Kick redemption)</span>}
                  </div>
                  {r.note && <span className="muted small">{r.note}</span>}
                </div>
                <div className="item-side">
                  <span className={`pill ${r.status === 'fulfilled' ? 'pill-ok' : 'pill-muted'}`}>{r.status === 'fulfilled' ? 'Fulfilled' : 'Rejected · refunded'}</span>
                  <span className="muted small">{r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : ''}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PendingRow({ r, pointsName, onChanged }: { r: LoyaltyRedemptionView; pointsName: string; onChanged?: () => void }) {
  const { busy, error, run } = useAction(onChanged);
  const [note, setNote] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);
  return (
    <li className="item">
      <div className="item-main">
        <div className="item-title">
          <Who name={r.displayName} id={r.userId} />
          <strong>{r.rewardName}</strong>
          <span className="muted small">{formatPoints(r.cost, pointsName)}</span>
        </div>
        <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
        <input aria-label="Note (optional)" placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        <ErrorLine error={error} />
      </div>
      <div className="item-side">
        <Button className="btn btn-primary btn-small" busy={busy} onClick={() => void run(() => api('POST', `/api/loyalty/redemptions/${r.id}/fulfill`, { note: note || null }))}>
          Mark fulfilled
        </Button>
        {confirmReject ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('POST', `/api/loyalty/redemptions/${r.id}/reject`, { note: note || null }))}>
            Reject &amp; refund {num(r.cost)}
          </Button>
        ) : (
          <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setConfirmReject(true)}>
            Reject…
          </Button>
        )}
      </div>
    </li>
  );
}

function signed(n: number): string {
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
