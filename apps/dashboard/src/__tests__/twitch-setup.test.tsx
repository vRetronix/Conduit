// Twitch card and setup dialog, rendered from backend Twitch state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwitchAccountState, TwitchSetupState } from '@conduit/shared/twitch/twitch-setup';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const never = () => new Promise<never>(() => {});
const stubBridge: ConduitBridge = {
  getAppInfo: never,
  getBackendStatus: never,
  onBackendStatus: () => () => {},
  api: { request: never },
  connections: { connect: never },
  kick: { openDeveloperSettings: never },
  twitch: { openDeveloperConsole: never },
  discord: { installBot: never, openPortal: never },
};

const none: TwitchAccountState = { status: 'not_connected', userId: null, name: null, handle: null, avatarDataUrl: null, scopes: [], pending: false, problem: null, lastVerifiedAt: null };
const streamer: TwitchAccountState = { ...none, status: 'connected', userId: '9990001', name: 'RetroLive', handle: 'retrolive' };
const state = (over: Partial<TwitchSetupState> = {}): TwitchSetupState => ({
  application: { configured: false, clientId: null, clientSecretStored: false },
  primary: none,
  bot: none,
  chatbot: { mode: 'primary', account: null, ready: false, note: 'Connect your Twitch account first.' },
  redirectUri: 'http://localhost:47821/oauth/twitch/callback',
  scopes: { primary: ['user:read:chat', 'user:write:chat'], bot: ['user:write:chat'] },
  chat: {
    receive: { status: 'disconnected', problem: null, lastEventAt: null, messagesReceived: 0, nextRetryAt: null },
    send: { account: null, accountName: null, channel: null, ready: false, missingScope: null, problem: null },
    recent: [],
  },
  ...over,
});
const configured = { configured: true, clientId: 'twitchclientid0000000000000001', clientSecretStored: true };

const g = globalThis as { window?: unknown };
beforeEach(() => {
  vi.resetModules();
  g.window = { conduit: stubBridge };
});
afterEach(() => {
  delete g.window;
});
const text = (html: string) =>
  html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('Twitch card', () => {
  it('not set up: Not Connected, with Connect Twitch', async () => {
    const { TwitchCard } = await import('../components/twitch/TwitchSetup');
    const t = text(renderToStaticMarkup(<TwitchCard state={state()} />));
    expect(t).toMatch(/Twitch Not Connected Account Not Connected Chatbot Main account App Not set up/);
    expect(t).toContain('Connect Twitch');
  });

  it('connected: the account, Manage and Disconnect; an expired one asks to reconnect', async () => {
    const { TwitchCard, twitchConnectionTag } = await import('../components/twitch/TwitchSetup');
    const t = text(renderToStaticMarkup(<TwitchCard state={state({ application: configured, primary: streamer })} />));
    expect(t).toMatch(/Twitch Connected Account RetroLive Chatbot RetroLive App Set up/);
    expect(t).toContain('Manage');
    expect(t).toContain('Disconnect');
    expect(twitchConnectionTag(state({ primary: { ...streamer, status: 'needs_reauth' } }))).toEqual({ label: 'Needs Reconnect', pill: 'pill-bad' });
    expect(twitchConnectionTag(state({ primary: { ...none, pending: true } })).label).toBe('Connecting');
  });
});

describe('Twitch setup dialog', () => {
  it('opens at the Twitch App step with the exact redirect URL to register', async () => {
    const { TwitchSetupDialog, firstOpenTwitchStep } = await import('../components/twitch/TwitchSetup');
    expect(firstOpenTwitchStep(state())).toBe('app');
    const t = text(renderToStaticMarkup(<TwitchSetupDialog state={state()} onChanged={() => {}} onClose={() => {}} />));
    expect(t).toContain('http://localhost:47821/oauth/twitch/callback');
    expect(t).toContain('Open Twitch Developer Console');
    expect(t).toContain('Confidential');
  });

  it('once the app is saved, it opens at Your Account, then Chatbot, then Live Chat; the summary shows what Twitch confirmed', async () => {
    const { TwitchSetupDialog, firstOpenTwitchStep } = await import('../components/twitch/TwitchSetup');
    expect(firstOpenTwitchStep(state({ application: configured }))).toBe('account');
    expect(firstOpenTwitchStep(state({ application: configured, primary: streamer }))).toBe('chatbot');
    const account = text(renderToStaticMarkup(<TwitchSetupDialog state={state({ application: configured, primary: streamer })} initialStep="account" onChanged={() => {}} onClose={() => {}} />));
    expect(account).toContain('Disconnect main account');
    const done = state({
      application: configured,
      primary: streamer,
      chatbot: { mode: 'primary', account: 'primary', ready: true, note: "Messages are sent as RetroLive to retrolive's chat." },
      chat: {
        receive: { status: 'connected', problem: null, lastEventAt: null, messagesReceived: 2, nextRetryAt: null },
        send: { account: 'primary', accountName: 'RetroLive', channel: 'retrolive', ready: true, missingScope: null, problem: null },
        recent: [{ messageId: 'm1', content: 'hello chat', senderUserId: '5', senderUsername: 'Viewer', senderColor: null, badges: ['subscriber'], receivedAt: '2026-10-29T12:00:00.000Z' }],
      },
    });
    expect(firstOpenTwitchStep(done)).toBe('chat');
    const t = text(renderToStaticMarkup(<TwitchSetupDialog state={done} onChanged={() => {}} onClose={() => {}} />));
    expect(t).toContain('Twitch is set up.');
    expect(t).toContain('2 messages received');
    expect(t).toMatch(/Viewer \[subscriber\] ?: hello chat/);
    expect(t).toMatch(/Send as \w+/);
    expect(t).not.toContain('needs no tunnel');
  });

  it('an account connected before chat existed is asked to allow chat', async () => {
    const { TwitchCard } = await import('../components/twitch/TwitchSetup');
    const old = state({
      application: configured,
      primary: streamer,
      chat: {
        receive: { status: 'permission_required', problem: 'needs user:read:chat', lastEventAt: null, messagesReceived: 0, nextRetryAt: null },
        send: { account: 'primary', accountName: 'RetroLive', channel: 'retrolive', ready: false, missingScope: 'user:write:chat', problem: null },
        recent: [],
      },
    });
    const t = text(renderToStaticMarkup(<TwitchCard state={old} />));
    expect(t).toContain('Connect your Twitch account again to allow chat');
    expect(t).toContain('Allow Chat');
  });

  it('a separate chatbot account: Add Bot Account on the card', async () => {
    const { TwitchCard } = await import('../components/twitch/TwitchSetup');
    const t = text(renderToStaticMarkup(<TwitchCard state={state({ application: configured, primary: streamer, chatbot: { mode: 'separate', account: null, ready: false, note: '' } })} />));
    expect(t).toMatch(/Chatbot No bot account/);
    expect(t).toContain('Add Bot Account');
  });

  it('checks the app form before sending', async () => {
    const { checkTwitchAppForm } = await import('../components/twitch/TwitchSetup');
    expect(checkTwitchAppForm({ clientId: '', clientSecret: '' }, false)).toEqual({ clientId: expect.any(String), clientSecret: expect.any(String) });
    expect(checkTwitchAppForm({ clientId: 'short', clientSecret: 'has spaces in it 000000' }, false)).toEqual({ clientId: expect.stringMatching(/Twitch Client ID/), clientSecret: expect.stringMatching(/Twitch Client Secret/) });
    expect(checkTwitchAppForm({ clientId: 'twitchclientid0000000000000001', clientSecret: '' }, true)).toEqual({});
  });
});
