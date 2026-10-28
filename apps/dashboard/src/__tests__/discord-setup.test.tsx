// Renders the Discord card and setup wizard to HTML (react-dom/server), without a browser.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordSetupState, DiscordSetupStep } from '@conduit/shared/discord/discord-setup';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const stubBridge: ConduitBridge = {
  getAppInfo: () => new Promise(() => {}),
  getBackendStatus: () => new Promise(() => {}),
  onBackendStatus: () => () => {},
  api: { request: () => new Promise(() => {}) },
  connections: { connect: () => new Promise(() => {}) },
  kick: { openDeveloperSettings: () => new Promise(() => {}) },
  discord: { installBot: () => new Promise(() => {}), openPortal: () => new Promise(() => {}) },
};

const base = (): DiscordSetupState => ({
  nextStep: 'application',
  application: { configured: false, applicationId: null, applicationName: null, clientSecretStored: false, botTokenStored: false, validatedAt: null, botUserId: null, botUsername: null },
  account: { connected: false, name: null, handle: null, avatarDataUrl: null, pending: false, problem: null },
  bot: { status: 'not_configured', username: null, userId: null, problem: null, retryable: false, since: null },
  installation: { status: 'unknown', guilds: [], checkedAt: null, source: null, pending: false, problem: null },
  commands: {
    status: 'not_registered',
    scope: 'guild',
    names: ['ping'],
    definitions: [{ name: 'ping', description: 'Check that I’m connected', requiresPermissions: false, origin: 'default' }],
    applicationId: null,
    botUsername: null,
    guilds: [],
    lastAttemptAt: null,
    problem: null,
    canRegister: false,
    nextRetryAt: null,
  },
  redirectUri: 'http://127.0.0.1:47821/oauth/discord/callback',
  installPermissions: '0',
  intents: [{ name: 'Guilds', privileged: false }],
});

interface Patch {
  nextStep?: DiscordSetupStep;
  commands?: Partial<DiscordSetupState['commands']>;
  application?: Partial<DiscordSetupState['application']>;
  account?: Partial<DiscordSetupState['account']>;
  bot?: Partial<DiscordSetupState['bot']>;
  installation?: Partial<DiscordSetupState['installation']>;
}

const state = (p: Patch = {}): DiscordSetupState => {
  const s = base();
  return {
    ...s,
    nextStep: p.nextStep ?? s.nextStep,
    application: { ...s.application, ...p.application },
    account: { ...s.account, ...p.account },
    bot: { ...s.bot, ...p.bot },
    installation: { ...s.installation, ...p.installation },
    commands: { ...s.commands, ...p.commands },
  };
};

const configured: Patch['application'] = {
  configured: true,
  applicationId: '123456789012345678',
  applicationName: 'Retro Bot',
  clientSecretStored: true,
  botTokenStored: true,
  validatedAt: '2026-01-01T00:00:00.000Z',
  botUserId: '1',
  botUsername: 'RetroBot',
};

const ready = (): DiscordSetupState =>
  state({
    nextStep: 'done',
    application: configured,
    account: { connected: true, name: 'Retro Live', handle: 'retro_live' },
    bot: { status: 'connected', username: 'RetroBot', userId: '1' },
    installation: { status: 'installed', guilds: [{ id: '42', name: 'Retro Server' }], source: 'gateway', checkedAt: '2026-01-01T00:00:00.000Z' },
  });

const g = globalThis as { window?: unknown };
beforeEach(() => {
  vi.resetModules();
  g.window = { conduit: stubBridge };
});
afterEach(() => {
  delete g.window;
});

async function card(s: DiscordSetupState) {
  const { DiscordCard } = await import('../components/discord/DiscordSetup');
  return renderToStaticMarkup(<DiscordCard state={s} />);
}

/** Renders the wizard at the screen that shows a backend step (install, bot and done share "Add & Start the Bot"). */
async function wizard(s: DiscordSetupState, step: DiscordSetupStep) {
  const { DiscordSetupWizard, wizardStepFor } = await import('../components/discord/DiscordSetup');
  return renderToStaticMarkup(<DiscordSetupWizard state={s} step={wizardStepFor(step)} onStep={() => {}} onChanged={() => {}} onClose={() => {}} />);
}

// Text as a screen reader gets it: decorative (aria-hidden) content such as fallback initials is skipped.
const text = (html: string) =>
  html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('Discord card', () => {
  const AVATAR = 'data:image/png;base64,QUFBQQ==';
  const BOT_AVATAR = 'data:image/png;base64,QkJCQg==';
  const SERVER_ICON = 'data:image/png;base64,U1NTUw==';
  const rowsOf = (html: string) => [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);

  it('shows only Account, Bot and Server', async () => {
    for (const s of [state(), ready()]) {
      const html = await card(s);
      expect(rowsOf(html)).toEqual(['Account', 'Bot', 'Server']);
      expect(text(html)).not.toMatch(/Application|Commands|Ready|Setup incomplete/);
    }
  });

  it('before setup: honest empty states and Connect', async () => {
    const t = text(await card(state()));
    expect(t).toMatch(/Account Not Connected/);
    expect(t).toMatch(/Bot Disconnected/);
    expect(t).toMatch(/Server Not Installed/);
    expect(t).toMatch(/ Connect /);
    expect(t).not.toMatch(/Reconfigure|Disconnect /);
  });

  it('shows the real pictures and names of the account, bot and server', async () => {
    const s = ready();
    s.account.avatarDataUrl = AVATAR;
    s.bot.avatarDataUrl = BOT_AVATAR;
    s.installation.guilds = [{ id: '42', name: 'Retro Server', iconDataUrl: SERVER_ICON }];
    const html = await card(s);
    expect(html).toContain(`src="${AVATAR}"`);
    expect(html).toContain(`src="${BOT_AVATAR}"`);
    expect(html).toContain(`src="${SERVER_ICON}"`);
    const t = text(html);
    expect(t).toMatch(/Account Retro Live/);
    expect(t).toMatch(/Bot RetroBot/);
    expect(t).toMatch(/Server Retro Server/);
  });

  it('falls back to initials (not a stand-in image) when there is no picture', async () => {
    const s = ready();
    s.installation.guilds = [{ id: '42', name: 'Retro Server', iconDataUrl: null }];
    const html = await card(s);
    expect(html).not.toContain('<img');
    expect(html).toMatch(/account-avatar-initial[^>]*>R</); // account and bot
    expect(html).toMatch(/entity-icon-rounded account-avatar-initial[^>]*>RS</); // server
  });

  it('offers Continue Setup and Manage (formerly Reconfigure) while setup is incomplete', async () => {
    const t = text(await card(state({ nextStep: 'account', application: configured, bot: { status: 'connected', username: 'RetroBot' } })));
    expect(t).toContain('Continue Setup');
    expect(t).toContain('Manage');
    expect(t).not.toContain('Reconfigure');
    expect(t).toMatch(/Bot RetroBot/);
  });

  it('keeps the bot status visible next to its name, and the account independent of it', async () => {
    const t = text(
      await card(
        state({
          nextStep: 'install',
          application: configured,
          account: { connected: true, name: 'Retro Live' },
          bot: { status: 'error', problem: 'Discord rejected the bot token.', retryable: false },
        }),
      ),
    );
    expect(t).toMatch(/Account Retro Live/);
    expect(t).toMatch(/Bot RetroBot · Disconnected/); // verified name, real status
    expect(t).toMatch(/Server Not Installed/);
    expect(t).not.toMatch(/ Reconnect /); // not retryable: it needs a new token
    expect(t).toContain('Disconnect');
  });

  it('shows Unable to Verify and Reconnect for a recoverable bot problem', async () => {
    const t = text(
      await card(
        state({
          nextStep: 'install',
          application: configured,
          account: { connected: true, name: 'Retro Live' },
          bot: { status: 'disconnected', retryable: true },
          installation: { status: 'unable_to_verify' },
        }),
      ),
    );
    expect(t).toMatch(/Server Unable to Verify/);
    expect(t).toContain('Reconnect');
  });

  it('summarises several servers', async () => {
    const s = ready();
    s.installation.guilds = [
      { id: '42', name: 'Retro Server' },
      { id: '43', name: 'Second' },
    ];
    expect(text(await card(s))).toMatch(/Server Retro Server \+1 more/);
  });
});

describe('Discord setup wizard', () => {
  it('application step: labelled fields, hidden secrets, redirect URI, portal button, no .env instructions', async () => {
    const html = await wizard(state(), 'application');
    expect(html).toContain('role="dialog"');
    // Each value is labelled with where it comes from in the Developer Portal.
    expect(html).toMatch(/Application ID <span class="portal-tag">Developer Portal · General Information<\/span><\/label>/);
    expect(html).toMatch(/Client Secret <span class="portal-tag">Developer Portal · OAuth2<\/span><\/label>/);
    expect(html).toMatch(/Bot Token <span class="portal-tag">Developer Portal · Bot<\/span><\/label>/);
    expect((html.match(/type="password"/g) ?? []).length).toBe(2);
    expect(html).toContain('Show Client Secret');
    expect(html).toContain('http://127.0.0.1:47821/oauth/discord/callback');
    expect(html).toContain('Open Developer Portal');
    expect(html).not.toMatch(/\.env|CONDUIT_DISCORD/);
  });

  it('never puts stored secrets in the page: saved values show only as a placeholder', async () => {
    const html = await wizard(state({ application: configured, nextStep: 'account' }), 'application');
    expect(html).toContain('Saved securely — leave blank to keep it');
    expect(html).toContain('value="123456789012345678"');
    expect((html.match(/type="password"[^>]*value=""/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
    expect(html).toContain('Remove Discord setup');
  });

  it('install step: only the permissions CONDUIT uses, no privileged intents, never claims an unverified install', async () => {
    const t = text(
      await wizard(
        state({ nextStep: 'install', application: configured, account: { connected: true, name: 'R' }, installation: { status: 'not_installed' } }),
        'install',
      ),
    );
    expect(t).toContain('Permissions requested (0): View Channels, Send Messages, Embed Links, Attach Files, Add Reactions, Read Message History, Mention Everyone, Manage Messages, View Audit Log, Timeout Members, Ban Members, Kick Members, Manage Roles, Manage Server');
    expect(t).not.toMatch(/Administrator,/);
    expect(t).toContain('never asks for Administrator');
    expect(t).toContain('None are privileged');
    expect(t).toMatch(/Server: Not Installed/);
    expect(t).toContain('Add bot to server');
    expect(t).toContain('Check again');
  });

  it('install step shows Cancel while waiting for the browser', async () => {
    const t = text(await wizard(state({ nextStep: 'install', application: configured, installation: { status: 'not_installed', pending: true } }), 'install'));
    expect(t).toContain('Waiting for you to pick a server');
    expect(t).toContain('Cancel');
  });

  it('account step explains the minimal scope and that sign-in does not prove the bot works', async () => {
    const t = text(await wizard(state({ nextStep: 'account', application: configured }), 'account'));
    expect(t).toContain('identify');
    expect(t).toContain('never sees your Discord password');
    expect(t).toContain('does not check or start the bot');
    expect(t).toContain('Connect Discord account');
  });

  it('bot step offers Reconnect when the bot is down', async () => {
    const t = text(
      await wizard(state({ nextStep: 'bot', application: configured, bot: { status: 'disconnected', problem: 'The bot is disconnected', retryable: true } }), 'bot'),
    );
    expect(t).toMatch(/Bot: Disconnected/);
    expect(t).toContain('Reconnect');
  });

  it('completion screen summarises the verified setup', async () => {
    const t = text(await wizard(ready(), 'done'));
    expect(t).toContain('Discord is set up.');
    expect(t).toContain('Retro Server');
    expect(t).toContain('RetroBot');
    expect(t).toContain('Finish');
  });
});

describe('three-step wizard', () => {
  const decoded = (s: string) => s.replace(/&amp;/g, '&');
  it('has exactly three steps, in order: Developer Portal, Your Account, Add & Start the Bot', async () => {
    const html = await wizard(state(), 'application');
    const steps = [...html.matchAll(/<span class="step-number">[^<]*<\/span> ([^<]+)<\/button>/g)].map((m) => decoded(m[1]!));
    expect(steps).toEqual(['Developer Portal', 'Your Account', 'Add & Start the Bot']);
    expect(decoded(text(html))).toContain('Step 1 of 3 · Developer Portal');
    // A fresh setup can only open the first step.
    expect(html.match(/<button type="button" disabled=""/g)?.length).toBe(2);
  });

  it('install, start and done are one step', async () => {
    const { wizardStepFor } = await import('../components/discord/DiscordSetup');
    expect((['application', 'account', 'install', 'bot', 'done'] as const).map(wizardStepFor)).toEqual(['application', 'account', 'bot', 'bot', 'bot']);
    const t = decoded(text(await wizard(state({ nextStep: 'install', application: configured, account: { connected: true, name: 'R' } }), 'install')));
    expect(t).toContain('Step 3 of 3 · Add & Start the Bot');
    expect(t).toContain('Add the bot to your server');
    expect(t).toContain('Start the bot');
  });

  it('the last step shows User Account, Bot (Application) and Server from verified data', async () => {
    const t = text(await wizard(ready(), 'done'));
    expect(t).toMatch(/User Account .*Retro Live/);
    expect(t).toMatch(/Bot \(Application\) .*RetroBot/);
    expect(t).toMatch(/Server .*Retro Server/);
    expect(t).toContain('Discord is set up.');
  });

  it('before the bot is added and started, the summary says so instead of claiming success', async () => {
    const t = text(await wizard(state({ nextStep: 'install', application: configured, account: { connected: true, name: 'RetroLive' }, installation: { status: 'not_installed' } }), 'install'));
    expect(t).toContain('Not finished yet');
    expect(t).not.toContain('Discord is set up.');
    expect(t).toMatch(/Server Not Installed/);
    expect(t).toMatch(/Bot \(Application\) .*Disconnected/);
  });
});

describe('dashboard connection tag', () => {
  it('Connected only while the bot is actually connected to Discord; saved credentials alone are not enough', async () => {
    const tag = async (s: DiscordSetupState) => /<span class="pill ([a-z-]+)">([^<]+)<\/span>/.exec(await card(s))!.slice(1);
    expect(await tag(state())).toEqual(['pill-muted', 'Not Connected']);
    expect(await tag(state({ application: configured, nextStep: 'bot', bot: { status: 'disconnected' } }))).toEqual(['pill-muted', 'Not Connected']);
    expect(await tag(state({ application: configured, nextStep: 'bot', bot: { status: 'connecting' } }))).toEqual(['pill-warn', 'Connecting']);
    expect(await tag(ready())).toEqual(['pill-ok', 'Connected']);
  });
});

describe('application form checks', () => {
  const none = { secret: false, token: false };
  const token = `${'A'.repeat(26)}.${'B'.repeat(6)}.${'C'.repeat(38)}`;

  it('accepts well-formed values', async () => {
    const { checkApplicationForm } = await import('../components/discord/DiscordSetup');
    expect(checkApplicationForm({ applicationId: '123456789012345678', clientSecret: 'x'.repeat(32), botToken: token }, none)).toEqual({});
  });

  it('explains what is wrong with each field', async () => {
    const { checkApplicationForm } = await import('../components/discord/DiscordSetup');
    const errors = checkApplicationForm({ applicationId: 'my bot', clientSecret: 'short', botToken: 'not a token' }, none);
    expect(errors.applicationId).toMatch(/15–25 digits/);
    expect(errors.clientSecret).toMatch(/OAuth2 page/);
    expect(errors.botToken).toMatch(/Bot page/);
  });

  it('lets stored secrets be kept by leaving them blank', async () => {
    const { checkApplicationForm } = await import('../components/discord/DiscordSetup');
    expect(checkApplicationForm({ applicationId: '123456789012345678', clientSecret: '', botToken: '' }, { secret: true, token: true })).toEqual({});
    expect(Object.keys(checkApplicationForm({ applicationId: '123456789012345678', clientSecret: '', botToken: '' }, none))).toEqual(['clientSecret', 'botToken']);
  });
});

describe('slash command status', () => {
  const online = (commands: Patch['commands']) =>
    state({
      nextStep: 'done',
      application: configured,
      account: { connected: true, name: 'Retro Live' },
      bot: { status: 'connected', username: 'RetroBot', userId: '1' },
      installation: { status: 'installed', guilds: [{ id: '42', name: 'Retro Server' }], source: 'gateway' },
      commands: { applicationId: '123456789012345678', botUsername: 'RetroBot', ...commands },
    });

  it('the wizard panel names the application, bot, servers and last attempt', async () => {
    const t = text(
      await wizard(
        online({
          status: 'partial',
          canRegister: true,
          lastAttemptAt: '2026-01-01T00:00:00.000Z',
          problem: 'Discord is rate limiting command registration. CONDUIT will retry in 30 seconds.',
          guilds: [
            { id: '42', name: 'Retro Server', status: 'registered', registeredAt: '2026-01-01T00:00:00.000Z', lastAttemptAt: '2026-01-01T00:00:00.000Z', error: null },
            { id: '43', name: 'Second Server', status: 'failed', registeredAt: null, lastAttemptAt: '2026-01-01T00:00:00.000Z', error: 'rate limited' },
          ],
        }),
        'done',
      ),
    );
    expect(t).toContain('Slash commands');
    expect(t).toMatch(/Commands: Partly Registered/);
    expect(t).toContain('/ping');
    expect(t).toContain('RetroBot');
    expect(t).toContain('123456789012345678');
    expect(t).toMatch(/Retro Server: Registered/);
    expect(t).toMatch(/Second Server: Failed/);
    expect(t).toContain('Last attempt');
    expect(t).toContain('retry in 30 seconds');
    expect(t).toContain('Retry');
  });
});

describe('Discord card while the bot connects', () => {
  it('shows Connecting only as the yellow tag, not as gray text in the Bot row', async () => {
    const html = await card(state({ application: configured, nextStep: 'bot', bot: { status: 'connecting' } }));
    expect(html).toContain('<span class="pill pill-warn">Connecting</span>');
    expect(html).not.toContain('Connecting…');
  });
});
