/**
 * Giveaway core (GiveawayService) on an in-memory database with a simulated Kick chat and simulated Kick Channel Points
 * API (automated, mocked — not proof of live Kick behaviour): immediate start, cancellation by deletion, entries and
 * eligibility, tickets (bonus redemptions, subscriber multiplier), weighted draws, redraw history, expiry and restarts,
 * announcements and their privacy.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { giveawaysRepo, migrate, migrations, openDatabase, type Database } from '@conduit/database';
import { createLogger } from '@conduit/logger';
import { createGiveawaySchema, type GiveawayView } from '@conduit/shared';
import type { KickRedemption, KickRewardInput } from '../../apps/server/src/kick/kick-chat-api';
import { parseRedemption, type KickChatMessage, type KickRedemptionEvent, type KickSendOutcome } from '../../apps/server/src/kick/kick-chat-service';
import {
  fitKick,
  GiveawayService,
  startedMessage,
  winnersMessage,
  type GiveawayKickChat,
  type GiveawayKickRewards,
} from '../../apps/server/src/community/giveaway-service';
import { AppError } from '../../apps/server/src/errors';

const logger = createLogger({ name: 'test', level: 'error', console: false });
const OWNER = '4242001';
const CHATBOT = '4242002';

class FakeChat implements GiveawayKickChat {
  listeners: Array<(m: KickChatMessage) => void> = [];
  sent: string[] = [];
  ready = true;
  outcomes: KickSendOutcome[] = [];
  onMessage(l: (m: KickChatMessage) => void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  async sendResult(content: string): Promise<KickSendOutcome> {
    const next = this.outcomes.shift();
    if (next && !next.ok) return next;
    this.sent.push(content);
    return { ok: true, result: { sent: true, messageId: 'm', as: 'RetroBotKick', channel: 'retrolive' } };
  }
  msUntilNextSend() {
    return 0;
  }
  chatbotIdentity() {
    return { userId: CHATBOT, isMainAccount: false };
  }
  sendReadiness() {
    return this.ready ? { ready: true, problem: null } : { ready: false, problem: 'Connect a chatbot account.' };
  }
  receiving() {
    return true;
  }
  say(content: string, sender: { id: string; name: string }, opts: { messageId?: string; badges?: string[] } = {}) {
    const m = {
      messageId: opts.messageId ?? crypto.randomUUID(),
      content,
      senderUserId: sender.id,
      senderUsername: sender.name,
      broadcasterUserId: OWNER,
      badgeTypes: opts.badges ?? [],
    } as unknown as KickChatMessage;
    for (const l of this.listeners) l(m);
  }
}

/** Kick's channel rewards API, simulated: rewards, a redemption queue, accept/reject, and failure switches. */
class FakeRewards implements GiveawayKickRewards {
  access = { ok: true, problem: null as string | null };
  rewards = new Map<string, KickRewardInput & { paused?: boolean }>();
  /** Redemptions as Kick holds them. */
  queue: KickRedemption[] = [];
  decisions: Array<{ decision: 'accept' | 'reject'; ids: string[] }> = [];
  failCreate = false;
  failDecide = 0;
  listeners: Array<(r: KickRedemptionEvent) => void> = [];
  private n = 0;
  rewardsAccess() {
    return this.access;
  }
  onRedemption(l: (r: KickRedemptionEvent) => void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  async createReward(r: KickRewardInput) {
    if (this.failCreate) throw new Error('Kick rejected POST /channels/rewards (HTTP 400)');
    const id = `01REWARD${++this.n}`;
    this.rewards.set(id, { ...r });
    return id;
  }
  async updateReward(id: string, patch: Partial<KickRewardInput>) {
    Object.assign(this.rewards.get(id) ?? {}, patch.is_paused ? { paused: true } : {}, patch);
  }
  async deleteReward(id: string) {
    this.rewards.delete(id);
  }
  async rewardRedemptions(rewardId: string, status: 'pending' | 'accepted' | 'rejected' = 'pending') {
    return this.queue.filter((r) => r.rewardId === rewardId && r.status === status);
  }
  async decideRedemptions(decision: 'accept' | 'reject', ids: string[]) {
    if (this.failDecide > 0) {
      this.failDecide--;
      throw new Error('network');
    }
    this.decisions.push({ decision, ids });
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const r = this.queue.find((x) => x.id === id);
      if (!r) failed.push({ id, reason: 'NOT_FOUND' });
      else if (r.status !== 'pending') failed.push({ id, reason: 'NOT_PENDING' });
      else r.status = decision === 'accept' ? 'accepted' : 'rejected';
    }
    return failed;
  }
  /** A viewer redeems the reward on Kick: queued as pending and delivered by webhook (unless `silent`). */
  redeem(rewardId: string, userId: string, opts: { at?: string; silent?: boolean; id?: string } = {}): KickRedemptionEvent {
    const r: KickRedemption = { id: opts.id ?? `01RDM${++this.n}`, rewardId, redeemerUserId: userId, redeemedAt: opts.at ?? new Date(ms).toISOString(), status: 'pending' };
    this.queue.push(r);
    const event: KickRedemptionEvent = { ...r, redeemerUsername: `user${userId}`, broadcasterUserId: OWNER };
    if (!opts.silent) for (const l of this.listeners) l(event);
    return event;
  }
  deliver(e: KickRedemptionEvent) {
    for (const l of this.listeners) l(e);
  }
}

let db: Database;
let chat: FakeChat;
let rewards: FakeRewards;
let ms: number;
let svc: GiveawayService;
const now = () => new Date(ms);

function service(opts: { randomInt?: (max: number) => number } = {}) {
  return new GiveawayService({
    db,
    now,
    logger,
    kick: chat,
    kickRewards: rewards,
    discordReadiness: async () => ({ ready: true, note: null }),
    sleep: async () => {},
    ...opts,
  });
}

function connectKick() {
  const at = '2026-10-11T00:00:00.000Z';
  db.prepare(
    `INSERT INTO platform_connections (id, platform, external_account_id, account_name, granted_scopes, status, connected_at,
       last_verified_at, updated_at, role) VALUES (?, 'kick', ?, 'RetroLive', '[]', 'connected', ?, ?, ?, 'primary')`,
  ).run(crypto.randomUUID(), OWNER, at, at, at);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, migrations);
  chat = new FakeChat();
  rewards = new FakeRewards();
  ms = Date.parse('2026-10-11T18:00:00.000Z');
  svc = service();
});
afterEach(async () => {
  await svc.close();
  db.close();
});

const viewer = (n: number) => ({ id: String(5550000 + n), name: `viewer${n}` });
const fail = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
};
const failAsync = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
};
/** A running giveaway (Start Giveaway, without the platform checks). */
function opened(body: Record<string, unknown> = {}): GiveawayView {
  return svc.create({ prize: 'Steam key', ...body });
}
const rows = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Kick-only giveaway with a Channel Points reward, started through Start Giveaway. */
async function withReward(body: Record<string, unknown> = {}) {
  connectKick();
  const g = await svc.createAndStart({ prize: 'Steam key', platforms: ['kick'], kickReward: { title: 'Bonus ticket', cost: 500, tickets: 1 }, ...body });
  return { g, rewardId: giveawaysRepo.get(db, g.id)!.kickRewardId! };
}

describe('Start Giveaway (no drafts)', () => {
  it('starts immediately: running, with start and end times, on the chosen platforms', () => {
    const g = svc.create({ prize: '  Steam key ', description: 'A great game', winnerCount: 2, durationMinutes: 10 });
    expect(g).toMatchObject({
      prize: 'Steam key',
      description: 'A great game',
      status: 'open',
      winnerCount: 2,
      durationMinutes: 10,
      platforms: ['kick', 'discord'],
      startedAt: '2026-10-11T18:00:00.000Z',
      endsAt: '2026-10-11T18:10:00.000Z',
      entryCount: 0,
      ticketCount: 0,
    });
    expect(fail(() => svc.startGiveaway(g.id)).code).toBe('conflict'); // no second Start
  });

  it('validates fields with the shared rules', () => {
    expect(fail(() => svc.create({ prize: '' })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'x'.repeat(101) })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'line\nbreak' })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', winnerCount: 0 })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', durationMinutes: 10081 })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', platforms: [] })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', status: 'drawn' })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', subscriberMultiplier: 11 })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', platforms: ['discord'], subscriberMultiplier: 2 })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', platforms: ['discord'], kickReward: { title: 't', cost: 5, tickets: 1 } })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', kickReward: { title: 'x'.repeat(51), cost: 5, tickets: 1 } })).code).toBe('validation_error');
    expect(fail(() => svc.create({ prize: 'p', kickReward: { title: 't', cost: 0, tickets: 1 } })).code).toBe('validation_error');
    expect(createGiveawaySchema.parse({ prize: 'p', description: '  ' }).description).toBeNull();
  });

  it('allows only one running giveaway (also enforced by the database)', () => {
    opened();
    expect(fail(() => svc.create({ prize: 'Second' })).code).toBe('conflict');
    expect(giveawaysRepo.list(db)).toHaveLength(1);
  });

  it('checks platform connections and Kick Channel Points access before anything is created', async () => {
    expect((await failAsync(svc.createAndStart({ prize: 'p', platforms: ['kick'] }))).message).toMatch(/connect your main Kick account/);
    connectKick();
    rewards.access = { ok: false, problem: 'Kick Channel Points need the "channel:rewards:write" permission.' };
    const err = await failAsync(svc.createAndStart({ prize: 'p', platforms: ['kick'], kickReward: { title: 'Bonus', cost: 500, tickets: 1 } }));
    expect(err.message).toMatch(/^Not started: Kick Channel Points need/);
    expect(rows('giveaways')).toBe(0);
    expect(rewards.rewards.size).toBe(0);
  });

  it('creates a dedicated Kick reward; if that fails, no giveaway is left active', async () => {
    const { g, rewardId } = await withReward();
    expect(rewards.rewards.get(rewardId)).toMatchObject({ title: 'Bonus ticket', cost: 500, should_redemptions_skip_request_queue: false });
    expect(g.kickReward).toMatchObject({ title: 'Bonus ticket', cost: 500, tickets: 1, status: 'active', accepted: 0 });
    await svc.cancel(g.id);
    rewards.failCreate = true;
    const err = await failAsync(svc.createAndStart({ prize: 'Again', platforms: ['kick'], kickReward: { title: 'Bonus', cost: 5, tickets: 1 } }));
    expect(err.message).toMatch(/^Not started: Kick couldn’t create the Channel Points reward/);
    expect(giveawaysRepo.findOpen(db)).toBeUndefined();
    expect(rows('giveaways')).toBe(0);
  });

  it('limits edits once running; completed giveaways are final', () => {
    const g = opened({ durationMinutes: 5 });
    expect(svc.update(g.id, { winnerCount: 3, description: 'now' })).toMatchObject({ winnerCount: 3, description: 'now' });
    expect(fail(() => svc.update(g.id, { durationMinutes: 60 })).code).toBe('validation_error');
    svc.enter('kick', viewer(1));
    svc.enter('kick', viewer(2));
    svc.enter('kick', viewer(3));
    svc.draw(g.id);
    expect(fail(() => svc.update(g.id, { prize: 'changed' })).code).toBe('validation_error');
  });
});

describe('cancelling deletes the giveaway', () => {
  it('removes the giveaway with its entries, draws, winners and redemptions; other giveaways stay', async () => {
    const done = opened({ prize: 'Done' });
    svc.enter('kick', viewer(9));
    svc.draw(done.id);
    const { g, rewardId } = await withReward();
    svc.enter('kick', viewer(1));
    rewards.redeem(rewardId, viewer(1).id);
    expect(rows('giveaway_redemptions')).toBe(1);
    const result = await svc.cancel(g.id);
    expect(result).toEqual({ id: g.id, deleted: true });
    expect(giveawaysRepo.get(db, g.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(g.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM giveaway_redemptions WHERE giveaway_id = ?').get(g.id)).toEqual({ n: 0 });
    // The completed giveaway and its history are untouched.
    expect(svc.get(done.id)).toMatchObject({ status: 'drawn', entryCount: 1 });
    expect(rows('giveaway_winners')).toBe(1);
    expect(rows('giveaway_draws')).toBe(1);
    // The Kick reward is gone and the audit log keeps a minimal record.
    expect(rewards.rewards.has(rewardId)).toBe(false);
    const audit = db.prepare("SELECT metadata FROM audit_logs WHERE action = 'giveaway.cancelled'").all() as Array<{ metadata: string }>;
    expect(JSON.parse(audit.at(-1)!.metadata)).toMatchObject({ giveawayId: g.id });
  });

  it('a cancelled giveaway is no longer shown; completed ones can’t be cancelled', async () => {
    const g = opened();
    svc.enter('kick', viewer(1));
    await svc.cancel(g.id);
    expect((await svc.state()).giveaways).toEqual([]);
    const done = opened({ prize: 'Done' });
    svc.enter('kick', viewer(1));
    svc.draw(done.id);
    expect((await failAsync(svc.cancel(done.id))).code).toBe('conflict');
  });

  it('cancelled giveaways from before (kept rows) are hidden, not deleted', async () => {
    db.prepare(
      `INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, created_at, updated_at, cancelled_at)
       VALUES (?, 'Old', 'cancelled', 1, 1, 0, 't', 't', 't')`,
    ).run(crypto.randomUUID());
    const s = await svc.state();
    expect(s.giveaways).toEqual([]);
    expect(s.hiddenCancelled).toBe(1);
    expect(rows('giveaways')).toBe(1);
  });
});

describe('entries', () => {
  it('one entry per platform user id; names never merge or split entrants', () => {
    const g = opened();
    expect(svc.enter('kick', { id: '1', name: 'Alice' })).toMatchObject({ outcome: 'entered' });
    expect(svc.enter('kick', { id: '1', name: 'Alice2' })).toEqual({ outcome: 'already_entered', prize: 'Steam key' });
    expect(svc.enter('kick', { id: '2', name: 'Alice' }).outcome).toBe('entered');
    expect(svc.enter('discord', { id: '1', name: 'Alice' }).outcome).toBe('entered');
    expect(svc.get(g.id)).toMatchObject({ entryCount: 3, entriesByPlatform: { kick: 2, discord: 1 }, ticketCount: 3 });
  });

  it('is idempotent at the database level too (concurrent duplicates add nothing)', () => {
    const g = opened();
    const add = () =>
      giveawaysRepo.addEntry(db, { giveawayId: g.id, platform: 'kick', platformUserId: '9', displayName: 'n', enteredAt: 'now', source: 'chat', subscriberVerified: false, subscriberEvidence: null });
    expect([add(), add(), add()]).toEqual([true, false, false]);
    expect(giveawaysRepo.entryCount(db, g.id)).toBe(1);
  });

  it('checks that a giveaway is running, accepts the platform, and the entrant is eligible', () => {
    expect(svc.enter('kick', viewer(1))).toEqual({ outcome: 'no_giveaway' });
    opened({ platforms: ['discord'] });
    expect(svc.enter('kick', viewer(1))).toMatchObject({ outcome: 'platform_not_allowed', platforms: ['discord'] });
    expect(svc.enter('discord', viewer(1)).outcome).toBe('entered');
  });

  it('the streamer’s own accounts and the chatbot can’t enter', () => {
    connectKick();
    opened();
    expect(svc.enter('kick', { id: OWNER, name: 'RetroLive' }).outcome).toBe('not_eligible');
    expect(svc.enter('kick', { id: CHATBOT, name: 'RetroBotKick' }).outcome).toBe('not_eligible');
    expect(svc.enter('kick', { id: 'not a valid id!', name: 'x' }).outcome).toBe('not_eligible');
  });

  it('Kick: "!enter" as the first word of a verified chat message; repeats and the owner are ignored', () => {
    const g = opened();
    chat.say('!enter', viewer(1), { messageId: 'msg-1' });
    chat.say('!enter', viewer(1), { messageId: 'msg-1' });
    chat.say('!ENTER please', viewer(2));
    chat.say('I want to !enter', viewer(3));
    chat.say('!entering', viewer(4));
    chat.say('!enter', { id: OWNER, name: 'RetroLive' });
    expect(giveawaysRepo.entries(db, g.id).map((e) => e.platformUserId)).toEqual([viewer(1).id, viewer(2).id]);
  });

  it('Kick: each new entrant is announced publicly once; repeats and ineligible accounts stay silent', async () => {
    connectKick();
    opened({ platforms: ['kick'] });
    await svc.idle();
    chat.sent = [];
    chat.say('!enter', viewer(1), { badges: ['subscriber'] });
    chat.say('!enter', viewer(1));
    chat.say('!enter', viewer(2));
    chat.say('!enter', { id: CHATBOT, name: 'RetroBotKick' });
    await svc.idle();
    expect(chat.sent).toEqual(['viewer1 has entered the giveaway!', 'viewer2 has entered the giveaway!']);
  });

  it('Kick: entry announcements are bounded during a burst (everyone is still entered)', async () => {
    const g = opened({ platforms: ['kick'] });
    await svc.idle();
    chat.sent = [];
    for (let n = 1; n <= 30; n++) chat.say('!enter', viewer(n));
    await svc.idle();
    expect(giveawaysRepo.entryCount(db, g.id)).toBe(30);
    expect(chat.sent.length).toBeLessThanOrEqual(10);
  });

  it('Kick: "!enter" after entries closed gets a short answer, at most once a minute', async () => {
    const g = opened({ platforms: ['kick'] });
    svc.end(g.id);
    await svc.idle();
    chat.sent = [];
    chat.say('!enter', viewer(1));
    chat.say('!enter', viewer(2));
    await svc.idle();
    expect(chat.sent).toEqual(['Giveaway entries are closed.']);
    ms += 61_000;
    chat.say('!enter', viewer(3));
    await svc.idle();
    expect(chat.sent).toEqual(['Giveaway entries are closed.', 'Giveaway entries are closed.']);
  });
});

describe('active-subscriber multiplier', () => {
  it('is verified from Kick’s subscriber badge on the signed !enter message, at entry time, with evidence', () => {
    const g = opened({ platforms: ['kick'], subscriberMultiplier: 2 });
    chat.say('!enter', viewer(1), { badges: ['subscriber'], messageId: 'm-sub' });
    chat.say('!enter', viewer(2), { badges: ['og', 'vip', 'founder', 'sub_gifter', 'Subscriber'] });
    chat.say('!enter', viewer(3));
    const entries = giveawaysRepo.entries(db, g.id);
    expect(entries.map((e) => e.subscriberVerified)).toEqual([true, false, false]);
    expect(JSON.parse(entries[0]!.subscriberEvidence!)).toEqual({ kind: 'kick_chat_subscriber_badge', messageId: 'm-sub', at: '2026-10-11T18:00:00.000Z' });
    // Evaluated once: a later message with the badge doesn't change an existing entry.
    chat.say('!enter', viewer(3), { badges: ['subscriber'] });
    expect(giveawaysRepo.entries(db, g.id)[2]!.subscriberVerified).toBe(false);
    expect(svc.get(g.id)).toMatchObject({ ticketCount: 4, verifiedSubscribers: 1 });
  });

  it('never applies to Discord entrants, and is off (1×) unless configured', () => {
    const off = opened();
    chat.say('!enter', viewer(1), { badges: ['subscriber'] });
    svc.enter('discord', viewer(2));
    expect(svc.ticketLines(giveawaysRepo.get(db, off.id)!).map((l) => [l.platform, l.weight])).toEqual([
      ['kick', 1],
      ['discord', 1],
    ]);
  });
});

describe('Kick Channel Points bonus tickets', () => {
  it('a valid redemption by an entrant is accepted on Kick and adds the bonus tickets, once per redemption id', async () => {
    const { g, rewardId } = await withReward({ subscriberMultiplier: 2 });
    chat.say('!enter', viewer(1), { badges: ['subscriber'] });
    const r1 = rewards.redeem(rewardId, viewer(1).id);
    rewards.redeem(rewardId, viewer(1).id);
    rewards.deliver(r1); // a retried webhook delivery
    await svc.idle();
    expect(rewards.decisions.filter((d) => d.decision === 'accept').flatMap((d) => d.ids)).toHaveLength(2);
    const line = svc.ticketLines(giveawaysRepo.get(db, g.id)!)[0]!;
    // The documented example: 1 base + 2 bonus, × 2 for a verified subscriber = 6.
    expect(line).toMatchObject({ base: 1, bonus: 2, subscriber: true, multiplier: 2, weight: 6 });
    expect(svc.get(g.id).kickReward).toMatchObject({ accepted: 2, rejected: 0 });
  });

  it('rejects redemptions without an entry, from ineligible accounts, after the end time or after entries closed', async () => {
    const { g, rewardId } = await withReward({ durationMinutes: 10 });
    rewards.redeem(rewardId, viewer(1).id); // hasn't typed !enter
    rewards.redeem(rewardId, OWNER); // the channel owner
    chat.say('!enter', viewer(2));
    rewards.redeem(rewardId, viewer(2).id, { at: '2026-10-11T18:30:00.000Z' }); // timestamped after the end
    await svc.idle();
    const reasons = giveawaysRepo.redemptions(db, g.id).map((r) => [r.status, r.reason]);
    expect(reasons).toEqual([
      ['rejected', 'No giveaway entry (type !enter first)'],
      ['rejected', 'No giveaway entry (type !enter first)'],
      ['rejected', 'Redeemed after the end time'],
    ]);
    expect(rewards.decisions.filter((d) => d.decision === 'reject').flatMap((d) => d.ids)).toHaveLength(3);
    ms += 11 * 60_000;
    const late = rewards.redeem(rewardId, viewer(2).id, { at: '2026-10-11T18:09:59.000Z' }); // made just before, processed after closing
    await svc.idle();
    expect(giveawaysRepo.getRedemption(db, late.id)).toMatchObject({ status: 'rejected', reason: 'Entries were closed' });
    expect(svc.ticketLines(giveawaysRepo.get(db, g.id)!)[0]!.weight).toBe(1);
  });

  it('ignores other rewards and handles Kick’s own status updates', async () => {
    const { g, rewardId } = await withReward();
    chat.say('!enter', viewer(1));
    rewards.redeem('01OTHERREWARD', viewer(1).id);
    expect(rows('giveaway_redemptions')).toBe(0);
    const r = rewards.redeem(rewardId, viewer(1).id);
    await svc.idle();
    expect(svc.ticketLines(giveawaysRepo.get(db, g.id)!)[0]!.bonus).toBe(1);
    // The streamer rejects it on Kick while entries are open: the bonus goes.
    rewards.deliver({ ...r, status: 'rejected' });
    expect(svc.ticketLines(giveawaysRepo.get(db, g.id)!)[0]!.bonus).toBe(0);
    // A redemption Kick reports as already rejected is recorded, never counted.
    rewards.deliver({ ...r, id: '01RDMREJ', status: 'rejected' });
    expect(giveawaysRepo.getRedemption(db, '01RDMREJ')).toMatchObject({ status: 'rejected', tickets: 0 });
  });

  it('tickets are frozen when entries close (a later rejection on Kick changes nothing)', async () => {
    const { g, rewardId } = await withReward();
    chat.say('!enter', viewer(1));
    const r = rewards.redeem(rewardId, viewer(1).id);
    await svc.idle();
    svc.end(g.id);
    rewards.deliver({ ...r, status: 'rejected' });
    expect(svc.ticketLines(giveawaysRepo.get(db, g.id)!)[0]!.bonus).toBe(1);
  });

  it('missed webhooks are picked up from Kick’s pending list; failed Kick calls are retried', async () => {
    const { g, rewardId } = await withReward();
    chat.say('!enter', viewer(1));
    rewards.failDecide = 2; // the decision and the in-pass retry both fail
    rewards.redeem(rewardId, viewer(1).id, { silent: true }); // the webhook never arrived
    await svc.syncRewards();
    await svc.idle();
    expect(giveawaysRepo.redemptions(db, g.id)).toEqual([expect.objectContaining({ status: 'accepted', kickSynced: false })]);
    await svc.syncRewards(); // retries the decision Kick didn't get
    await svc.idle();
    expect(giveawaysRepo.redemptions(db, g.id)[0]!.kickSynced).toBe(true);
    expect(rewards.queue[0]!.status).toBe('accepted');
  });

  it('closing pauses the reward and rejects pending redemptions; drawing removes the reward', async () => {
    const { g, rewardId } = await withReward();
    chat.say('!enter', viewer(1));
    rewards.redeem(rewardId, viewer(1).id, { silent: true });
    svc.end(g.id);
    await svc.idle();
    expect(rewards.rewards.get(rewardId)).toMatchObject({ is_paused: true });
    expect(rewards.queue[0]!.status).toBe('rejected');
    expect(svc.get(g.id).kickReward).toMatchObject({ status: 'paused' });
    svc.draw(g.id);
    await svc.idle();
    expect(rewards.rewards.has(rewardId)).toBe(false);
    expect(svc.get(g.id).kickReward).toMatchObject({ status: 'removed' });
  });

  it('a rejection Kick didn’t receive when entries close isn’t counted as delivered: it’s sent again', async () => {
    const { g, rewardId } = await withReward();
    chat.say('!enter', viewer(1));
    const r = rewards.redeem(rewardId, viewer(1).id, { silent: true });
    rewards.failDecide = 10; // Kick unreachable for every reject while closing
    svc.end(g.id);
    await svc.idle();
    expect(rewards.queue[0]!.status).toBe('pending');
    expect(giveawaysRepo.getRedemption(db, r.id)).toMatchObject({ status: 'rejected', kickSynced: false });
    // Kick is back: the next sync delivers it.
    rewards.failDecide = 0;
    await svc.syncRewards();
    await svc.idle();
    expect(rewards.queue[0]!.status).toBe('rejected');
    expect(giveawaysRepo.getRedemption(db, r.id)!.kickSynced).toBe(true);
  });

  it('parses only well-formed verified redemption events', () => {
    const base = {
      id: '01RDM1',
      status: 'pending',
      redeemed_at: '2026-10-11T18:00:00Z',
      reward: { id: '01REWARD1', title: 'Bonus', cost: 500 },
      redeemer: { user_id: 5550001, username: 'viewer1' },
      broadcaster: { user_id: 4242001 },
    };
    expect(parseRedemption(base)).toMatchObject({ id: '01RDM1', status: 'pending', rewardId: '01REWARD1', redeemerUserId: '5550001', broadcasterUserId: '4242001' });
    expect(parseRedemption({ ...base, status: 'fulfilled' })).toBeNull();
    expect(parseRedemption({ ...base, id: 'x y' })).toBeNull();
    expect(parseRedemption({ ...base, redeemer: { user_id: 'abc' } })).toBeNull();
    expect(parseRedemption({ ...base, redeemed_at: 'yesterday' })).toBeNull();
  });
});

describe('weighted winner selection', () => {
  it('picks proportionally to tickets: the random number maps onto the ticket ranges', () => {
    const rolls = [4];
    svc = service({ randomInt: () => rolls.shift() ?? 0 });
    const g = opened({ platforms: ['kick'], subscriberMultiplier: 3 });
    chat.say('!enter', viewer(1)); // 1 ticket: [0, 1)
    chat.say('!enter', viewer(2), { badges: ['subscriber'] }); // 3 tickets: [1, 4)
    chat.say('!enter', viewer(3)); // 1 ticket: [4, 5)
    expect(svc.draw(g.id).winners.map((w) => w.displayName)).toEqual(['viewer3']);
  });

  it('gives more tickets proportionally more chances (crypto random, sanity check)', () => {
    const wins = { a: 0, b: 0 };
    for (let run = 0; run < 400; run++) {
      const g = svc.create({ prize: `p${run}`, platforms: ['kick'], subscriberMultiplier: 3 });
      chat.say('!enter', { id: '1', name: 'a' });
      chat.say('!enter', { id: '2', name: 'b' }, { badges: ['subscriber'] });
      const name = svc.draw(g.id).winners[0]!.displayName as 'a' | 'b';
      wins[name]++;
    }
    // Expected 100 : 300.
    expect(wins.a).toBeGreaterThan(50);
    expect(wins.a).toBeLessThan(160);
    expect(wins.b).toBeGreaterThan(240);
  });

  it('draws distinct winners and stores the pool’s ticket calculation with the draw', () => {
    const g = opened({ winnerCount: 3, platforms: ['kick'], subscriberMultiplier: 2 });
    for (let n = 1; n <= 6; n++) chat.say('!enter', viewer(n), { badges: n === 1 ? ['subscriber'] : [] });
    const drawn = svc.draw(g.id);
    expect(new Set(drawn.winners.map((w) => w.platformUserId)).size).toBe(3);
    expect(drawn.draws[0]).toMatchObject({ kind: 'initial', poolSize: 6, poolTickets: 7 });
    const snapshot = JSON.parse(giveawaysRepo.draws(db, g.id)[0]!.ticketSnapshot!) as Array<{ weight: number; subscriber: boolean }>;
    expect(snapshot.map((l) => l.weight)).toEqual([2, 1, 1, 1, 1, 1]);
  });

  it('needs enough eligible participants for the number of winners', () => {
    const g = opened({ winnerCount: 2 });
    expect(fail(() => svc.draw(g.id)).message).toMatch(/Nobody has entered/);
    svc.enter('kick', viewer(1));
    expect(fail(() => svc.draw(g.id)).message).toBe('Only 1 eligible entrant for 2 winners. Lower the number of winners (Edit) and draw again.');
    expect(svc.get(g.id).status).toBe('open');
    svc.update(g.id, { winnerCount: 1 });
    expect(svc.draw(g.id).winners).toHaveLength(1);
  });

  it('can’t be drawn twice: repeated or simultaneous draw requests are refused', async () => {
    const g = opened({ winnerCount: 1 });
    for (let n = 1; n <= 5; n++) svc.enter('kick', viewer(n));
    const results = await Promise.allSettled([Promise.resolve().then(() => svc.draw(g.id)), Promise.resolve().then(() => svc.draw(g.id))]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(giveawaysRepo.draws(db, g.id)).toHaveLength(1);
    expect(() =>
      giveawaysRepo.insertDraw(db, { id: crypto.randomUUID(), giveawayId: g.id, kind: 'initial', drawnAt: 'x', poolSize: 5, replacedWinnerId: null, reason: null }),
    ).toThrow(/UNIQUE/);
  });

  it('a draw closes entries first; entries after that are refused', () => {
    const g = opened();
    svc.enter('kick', viewer(1));
    svc.draw(g.id);
    expect(svc.enter('kick', viewer(2))).toEqual({ outcome: 'no_giveaway' });
    expect(svc.get(g.id).closedAt).not.toBeNull();
  });
});

describe('redraw', () => {
  it('replaces one winner, keeps the history, never picks a previous winner, and records the pool’s tickets', () => {
    const g = opened({ winnerCount: 2 });
    for (let n = 1; n <= 4; n++) svc.enter('kick', viewer(n));
    const first = svc.draw(g.id);
    const out = first.winners.find((w) => w.position === 1)!;
    const after = svc.redraw(g.id, { winnerId: out.id, reason: 'Did not respond' });
    expect(after.winners.find((w) => w.id === out.id)).toMatchObject({ status: 'replaced', position: 1 });
    const newOne = after.winners.find((w) => w.status === 'won' && w.position === 1)!;
    expect(first.winners.map((w) => w.platformUserId)).not.toContain(newOne.platformUserId);
    expect(after.draws.map((d) => d.kind)).toEqual(['initial', 'redraw']);
    expect(after.draws[1]).toMatchObject({ replacedWinnerId: out.id, reason: 'Did not respond', poolSize: 2, poolTickets: 2 });
    expect(fail(() => svc.redraw(g.id, { winnerId: out.id })).message).toMatch(/already replaced/);
  });

  it('stops when everyone has been drawn, and only works on completed giveaways', () => {
    const g = opened({ winnerCount: 1 });
    svc.enter('kick', viewer(1));
    svc.enter('kick', viewer(2));
    const w1 = svc.draw(g.id).winners[0]!;
    const w2 = svc.redraw(g.id, { winnerId: w1.id }).winners.find((w) => w.status === 'won')!;
    expect(fail(() => svc.redraw(g.id, { winnerId: w2.id })).message).toMatch(/nobody left/);
    const other = opened({ prize: 'Other' });
    expect(fail(() => svc.redraw(other.id, { winnerId: w2.id })).code).toBe('conflict');
  });
});

describe('expiry and restarts', () => {
  it('entries stop at the end time even before the background check runs', () => {
    const g = opened({ durationMinutes: 5 });
    svc.enter('kick', viewer(1));
    ms += 5 * 60_000;
    expect(svc.enter('kick', viewer(2))).toEqual({ outcome: 'no_giveaway' });
    expect(svc.get(g.id)).toMatchObject({ status: 'closed', entryCount: 1 });
  });

  it('a backend started after the end time closes the overdue giveaway; nothing is lost', async () => {
    const g = opened({ durationMinutes: 5 });
    svc.enter('kick', viewer(1));
    await svc.close();
    ms += 3 * 60 * 60_000;
    svc = service();
    svc.start();
    expect(svc.get(g.id)).toMatchObject({ status: 'closed', entryCount: 1 });
    await svc.idle();
    expect(chat.sent.filter((s) => s.startsWith('Entries for'))).toEqual([]);
    expect(svc.draw(g.id).winners).toHaveLength(1);
  });

  it('a giveaway with no duration stays running across restarts until ended', async () => {
    const g = opened();
    await svc.close();
    ms += 24 * 60 * 60_000;
    svc = service();
    svc.start();
    expect(svc.get(g.id).status).toBe('open');
  });
});

describe('public messages', () => {
  it('announce the start (with the reward), a timely close and the winners: names and prize only', async () => {
    const g = opened({ winnerCount: 2, durationMinutes: 10 });
    svc.enter('kick', { id: '1', name: 'alice' });
    svc.enter('discord', { id: '2', name: 'bob' });
    ms += 10 * 60_000 + 1000;
    svc.closeOverdue();
    svc.draw(g.id);
    await svc.idle();
    expect(chat.sent[0]).toBe('🎉 I’ve started a giveaway for Steam key! To enter, type !enter in chat or click Enter Giveaway on the Discord announcement. 2 winners. Entries close in 10 minutes.');
    expect(chat.sent[1]).toBe('Entries for Steam key are now closed. Winners will be drawn soon.');
    expect(chat.sent[2]).toMatch(/^🏆 Winners of Steam key: (@alice, bob \(Discord\)|bob \(Discord\), @alice)\. Congratulations!$/);
  });

  it('never expose ticket counts, totals, odds or entrant lists', async () => {
    const { g, rewardId } = await withReward({ subscriberMultiplier: 2, winnerCount: 1 });
    for (let n = 1; n <= 5; n++) chat.say('!enter', viewer(n), { badges: n === 1 ? ['subscriber'] : [] });
    rewards.redeem(rewardId, viewer(1).id);
    await svc.idle();
    const drawn = svc.draw(g.id);
    svc.redraw(g.id, { winnerId: drawn.winners[0]!.id });
    await svc.idle();
    const publicText = chat.sent.join('\n');
    expect(publicText).not.toMatch(/ticket(s)? \d|\d+ tickets?|\d+ (entries|entrants)|odds|%|chance|\d+×|subscriber/i);
    expect(chat.sent.filter((s) => s.startsWith('🏆'))).toHaveLength(2);
    expect(startedMessage(giveawaysRepo.get(db, g.id)!)).toContain('Redeem “Bonus ticket” with Channel Points for bonus tickets.');
  });

  it('a failed announcement is recorded and never undoes the result', async () => {
    const g = opened();
    svc.enter('kick', viewer(1));
    await svc.idle();
    chat.outcomes.push({ ok: false, outcome: 'failed', message: 'Kick refused the message.', locallyThrottled: false });
    const drawn = svc.draw(g.id);
    await svc.idle();
    const after = svc.get(g.id);
    expect(after.status).toBe('drawn');
    expect(after.winners).toEqual(drawn.winners);
    expect(after.announcement).toMatchObject({ kind: 'winners', outcome: 'failed', detail: 'Kick refused the message.' });
  });

  it('messages fit Kick’s limit and never start with a command prefix', () => {
    const many = Array.from({ length: 50 }, (_, n) => ({ platform: 'kick' as const, displayName: `winner_with_a_long_name_${n}` }));
    const text = fitKick(winnersMessage('x'.repeat(100), many));
    expect([...text].length).toBeLessThanOrEqual(500);
    const g = giveawaysRepo.get(db, svc.create({ prize: '!so everyone', durationMinutes: 90 }).id)!;
    expect(startedMessage(g)).toMatch(/^🎉 /);
  });
});

describe('migrations 13 and 14 keep existing giveaways working', () => {
  it('older giveaways keep one entry = one ticket; their draws have no ticket snapshot', () => {
    const old = openDatabase(':memory:');
    migrate(old, migrations.slice(0, 12));
    old.exec(`INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, created_at, updated_at)
              VALUES ('g1', 'Steam key', 'drawn', 1, 1, 1, 't', 't')`);
    old.exec(`INSERT INTO giveaway_entries (giveaway_id, platform, platform_user_id, display_name, entered_at)
              VALUES ('g1', 'discord', '900000000000000001', 'fan', 't')`);
    old.exec(`INSERT INTO giveaway_draws (id, giveaway_id, kind, drawn_at, pool_size) VALUES ('d1', 'g1', 'initial', 't', 1)`);
    expect(migrate(old, migrations)).toEqual({ applied: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(giveawaysRepo.get(old, 'g1')).toMatchObject({ prize: 'Steam key', subscriberMultiplier: 1, kickRewardCost: null, discordMessageId: null });
    expect(giveawaysRepo.entries(old, 'g1')).toEqual([expect.objectContaining({ source: null, subscriberVerified: false, subscriberEvidence: null })]);
    expect(giveawaysRepo.draws(old, 'g1')[0]!.ticketSnapshot).toBeNull();
    old.close();
  });

  it('enforce the schema rules on their own', () => {
    const ins = (status: string) =>
      db
        .prepare(`INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, created_at, updated_at) VALUES (?, 'p', ?, 1, 1, 0, 't', 't')`)
        .run(crypto.randomUUID(), status);
    expect(() => ins('paused')).toThrow(/CHECK/);
    ins('open');
    expect(() => ins('open')).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE giveaways SET subscriber_multiplier = 11")).toThrow(/CHECK/);
    const gid = (db.prepare('SELECT id FROM giveaways').get() as { id: string }).id;
    const red = (id: string, status: string, tickets: number) =>
      db
        .prepare(
          `INSERT INTO giveaway_redemptions (id, giveaway_id, reward_id, redeemer_user_id, redeemed_at, status, tickets, processed_at) VALUES (?, ?, 'r', '1', 't', ?, ?, 't')`,
        )
        .run(id, gid, status, tickets);
    red('a', 'accepted', 1);
    expect(() => red('a', 'accepted', 1)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => red('b', 'rejected', 1)).toThrow(/CHECK/);
  });
});

describe('Kick giveaway message templates', () => {
  it('fills in only that message’s variables, once (inserted text is never a template), and never starts with ! or /', async () => {
    const { renderKickGiveawayMessage } = await import('@conduit/shared');
    expect(renderKickGiveawayMessage('entered', '{user} joined for {prize}', { user: '{prize}', prize: 'Key' })).toBe('{prize} joined for Key');
    expect(renderKickGiveawayMessage('entered', '{user} joined', { user: '!ban everyone' })).toBe('ban everyone joined');
    expect(renderKickGiveawayMessage('closed', 'Closed {prize} {user}', { prize: 'Key', user: 'x' })).toBe('Closed Key {user}');
    expect(renderKickGiveawayMessage('redraw', '{winner}\nwins', { winner: 'a\u0007b' })).toBe('a b wins');
  });

  it('the default texts produce exactly the earlier messages', async () => {
    const { KICK_GIVEAWAY_MESSAGE_DEFAULTS, renderKickGiveawayMessage } = await import('@conduit/shared');
    expect(renderKickGiveawayMessage('entered', KICK_GIVEAWAY_MESSAGE_DEFAULTS.entered, { user: 'Viewer1', prize: 'p' })).toBe('Viewer1 has entered the giveaway!');
    expect(renderKickGiveawayMessage('closed', KICK_GIVEAWAY_MESSAGE_DEFAULTS.closed, { prize: 'p' })).toBe('Entries for p are now closed. Winners will be drawn soon.');
    expect(renderKickGiveawayMessage('closedReply', KICK_GIVEAWAY_MESSAGE_DEFAULTS.closedReply, {})).toBe('Giveaway entries are closed.');
    expect(winnersMessage('p', [{ platform: 'kick', displayName: 'a' }])).toBe('🏆 Winner of p: @a. Congratulations!');
  });

  it('offers no ticket, entry-count or odds variable on any message', async () => {
    const { KICK_GIVEAWAY_MESSAGES } = await import('@conduit/shared');
    const names = Object.values(KICK_GIVEAWAY_MESSAGES).flatMap((m) => Object.keys(m.variables));
    expect(names.filter((n) => /ticket|odds|chance|entries|entry_count|total/.test(n))).toEqual([]);
  });
});
