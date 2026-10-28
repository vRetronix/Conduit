// Loyalty & Rewards (Discord only), rendered from backend state (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';
import { DEFAULT_LOYALTY_SETTINGS, formatPoints, renderLevelUp, type LoyaltyState } from '@conduit/shared/discord/loyalty';

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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const state = (over: Partial<LoyaltyState> = {}): LoyaltyState => ({
  settings: DEFAULT_LOYALTY_SETTINGS,
  stats: { viewers: 0, outstanding: 0, pending: 0, members: 0, totalXp: 0, legacyKick: { accounts: 0, points: 0 } },
  guilds: [{ id: '42', name: 'Retro Server', members: 0 }],
  rewards: [],
  roleRewards: [],
  redemptions: [],
  problems: [],
  discord: { ready: true, problem: null, contentAvailable: false, commandConflicts: [] },
  ...over,
});

describe('Loyalty & Rewards page', () => {
  it('off: says so (data kept); the tabs; Discord-only wording with no Kick controls', async () => {
    const { LoyaltyView } = await import('../pages/discord/LoyaltyPage');
    const t = text(renderToStaticMarkup(<LoyaltyView s={state()} />));
    expect(t).toContain('Loyalty is off');
    expect(t).toContain('Levels, balances and history are kept');
    for (const tab of ['Overview', 'Levels & XP', 'Members', 'Points & Earning', 'Rewards', 'Redemptions']) expect(t).toContain(tab);
    expect(t).toContain('XP and points are never converted into each other');
    expect(t).not.toMatch(/Kick/);
  });

  it('overview: totals, problems, and older Kick balances explained as kept history', async () => {
    const { LoyaltyView } = await import('../pages/discord/LoyaltyPage');
    const t = text(
      renderToStaticMarkup(
        <LoyaltyView
          s={state({
            settings: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true },
            stats: { viewers: 3, outstanding: 1234, pending: 1, members: 7, totalXp: 98765, legacyKick: { accounts: 2, points: 40 } },
            problems: [{ at: '2026-01-01T12:00:00.000Z', detail: 'Level 3 role for alice wasn’t given: Discord refused' }],
          })}
        />,
      ),
    );
    expect(t).not.toContain('Loyalty is off');
    expect(t).toContain('98,765');
    expect(t).toContain('1,234');
    expect(t).toContain('Level 3 role for alice wasn’t given');
    expect(t).toContain('2 older Kick balances (40 points) are kept as history');
  });

  it('levels tab: XP rules, the formula, announcements and role rewards with their problems', async () => {
    const { LoyaltyView } = await import('../pages/discord/LoyaltyPage');
    const t = text(
      renderToStaticMarkup(
        <LoyaltyView
          initialTab="levels"
          s={state({ roleRewards: [{ id: 'r1', guildId: '42', level: 5, roleId: '7', roleName: 'Regular', problem: 'This role is at or above the bot’s highest role.' }] })}
        />,
      ),
    );
    expect(t).toContain('XP per message (random)');
    expect(t).toContain('5 × L² + 50 × L + 100');
    expect(t).toContain('Repeats can only be recognised while the bot receives message text');
    expect(t).toContain('Each level is announced once');
    expect(t).toContain('Include an embed');
    expect(t).toContain('Level 5');
    expect(t).toContain('@Regular');
    expect(t).toContain('at or above the bot’s highest role');
    expect(t).toContain('Remove…'); // confirmation first
  });

  it('redemptions: pending with fulfil and a confirm-first reject; handled ones show their outcome', async () => {
    const { LoyaltyView } = await import('../pages/discord/LoyaltyPage');
    const t = text(
      renderToStaticMarkup(
        <LoyaltyView
          initialTab="redemptions"
          s={state({
            settings: { ...DEFAULT_LOYALTY_SETTINGS, enabled: true, pointsName: 'coins' },
            redemptions: [
              { id: '1', rewardId: 'r', rewardName: 'Song request', platform: 'discord', userId: '9', displayName: 'alice', cost: 500, status: 'pending', note: null, createdAt: '2026-01-01T12:00:00.000Z', resolvedAt: null },
              { id: '2', rewardId: 'r', rewardName: 'Hydrate', platform: 'discord', userId: '9', displayName: 'alice', cost: 100, status: 'rejected', note: 'Stream ended', createdAt: '2026-01-01T11:00:00.000Z', resolvedAt: '2026-01-01T11:05:00.000Z' },
            ],
          })}
        />,
      ),
    );
    expect(t).toContain('Song request');
    expect(t).toContain('500 coins');
    expect(t).toContain('Mark fulfilled');
    expect(t).toContain('Reject…');
    expect(t).toContain('Rejected · refunded');
    expect(t).toContain('Stream ended');
  });

  it('has no History tab: its points changes and logs are in Discord Bot → Logs → Moderation log', async () => {
    const { LoyaltyView } = await import('../pages/discord/LoyaltyPage');
    const t = text(renderToStaticMarkup(<LoyaltyView s={state()} />));
    expect(t).toContain('Redemptions');
    expect(t).not.toContain('History');
    expect(t).not.toContain('Loyalty & Reward Logs');
  });

  it('formats points and level-up messages', () => {
    expect(formatPoints(1, 'coins')).toBe('1 coin');
    expect(formatPoints(2500, 'points')).toBe('2,500 points');
    expect(renderLevelUp('GG {user} ({USERNAME}) → level {level}', { userId: '9', username: 'alice', level: 4 })).toBe('GG <@9> (alice) → level 4');
  });
});
