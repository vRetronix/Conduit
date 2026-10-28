import { useState } from 'react';
import {
  KICK_GIVEAWAY_MESSAGE_KINDS,
  KICK_GIVEAWAY_MESSAGES,
  kickGiveawayMessageSchema,
  renderKickGiveawayMessage,
  type GiveawaysState,
  type KickGiveawayMessageKind,
  type KickGiveawayMessages,
} from '@conduit/shared/community/giveaways';
import { api, ApiClientError, errorMessage } from '../../api';
import { Button } from '../forms';

/** An example of what a message will look like, with sample values for its variables. */
export function previewKickGiveawayMessage(kind: KickGiveawayMessageKind, template: string): string {
  const vars = Object.fromEntries(Object.entries(KICK_GIVEAWAY_MESSAGES[kind].variables).map(([name, v]) => [name, v.example]));
  return renderKickGiveawayMessage(kind, template, vars);
}

/**
 * The giveaway messages the chatbot posts in Kick chat, edited here before anything is sent. Saving checks every
 * message (one line, Kick's limits, only that message's variables) and sends nothing; the saved text is exactly what is
 * posted, with its variables filled in. There are no ticket or odds variables: those stay private.
 */
export function KickGiveawayMessagesCard({ saved, onSaved, bare = false }: { saved: KickGiveawayMessages; onSaved?: (s: GiveawaysState) => void; bare?: boolean }) {
  const [draft, setDraft] = useState<KickGiveawayMessages>(saved);
  const [errors, setErrors] = useState<Partial<Record<KickGiveawayMessageKind, string>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // One message open at a time keeps the card short; a message with an error opens so the error is visible.
  const [open, setOpen] = useState<KickGiveawayMessageKind | null>(null);

  const changed = KICK_GIVEAWAY_MESSAGE_KINDS.filter((k) => draft[k].trim() !== saved[k]);

  const save = async (body: Partial<Record<KickGiveawayMessageKind, string | null>>, done: string) => {
    setNotice(null);
    setFailure(null);
    setBusy(true);
    try {
      const s = await api<GiveawaysState>('POST', '/api/giveaways/kick-messages', body);
      setDraft(s.kickMessages);
      setErrors({});
      setNotice(done);
      onSaved?.(s);
    } catch (err) {
      const issues = err instanceof ApiClientError ? err.issues : [];
      if (issues.length) {
        const byKind = Object.fromEntries(issues.map((i) => [String(i.path).split('.')[0], i.message])) as Partial<Record<KickGiveawayMessageKind, string>>;
        setErrors(byKind);
        setOpen(KICK_GIVEAWAY_MESSAGE_KINDS.find((k) => byKind[k]) ?? null);
      }
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    const found: Partial<Record<KickGiveawayMessageKind, string>> = {};
    for (const k of changed) {
      const r = kickGiveawayMessageSchema(k).safeParse(draft[k]);
      if (!r.success) found[k] = r.error.issues[0]?.message ?? 'Invalid message';
    }
    setErrors(found);
    const firstBad = KICK_GIVEAWAY_MESSAGE_KINDS.find((k) => found[k]);
    if (firstBad) {
      setOpen(firstBad);
      return;
    }
    void save(Object.fromEntries(changed.map((k) => [k, draft[k]])), 'Saved. Nothing was sent.');
  };

  return (
    <section className={bare ? undefined : 'card'} aria-labelledby={bare ? undefined : 'giveaway-kick-messages'} aria-label={bare ? 'Kick chat messages' : undefined}>
      {!bare && <h2 id="giveaway-kick-messages">Kick chat messages</h2>}
      <p className="muted small">What the chatbot posts in Kick chat during a giveaway. Saving sends nothing; ticket counts and odds are never posted.</p>
      <ul className="kmsg-list">
        {KICK_GIVEAWAY_MESSAGE_KINDS.map((k) => {
          const info = KICK_GIVEAWAY_MESSAGES[k];
          const vars = Object.entries(info.variables);
          const isDefault = draft[k].trim() === info.default;
          const unsaved = changed.includes(k);
          const isOpen = open === k;
          const preview = previewKickGiveawayMessage(k, draft[k]);
          const inputId = `kmsg-${k}`;
          return (
            <li key={k} className={`kmsg${isOpen ? ' kmsg-open' : ''}${errors[k] ? ' kmsg-invalid' : ''}`}>
              <button
                type="button"
                className="kmsg-head"
                aria-expanded={isOpen}
                aria-controls={`${inputId}-body`}
                onClick={() => setOpen(isOpen ? null : k)}
              >
                <span className="kmsg-title">{info.label}</span>
                {unsaved ? <span className="kmsg-tag kmsg-tag-unsaved">Unsaved</span> : !isDefault && <span className="kmsg-tag">Custom</span>}
                <span className="kmsg-snippet">{draft[k]}</span>
                <span className="kmsg-chevron" aria-hidden="true">
                  ▾
                </span>
              </button>
              <div id={`${inputId}-body`} className="kmsg-body" hidden={!isOpen}>
                <input
                  id={inputId}
                  aria-label={info.label}
                  value={draft[k]}
                  maxLength={600}
                  aria-invalid={errors[k] ? true : undefined}
                  aria-describedby={`${inputId}-note`}
                  onChange={(e) => {
                    setDraft({ ...draft, [k]: e.target.value });
                    setErrors({ ...errors, [k]: undefined });
                    setNotice(null);
                  }}
                />
                {errors[k] ? (
                  <span id={`${inputId}-note`} className="field-error">
                    {errors[k]}
                  </span>
                ) : (
                  <span id={`${inputId}-note`} className="kmsg-preview" title={info.when}>
                    Preview: {preview || '(empty: nothing is posted)'}
                  </span>
                )}
                <div className="kmsg-tools">
                  {vars.length > 0 ? (
                    <details className="kmsg-vars">
                      <summary>Available variables</summary>
                      <ul>
                        {vars.map(([name, v]) => (
                          <li key={name}>
                            <code>{`{${name}}`}</code> <span className="muted">{v.description}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <span className="muted small">No variables</span>
                  )}
                  {!isDefault && (
                    <Button variant="ghost" className="btn btn-ghost btn-small" disabled={busy} onClick={() => setDraft({ ...draft, [k]: info.default })}>
                      Reset to default
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="kmsg-actions">
        {notice && (
          <span className="text-ok small" role="status">
            {notice}
          </span>
        )}
        {failure && (
          <span className="text-warn small" role="alert">
            {failure}
          </span>
        )}
        {changed.length > 0 && (
          <Button variant="ghost" disabled={busy} onClick={() => (setDraft(saved), setErrors({}))}>
            Discard
          </Button>
        )}
        <Button disabled={busy || changed.length === 0} onClick={onSave}>
          {busy ? 'Saving…' : 'Save messages'}
        </Button>
      </div>
    </section>
  );
}
