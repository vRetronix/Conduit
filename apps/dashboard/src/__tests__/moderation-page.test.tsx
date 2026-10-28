// Kick and Discord moderation pages and navigation, rendered from backend state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import {
  AUTOMOD_DEFAULTS,
  type DiscordModerationState,
  type KickModerationState,
  type ModerationCapability,
  type ModerationRecordView,
} from '@conduit/shared/community/moderation';

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
/** The page's primary sections: the h2 of each card. */
const sections = (html: string) => [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1]);

const yes: ModerationCapability = { available: true, problem: null };
const no = (problem: string): ModerationCapability => ({ available: false, problem });

function kick(over: Partial<KickModerationState> = {}): KickModerationState {
  return {
    connected: true,
    problem: null,
    accountName: 'RetroLive',
    channel: 'retrolive',
    chat: { status: 'connected', problem: null },
    automod: {
      kick: structuredClone(AUTOMOD_DEFAULTS),
      kickActions: { log: yes, delete_message: yes, timeout: yes },
      raid: { activeUntil: null, learning: true, knownChatters: 3 },
      kickModerationEvents: { ok: true, problem: null },
      discord: { supported: false, reason: 'Reading Discord messages needs the privileged Message Content intent, which CONDUIT doesn’t use.' },
      stats: { checked: 0, matched: 0, since: '2026-10-11T18:00:00.000Z' },
    },
    history: [],
    ...over,
  };
}

const guildCaps = (over: Record<string, ModerationCapability> = {}) => ({ timeout: yes, untimeout: yes, ban: yes, unban: yes, delete_message: yes, lookup: yes, ...over });

function discord(over: Partial<DiscordModerationState> = {}): DiscordModerationState {
  return {
    connected: true,
    problem: null,
    botName: 'RetroBot',
    guilds: [{ id: '42', name: 'Retro Server', problem: null, capabilities: guildCaps({ ban: no('x'), unban: no('x') }) }],
    commands: [
      { name: 'timeout', permission: 'Timeout Members', missingIn: [] },
      { name: 'untimeout', permission: 'Timeout Members', missingIn: [] },
      { name: 'kick', permission: 'Kick Members', missingIn: ['42'] },
      { name: 'ban', permission: 'Ban Members', missingIn: ['42'] },
      { name: 'unban', permission: 'Ban Members', missingIn: ['42'] },
    ],
    automod: { supported: false, reason: 'Reading Discord messages needs the privileged Message Content intent, which CONDUIT doesn’t use. Use Discord’s built-in AutoMod (Server Settings → AutoMod) for Discord.' },
    history: [],
    serverHistory: [],
    protectionHistory: [],
    loggingHistory: [],
    loyaltyHistory: [],
    ...over,
  };
}

const rec = (over: Partial<ModerationRecordView>): ModerationRecordView => ({
  id: Math.random().toString(),
  at: '2026-10-11T18:00:00.000Z',
  platform: 'kick',
  place: 'retrolive',
  action: 'timeout',
  targetUserId: '1',
  targetName: 'viewer1',
  durationSeconds: 600,
  reason: null,
  source: 'automod',
  actor: 'RetroLive',
  rule: 'repeat',
  outcome: 'success',
  detail: null,
  ...over,
});

async function renderKick(s: KickModerationState) {
  const { KickModerationView } = await import('../pages/community/ModerationPage');
  const html = renderToStaticMarkup(<KickModerationView s={s} />);
  return { html, t: text(html) };
}
async function renderDiscord(s: DiscordModerationState) {
  const { DiscordModerationView } = await import('../pages/community/ModerationPage');
  const html = renderToStaticMarkup(<DiscordModerationView s={s} />);
  return { html, t: text(html) };
}

describe('navigation', () => {
  it('is organised by platform; every feature has exactly one place', async () => {
    const { SECTIONS, SECTION_GROUPS } = await import('../sections');
    expect(SECTION_GROUPS.map((x) => x.label)).toEqual(['Overview', 'Discord', 'Kick', 'Twitch', 'YouTube', 'Coming later']);
    const inGroup = (g: string) => SECTIONS.filter((s) => s.group === g).map((s) => (s.phase === null ? s.label : `${s.label} (Soon)`));
    expect(inGroup('overview')).toEqual(['Dashboard', 'Commands', 'Giveaways', 'Timed Messages']);
    expect(inGroup('discord')).toEqual(['Discord Bot', 'Sticky Messages', 'Embed Creator', 'Loyalty & Rewards']);
    expect(inGroup('kick')).toEqual(['Kick Moderation', 'Kick Notifications', 'Clips']);
    // Connections are managed from the Dashboard's cards, not separate pages.
    // (The Discord Bot page is the bot's settings, protection and logs — not account connections.)
    expect(SECTIONS.map((s) => s.label).filter((l) => /Kick Accounts|Bot Accounts|Connections/.test(l))).toEqual([]);
    expect(SECTIONS.find((s) => s.label === 'Discord Bot')!.summary).not.toMatch(/connect|account/i);
    expect(inGroup('twitch')).toEqual(['Twitch Notifications (Soon)', 'Twitch Moderation (Soon)']);
    expect(inGroup('youtube')).toEqual(['YouTube Notifications (Soon)', 'YouTube Moderation (Soon)']);
    expect(inGroup('planned').every((l) => l.endsWith('(Soon)'))).toBe(true);
    // No duplicates, and the retired workflow builder is gone.
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('automations');
    expect(ids.filter((id) => id.includes('sticky'))).toEqual(['sticky-messages']);
    expect(ids.filter((id) => id.includes('timed'))).toEqual(['timed-messages']);
  });

  it('the sidebar marks platform categories, and Soon items are gray and not clickable', async () => {
    const { App } = await import('../App');
    const html = renderToStaticMarkup(<App />);
    const t = text(html);
    expect(t).toMatch(
      /Overview Dashboard Commands Giveaways Timed Messages Discord Discord Bot Sticky Messages Embed Creator Loyalty &(?:amp;)? Rewards Kick Kick Moderation Kick Notifications Clips Twitch Soon Twitch Notifications Soon Twitch Moderation Soon YouTube Soon YouTube Notifications Soon YouTube Moderation Soon Coming later Soon OBS Overlays Soon/,
    );
    // Groups fold: those with only planned (Soon) sections start folded (still in the page, hidden); the rest are open.
    for (const g of ['twitch', 'youtube', 'planned']) {
      expect(html).toMatch(new RegExp(`aria-expanded="false" aria-controls="nav-group-${g}"`));
      expect(html).toMatch(new RegExp(`id="nav-group-${g}" class="nav-group-items" hidden=""`));
    }
    for (const g of ['overview', 'discord', 'kick']) expect(html).toMatch(new RegExp(`aria-expanded="true" aria-controls="nav-group-${g}"`));
    for (const p of ['discord', 'kick', 'twitch', 'youtube']) expect(html).toContain(`nav-platform nav-platform-${p}`);
    // Soon entries are plain text (no button), marked disabled, with the gray Soon label.
    expect(html).toMatch(/<span class="nav-item nav-soon" aria-disabled="true" title="Coming soon">.*?Twitch Notifications.*?<span class="nav-phase">Soon<\/span><\/span>/);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Twitch Notifications/);
    expect(t).toContain('Connect and manage your platform accounts.');
  });

  it('Settings is pinned in the sidebar footer next to the version, and opens', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.filter((s) => s.group === 'footer').map((s) => [s.id, s.label, s.phase])).toEqual([['settings', 'Settings', null]]);
    expect(SECTIONS.filter((s) => s.group === 'planned').map((s) => s.label)).toEqual(['OBS Overlays']);
    const { App } = await import('../App');
    const html = renderToStaticMarkup(<App />);
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    expect(nav).not.toContain('Settings');
    const footer = html.slice(html.indexOf('<div class="sidebar-footer">'), html.indexOf('</aside>'));
    expect(footer).toMatch(/^<div class="sidebar-footer"><button type="button" class="nav-item"><svg[^]*?<\/svg><span class="nav-label">Settings<\/span><\/button>/);
    expect(footer).not.toContain('nav-soon');
    expect(text(footer)).toContain('built by Retronix');
  });

  it('brand: the CONDUIT logo and tagline', async () => {
    const { App } = await import('../App');
    const html = renderToStaticMarkup(<App />);
    expect(html).toMatch(/<img class="brand-mark" src="[^"]*logo[^"]*\.png"/);
    expect(html).not.toContain('crown');
    expect(text(html)).toContain('CONDUIT The Link Between Everything.');
  });


  it('the planned page (if reached) shows a gray Soon badge and no controls', async () => {
    const { SECTIONS } = await import('../sections');
    const { PlannedPage } = await import('../pages/app/PlannedPage');
    for (const id of ['youtube-moderation', 'twitch-notifications']) {
      const html = renderToStaticMarkup(<PlannedPage section={SECTIONS.find((s) => s.id === id)!} />);
      expect(html).toContain('class="badge badge-soon"');
      expect(text(html)).toMatch(/no permissions are requested/);
      expect(html).not.toMatch(/<button|<input|<select|<table/);
    }
  });
});

describe('Kick Moderation page', () => {
  it('has two sections: Automated Protection and Logs (no chat messages)', async () => {
    const { html } = await renderKick(kick());
    expect(sections(html)).toEqual(['Automated Protection', 'Logs']);
  });

  it('has no manual moderation: no Take Action, lookup, Moderate, timeout/ban buttons or confirmations', async () => {
    const { html, t } = await renderKick(kick());
    expect(t).not.toMatch(/Take action|Look up|\bModerate\b|Confirm|Kick user(?!names)/i);
    expect(html).not.toMatch(/role="radiogroup"|alertdialog/);
    // Only Configure on each protection row (the settings open below it).
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(Array(5).fill('Configure')); // blocked words, links, spam checks, raid mode, ignored users
  });

  it('empty states without account status (that is shown on the Dashboard only)', async () => {
    let { t } = await renderKick(kick({ connected: false, problem: 'Connect your main Kick account (Dashboard → Kick) to monitor and protect Kick chat.' }));
    expect(t).not.toContain('Connect your main Kick account');
    ({ t } = await renderKick(kick({ chat: { status: 'disconnected', problem: null } })));
    expect(t).not.toMatch(/Not receiving chat|isn’t connected/);
    expect(t).toContain('Nothing logged yet.');
  });

  it('shows which rules are on and what each does; off and log-only by default; unavailable actions say why', async () => {
    const { ruleSummary } = await import('../pages/community/ModerationPage');
    const on = { ...structuredClone(AUTOMOD_DEFAULTS), enabled: true };
    expect(ruleSummary(AUTOMOD_DEFAULTS, 'repeat')).toEqual({ text: 'Off', tone: 'muted' });
    expect(ruleSummary(on, 'repeat')).toEqual({ text: 'Log only', tone: 'info' });
    expect(ruleSummary(on, 'blockedTerms').text).toBe('No words yet');
    expect(ruleSummary({ ...on, spam: { ...on.spam, action: 'timeout', timeoutMinutes: 3 } }, 'spam').text).toBe('Times out for 3 min');
    expect(ruleSummary({ ...on, repeat: { ...on.repeat, action: 'delete_message' } }, 'repeat').text).toBe('Deletes the message');

    const automod = { ...kick().automod, kickActions: { log: yes, timeout: yes, delete_message: no('Your main Kick account hasn’t granted “moderation:chat_message:manage”.') } };
    const { html, t } = await renderKick(kick({ automod }));
    // Like Discord Bot → Protection: a row per check with what it does, its status, a switch and Configure.
    expect(t).toMatch(
      /Blocked words and phrases Messages with words, phrases or patterns from your list\. Off Configure Links Links, except to sites you allow\. Off Configure Spam checks Caps, emote and symbol spam, long messages, repeats and flooding\. Off Configure Raid mode When many first-time chatters arrive at once, CONDUIT is stricter with them for a few minutes\. Off Configure Ignored users People the checks skip\. You and the chatbot are always skipped\. Moderators Configure/,
    );
    for (const r of ['Blocked words and phrases', 'Links', 'Raid mode']) expect(html).toContain(`aria-label="${r} `);
    // The spam checks are one row (no switch of its own; each check has one in its table).
    expect(html).not.toContain('aria-label="Spam checks');
    expect(html).not.toContain('protection-panel');
    expect(t).toContain('Delete the message: Your main Kick account hasn’t granted “moderation:chat_message:manage”.');
    expect(html).toMatch(/<input type="checkbox"[^>]*\/>\s*<span>Off<\/span>/);
    // Configure opens that check's settings below its row.
    const { AutomodCard } = await import('../pages/community/ModerationPage');
    const spam = renderToStaticMarkup(<AutomodCard automod={automod} kickConnected initialOpen="spamChecks" />);
    expect(spam.match(/protection-panel/g)).toHaveLength(1);
    expect(spam).toMatch(/<option value="delete_message" disabled="">Delete the message \(unavailable\)<\/option>/);
    // One table: each spam check with its switch, what it matches and what it does.
    expect(text(spam)).toMatch(
      /Spam checks .* Close On \/ off Check Matches when Then Excessive caps % capitals, in messages with at least letters .* Emote spam More than emotes .* Symbol spam .* Long messages More than characters .* Repeated messages The same message times within s .* Message flooding More than messages within s .* Save/,
    );
    for (const c of ['Excessive caps', 'Emote spam', 'Symbol spam', 'Long messages']) expect(spam).toContain(`aria-label="${c} off"`);
    for (const c of ['Repeated messages', 'Message flooding']) expect(spam).toContain(`aria-label="${c} on"`); // on (log only) by default
    expect(spam).toMatch(/aria-label="Repeats"[^>]*value="3"|value="3"[^>]*aria-label="Repeats"/);
    const { spamSummary } = await import('../pages/community/ModerationPage');
    const enabled = { ...structuredClone(AUTOMOD_DEFAULTS), enabled: true };
    expect(spamSummary(AUTOMOD_DEFAULTS)).toEqual({ text: 'Off', tone: 'muted' });
    expect(spamSummary(enabled)).toEqual({ text: '2 of 6 on', tone: 'info' }); // repeats and flooding, log only
    expect(spamSummary({ ...enabled, caps: { ...enabled.caps, enabled: true, action: 'delete_message' } })).toEqual({ text: '3 of 6 on', tone: 'warn' });
    const ignored = text(renderToStaticMarkup(<AutomodCard automod={automod} kickConnected initialOpen="ignored" />));
    expect(ignored).toMatch(/Ignored users .* Close Kick usernames, one per line Ignore moderators Save/);
  });

  it('raid mode: its row says whether it’s learning, watching or on; its panel explains what Kick doesn’t allow and can start it now', async () => {
    const { raidSummary, AutomodCard } = await import('../pages/community/ModerationPage');
    const s = { ...structuredClone(AUTOMOD_DEFAULTS), enabled: true, raid: { ...AUTOMOD_DEFAULTS.raid, enabled: true } };
    expect(raidSummary(AUTOMOD_DEFAULTS, { activeUntil: null, learning: false, knownChatters: 0 }).text).toBe('Off');
    expect(raidSummary(s, { activeUntil: null, learning: true, knownChatters: 3 }).text).toBe('Learning your regulars');
    expect(raidSummary(s, { activeUntil: null, learning: false, knownChatters: 90 }).text).toBe('Watching');
    expect(raidSummary(s, { activeUntil: '2026-10-11T18:05:00.000Z', learning: false, knownChatters: 90 }).text).toMatch(/^On until /);
    const automod = { ...kick().automod, kick: s };
    const t = text(renderToStaticMarkup(<AutomodCard automod={automod} kickConnected initialOpen="raid" />));
    expect(t).toMatch(/Raid mode .* Learning your regulars Close Starts when people chat for the first time within seconds, and lasts minutes/);
    expect(t).toContain('Kick doesn’t let apps change its chat modes (like slow or followers-only), so CONDUIT doesn’t.');
    expect(t).toContain('(3 chatters so far)');
    expect(t).toMatch(/Then Delete the message Timeout the user.* The chatbot says, when raid mode starts/);
    expect(t).toContain('Start raid mode now');
  });

  it('blocked words: words with wildcards, patterns and allowed words; links: allowed sites', async () => {
    const { AutomodCard } = await import('../pages/community/ModerationPage');
    const words = text(renderToStaticMarkup(<AutomodCard automod={kick().automod} kickConnected initialOpen="blockedTerms" />));
    expect(words).toMatch(/Words and phrases, one per line \(\* as a wildcard\) Regular expressions, one per line \(up to 10\) .* cat\* words starting with it,.* Allowed words/);
    const links = text(renderToStaticMarkup(<AutomodCard automod={kick().automod} kickConnected initialOpen="links" />));
    expect(links).toMatch(/Allowed sites, one per line \(their subdomains too\) kick\.com/);
  });

  it('logs: bans and timeouts done on Kick say who did them; names can be selected for their history; a missing ban subscription says so', async () => {
    const { html, t } = await renderKick(
      kick({
        history: [rec({ source: 'platform', action: 'ban', durationSeconds: null, actor: 'ModAlice', rule: null, targetName: 'raider', targetUserId: '77' })],
        automod: { ...kick().automod, kickModerationEvents: { ok: false, problem: 'Kick didn’t accept the ban and timeout subscription, so moderation done on Kick itself isn’t in the Logs.' } },
      }),
    );
    expect(t).toMatch(/Ban raider On Kick by ModAlice/);
    expect(html).toContain('<button type="button" class="link-button">raider</button>');
    expect(t).toContain('Select a name to see everything for that person.');
    expect(t).toContain('Kick didn’t accept the ban and timeout subscription');
  });

  it('logs separate what was detected from what was done or failed', async () => {
    const { t } = await renderKick(
      kick({
        history: [
          rec({ action: 'flag', outcome: 'logged', durationSeconds: null, rule: 'blocked_terms', detail: 'Matched a blocked word or phrase.' }),
          rec({ action: 'delete_message', outcome: 'failed', durationSeconds: null, rule: 'spam', detail: 'Kick couldn’t find that message.' }),
          rec({}),
        ],
      }),
    );
    expect(t).toMatch(/None \(log only\) viewer1 Blocked words and phrases.* Detected only .*Matched a blocked word/);
    expect(t).toMatch(/Delete message viewer1 Message flooding Failed .*Kick couldn’t find that message\./);
    expect(t).toMatch(/Timeout · 10 min viewer1 Repeated messages retrolive/);
  });
});

describe('Discord Moderation page', () => {
  it('shows the moderation log; no Kick settings, no manual actions', async () => {
    const { html, t } = await renderDiscord(discord());
    expect(sections(html)).toEqual(['Moderation log']);
    expect(t).not.toMatch(/Blocked words|Repeated messages|Recent Kick Chat|Take action|Look up/);
    expect(html).not.toContain('<button');
  });

  it('logs show the command and who ran it, the target, reason and Discord’s answer', async () => {
    const { t } = await renderDiscord(
      discord({
        history: [
          rec({ platform: 'discord', place: 'Retro Server', source: 'manual', rule: null, actor: 'retrofan via /ban', action: 'ban', durationSeconds: null, reason: 'Raid', outcome: 'failed', detail: 'Discord refused: the bot is missing a permission.', targetName: 'fan' }),
          rec({ platform: 'discord', place: 'Retro Server', source: 'manual', rule: null, actor: 'retrofan via /timeout', targetName: 'fan', reason: 'Spam' }),
        ],
      }),
    );
    expect(t).toMatch(/Ban Raid fan \/ban by retrofan Failed Retro Server Discord refused/);
    expect(t).toMatch(/Timeout · 10 min Spam fan \/timeout by retrofan Retro Server/);
  });

  it('lists the moderation commands and which permission the bot still needs', async () => {
    const { t } = await renderDiscord(discord());
    expect(t).toMatch(/Commands: \/timeout ?, \/untimeout ?, \/kick ?, \/ban ?, \/unban/);
    expect(t).toContain('In Retro Server the bot still needs Kick Members and Ban Members (Server Settings → Roles).');
    const all = await renderDiscord(discord({ commands: discord().commands.map((c) => ({ ...c, missingIn: [] })) }));
    expect(all.t).toContain('In Retro Server the bot has the permissions it needs.');
    const off = await renderDiscord(discord({ connected: false, problem: 'Set up your Discord bot first (Dashboard → Discord → Connect).', guilds: [] }));
    expect(off.t).not.toContain('Set up your Discord bot first'); // account status: Dashboard only
  });
});

describe('Discord Bot page tabs', () => {
  const render = async (tab: 'bot' | 'protection' | 'logs') => {
    const { DiscordBotView } = await import('../pages/community/ModerationPage');
    return renderToStaticMarkup(<DiscordBotView tab={tab} onTab={() => {}} />);
  };

  it('three tabs — Settings, Protection, Logs — with the chosen one selected', async () => {
    const html = await render('protection');
    const tabs = [...html.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([
      ['Settings', 'false'],
      ['Protection', 'true'],
      ['Logs', 'false'],
    ]);
    expect(html).toContain('aria-label="Discord bot"');
    expect(html).toContain('id="discord-bot-panel-protection"');
  });

  it('each tab shows only its own sections (and loads only its own data)', async () => {
    expect(text(await render('bot'))).toContain('Loading the bot’s status…'); // Status Updates and Rich Presence Updates
    expect(text(await render('logs'))).toContain('Loading Discord logging…');
    for (const tab of ['bot', 'protection'] as const) expect(text(await render(tab))).not.toContain('Discord logging');
  });

  it('the sidebar calls it Discord Bot (same page id, so remembered pages and links keep working)', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.find((s) => s.id === 'discord-moderation')!.label).toBe('Discord Bot');
  });
});

describe('Discord Bot → Logs: moderation log', () => {
  it('merges CONDUIT’s commands with Discord’s buttons, other bots and AutoMod, newest first', async () => {
    const { DiscordCommandLog } = await import('../pages/community/ModerationPage');
    const server = (over: Partial<import('@conduit/shared/community/moderation').DiscordServerModerationView>) => ({
      id: crypto.randomUUID(),
      at: '2026-10-18T12:00:00Z',
      place: 'Retro Server',
      action: 'ban' as const,
      targetUserId: '900000000000000031',
      targetName: 'troll',
      via: 'discord' as const,
      by: 'modbrad',
      reason: null,
      ruleName: null,
      until: null,
      ...over,
    });
    const s = discord({
      serverHistory: [
        server({ at: '2026-10-18T12:03:00Z', action: 'automod_block', via: 'automod', by: null, ruleName: 'Block invite links' }),
        server({ at: '2026-10-18T12:01:00Z', action: 'kick', via: 'bot', by: 'OtherBot' }),
        server({ at: '2026-10-18T12:00:00Z', action: 'ban', reason: 'Spam' }),
      ],
    });
    const t = text(renderToStaticMarkup(<DiscordCommandLog s={s} />));
    expect(t).toContain('Moderation log');
    expect(t).toMatch(/Message blocked troll AutoMod: Block invite links.* Kick troll By OtherBot \(bot\).* Ban Spam troll In Discord by modbrad/);
  });

  it('includes what CONDUIT protection noticed or did, with Discord’s answer', async () => {
    const { DiscordCommandLog } = await import('../pages/community/ModerationPage');
    const p = (over: Partial<DiscordModerationState['protectionHistory'][number]>): DiscordModerationState['protectionHistory'][number] => ({
      id: Math.random().toString(),
      at: '2026-10-18T12:00:00Z',
      place: 'Retro Server',
      feature: 'message',
      rule: 'repeat',
      userId: '9',
      userName: 'troll',
      action: 'timeout',
      outcome: 'success',
      detail: 'Sent the same message 3 times within 30 s. Timed out for 5 min.',
      ...over,
    });
    const s = discord({
      protectionHistory: [
        p({ at: '2026-10-18T12:02:00Z', rule: 'invites', action: 'delete_message', outcome: 'failed', detail: 'Posted a Discord invite link. Discord refused.' }),
        p({ at: '2026-10-18T12:01:00Z', rule: 'caps', action: 'log', outcome: 'logged', detail: '100% capital letters.' }),
        p({}),
      ],
    });
    const t = text(renderToStaticMarkup(<DiscordCommandLog s={s} />));
    const anti = text(
      renderToStaticMarkup(
        <DiscordCommandLog
          s={discord({
            protectionHistory: [
              p({ feature: 'antinuke', rule: 'channel_delete', action: 'quarantine', detail: '3 channels deleted within 60 s.' }),
              p({ at: '2026-10-18T11:00:00Z', feature: 'antinuke', rule: 'ban', action: 'alert', outcome: 'logged', detail: '5 members banned within 60 s.' }),
            ],
          })}
        />,
      ),
    );
    const raid = text(
      renderToStaticMarkup(
        <DiscordCommandLog
          s={discord({
            protectionHistory: [
              p({ feature: 'antiraid', rule: 'join_burst', action: 'lockdown', detail: '10 members joined within 10 s.' }),
              p({ at: '2026-10-18T11:00:00Z', feature: 'joingate', rule: 'gate', action: 'hold', detail: 'No profile picture.' }),
            ],
          })}
        />,
      ),
    );
    const bait = text(
      renderToStaticMarkup(
        <DiscordCommandLog s={discord({ protectionHistory: [p({ feature: 'botbait', rule: 'trap', action: 'softban', detail: 'Posted in the bait channel #do-not-post.' })] })} />,
      ),
    );
    expect(bait).toMatch(/Softban \(ban and unban: wipes their recent messages\) .*Bot bait.*Posted in the bait channel #do-not-post\./);
    expect(raid).toMatch(/Lockdown .*Anti-raid: Join burst.* Held .*Join gate.*No profile picture\./);
    expect(anti).toMatch(/Quarantine \(remove their roles\) .*Anti-nuke: Channels deleted.* None \(alert only\) .*Anti-nuke: Members banned.* Detected only/);
    expect(t).toMatch(
      /Delete the message troll Protection: Invite links Failed Retro Server Posted a Discord invite link\. Discord refused\. .* None \(log only\) troll Protection: Excessive caps Detected only .*100% capital letters\. .* Delete and time out troll Protection: Repeated messages Retro Server Sent the same message 3 times/,
    );
  });
});

describe('Moderation log: Discord Logging entries', () => {
  it('lists what Discord Logging posted, with the category and whether it was posted', async () => {
    const { DiscordCommandLog } = await import('../pages/community/ModerationPage');
    const entry = (over: Partial<DiscordModerationState['loggingHistory'][number]>): DiscordModerationState['loggingHistory'][number] => ({
      id: Math.random().toString(),
      at: '2026-10-20T12:00:00Z',
      place: 'Retro Server',
      category: 'messages',
      event: 'delete',
      title: 'Message deleted',
      userId: '9',
      userName: 'troll',
      detail: 'In #general · Text unavailable',
      posted: true,
      ...over,
    });
    const s = discord({ loggingHistory: [entry({}), entry({ at: '2026-10-20T11:00:00Z', category: 'members', title: 'Member joined', posted: false, detail: null })] });
    const t = text(renderToStaticMarkup(<DiscordCommandLog s={s} />));
    expect(t).toMatch(/Messages log troll Message deleted Retro Server In #general · Text unavailable .* Members log troll Member joined Not posted Retro Server/);
    expect(t).toContain('everything Discord Logging posts');
  });
});

describe('Moderation log: Loyalty & Rewards', () => {
  it('lists points changes, XP adjustments and settings changes, with the member’s name and ID and the server', async () => {
    const { DiscordCommandLog } = await import('../pages/community/ModerationPage');
    const s = discord({
      loyaltyHistory: [
        { id: 'p1', at: '2026-10-20T12:00:00Z', title: 'Points adjusted', place: null, userId: '123456789012345678', userName: 'member', change: '+2 points · balance 2', reason: 'test', detail: null },
        { id: 'x1', at: '2026-10-20T11:00:00Z', title: 'XP adjusted', place: 'Retro Server', userId: '901', userName: null, change: '−20 XP · level 3', reason: 'spam', detail: null },
        { id: 's1', at: '2026-10-20T10:00:00Z', title: 'Loyalty settings saved', place: 'Retro Server', userId: null, userName: null, change: null, reason: null, detail: 'enabled: true' },
      ],
    });
    const t = text(renderToStaticMarkup(<DiscordCommandLog s={s} />));
    expect(t).toMatch(/Points adjusted member 123456789012345678 \+2 points · balance 2 test/);
    expect(t).toMatch(/XP adjusted 901 −20 XP · level 3 Retro Server spam/);
    expect(t).toMatch(/Loyalty settings saved — Retro Server enabled: true/);
    expect(t).toContain('and Loyalty &amp; Rewards');
  });
});

describe('log pages', () => {
  it('shows 5 rows per page with Prev, page numbers and Next under the log; nothing when it all fits', async () => {
    const { DiscordCommandLog } = await import('../pages/community/ModerationPage');
    const entry = (i: number) => ({
      id: `l${i}`,
      at: `2026-10-20T${String(10 + i).padStart(2, '0')}:00:00Z`,
      title: `Change ${i}`,
      place: null,
      userId: null,
      userName: null,
      change: null,
      reason: null,
      detail: null,
    });
    const html = renderToStaticMarkup(<DiscordCommandLog s={discord({ loyaltyHistory: Array.from({ length: 12 }, (_, i) => entry(i)) })} />);
    expect(html.match(/<tr>/g)).toHaveLength(1 + 5); // header + 5 rows
    const t = text(html);
    expect(t).toMatch(/Change 11 .*Change 7/); // newest first
    expect(t).not.toContain('Change 6');
    expect(t).toMatch(/1–5 of 12 ‹ Prev 1 2 3 Next ›/);
    expect(html).toContain('aria-current="page"');
    const few = renderToStaticMarkup(<DiscordCommandLog s={discord({ loyaltyHistory: [entry(1), entry(2)] })} />);
    expect(few).not.toContain('class="pager"');
  });

  it('page numbers keep the first, the last and the ones around the current page', async () => {
    const { pageNumbers } = await import('../components/Pager');
    expect(pageNumbers(0, 3)).toEqual([0, 1, 2]);
    expect(pageNumbers(5, 10)).toEqual([0, null, 4, 5, 6, null, 9]);
    expect(pageNumbers(9, 10)).toEqual([0, null, 8, 9]);
  });
});
