// The Kick Bot Account card in Bot Accounts, rendered from Kick setup state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import type { KickAccountState, KickSetupState } from '@conduit/shared/kick/kick-setup';

const never = () => new Promise<never>(() => {});
const stubBridge: ConduitBridge = {
  getAppInfo: never,
  getBackendStatus: never,
  onBackendStatus: () => () => {},
  api: { request: never },
  connections: { connect: never },
  kick: { openDeveloperSettings: () => new Promise(() => {}) },
  discord: { installBot: never, openPortal: never },
};
const g = globalThis as { window?: unknown };
beforeEach(() => {
  vi.resetModules();
  g.window = { conduit: stubBridge };
});
afterEach(() => {
  delete g.window;
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('Kick Bot Account card', () => {
  const account = (over: Partial<KickAccountState>): KickAccountState => ({
    status: 'not_connected',
    userId: null,
    name: null,
    handle: null,
    avatarDataUrl: null,
    scopes: [],
    pending: false,
    problem: null,
    lastVerifiedAt: null,
    ...over,
  });
  const kick = (over: { mode?: 'primary' | 'separate'; bot?: Partial<KickAccountState>; ready?: boolean } = {}): KickSetupState =>
    ({
      application: { configured: true, clientId: 'x', clientSecretStored: true },
      redirectUri: 'http://localhost:47821/oauth/kick/callback',
      primary: account({ status: 'connected', userId: '1', name: 'Retronix', handle: 'retronix', scopes: ['user:read', 'channel:read', 'moderation:ban'] }),
      bot: account(over.bot ?? {}),
      chatbot: { mode: over.mode ?? 'separate', account: over.mode === 'primary' ? 'primary' : 'bot', ready: over.ready ?? true, note: '' },
      scopes: { primary: [], bot: [] },
      chat: {} as KickSetupState['chat'],
    }) as unknown as KickSetupState;

  async function card(s: KickSetupState) {
    const { KickBotAccountCard } = await import('../components/kick/KickBotAccountCard');
    const html = renderToStaticMarkup(<KickBotAccountCard s={s} onManage={() => {}} />);
    return { html, t: text(html) };
  }

  it('shows the verified bot account separately from the main account, without secrets', async () => {
    const { html, t } = await card(
      kick({ bot: { status: 'connected', userId: '77', name: 'MyChatBot', handle: 'mychatbot', scopes: ['user:read', 'chat:write'], lastVerifiedAt: '2026-10-13T18:00:00.000Z' } }),
    );
    expect(t).toMatch(/Kick Bot Account Connected Platform Kick Bot account (?:M )?MyChatBot Kick user ID 77 Chatbot Posts as this account Kick permissions user:read, chat:write/);
    expect(t).toMatch(/Moderation Not done by this account — it runs as the main account Main account Retronix \(channel, rewards, moderation; separate\)/);
    expect(t).toContain('Manage');
    expect(html).not.toMatch(/token|secret|refresh/i);
  });

  it('is honest when no separate bot account is configured or connected', async () => {
    let { t } = await card(kick({ mode: 'primary' }));
    expect(t).toMatch(/Kick Bot Account Not configured/);
    expect(t).toContain('The chatbot posts as Retronix. To use a separate bot account, select Manage → Chatbot.');
    expect(t).not.toContain('MyChatBot');
    ({ t } = await card(kick({ ready: false })));
    expect(t).toMatch(/Not connected .* Selected, not ready to post/);
    ({ t } = await card(kick({ bot: { status: 'needs_reauth', name: 'MyChatBot', scopes: ['user:read'] } })));
    expect(t).toMatch(/Needs Reconnect/);
    expect(t).toContain('can’t send chat');
  });
});
