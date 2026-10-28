/**
 * Loyalty & Rewards is Discord-only: Kick chat (real signed webhook deliveries against a simulated Kick — automated,
 * mocked, not proof of live Kick behaviour) can't earn, spend or redeem points, and the Kick commands !points, !rewards
 * and !redeem are gone — while Kick's own features (chat feed, custom commands) keep working, and older Kick points
 * history is kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loyaltyRepo } from '@conduit/database';
import { DEFAULT_LOYALTY_SETTINGS, type LoyaltySettings, type LoyaltyState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;
let kick: FakeKick;
let port: number;

const viewer = { user_id: 5550001, name: 'Viewer', slug: 'viewer', profile_picture: null };
const SUB = [{ text: 'Subscriber', type: 'subscriber', count: 3 }];
const everythingOn: LoyaltySettings = {
  ...DEFAULT_LOYALTY_SETTINGS,
  enabled: true,
  xp: { ...DEFAULT_LOYALTY_SETTINGS.xp, enabled: true },
  discord: { ...DEFAULT_LOYALTY_SETTINGS.discord, earn: true, commands: true },
};
const say = (content: string, from: FakeKickUser = viewer, badges: Array<{ text: string; type: string }> | null = SUB) =>
  deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, badges }));

async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
  const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
  const back = kick.approve(new URL(res.body.authorizationUrl), who);
  expect((await fetch(back)).status).toBe(200);
}

async function settle(expectedPosts: number): Promise<void> {
  const end = Date.now() + 2000;
  while (kick.posted.length < expectedPosts && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 60));
}

beforeEach(async () => {
  kick = new FakeKick();
  port = await freePort();
  h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(port) }, { vault: new MemoryVault(), fetch: kick.fetch });
  await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
  await connect(kick.users.streamer);
  await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
  await connect(kick.users.bot, 'bot');
  await h.services.kickChat.start();
  await h.call('POST', '/api/loyalty/settings', { body: everythingOn });
  await h.call('POST', '/api/loyalty/rewards', { body: { name: 'Hydrate', cost: 1 } });
});
afterEach(async () => {
  await h.close();
});

describe('Kick takes no part in Loyalty & Rewards', () => {
  it('Kick chat earns nothing (no points, no XP, no subscriber bonus) and !points / !rewards / !redeem don’t answer', async () => {
    for (const text of ['hello!', '!points', '!rewards', '!redeem Hydrate']) await say(text);
    await settle(0);
    expect(h.services.kickChat.state().recent.map((m) => m.content)).toEqual(['hello!', '!points', '!rewards', '!redeem Hydrate']); // received
    expect(kick.posted).toEqual([]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM loyalty_accounts WHERE platform = 'kick'").get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loyalty_levels').get()).toEqual({ n: 0 });
    expect(loyaltyRepo.listRedemptions(h.db, null, 10)).toEqual([]);
    const s = (await h.call<LoyaltyState>('GET', '/api/loyalty')).body;
    expect(s).not.toHaveProperty('kick');
    expect(s.settings).not.toHaveProperty('kick');
  });

  it('Kick’s own custom commands keep working (including one named !points)', async () => {
    await h.call('POST', '/api/commands/kick', { body: { trigger: '!points', response: 'Points live on our Discord' } });
    await h.call('POST', '/api/commands/kick', { body: { trigger: '!hello', response: 'Hi {user}' } });
    await say('!points');
    await settle(1);
    await say('!hello');
    await settle(2);
    expect(kick.posted.map((p) => p.content)).toEqual(['Points live on our Discord', 'Hi Viewer']);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loyalty_transactions').get()).toEqual({ n: 0 });
  });

  it('older Kick points history is kept, shown as such, and can’t be adjusted or spent', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    loyaltyRepo.ensureAccount(h.db, 'kick', '5550001', 'Viewer', at);
    loyaltyRepo.applyChange(h.db, { id: '33333333-3333-4333-8333-333333333333', platform: 'kick', userId: '5550001', amount: 15, kind: 'chat', reason: 'Chat message', eventKey: 'kick:chat:old', redemptionId: null, at });
    const s = (await h.call<LoyaltyState>('GET', '/api/loyalty')).body;
    expect(s.stats.legacyKick).toEqual({ accounts: 1, points: 15 });
    expect(s.stats.viewers).toBe(0); // Discord members only
    // Older Kick points history is listed in Discord Bot → Logs → Moderation log, marked as Kick.
    const log = (await h.call<{ loyaltyHistory: Array<{ userName: string | null; change: string | null }> }>('GET', '/api/moderation/discord')).body.loyaltyHistory;
    expect(log).toEqual(expect.arrayContaining([expect.objectContaining({ userName: 'Viewer (Kick, older)', change: expect.stringMatching(/^\+15 /) })]));
    // Adjustments are Discord-only; a Kick id is not a Discord member.
    expect((await h.call('POST', '/api/loyalty/members/points', { body: { userId: '5550001', amount: 5, reason: 'Try Kick' } })).status).toBe(404);
    await say('!redeem Hydrate', viewer);
    await settle(0);
    expect(loyaltyRepo.getAccount(h.db, 'kick', '5550001')!.balance).toBe(15);
  });
});
