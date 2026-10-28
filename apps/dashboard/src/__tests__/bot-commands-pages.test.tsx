// The Commands page, rendered from backend state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Commands hub', () => {
  type Hub = import('@conduit/shared/community/custom-commands').CommandsHubState;
  type Custom = import('@conduit/shared/community/custom-commands').CustomCommandView;
  const custom = (over: Partial<Custom> = {}): Custom => ({
    id: '3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b',
    platform: 'kick',
    trigger: '!hello',
    description: null,
    response: 'Hello {user}, welcome to {channel}!',
    enabled: true,
    permission: 'everyone',
    cooldownMode: 'none',
    cooldownSeconds: 0,
    access: 'Anyone · no cooldown',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    valid: true,
    problem: null,
    unknownVariables: [],
    lastRun: null,
    runs: 0,
    ...over,
  });
  const hub = (over: Partial<Hub> = {}): Hub => ({
    platform: 'kick',
    defaults: [],
    custom: [],
    ready: { ok: true, note: null, sendAs: 'MyChatBot', channel: 'retronix' },
    registration: null,
    recent: [],
    ...over,
  });
  const render = async (s: Hub) => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    return renderToStaticMarkup(<CommandsView s={s} />);
  };

  it('has exactly one Commands item in the sidebar (no separate Kick Commands)', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.filter((s) => /command/i.test(s.label)).map((s) => s.label)).toEqual(['Commands']);
    expect(SECTIONS.map((s) => s.id)).not.toContain('kick-commands');
  });

  it('offers Discord and Kick tabs only', async () => {
    const { CommandsPage } = await import('../pages/community/CommandsPage');
    const html = renderToStaticMarkup(<CommandsPage />);
    const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
    expect(tabs).toEqual(['Discord', 'Kick']);
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toMatch(/YouTube|Twitch/);
  });

  it('Discord: custom commands are listed apart from the default commands', async () => {
    const t = text(
      await render(
        hub({
          platform: 'discord',
          defaults: [{ trigger: '/ping', description: 'Check that I’m connected', permission: 'everyone' as const, enabled: true, canDisable: false, inactiveReason: null, args: [], example: null, message: null }],
          custom: [custom({ platform: 'discord', trigger: '/discord', description: 'Our Discord link', response: 'Join us, {user}!' })],
          registration: { status: 'registered', problem: null },
          ready: { ok: true, note: null, sendAs: 'RetroBot', channel: null },
        }),
      ),
    );
    expect(t).not.toContain('Registered with Discord');
    expect(t).not.toContain('Default Command ');
    expect(t).toMatch(/New command On \/ off Command Access Description Status Actions \/discord Anyone · no cooldown Our Discord link Enabled/);
    expect(t).not.toContain('Last run');
    // Default commands get no edit/delete controls: the only Edit/Delete belong to the custom row.
    expect(t.match(/ Edit /g)).toHaveLength(1);
  });

  it('Kick: default commands as on / off | Command | Access | Description, without a Status column', async () => {
    const t = text(await render(hub({ defaults: [{ trigger: '!enter', description: 'Enter the current giveaway', permission: 'everyone' as const, enabled: true, canDisable: false, inactiveReason: null, args: [], example: '!enter', message: null }] })));
    expect(t).toMatch(/Default Commands 1 Custom Commands 0 On \/ off Command Access Message !enter Anyone No reply in chat Example: !enter/);
    expect(t).not.toMatch(/Status/);
  });

  it('Kick: each default has its switch, who can use it, its inputs as tags, an example, and why it isn’t answering', async () => {
    const d = (trigger: string, over: Partial<Hub['defaults'][number]> = {}) => ({
      trigger,
      description: `${trigger} description`,
      permission: 'everyone' as const,
      enabled: true,
      canDisable: true,
      inactiveReason: null,
      args: [] as string[],
      example: null as string | null,
      message: null as string | null,
      ...over,
    });
    const defaults = [
      d('!enter', { canDisable: false }),
      d('!timeout', { permission: 'moderator', args: ['@name', '[minutes]', '[reason]'], example: '!timeout @troll 10 spamming', message: '{name} is timed out for {minutes} minutes.' }),
      d('!title', { enabled: false }),
      d('!followage', { inactiveReason: 'Your custom !followage answers instead' }),
    ];
    const html = await render(hub({ defaults }));
    const t = text(html);
    // The Message column: the reply with its {variables} marked, then an example; the description is the tooltip.
    expect(t).toMatch(/!timeout Moderators? \{name\} is timed out for \{minutes\} minutes\. Example: !timeout @troll 10 spamming/);
    expect(html).toContain('<span class="command-message"><code class="command-var">{name}</code> is timed out for <code class="command-var">{minutes}</code> minutes.</span>');
    expect(html).toContain('<code title="!timeout description">!timeout</code>');
    expect(t).toContain('No reply in chat Your custom !followage answers instead');
    // Switches: on, off, and fixed on for !enter.
    expect(html).toMatch(/aria-label="!timeout on" checked=""/);
    expect(html).toMatch(/aria-label="!title off"(?![^>]*checked)/);
    expect(html).toMatch(/aria-label="!enter on" disabled="" checked=""/);
    expect(t).not.toContain('Edit access');
    expect(t).toContain('A custom command with the same trigger answers instead of the default.');
  });

  it('each custom command starts with an on/off toggle (green on, red off); the row ends with Edit and Delete only', async () => {
    const html = await render(hub({ custom: [custom(), custom({ id: 'b', trigger: '!off', response: 'Off', enabled: false })] }));
    const row = (trigger: string) => {
      const at = html.indexOf(`<code>${trigger}</code>`);
      return html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
    };
    expect(row('!hello')).toMatch(/^<tr><td class="cell-toggle"><label class="switch switch-onoff"><input type="checkbox" aria-label="!hello on" checked=""/);
    expect(row('!off')).toMatch(/aria-label="!off off"(?![^>]*checked)/);
    for (const r of [row('!hello'), row('!off')]) {
      expect(text(r)).toMatch(/Edit Delete\s*$/);
      expect(r).not.toMatch(/>(Disable|Enable)</);
    }
  });

  it('Kick: says honestly there are no built-in commands, and lists custom ones', async () => {
    const t = text(await render(hub({ custom: [custom(), custom({ id: 'b', trigger: '!off', response: 'Off', enabled: false })] })));
    expect(t).toContain('No built-in Kick commands yet.');
    // Kick commands have no description: the reply is shown.
    expect(t).toMatch(/!hello Anyone · no cooldown Hello \{user\}, welcome to \{channel\}! Enabled/);
    expect(t).toMatch(/!off Anyone · no cooldown Off Disabled/);
    expect(t).not.toContain('Not triggered this session');
  });

  it('flags a stored placeholder that is not a supported variable (posted as written)', async () => {
    const t = text(
      await render(
        hub({ custom: [custom({ trigger: '!vanish', response: 'Bye {{sender.username}', unknownVariables: ['{sender.username}'] })] }),
      ),
    );
    expect(t).toMatch(/\{sender\.username\} isn’t a variable for Kick commands; it’s posted as written/);
    expect(t).toContain('Enabled');
  });

  it('shows empty states; account status is left to the Dashboard', async () => {
    const t = text(
      await render(hub({ ready: { ok: false, note: 'Commands respond only while Kick chat is connected.', sendAs: null, channel: null } })),
    );
    expect(t).toContain('No custom Kick commands yet.');
    expect(t).not.toContain('Commands respond only while Kick chat is connected.');
  });
});

describe('Command editor variables', () => {
  async function editor(platform: 'kick' | 'discord', response = '') {
    const { CommandEditor } = await import('../pages/community/CommandsPage');
    const initial =
      response === ''
        ? null
        : {
            id: 'x',
            platform,
            trigger: platform === 'kick' ? '!hello' : '/hello',
            description: platform === 'discord' ? 'Say hello' : null,
            response,
            enabled: true,
            permission: 'everyone' as const,
            cooldownMode: 'none' as const,
            cooldownSeconds: 0,
            access: 'Anyone · no cooldown',
            createdAt: '',
            updatedAt: '',
            valid: true,
            problem: null,
            unknownVariables: [],
            lastRun: null,
            runs: 0,
          };
    return renderToStaticMarkup(<CommandEditor platform={platform} initial={initial} onCancel={() => {}} onSaved={() => {}} />);
  }

  const inserts = (html: string) => [...html.matchAll(/aria-label="Insert ([^"]+)"/g)].map((m) => m[1]);
  const groups = (html: string) => [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);

  it('lists the variables by group, clickable, with examples; only the ones that work on Kick', async () => {
    const html = await editor('kick');
    expect(groups(html)).toEqual(['User and input', 'Your Kick stream', 'Random and maths', 'Counters', 'Time', 'Kick only']);
    const list = inserts(html);
    for (const v of ['{user}', '{touser}', '{args}', '{1}', '{random:1-6}', '{pick:heads;tails}', '{counter:deaths+1}', '{uptime}', '{submonths}']) expect(list).toContain(v);
    for (const v of ['{followers}', '{followage}', '{streamer.bio}']) expect(list).not.toContain(v); // no unofficial Kick data
    for (const v of ['{mention}', '{points}', '{server}']) expect(list).not.toContain(v); // Discord only
    const t = text(html);
    expect(t).toContain('Add |text for a fallback');
    expect(t).toContain('If nothing is given, {args} is empty');
    expect(t).toContain('Hello {user}, welcome to {channel}!');
    expect(html).toMatch(/<details class="variable-group" open=""><summary>User and input<\/summary>/);
  });

  it('Discord: the description and “text” box, and Discord-only variables instead of Kick-only ones', async () => {
    const html = await editor('discord');
    const t = text(html);
    expect(t).toContain('Description');
    expect(t).toContain('adds a “text” box to the command');
    expect(groups(html)).toContain('Discord only');
    expect(groups(html)).not.toContain('Kick only');
    for (const v of ['{mention}', '{server}', '{membercount}', '{points}', '{level}', '{rank}']) expect(inserts(html)).toContain(v);
    expect(inserts(html)).not.toContain('{submonths}'); // Kick only
  });

  it('previews new variables with fixed example values', async () => {
    const t = text(await editor('kick', '{touser} rolled {random:1-6}, deaths {counter:deaths+1}, live {uptime}'));
    expect(t).toContain('hi rolled 3, deaths 8, live 2 hours 15 minutes');
  });

  it('previews with clearly labelled example values', async () => {
    const t = text(await editor('kick', 'Hello {user}, welcome to {channel}!'));
    expect(t).toMatch(
      /Preview with example values \( user “ExampleViewer”, channel “yourchannel”, text “hi there”\): Hello ExampleViewer, welcome to yourchannel!/,
    );
  });

  it('Discord: a several-line reply box, and a preview with Discord markdown', async () => {
    const html = await editor('discord', '## Hi {user}\n- **bold** item');
    expect(html).toMatch(/<textarea[^>]*id="command-response"/);
    expect(html).toContain('<div class="md-h2" role="heading" aria-level="4">Hi exampleviewer</div>');
    expect(html).toContain('<ul class="md-list"><li><strong>bold</strong> item</li></ul>');
    expect(text(html)).toContain('Discord markdown works');
    expect(await editor('kick')).toMatch(/<input[^>]*id="command-response"/);
  });

  it('checkCommandForm applies the backend rules', async () => {
    const { checkCommandForm } = await import('../pages/community/CommandsPage');
    expect(checkCommandForm('kick', { trigger: '!hi', response: 'Hello {user}' })).toEqual({});
    expect(checkCommandForm('kick', { trigger: '!hi', response: 'Hi {name}' }).response).toMatch(/\{name\} isn’t a variable for Kick commands/);
    expect(checkCommandForm('kick', { trigger: '!hi', response: 'Hi {mention}' }).response).toMatch(/\{mention\} isn’t a variable for Kick commands/);
    expect(checkCommandForm('kick', { trigger: '!hi', response: 'Rolled {random:1-6|?} {touser|you}' })).toEqual({});
    expect(checkCommandForm('discord', { trigger: 'ping', response: 'x', description: 'd' }).trigger).toMatch(/default command/);
    expect(checkCommandForm('discord', { trigger: 'hi', response: 'x', description: '' }).description).toMatch(/description/);
  });
});

describe('Command editor permissions and cooldowns', () => {
  async function editor(platform: 'kick' | 'discord', over: Record<string, unknown> | null = null) {
    const { CommandEditor } = await import('../pages/community/CommandsPage');
    const initial = over
      ? {
          id: 'x',
          platform,
          trigger: platform === 'kick' ? '!x' : '/x',
          description: platform === 'discord' ? 'X' : null,
          response: 'Hi',
          enabled: true,
          permission: 'everyone' as const,
          cooldownMode: 'none' as const,
          cooldownSeconds: 0,
          access: 'Anyone · no cooldown',
          createdAt: '',
          updatedAt: '',
          valid: true,
          problem: null,
          unknownVariables: [],
          lastRun: null,
          runs: 0,
          ...over,
        }
      : null;
    return renderToStaticMarkup(<CommandEditor platform={platform} initial={initial as never} onCancel={() => {}} onSaved={() => {}} />);
  }

  it('Kick: all four permission levels, explained', async () => {
    const t = text(await editor('kick'));
    expect(t).toContain('Permissions');
    expect(t).toMatch(/Anyone — Anyone in your chat/);
    expect(t).toMatch(/Subscribers — Subscribers \(Kick subscriber badge\), moderators and you/);
    expect(t).toMatch(/Moderators — Your channel’s moderators \(Kick moderator badge\) and you/);
    expect(t).toMatch(/Broadcaster only — Only you, the channel owner/);
  });

  it('Discord: subscribers shown as unavailable (disabled), administrators explained', async () => {
    const html = await editor('discord');
    const subscriberRadio = html.match(/<input[^>]*value="subscriber"[^>]*>/)![0];
    expect(subscriberRadio).toContain('disabled=""');
    expect(text(html)).toContain('Not available: Discord has no subscribers');
    expect(text(html)).toContain('Admin — Members with Administrator (the server owner always has it)');
  });

  it('cooldown: no duration field until a cooldown is chosen; then a seconds field with limits', async () => {
    let html = await editor('kick');
    expect(html).not.toContain('id="command-cooldown-seconds"');
    expect(text(html)).toContain('The command can be used again right away.');
    html = await editor('kick', { cooldownMode: 'user', cooldownSeconds: 45 });
    expect(html).toMatch(/id="command-cooldown-seconds"[^>]*min="1"[^>]*max="86400"/);
    expect(html).toContain('value="45"');
    expect(text(html)).toContain('cooldowns reset when CONDUIT restarts');
  });

  it('checkCommandForm validates the cooldown like the backend', async () => {
    const { checkCommandForm } = await import('../pages/community/CommandsPage');
    expect(checkCommandForm('kick', { trigger: '!a', response: 'b', cooldownMode: 'user', cooldownSeconds: 0 }).cooldownSeconds).toMatch(
      /1–86400/,
    );
    expect(checkCommandForm('kick', { trigger: '!a', response: 'b', cooldownMode: 'global', cooldownSeconds: 30 })).toEqual({});
    expect(checkCommandForm('discord', { trigger: 'a', response: 'b', description: 'd', permission: 'subscriber' }).permission).toMatch(
      /no subscribers/,
    );
  });

  it('the table shows the effective settings; blocked runs are in Recent runs', async () => {
    const { CommandsView } = await import('../pages/community/CommandsPage');
    const t = text(
      renderToStaticMarkup(
        <CommandsView
          s={{
            platform: 'kick',
            defaults: [],
            custom: [
              {
                id: 'a',
                platform: 'kick',
                trigger: '!mod',
                description: null,
                response: 'Mods only',
                enabled: true,
                permission: 'moderator',
                cooldownMode: 'user',
                cooldownSeconds: 30,
                access: 'Moderators · 30 s per user',
                createdAt: '',
                updatedAt: '',
                valid: true,
                problem: null,
                unknownVariables: [],
                lastRun: { at: '2026-01-01T00:00:00Z', outcome: 'blocked', detail: 'Not allowed: moderators only.' },
                runs: 1,
              },
            ],
            ready: { ok: true, note: null, sendAs: 'MyChatBot', channel: 'retronix' },
            registration: null,
            recent: [{ at: '2026-01-01T00:00:00Z', trigger: '!mod', outcome: 'blocked', detail: 'Not allowed: moderators only.' }],
          }}
        />,
      ),
    );
    expect(t).toMatch(/!mod Moderators · 30 s per user Mods only Enabled/);
    // Runs are in the log (Recent runs), not in the table.
    expect(t).toMatch(/Recent runs !mod — Blocked .* Not allowed: moderators only\./);
  });
});
