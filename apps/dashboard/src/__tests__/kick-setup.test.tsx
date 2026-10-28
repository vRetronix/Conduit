// Kick card and setup dialog, rendered from backend Kick state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KickAccountState, KickChatState, KickSetupState } from '@conduit/shared/kick/kick-setup';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const never = () => new Promise<never>(() => {});
const stubBridge: ConduitBridge = {
  getAppInfo: never,
  getBackendStatus: never,
  onBackendStatus: () => () => {},
  api: { request: never },
  connections: { connect: never },
  kick: { openDeveloperSettings: never },
  discord: { installBot: never, openPortal: never },
};

const none: KickAccountState = {
  status: 'not_connected',
  userId: null,
  name: null,
  handle: null,
  avatarDataUrl: null,
  scopes: [],
  pending: false,
  problem: null,
  lastVerifiedAt: null,
};
const streamer: KickAccountState = {
  ...none,
  status: 'connected',
  userId: '1',
  name: 'RetroLive',
  handle: 'retrolive',
  avatarDataUrl: 'data:image/webp;base64,QUFB',
  scopes: ['user:read', 'channel:read'],
};
const botAcct: KickAccountState = { ...none, status: 'connected', userId: '2', name: 'RetroBotKick', handle: null, scopes: ['user:read'] };

function chatState(
  over: {
    receive?: Partial<KickChatState['receive']>;
    send?: Partial<KickChatState['send']>;
    recent?: KickChatState['recent'];
  } = {},
): KickChatState {
  return {
    receive: {
      status: 'disconnected',
      delivery: 'unconfirmed',
      problem: null,
      localTarget: 'http://127.0.0.1:47822',
      webhookPath: '/kick/webhook',
      lastEventAt: null,
      messagesReceived: 0,
      rejected: 0,
      nextRetryAt: null,
      ...over.receive,
    },
    send: { account: null, accountName: null, channel: null, ready: false, missingScope: null, problem: null, ...over.send },
    recent: over.recent ?? [],
  };
}

function state(
  p: { configured?: boolean; primary?: KickAccountState; bot?: KickAccountState; mode?: 'primary' | 'separate'; chat?: KickChatState } = {},
): KickSetupState {
  const primary = p.primary ?? none;
  const bot = p.bot ?? none;
  const mode = p.mode ?? 'primary';
  return {
    application:
      p.configured === false
        ? { configured: false, clientId: null, clientSecretStored: false }
        : { configured: true, clientId: '01JKICK', clientSecretStored: true },
    primary,
    bot,
    chatbot: {
      mode,
      account: mode === 'primary' ? (primary.status === 'connected' ? 'primary' : null) : bot.status === 'connected' ? 'bot' : null,
      ready: false,
      note: 'Kick chat features are not available in CONDUIT yet.',
    },
    redirectUri: 'http://localhost:47821/oauth/kick/callback',
    scopes: { primary: ['user:read', 'channel:read', 'events:subscribe'], bot: ['user:read', 'chat:write'] },
    chat: p.chat ?? chatState(),
  };
}

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
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

async function card(s: KickSetupState) {
  const { KickCard } = await import('../components/kick/KickSetup');
  return renderToStaticMarkup(<KickCard state={s} />);
}

describe('Kick card', () => {
  it('before connecting: Not Connected and Connect Kick, no fake chatbot', async () => {
    const t = text(await card(state({ configured: false })));
    expect(t).toMatch(/Account Not Connected/);
    expect(t).toMatch(/Chatbot Main account/);
    expect(t).toContain('Connect Kick');
    expect(t).not.toMatch(/Disconnect|RetroLive/);
  });

  it('Option A: shows the real account with its avatar, used as the chatbot', async () => {
    const html = await card(state({ primary: streamer }));
    expect(html).toContain('src="data:image/webp;base64,QUFB"');
    const t = text(html);
    // The slug only differs by letter case here, so it isn't repeated.
    expect(t).toMatch(/Account RetroLive Chatbot/);
    expect(t).toMatch(/Chatbot RetroLive/);
    expect(t).not.toMatch(/\((?:main|bot) account\)/); // just the labels, no tags
    expect(t).toContain('Manage');
    expect(t).toContain('Disconnect');
    expect(t).not.toContain('Add Bot Account');
  });

  it('Option B without a bot yet: Add Bot Account, not an error', async () => {
    const t = text(await card(state({ primary: streamer, mode: 'separate' })));
    expect(t).toMatch(/Chatbot No bot account/);
    expect(t).toContain('Add Bot Account');
    expect(t).not.toMatch(/error|failed/i);
  });

  it('Option B with a bot: separate identity, initials fallback without an avatar', async () => {
    const html = await card(state({ primary: streamer, bot: botAcct, mode: 'separate' }));
    expect(html).toMatch(/account-avatar-initial[^>]*>R</);
    expect(text(html)).toMatch(/Chatbot RetroBotKick/);
    expect(text(html)).not.toMatch(/\(bot account\)/); // "Chatbot" already says what it is
  });

  it('shows Reconnect when the main or bot authorization expired, never Connected', async () => {
    const expired: KickAccountState = {
      ...streamer,
      status: 'needs_reauth',
      problem: 'Kick no longer accepts this authorization. Select Reconnect.',
    };
    let t = text(await card(state({ primary: expired })));
    expect(t).toContain('Needs reconnect');
    expect(t).toMatch(/ Reconnect /);
    t = text(await card(state({ primary: streamer, bot: { ...botAcct, status: 'needs_reauth' }, mode: 'separate' })));
    expect(t).toContain('Reconnect Bot Account');
  });

  it('while waiting for the browser: Cancel', async () => {
    const t = text(await card(state({ primary: { ...none, pending: true } })));
    expect(t).toContain('Waiting for you to approve CONDUIT on Kick');
    expect(t).toContain('Cancel');
  });

  it('the panel says nothing about clips (CONDUIT has no !clip of its own)', async () => {
    expect(text(await card(state({ primary: streamer })))).not.toContain('!clip');
  });
});

describe('Kick setup dialog', () => {
  async function dialog(s: KickSetupState, step?: import('../components/kick/KickSetup').KickWizardStep) {
    const { KickSetupDialog } = await import('../components/kick/KickSetup');
    return renderToStaticMarkup(<KickSetupDialog state={s} onChanged={() => {}} onClose={() => {}} initialStep={step} />);
  }

  it('asks for the app details first, with the exact redirect URL and a hidden secret', async () => {
    const html = await dialog(state({ configured: false }));
    expect(html).toContain('http://localhost:47821/oauth/kick/callback');
    expect(html).toMatch(/Client ID <span class="portal-tag">Kick · Developer settings<\/span><\/label>/);
    expect(html).toMatch(/Client Secret <span class="portal-tag">Kick · Developer settings<\/span><\/label>/);
    expect(html).toMatch(/type="password"/);
    expect(html).toContain('Open Kick developer settings');
    expect(text(html)).not.toMatch(/Your Kick account|Chatbot account/);
  });

  it('explains the main account before connecting it', async () => {
    const t = text(await dialog(state()));
    expect(t).toContain('main Kick account');
    expect(t).toContain('user:read, channel:read');
    expect(t).toContain('Connect Kick account');
  });

  it('offers both chatbot options once the main account is connected', async () => {
    const html = await dialog(state({ primary: streamer, mode: 'separate' }));
    const t = text(html);
    expect(t).toContain('Use my main account');
    expect(t).toContain('Use a separate bot account');
    expect(t).toContain('Add Bot Account');
    expect(t).toContain('Log in as the bot account first');
    expect(t).toContain('not available in CONDUIT yet');
  });

  it('manages an existing bot account without touching the main one', async () => {
    const t = text(await dialog(state({ primary: streamer, bot: botAcct, mode: 'separate' }), 'chatbot'));
    expect(t).toContain('Replace bot account');
    expect(t).toContain('Disconnect bot account');
    expect(text(await dialog(state({ primary: streamer, bot: botAcct, mode: 'separate' }), 'account'))).toContain('Disconnect main account');
  });

  it('the Chatbot step (Dashboard → Kick → Manage) shows the Kick Bot Account details, separate from the main account', async () => {
    const t = text(await dialog(state({ primary: streamer, bot: botAcct, mode: 'separate' }), 'chatbot'));
    expect(t).toMatch(/Kick Bot Account Connected Platform Kick Bot account/);
    expect(t).toMatch(/Moderation Not done by this account/);
    expect(t).not.toMatch(/token|secret/i);
  });

  it('uses the same wizard as Discord setup: numbered steps, step header, Back/Continue, and opens at the first unfinished step', async () => {
    const steps = (html: string) => [...html.matchAll(/<span class="step-number">([^<]*)<\/span> ([^<]+)<\/button>/g)].map((m) => `${m[1]} ${m[2]}`);
    const fresh = await dialog(state({ configured: false }));
    expect(steps(fresh)).toEqual(['1 Kick App', '2 Your Account', '3 Chatbot', '4 Live Chat']);
    expect(text(fresh)).toContain('Step 1 of 4 · Kick App');
    expect(fresh.match(/<button type="button" disabled=""/g)?.length).toBe(3); // later steps wait for the app
    const connected = await dialog(state({ primary: streamer }));
    expect(steps(connected)).toEqual(['✓ Kick App', '✓ Your Account', '✓ Chatbot', '4 Live Chat']);
    expect(text(connected)).toContain('Step 4 of 4 · Live Chat');
    expect(text(connected)).toMatch(/Not finished yet Main Account .*RetroLive.* Chatbot .* Live Chat Disconnected/);
    expect(connected).toContain('class="wizard-steps"');
    expect(text(connected)).toContain('Back');
  });
});

describe('checkKickAppForm', () => {
  it('explains what is wrong, and lets a stored secret be kept', async () => {
    const { checkKickAppForm } = await import('../components/kick/KickSetup');
    expect(checkKickAppForm({ clientId: '', clientSecret: '' }, false)).toMatchObject({
      clientId: expect.any(String),
      clientSecret: expect.any(String),
    });
    expect(checkKickAppForm({ clientId: 'bad id!', clientSecret: 'short' }, false)).toMatchObject({
      clientId: expect.stringMatching(/does not look like/),
      clientSecret: expect.stringMatching(/does not look like/),
    });
    expect(checkKickAppForm({ clientId: '01JKICKCLIENTID', clientSecret: '' }, true)).toEqual({});
  });
});

describe('Kick live chat', () => {
  async function dialog(s: KickSetupState) {
    const { KickSetupDialog } = await import('../components/kick/KickSetup');
    return text(renderToStaticMarkup(<KickSetupDialog state={s} onChanged={() => {}} onClose={() => {}} />));
  }
  const bot = { ...botAcct, scopes: ['user:read', 'chat:write'] };

  it('the card has no separate Chat section; chat status lives in setup (Live Chat) and Kick Moderation', async () => {
    const t = text(await card(state({ primary: streamer, chat: chatState({ receive: { status: 'permission_required' } }) })));
    expect(t).not.toMatch(/Chat (Permission required|Connected|Disconnected)/);
    expect(t).toMatch(/Kick Connected Account RetroLive/);
  });

  it('the card tag reflects the main account’s actual authorization', async () => {
    const tag = async (s: KickSetupState) => /<span class="pill ([a-z-]+)">([^<]+)<\/span>/.exec(await card(s))!.slice(1);
    expect(await tag(state())).toEqual(['pill-muted', 'Not Connected']); // app configured, account not connected
    expect(await tag(state({ primary: streamer }))).toEqual(['pill-ok', 'Connected']);
    expect(await tag(state({ primary: { ...streamer, status: 'needs_reauth' } }))).toEqual(['pill-bad', 'Needs Reconnect']);
  });

  it('never claims Connected before the subscription exists; explains an unconfirmed tunnel', async () => {
    let t = await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'connecting' } }) }));
    expect(t).toMatch(/Receiving retrolive's chat: Connecting…/);
    t = await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'connected', delivery: 'unconfirmed' } }) }));
    expect(t).toContain('waiting for the first message to confirm your tunnel');
    expect(t).toContain('cloudflared tunnel --url http://127.0.0.1:47822');
    expect(t).toContain('/kick/webhook');
  });

  it('offers Reauthorize main account when Kick permission is missing, and Retry on errors', async () => {
    let t = await dialog(
      state({ primary: streamer, chat: chatState({ receive: { status: 'permission_required', problem: 'needs events:subscribe' } }) }),
    );
    expect(t).toContain('Reauthorize main account');
    t = await dialog(
      state({
        primary: streamer,
        chat: chatState({ receive: { status: 'error', problem: 'Kick is having problems right now. Select Retry.' } }),
      }),
    );
    expect(t).toContain('Retry');
  });

  it('always offers a way to re-check the subscription once the main account is connected', async () => {
    expect(await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'connected' } }) }))).toContain('Check subscription');
    expect(await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'disconnected' } }) }))).toContain('Check subscription');
    expect(await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'reconnecting' } }) }))).toContain('Retry');
    expect(await dialog(state({ primary: streamer, chat: chatState({ receive: { status: 'connecting' } }) }))).not.toMatch(/Retry|Check subscription/);
  });

  it('lists recent messages as text (no HTML injection)', async () => {
    const { KickSetupDialog } = await import('../components/kick/KickSetup');
    const html = renderToStaticMarkup(
      <KickSetupDialog
        state={state({
          primary: streamer,
          chat: chatState({
            receive: { status: 'connected', delivery: 'confirmed', messagesReceived: 1 },
            recent: [
              {
                messageId: 'm1',
                content: '<img src=x onerror=alert(1)>',
                senderUserId: '9',
                senderUsername: 'viewer',
                senderColor: '#FF5733',
                badges: ['Moderator'],
                createdAt: null,
                receivedAt: '2026-01-01T00:00:00Z',
              },
            ],
          }),
        })}
        onChanged={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(text(html)).toMatch(/viewer\s*\[Moderator\]\s*:/);
    expect(text(html)).toContain('1 message received');
  });

  it('sending: names the account and channel, requires an explicit Send, and asks to reauthorize when chat:write is missing', async () => {
    let t = await dialog(
      state({
        primary: streamer,
        bot,
        mode: 'separate',
        chat: chatState({ send: { account: 'bot', accountName: 'RetroBotKick', channel: 'retrolive', ready: true } }),
      }),
    );
    expect(t).toMatch(/Sends as RetroBotKick \(bot account\) to retrolive\s*'s live chat/);
    expect(t).toContain('Nothing is ever posted automatically');
    expect(t).toContain('Send to live chat');

    t = await dialog(
      state({
        primary: streamer,
        bot: botAcct,
        mode: 'separate',
        chat: chatState({
          send: {
            account: 'bot',
            accountName: 'RetroBotKick',
            channel: 'retrolive',
            ready: false,
            missingScope: 'chat:write',
            problem: 'RetroBotKick needs Kick’s "chat:write" permission.',
          },
        }),
      }),
    );
    expect(t).toContain('Reauthorize bot account');
    expect(t).toContain('log in as RetroBotKick first');
    expect(t).not.toContain('Send to live chat');
  });
});

describe('Kick dashboard tag: Connecting', () => {
  it('is a yellow Connecting tag while an approval is pending or the chat is still connecting', async () => {
    const { kickConnectionTag } = await import('../components/kick/KickSetup');
    const connected: KickAccountState = { ...none, status: 'connected', name: 'Streamer' };
    expect(kickConnectionTag(state({ primary: { ...none, pending: true } }))).toEqual({ label: 'Connecting', pill: 'pill-warn' });
    expect(kickConnectionTag(state({ primary: connected, chat: chatState({ receive: { status: 'connecting' } }) }))).toEqual({ label: 'Connecting', pill: 'pill-warn' });
    expect(kickConnectionTag(state({ primary: connected, chat: chatState({ receive: { status: 'connected' } }) }))).toEqual({ label: 'Connected', pill: 'pill-ok' });
    expect(kickConnectionTag(state())).toEqual({ label: 'Not Connected', pill: 'pill-muted' });
  });
});
