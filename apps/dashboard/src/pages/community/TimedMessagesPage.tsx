import { useState } from 'react';
import { EMPTY_EMBED, type DiscordEmbed } from '@conduit/shared/discord/embeds';
import { describeSchedule, timedMessageSchema, type TimedMessagesState, type TimedMessageView } from '@conduit/shared/community/timed-messages';
import { api, ApiClientError, errorMessage } from '../../api';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { EmbedEditor, EmbedPreview } from '../../components/discord/EmbedEditor';
import { Button, Loading } from '../../components/forms';
import { PlatformIcon } from '../../components/PlatformIcon';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 5000;

/** Timed Messages: one message repeated in a Kick chat or a Discord channel, by time and/or chat activity. */
export function TimedMessagesPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<TimedMessagesState>('GET', '/api/timed-messages'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading timed messages…'} />;
  return <TimedMessagesView s={data} onChanged={reload} />;
}

type Editing = { mode: 'new' } | { mode: 'edit'; item: TimedMessageView } | null;

export function TimedMessagesView({ s, onChanged }: { s: TimedMessagesState; onChanged?: () => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <div className="stack">
      <section className="card" aria-labelledby="timed-title">
        <div className="card-head">
          <div>
            <h2 id="timed-title">Your messages</h2>
            <p className="muted small">Each one runs on its own schedule. Switch it on or off, edit, duplicate or delete it here.</p>
          </div>
          {!editing && <Button onClick={() => setEditing({ mode: 'new' })}>New timed message</Button>}
        </div>
        {s.timedMessages.length === 0 && !editing ? (
          <p className="empty-note">No timed messages yet.</p>
        ) : (
          <ul className="item-list">
            {s.timedMessages.map((t) => (
              <TimedRow key={t.id} t={t} onEdit={() => setEditing({ mode: 'edit', item: t })} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <TimedEditor
          key={editing.mode === 'edit' ? editing.item.id : 'new'}
          initial={editing.mode === 'edit' ? editing.item : null}
          s={s}
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

function useRowAction(onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiClientError && err.issues.length ? err.issues.map((i) => i.message).join(' ') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function TimedRow({ t, onEdit, onChanged }: { t: TimedMessageView; onEdit: () => void; onChanged?: () => void }) {
  const { busy, error, run } = useRowAction(onChanged);
  const [confirm, setConfirm] = useState(false);
  const last = t.recent[0];
  return (
    <li className={`item${t.enabled ? '' : ' item-off'}`}>
      <label className="switch">
        <input type="checkbox" aria-label={`${t.name}: ${t.enabled ? 'on' : 'off'}`} checked={t.enabled} disabled={busy} onChange={(e) => void run(() => api('PATCH', `/api/timed-messages/${t.id}`, { enabled: e.target.checked }))} />
      </label>
      <div className="item-main">
        <div className="item-title">
          <PlatformIcon platform={t.platform} size={16} />
          <strong>{t.name}</strong>
          <span className="muted small">→ {t.destination ?? 'Unknown destination'}</span>
        </div>
        <div className="small">{describeSchedule(t)}</div>
        <div className="muted small item-preview">{t.platform === 'kick' ? t.content : t.message.content || (t.message.embed ? `Embed: ${t.message.embed.title || 'untitled'}` : '')}</div>
        {t.problem && <span className="small text-warn">{t.problem}</span>}
        {error && (
          <span className="small text-bad" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="item-side">
        {last ? (
          <span className={`pill ${last.ok ? 'pill-ok' : 'pill-bad'}`} title={`${new Date(last.at).toLocaleString()} — ${last.detail}`}>
            {last.ok ? 'Posted' : 'Failed'}
          </span>
        ) : (
          <span className="muted small">Not posted yet</span>
        )}
        {t.enabled && t.messageCount !== null && <span className="muted small">{t.messagesSince}/{t.messageCount} messages</span>}
        <Button variant="ghost" className="btn btn-ghost btn-small" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void run(() => api('POST', `/api/timed-messages/${t.id}/duplicate`))}>
          Duplicate
        </Button>
        {confirm ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('DELETE', `/api/timed-messages/${t.id}`))}>
            Delete
          </Button>
        ) : (
          <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setConfirm(true)}>
            Delete…
          </Button>
        )}
      </div>
    </li>
  );
}

interface Draft {
  platform: 'kick' | 'discord';
  name: string;
  enabled: boolean;
  content: string;
  guildId: string;
  channelId: string;
  useEmbed: boolean;
  embed: DiscordEmbed;
  useTime: boolean;
  intervalMinutes: number;
  useCount: boolean;
  messageCount: number;
  combine: 'all' | 'any';
}

function draftOf(t: TimedMessageView | null): Draft {
  return {
    platform: t?.platform ?? 'discord',
    name: t?.name ?? '',
    enabled: t?.enabled ?? false,
    content: t ? (t.platform === 'kick' ? t.content : t.message.content) : '',
    guildId: t?.platform === 'discord' ? t.guildId : '',
    channelId: t?.platform === 'discord' ? t.channelId : '',
    useEmbed: t?.platform === 'discord' && t.message.embed !== null,
    embed: t?.platform === 'discord' && t.message.embed ? t.message.embed : { ...EMPTY_EMBED },
    useTime: t ? t.intervalMinutes !== null : true,
    intervalMinutes: t?.intervalMinutes ?? 30,
    useCount: t ? t.messageCount !== null : false,
    messageCount: t?.messageCount ?? 25,
    combine: t?.combine ?? 'all',
  };
}

export function toBody(d: Draft) {
  const schedule = { intervalMinutes: d.useTime ? d.intervalMinutes : null, messageCount: d.useCount ? d.messageCount : null, combine: d.combine };
  return d.platform === 'kick'
    ? { platform: 'kick' as const, name: d.name, enabled: d.enabled, content: d.content, ...schedule }
    : { platform: 'discord' as const, name: d.name, enabled: d.enabled, guildId: d.guildId, channelId: d.channelId, message: { content: d.content, embed: d.useEmbed ? d.embed : null }, ...schedule };
}

function TimedEditor({ initial, s, onClose, onSaved }: { initial: TimedMessageView | null; s: TimedMessagesState; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draftOf(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const channels = useDiscordChannels();
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const err = (p: string) => errors[p];

  const save = async () => {
    setFailure(null);
    const body = toBody(d);
    const checked = timedMessageSchema.safeParse(body);
    if (!checked.success) {
      setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      if (initial) await api('PATCH', `/api/timed-messages/${initial.id}`, body);
      else await api('POST', '/api/timed-messages', body);
      onSaved();
    } catch (e) {
      if (e instanceof ApiClientError && e.issues.length) setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTest('Sending…');
    try {
      const r = await api<{ ok: boolean; message: string }>('POST', '/api/discord/embeds/test', { guildId: d.guildId, channelId: d.channelId, message: { content: d.content, embed: d.useEmbed ? d.embed : null } });
      setTest(r.message);
    } catch (e) {
      setTest(errorMessage(e));
    }
  };

  return (
    <section className="card editor-card" aria-labelledby="timed-editor-title">
      <h2 id="timed-editor-title">{initial ? `Edit “${initial.name}”` : 'New timed message'}</h2>
      <div className="editor-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
          {err('name') && <span className="field-error">{err('name')}</span>}
        </label>
        <div className="field">
          <span className="field-label">Where</span>
          <div className="segmented" role="radiogroup" aria-label="Platform">
            {(['discord', 'kick'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={d.platform === p} className={`segment${d.platform === p ? ' active' : ''}`} disabled={!!initial} onClick={() => set({ platform: p })}>
                {p === 'discord' ? 'Discord channel' : 'Kick chat'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {d.platform === 'discord' ? (
        <DiscordChannelPicker channels={channels} guildId={d.guildId} channelId={d.channelId} needs={['viewChannel', 'sendMessages', ...(d.useEmbed ? (['embedLinks'] as const) : [])]} onChange={(guildId, channelId) => set({ guildId, channelId })} error={err('channelId') ?? err('guildId')} />
      ) : (
        <p className="small muted">
          Posts in {s.kick.channel ? `${s.kick.channel}’s` : 'your'} Kick chat as the chatbot account. Kick chat shows text only (no embeds).
        </p>
      )}

      <label className="field">
        <span className="field-label">{d.platform === 'kick' ? 'Message (one line, up to 500 characters)' : 'Message text (optional with an embed; Discord markdown works)'}</span>
        {d.platform === 'kick' ? <input value={d.content} maxLength={500} onChange={(e) => set({ content: e.target.value })} /> : <textarea rows={2} value={d.content} maxLength={2000} onChange={(e) => set({ content: e.target.value })} />}
        {(err('content') || err('message.content') || err('message')) && <span className="field-error">{err('content') ?? err('message.content') ?? err('message')}</span>}
      </label>

      {d.platform === 'discord' && (
        <>
          <label className="inline-check">
            <input type="checkbox" checked={d.useEmbed} onChange={(e) => set({ useEmbed: e.target.checked })} /> Include an embed
          </label>
          {d.useEmbed ? <EmbedEditor value={d.embed} onChange={(embed) => set({ embed })} /> : d.content && <EmbedPreview embed={null} content={d.content} />}
        </>
      )}

      <fieldset className="editor-block">
        <legend>Schedule</legend>
        <div className="editor-row">
          <label className="inline-check">
            <input type="checkbox" checked={d.useTime} onChange={(e) => set({ useTime: e.target.checked })} /> Every
          </label>
          <input aria-label="Minutes" className="num" type="number" min={5} max={1440} value={d.intervalMinutes} disabled={!d.useTime} onChange={(e) => set({ intervalMinutes: Number(e.target.value) })} />
          <span className="muted small">minutes</span>
        </div>
        <div className="editor-row">
          <label className="inline-check">
            <input type="checkbox" checked={d.useCount} onChange={(e) => set({ useCount: e.target.checked })} /> After
          </label>
          <input aria-label="Messages" className="num" type="number" min={5} max={1000} value={d.messageCount} disabled={!d.useCount} onChange={(e) => set({ messageCount: Number(e.target.value) })} />
          <span className="muted small">chat messages from people (bots never count)</span>
        </div>
        {d.useTime && d.useCount && (
          <div className="editor-row">
            <span className="muted small">With both:</span>
            <select aria-label="Combine" value={d.combine} onChange={(e) => set({ combine: e.target.value as 'all' | 'any' })}>
              <option value="all">Wait for both (time passed and enough messages)</option>
              <option value="any">Whichever comes first</option>
            </select>
          </div>
        )}
        <p className="muted small">
          {d.useTime || d.useCount ? `Posts ${describeSchedule({ intervalMinutes: d.useTime ? d.intervalMinutes : null, messageCount: d.useCount ? d.messageCount : null, combine: d.combine })}. ` : ''}
          Each post restarts both counts, so it never posts twice for one moment; at most one post a minute. The clock starts when it’s switched on (nothing is posted right away). Message counts are saved, so they carry on after CONDUIT restarts; switching it on or off or changing its settings starts the count again.
        </p>
        {err('intervalMinutes') && <span className="field-error">{err('intervalMinutes')}</span>}
        {err('messageCount') && <span className="field-error">{err('messageCount')}</span>}
      </fieldset>

      <div className="card-foot">
        <label className="inline-check">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On
        </label>
        {test && <span className="small muted">{test}</span>}
        {failure && (
          <span className="small text-bad" role="alert">
            {failure}
          </span>
        )}
        <div className="button-row">
          {d.platform === 'discord' && (
            <Button variant="secondary" disabled={!d.channelId} onClick={() => void sendTest()}>
              Send test
            </Button>
          )}
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
