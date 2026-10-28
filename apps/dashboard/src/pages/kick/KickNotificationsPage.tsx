import { useState } from 'react';
import { type DiscordEmbed } from '@conduit/shared/discord/embeds';
import {
  DEFAULT_NOTIFICATION_BUTTONS,
  DEFAULT_NOTIFICATION_CONTENT,
  DEFAULT_NOTIFICATION_EMBED,
  defaultNotificationLayout,
  NOTIFICATION_BUTTONS_MAX,
  NOTIFICATION_VARIABLES,
  notifierSchema,
  testNotificationSchema,
  type NotificationButton,
  type NotifierView,
  type StreamNotificationsState,
} from '@conduit/shared/kick/stream-notifications';
import { api, ApiClientError, errorMessage } from '../../api';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { EmbedEditor, EmbedPreview } from '../../components/discord/EmbedEditor';
import { Button, Loading } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';
import thumbnailExample from '../../assets/kick/thumbnail-example.png';

const POLL_MS = 10_000;
/** Sample values for the preview only (never sent). */
const PREVIEW_VARS = {
  streamer: 'StreamerName',
  title: 'Example stream title',
  category: 'Example category',
  url: 'https://kick.com/streamername',
  viewers: '0',
  // Placeholders (the preview never loads remote images); real posts use Kick's image links. The sample stream
  // thumbnail is shown with a bundled example picture (SAMPLE_IMAGES).
  thumbnail: 'https://kick.com/sample-thumbnail',
  avatar: 'https://kick.com/sample-avatar',
};

/** Bundled example pictures for the preview's sample image links. */
const SAMPLE_IMAGES = { 'https://kick.com/sample-thumbnail': thumbnailExample };

/** Kick Notifications: announce in Discord when Kick streamers go live. */
export function KickNotificationsPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<StreamNotificationsState>('GET', '/api/notifications'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading notifications…'} />;
  return <KickNotificationsView s={data} onChanged={reload} />;
}

type Editing = { mode: 'new' } | { mode: 'edit'; item: NotifierView } | null;

export function KickNotificationsView({ s, onChanged }: { s: StreamNotificationsState; onChanged?: () => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [checking, setChecking] = useState(false);
  return (
    <div className="stack">
      <section className="card" aria-labelledby="notify-title">
        <div className="card-head">
          <div>
            <h2 id="notify-title">Kick live notifications</h2>
            <p className="muted small">
              Posts in Discord when a Kick streamer goes live — yours or anyone’s. CONDUIT checks Kick every {s.kick.pollSeconds} seconds while it’s running, using your
              Kick app (public channel information; no rights over other channels). One post per stream.
            </p>
          </div>
          <div className="button-row">
            <Button
              variant="secondary"
              busy={checking}
              onClick={() => {
                setChecking(true);
                void api('POST', '/api/notifications/check').finally(() => (setChecking(false), onChanged?.()));
              }}
            >
              Check now
            </Button>
            {!editing && <Button onClick={() => setEditing({ mode: 'new' })}>Add streamer</Button>}
          </div>
        </div>
        {s.notifiers.length === 0 && !editing ? (
          <p className="empty-note">No streamers yet. Add your own channel or anyone else’s.</p>
        ) : (
          <ul className="item-list">
            {s.notifiers.map((n) => (
              <NotifierRow key={n.id} n={n} onEdit={() => setEditing({ mode: 'edit', item: n })} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <NotifierEditor
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

function NotifierRow({ n, onEdit, onChanged }: { n: NotifierView; onEdit: () => void; onChanged?: () => void }) {
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
  return (
    <li className={`item${n.enabled ? '' : ' item-off'}`}>
      <label className="switch">
        <input type="checkbox" aria-label={`${n.channel}: ${n.enabled ? 'on' : 'off'}`} checked={n.enabled} disabled={busy} onChange={(e) => void run(() => api('PATCH', `/api/notifications/${n.id}`, { enabled: e.target.checked }))} />
      </label>
      <div className="item-main">
        <div className="item-title">
          <strong>{n.displayName ?? n.channel}</strong>
          <span className="muted small">kick.com/{n.channel} → {n.destination ?? 'Discord'}</span>
        </div>
        {n.live && n.title && (
          <div className="small">
            “{n.title}”{n.category ? ` · ${n.category}` : ''}
          </div>
        )}
        <div className="muted small">
          {n.status ?? 'Not checked yet.'}
          {n.lastCheckedAt ? ` · checked ${new Date(n.lastCheckedAt).toLocaleTimeString()}` : ''}
          {n.deleteWhenEnded ? ' · deleted when the stream ends' : ''}
        </div>
        {n.problem && <span className="small text-warn">{n.problem}</span>}
        {error && (
          <span className="small text-bad" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="item-side">
        <span className={`pill ${n.live ? 'pill-ok' : 'pill-muted'}`}>{n.live === null ? 'Unknown' : n.live ? 'Live' : 'Offline'}</span>
        <Button variant="ghost" className="btn btn-ghost btn-small" onClick={onEdit}>
          Edit
        </Button>
        {confirm ? (
          <Button variant="danger" className="btn btn-danger btn-small" busy={busy} onClick={() => void run(() => api('DELETE', `/api/notifications/${n.id}`))}>
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

type Layout = ReturnType<typeof defaultNotificationLayout>;

/**
 * "Use default layout": shows the default post (preview) and replaces only the text, embed and buttons after a
 * confirmation. Server, channel, role, delete-when-ended, on/off and live tracking are untouched, and nothing is saved
 * until Save.
 */
export function DefaultLayoutBlock({
  current,
  previewVars,
  mention,
  onApply,
}: {
  current: Layout;
  previewVars: Record<string, string>;
  mention: string | null;
  onApply: (layout: Layout) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const def = defaultNotificationLayout();
  const isDefault = JSON.stringify(current) === JSON.stringify(def);
  return (
    <fieldset className="editor-block">
      <legend>Layout</legend>
      {!confirming ? (
        <div className="button-row">
          <p className="muted small">{isDefault ? 'This notification uses the default layout.' : 'This notification uses a custom layout.'}</p>
          {!isDefault && (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Use default layout…
            </Button>
          )}
        </div>
      ) : (
        <div className="default-layout-confirm" role="group" aria-label="Replace with the default layout">
          <p>
            <strong>Replace the announcement text, embed and buttons with the default layout?</strong> Your custom layout is replaced in this editor. The server,
            channel, role, delete-when-ended and on/off settings stay as they are, and nothing is saved until you press <strong>Save</strong>.
          </p>
          <EmbedPreview
            embed={def.embed}
            vars={previewVars}
            content={def.content}
            mention={mention}
            buttons={def.buttons}
            note="Preview of the default layout with sample data."
            imageLabels={{ image: 'Stream thumbnail (from Kick, when live)', thumb: 'Profile' }}
            imageSamples={SAMPLE_IMAGES}
          />
          <div className="button-row">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep my layout
            </Button>
            <Button
              onClick={() => {
                onApply(defaultNotificationLayout());
                setConfirming(false);
              }}
            >
              Replace with default
            </Button>
          </div>
        </div>
      )}
      <p className="muted small">
        Variables are lowercase, like <code>{'{streamer}'}</code>. A differently capitalised one (<code>{'{Streamer}'}</code>) still works and is corrected when you save.
      </p>
    </fieldset>
  );
}

function NotifierEditor({ initial, onClose, onSaved }: { initial: NotifierView | null; onClose: () => void; onSaved: () => void }) {
  const channels = useDiscordChannels();
  const [channel, setChannel] = useState(initial?.channel ?? '');
  const [guildId, setGuildId] = useState(initial?.guildId ?? '');
  const [channelId, setChannelId] = useState(initial?.channelId ?? '');
  const [roleId, setRoleId] = useState(initial?.roleId ?? '');
  const [content, setContent] = useState(initial?.content ?? DEFAULT_NOTIFICATION_CONTENT);
  const [embed, setEmbed] = useState<DiscordEmbed>(initial?.embed ?? structuredClone(DEFAULT_NOTIFICATION_EMBED));
  const [buttons, setButtons] = useState<NotificationButton[]>(initial?.buttons ?? structuredClone(DEFAULT_NOTIFICATION_BUTTONS));
  const [deleteWhenEnded, setDeleteWhenEnded] = useState(initial?.deleteWhenEnded ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = channels?.guilds.find((g) => g.id === guildId)?.roles ?? [];
  const role = roles.find((r) => r.id === roleId);
  const body = { platform: 'kick', channel, guildId, channelId, roleId: roleId || null, content, embed, buttons };
  const sampleName = channel.replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/\/.*$/, '') || PREVIEW_VARS.streamer;
  const previewVars = { ...PREVIEW_VARS, streamer: initial?.displayName ?? sampleName, url: `https://kick.com/${sampleName.toLowerCase()}` };

  const issuesOf = (e: unknown) => (e instanceof ApiClientError && e.issues.length ? Object.fromEntries(e.issues.map((i) => [i.path, i.message])) : null);

  const save = async () => {
    setFailure(null);
    const full = { ...body, enabled, deleteWhenEnded };
    const checked = notifierSchema.safeParse(full);
    if (!checked.success) {
      setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      if (initial) await api('PATCH', `/api/notifications/${initial.id}`, full);
      else await api('POST', '/api/notifications', full);
      onSaved();
    } catch (e) {
      const issues = issuesOf(e);
      if (issues) setErrors(issues);
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTest(null);
    const checked = testNotificationSchema.safeParse(body);
    if (!checked.success) {
      setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>('POST', '/api/notifications/test', body);
      setTest({ ok: r.ok, text: r.message });
    } catch (e) {
      const issues = issuesOf(e);
      if (issues) setErrors(issues);
      setTest({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card editor-card" aria-labelledby="notify-editor-title">
      <h2 id="notify-editor-title">{initial ? `Edit ${initial.displayName ?? initial.channel}` : 'Add a Kick streamer'}</h2>

      <fieldset className="editor-block">
        <legend>Streamer and destination</legend>
        <div className="editor-grid">
          <label className="field">
            <span className="field-label">Kick channel</span>
            <input value={channel} placeholder="channel name or kick.com link" onChange={(e) => setChannel(e.target.value)} />
            {errors.channel && <span className="field-error">{errors.channel}</span>}
          </label>
          <DiscordChannelPicker channels={channels} guildId={guildId} channelId={channelId} needs={['viewChannel', 'sendMessages', 'embedLinks']} label="Post in" onChange={(g, ch) => (setGuildId(g), setChannelId(ch))} error={errors.channelId ?? errors.guildId} />
        </div>
      </fieldset>

      <DefaultLayoutBlock
        current={{ content, embed, buttons }}
        previewVars={previewVars}
        mention={role ? `@${role.name}` : null}
        onApply={(d) => {
          setContent(d.content);
          setEmbed(d.embed);
          setButtons(d.buttons);
        }}
      />

      <fieldset className="editor-block">
        <legend>Announcement</legend>
        <div className="editor-grid">
          <label className="field">
            <span className="field-label">Mention a role (optional)</span>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">No mention</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  @{r.name}
                  {r.mentionable ? '' : ' (not mentionable)'}
                </option>
              ))}
            </select>
            {errors.roleId && <span className="field-error">{errors.roleId}</span>}
          </label>
          <label className="field">
            <span className="field-label">Announcement text</span>
            <input value={content} maxLength={1500} onChange={(e) => setContent(e.target.value)} />
            {errors.content && <span className="field-error">{errors.content}</span>}
          </label>
        </div>
        <p className="muted small">Posted above the embed, after the role mention. With no role, there’s no mention at all.</p>
      </fieldset>

      <fieldset className="editor-block">
        <legend>Embed</legend>
        <p className="muted small">
          The stream thumbnail is the embed’s large <strong>Image</strong> (<code>{'{thumbnail}'}</code>), shown full width under the title and category; the profile
          picture is the small <strong>Thumbnail</strong> (<code>{'{avatar}'}</code>). No author is needed — the bot posts the message. Kick’s public API doesn’t provide
          follower counts, so they can’t be shown.
        </p>
        <EmbedEditor
          value={embed}
          onChange={setEmbed}
          variables={NOTIFICATION_VARIABLES}
          previewVars={previewVars}
          preview={{
            content,
            mention: role ? `@${role.name}` : null,
            buttons,
            note: 'Sample data (stream title, category, images). Real notifications use Kick’s live data for this streamer.',
            imageLabels: { image: 'Stream thumbnail (from Kick, when live)', thumb: 'Profile' },
            imageSamples: SAMPLE_IMAGES,
          }}
        />
      </fieldset>

      <fieldset className="editor-block">
        <legend>Buttons</legend>
        {buttons.map((b, i) => (
          <div key={i} className="button-editor">
            <input aria-label={`Button ${i + 1} label`} value={b.label} maxLength={80} placeholder="Label" onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input aria-label={`Button ${i + 1} link`} value={b.url} placeholder="{url} or https://…" onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
            <Button variant="ghost" className="btn btn-ghost btn-small" aria-label={`Remove button ${i + 1}`} onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>
              ✕
            </Button>
            {(errors[`buttons.${i}.label`] || errors[`buttons.${i}.url`]) && <span className="field-error">{errors[`buttons.${i}.label`] ?? errors[`buttons.${i}.url`]}</span>}
          </div>
        ))}
        {buttons.length < NOTIFICATION_BUTTONS_MAX && (
          <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => setButtons([...buttons, { label: buttons.length ? 'More' : 'Watch {streamer} on Kick!', url: buttons.length ? 'https://' : '{url}' }])}>
            + Add button
          </Button>
        )}
        <p className="muted small">Real Discord link buttons under the embed. <code>{'{url}'}</code> is the streamer’s Kick channel; labels can use <code>{'{streamer}'}</code>.</p>
      </fieldset>

      <div className="card-foot">
        <label className="inline-check">
          <input type="checkbox" checked={deleteWhenEnded} onChange={(e) => setDeleteWhenEnded(e.target.checked)} /> Delete the post when the stream ends
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On
        </label>
        {test && (
          <span className={`small ${test.ok ? 'text-ok' : 'text-bad'}`} role="status">
            {test.text}
          </span>
        )}
        {failure && (
          <span className="small text-bad" role="alert">
            {failure}
          </span>
        )}
        <div className="button-row">
          <Button variant="secondary" disabled={busy || !channelId || !channel} onClick={() => void sendTest()}>
            Send test
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <p className="muted small">
        <strong>Send test</strong> posts this notification now, marked as a test, with the streamer’s real current Kick data (the role is shown but not pinged). A streamer
        who is live when added is announced from their next stream.
      </p>
    </section>
  );
}
