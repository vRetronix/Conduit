import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import logoUrl from './assets/logo.png';
import { bridge } from './bridge';
import { NavIcon } from './components/NavIcon';
import { StatusPill } from './components/StatusPill';
import { Toasts } from './components/Toasts';
import { Loading } from './components/forms';
import { useAppInfo, useBackendStatus } from './hooks';
import { DashboardPage } from './pages/app/DashboardPage';
import { PlannedPage } from './pages/app/PlannedPage';
import { SECTION_GROUPS, SECTIONS, type Section, type SectionGroup } from './sections';
import { loadAppearance } from './theme/appearance';

const NAV_COLLAPSED_KEY = 'conduit.navCollapsed';

/**
 * Which sidebar groups are folded. Remembered in this window (a per-viewer convenience); by default the groups that
 * only hold planned ("Soon") sections are folded, so the sidebar shows what can be used.
 */
function initialCollapsed(): Set<SectionGroup> {
  try {
    const saved = localStorage.getItem(NAV_COLLAPSED_KEY);
    if (saved) return new Set(JSON.parse(saved) as SectionGroup[]);
  } catch {
    // Storage unavailable: use the default.
  }
  return new Set(SECTION_GROUPS.filter((g) => SECTIONS.some((s) => s.group === g.id) && SECTIONS.filter((s) => s.group === g.id).every((s) => s.phase !== null)).map((g) => g.id));
}

/** A page loaded when it is first opened (its own chunk), from a module's named export. */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): LazyExoticComponent<ComponentType> {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

/**
 * Every page except the Dashboard (the first screen) is loaded when it is first opened, so starting CONDUIT only loads
 * what the Dashboard needs. A section with no entry here is shown as planned.
 */
const PAGES: Partial<Record<string, LazyExoticComponent<ComponentType>>> = {
  commands: page(() => import('./pages/community/CommandsPage'), 'CommandsPage'),
  giveaways: page(() => import('./pages/community/GiveawaysPage'), 'GiveawaysPage'),
  'timed-messages': page(() => import('./pages/community/TimedMessagesPage'), 'TimedMessagesPage'),
  'discord-moderation': page(() => import('./pages/community/ModerationPage'), 'DiscordModerationPage'),
  'sticky-messages': page(() => import('./pages/discord/StickyMessagesPage'), 'StickyMessagesPage'),
  'embed-creator': page(() => import('./pages/discord/EmbedCreatorPage'), 'EmbedCreatorPage'),
  loyalty: page(() => import('./pages/discord/LoyaltyPage'), 'LoyaltyPage'),
  'kick-moderation': page(() => import('./pages/community/ModerationPage'), 'KickModerationPage'),
  'kick-notifications': page(() => import('./pages/kick/KickNotificationsPage'), 'KickNotificationsPage'),
  'kick-clips': page(() => import('./pages/kick/KickClipsPage'), 'KickClipsPage'),
  settings: lazy(() => import('./pages/app/SettingsPage')),
};

/**
 * Opens straight into the dashboard: there is no CONDUIT sign-in on the desktop.
 * Access to the local backend is controlled by the main process, which holds the per-launch local access key.
 */
export function App() {
  const [activeId, setActiveId] = useState('dashboard');
  const [collapsed, setCollapsed] = useState<Set<SectionGroup>>(initialCollapsed);
  const toggleGroup = (id: SectionGroup) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered; it still works for this session.
      }
      return next;
    });
  const appInfo = useAppInfo();
  const backendStatus = useBackendStatus();
  const running = backendStatus?.state === 'running';
  // The saved appearance, once the backend is up (the cached copy was applied before the first frame).
  useEffect(() => {
    if (running) loadAppearance().catch(() => undefined);
  }, [running]);

  if (!bridge) {
    return <div className="card error-card standalone-error">CONDUIT must be opened from the desktop app.</div>;
  }

  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0]!;

  const navItem = (section: Section) =>
    section.phase !== null ? (
      // Not built yet: shown (muted, with a gray "Soon"), but not a link to anything.
      <span key={section.id} className="nav-item nav-soon" aria-disabled="true" title="Coming soon">
        <NavIcon id={section.id} />
        <span className="nav-label">{section.label}</span>
        <span className="nav-phase">Soon</span>
      </span>
    ) : (
      <button
        key={section.id}
        type="button"
        className={`nav-item${section.id === active.id ? ' active' : ''}`}
        aria-current={section.id === active.id ? 'page' : undefined}
        onClick={() => setActiveId(section.id)}
      >
        <NavIcon id={section.id} />
        <span className="nav-label">{section.label}</span>
      </button>
    );

  return (
    <div className="shell">
      {/* The installed app has no Windows title bar: this strip along the top drags the window. */}
      <div className="titlebar-drag" aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={logoUrl} alt="" aria-hidden="true" />
          <span className="brand-text">
            <span className="brand-name">CONDUIT</span>
            <span className="brand-tagline">The Link Between Everything.</span>
          </span>
        </div>
        <nav aria-label="Sections">
          {SECTION_GROUPS.map((group) => {
            const items = SECTIONS.filter((s) => s.group === group.id);
            if (items.length === 0) return null;
            // The group of the page being shown never folds away.
            const folded = collapsed.has(group.id) && !items.some((s) => s.id === active.id);
            const allSoon = items.every((s) => s.phase !== null);
            return (
              <div key={group.id} className={`nav-group nav-group-${group.id}${folded ? ' folded' : ''}`}>
                <button
                  type="button"
                  className={`nav-group-label${group.platform ? ` nav-platform nav-platform-${group.platform}` : ''}`}
                  aria-expanded={!folded}
                  aria-controls={`nav-group-${group.id}`}
                  onClick={() => toggleGroup(group.id)}
                >
                  <span className="nav-group-name">{group.label}</span>
                  {folded && allSoon && <span className="nav-phase">Soon</span>}
                  <svg className="nav-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                    <path d="M2.5 3.75L5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div id={`nav-group-${group.id}`} className="nav-group-items" hidden={folded}>
                  {items.map((section) => navItem(section))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {SECTIONS.filter((s) => s.group === 'footer').map((section) => navItem(section))}
          <span className="sidebar-version">
            {appInfo && <span>v{appInfo.version}</span>}
            <span className="sidebar-credit">built by Retronix</span>
          </span>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{active.label}</h1>
            <p className="topbar-summary">{active.summary}</p>
          </div>
          <StatusPill status={backendStatus} />
        </header>
        {active.id === 'dashboard' ? <DashboardPage /> : <PageContent section={active} />}
      </main>
      <Toasts />
    </div>
  );
}

function PageContent({ section }: { section: Section }) {
  const Page = PAGES[section.id];
  if (!Page) return <PlannedPage section={section} />;
  return (
    <Suspense fallback={<Loading label={`Loading ${section.label}…`} />}>
      <Page />
    </Suspense>
  );
}
