import { useEffect, useRef, useState } from 'react';
import type { AlertFeed, AlertView } from '@conduit/shared/app/alerts';
import { api } from '../api';
import { useAppearance } from '../theme/appearance';
import { resolveTheme, type ThemeDefinition } from '../theme/registry';
import { ThemeSprite } from '../theme/ThemeSprite';

const POLL_MS = 4000;
/** How long a bubble stays: errors stay until closed. */
const SHOW_MS: Record<AlertView['level'], number | null> = { info: 6000, warn: 10_000, error: null };
const MAX_SHOWN = 4;
const TEST_EVENT = 'conduit:test-alert';
let testIds = 0;

/** Shows a sample bubble (Settings → Appearance & Themes), to see how notifications look in the current theme. */
export function showTestAlert(level: AlertView['level']): void {
  window.dispatchEvent(new CustomEvent<AlertView['level']>(TEST_EVENT, { detail: level }));
}

/**
 * Pop-up alerts ("bubbles") in the corner, on every page: a platform rate limiting, an account disconnecting or coming
 * back, a role reward that couldn't be given. Only alerts raised after the dashboard opened are shown.
 */
export function Toasts() {
  const [shown, setShown] = useState<AlertView[]>([]);
  const after = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const feed = await api<AlertFeed>('POST', '/api/alerts/query', { after: after.current });
        if (!active) return;
        // The backend restarted (its ids start again): carry on from its newest alert.
        if (after.current !== null && feed.latestId < after.current) after.current = feed.latestId;
        else {
          after.current = feed.latestId;
          if (feed.alerts.length) setShown((list) => [...list, ...feed.alerts].slice(-MAX_SHOWN));
        }
      } catch {
        // Backend unavailable (e.g. restarting): try again later; the status pill already says so.
      }
      if (active) timer = setTimeout(next, POLL_MS);
    };
    // Paused while the window is hidden; alerts raised meanwhile are fetched as soon as it is visible again.
    const next = () => {
      if (!document.hidden) void poll();
      else document.addEventListener('visibilitychange', onVisible);
    };
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      void poll();
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Sample bubbles (negative ids never clash with the backend's).
  useEffect(() => {
    const onTest = (e: Event) => {
      const level = (e as CustomEvent<AlertView['level']>).detail;
      const sample: AlertView = {
        id: -++testIds,
        at: new Date().toISOString(),
        level,
        title: level === 'error' ? 'Something went wrong' : 'A test notification',
        detail: level === 'error' ? 'This is what an error looks like. Nothing actually failed.' : 'This is what notifications look like in this theme.',
      };
      setShown((list) => [...list, sample].slice(-MAX_SHOWN));
    };
    window.addEventListener(TEST_EVENT, onTest);
    return () => window.removeEventListener(TEST_EVENT, onTest);
  }, []);

  const close = (id: number) => setShown((list) => list.filter((a) => a.id !== id));

  const { applied, preview } = useAppearance();
  const art = resolveTheme((preview ?? applied).themeId).art;

  return <ToastStack alerts={shown} art={art} onClose={close} />;
}

/** The shown bubbles, oldest first. Only the newest one gets the theme's character (one at a time). */
export function ToastStack({ alerts, art, onClose }: { alerts: readonly AlertView[]; art?: ThemeDefinition['art']; onClose: (id: number) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {alerts.map((a, i) => (
        <Toast key={a.id} alert={a} art={i === alerts.length - 1 ? art : undefined} onClose={() => onClose(a.id)} />
      ))}
    </div>
  );
}

/**
 * One bubble. With a theme character (Retronix), it is hauled up from the bottom of the window and the character peeks
 * out from behind its right edge; with an error, he tumbles down beside it instead. Either way he stays in a gutter
 * beside the bubble (see .toast-mascot in styles/themes.css), never over its text or buttons. Decorative only.
 */
function Toast({ alert: a, art, onClose }: { alert: AlertView; art?: ThemeDefinition['art']; onClose: () => void }) {
  // The timer starts once per bubble (new bubbles arriving don't restart it).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const ms = SHOW_MS[a.level];
    if (ms === null) return;
    const t = setTimeout(() => closeRef.current(), ms);
    return () => clearTimeout(t);
  }, [a.id, a.level]);
  const character = a.level === 'error' ? (art?.fall ? { art: art.fall, kind: 'fall' } : null) : art?.peek ? { art: art.peek, kind: 'peek' } : null;
  return (
    <div className={`toast-wrap${character ? ' hauled' : ''}`}>
      {character && <ThemeSprite art={character.art} className={`toast-mascot ${character.kind}`} />}
    <div className={`toast toast-${a.level}`} role={a.level === 'error' ? 'alert' : 'status'}>
      <div className="toast-body">
        <strong>{a.title}</strong>
        {a.detail && <span className="small">{a.detail}</span>}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
    </div>
  );
}
