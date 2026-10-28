import { useState } from 'react';
import { EMPTY_EMBED, type DiscordEmbed } from '@conduit/shared/discord/embeds';
import { stickyMessageSchema, type StickyMessagesState, type StickyMessageView } from '@conduit/shared/discord/sticky-messages';
import { api, ApiClientError, errorMessage } from '../../api';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { EmbedEditor, EmbedPreview } from '../../components/discord/EmbedEditor';
import { Button, Loading } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 5000;
const STATUS: Record<StickyMessageView['status'], { label: string; pill: string }> = {
  active: { label: 'Active', pill: 'pill-ok' },
  off: { label: 'Off', pill: 'pill-muted' },
  problem: { label: 'Needs attention', pill: 'pill-warn' },
};

/** Discord Sticky Messages: a message kept at the bottom of a channel. Discord only. */
export function StickyMessagesPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<StickyMessagesState>('GET', '/api/discord/stickies'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading sticky messages…'} />;
  return <StickyMessagesView s={data} onChanged={reload} />;
}

type Editing = { mode: 'new' } | { mode: 'edit'; item: StickyMessageView } | null;

export function StickyMessagesView({ s, onChanged }: { s: StickyMessagesState; onChanged?: () => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <div className="stack">
      <section className="card" aria-labelledby="sticky-title">
        <div className="card-head">
          <div>
            <h2 id="sticky-title">Your stickies</h2>
            <p className="muted small">When people post, each one moves back to the bottom: the bot posts a fresh copy and deletes the old one.</p>
          </div>
          {!editing && <Button onClick={() => setEditing({ mode: 'new' })}>New sticky</Button>}
        </div>
        {s.stickies.length === 0 && !editing ? (
          <p className="empty-note">No sticky messages yet.</p>
        ) : (
          <ul className="item-list">
            {s.stickies.map((x) => (
              <StickyRow key={x.id} x={x} onEdit={() => setEditing({ mode: 'edit', item: x })} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <StickyEditor
          key={editing.mode === 'edit' ? editing.item.id : 'new'}
          initial={editing.mode === 'edit' ? editing.item : null}
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

function StickyRow({ x, onEdit, onChanged }: { x: StickyMessageView; onEdit: () => void; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
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
  const status = STATUS[x.status];
  return (
    <li className={`item${x.enabled ? '' : ' item-off'}`}>
      <label className="switch">
        <input type="checkbox" aria-label={`${x.name}: ${x.enabled ? 'on' : 'off'}`} checked={x.enabled} disabled={busy} onChange={(e) => void run(() => api('PATCH', `/api/discord/stickies/${x.id}`, { enabled: e.target.checked }))} />
      </label>
      <div className="item-main">
        <div className="item-title">
          <strong>{x.name}</strong>
          <span className="muted small">in {x.destination ?? 'an unknown channel'}</span>
        </div>
        <div className="small">
          Moves to the bottom after {x.messagesBeforeRepost === 1 ? 'each message' : `${x.messagesBeforeRepost} messages`} from people, at most every {x.cooldownSeconds} s
        </div>
        <div className="muted small item-preview">{x.message.content || (x.message.embed ? `Embed: ${x.message.embed.title || 'untitled'}` : '')}</div>
        {x.problem && <span className="small text-warn">{x.problem}</span>}
        {x.recent[0] && <span className="muted small">Last: {x.recent[0].detail} ({new Date(x.recent[0].at).toLocaleTimeString()})</span>}
        {error && (
          <span className="small text-bad" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="item-side">
        <span className={`pill ${status.pill}`}>{status.label}</span>
        <Button variant="ghost" className="btn btn-ghost btn-small" onClick={onEdit}>
          Edit
        </Button>
        {confirm ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('DELETE', `/api/discord/stickies/${x.id}`))}>
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

function StickyEditor({ initial, onClose, onSaved }: { initial: StickyMessageView | null; onClose: () => void; onSaved: () => void }) {
  const channels = useDiscordChannels();
  const [name, setName] = useState(initial?.name ?? '');
  const [guildId, setGuildId] = useState(initial?.guildId ?? '');
  const [channelId, setChannelId] = useState(initial?.channelId ?? '');
  const [content, setContent] = useState(initial?.message.content ?? '');
  const [useEmbed, setUseEmbed] = useState(initial ? initial.message.embed !== null : false);
  const [embed, setEmbed] = useState<DiscordEmbed>(initial?.message.embed ?? { ...EMPTY_EMBED });
  const [cooldown, setCooldown] = useState(initial?.cooldownSeconds ?? 15);
  const [every, setEvery] = useState(initial?.messagesBeforeRepost ?? 1);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setFailure(null);
    const body = { name, enabled, guildId, channelId, message: { content, embed: useEmbed ? embed : null }, cooldownSeconds: cooldown, messagesBeforeRepost: every };
    const checked = stickyMessageSchema.safeParse(body);
    if (!checked.success) {
      setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      if (initial) await api('PATCH', `/api/discord/stickies/${initial.id}`, body);
      else await api('POST', '/api/discord/stickies', body);
      onSaved();
    } catch (e) {
      if (e instanceof ApiClientError && e.issues.length) setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card editor-card" aria-labelledby="sticky-editor-title">
      <h2 id="sticky-editor-title">{initial ? `Edit “${initial.name}”` : 'New sticky message'}</h2>
      <div className="editor-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>
        <DiscordChannelPicker
          channels={channels}
          guildId={guildId}
          channelId={channelId}
          needs={['viewChannel', 'sendMessages', 'readMessageHistory', ...(useEmbed ? (['embedLinks'] as const) : [])]}
          onChange={(g, c) => (setGuildId(g), setChannelId(c))}
          error={errors.channelId ?? errors.guildId}
        />
      </div>
      <label className="field">
        <span className="field-label">Message text (optional with an embed; Discord markdown works)</span>
        <textarea rows={2} value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} />
        {(errors['message.content'] || errors.message) && <span className="field-error">{errors['message.content'] ?? errors.message}</span>}
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={useEmbed} onChange={(e) => setUseEmbed(e.target.checked)} /> Include an embed
      </label>
      {useEmbed ? <EmbedEditor value={embed} onChange={setEmbed} /> : content && <EmbedPreview embed={null} content={content} />}
      <fieldset className="editor-block">
        <legend>Repost</legend>
        <div className="editor-row">
          <span className="muted small">After</span>
          <input aria-label="Messages before repost" className="num" type="number" min={1} max={100} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
          <span className="muted small">message(s) from people, at most once every</span>
          <input aria-label="Cooldown seconds" className="num" type="number" min={5} max={3600} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} />
          <span className="muted small">seconds</span>
        </div>
        <p className="muted small">Several messages in a row cause one repost. Nothing is reposted while the sticky is still the newest message.</p>
        {(errors.cooldownSeconds || errors.messagesBeforeRepost) && <span className="field-error">{errors.cooldownSeconds ?? errors.messagesBeforeRepost}</span>}
      </fieldset>
      <div className="card-foot">
        <label className="inline-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On (posts it now)
        </label>
        {failure && (
          <span className="small text-bad" role="alert">
            {failure}
          </span>
        )}
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
