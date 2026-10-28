import { useState } from 'react';
import { LOG_CATEGORIES, LOG_CATEGORY_LABEL, LOG_EVENTS, loggingSettingsSchema, type LogCategory, type LoggingSettings, type LoggingState } from '@conduit/shared/discord/discord-logging';
import { api, ApiClientError, errorMessage } from '../../api';
import { DiscordChannelPicker, useDiscordChannels } from '../../components/discord/DiscordChannelPicker';
import { Button } from '../../components/forms';
import { useAsync, useBackendStatus, usePolling } from '../../hooks';

const CATEGORY_HELP: Record<LogCategory, string> = {
  moderation: 'Bans, unbans, kicks and timeouts from Discord’s audit log (who did it and why), plus CONDUIT’s /ban, /timeout… commands.',
  members: 'Joins, leaves, nickname and role changes.',
  messages: 'Deleted, edited and bulk-deleted messages, with jump links. While this is on, new messages’ text is kept for 7 days so deleted and edited ones can show what was written.',
  server: 'Channels and roles created, deleted or changed.',
  loyalty: 'Level-ups, XP and points adjustments, rewards redeemed and handled, level roles and resets, from Loyalty & Rewards.',
};

/**
 * Discord Logging (Carl-bot-style): each category of server events to a channel you choose. Part of the Discord Moderation
 * page, so it shows a short note while it loads rather than a full-page loader.
 */
export function DiscordLoggingSection() {
  const backend = useBackendStatus();
  const { data, error, reload } = useAsync(() => api<LoggingState>('GET', '/api/discord/logging'), [backend?.state === 'running']);
  usePolling(reload, error ? 2000 : 10_000, [data, error]);
  if (!data) return <p className="muted">{error ? `Waiting for the CONDUIT backend… (${errorMessage(error)})` : 'Loading Discord logging…'}</p>;
  return <DiscordLoggingView key={JSON.stringify(data.settings)} s={data} onSaved={reload} />;
}

export function DiscordLoggingView({ s, onSaved }: { s: LoggingState; onSaved?: () => void }) {
  const channels = useDiscordChannels();
  const [draft, setDraft] = useState<LoggingSettings>(s.settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(s.settings);
  const guilds = channels?.guilds ?? [];
  const guildId = draft.guildId ?? (guilds.length === 1 ? guilds[0]!.id : '');
  const setCat = (c: LogCategory, patch: Partial<LoggingSettings[LogCategory]>) => (setDraft({ ...draft, guildId: draft.guildId ?? (guildId || null), [c]: { ...draft[c], ...patch } }), setMessage(null));

  const save = async () => {
    const body = { ...draft, guildId: draft.guildId ?? (guildId || null) };
    const checked = loggingSettingsSchema.safeParse(body);
    if (!checked.success) {
      setErrors(Object.fromEntries(checked.error.issues.map((i) => [i.path.map(String).join('.'), i.message])));
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api('POST', '/api/discord/logging', checked.data);
      setMessage({ ok: true, text: 'Saved.' });
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiClientError && e.issues.length) setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="logging-title">
      <div className="card-head">
        <div>
          <h2 id="logging-title">Discord logging</h2>
          <p className="muted small">
            Each category posts detailed embeds to a channel you choose; several categories can share one. Only completed actions are logged as done.
            Everything logged is also listed in the Moderation log below.
          </p>
        </div>
        {guilds.length > 1 && (
          <label className="field">
            <span className="field-label">Server</span>
            <select value={guildId} onChange={(e) => setDraft({ ...draft, guildId: e.target.value || null })}>
              <option value="">Choose…</option>
              {guilds.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="log-categories">
        {LOG_CATEGORIES.map((c) => {
          const a = s.availability[c];
          const cat = draft[c];
          return (
            <div key={c} className={`log-category${cat.enabled ? '' : ' log-off'}`}>
              <div className="log-head">
                <label className="switch">
                  <input type="checkbox" aria-label={`${LOG_CATEGORY_LABEL[c]} logging`} checked={cat.enabled} onChange={(e) => setCat(c, { enabled: e.target.checked })} />
                </label>
                <div>
                  <strong>{LOG_CATEGORY_LABEL[c]}</strong>
                  <div className="muted small">{CATEGORY_HELP[c]}</div>
                </div>
              </div>
              <DiscordChannelPicker
                channels={channels ? { ...channels, guilds: channels.guilds.filter((g) => !guildId || g.id === guildId) } : null}
                guildId={guildId}
                channelId={cat.channelId ?? ''}
                needs={['viewChannel', 'sendMessages', 'embedLinks']}
                label="Log to"
                onChange={(g, ch) => (setDraft({ ...draft, guildId: g || draft.guildId, [c]: { ...cat, channelId: ch || null } }), setMessage(null))}
                error={errors[`${c}.channelId`]}
              />
              <div className="log-events">
                {Object.entries(LOG_EVENTS[c]).map(([event, label]) => (
                  <label key={event} className="inline-check small">
                    <input
                      type="checkbox"
                      checked={!cat.off.includes(event)}
                      onChange={(e) => setCat(c, { off: e.target.checked ? cat.off.filter((x) => x !== event) : [...cat.off, event] })}
                    />{' '}
                    {label}
                  </label>
                ))}
              </div>
              {!a.available && <p className="small text-warn">{a.problem}</p>}
              {a.partial && <p className="small muted">{a.partial}</p>}
            </div>
          );
        })}
      </div>
      {errors.guildId && <p className="field-error">{errors.guildId}</p>}
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

