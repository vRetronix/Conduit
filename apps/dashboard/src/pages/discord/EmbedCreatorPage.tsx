/**
 * Discord → Embed Creator: build a message (text, up to 10 embeds, buttons and select menus) visually or as JSON, send it
 * as your bot, and edit it later from the Embeds list. A message's name is its embeds' name in the library: they're
 * saved there automatically.
 */
import { useEffect, useRef, useState } from 'react';
import {
  EMBEDS_PER_MESSAGE,
  EMPTY_DRAFT,
  MESSAGE_NAME_MAX,
  messageDraftSchema,
  messageToJson,
  type MessageDraft,
  type PostedMessageView,
} from '@conduit/shared/discord/discord-messages';
import { EMBED_LIMITS, EMPTY_EMBED, embedSchema, type SavedEmbedView } from '@conduit/shared/discord/embeds';
import { api, errorMessage } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { ComponentsEditor } from '../../components/discord/ComponentsEditor';
import { EditorModeTabs, EmbedEditor, JsonEditor } from '../../components/discord/EmbedEditor';
import { Button, ErrorBanner, Field, Loading } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

export function EmbedCreatorPage() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<PostedMessageView[]>('GET', '/api/discord/messages'), [backend?.state === 'running']);
  usePolling(reload, error ? 3000 : 30_000, [data, error]);
  return <EmbedCreatorView messages={data ?? null} loadProblem={error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : null} onChanged={reload} />;
}

/** What the editor's message will become: a new message, or a change to one in the Embeds list. */
type Target = { kind: 'new' } | { kind: 'edit'; message: PostedMessageView };

function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      onDone?.();
      return r;
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function EmbedCreatorView({ messages, loadProblem = null, onChanged }: { messages: PostedMessageView[] | null; loadProblem?: string | null; onChanged?: () => void }) {
  const [draft, setDraft] = useState<MessageDraft>(structuredClone(EMPTY_DRAFT));
  const [target, setTarget] = useState<Target>({ kind: 'new' });
  const [name, setName] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  // A new key re-creates the editor (and its JSON text) when another message is loaded.
  const [editorKey, setEditorKey] = useState(0);
  const autosave = useAutosave(draft, name);
  const open = (d: MessageDraft, t: Target, n: string, why: string[] = []) => {
    setDraft(structuredClone(d));
    setTarget(t);
    setName(n);
    setNotes(why);
    setEditorKey((k) => k + 1);
    // A message already saved under a name keeps updating those library entries.
    autosave.reset(n || null);
  };
  return (
    <div className="stack">
      <MessageEditor
        key={editorKey}
        draft={draft}
        onDraft={setDraft}
        target={target}
        name={name}
        onName={setName}
        saveStatus={autosave.status}
        notes={notes}
        onSent={(m) => {
          open(m.draft, { kind: 'edit', message: m }, m.name);
          onChanged?.();
        }}
        onNew={() => open(structuredClone(EMPTY_DRAFT), { kind: 'new' }, '')}
        onCopy={() => {
          setTarget({ kind: 'new' });
          // A copy gets its own name, so it's saved as new library entries.
          const copy = name ? `Copy of ${name}`.slice(0, MESSAGE_NAME_MAX) : '';
          setName(copy);
          autosave.reset(null);
        }}
      />
      <PostedMessages messages={messages} loadProblem={loadProblem} editingId={target.kind === 'edit' ? target.message.id : null} onEdit={(m) => open(m.draft, { kind: 'edit', message: m }, m.name)} onChanged={onChanged} />
    </div>
  );
}

/**
 * Saves the message's embeds to the library automatically, under its name ("Rules", "Rules (2)"…), a moment after each
 * change. Only valid embeds are saved; renaming moves the entries; removed embeds' entries go. Nothing is saved until
 * the message has a name.
 */
function useAutosave(draft: MessageDraft, name: string) {
  const savedAs = useRef<string | null>(null);
  const lastSent = useRef<string>('');
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    const n = name.trim();
    if (!n || n.length > MESSAGE_NAME_MAX) return;
    const embeds = draft.embeds.filter((e) => embedSchema.safeParse(e).success);
    const body = { name: n, previousName: savedAs.current, embeds };
    const key = JSON.stringify(body);
    if (key === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = key;
      api<SavedEmbedView[]>('POST', '/api/discord/embeds/autosave', body).then(
        (saved) => {
          savedAs.current = n;
          setStatus(saved.length === 0 ? 'Nothing to save yet: add an embed.' : `Saved to the library as ${saved.map((x) => `“${x.name}”`).join(', ')}.`);
        },
        (err) => {
          lastSent.current = '';
          setStatus(`Not saved to the library: ${errorMessage(err)}`);
        },
      );
    }, 900);
    return () => clearTimeout(timer);
  }, [draft, name]);
  return {
    status,
    /** Another message was opened: it's saved under this name from now on (null: a new name). */
    reset: (n: string | null) => {
      savedAs.current = n;
      lastSent.current = '';
      setStatus(null);
    },
  };
}

function MessageEditor({
  draft,
  onDraft,
  target,
  name,
  onName,
  saveStatus,
  notes,
  onSent,
  onNew,
  onCopy,
}: {
  draft: MessageDraft;
  onDraft: (d: MessageDraft) => void;
  target: Target;
  name: string;
  onName: (n: string) => void;
  saveStatus: string | null;
  notes: string[];
  onSent: (m: PostedMessageView) => void;
  onNew: () => void;
  onCopy: () => void;
}) {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [active, setActive] = useState(0);
  const check = messageDraftSchema.safeParse(draft);
  const shown = Math.min(active, draft.embeds.length - 1);
  const issues = check.success
    ? []
    : [
        ...new Set(
          check.error.issues.flatMap((i) => {
            const at = i.path[0] === 'embeds' && typeof i.path[1] === 'number' ? i.path[1] : null;
            if (at === shown) return [];
            return [at === null ? i.message : `Embed ${at + 1}: ${i.message}`];
          }),
        ),
      ];
  const embed = draft.embeds[Math.min(active, draft.embeds.length - 1)];
  const setEmbeds = (embeds: MessageDraft['embeds']) => onDraft({ ...draft, embeds });
  return (
    <section className="card" aria-labelledby="message-editor-title">
      <div className="card-head">
        <div>
          <h2 id="message-editor-title">{target.kind === 'edit' ? `Editing “${target.message.name}”` : 'New message'}</h2>
          <TargetNote target={target} />
        </div>
        {target.kind !== 'new' && (
          <Button variant="secondary" className="btn-row" onClick={onNew}>
            New message
          </Button>
        )}
      </div>
      {notes.map((n) => (
        <p key={n} className="small text-warn">
          {n}
        </p>
      ))}
      <EditorModeTabs mode={mode} onMode={setMode} />
      {mode === 'json' ? (
        <JsonEditor label="Message JSON" initialText={JSON.stringify(messageToJson(draft), null, 2)} onDraft={(d) => (onDraft(d), setActive(0))} />
      ) : (
        <>
          <label className="field">
            <span className="field-label">
              Message text{' '}
              <span className={`char-count${draft.content.length > EMBED_LIMITS.content ? ' over' : ''}`}>
                {draft.content.length}/{EMBED_LIMITS.content}
              </span>
            </span>
            <textarea rows={3} value={draft.content} onChange={(e) => onDraft({ ...draft, content: e.target.value })} placeholder="Optional text above the embeds" />
          </label>
          <div className="embed-tabs" role="tablist" aria-label="Embeds">
            {draft.embeds.map((_, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === active} className={`editor-mode-tab${i === active ? ' active' : ''}`} onClick={() => setActive(i)}>
                Embed {i + 1}
              </button>
            ))}
            {draft.embeds.length < EMBEDS_PER_MESSAGE && (
              <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => (setEmbeds([...draft.embeds, structuredClone(EMPTY_EMBED)]), setActive(draft.embeds.length))}>
                + Add embed
              </Button>
            )}
            {embed && (
              <Button
                variant="ghost"
                className="btn btn-ghost btn-small btn-row-delete"
                onClick={() => (setEmbeds(draft.embeds.filter((_, i) => i !== active)), setActive(Math.max(0, active - 1)))}
              >
                Remove embed {Math.min(active, draft.embeds.length - 1) + 1}
              </Button>
            )}
          </div>
          {embed ? (
            <EmbedEditor
              key={Math.min(active, draft.embeds.length - 1)}
              json={false}
              library={false}
              value={embed}
              onChange={(e) => setEmbeds(draft.embeds.map((x, i) => (i === Math.min(active, draft.embeds.length - 1) ? e : x)))}
              preview={{ content: draft.content, components: draft.components }}
            />
          ) : (
            <p className="empty-note">No embeds: the message is text only.</p>
          )}
          {draft.externalComponents ? (
            <p className="muted small">This message’s buttons belong to another CONDUIT feature (for example a giveaway) and stay as they are.</p>
          ) : (
            <ComponentsEditor rows={draft.components} onChange={(components) => onDraft({ ...draft, components })} />
          )}
        </>
      )}
      {issues.length > 0 && (
        <ul className="embed-issues" role="alert">
          {issues.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <SendPanel draft={draft} valid={issues.length === 0} target={target} name={name} onName={onName} saveStatus={saveStatus} onSent={onSent} onCopy={onCopy} />
    </section>
  );
}

function TargetNote({ target }: { target: Target }) {
  if (target.kind === 'new') return <p className="muted small">Send it as your bot when it’s ready.</p>;
  const m = target.message;
  return (
    <p className="muted small">
      In #{m.channelName ?? 'a channel'}
      {m.place ? ` · ${m.place}` : ''}
    </p>
  );
}

function SendPanel({
  draft,
  valid,
  target,
  name,
  onName,
  saveStatus,
  onSent,
  onCopy,
}: {
  draft: MessageDraft;
  valid: boolean;
  target: Target;
  name: string;
  onName: (n: string) => void;
  saveStatus: string | null;
  onSent: (m: PostedMessageView) => void;
  onCopy: () => void;
}) {
  const channels = useDiscordChannels();
  const [guildId, setGuildId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const ready = valid && name.trim() !== '';
  const finish = (m: PostedMessageView | undefined, text: string) => {
    if (!m) return;
    setDone(text);
    onSent(m);
  };
  return (
    <div className="stack send-panel">
      <div className="form-grid">
        <Field
          label="Name"
          value={name}
          maxLength={MESSAGE_NAME_MAX}
          onChange={onName}
          hint={saveStatus ?? (name.trim() ? 'Saving to the library…' : 'Its embeds are saved to the library under this name.')}
        />
        {target.kind === 'new' && (
          <DiscordChannelPicker channels={channels} guildId={guildId} channelId={channelId} needs={['viewChannel', 'sendMessages', 'embedLinks']} onChange={(g, c) => (setGuildId(g), setChannelId(c))} label="Send to" />
        )}
      </div>
      <ErrorBanner error={error} />
      {done && <p className="small text-ok">{done}</p>}
      <div className="form-actions">
        {target.kind === 'new' && (
          <Button busy={busy} disabled={!ready || !channelId} onClick={() => void run(async () => finish(await api<PostedMessageView>('POST', '/api/discord/messages', { name, guildId, channelId, draft }), 'Sent.'))}>
            Send as the bot
          </Button>
        )}
        {target.kind === 'edit' && (
          <>
            <Button
              busy={busy}
              disabled={!ready}
              onClick={() => void run(async () => finish(await api<PostedMessageView>('PATCH', `/api/discord/messages/${target.message.id}`, { name, draft }), 'Saved in Discord.'))}
            >
              Save changes in Discord
            </Button>
            <Button variant="secondary" onClick={onCopy}>
              Send as a new copy…
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Embeds sent with the Embed Creator, which can be edited later. */
function PostedMessages({
  messages,
  loadProblem,
  editingId,
  onEdit,
  onChanged,
}: {
  messages: PostedMessageView[] | null;
  loadProblem: string | null;
  editingId: string | null;
  onEdit: (m: PostedMessageView) => void;
  onChanged?: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const { busy, error, run } = useAction(onChanged);
  return (
    <section className="card" aria-labelledby="posted-messages-title">
      <h2 id="posted-messages-title">Embeds</h2>
      <p className="muted small">Embeds you’ve sent with the Embed Creator: edit them here and the message in Discord changes too.</p>
      <ErrorBanner error={error} />
      {messages === null ? (
        <Loading label={loadProblem ?? 'Loading embeds…'} />
      ) : messages.length === 0 ? (
        <p className="empty-note">None yet. Build one above and send it.</p>
      ) : (
        <div className="table-scroll">
          <table className="table commands-table">
            <thead>
              <tr>
                <th scope="col">Embed</th>
                <th scope="col">Where</th>
                <th scope="col">Changed</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    {editingId === m.id && <span className="pill pill-muted"> Editing</span>}
                    <div className="muted small">
                      {m.draft.embeds.length} embed{m.draft.embeds.length === 1 ? '' : 's'}
                      {m.draft.content ? ' + text' : ''}
                    </div>
                  </td>
                  <td className="small">
                    #{m.channelName ?? 'unknown channel'}
                    {m.place && <div className="muted">{m.place}</div>}
                  </td>
                  <td className="nowrap muted small">{new Date(m.updatedAt).toLocaleString()}</td>
                  <td className="actions">
                    {confirm === m.id ? (
                      <span className="row-actions">
                        <Button variant="secondary" className="btn-row" busy={busy} onClick={() => void run(() => api('POST', `/api/discord/messages/${m.id}/remove`, { fromDiscord: false }))}>
                          Remove from list
                        </Button>
                        <Button variant="danger" className="btn-row" busy={busy} onClick={() => void run(() => api('POST', `/api/discord/messages/${m.id}/remove`, { fromDiscord: true }))}>
                          Delete in Discord too
                        </Button>
                        <Button variant="secondary" className="btn-row" onClick={() => setConfirm(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <span className="row-actions">
                        <Button variant="secondary" className="btn-row" onClick={() => onEdit(m)}>
                          Edit
                        </Button>
                        <CopyButton text={m.link} label="Copy link" />
                        <Button variant="secondary" className="btn-row btn-row-delete" onClick={() => setConfirm(m.id)}>
                          Remove
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
    </section>
  );
}
