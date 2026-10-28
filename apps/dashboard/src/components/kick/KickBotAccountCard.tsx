import type { KickSetupState } from '@conduit/shared/kick/kick-setup';
import { EntityIcon } from '../EntityIcon';
import { Button } from '../forms';
import { PlatformIcon } from '../PlatformIcon';

/**
 * The separate Kick bot account (the chatbot identity), shown apart from the main Kick account. Everything comes from
 * the Kick setup state: the bot account's identity as Kick verified it when it was connected, the scopes Kick actually
 * granted it, and which account the chatbot uses. Tokens are never part of that state.
 */
export function kickBotStatus(s: KickSetupState): { label: string; pill: string; note: string | null } {
  const main = s.primary.name ?? 'your main account';
  if (s.chatbot.mode === 'primary')
    return { label: 'Not configured', pill: 'pill-muted', note: `The chatbot posts as ${main}. To use a separate bot account, select Manage → Chatbot.` };
  if (s.bot.status === 'connected') return { label: 'Connected', pill: 'pill-ok', note: null };
  if (s.bot.status === 'needs_reauth') return { label: 'Needs Reconnect', pill: 'pill-bad', note: s.bot.problem ?? 'Kick rejected its authorization. Select Manage → Chatbot → Reconnect bot account.' };
  return {
    label: 'Not connected',
    pill: 'pill-muted',
    note: 'A separate bot account is selected but not connected. Log in to kick.com as the bot account, then select Manage → Chatbot → Add Bot Account.',
  };
}

export function KickBotAccountCard({ s, onManage }: { s: KickSetupState; onManage?: () => void }) {
  const b = s.bot;
  const status = kickBotStatus(s);
  const separate = s.chatbot.mode === 'separate';
  const known = separate && b.status !== 'not_connected' && b.name;
  const canChat = b.scopes.includes('chat:write');
  return (
    <article className="card bot-account" aria-label={`Kick bot account: ${status.label}`}>
      <header className="connection-head">
        <PlatformIcon platform="kick" />
        <h2>Kick Bot Account</h2>
        <span className={`pill ${status.pill}`}>{status.label}</span>
      </header>
      <dl className="connection-details">
        <div className="row">
          <dt>Platform</dt>
          <dd>Kick</dd>
        </div>
        <div className="row">
          <dt>Bot account</dt>
          <dd>
            {known ? (
              <span className="account-cell">
                <EntityIcon src={b.avatarDataUrl} name={b.name!} />
                <span>
                  {b.name}
                  {b.handle && b.handle.toLowerCase() !== b.name!.toLowerCase() && <span className="muted"> @{b.handle}</span>}
                </span>
              </span>
            ) : (
              <span className="muted">{status.label}</span>
            )}
          </dd>
        </div>
        {known && b.userId && (
          <div className="row">
            <dt>Kick user ID</dt>
            <dd>{b.userId}</dd>
          </div>
        )}
        <div className="row">
          <dt>Chatbot</dt>
          <dd>
            {separate ? (
              s.chatbot.account === 'bot' && s.chatbot.ready ? (
                <span className="text-ok">Posts as this account</span>
              ) : (
                <span className="text-warn">Selected, not ready to post</span>
              )
            ) : (
              <span className="muted">Uses the main account</span>
            )}
          </dd>
        </div>
        {known && (
          <div className="row">
            <dt>Kick permissions</dt>
            <dd>
              {b.scopes.length ? b.scopes.join(', ') : 'Not reported'}
              {!canChat && <span className="text-warn"> · can’t send chat</span>}
            </dd>
          </div>
        )}
        <div className="row">
          <dt>Moderation</dt>
          <dd className="muted">Not done by this account — it runs as the main account</dd>
        </div>
        <div className="row">
          <dt>Main account</dt>
          <dd>
            {s.primary.name ? (
              <span>
                {s.primary.name} <span className="muted">(channel, rewards, moderation; separate)</span>
              </span>
            ) : (
              <span className="muted">Not connected</span>
            )}
          </dd>
        </div>
        {known && b.lastVerifiedAt && (
          <div className="row">
            <dt>Verified by Kick</dt>
            <dd>{new Date(b.lastVerifiedAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {status.note && <p className="connection-note note-warn">{status.note}</p>}
      {onManage && s.application.configured && (
        <div className="button-row">
          <Button variant="secondary" onClick={onManage}>
            Manage
          </Button>
        </div>
      )}
    </article>
  );
}
