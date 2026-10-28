import { useState } from 'react';
import { kickClipSettingsSchema, type KickClipSettings, type KickClipsState, type KickClipView } from '@conduit/shared/kick/kick-clips';
import { api, ApiClientError, errorMessage } from '../../api';
import { bridge } from '../../bridge';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { Button, Loading, schemaFieldErrors } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const POLL_MS = 60_000;
/** Clips shown at first; "Show more" adds this many each time. */
const PAGE = 20;

/** Kick → Clips: your channel's Kick clips, posted in Discord and saved on this PC. */
export function KickClipsPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<KickClipsState>('GET', '/api/kick/clips'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : POLL_MS, [data, error]);
  if (!data) return <Loading label={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading clips…'} />;
  return <KickClipsView s={data} onChanged={reload} />;
}

export function KickClipsView({ s, onChanged }: { s: KickClipsState; onChanged?: () => void }) {
  return (
    <div className="stack">
      <ClipSettings s={s} onSaved={onChanged} />
      <ClipList s={s} onChanged={onChanged} />
    </div>
  );
}

// ── settings ──────────────────────────────────────────────────────────────────

function ClipSettings({ s, onSaved }: { s: KickClipsState; onSaved?: () => void }) {
  const channels = useDiscordChannels();
  const [draft, setDraft] = useState<KickClipSettings>(s.settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(s.settings);
  const set = (patch: Partial<KickClipSettings>) => (setDraft({ ...draft, ...patch }), setMessage(null));
  const folder = draft.folder ?? (s.settings.folder === null ? s.folder : 'Videos\\CONDUIT Clips (the default)');

  const save = async () => {
    const problems = schemaFieldErrors(kickClipSettingsSchema, draft);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      await api('POST', '/api/kick/clips', draft);
      setMessage({ ok: true, text: 'Saved.' });
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiClientError && e.issues.length) setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    const r = await bridge?.files?.chooseFolder('clips');
    if (r?.ok && r.data.path) set({ folder: r.data.path });
    else if (r && !r.ok) setMessage({ ok: false, text: r.error.message });
  };

  return (
    <section className="card" aria-labelledby="clip-settings-title">
      <h2 id="clip-settings-title">Clip settings</h2>
      <div className="clip-settings">
        <div>
          <h3 className="clip-settings-head">Discord</h3>
          <DiscordChannelPicker
            channels={channels}
            guildId={draft.guildId ?? ''}
            channelId={draft.channelId ?? ''}
            needs={['viewChannel', 'sendMessages', 'embedLinks']}
            label="Post clips in"
            onChange={(g, ch) => set({ guildId: g || null, channelId: ch || null })}
            error={errors.channelId}
          />
          <label className="inline-check">
            <input type="checkbox" checked={draft.autoPost} onChange={(e) => set({ autoPost: e.target.checked })} /> Post new clips automatically
          </label>
          <p className="muted small">
            Checked every 2 minutes, so clips made in chat with Kick’s <code>/clip</code> show up within a few minutes. Only clips made after you turn
            this on are posted, each with its thumbnail and Watch stream and View clip on Kick buttons.
          </p>
        </div>
        <div>
          <h3 className="clip-settings-head">Saving</h3>
          <span className="field-label">Saved clips go to</span>
          <code className="clip-folder small">{folder}</code>
          <div className="clip-folder-actions">
            {bridge?.files && (
              <Button variant="ghost" onClick={() => void chooseFolder()}>
                Change…
              </Button>
            )}
            {draft.folder && (
              <Button variant="ghost" onClick={() => set({ folder: null })}>
                Use default
              </Button>
            )}
            {bridge?.files?.openClipsFolder && !changed && (
              <Button variant="ghost" onClick={() => void bridge!.files!.openClipsFolder!().then((r) => !r.ok && setMessage({ ok: false, text: r.error.message }))}>
                Open folder
              </Button>
            )}
          </div>
          {errors.folder && <p className="field-error">{errors.folder}</p>}
          <p className="muted small">Saved as .ts video files (Kick’s format), which VLC and most players open.</p>
        </div>
      </div>
      <div className="form-actions">
        <Button disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {changed && (
          <Button variant="ghost" disabled={busy} onClick={() => (setDraft(s.settings), setErrors({}))}>
            Discard
          </Button>
        )}
        {message && (
          <span className={`small ${message.ok ? 'text-ok' : 'text-bad'}`} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ── the clips ─────────────────────────────────────────────────────────────────

function ClipList({ s, onChanged }: { s: KickClipsState; onChanged?: () => void }) {
  const [shown, setShown] = useState(PAGE);
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshing(true);
    setProblem(null);
    try {
      await api('POST', '/api/kick/clips/refresh');
      onChanged?.();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  const lastProblem = problem ?? s.lastCheck?.problem ?? null;
  return (
    <section className="card" aria-labelledby="clips-title">
      <div className="card-head">
        <div>
          <h2 id="clips-title">Clips{s.clips.length ? ` (${s.clips.length})` : ''}</h2>
          <p className="muted small">
            {s.channel ? (
              <>
                Clips of <strong>kick.com/{s.channel.slug}</strong>, made by anyone on Kick.
                {s.lastCheck && !s.lastCheck.problem && <> Updated {ago(s.lastCheck.at)}.</>}
              </>
            ) : (
              'Your Kick channel’s clips.'
            )}
          </p>
        </div>
        {s.channel && (
          <Button variant="ghost" busy={refreshing} onClick={() => void refresh()}>
            Refresh
          </Button>
        )}
      </div>
      {lastProblem && <p className="small text-warn">{lastProblem}</p>}
      {s.channel && !s.settings.channelId && s.clips.length > 0 && <p className="small muted">Choose a Discord channel in Clip settings to post clips.</p>}
      {!s.channel ? (
        <p className="muted">Connect your main Kick account first (Dashboard → Kick).</p>
      ) : s.clips.length === 0 ? (
        <p className="muted">No clips yet. Clips made on your channel show up here.</p>
      ) : (
        <>
          <ul className="clip-list">
            {s.clips.slice(0, shown).map((c) => (
              <ClipItem key={c.id} c={c} canPost={s.settings.channelId !== null} folder={s.folder} />
            ))}
          </ul>
          {s.clips.length > shown && (
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setShown(shown + PAGE)}>
                Show more ({s.clips.length - shown} left)
              </Button>
            </div>
          )}
        </>
      )}
      <p className="muted small clip-note">Kick has no official clips API yet, so this list comes from Kick’s website and may stop working if Kick changes it.</p>
    </section>
  );
}

function ClipItem({ c, canPost, folder }: { c: KickClipView; canPost: boolean; folder: string }) {
  const [busy, setBusy] = useState<'post' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: 'post' | 'save') => {
    setBusy(what);
    setResult(null);
    try {
      await api('POST', `/api/kick/clips/${c.id}/${what}`);
      setResult({ ok: true, text: what === 'post' ? 'Posted in Discord.' : `Saved in ${folder}.` });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const openClip = bridge?.kick.openClip;
  return (
    <li className="clip-item">
      <div className="clip-main">
        <div className="clip-title">
          {c.title} <span className="clip-length">{formatLength(c.durationSeconds)}</span>
        </div>
        <div className="muted small">
          {[c.creatorName ? `Clipped by ${c.creatorName}` : null, ago(c.createdAt), c.category, `${c.views.toLocaleString('en-US')} view${c.views === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
        </div>
        {result && (
          <div className={`small ${result.ok ? 'text-ok' : 'text-bad'}`} role={result.ok ? 'status' : 'alert'}>
            {result.text}
          </div>
        )}
      </div>
      <div className="row-actions">
        <Button variant="secondary" busy={busy === 'post'} disabled={busy !== null || !canPost} title={canPost ? undefined : 'Choose a Discord channel in Clip settings first'} onClick={() => void run('post')}>
          Post to Discord
        </Button>
        <Button variant="ghost" busy={busy === 'save'} disabled={busy !== null} onClick={() => void run('save')}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {openClip && (
          <Button variant="ghost" onClick={() => void openClip(c.url)}>
            Open on Kick
          </Button>
        )}
      </div>
    </li>
  );
}

function formatLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then the date. */
function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return unit(Math.floor(seconds / 86_400), 'day');
  return new Date(iso).toLocaleDateString();
}
