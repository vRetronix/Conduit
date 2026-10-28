import type { ReactNode } from 'react';

/**
 * Browser-style tabs on one card: the active tab is raised and joined to the card, the others sit flat beside it.
 * Every panel stays rendered (the inactive ones hidden), so switching keeps what's being edited in them.
 */
export function BrowserTabs<T extends string>({
  idPrefix,
  scope,
  label,
  tabs,
  active,
  onChange,
  panels,
}: {
  /** Element ids: \`<idPrefix>-tab-<scope>-<id>\` and \`<idPrefix>-panel-<scope>-<id>\`. */
  idPrefix: string;
  scope?: string;
  /** What the tabs are for (read by screen readers). */
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
  panels: Record<T, ReactNode>;
}) {
  const key = (kind: 'tab' | 'panel', id: T) => `${idPrefix}-${kind}-${scope ? `${scope}-` : ''}${id}`;
  return (
    <div className="chrome-tabs-wrap">
      <div className="chrome-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={key('tab', t.id)}
            aria-selected={active === t.id}
            aria-controls={key('panel', t.id)}
            className={`chrome-tab${active === t.id ? ' active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined && <span className="chrome-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="card chrome-tab-panel">
        {tabs.map((t) => (
          <div key={t.id} role="tabpanel" id={key('panel', t.id)} aria-labelledby={key('tab', t.id)} hidden={active !== t.id}>
            {panels[t.id]}
          </div>
        ))}
      </div>
    </div>
  );
}
