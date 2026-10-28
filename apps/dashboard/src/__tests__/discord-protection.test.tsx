// Discord Bot → Protection, rendered from backend state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import { ANTINUKE_DEFAULTS, ANTIRAID_DEFAULTS, BOTBAIT_DEFAULTS, MESSAGE_CHECKS_DEFAULTS, type DiscordAutomodGuild, type DiscordAutomodRule, type DiscordProtectionState } from '@conduit/shared/discord/discord-protection';

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
const sections = (html: string) => [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1]);

const rule = (over: Partial<DiscordAutomodRule> = {}): DiscordAutomodRule => ({
  id: '00000000-0000-0000-0000-0000000000a1',
  guildId: '42',
  name: 'No invites',
  enabled: true,
  trigger: 'keyword',
  keywords: ['discord.gg/*'],
  regexPatterns: [],
  allowList: [],
  mentionLimit: null,
  action: 'timeout',
  timeoutMinutes: 10,
  alertChannelId: '5',
  exemptModerators: true,
  exemptRoles: ['7'],
  exemptChannels: [],
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  ...over,
});
const guild = (over: Partial<DiscordAutomodGuild> = {}): DiscordAutomodGuild => ({
  id: '42',
  name: 'Retro Server',
  rules: [],
  roles: [{ id: '7', name: 'Mods' }],
  channels: [{ id: '5', name: 'mod-alerts' }],
  ...over,
});
const state = (over: Partial<DiscordProtectionState> = {}): DiscordProtectionState => ({
  messageChecks: structuredClone(MESSAGE_CHECKS_DEFAULTS),
  automod: { guilds: [guild()], problem: null },
  stats: { checked: 0, matched: 0, since: '2026-10-18T10:00:00.000Z' },
  messageContent: true,
  antinuke: structuredClone(ANTINUKE_DEFAULTS),
  quarantine: [],
  antiraid: structuredClone(ANTIRAID_DEFAULTS),
  lockdowns: [],
  botbait: structuredClone(BOTBAIT_DEFAULTS),
  ...over,
});

type Open = 'automod' | 'messages' | 'antinuke' | 'antiraid' | 'botbait' | null;
async function render(s: DiscordProtectionState, open: Open = null) {
  const { DiscordProtectionView } = await import('../pages/discord/DiscordProtection');
  const html = renderToStaticMarkup(<DiscordProtectionView s={s} initialOpen={open} />);
  return { html, t: text(html) };
}

describe('Discord Bot → Protection overview', () => {
  it('one compact list: each feature with what it does, its status, a switch and Configure; no settings until opened', async () => {
    const { html, t } = await render(state());
    expect(sections(html)).toEqual(['Protection']);
    expect(t).not.toMatch(/Runs on Discord|Runs in CONDUIT/);
    expect(t).toMatch(/AutoMod Your own rules for words, mention spam and member names\. No rules Manage/);
    expect(t).toContain('Everything runs while CONDUIT is open.');
    expect(t).toMatch(/Message checks Repeated messages, flooding, caps and invite links\. Off Configure/);
    expect(t).toMatch(/Anti-nuke Stops mass deleting, banning and rogue bots\. Off Configure/);
    expect(t).toMatch(/Anti-raid Spots join bursts, can lock the server down, and checks new accounts \(join gate\)\. Off Configure/);
    expect(t).not.toMatch(/Join gate &amp; Verify|Verify button/);
    expect(t).toMatch(/Bot bait Trap channels: anyone who posts there is treated as a spam bot\. Off Configure/);
    for (const f of ['Message checks', 'Anti-nuke', 'Anti-raid', 'Bot bait']) expect(html).toContain(`aria-label="${f} off"`);
    expect(html).not.toContain('protection-panel');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(5);
  });

  it('statuses say how each feature is set', async () => {
    const { protectionStatus } = await import('../pages/discord/DiscordProtection');
    const s = state({ automod: { guilds: [guild({ rules: [rule(), rule({ id: '2', enabled: false })] })], problem: null } });
    s.messageChecks.enabled = true;
    s.antinuke = { ...s.antinuke, enabled: true, mode: 'enforce', response: 'ban' };
    s.antiraid = { ...s.antiraid, enabled: true, gate: { ...s.antiraid.gate, enabled: true, response: 'kick' } };
    const st = protectionStatus(s);
    expect(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.label]))).toEqual({
      automod: '1 of 2 rules on',
      messages: 'Log only',
      antinuke: 'Enforcing: ban',
      antiraid: 'Alert only · gate kicks',
      botbait: 'Off',
    });
    const gateOnly = state();
    gateOnly.antiraid = { ...gateOnly.antiraid, gate: { ...gateOnly.antiraid.gate, enabled: true, response: 'hold' } };
    expect(protectionStatus(gateOnly).antiraid).toEqual({ label: 'Join gate holds', pill: 'pill-ok' });
    expect(protectionStatus(state({ botbait: { ...BOTBAIT_DEFAULTS, enabled: true } })).botbait.label).toBe('No channels');
    expect(protectionStatus(state({ botbait: { ...BOTBAIT_DEFAULTS, enabled: true, channels: ['5'], action: 'softban' } })).botbait.label).toBe('Enforcing: softban');
    expect(protectionStatus(state({ automod: { guilds: [], problem: null } })).automod.label).toBe('No server');
    expect(protectionStatus(state({ lockdowns: [lockdown()] })).antiraid).toEqual({ label: 'Locked down', pill: 'pill-bad' });
  });

  it('opening a feature shows only its settings, below its row', async () => {
    const { html, t } = await render(state(), 'antinuke');
    expect(html.match(/protection-panel/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="true"');
    expect(t).toMatch(/Anti-nuke .* Close Never acts on the server owner/);
    expect(t).not.toContain('Repeated messages Message flooding');
  });

  it('lockdowns and active quarantines show above the list only while they’re in effect', async () => {
    const { html } = await render(state({ lockdowns: [lockdown()], quarantine: [quarantine({}), quarantine({ id: '00000000-0000-0000-0000-000000000002', status: 'released' })] }));
    expect(sections(html)).toEqual(['Lockdown in effect', 'Quarantined members', 'Protection']);
  });
});

describe('AutoMod panel (CONDUIT’s own rules)', () => {
  it('lists the rules with an on/off toggle, what each does, and exemptions; says it’s CONDUIT’s own', async () => {
    const { html, t } = await render(
      state({ automod: { guilds: [guild({ rules: [rule(), rule({ id: '00000000-0000-0000-0000-0000000000a2', name: 'Pings', trigger: 'mention_spam', keywords: [], mentionLimit: 5, action: 'delete_message', alertChannelId: null, enabled: false })] })], problem: null } }),
      'automod',
    );
    expect(t).toContain('CONDUIT’s own rules, checked while CONDUIT is open.');
    expect(t).toContain('Discord’s built-in AutoMod isn’t changed.');
    expect(t).toMatch(/No invites Exempt: 1 role Custom words Delete and time out 10 min · Alert #mod-alerts Edit Delete/);
    expect(t).toMatch(/Pings Exempt: 1 role Mention spam Delete the message Edit Delete/);
    expect(html).toContain('aria-label="No invites on"');
    expect(html).toContain('aria-label="Pings off"');
    expect(t).not.toMatch(/Manage Server|Suspected spam|Commonly flagged/);
  });

  it('new rules: custom words, mention spam or member names; up to 25 a server', async () => {
    const { html } = await render(state(), 'automod');
    expect([...html.matchAll(/<select aria-label="Kind of rule">(.*?)<\/select>/g)][0]![1]).toBe(
      '<option value="keyword" selected="">Custom words</option><option value="mention_spam">Mention spam</option><option value="member_profile">Member names</option>',
    );
    const many = Array.from({ length: 25 }, (_, i) => rule({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
    const { t } = await render(state({ automod: { guilds: [guild({ rules: many })], problem: null } }), 'automod');
    expect(t).toContain('A server can have up to 25 rules.');
  });

  it('custom words need the Message Content intent; it says so when it’s off', async () => {
    const { t } = await render(state({ messageContent: false }), 'automod');
    expect(t).toContain('Custom words need the Message Content intent');
  });

  it('the editor: words, wildcards and allowed words; what it does; alert; exemptions (member names: no channels or moderators)', async () => {
    const { AutomodRuleEditor } = await import('../pages/discord/DiscordProtection');
    const words = text(renderToStaticMarkup(<AutomodRuleEditor g={guild()} rule={null} trigger="keyword" onClose={() => {}} onSaved={() => {}} />));
    expect(words).toMatch(/New rule · Custom words .* Words and phrases .* Regular expressions .* cat\* words starting with it,.* Allowed words .* When it matches .* Send an alert to .* Don’t check moderators .* Exempt roles .* Exempt channels/);
    const names = renderToStaticMarkup(<AutomodRuleEditor g={guild()} rule={null} trigger="member_profile" onClose={() => {}} onSaved={() => {}} />);
    expect(names).toMatch(/<option value="log" selected="">Log only<\/option><option value="timeout">Time out<\/option><option value="kick">Kick<\/option>/);
    expect(text(names)).not.toMatch(/Exempt channels|Don’t check moderators/);
    const mentions = text(renderToStaticMarkup(<AutomodRuleEditor g={guild()} rule={null} trigger="mention_spam" onClose={() => {}} onSaved={() => {}} />));
    expect(mentions).toContain('Most mentions allowed (per message)');
    expect(mentions).not.toContain('Words and phrases');
  });

  it('a rule whose alert channel is gone shows it (not “No alert”), so it can be changed before saving', async () => {
    const { AutomodRuleEditor } = await import('../pages/discord/DiscordProtection');
    const gone = rule({ trigger: 'mention_spam', name: 'Block mention spam', keywords: [], mentionLimit: 5, alertChannelId: '99' });
    const html = renderToStaticMarkup(<AutomodRuleEditor g={guild()} rule={gone} trigger="mention_spam" onClose={() => {}} onSaved={() => {}} />);
    expect(html).toContain('<option value="99" selected="">Unknown channel (no longer exists?)</option>');
    const { t } = await render(state({ automod: { guilds: [guild({ rules: [gone] })], problem: null } }), 'automod');
    expect(t).toContain('Alert: unknown channel');
  });
});

describe('Message checks panel', () => {
  it('every check with its action, log only by default; the switch is in the row', async () => {
    const { html, t } = await render(state(), 'messages');
    expect(html).not.toContain('<strong>Check messages</strong>');
    for (const c of ['Repeated messages', 'Message flooding', 'Excessive caps', 'Invite links']) expect(t).toContain(c);
    expect(html.match(/<option value="log" selected="">Log only<\/option>/g)).toHaveLength(4);
  });

  it('warns when the bot can’t read message text', async () => {
    const s = state({ messageContent: false });
    s.messageChecks.enabled = true;
    const { t } = await render(s, 'messages');
    expect(t).toContain('caps and invite checks can’t run');
    expect(t).toContain('Every check is on “Log only”');
  });
});

const quarantine = (over: Partial<DiscordProtectionState['quarantine'][number]>): DiscordProtectionState['quarantine'][number] => ({
  id: '00000000-0000-0000-0000-000000000001',
  at: '2026-10-18T12:00:00Z',
  guildId: '42',
  place: 'Retro Server',
  userId: '9',
  userName: 'nuker',
  roles: [{ id: '7', name: 'Mods' }, { id: '8', name: null }],
  reason: '3 channels deleted within 60 s.',
  status: 'active',
  resolvedAt: null,
  ...over,
});

describe('Anti-nuke panel', () => {
  it('alert only by default, balanced preset, every rule with its threshold', async () => {
    const { html, t } = await render(state(), 'antinuke');
    expect(html).toContain('<option value="alert" selected="">Alert only (dry run)</option>');
    expect(html).toMatch(/class="btn btn-primary btn-row"[^>]*>Balanced</);
    for (const r of ['Channels deleted', 'Roles created', 'Dangerous permissions given', 'Members pruned', 'Bots added', 'Webhooks created']) expect(t).toContain(r);
    expect(html).toContain('aria-label="Channels deleted threshold" class="num" type="number" min="1" max="50" value="3"');
  });

  it('warns when enforcing without trusted people or roles, and without an alert channel', async () => {
    const { t } = await render(state({ antinuke: { ...structuredClone(ANTINUKE_DEFAULTS), enabled: true, mode: 'enforce' } }), 'antinuke');
    expect(t).toContain('Enforcing with no trusted people or roles');
    expect(t).toContain('No alert channel: trips are only recorded in Logs.');
  });

  it('the quarantine history, with Restore and Release while active', async () => {
    const { html, t } = await render(state({ quarantine: [quarantine({}), quarantine({ id: '00000000-0000-0000-0000-000000000002', userName: 'old', status: 'restored' })] }), 'antinuke');
    expect(t).toContain('Quarantine history');
    expect(t).toMatch(/Quarantine history .* nuker Retro Server 3 channels deleted within 60 s\. @Mods, 8 Quarantined Restore Release/);
    expect(t).toMatch(/old .* Roles restored/);
    // Once in the card above the list (active only), once in the history.
    expect(html.match(/<button[^>]*>Restore<\/button>/g)).toHaveLength(2);
  });
});

const lockdown = (): DiscordProtectionState['lockdowns'][number] => ({
  guildId: '42',
  place: 'Retro Server',
  since: '2026-10-18T12:00:00Z',
  reason: '12 members joined within 10 s.',
  manual: false,
  liftAt: '2026-10-18T12:15:00Z',
  verification: { from: 'low', to: 'high' },
  lockedChannels: [{ id: '5', name: 'mod-alerts' }],
  problems: ['#general not locked: Discord refused.'],
});

describe('Anti-raid panel', () => {
  it('bursts and lockdown options, and locking down by hand', async () => {
    const { html, t } = await render(state(), 'antiraid');
    expect(html).not.toContain('<strong>Watch for join bursts</strong>');
    expect(html).toContain('<option value="alert" selected="">Alert only (dry run)</option>');
    expect(html).toContain('<option value="high" selected="">High (member 10+ minutes)</option>');
    expect(t).toMatch(/Lockdown by hand .* Retro Server Normal Preview Lock down now/);
  });

  it('the join gate is part of it; Hold works through Verify buttons (Embed Creator)', async () => {
    const { html, t } = await render(state(), 'antiraid');
    expect(t).toMatch(/Join gate Check new accounts \(only new joins\) Flag accounts younger than ?.*days or without a profile picture Flagged members/);
    expect(html).toContain('<option value="hold">Hold: Verify buttons won’t let them in</option>');
    expect(t).toContain('“Hold” works with buttons that use the Verify action (Discord → Embed Creator → Buttons &amp; Menus).');
    expect(t).not.toMatch(/Post the Verify button|Save join gate/);
  });

  it('warns when enforcing a lockdown that changes nothing', async () => {
    const { t } = await render(state({ antiraid: { ...structuredClone(ANTIRAID_DEFAULTS), enabled: true, mode: 'enforce', raiseVerification: false } }), 'antiraid');
    expect(t).toContain('the lockdown does nothing');
    expect(t).toContain('No alert channel');
  });

  it('a lockdown in effect: what changed and when it lifts', async () => {
    const { t } = await render(state({ lockdowns: [lockdown()] }));
    expect(t).toMatch(/Lockdown in effect Retro Server Locked down .* 12 members joined within 10 s\. Verification raised from Low \(verified email\) to High \(member 10\+ minutes\)\. Locked: #mod-alerts Lifts at .* #general not locked: Discord refused\. Lift lockdown/);
  });
});

describe('role and channel pickers', () => {
  it('chosen ones as removable chips (also ids that no longer exist), and an Add menu with the rest', async () => {
    const s = state();
    s.messageChecks.exemptRoles = ['7', '999'];
    const { html, t } = await render(s, 'messages');
    expect(html).toContain('class="id-chip id-chip-role"');
    expect(html).toContain('aria-label="Remove @Mods"');
    expect(html).toContain('class="id-chip id-chip-role is-missing"');
    expect(t).toContain('Unknown role');
    // Mods is chosen, so the role menu has nothing left; channels can still be added.
    expect(html).toMatch(/aria-label="Add a role to Exempt roles"[^>]*disabled=""[^>]*><option value="" selected="">No more roles<\/option>/);
    expect(html).toMatch(/aria-label="Add a channel to Exempt channels"[^>]*><option value="" selected="">\+ Add channel…<\/option><option value="5">#mod-alerts<\/option>/);
    expect(t).toContain('No channels yet.');
  });
});

describe('Bot bait panel', () => {
  it('bait channels, the action, and the warning to post once saved', async () => {
    const empty = await render(state(), 'botbait');
    expect(empty.t).toContain('Bait channels');
    expect(empty.html).toContain('<option value="alert" selected="">Alert only</option>');
    expect(empty.t).not.toContain('Warning message');

    const s = state({ botbait: { ...BOTBAIT_DEFAULTS, enabled: true, channels: ['5'], action: 'ban' } });
    const { html, t } = await render(s, 'botbait');
    expect(html).toContain('aria-label="Remove #mod-alerts"');
    expect(t).toContain('Their other messages');
    expect(t).toMatch(/Warning message .* ⚠️ Do not post in this channel — This channel catches spam bots\. Anything posted here gets the account banned automatically\.” Post in #mod-alerts/);
    expect(t).toContain('No alert channel: catches are only recorded in Logs.');
  });

  it('warns when on with no bait channels', async () => {
    const { t } = await render(state({ botbait: { ...BOTBAIT_DEFAULTS, enabled: true } }), 'botbait');
    expect(t).toContain('Choose at least one bait channel');
  });
});
