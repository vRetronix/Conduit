// Timed Messages, Sticky Messages, Discord Logging, Kick Notifications and the embed editor, rendered from backend
// state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import { DEFAULT_LOGGING_SETTINGS, type LoggingState } from '@conduit/shared/discord/discord-logging';
import { EMPTY_EMBED } from '@conduit/shared/discord/embeds';
import type { StickyMessagesState } from '@conduit/shared/discord/sticky-messages';
import { DEFAULT_NOTIFICATION_EMBED, type StreamNotificationsState } from '@conduit/shared/kick/stream-notifications';
import type { TimedMessagesState } from '@conduit/shared/community/timed-messages';
import type { KickClipsState } from '@conduit/shared/kick/kick-clips';

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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('Timed Messages page', () => {
  const state = (over: Partial<TimedMessagesState> = {}): TimedMessagesState => ({
    timedMessages: [],
    kick: { ready: true, problem: null, channel: 'retronix' },
    discord: { ready: true, problem: null, messageEvents: true },
    ...over,
  });

  it('empty state and New button', async () => {
    const { TimedMessagesView } = await import('../pages/community/TimedMessagesPage');
    const t = text(renderToStaticMarkup(<TimedMessagesView s={state()} />));
    expect(t).toContain('No timed messages yet.');
    expect(t).toContain('New timed message');
  });

  it('shows schedule, destination, on/off and the latest result for each', async () => {
    const { TimedMessagesView } = await import('../pages/community/TimedMessagesPage');
    const html = renderToStaticMarkup(
      <TimedMessagesView
        s={state({
          timedMessages: [
            {
              platform: 'discord',
              id: 't1',
              name: 'Socials',
              enabled: true,
              guildId: '42',
              channelId: '5',
              message: { content: 'Follow us!', embed: null },
              intervalMinutes: 30,
              messageCount: 20,
              combine: 'all',
              createdAt: 'x',
              updatedAt: 'x',
              lastSentAt: '2026-10-13T18:00:00.000Z',
              messagesSince: 7,
              nextDueAt: null,
              recent: [{ at: '2026-10-13T18:00:00.000Z', ok: true, reason: 'both', detail: 'Posted in Discord.' }],
              destination: '#general in Retro Server',
              problem: null,
            },
            {
              platform: 'kick',
              id: 't2',
              name: 'Hydrate',
              enabled: false,
              content: 'Drink water!',
              intervalMinutes: null,
              messageCount: 50,
              combine: 'all',
              createdAt: 'x',
              updatedAt: 'x',
              lastSentAt: null,
              messagesSince: 0,
              nextDueAt: null,
              recent: [],
              destination: 'retronix’s Kick chat',
              problem: null,
            },
          ],
        })}
      />,
    );
    const t = text(html);
    expect(t).toMatch(/Socials → #general in Retro Server every 30 minutes, once there were at least 20 chat messages Follow us!/);
    expect(t).toMatch(/Posted 7\/20 messages Edit Duplicate Delete…/);
    expect(t).toMatch(/Hydrate → retronix’s Kick chat after 50 chat messages Drink water! Not posted yet/);
    expect(html).toMatch(/aria-label="Hydrate: off"/);
  });
});

describe('Sticky Messages page', () => {
  it('explains how reposting works and what the bot needs; shows each sticky’s channel and status', async () => {
    const { StickyMessagesView } = await import('../pages/discord/StickyMessagesPage');
    const s: StickyMessagesState = {
      stickies: [
        {
          id: 's1',
          name: 'Rules',
          enabled: true,
          guildId: '42',
          channelId: '5',
          message: { content: 'Read the rules', embed: null },
          cooldownSeconds: 15,
          messagesBeforeRepost: 1,
          createdAt: 'x',
          updatedAt: 'x',
          postedMessageId: '9',
          lastPostedAt: null,
          destination: '#general in Retro Server',
          status: 'problem',
          problem: 'The bot is missing a permission in that channel.',
          recent: [],
        },
      ],
      discord: { ready: true, problem: null, messageEvents: true },
    };
    const t = text(renderToStaticMarkup(<StickyMessagesView s={s} />));
    expect(t).toMatch(/Your stickies When people post, each one moves back to the bottom: the bot posts a fresh copy and deletes the old one./);
    expect(t).not.toMatch(/No privileged intent|Read Message History|Discord can’t pin/);
    expect(t).toMatch(/Rules in #general in Retro Server Moves to the bottom after each message from people, at most every 15 s/);
    expect(t).toMatch(/Needs attention/);
  });
});

describe('Discord Logging page', () => {
  it('five categories with destinations and event toggles; privileged intents explained, never assumed', async () => {
    const { DiscordLoggingView } = await import('../pages/discord/DiscordLoggingPage');
    const s: LoggingState = {
      settings: { ...structuredClone(DEFAULT_LOGGING_SETTINGS), guildId: '42' },
      availability: {
        moderation: { available: false, problem: 'The bot needs View Audit Log in this server to see bans, kicks and timeouts.', partial: null },
        members: { available: false, problem: 'Turn on “Server Members Intent” on the Bot page…', partial: null },
        messages: { available: true, problem: null, partial: 'Message text isn’t available (privileged Message Content intent off).' },
        server: { available: true, problem: null, partial: null },
        loyalty: { available: true, problem: null, partial: 'Loyalty & Rewards is off, so there’s nothing to log until it’s switched on.' },
      },
      intents: { members: { portal: false, inUse: false }, messageContent: { portal: true, inUse: false }, presences: { portal: true, inUse: true } },
      auditLogAccess: false,
      discord: { ready: true, problem: null },
    };
    const html = renderToStaticMarkup(<DiscordLoggingView s={s} />);
    const t = text(html);
    // One panel: Save is inside it; no separate "Recently logged" list (entries are in the Moderation log).
    expect(html.match(/<section class="card"/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="form-actions"><button type="button"[^>]*disabled=""[^>]*>Save<\/button><\/div><\/section>$/);
    expect(t).not.toContain('Recently logged');
    expect(t).toContain('Everything logged is also listed in the Moderation log below.');
    for (const c of ['Moderation', 'Members', 'Messages', 'Server & roles', 'XP & Loyalty']) expect(t).toContain(c);
    for (const e of ['Bans', 'Timeouts', 'Joins', 'Deleted messages', 'Edited messages', 'Channels created, deleted or changed']) expect(t).toContain(e);
    for (const e of ['Level-ups', 'XP adjustments', 'Points adjustments', 'Rewards redeemed', 'Redemptions fulfilled or rejected', 'Level roles given (or refused)', 'Resets (a member, or the leaderboard)']) expect(t).toContain(e);
    expect(t).toContain('Loyalty & Rewards is off, so there’s nothing to log until it’s switched on.');
    expect(t).toContain('needs View Audit Log');
    // The privileged intents are required, not optional: no "Privileged information" panel or opt-in switches.
    expect(t).not.toMatch(/Privileged information|Privileged intents/);
    expect(html).not.toContain('Server Members intent)');
    expect(html).toMatch(/<input type="checkbox"[^>]*\/> Failed CONDUIT commands/); // off by default
  });
});

describe('Kick Notifications page', () => {
  it('lists streamers with live status and what happened; explains how live status is read', async () => {
    const { KickNotificationsView } = await import('../pages/kick/KickNotificationsPage');
    const s: StreamNotificationsState = {
      notifiers: [
        {
          platform: 'kick',
          channel: 'retronix',
          enabled: true,
          guildId: '42',
          channelId: '5',
          roleId: null,
          content: '',
          embed: DEFAULT_NOTIFICATION_EMBED,
          buttons: [{ label: 'Watch {streamer} on Kick!', url: '{url}' }],
          deleteWhenEnded: true,
          id: 'n1',
          createdAt: 'x',
          updatedAt: 'x',
          displayName: 'Retronix',
          avatarUrl: null,
          live: true,
          liveSince: null,
          title: 'Speedruns',
          category: 'Retro Games',
          lastCheckedAt: null,
          messageId: '1',
          lastNotifiedAt: null,
          status: 'Live — notification posted.',
          problem: null,
          destination: '#live-alerts in Retro Server',
        },
      ],
      kick: { ready: true, problem: null, pollSeconds: 60 },
      discord: { ready: true, problem: null },
    };
    const t = text(renderToStaticMarkup(<KickNotificationsView s={s} />));
    expect(t).toMatch(/Retronix kick.com\/retronix → #live-alerts in Retro Server “Speedruns” · Retro Games Live — notification posted\. · deleted when the stream ends Live/);
    expect(t).toContain('checks Kick every 60 seconds');
    expect(t).toContain('no rights over other channels');
  });
});

describe('Kick notification preview', () => {
  it('the default (Retronix) layout: @Role + announcement, stream title heading, Category and Viewers, large thumbnail, footer, link buttons; sample data labelled', async () => {
    const { EmbedPreview } = await import('../components/discord/EmbedEditor');
    const { DEFAULT_NOTIFICATION_CONTENT, DEFAULT_NOTIFICATION_BUTTONS } = await import('@conduit/shared/kick/stream-notifications');
    const html = renderToStaticMarkup(
      <EmbedPreview
        embed={DEFAULT_NOTIFICATION_EMBED}
        vars={{ streamer: 'StreamerName', title: 'Example stream title', category: 'Example category', viewers: '0', url: 'https://kick.com/streamername', thumbnail: 'https://kick.com/sample-thumbnail', avatar: 'https://kick.com/sample-avatar' }}
        content={DEFAULT_NOTIFICATION_CONTENT}
        mention="@Live Pings"
        buttons={DEFAULT_NOTIFICATION_BUTTONS}
        note="Sample data (stream title, category, images). Real notifications use Kick’s live data for this streamer."
        imageLabels={{ image: 'Stream thumbnail (from Kick, when live)', thumb: 'Profile' }}
      />,
    );
    const t = text(html);
    expect(t).toMatch(/@Live Pings Live now! StreamerName is streaming on Kick!/);
    expect(t).toMatch(/Example stream title Category Example category Viewers 0 Stream thumbnail \(from Kick, when live\)/);
    expect(t).toContain('kick.com/StreamerName');
    expect(t).toContain('Watch StreamerName on Kick!');
    expect(t).toContain('Sample data');
    expect(html).toContain('dp-img dp-img-image'); // the large image, not only the small thumbnail
    expect(html).toContain('dp-img dp-img-thumb');
  });

  it('the sample stream thumbnail shows the bundled example picture; any other image link keeps its placeholder', async () => {
    const { EmbedPreview } = await import('../components/discord/EmbedEditor');
    const vars = { streamer: 'S', title: 't', category: 'c', url: 'https://kick.com/s', thumbnail: 'https://kick.com/sample-thumbnail', avatar: 'https://kick.com/sample-avatar' };
    const samples = { 'https://kick.com/sample-thumbnail': '/assets/thumbnail-example.png' };
    const html = renderToStaticMarkup(
      <EmbedPreview embed={DEFAULT_NOTIFICATION_EMBED} vars={vars} imageLabels={{ image: 'Stream thumbnail (from Kick, when live)', thumb: 'Profile' }} imageSamples={samples} />,
    );
    expect(html).toContain('<img class="dp-img dp-img-image dp-img-sample" src="/assets/thumbnail-example.png" alt="Stream thumbnail (from Kick, when live)"');
    expect(html).toContain('<span class="dp-img dp-img-thumb"'); // the profile picture is still a placeholder
    const custom = renderToStaticMarkup(
      <EmbedPreview embed={{ ...DEFAULT_NOTIFICATION_EMBED, imageUrl: 'https://example.com/banner.png' }} vars={vars} imageSamples={samples} />,
    );
    expect(custom).not.toContain('dp-img-sample');
    expect(custom).not.toContain('<img');
  });

  it('the page offers Add streamer', async () => {
    const { KickNotificationsView } = await import('../pages/kick/KickNotificationsPage');
    // Opening the editor needs state; render the view and check the static parts of the page instead.
    const t = text(renderToStaticMarkup(<KickNotificationsView s={{ notifiers: [], kick: { ready: true, problem: null, pollSeconds: 60 }, discord: { ready: true, problem: null } }} />));
    expect(t).toContain('Add streamer');
  });
});

describe('Embed editor', () => {
  it('edits every part, shows Discord’s limits, a Discord-style preview with variables filled, and image placeholders (no remote loads)', async () => {
    const { EmbedEditor } = await import('../components/discord/EmbedEditor');
    const html = renderToStaticMarkup(
      <EmbedEditor
        value={{ ...EMPTY_EMBED, title: '{streamer} is live', description: 'Come hang out', fields: [{ name: 'Game', value: '{category}', inline: true }], imageUrl: 'https://images.kick.com/x.webp', color: '#53FC18', timestamp: true }}
        onChange={() => {}}
        variables={{ streamer: 'Name', category: 'Game' }}
        previewVars={{ streamer: 'Retronix', category: 'Retro Games' }}
      />,
    );
    const t = text(html);
    for (const l of ['Author', 'Title', 'Title link', 'Description', 'Fields (1/25)', 'Thumbnail URL', 'Image URL', 'Footer', 'Color', 'Show the time it’s posted']) expect(t).toContain(l);
    expect(t).toContain('18/256'); // title length vs Discord's limit
    expect(t).toMatch(/Retronix is live Come hang out Game Retro Games Image from images\.kick\.com Today at 12:00/);
    expect(html).not.toMatch(/<img[^>]+src="https:/);
    expect(t).toMatch(/Variables: \{streamer\} , \{category\}/);
    expect(t).toContain('Save to library');
  });

  it('shows validation problems before anything is sent', async () => {
    const { EmbedEditor } = await import('../components/discord/EmbedEditor');
    const t = text(renderToStaticMarkup(<EmbedEditor value={{ ...EMPTY_EMBED, title: 'x'.repeat(300), url: 'not a link' }} onChange={() => {}} />));
    expect(t).toContain('Title: at most 256 characters');
    expect(t).toContain('Use an http(s) link');
  });
});

describe('Kick → Clips page', () => {
  const FOLDER = 'C:\\Users\\Me\\Videos\\CONDUIT Clips';
  const state = (over: Partial<KickClipsState> = {}): KickClipsState => ({
    channel: { slug: 'retrolive', name: 'RetroLive' },
    settings: { guildId: null, channelId: null, autoPost: false, folder: null },
    folder: FOLDER,
    clips: [],
    lastCheck: { at: '2026-10-24T12:00:00.000Z', problem: null },
    ...over,
  });
  const clipView: KickClipsState['clips'][number] = {
    id: 'clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY',
    title: 'Great play',
    creatorName: 'BigFan',
    category: 'Just Chatting',
    durationSeconds: 75,
    views: 12,
    thumbnailUrl: null,
    url: 'https://kick.com/retrolive/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY',
    createdAt: '2026-10-24T11:00:00.000Z',
    saved: null,
    posted: null,
    postProblem: null,
  };

  it('sits in the Kick group of the sidebar', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.find((s) => s.id === 'kick-clips')).toMatchObject({ label: 'Clips', group: 'kick', phase: null });
  });

  it('has its own sidebar icon (a clapperboard), like every section — none falls back to the plain square', async () => {
    const { SECTIONS } = await import('../sections');
    const { NavIcon } = await import('../components/NavIcon');
    const fallback = 'd="M3 3h10v10H3z"';
    expect(SECTIONS.filter((s) => renderToStaticMarkup(<NavIcon id={s.id} />).includes(fallback)).map((s) => s.id)).toEqual([]);
    expect(renderToStaticMarkup(<NavIcon id="kick-clips" />)).toContain('d="M2.5 7h11v6.5h-11zM2.5 4.5h11V7h-11z');
  });

  it('settings first, then the clips; empty or not connected says so', async () => {
    const { KickClipsView } = await import('../pages/kick/KickClipsPage');
    const empty = text(renderToStaticMarkup(<KickClipsView s={state()} />));
    expect(empty.indexOf('Clip settings')).toBeLessThan(empty.indexOf('No clips yet.'));
    expect(empty).toContain(`Saved clips go to ${FOLDER}`);
    expect(text(renderToStaticMarkup(<KickClipsView s={state({ channel: null })} />))).toContain('Connect your main Kick account first');
  });

  it('posts clips made with Kick’s own /clip (no !clip or kick.com login of CONDUIT’s own)', async () => {
    const { KickClipsView } = await import('../pages/kick/KickClipsPage');
    const out = text(renderToStaticMarkup(<KickClipsView s={state()} />));
    expect(out).toContain('Checked every 2 minutes, so clips made in chat with Kick’s /clip show up within a few minutes.');
    expect(out).toContain('each with its thumbnail and Watch stream and View clip on Kick buttons.');
    expect(out).not.toMatch(/!clip|Sign in|session_token/);
  });

  it('each clip: title, length, who and when, and its actions; no Discord or saved columns; posting needs a channel', async () => {
    const { KickClipsView } = await import('../pages/kick/KickClipsPage');
    const problem = 'Kick’s website refused the request (HTTP 403); try again in a few minutes.';
    const html = renderToStaticMarkup(<KickClipsView s={state({ clips: [clipView], lastCheck: { at: '2026-10-24T12:00:00.000Z', problem } })} />);
    const t = text(html);
    expect(t).toMatch(/Clips \(1\)/);
    expect(t).toMatch(/Great play 1:15 Clipped by BigFan · [^·]+ · Just Chatting · 12 views/);
    expect(t).toContain(problem);
    expect(t).toContain('Choose a Discord channel in Clip settings to post clips.');
    expect(html).toContain('title="Choose a Discord channel in Clip settings first" class="btn btn-secondary" disabled="">Post to Discord</button>');
    expect(t).toMatch(/Post to Discord Save/);
    expect(t).not.toMatch(/On this PC|Not posted|Not saved/);
    expect(html).not.toContain('<table');
  });
});
