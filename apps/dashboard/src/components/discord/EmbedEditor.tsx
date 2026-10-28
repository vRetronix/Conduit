import { useEffect, useState } from 'react';
import type { ComponentRow } from '@conduit/shared/discord/discord-components';
import { embedToJson, parseMessageJson, type MessageDraft } from '@conduit/shared/discord/discord-messages';
import { EMBED_LIMITS, EMPTY_EMBED, embedSchema, fillTemplate, type DiscordEmbed, type SavedEmbedView } from '@conduit/shared/discord/embeds';
import { api, errorMessage } from '../../api';
import { CopyButton } from '../CopyButton';
import { Button } from '../forms';
import { DiscordMarkdown } from './DiscordMarkdown';

/**
 * A visual Discord embed editor: every embed part, a live preview that looks like Discord, Discord's
 * limits checked as you type, and a library to save, load and reuse embeds. Loading from the library copies the embed
 * (later library edits don't change messages already configured). "JSON" shows and edits the same embed as Discord's
 * JSON, so embeds can be pasted in and copied out as text.
 */
export function EmbedEditor({
  value,
  onChange,
  variables,
  previewVars = {},
  preview,
  json = true,
  library = true,
}: {
  value: DiscordEmbed;
  onChange: (e: DiscordEmbed) => void;
  /** {variables} this feature fills in, with descriptions (shown under the editor). */
  variables?: Record<string, string>;
  /** Sample values for the preview. */
  previewVars?: Record<string, string>;
  /** Extra parts of the message shown in the preview (text, role mention, buttons, labels). */
  preview?: Omit<PreviewProps, 'embed' | 'vars'>;
  /** Offer the Visual / JSON switch (off where a whole-message JSON editor already exists). */
  json?: boolean;
  /** Offer the library controls (off in the Embed Creator, which saves to the library automatically). */
  library?: boolean;
}) {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const set = (patch: Partial<DiscordEmbed>) => onChange({ ...value, ...patch });
  const check = embedSchema.safeParse(value);
  const issues = check.success ? [] : check.error.issues.map((i) => i.message);
  const count = (s: string, max: number) => (
    <span className={`char-count${s.length > max ? ' over' : ''}`}>
      {s.length}/{max}
    </span>
  );
  return (
    <div className="stack">
      {json && <EditorModeTabs mode={mode} onMode={setMode} />}
      <div className="embed-editor">
        {mode === 'json' ? (
          <div className="embed-form">
            <JsonEditor
              label="Embed JSON"
              initialText={JSON.stringify(embedToJson(value), null, 2)}
              single
              onDraft={(d) => d.embeds[0] && onChange(d.embeds[0])}
            />
            {issues.length > 0 && (
              <ul className="embed-issues" role="alert">
                {issues.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
            {library && <EmbedLibrary value={value} onLoad={onChange} />}
          </div>
        ) : (
          <div className="embed-form">
            <div className="embed-row">
              <label className="field">
                <span className="field-label">Author {count(value.authorName, EMBED_LIMITS.author)}</span>
                <input value={value.authorName} onChange={(e) => set({ authorName: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Author icon URL</span>
                <input value={value.authorIconUrl} placeholder="https://…" onChange={(e) => set({ authorIconUrl: e.target.value })} />
              </label>
            </div>
            <div className="embed-row">
              <label className="field">
                <span className="field-label">Title {count(value.title, EMBED_LIMITS.title)}</span>
                <input value={value.title} onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Title link</span>
                <input value={value.url} placeholder="https://…" onChange={(e) => set({ url: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Description {count(value.description, EMBED_LIMITS.description)}</span>
              <textarea rows={4} value={value.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <div className="embed-fields">
              <span className="field-label">
                Fields ({value.fields.length}/{EMBED_LIMITS.fields})
              </span>
              {value.fields.map((f, i) => {
                const setField = (patch: Partial<typeof f>) => set({ fields: value.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                const move = (to: number) => {
                  const next = [...value.fields];
                  next.splice(to, 0, ...next.splice(i, 1));
                  set({ fields: next });
                };
                return (
                  <div key={i} className="embed-field-card">
                    <div className="embed-field-head">
                      <span className="embed-field-title">
                        Field {i + 1}
                        {f.name.trim() ? <span className="muted"> – {f.name.trim()}</span> : null}
                      </span>
                      <span className="row-actions">
                        <Button variant="ghost" className="btn btn-ghost btn-small" aria-label={`Move field ${i + 1} up`} disabled={i === 0} onClick={() => move(i - 1)}>
                          ↑
                        </Button>
                        <Button variant="ghost" className="btn btn-ghost btn-small" aria-label={`Move field ${i + 1} down`} disabled={i === value.fields.length - 1} onClick={() => move(i + 1)}>
                          ↓
                        </Button>
                        {value.fields.length < EMBED_LIMITS.fields && (
                          <Button variant="ghost" className="btn btn-ghost btn-small" aria-label={`Duplicate field ${i + 1}`} onClick={() => set({ fields: [...value.fields.slice(0, i + 1), { ...f }, ...value.fields.slice(i + 1)] })}>
                            Duplicate
                          </Button>
                        )}
                        <Button variant="ghost" className="btn btn-ghost btn-small" aria-label={`Remove field ${i + 1}`} onClick={() => set({ fields: value.fields.filter((_, j) => j !== i) })}>
                          ✕
                        </Button>
                      </span>
                    </div>
                    <div className="embed-field-name-row">
                      <label className="field">
                        <span className="field-label">Name {count(f.name, EMBED_LIMITS.fieldName)}</span>
                        <input aria-label={`Field ${i + 1} name`} value={f.name} onChange={(e) => setField({ name: e.target.value })} />
                      </label>
                      <label className="inline-check">
                        <input type="checkbox" checked={f.inline} onChange={(e) => setField({ inline: e.target.checked })} /> Inline
                      </label>
                    </div>
                    <label className="field">
                      <span className="field-label">Value {count(f.value, EMBED_LIMITS.fieldValue)}</span>
                      <textarea aria-label={`Field ${i + 1} value`} rows={4} value={f.value} onChange={(e) => setField({ value: e.target.value })} />
                    </label>
                  </div>
                );
              })}
              {value.fields.length < EMBED_LIMITS.fields && (
                <Button variant="ghost" className="btn btn-ghost btn-small" onClick={() => set({ fields: [...value.fields, { name: '', value: '', inline: false }] })}>
                  + Add field
                </Button>
              )}
            </div>
            <div className="embed-row">
              <label className="field">
                <span className="field-label">Thumbnail URL</span>
                <input value={value.thumbnailUrl} placeholder="https://…" onChange={(e) => set({ thumbnailUrl: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Image URL</span>
                <input value={value.imageUrl} placeholder="https://…" onChange={(e) => set({ imageUrl: e.target.value })} />
              </label>
            </div>
            <div className="embed-row">
              <label className="field">
                <span className="field-label">Footer {count(value.footerText, EMBED_LIMITS.footer)}</span>
                <input value={value.footerText} onChange={(e) => set({ footerText: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Footer icon URL</span>
                <input value={value.footerIconUrl} placeholder="https://…" onChange={(e) => set({ footerIconUrl: e.target.value })} />
              </label>
            </div>
            <div className="embed-row embed-row-tight">
              <label className="field field-narrow">
                <span className="field-label">Color</span>
                <span className="color-pick">
                  <input type="color" value={value.color} onChange={(e) => set({ color: e.target.value })} aria-label="Embed color" />
                  <input value={value.color} maxLength={7} onChange={(e) => set({ color: e.target.value })} aria-label="Embed color hex" />
                </span>
              </label>
              <label className="inline-check">
                <input type="checkbox" checked={value.timestamp} onChange={(e) => set({ timestamp: e.target.checked })} /> Show the time it’s posted
              </label>
            </div>
            {variables && Object.keys(variables).length > 0 && (
              <p className="muted small">
                Variables:{' '}
                {Object.entries(variables).map(([v, d], i) => (
                  <span key={v}>
                    {i > 0 && ', '}
                    <code title={d}>{`{${v}}`}</code>
                  </span>
                ))}
              </p>
            )}
            {issues.length > 0 && (
              <ul className="embed-issues" role="alert">
                {issues.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
            {library && <EmbedLibrary value={value} onLoad={onChange} />}
          </div>
        )}
        <EmbedPreview embed={value} vars={previewVars} {...preview} />
      </div>
    </div>
  );
}

/** Visual / JSON switch for an embed or message editor. */
export function EditorModeTabs({ mode, onMode }: { mode: 'visual' | 'json'; onMode: (m: 'visual' | 'json') => void }) {
  return (
    <div className="editor-mode" role="tablist" aria-label="Editor">
      {(['visual', 'json'] as const).map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} className={`editor-mode-tab${mode === m ? ' active' : ''}`} onClick={() => onMode(m)}>
          {m === 'visual' ? 'Visual' : 'JSON'}
        </button>
      ))}
    </div>
  );
}

/**
 * Edits Discord's JSON for an embed or a whole message. Every valid change is applied straight away; problems are
 * explained under the box.
 */
export function JsonEditor({ label, initialText, single = false, onDraft }: { label: string; initialText: string; single?: boolean; onDraft: (d: MessageDraft) => void }) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const change = (t: string) => {
    setText(t);
    const r = parseMessageJson(t);
    if (!r.ok) {
      setError(r.error);
      setNotes([]);
      return;
    }
    const n = [...r.notes];
    if (single) {
      if (r.draft.embeds.length === 0) {
        setError('There’s no embed in it.');
        setNotes([]);
        return;
      }
      if (r.draft.embeds.length > 1) n.push(`It has ${r.draft.embeds.length} embeds; only the first is used here.`);
      if (r.draft.content.trim()) n.push('Message text isn’t part of an embed, so it was left out.');
    }
    setError(null);
    setNotes(n);
    onDraft(r.draft);
  };
  return (
    <div className="json-editor">
      <label className="field">
        <span className="field-label">{label}</span>
        <textarea className="json-text" rows={18} spellCheck={false} value={text} aria-invalid={error ? true : undefined} onChange={(e) => change(e.target.value)} />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
      <div className="editor-row">
        <CopyButton text={text} label="Copy JSON" />
        <span className="muted small">Discord’s message JSON: paste a whole message, one embed or a list of embeds.</span>
      </div>
    </div>
  );
}

/** A preview styled like Discord's embed (dark theme), with sample variable values and Discord markdown. */
interface PreviewProps {
  embed: DiscordEmbed | null;
  vars?: Record<string, string>;
  content?: string;
  /** A role mention shown before the text (e.g. "@Live Pings"). */
  mention?: string | null;
  /** Link buttons under the embed. */
  buttons?: Array<{ label: string; url: string }>;
  /** Embed Creator buttons and select menus, row by row. */
  components?: ComponentRow[];
  /** Shown above the preview (e.g. that the values are sample data). */
  note?: string;
  /** Labels for image placeholders (e.g. "Stream thumbnail"). */
  imageLabels?: { image?: string; thumb?: string };
  /**
   * Bundled example pictures shown instead of a placeholder, by the (filled-in) image URL they stand for — e.g. the
   * sample stream thumbnail. Any other URL keeps its placeholder: the preview never loads remote images.
   */
  imageSamples?: Readonly<Record<string, string>>;
}

export function EmbedPreview({ embed: e, vars = {}, content, mention, buttons = [], components = [], note, imageLabels = {}, imageSamples = {} }: PreviewProps) {
  const f = (s: string) => fillTemplate(s, vars);
  const url = (s: string) => (/^https?:\/\/\S+$/i.test(f(s)) ? f(s) : null);
  return (
    <div className="discord-preview" aria-label="Preview">
      <div className="dp-message">
        <div className="dp-avatar" aria-hidden="true" />
        <div className="dp-body">
          <div className="dp-name">
            Your bot <span className="dp-tag">APP</span>
          </div>
          {(mention || content) && (
            <div className="dp-content">
              {mention && <span className="dp-mention">{mention}</span>}
              {mention && content ? ' ' : ''}
              {content ? <DiscordMarkdown text={f(content)} /> : ''}
            </div>
          )}
          {e && (
            <div className="dp-embed" style={{ borderLeftColor: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : '#202225' }}>
              <div className="dp-embed-main">
                {e.authorName && (
                  <div className="dp-author">
                    {url(e.authorIconUrl) && <ImageSpot url={url(e.authorIconUrl)!} kind="icon" />}
                    {f(e.authorName)}
                  </div>
                )}
                {e.title && (
                  <div className={`dp-title${url(e.url) ? ' dp-link' : ''}`}>
                    <DiscordMarkdown text={f(e.title)} inline />
                  </div>
                )}
                {e.description && (
                  <div className="dp-description">
                    <DiscordMarkdown text={f(e.description)} />
                  </div>
                )}
                {e.fields.length > 0 && (
                  <div className="dp-fields">
                    {e.fields.map((x, i) => (
                      <div key={i} className={`dp-field${x.inline ? ' dp-inline' : ''}`}>
                        <div className="dp-field-name">
                          <DiscordMarkdown text={f(x.name)} inline />
                        </div>
                        <div className="dp-field-value">
                          <DiscordMarkdown text={f(x.value)} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {url(e.imageUrl) && <ImageSpot url={url(e.imageUrl)!} kind="image" label={imageLabels.image} sample={imageSamples[url(e.imageUrl)!]} />}
                {(e.footerText || e.timestamp) && (
                  <div className="dp-footer">
                    {url(e.footerIconUrl) && <ImageSpot url={url(e.footerIconUrl)!} kind="icon" />}
                    {f(e.footerText)}
                    {e.footerText && e.timestamp ? ' • ' : ''}
                    {e.timestamp ? 'Today at 12:00' : ''}
                  </div>
                )}
              </div>
              {url(e.thumbnailUrl) && <ImageSpot url={url(e.thumbnailUrl)!} kind="thumb" label={imageLabels.thumb} sample={imageSamples[url(e.thumbnailUrl)!]} />}
            </div>
          )}
          {components.map((row, ri) => (
            <div key={ri} className="dp-row">
              {row.components.map((c) =>
                c.kind === 'button' ? (
                  <span key={c.id} className={`dp-button dp-button-${c.style}${c.disabled ? ' is-disabled' : ''}`} title={c.style === 'link' ? c.url : undefined}>
                    {c.emoji && !c.emoji.startsWith('<') && <span aria-hidden="true">{c.emoji}</span>}
                    {c.label}
                    {c.style === 'link' && <span aria-hidden="true">↗</span>}
                  </span>
                ) : (
                  <span key={c.id} className={`dp-select${c.disabled ? ' is-disabled' : ''}`}>
                    {c.placeholder || 'Make a selection'}
                    <span aria-hidden="true">▾</span>
                  </span>
                ),
              )}
            </div>
          ))}
          {buttons.length > 0 && (
            <div className="dp-buttons">
              {buttons.map((b, i) => (
                <span key={i} className="dp-button" title={f(b.url)}>
                  {f(b.label) || 'Button'} <span aria-hidden="true">↗</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {note && <p className="dp-note small">{note}</p>}
      <p className="muted small">
        Preview. CONDUIT doesn’t load images from the internet, so pictures show as placeholders
        {Object.keys(imageSamples).length > 0 ? ' or example pictures' : ''}; Discord shows the real images.
      </p>
    </div>
  );
}

/** Where Discord will show a picture (CONDUIT itself never loads remote images). */
function ImageSpot({ url, kind, label, sample }: { url: string; kind: 'icon' | 'image' | 'thumb'; label?: string; sample?: string }) {
  if (sample) return <img className={`dp-img dp-img-${kind} dp-img-sample`} src={sample} alt={label ?? 'Example image'} title={label} draggable={false} />;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  return (
    <span className={`dp-img dp-img-${kind}`} title={url}>
      {kind === 'icon' ? '' : (label ?? `Image from ${host}`)}
    </span>
  );
}

/**
 * The saved-embed library: load (reuse a copy), save as new (also how to duplicate), update the loaded one, delete.
 * Loading copies the embed, so library changes never alter messages already configured.
 */
function EmbedLibrary({ value, onLoad }: { value: DiscordEmbed; onLoad: (e: DiscordEmbed) => void }) {
  const [saved, setSaved] = useState<SavedEmbedView[] | null>(null);
  const [loaded, setLoaded] = useState<SavedEmbedView | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const reload = () => api<SavedEmbedView[]>('GET', '/api/discord/embeds').then(setSaved, () => setSaved([]));
  useEffect(() => {
    void reload();
  }, []);
  const act = (p: Promise<unknown>, done: string) =>
    void p.then(
      () => (setNote(done), void reload()),
      (err) => setNote(errorMessage(err)),
    );
  return (
    <div className="embed-library">
      <select
        aria-label="Load a saved embed"
        value={loaded?.id ?? ''}
        onChange={(e) => {
          const found = saved?.find((x) => x.id === e.target.value) ?? null;
          setLoaded(found);
          setNote(null);
          if (found) onLoad(structuredClone(found.embed));
        }}
      >
        <option value="">{saved === null ? 'Loading saved embeds…' : saved.length ? 'Load a saved embed…' : 'No saved embeds yet'}</option>
        {saved?.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {loaded && (
        <>
          <Button variant="secondary" className="btn btn-secondary btn-small" onClick={() => act(api('PATCH', `/api/discord/embeds/${loaded.id}`, { name: loaded.name, embed: value }), `Updated “${loaded.name}”.`)}>
            Update “{loaded.name}”
          </Button>
          <Button
            variant="ghost"
            className="btn btn-ghost btn-small"
            onClick={() => (act(api('DELETE', `/api/discord/embeds/${loaded.id}`), `Deleted “${loaded.name}” from the library.`), setLoaded(null))}
          >
            Delete from library
          </Button>
        </>
      )}
      <input aria-label="Save as" placeholder={loaded ? `Copy of ${loaded.name}` : 'Save as…'} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <Button
        variant="secondary"
        className="btn btn-secondary btn-small"
        disabled={!name.trim()}
        onClick={() => (act(api('POST', '/api/discord/embeds', { name, embed: value }), `Saved “${name}”.`), setName(''))}
      >
        {loaded ? 'Save as new (duplicate)' : 'Save to library'}
      </Button>
      {note && <span className="small muted">{note}</span>}
    </div>
  );
}

export { EMPTY_EMBED };
