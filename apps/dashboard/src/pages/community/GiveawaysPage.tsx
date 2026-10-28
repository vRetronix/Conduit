import { useState } from 'react';
import {
  createGiveawaySchema,
  EDITABLE_FIELDS,
  GIVEAWAY_DESCRIPTION_MAX,
  GIVEAWAY_DURATION_MAX_MINUTES,
  GIVEAWAY_PLATFORMS,
  GIVEAWAY_PRIZE_MAX,
  GIVEAWAY_WINNERS_MAX,
  KICK_REWARD_DEFAULTS,
  KICK_GIVEAWAY_MESSAGE_KINDS,
  KICK_REWARD_TITLE_MAX,
  type DiscordChannelRef,
  type DiscordChannelsState,
  type GiveawayPlatform,
  type GiveawaysState,
  type GiveawayStatus,
  type GiveawayView,
} from '@conduit/shared/community/giveaways';
import { api, ApiClientError, errorMessage } from '../../api';
import { BrowserTabs } from '../../components/BrowserTabs';
import { Button, Field, fieldError, Loading, schemaFieldErrors } from '../../components/forms';
import { Pager, usePaged } from '../../components/Pager';
import { KickGiveawayMessagesCard } from '../../components/kick/KickGiveawayMessages';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 3000;
const PLATFORM_LABEL: Record<GiveawayPlatform, string> = { kick: 'Kick', discord: 'Discord' };
const MULTIPLIERS = [1, 2, 3, 4, 5] as const;

const STATUS_LABEL: Record<GiveawayStatus, string> = {
  draft: 'Not started',
  open: 'Running',
  closed: 'Entries closed',
  drawn: 'Completed',
  cancelled: 'Cancelled',
};
const STATUS_PILL: Record<GiveawayStatus, string> = {
  draft: 'pill-muted',
  open: 'pill-ok',
  closed: 'pill-warn',
  drawn: 'pill-ok',
  cancelled: 'pill-muted',
};

/** Giveaways: start giveaways and run them; viewers enter from Kick chat (!enter) and Discord (the embed's buttons). */
export function GiveawaysPage() {
  const backend = useBackendStatus();
  const running = backend?.state === 'running';
  const { data, error, reload } = useAsync(() => api<GiveawaysState>('GET', '/api/giveaways'), [running]);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading giveaways…'} />;
  return <GiveawaysView s={data} onChanged={reload} />;
}

/**
 * Giveaways, on two browser-style tabs: **Giveaways** (the one running, then the completed ones as a compact list that
 * opens for details) and **Kick Messages** (what the chatbot posts). How viewers enter is a one-line hint.
 */
export function GiveawaysView({ s, onChanged, initialTab = 'giveaways' }: { s: GiveawaysState; onChanged?: () => void; initialTab?: 'giveaways' | 'messages' }) {
  const [tab, setTab] = useState(initialTab);
  const [creating, setCreating] = useState(false);
  // Active: running, entries closed (waiting for the draw), and drafts left by an earlier version.
  const active = s.giveaways.filter((g) => g.status === 'open' || g.status === 'closed' || g.status === 'draft');
  const completed = s.giveaways.filter((g) => g.status === 'drawn');
  const paged = usePaged(completed);
  return (
    <div className="stack">
      <BrowserTabs
        idPrefix="giveaways"
        label="Giveaways"
        tabs={[
          { id: 'giveaways', label: 'Giveaways', count: active.length + completed.length },
          { id: 'messages', label: 'Kick Messages', count: KICK_GIVEAWAY_MESSAGE_KINDS.length },
        ]}
        active={tab}
        onChange={setTab}
        panels={{
          giveaways: (
            <div className="stack">
              {!creating && (
                <div className="commands-actions">
                  <Button onClick={() => setCreating(true)}>New giveaway</Button>
                </div>
              )}
              {creating && (
                <GiveawayEditor
                  initial={null}
                  defaultChannel={s.discordChannelDefault}
                  kickRewards={s.kickRewards}
                  onCancel={() => setCreating(false)}
                  onSaved={() => {
                    setCreating(false);
                    onChanged?.();
                  }}
                />
              )}

              <section aria-labelledby="giveaways-active">
                <h3 id="giveaways-active" className="giveaway-group">
                  Current giveaway
                </h3>
                {active.length === 0 ? (
                  <p className="empty-note">No giveaway is running. Start one with New giveaway; it’s announced on the platforms you pick.</p>
                ) : (
                  active.map((g) => <GiveawayCard key={g.id} g={g} onChanged={onChanged} />)
                )}
              </section>

              <section aria-labelledby="giveaways-completed">
                <h3 id="giveaways-completed" className="giveaway-group">
                  Completed
                </h3>
                {completed.length === 0 ? (
                  <p className="empty-note">Completed giveaways stay here with their winners and draw history.</p>
                ) : (
                  <div className="giveaway-rows">
                    {paged.rows.map((g) => (
                      <details key={g.id} className="giveaway-row">
                        <summary>
                          <span className="giveaway-row-prize">{g.prize}</span>
                          <span className="muted small">
                            {g.drawnAt ? formatTime(g.drawnAt) : ''} · {g.entryCount} {g.entryCount === 1 ? 'entry' : 'entries'} ·{' '}
                            {winnerNames(g) || 'no winners'}
                          </span>
                        </summary>
                        <GiveawayCard g={g} onChanged={onChanged} inset />
                      </details>
                    ))}
                  </div>
                )}
                <Pager {...paged} label="Completed giveaways" />
              </section>
            </div>
          ),
          messages: <KickGiveawayMessagesCard key={JSON.stringify(s.kickMessages)} saved={s.kickMessages} onSaved={() => onChanged?.()} bare />,
        }}
      />
    </div>
  );
}

/** The current winners' names, for a completed giveaway's row. */
function winnerNames(g: GiveawayView): string {
  return g.winners
    .filter((w) => w.status === 'won')
    .map((w) => w.displayName)
    .join(', ');
}

type Confirm = { action: 'cancel' | 'draw' | 'delete' } | { action: 'redraw'; winnerId: string; name: string } | null;

/** One giveaway. `inset`: inside a completed row (no card of its own, and the row already shows the prize). */
export function GiveawayCard({ g, onChanged, inset = false }: { g: GiveawayView; onChanged?: () => void; inset?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/giveaways/${g.id}`;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
      setReason('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      onChanged?.();
    }
  }

  const current = g.winners.filter((w) => w.status === 'won');
  const canEdit = EDITABLE_FIELDS[g.status].length > 0;
  const running = g.status === 'open' || g.status === 'closed' || g.status === 'draft';

  return (
    <article className={inset ? 'giveaway-card giveaway-inset' : 'giveaway-card giveaway-current'} aria-label={`Giveaway: ${g.prize}`}>
      {!inset && (
        <div className="commands-head">
          <h4 className="giveaway-prize">{g.prize}</h4>
          <span className={`pill ${STATUS_PILL[g.status]}`}>{STATUS_LABEL[g.status]}</span>
        </div>
      )}
      {g.description && <p className="giveaway-description">{g.description}</p>}

      {editing ? (
        <GiveawayEditor
          initial={g}
          defaultChannel={null}
          kickRewards={null}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged?.();
          }}
        />
      ) : (
        <ul className="facts">
          <li>
            <strong>Entry on:</strong> {g.platforms.map((p) => PLATFORM_LABEL[p]).join(' and ')} · <strong>Winners:</strong> {g.winnerCount}
          </li>
          {g.status === 'open' && (
            <li>
              <strong>Time remaining:</strong> {g.endsAt ? remaining(g.endsAt) : 'until you end entries'}
            </li>
          )}
          {g.status === 'closed' && <li className="text-warn">Entries are closed. Draw the winners when you’re ready.</li>}
          <li>
            <strong>Entries (private):</strong> {g.entryCount}
            {g.platforms.length > 1 && (
              <span className="muted"> ({g.platforms.map((p) => `${PLATFORM_LABEL[p]} ${g.entriesByPlatform[p]}`).join(' · ')})</span>
            )}{' '}
            · <strong>Tickets:</strong> {g.ticketCount}
            {g.subscriberMultiplier > 1 && (
              <span className="muted">
                {' '}
                · {g.subscriberMultiplier}× for verified Kick subscribers ({g.verifiedSubscribers})
              </span>
            )}
          </li>
          {g.kickReward && (
            <li className="small">
              <strong>Channel Points reward:</strong> “{g.kickReward.title}” · {g.kickReward.cost} points for {g.kickReward.tickets} bonus{' '}
              {g.kickReward.tickets === 1 ? 'ticket' : 'tickets'} · {g.kickReward.accepted} accepted, {g.kickReward.rejected} rejected
              {g.kickReward.status && <span className="muted"> · {REWARD_STATUS[g.kickReward.status]}</span>}
              {g.kickReward.detail && <div className="field-hint text-warn">{g.kickReward.detail}</div>}
            </li>
          )}
          <li className="muted small">
            Started {formatTime(g.startedAt ?? g.createdAt)}
            {g.closedAt && ` · entries closed ${formatTime(g.closedAt)}`}
            {g.drawnAt && ` · completed ${formatTime(g.drawnAt)}`}
          </li>
          {g.platforms.includes('discord') && <DiscordAnnouncementLine g={g} busy={busy} onRetry={() => void run(() => api('POST', `${base}/discord/retry`))} />}
          {g.announcement && (
            <li className="small">
              <strong>Kick announcement ({g.announcement.kind}):</strong>{' '}
              <span className={g.announcement.outcome === 'sent' ? 'text-ok' : g.announcement.outcome === 'skipped' ? 'muted' : 'text-warn'}>
                {ANNOUNCEMENT_LABEL[g.announcement.outcome]}
              </span>
              {g.announcement.detail && <span className="muted"> · {g.announcement.detail}</span>}
            </li>
          )}
        </ul>
      )}

      {g.winners.length > 0 && (
        <div className="giveaway-winners">
          <h4>Winners</h4>
          <ol className="winner-list">
            {current.map((w) => (
              <li key={w.id}>
                <span className="winner-name">{w.displayName}</span> <span className="badge">{PLATFORM_LABEL[w.platform]}</span>{' '}
                <span className="muted small">#{w.position}</span>
                {g.status === 'drawn' && confirm === null && (
                  <Button variant="ghost" onClick={() => setConfirm({ action: 'redraw', winnerId: w.id, name: w.displayName })}>
                    Redraw
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <details className="small">
            <summary>Draw history ({g.draws.length} {g.draws.length === 1 ? 'draw' : 'draws'})</summary>
            <ul className="facts">
              {g.draws.map((d) => {
                const old = d.replacedWinnerId ? g.winners.find((w) => w.id === d.replacedWinnerId) : null;
                return (
                  <li key={d.id}>
                    {formatTime(d.drawnAt)} — {d.kind === 'initial' ? 'Draw' : `Redraw for #${old?.position ?? '?'}`} from {d.poolSize}{' '}
                    {d.poolSize === 1 ? 'entry' : 'entries'}
                    {d.poolTickets !== null && ` (${d.poolTickets} tickets)`}
                    {old && <span className="muted"> · replaced {old.displayName}</span>}
                    {d.reason && <span className="muted"> · “{d.reason}”</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        </div>
      )}

      {confirm && (
        <div className="confirm-row" role="group" aria-label="Confirm">
          {confirm.action === 'cancel' && (
            <span className="small">Cancel and delete this giveaway? Its entries and history are deleted. This can’t be undone.</span>
          )}
          {confirm.action === 'delete' && (
            <span className="small">Delete this completed giveaway? Its entries, winners and draw history are deleted; the Discord post stays. This can’t be undone.</span>
          )}
          {confirm.action === 'draw' && (
            <span className="small">
              Draw {g.winnerCount} {g.winnerCount === 1 ? 'winner' : 'winners'} from {g.entryCount} {g.entryCount === 1 ? 'entry' : 'entries'} (
              {g.ticketCount} tickets)? {g.status === 'open' && 'Entries close first. '}This can’t be undone.
            </span>
          )}
          {confirm.action === 'redraw' && (
            <>
              <span className="small">Replace {confirm.name} with a new random winner? {confirm.name} stays in the draw history.</span>
              <input aria-label="Reason (optional)" placeholder="Reason (optional)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </>
          )}
          <span className="button-row">
            <Button
              variant={confirm.action === 'cancel' || confirm.action === 'delete' ? 'danger' : 'primary'}
              busy={busy}
              onClick={() =>
                void run(() =>
                  confirm.action === 'redraw'
                    ? api('POST', `${base}/redraw`, { winnerId: confirm.winnerId, reason })
                    : confirm.action === 'delete'
                      ? api('DELETE', base)
                      : api('POST', `${base}/${confirm.action}`),
                )
              }
            >
              {confirm.action === 'cancel' ? 'Cancel and delete' : confirm.action === 'delete' ? 'Delete' : confirm.action === 'draw' ? 'Draw winners' : 'Redraw'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep as is
            </Button>
          </span>
        </div>
      )}

      {!editing && !confirm && running && (
        <div className="button-row">
          {g.status === 'draft' && (
            <Button busy={busy} onClick={() => void run(() => api('POST', `${base}/start`))}>
              Start
            </Button>
          )}
          {g.status === 'open' && (
            <Button variant="secondary" busy={busy} onClick={() => void run(() => api('POST', `${base}/end`))}>
              End entries
            </Button>
          )}
          {(g.status === 'open' || g.status === 'closed') && (
            <Button busy={busy} disabled={g.entryCount === 0} onClick={() => setConfirm({ action: 'draw' })}>
              Draw winners
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button variant="ghost" onClick={() => setConfirm({ action: 'cancel' })}>
            Cancel
          </Button>
        </div>
      )}
      {!confirm && g.status === 'drawn' && (
        <div className="button-row">
          <Button variant="ghost" className="btn-row-delete" onClick={() => setConfirm({ action: 'delete' })}>
            Delete giveaway
          </Button>
        </div>
      )}
      {(g.status === 'open' || g.status === 'closed') && g.entryCount === 0 && (
        <p className="muted small">Nobody has entered yet, so there is nothing to draw.</p>
      )}
      {error && (
        <p className="connection-note note-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

const REWARD_STATUS: Record<NonNullable<NonNullable<GiveawayView['kickReward']>['status']>, string> = {
  active: 'redeemable on Kick',
  paused: 'paused on Kick',
  removed: 'removed from Kick',
  failed: 'needs attention',
};

/** The Discord embed's state on a giveaway card, with Retry/Repost when it needs attention. */
function DiscordAnnouncementLine({ g, busy, onRetry }: { g: GiveawayView; busy: boolean; onRetry: () => void }) {
  const d = g.discord;
  if (!d) {
    return (
      <li className="small">
        <strong>Discord announcement:</strong> <span className="text-warn">no channel chosen.</span>
      </li>
    );
  }
  const where = d.channelName ? `#${d.channelName}` : 'the chosen channel';
  const canPost = g.status !== 'draft';
  if (d.status === 'failed' || d.status === 'missing') {
    return (
      <li className="small">
        <strong>Discord announcement ({where}):</strong>{' '}
        <span className="text-bad">{d.status === 'missing' ? 'Not found in Discord' : 'Needs attention'}</span>
        <div className="connection-note note-error" role="alert">
          {d.detail}
        </div>
        {canPost && (
          <Button variant="secondary" busy={busy} onClick={onRetry}>
            {d.status === 'missing' || !d.messageId ? 'Repost announcement' : 'Retry'}
          </Button>
        )}
      </li>
    );
  }
  return (
    <li className="small">
      <strong>Discord announcement:</strong>{' '}
      {d.messageId ? (
        <>
          <span className="text-ok">Posted in {where}</span>
          {d.updatedAt && <span className="muted"> · updated {formatTime(d.updatedAt)}</span>}
        </>
      ) : g.status === 'draft' ? (
        <span className="muted">posted in {where} when you start the giveaway</span>
      ) : (
        <>
          <span className="text-warn">Not posted</span>{' '}
          {canPost && (
            <Button variant="secondary" busy={busy} onClick={onRetry}>
              Post announcement
            </Button>
          )}
        </>
      )}
    </li>
  );
}

const ANNOUNCEMENT_LABEL: Record<NonNullable<GiveawayView['announcement']>['outcome'], string> = {
  sent: 'Posted',
  failed: 'Not posted',
  unconfirmed: 'Not confirmed',
  skipped: 'Skipped',
};

interface FormState {
  prize: string;
  description: string;
  winnerCount: string;
  durationMinutes: string;
  platforms: GiveawayPlatform[];
  discordChannel?: string;
  rewardEnabled?: boolean;
  rewardTitle?: string;
  rewardCost?: string;
  rewardTickets?: string;
  subscriberMultiplier?: string;
}

/** Field errors from the shared schema (the same rules the backend applies). */
export function checkGiveawayForm(f: FormState): Record<string, string> {
  const errors = schemaFieldErrors(createGiveawaySchema, toBody(f));
  // Discord entries are made with the embed’s buttons, so Discord needs its announcement channel.
  if (f.platforms.includes('discord') && !channelRef(f.discordChannel ?? '')) errors.discordChannel ??= 'Choose the channel for the giveaway embed';
  return errors;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s));

function toBody(f: FormState) {
  const kick = f.platforms.includes('kick');
  return {
    prize: f.prize,
    description: f.description,
    winnerCount: num(f.winnerCount),
    durationMinutes: f.durationMinutes.trim() === '' ? null : Number(f.durationMinutes),
    platforms: f.platforms,
    discordChannel: f.platforms.includes('discord') ? channelRef(f.discordChannel ?? '') : null,
    kickReward: kick && f.rewardEnabled ? { title: f.rewardTitle ?? '', cost: num(f.rewardCost), tickets: num(f.rewardTickets) } : null,
    subscriberMultiplier: kick ? Number(f.subscriberMultiplier ?? '1') : 1,
  };
}

/** "guildId:channelId" (the select's value) ↔ a channel reference. */
const channelKey = (ref: DiscordChannelRef) => (ref ? `${ref.guildId}:${ref.channelId}` : '');
function channelRef(key: string): DiscordChannelRef {
  const [guildId, channelId] = key.split(':');
  return guildId && channelId ? { guildId, channelId } : null;
}

/**
 * New giveaway (Start Giveaway: one step, no drafts) or editing a running one (prize, description, number of winners;
 * the rest is fixed once it started).
 */
export function GiveawayEditor({
  initial,
  defaultChannel,
  kickRewards,
  onCancel,
  onSaved,
}: {
  initial: GiveawayView | null;
  defaultChannel: DiscordChannelRef;
  kickRewards: GiveawaysState['kickRewards'] | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [prize, setPrize] = useState(initial?.prize ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [winnerCount, setWinnerCount] = useState(String(initial?.winnerCount ?? 1));
  const [durationMinutes, setDurationMinutes] = useState(initial?.durationMinutes == null ? '' : String(initial.durationMinutes));
  const [platforms, setPlatforms] = useState<GiveawayPlatform[]>(initial?.platforms ?? ['kick', 'discord']);
  const [discordChannel, setDiscordChannel] = useState(
    channelKey(initial ? (initial.discord ? { guildId: initial.discord.guildId, channelId: initial.discord.channelId } : null) : defaultChannel),
  );
  const [rewardEnabled, setRewardEnabled] = useState(false);
  const [rewardTitle, setRewardTitle] = useState<string>(KICK_REWARD_DEFAULTS.title);
  const [rewardCost, setRewardCost] = useState(String(KICK_REWARD_DEFAULTS.cost));
  const [rewardTickets, setRewardTickets] = useState(String(KICK_REWARD_DEFAULTS.tickets));
  const [subscriberMultiplier, setSubscriberMultiplier] = useState('1');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const isNew = initial === null;
  const editable = initial ? EDITABLE_FIELDS[initial.status] : null;
  const err = (field: string) => fieldError(field, errors, serverError);

  async function save() {
    setServerError(null);
    if (isNew) {
      const form: FormState = {
        prize,
        description,
        winnerCount,
        durationMinutes,
        platforms,
        discordChannel,
        rewardEnabled,
        rewardTitle,
        rewardCost,
        rewardTickets,
        subscriberMultiplier,
      };
      const found = checkGiveawayForm(form);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
      setSaving(true);
      try {
        await api('POST', '/api/giveaways', toBody(form));
        onSaved();
      } catch (e) {
        setServerError(e);
      } finally {
        setSaving(false);
      }
      return;
    }
    const body = Object.fromEntries(
      Object.entries({ prize, description, winnerCount: num(winnerCount) }).filter(([k]) => (editable as readonly string[]).includes(k)),
    );
    setSaving(true);
    try {
      await api('PATCH', `/api/giveaways/${initial!.id}`, body);
      onSaved();
    } catch (e) {
      setServerError(e);
    } finally {
      setSaving(false);
    }
  }

  const kick = platforms.includes('kick');

  return (
    <form
      className="giveaway-editor stack"
      aria-label={initial ? `Edit ${initial.prize}` : 'New giveaway'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Prize" value={prize} onChange={setPrize} maxLength={GIVEAWAY_PRIZE_MAX} error={err('prize')} required />
      <div className="field">
        <label htmlFor={`giveaway-description-${initial?.id ?? 'new'}`}>Description (optional)</label>
        <textarea
          id={`giveaway-description-${initial?.id ?? 'new'}`}
          value={description}
          maxLength={GIVEAWAY_DESCRIPTION_MAX}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
        />
        {err('description') && <span className="field-error">{err('description')}</span>}
      </div>
      <div className="giveaway-editor-row">
        <Field label="Winners" type="number" min={1} max={GIVEAWAY_WINNERS_MAX} value={winnerCount} onChange={setWinnerCount} error={err('winnerCount')} />
        {isNew && (
          <Field
            label="Duration (minutes)"
            type="number"
            min={1}
            max={GIVEAWAY_DURATION_MAX_MINUTES}
            value={durationMinutes}
            onChange={setDurationMinutes}
            placeholder="Until you end it"
            hint="Entries close automatically after this. Leave empty to end entries yourself."
            error={err('durationMinutes')}
          />
        )}
      </div>
      {isNew && (
        <>
          <fieldset className="choice-list">
            <legend className="small">Entry on</legend>
            {GIVEAWAY_PLATFORMS.map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  checked={platforms.includes(p)}
                  onChange={(e) => setPlatforms((list) => (e.target.checked ? [...list, p] : list.filter((x) => x !== p)))}
                />{' '}
                {PLATFORM_LABEL[p]}
              </label>
            ))}
            {err('platforms') && <span className="field-error">{err('platforms')}</span>}
          </fieldset>
          {platforms.includes('discord') && <DiscordChannelPicker value={discordChannel} onChange={setDiscordChannel} error={err('discordChannel')} />}
          {kick && (
            <fieldset className="choice-list giveaway-tickets">
              <legend className="small">Kick bonus tickets (optional)</legend>
              <label>
                <input
                  type="checkbox"
                  checked={rewardEnabled}
                  disabled={!kickRewards?.available}
                  onChange={(e) => setRewardEnabled(e.target.checked)}
                />{' '}
                Channel Points reward for bonus tickets
              </label>
              {!kickRewards?.available && kickRewards?.problem && <span className="field-hint text-warn">{kickRewards.problem}</span>}
              {rewardEnabled && (
                <div className="giveaway-editor-row">
                  <Field
                    label="Reward name"
                    value={rewardTitle}
                    onChange={setRewardTitle}
                    maxLength={KICK_REWARD_TITLE_MAX}
                    error={err('kickReward.title')}
                  />
                  <Field label="Cost (points)" type="number" min={1} value={rewardCost} onChange={setRewardCost} error={err('kickReward.cost')} />
                  <Field
                    label="Bonus tickets per redemption"
                    type="number"
                    min={1}
                    max={100}
                    value={rewardTickets}
                    onChange={setRewardTickets}
                    error={err('kickReward.tickets')}
                  />
                </div>
              )}
              {rewardEnabled && (
                <span className="field-hint">
                  CONDUIT creates this reward on your Kick channel when the giveaway starts and removes it afterwards. Viewers type !enter first, then
                  redeem; each accepted redemption adds the bonus tickets. Redemptions without an entry, or after entries close, are rejected.
                </span>
              )}
              <div className="field">
                <label htmlFor="giveaway-multiplier">Active Kick subscribers</label>
                <select id="giveaway-multiplier" value={subscriberMultiplier} onChange={(e) => setSubscriberMultiplier(e.target.value)}>
                  {MULTIPLIERS.map((m) => (
                    <option key={m} value={String(m)}>
                      {m === 1 ? 'No multiplier' : `${m}× tickets`}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Verified when they type !enter, from Kick’s subscriber badge on that message. Total tickets = (1 + bonus tickets) × multiplier.
                </span>
              </div>
            </fieldset>
          )}
        </>
      )}
      {serverError !== null && !(serverError instanceof ApiClientError && serverError.issues.length > 0) && (
        <p className="connection-note note-error" role="alert">
          {errorMessage(serverError)}
        </p>
      )}
      <div className="button-row">
        <Button type="submit" busy={saving}>
          {isNew ? 'Start Giveaway' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {isNew ? 'Discard' : 'Cancel'}
        </Button>
      </div>
    </form>
  );
}

/** Choose the Discord channel for the giveaway embed, from the channels the bot can see (with missing permissions). */
function DiscordChannelPicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const { data, error: loadError, reload, loading } = useAsync(() => api<DiscordChannelsState>('GET', '/api/giveaways/discord/channels'), []);
  const known = data?.guilds.some((g) => g.channels.some((ch) => `${g.id}:${ch.id}` === value)) ?? false;
  const selected = data?.guilds.flatMap((g) => g.channels.map((ch) => ({ key: `${g.id}:${ch.id}`, ch }))).find((x) => x.key === value)?.ch;
  return (
    <div className="field">
      <label htmlFor="giveaway-discord-channel">Discord announcement channel</label>
      <select id="giveaway-discord-channel" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a channel…</option>
        {value && !known && <option value={value}>{loading ? 'Loading…' : 'Current channel (not found)'}</option>}
        {data?.guilds.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {g.channels.map((ch) => (
              <option key={ch.id} value={`${g.id}:${ch.id}`} disabled={ch.missing.length > 0 && `${g.id}:${ch.id}` !== value}>
                #{ch.name}
                {ch.missing.length > 0 ? ` — missing ${ch.missing.join(', ')}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {error ? (
        <span className="field-error">{error}</span>
      ) : selected && selected.missing.length > 0 ? (
        <span className="field-error">
          The bot is missing {selected.missing.join(', ')} in #{selected.name}. Fix the channel’s permissions in Discord, or choose another channel.
        </span>
      ) : (
        <span className="field-hint">
          When you start, the bot posts the giveaway embed here with an Enter Giveaway button. Channels where the bot lacks permissions are
          disabled.
        </span>
      )}
      {(loadError || data?.problem || data?.guilds.some((g) => g.problem)) && (
        <span className="field-hint text-warn">
          {loadError ? errorMessage(loadError) : (data?.problem ?? data?.guilds.find((g) => g.problem)?.problem)}{' '}
          <button type="button" className="link-button" onClick={reload}>
            Refresh
          </button>
        </span>
      )}
    </div>
  );
}

function remaining(endsAt: string): string {
  const ms = Date.parse(endsAt) - Date.now();
  if (ms <= 0) return 'closing now';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min (closes ${formatTime(endsAt)})`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min (closes ${formatTime(endsAt)})`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
