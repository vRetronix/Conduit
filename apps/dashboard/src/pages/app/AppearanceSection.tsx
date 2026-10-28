import { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, type Appearance } from '@conduit/shared/app/appearance';
import { errorMessage } from '../../api';
import { Button } from '../../components/forms';
import { showTestAlert } from '../../components/Toasts';
import { cancelPreview, previewAppearance, saveAppearance, useAppearance } from '../../theme/appearance';
import { resolveTheme, THEMES, type ThemeDefinition } from '../../theme/registry';


/**
 * Settings → Appearance & Themes. Any change is previewed live across the whole app; Apply saves it, Cancel goes back
 * to what was applied. Leaving Settings with an unsaved preview also goes back. Only appearance is touched here.
 */
export function AppearanceSection() {
  const { applied, preview } = useAppearance();
  const draft = preview ?? applied;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Leaving Settings never keeps an unsaved preview.
  useEffect(() => () => cancelPreview(), []);

  const change = (patch: Partial<Appearance>) => {
    setSaved(null);
    previewAppearance({ ...draft, ...patch });
  };
  const save = async (a: Appearance, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await saveAppearance(a);
      setSaved(message);
      setConfirmReset(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const appliedTheme = resolveTheme(applied.themeId);
  const draftTheme = resolveTheme(draft.themeId);

  return (
    <section className="card appearance-card" aria-labelledby="appearance-title">
      <div className="card-head">
        <div>
          <h2 id="appearance-title">Appearance &amp; Themes</h2>
          <p className="muted small">Choose a theme. Preview shows it across the whole app right away; Apply keeps it.</p>
        </div>
      </div>

      {preview && (
        <div className="banner banner-info appearance-previewing" role="status">
          <span>
            Previewing <strong>{draftTheme.name}</strong>. Applied: {appliedTheme.name}.
          </span>
          <span className="button-row">
            <Button variant="ghost" disabled={busy} onClick={() => (cancelPreview(), setSaved(null))}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void save(draft, `${draftTheme.name} applied.`)}>
              Apply
            </Button>
          </span>
        </div>
      )}

      <ul className="theme-grid" aria-label="Themes">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            applied={t.id === appliedTheme.id}
            selected={t.id === draftTheme.id}
            onPreview={() => change({ themeId: t.id })}
            onApply={() => void save({ ...draft, themeId: t.id }, `${t.name} applied.`)}
            busy={busy}
          />
        ))}
      </ul>

      <div className="button-row appearance-test">
        <span className="small muted">See how notifications look in this theme:</span>
        <Button variant="secondary" className="btn btn-secondary btn-small" onClick={() => showTestAlert('info')}>
          Show a test notification
        </Button>
        <Button variant="secondary" className="btn btn-secondary btn-small" onClick={() => showTestAlert('error')}>
          Test an error
        </Button>
      </div>

      <div className="card-foot">
        {error && (
          <span className="small text-bad" role="alert">
            {error}
          </span>
        )}
        {saved && (
          <span className="small text-ok" role="status">
            {saved}
          </span>
        )}
        <div className="button-row">
          {confirmReset ? (
            <>
              <span className="small muted">Back to CONDUIT Default? Nothing else changes.</span>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
                Keep
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void save(DEFAULT_APPEARANCE, 'Appearance reset to the defaults.')}>
                Reset
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmReset(true)}>
              Reset to defaults…
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function ThemeCard({ theme: t, applied, selected, onPreview, onApply, busy }: { theme: ThemeDefinition; applied: boolean; selected: boolean; onPreview: () => void; onApply: () => void; busy: boolean }) {
  const k = t.tokens;
  return (
    <li className={`theme-card${selected ? ' selected' : ''}`} aria-label={`${t.name}${applied ? ' (applied)' : selected ? ' (previewing)' : ''}`}>
      {/* A miniature of the theme in its own colours (independent of the theme currently shown). */}
      <div className="theme-mini" style={{ background: `radial-gradient(120px 80px at 0% 0%, ${k['glow-1']}55, transparent 70%), ${k.bg}` }} aria-hidden="true">
        <span className="theme-mini-side" style={{ background: k.sidebar, borderColor: k.border }} />
        <span className="theme-mini-panel" style={{ background: k.surface, borderColor: k.border }}>
          <span className="theme-mini-line" style={{ background: k.text }} />
          <span className="theme-mini-line short" style={{ background: k.muted }} />
          <span className="theme-mini-button" style={{ background: k.accent }} />
          <span className="theme-mini-dot" style={{ background: k['accent-2'] }} />
        </span>
        {t.art?.preview && <img className="theme-mini-art" src={t.art.preview.src} alt="" draggable={false} />}
      </div>
      <div className="theme-card-body">
        <strong>{t.name}</strong>
        <span className="muted small">{t.description}</span>
        <span className="theme-badges">
          {applied && <span className="pill pill-ok">Applied</span>}
          {selected && !applied && <span className="pill pill-warn">Previewing</span>}
          {t.placeholder && <span className="pill pill-muted">Starter palette</span>}
        </span>
      </div>
      <div className="button-row">
        <Button variant="secondary" className="btn btn-secondary btn-small" disabled={selected} onClick={onPreview}>
          Preview
        </Button>
        <Button className="btn btn-primary btn-small" disabled={busy || applied} onClick={onApply}>
          Apply
        </Button>
      </div>
    </li>
  );
}
