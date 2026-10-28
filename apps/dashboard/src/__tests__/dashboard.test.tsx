// Renders the real dashboard components to HTML (react-dom/server), without a browser.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConnectionSummary } from '@conduit/shared/app/connections';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const summary = (overrides: Partial<PlatformConnectionSummary> = {}): PlatformConnectionSummary => ({
  platform: 'kick',
  name: 'Kick',
  status: 'not_connected',
  account: null,
  additionalAccounts: 0,
  authorizationAvailable: false,
  unavailableReason: 'Connecting Kick is not available yet. Its official authorization flow has not been implemented.',
  pending: false,
  lastAttempt: null,
  problem: null,
  lastVerifiedAt: null,
  ...overrides,
});

const account = (name: string, extra: Partial<NonNullable<PlatformConnectionSummary['account']>> = {}) => ({ id: '1', name, handle: null, avatarDataUrl: null, ...extra });

const stubBridge: ConduitBridge = {
  getAppInfo: () => new Promise(() => {}),
  getBackendStatus: () => new Promise(() => {}),
  onBackendStatus: () => () => {},
  api: { request: () => new Promise(() => {}) },
  connections: { connect: () => new Promise(() => {}) },
  kick: { openDeveloperSettings: () => new Promise(() => {}) },
  discord: { installBot: () => new Promise(() => {}), openPortal: () => new Promise(() => {}) },
};

const g = globalThis as { window?: unknown };
beforeEach(() => vi.resetModules());
afterEach(() => {
  delete g.window;
});

async function renderApp(bridge: ConduitBridge | undefined) {
  g.window = bridge ? { conduit: bridge } : {};
  const { App } = await import('../App');
  return renderToStaticMarkup(<App />);
}

describe('app start', () => {
  it('opens directly to the dashboard with Connect Accounts — no CONDUIT sign-in, setup or password screen', async () => {
    const html = await renderApp(stubBridge);
    expect(html).toContain('aria-label="Connect Accounts"');
    expect(html).toContain('<h1>Dashboard</h1>');
    expect(html).toContain('Connect and manage your platform accounts.');
    // The cards stand on their own: no section heading or intro above them.
    expect(html).not.toContain('<h2 id="connect-accounts-title">');
    expect(html).not.toContain('official authorization page in your browser');
    for (const forbidden of [/sign in/i, /log ?in/i, /type="password"/, /choose a new password/i, /set up CONDUIT/i, /create owner account/i, /session ended/i]) {
      expect(html).not.toMatch(forbidden);
    }
    expect(html).not.toContain('<input');
  });

  it('never shows a platform as connected before the backend has answered', async () => {
    const html = await renderApp(stubBridge);
    expect(html).toContain('Loading connections');
    expect(html).not.toMatch(/>Connected</);
  });

  it('has no separate Connect Accounts page: the dashboard cards are the only place to manage connections', async () => {
    const html = await renderApp(stubBridge);
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    expect(nav).not.toContain('Connect Accounts');
    expect(nav).not.toContain('Platform Connections');
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.map((s) => s.id)).not.toContain('connections');
    // No separate Discord Bot / Kick Accounts pages either: the Dashboard cards (with Manage) are where accounts are managed.
    expect(SECTIONS.map((s) => s.id)).not.toEqual(expect.arrayContaining(['discord-setup']));
    expect(SECTIONS.filter((s) => ['discord-setup', 'kick-setup', 'bot-accounts'].includes(s.id))).toEqual([]);
    expect(SECTIONS.find((s) => s.id === 'commands')?.phase).toBeNull();
    // …while the dashboard itself still shows the section.
    expect(html).toContain('<section class="connect-accounts" aria-label="Connect Accounts">');
  });

  it('refuses to run outside the desktop app', async () => {
    expect(await renderApp(undefined)).toContain('CONDUIT must be opened from the desktop app.');
  });
});

describe('ConnectionCard', () => {
  const render = async (props: Parameters<typeof import('../components/ConnectAccounts').ConnectionCard>[0]) => {
    g.window = { conduit: stubBridge };
    const { ConnectionCard } = await import('../components/ConnectAccounts');
    return renderToStaticMarkup(<ConnectionCard {...props} />);
  };

  it('shows Not Connected, a Connect action and an honest note when authorization is not implemented', async () => {
    const html = await render({ connection: summary() });
    expect(html).toContain('>Not Connected<');
    expect(html).not.toMatch(/>Connected</);
    expect(html).toMatch(/>Connect<\/button>/);
    expect(html).not.toContain('Disconnect');
    expect(html).toContain('Its official authorization flow has not been implemented.');
    expect(html).toContain('<svg');
  });

  it('is laid out like Kick’s card: Account and Chatbot, then the note just above Connect', async () => {
    const html = await render({ connection: summary() });
    expect(html).toMatch(/<dt>Account<\/dt>.*<dt>Chatbot<\/dt>/);
    expect(html).toMatch(/<div class="connection-bottom"><p class="connection-note muted">[^<]*not been implemented\.<\/p><div class="connection-actions"><button/);
  });

  it('shows Connected, the authorized account and a Disconnect action only for a verified connection', async () => {
    const html = await render({
      connection: summary({ platform: 'twitch', name: 'Twitch', status: 'connected', account: account('RetroLive'), additionalAccounts: 1 }),
    });
    expect(html).toContain('>Connected<');
    expect(html).toContain('RetroLive');
    expect(html).toContain('+1 more');
    expect(html).toMatch(/>Disconnect<\/button>/);
    expect(html).not.toMatch(/>Connect<\/button>/);
    expect(html).not.toContain('not been implemented');
  });

  it('shows connection problems and failed attempts without claiming a connection', async () => {
    const html = await render({
      connection: summary({ problem: 'The authorization expired or was revoked. Connect again to restore access.' }),
      actionError: 'Connecting Kick is not available yet. Its official authorization flow has not been implemented.',
    });
    expect(html).toContain('>Not Connected<');
    expect(html).toContain('expired or was revoked');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Connecting Kick is not available yet');
  });

  it('shows the Discord account name, handle and avatar when connected', async () => {
    const html = await render({
      connection: summary({
        platform: 'discord',
        name: 'Discord',
        status: 'connected',
        account: account('Retro Live', { handle: 'retro_live', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
        authorizationAvailable: true,
        unavailableReason: null,
      }),
    });
    expect(html).toContain('Retro Live');
    expect(html).toContain('@retro_live');
    expect(html).toContain('<img class="account-avatar" src="data:image/png;base64,iVBORw0KGgo="');
  });

  it('shows a waiting state with Cancel while authorization is in progress (and no Connected claim)', async () => {
    const html = await render({ connection: summary({ platform: 'discord', name: 'Discord', authorizationAvailable: true, unavailableReason: null, pending: true }) });
    expect(html).toContain('Waiting for you to approve CONDUIT in your browser');
    expect(html).toMatch(/>Cancel<\/button>/);
    expect(html).toContain('aria-busy="true"');
    // Connecting shows as a yellow tag (never a Connected claim).
    expect(html).toContain('<span class="pill pill-warn">Connecting</span>');
    expect(html).not.toContain('>Connected<');
    expect(html).not.toMatch(/>Connect<\/button>/);
  });

  it('shows why the last attempt failed and offers Try again', async () => {
    const html = await render({
      connection: summary({
        platform: 'discord',
        name: 'Discord',
        authorizationAvailable: true,
        unavailableReason: null,
        lastAttempt: { outcome: 'cancelled', message: 'You cancelled the Discord authorization. Select Connect to try again.', at: 'x' },
      }),
    });
    expect(html).toContain('You cancelled the Discord authorization');
    expect(html).toMatch(/>Try again<\/button>/);
  });

  it('explains missing Discord configuration', async () => {
    const html = await render({
      connection: summary({ platform: 'discord', name: 'Discord', unavailableReason: "Discord isn't set up yet. Create an application in the Discord Developer Portal…" }),
    });
    expect(html).toContain('Discord Developer Portal');
  });

  it.each(['discord', 'kick', 'youtube', 'twitch'] as const)('renders an icon and name for %s', async (platform) => {
    const html = await render({ connection: summary({ platform, name: platform }) });
    expect(html).toContain('<svg');
    expect(html).toContain(`<h3>${platform}</h3>`);
  });
});
