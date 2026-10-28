// Giveaways page, rendered from backend state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import { KICK_GIVEAWAY_MESSAGE_DEFAULTS, type GiveawaysState, type GiveawayView } from '@conduit/shared/community/giveaways';

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

function giveaway(over: Partial<GiveawayView> = {}): GiveawayView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    prize: 'Steam key',
    description: null,
    status: 'open',
    winnerCount: 1,
    durationMinutes: null,
    platforms: ['kick', 'discord'],
    createdAt: '2026-10-11T18:00:00.000Z',
    updatedAt: '2026-10-11T18:00:00.000Z',
    startedAt: '2026-10-11T18:00:00.000Z',
    endsAt: null,
    closedAt: null,
    drawnAt: null,
    cancelledAt: null,
    entryCount: 0,
    entriesByPlatform: { kick: 0, discord: 0 },
    ticketCount: 0,
    subscriberMultiplier: 1,
    verifiedSubscribers: 0,
    kickReward: null,
    winners: [],
    draws: [],
    announcement: null,
    discord: null,
    ...over,
  };
}

const state = (giveaways: GiveawayView[], over: Partial<GiveawaysState> = {}): GiveawaysState => ({
  giveaways,
  entry: {
    kick: { command: '!enter', ready: true, note: null },
    discord: { command: '🎉 Enter Giveaway button', ready: false, note: 'The Discord bot is not connected, so the giveaway buttons don’t respond right now.' },
  },
  discordChannelDefault: null,
  kickRewards: { available: true, problem: null },
  kickMessages: { ...KICK_GIVEAWAY_MESSAGE_DEFAULTS },
  hiddenCancelled: 0,
  ...over,
});

async function render(s: GiveawaysState) {
  const { GiveawaysView } = await import('../pages/community/GiveawaysPage');
  return text(renderToStaticMarkup(<GiveawaysView s={s} />));
}

describe('Giveaways', () => {
  it('is in the navigation as an available section', async () => {
    const { SECTIONS } = await import('../sections');
    expect(SECTIONS.find((s) => s.id === 'giveaways')).toMatchObject({ label: 'Giveaways', phase: null });
  });

  it('two browser-style tabs, Giveaways and Messages; the Giveaways tab has the current one, then Completed (no hint at the bottom)', async () => {
    const t = await render(state([]));
    expect(t).toMatch(/^ ?Giveaways 0 Messages 6 New giveaway Current giveaway No giveaway is running\./);
    expect(t).toContain('Completed Completed giveaways stay here');
    expect(t).not.toMatch(/Drafts|Cancelled|How viewers enter|Start a giveaway/);
    expect(t).not.toContain('Viewers enter with');
    expect(t).not.toMatch(/Not ready|Ready/); // account status is shown on the Dashboard only
  });

  it('active: platforms, time remaining, status, private entry and ticket totals, and the management actions', async () => {
    const t = await render(
      state([
        giveaway({
          entryCount: 3,
          entriesByPlatform: { kick: 2, discord: 1 },
          ticketCount: 7,
          subscriberMultiplier: 2,
          verifiedSubscribers: 1,
          kickReward: { title: 'Bonus ticket', cost: 500, tickets: 1, rewardId: '01R', status: 'active', detail: null, accepted: 2, rejected: 1 },
        }),
      ]),
    );
    expect(t).toMatch(/Current giveaway Steam key Running/);
    expect(t).toContain('Entry on: Kick and Discord');
    expect(t).toContain('Time remaining: until you end entries');
    expect(t).toMatch(/Entries \(private\): 3 \(Kick 2 · Discord 1\) · Tickets: 7 · 2× for verified Kick subscribers \(1\)/);
    expect(t).toMatch(/Channel Points reward: “Bonus ticket” · 500 points for 1 bonus ticket · 2 accepted, 1 rejected · redeemable on Kick/);
    expect(t).toMatch(/End entries Draw winners Edit Cancel/);
  });

  it('completed giveaways stay visible with winners, completion time and the draw history (with private tickets)', async () => {
    const t = await render(
      state([
        giveaway({
          status: 'drawn',
          description: 'A game key',
          closedAt: '2026-10-11T18:30:00.000Z',
          drawnAt: '2026-10-11T18:40:00.000Z',
          entryCount: 4,
          ticketCount: 6,
          winners: [
            { id: 'w1', position: 1, platform: 'kick', platformUserId: '1', displayName: 'alice', status: 'replaced', drawId: 'd1', selectedAt: 'x', replacedAt: 'y' },
            { id: 'w2', position: 1, platform: 'discord', platformUserId: '2', displayName: 'bob', status: 'won', drawId: 'd2', selectedAt: 'y', replacedAt: null },
          ],
          draws: [
            { id: 'd1', kind: 'initial', drawnAt: '2026-10-11T18:40:00.000Z', poolSize: 4, poolTickets: 6, replacedWinnerId: null, reason: null },
            { id: 'd2', kind: 'redraw', drawnAt: '2026-10-11T18:45:00.000Z', poolSize: 3, poolTickets: null, replacedWinnerId: 'w1', reason: 'No reply' },
          ],
        }),
      ]),
    );
    // A one-line row (prize · when · entries · winners) that opens for the details.
    expect(t).toMatch(/Completed Steam key Oct 11, \d\d:40 [AP]M · 4 entries · bob A game key/);
    expect(t).toMatch(/· completed /);
    expect(t).toMatch(/Winners bob Discord #1 Redraw/);
    expect(t).not.toMatch(/alice Kick #1/);
    expect(t).toMatch(/Draw from 4 entries \(6 tickets\)/);
    expect(t).toMatch(/Redraw for #1 from 3 entries · replaced alice · “No reply”/);
    expect(t).not.toMatch(/End entries|Draw winners|Cancel and delete/);
    // A completed giveaway can be deleted (after confirming); a running one has Cancel instead.
    expect(t).toContain('Delete giveaway');
    expect(await render(state([giveaway({ status: 'open' })]))).not.toContain('Delete giveaway');
  });

  it('doesn’t list (or explain) cancelled giveaways kept from before', async () => {
    expect(await render(state([], { hiddenCancelled: 5 }))).not.toMatch(/cancelled/i);
  });

  it('completed giveaways come 5 to a page', async () => {
    const done = (i: number) => giveaway({ id: `g${i}`, prize: `Prize ${i}`, status: 'drawn', drawnAt: `2026-10-${String(10 + i).padStart(2, '0')}T18:40:00.000Z` });
    const t = await render(state(Array.from({ length: 7 }, (_, i) => done(i))));
    expect(t.match(/Prize \d/g)).toHaveLength(5);
    expect(t).toContain('1–5 of 7');
  });

  it('the Discord embed’s state, with an actionable error and Retry/Repost', async () => {
    const discord = { guildId: '42', channelId: '5', channelName: 'giveaways', messageId: '13', status: 'posted' as const, detail: null, updatedAt: null };
    const t = await render(
      state([
        giveaway({ id: crypto.randomUUID(), discord }),
        giveaway({ id: crypto.randomUUID(), status: 'closed', discord: { ...discord, status: 'failed', detail: 'The bot is missing permissions in #giveaways.' } }),
        giveaway({ id: crypto.randomUUID(), status: 'closed', discord: { ...discord, status: 'missing', detail: 'The announcement message was deleted.' } }),
      ]),
    );
    expect(t).toContain('Discord announcement: Posted in #giveaways');
    expect(t).toContain('Needs attention The bot is missing permissions in #giveaways. Retry');
    expect(t).toContain('Not found in Discord The announcement message was deleted. Repost announcement');
  });

  it('the new-giveaway form starts it in one step, with the Kick bonus options', async () => {
    const { GiveawayEditor } = await import('../pages/community/GiveawaysPage');
    const noop = () => {};
    const form = text(
      renderToStaticMarkup(<GiveawayEditor initial={null} defaultChannel={null} kickRewards={{ available: true, problem: null }} onCancel={noop} onSaved={noop} />),
    );
    expect(form).toContain('Start Giveaway');
    expect(form).not.toMatch(/Save draft|Create giveaway/);
    expect(form).toContain('Channel Points reward for bonus tickets');
    expect(form).toContain('Active Kick subscribers');
    expect(form).toContain('Total tickets = (1 + bonus tickets) × multiplier');
    const unavailable = text(
      renderToStaticMarkup(
        <GiveawayEditor initial={null} defaultChannel={null} kickRewards={{ available: false, problem: 'Select Reauthorize main account.' }} onCancel={noop} onSaved={noop} />,
      ),
    );
    expect(unavailable).toContain('Select Reauthorize main account.');
  });

  it('checks the form with the backend’s rules', async () => {
    const { checkGiveawayForm } = await import('../pages/community/GiveawaysPage');
    const base = { prize: 'p', description: '', winnerCount: '1', durationMinutes: '', platforms: ['kick'] as Array<'kick' | 'discord'> };
    expect(checkGiveawayForm({ ...base, prize: '' })).toHaveProperty('prize');
    expect(checkGiveawayForm({ ...base, winnerCount: '0' })).toHaveProperty('winnerCount');
    expect(checkGiveawayForm({ ...base, platforms: [] })).toHaveProperty('platforms');
    expect(checkGiveawayForm({ ...base, platforms: ['discord'] })).toHaveProperty('discordChannel');
    expect(checkGiveawayForm({ ...base, platforms: ['discord'], discordChannel: '42:5' })).toEqual({});
    expect(checkGiveawayForm({ ...base, rewardEnabled: true, rewardTitle: 'Bonus', rewardCost: '0', rewardTickets: '1' })).toHaveProperty(['kickReward.cost']);
    expect(checkGiveawayForm({ ...base, rewardEnabled: true, rewardTitle: 'Bonus', rewardCost: '500', rewardTickets: '1', subscriberMultiplier: '2' })).toEqual({});
  });
});

describe('Kick chat messages (editable before sending)', () => {
  it('lists every Kick giveaway message with its saved text, a preview and a collapsed variables list', async () => {
    const t = await render(state([]));
    expect(t).toContain('What the chatbot posts in Kick chat during a giveaway.');
    for (const label of ['Giveaway started', 'Viewer entered', 'Entries closed', 'Winners drawn', 'Winner redrawn', 'Entry after closing']) expect(t).toContain(label);
    expect(t).toContain('Preview: viewer123 has entered the giveaway!');
    expect(t).toContain('Preview: 🏆 Winners of Steam gift card: @viewer123, fan (Discord). Congratulations!');
    expect(t).toContain('Save messages');
    expect(t).toContain('Available variables');
    expect(t).not.toMatch(/Reset to default|Custom|Unsaved/); // all defaults, nothing changed
    // Compact: every message starts collapsed, one row each, with no repeated per-message instructions.
    const { KickGiveawayMessagesCard } = await import('../components/kick/KickGiveawayMessages');
    const html = renderToStaticMarkup(<KickGiveawayMessagesCard saved={{ ...KICK_GIVEAWAY_MESSAGE_DEFAULTS }} />);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(6);
    expect(html.match(/class="kmsg-body" hidden=""/g)).toHaveLength(6);
    expect(text(html).match(/Saving sends nothing/g)).toHaveLength(1);
    expect(t).not.toMatch(/{tickets?}|{odds}|{entries}/);
  });

  it('shows the saved (edited) text, its preview, a Custom tag and Reset to default', async () => {
    const t = await render(state([], { kickMessages: { ...KICK_GIVEAWAY_MESSAGE_DEFAULTS, entered: 'Welcome {user}, you are in for {prize}!' } }));
    expect(t).toContain('Preview: Welcome viewer123, you are in for Steam gift card!');
    expect(t).toMatch(/Viewer entered Custom Welcome {user}, you are in for {prize}!/);
    expect(t).toContain('Reset to default');
  });

  it('the example shows the message exactly as it will be filled in', async () => {
    const { previewKickGiveawayMessage } = await import('../components/kick/KickGiveawayMessages');
    expect(previewKickGiveawayMessage('closedReply', 'Too late, entries are closed.')).toBe('Too late, entries are closed.');
    expect(previewKickGiveawayMessage('started', KICK_GIVEAWAY_MESSAGE_DEFAULTS.started)).toBe(
      '🎉 I’ve started a giveaway for Steam gift card! To enter, type !enter in chat or click Enter Giveaway on the Discord announcement. 2 winners. Redeem “Bonus ticket” with Channel Points for bonus tickets. Entries close in 10 minutes.',
    );
  });
});
