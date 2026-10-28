// Commands → Discord (default commands with Access and Status, presence sections) and the notification character
// (react-dom/server, no browser). The placement rules in styles/ are checked in tests/unit/notification-placement.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertView } from '@conduit/shared/app/alerts';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import type { DiscordCommandView, DiscordCommandsOverview } from '@conduit/shared/discord/discord-commands';
import type { PresenceState } from '@conduit/shared/discord/discord-presence';
import type { CommandsHubState } from '@conduit/shared/community/custom-commands';

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
  g.window = { conduit: stubBridge, addEventListener: () => {}, removeEventListener: () => {} };
});
afterEach(() => {
  delete g.window;
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ── notifications ─────────────────────────────────────────────────────────────

describe('notification character', () => {
  const alert = (id: number, level: AlertView['level'], title: string): AlertView => ({ id, at: '2026-10-17T12:00:00Z', level, title, detail: `${title} detail` });

  it('several notifications: only the newest gets the character; info peeks, errors tumble; text and close stay in each note', async () => {
    const { ToastStack } = await import('../components/Toasts');
    const { THEMES } = await import('../theme/registry');
    const art = THEMES.find((t) => t.id === 'retronix')!.art;
    const html = renderToStaticMarkup(<ToastStack alerts={[alert(1, 'warn', 'Rate limited'), alert(2, 'info', 'Connected')]} art={art} onClose={() => {}} />);
    expect((html.match(/toast-mascot/g) ?? []).length).toBe(1);
    expect((html.match(/class="toast-close"/g) ?? []).length).toBe(2);
    // The character comes before its note in the same wrapper (drawn behind it), next to the newest only.
    const wraps = html.split('class="toast-wrap');
    expect(wraps[1]).not.toContain('toast-mascot');
    expect(wraps[2]).toMatch(/^ hauled"><span class="sprite toast-mascot peek"[^>]*><\/span><div class="toast toast-info"/);
    for (const t of ['Rate limited', 'Connected detail']) expect(text(html)).toContain(t);

    const errors = renderToStaticMarkup(<ToastStack alerts={[alert(3, 'info', 'Old'), alert(4, 'error', 'Bot disconnected')]} art={art} onClose={() => {}} />);
    expect(errors).toContain('class="sprite toast-mascot fall"');
    expect(errors).not.toContain('toast-mascot peek');
  });

  it('themes without a character show plain notifications; nothing is shown with no alerts', async () => {
    const { ToastStack } = await import('../components/Toasts');
    expect(renderToStaticMarkup(<ToastStack alerts={[alert(1, 'error', 'x')]} onClose={() => {}} />)).not.toContain('toast-mascot');
    expect(renderToStaticMarkup(<ToastStack alerts={[]} onClose={() => {}} />)).toBe('');
  });
});

// ── Commands → Discord ────────────────────────────────────────────────────────

const cmd = (over: Partial<DiscordCommandView> & Pick<DiscordCommandView, 'name'>): DiscordCommandView => ({
  description: `${over.name} description`,
  subcommands: [],
  options: [],
  example: null,
  message: null,
  kind: 'builtin',
  group: 'community',
  defaultGroup: 'community',
  minimumGroup: 'community',
  discordPermission: null,
  enabled: true,
  active: true,
  inactiveReason: null,
  ...over,
});
const mod = (name: string, permission: string) => cmd({ name, group: 'moderator', defaultGroup: 'moderator', minimumGroup: 'moderator', discordPermission: permission });
const overview: DiscordCommandsOverview = {
  commands: [
    cmd({ name: 'ping' }),
    mod('timeout', 'Timeout Members'),
    mod('untimeout', 'Timeout Members'),
    { ...mod('ban', 'Ban Members'), group: 'admin' },
    { ...mod('unban', 'Ban Members'), enabled: false, active: false },
    ...['points', 'rewards', 'redeem', 'level', 'leaderboard'].map((name) => cmd({ name, kind: 'loyalty', active: false, inactiveReason: 'Loyalty & Rewards is off' })),
  ],
};
const hub: CommandsHubState = {
  platform: 'discord',
  defaults: ['ping', 'timeout', 'untimeout', 'ban', 'unban'].map((n) => ({ trigger: `/${n}`, description: `${n} description`, permission: 'everyone' as const, enabled: true, canDisable: false, inactiveReason: null, args: [], example: null, message: null })),
  custom: [],
  ready: { ok: true, note: null, sendAs: 'RetroBot', channel: null },
  registration: { status: 'registered', problem: null },
  recent: [],
};
const presence: PresenceState = { saved: null, applied: { state: 'not_sent', at: null, presence: null, problem: null }, botConnected: true, history: [] };

describe('Commands → Discord', () => {
  const render = async () => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    return renderToStaticMarkup(<CommandsView s={hub} discordDefaults={overview} />);
  };
  const renderPresence = async (p: PresenceState = presence) => {
    const { BotPresenceView } = await import('../pages/discord/DiscordBotPresence');
    return renderToStaticMarkup(<BotPresenceView state={p} />);
  };
  const row = (html: string, name: string) => {
    const start = html.indexOf(`>/${name}</code>`);
    return html.slice(html.lastIndexOf('<tr', start), html.indexOf('</tr>', start));
  };
  const options = (html: string) => [...html.matchAll(/<option value="(\w+)"[^>]*>/g)].map((m) => m[1]);

  it('one Default Commands table: on / off | Command | Access | Description; no Status column, categories or tags', async () => {
    const html = await render();
    const defaults = html.slice(html.indexOf('Default Commands'), html.indexOf('</table>'));
    expect(text(defaults)).toMatch(/Default Commands 10 Custom Commands 0 Edit access On \/ off Command Access Message/);
    expect(defaults).not.toMatch(/>Status</);
    expect(html.match(/role="tablist"/g)).toHaveLength(1); // only Default / Custom Commands, no category tabs
    for (const gone of ['Default Command<', 'Registered with Discord', 'Command Permissions', 'Logging Commands']) expect(html).not.toContain(gone);
    expect([...defaults.matchAll(/<code title="[^"]*">\/(\w+)<\/code>/g)].map((m) => m[1])).toEqual(['ping', 'timeout', 'untimeout', 'ban', 'unban', 'points', 'rewards', 'redeem', 'level', 'leaderboard']);
  });

  it('the Message column shows the reply with its {variables} marked, then an example of using the command', async () => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    const o: DiscordCommandsOverview = {
      commands: [cmd({ name: 'timeout', options: ['user', 'minutes', '[reason]'], example: '/timeout user:@troll minutes:10', message: 'I’ve timed out {user} for {minutes} minutes.' })],
    };
    const html = renderToStaticMarkup(<CommandsView s={hub} discordDefaults={o} />);
    expect(row(html, 'timeout')).toContain(
      '<td class="cell-wrap"><span class="command-message">I’ve timed out <code class="command-var">{user}</code> for <code class="command-var">{minutes}</code> minutes.</span><div class="muted small command-example">Example: <code>/timeout user:@troll minutes:10</code></div></td>',
    );
    expect(row(html, 'timeout')).toContain('<code title="timeout description">/timeout</code>');
  });

  it('each row starts with its on / off switch; Access is plain text; a command on but inactive says why', async () => {
    const html = await render();
    const defaults = html.slice(html.indexOf('Default Commands'), html.indexOf('</table>'));
    expect(defaults).not.toContain('<select');
    expect(row(html, 'ping')).toMatch(/aria-label="\/ping on" checked=""/);
    expect(row(html, 'unban')).toMatch(/aria-label="\/unban off"(?![^>]*checked)/);
    expect(row(html, 'timeout')).toContain('<td class="small">Moderator</td>');
    expect(row(html, 'ban')).toContain('<td class="small">Admin</td>');
    expect(text(row(html, 'points'))).toContain('No reply in chat Loyalty &amp; Rewards is off');
  });

  it('the Kick and Discord tables use the same markup', async () => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    const kick = renderToStaticMarkup(
      <CommandsView s={{ ...hub, platform: 'kick', defaults: [{ trigger: '!enter', description: 'Enter the current giveaway', permission: 'everyone' as const, enabled: true, canDisable: false, inactiveReason: null, args: [], example: null, message: null }], registration: null }} />,
    );
    const rowOf = (h: string, code: string) => h.slice(h.lastIndexOf('<tr', h.indexOf(code)), h.indexOf('</tr>', h.indexOf(code)));
    const shape = (h: string) => h.replace(/![a-z]+|\/[a-z]+/g, 'X').replace(/>[^<]*</g, '><').replace(/ title="[^"]*"/g, '');
    expect(shape(rowOf(kick, '<code>!enter</code>'))).toBe(shape(rowOf(await render(), '<code>/ping</code>')).replace(' checked=""', ' disabled="" checked=""'));
  });

  it('Edit access: Access menus (moderation commands not below Moderator), with the switches still there', async () => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    const html = renderToStaticMarkup(<CommandsView s={hub} discordDefaults={overview} initialEditingAccess />);
    expect(options(row(html, 'ping'))).toEqual(['admin', 'moderator', 'community']);
    expect(options(row(html, 'timeout'))).toEqual(['admin', 'moderator']);
    expect(row(html, 'ban')).toMatch(/<option value="admin" selected="">Admin/);
    expect(row(html, 'unban')).toMatch(/aria-label="\/unban off"(?![^>]*checked)/);
    expect(text(html)).toContain('Moderation commands also need their Discord permission');
    expect(text(html)).toContain('Done');
  });

  it('Default Commands and Custom Commands are browser-style tabs on one card; the other tab’s content is hidden', async () => {
    const html = await render();
    expect(html).toMatch(/<div class="chrome-tabs" role="tablist" aria-label="Discord commands">/);
    expect(html).toMatch(/<button type="button" role="tab" id="commands-tab-discord-defaults" aria-selected="true"[^>]*class="chrome-tab active">Default Commands<span class="chrome-tab-count">10<\/span>/);
    expect(html).toMatch(/<button type="button" role="tab" id="commands-tab-discord-custom" aria-selected="false"[^>]*class="chrome-tab">Custom Commands<span class="chrome-tab-count">0<\/span>/);
    expect(html).toMatch(/<div role="tabpanel" id="commands-panel-discord-defaults" aria-labelledby="commands-tab-discord-defaults">/);
    expect(html).toMatch(/<div role="tabpanel" id="commands-panel-discord-custom" aria-labelledby="commands-tab-discord-custom" hidden="">/);
    const { CommandsView } = await import('../pages/community/CommandsPage');
    const custom = renderToStaticMarkup(<CommandsView s={hub} discordDefaults={overview} initialSection="custom" />);
    expect(custom).toMatch(/id="commands-panel-discord-defaults" aria-labelledby="commands-tab-discord-defaults" hidden=""/);
    expect(custom).toMatch(/aria-selected="true"[^>]*class="chrome-tab active">Custom Commands/);
    // The bot status sections are on Discord Bot, not here.
    expect(text(html)).not.toContain('Status Updates');
    expect(text(html)).not.toContain('Rich Presence Updates');
  });

  it('Status Updates, then Rich Presence Updates', async () => {
    const t = text(await renderPresence());
    expect(t.indexOf('Rich Presence Updates')).toBeGreaterThan(t.indexOf('Status Updates'));
  });

  it('Settings: the forms only — no status lines, and no notes about a person’s own status', async () => {
    const saved = { status: 'idle', customStatus: null, activity: { type: 'watching', name: 'the stream', url: null } } as const;
    const t = text(await renderPresence({ saved, applied: { state: 'sent', at: '2026-10-17T12:00:00Z', presence: saved, problem: null }, botConnected: true, history: [] }));
    for (const gone of ['Sent to Discord', 'Nothing saved', 'Not applied', 'A bot can’t change', 'Rich Presence features for games', 'Images, buttons'])
      expect(t).not.toContain(gone);
    expect(t).toContain('Bots can show an activity type and its text (and a Twitch or YouTube link for Streaming).');
  });

});
