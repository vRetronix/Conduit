/**
 * Discord Moderation: the bot's presence — Status Updates (online status, custom status line) and Rich Presence Updates
 * (an activity). Both edit the one presence the backend validates, saves and sends on the bot's gateway connection.
 */
import { useState } from 'react';
import {
  BOT_ACTIVITY_HELP,
  BOT_ACTIVITY_TYPES,
  BOT_STATUS_LABEL,
  BOT_STATUSES,
  PRESENCE_TEXT_MAX,
  presenceSchema,
  type BotActivityType,
  type BotPresence,
  type BotStatus,
  type PresenceState,
} from '@conduit/shared/discord/discord-presence';
import { api, errorMessage } from '../../api';
import { Button, ErrorBanner, Field, fieldError, schemaFieldErrors, Select } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

/** Status Updates and Rich Presence Updates, with the bot's presence loaded from the backend (Discord Moderation page). */
export function BotPresenceSections() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<PresenceState>('GET', '/api/discord/presence'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : 10_000, [data, error]);
  if (!data) return <p className="muted">{error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading the bot’s status…'}</p>;
  return <BotPresenceView state={data} onSaved={reload} />;
}

/** The two presence sections for a known state (forms reset when the saved presence changes). */
export function BotPresenceView({ state, onSaved }: { state: PresenceState; onSaved?: () => void }) {
  return (
    <>
      <StatusUpdates key={`status-${JSON.stringify(state.saved)}`} state={state} onSaved={() => onSaved?.()} />
      <RichPresenceUpdates key={`activity-${JSON.stringify(state.saved)}`} state={state} onSaved={() => onSaved?.()} />
    </>
  );
}

// ── Bot presence: Status Updates and Rich Presence Updates ────────────────────

/** Field errors from the shared schema (the same rules the backend applies), keyed like "activity.url". */
const presenceProblems = (p: unknown) => schemaFieldErrors(presenceSchema, p);

function usePresenceSave(onSaved: (s: PresenceState) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save(p: BotPresence) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<PresenceState>('POST', '/api/discord/presence', p));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

export function StatusUpdates({ state, onSaved }: { state: PresenceState; onSaved: (s: PresenceState) => void }) {
  const saved = state.saved;
  const [status, setStatus] = useState<BotStatus>(saved?.status ?? 'online');
  const [custom, setCustom] = useState(saved?.customStatus ?? '');
  const { busy, error, save } = usePresenceSave(onSaved);
  const next = { status, customStatus: custom.trim() || null, activity: saved?.activity ?? null };
  const problems = presenceProblems(next);
  return (
    <section className="card" aria-labelledby="presence-status">
      <h2 id="presence-status">Status Updates</h2>
      <p className="muted small">The bot’s own online status and an optional custom status line under its name.</p>
      <div className="presence-form">
        <Select label="Status" value={status} onChange={(v) => setStatus(v as BotStatus)} options={BOT_STATUSES.map((s) => ({ value: s, label: BOT_STATUS_LABEL[s] }))} />
        <Field
          label="Custom status (optional)"
          value={custom}
          onChange={setCustom}
          maxLength={PRESENCE_TEXT_MAX}
          placeholder="e.g. Keeping the server tidy"
          error={fieldError('customStatus', problems, error)}
          hint={saved?.activity ? 'Discord shows one line under a bot’s name: the Rich Presence activity replaces this while it is on.' : `Up to ${PRESENCE_TEXT_MAX} characters.`}
        />
      </div>
      <ErrorBanner error={error} />
      <div className="button-row">
        <Button busy={busy} disabled={Object.keys(problems).length > 0} onClick={() => void save(next)}>
          Save and apply status
        </Button>
      </div>
    </section>
  );
}

export function RichPresenceUpdates({ state, onSaved }: { state: PresenceState; onSaved: (s: PresenceState) => void }) {
  const saved = state.saved;
  const [on, setOn] = useState(saved?.activity !== null && saved?.activity !== undefined);
  const [type, setType] = useState<BotActivityType>(saved?.activity?.type ?? 'playing');
  const [name, setName] = useState(saved?.activity?.name ?? '');
  const [url, setUrl] = useState(saved?.activity?.url ?? '');
  const { busy, error, save } = usePresenceSave(onSaved);
  const next = {
    status: saved?.status ?? 'online',
    customStatus: saved?.customStatus ?? null,
    activity: on ? { type, name, url: type === 'streaming' ? url.trim() || null : null } : null,
  } as BotPresence;
  const problems = presenceProblems(next);
  return (
    <section className="card" aria-labelledby="presence-activity">
      <h2 id="presence-activity">Rich Presence Updates</h2>
      <p className="muted small">The activity shown on the bot’s profile and in the member list, e.g. “Watching the stream”.</p>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Show an activity
      </label>
      {on && (
        <div className="presence-form">
          <Select label="Activity" value={type} onChange={(v) => setType(v as BotActivityType)} options={BOT_ACTIVITY_TYPES.map((t) => ({ value: t, label: BOT_ACTIVITY_HELP[t].label }))} />
          <Field
            label="Text"
            value={name}
            onChange={setName}
            maxLength={PRESENCE_TEXT_MAX}
            placeholder="e.g. the stream"
            error={fieldError('activity.name', problems, error)}
            hint={`Shown as “${BOT_ACTIVITY_HELP[type].shownAs} ${name.trim() || '…'}”.`}
          />
          {type === 'streaming' && (
            <Field label="Stream link" value={url} onChange={setUrl} placeholder="https://twitch.tv/yourchannel" error={fieldError('activity.url', problems, error)} hint="A Twitch or YouTube link: Discord shows Streaming only with one." />
          )}
        </div>
      )}
      <ErrorBanner error={error} />
      <div className="button-row">
        <Button busy={busy} disabled={Object.keys(problems).length > 0 || (!on && !saved?.activity)} onClick={() => void save(next)}>
          {on ? 'Save and apply activity' : 'Save and remove activity'}
        </Button>
      </div>
      <p className="muted small">Bots can show an activity type and its text (and a Twitch or YouTube link for Streaming).</p>
    </section>
  );
}

