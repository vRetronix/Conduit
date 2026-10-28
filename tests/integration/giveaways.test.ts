/**
 * Giveaways end to end against simulated platforms (automated, mocked — not proof of live Kick or Discord behaviour):
 * Start Giveaway and management through the local API, Kick entries and Channel Points bonus tickets from signed
 * webhook deliveries and the rewards API, public Kick messages, cancellation by deletion, concurrent draws and restarts,
 * and the removal of the former Discord /enter command. Discord embeds and buttons: giveaways-discord.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordSetupState, GiveawaysState, GiveawayView } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { auditActions, createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;

afterEach(async () => {
  await h.close();
});

type Res<T> = { status: number; body: T & { error?: { code: string; message: string } } };
const state = async () => (await h.call<GiveawaysState>('GET', '/api/giveaways')).body;
/** Start Giveaway: Kick-only unless the test says otherwise. */
const start = (body: Record<string, unknown>) =>
  h.call<GiveawayView>('POST', '/api/giveaways', { body: { platforms: ['kick'], ...body } }) as Promise<Res<GiveawayView>>;
const act = (id: string, action: string, body?: unknown) =>
  h.call<GiveawayView>('POST', `/api/giveaways/${id}/${action}`, body === undefined ? {} : { body }) as Promise<Res<GiveawayView>>;
const view = async (id: string) => (await state()).giveaways.find((g) => g.id === id);

describe('with Kick (simulated Kick)', () => {
  let kick: FakeKick;
  let port: number;

  async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
    const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
    const back = kick.approve(new URL(res.body.authorizationUrl), who);
    expect((await fetch(back)).status).toBe(200);
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
  });

  const viewer = (n: number): FakeKickUser => ({ user_id: 5550000 + n, name: `Viewer${n}`, slug: `viewer${n}`, profile_picture: null });
  const say = (content: string, from: FakeKickUser, opts: { messageId?: string; badges?: Array<{ text: string; type: string }> } = {}) =>
    deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, messageId: opts.messageId, badges: opts.badges ?? [] }));
  const redeem = (payload: Record<string, unknown>) => deliverWebhook(kick, port, payload, { type: 'channel.reward.redemption.updated' });
  async function posts(n: number): Promise<string[]> {
    const end = Date.now() + 5000; // generous: the full suite runs many files in parallel
    while (kick.posted.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await h.services.giveaways.idle();
    return kick.posted.map((p) => p.content);
  }
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60));
    await h.services.giveaways.idle();
  };

  describe('Start Giveaway and management', () => {
    it('starts in one step, runs, ends, draws — with audit records', async () => {
      const c = await start({ prize: 'Gift card', description: 'For one lucky viewer', durationMinutes: 30 });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ status: 'open', startedAt: expect.any(String), endsAt: expect.any(String) });
      expect(await posts(1)).toEqual(['🎉 I’ve started a giveaway for Gift card! To enter, type !enter in chat. Entries close in 30 minutes.']);
      await say('!enter', viewer(1));
      await settle();
      expect((await act(c.body.id, 'end')).body.status).toBe('closed');
      const drawn = await act(c.body.id, 'draw');
      expect(drawn.body).toMatchObject({ status: 'drawn', entryCount: 1 });
      expect(auditActions(h).map((a) => a.action)).toEqual(expect.arrayContaining(['giveaway.started', 'giveaway.ended', 'giveaway.drawn']));
    });

    it('requires the local access key, validates input and allows one running giveaway', async () => {
      expect((await h.call('POST', '/api/giveaways', { withoutLocalKey: true, body: { prize: 'x' } })).status).toBe(401);
      const bad = await start({ prize: '', winnerCount: 0 });
      expect(bad.status).toBe(400);
      expect(bad.body.error?.code).toBe('validation_error');
      const a = await start({ prize: 'A' });
      const b = await start({ prize: 'B' });
      expect(b.status).toBe(409);
      expect(b.body.error?.message).toMatch(/“A” is still running/);
      expect((await state()).giveaways.map((g) => g.prize)).toEqual(['A']);
      expect((await act(a.body.id, 'draw')).status).toBe(409); // nobody entered
    });

    it('cancel deletes the giveaway and its data; it disappears from the dashboard', async () => {
      const c = await start({ prize: 'p' });
      await say('!enter', viewer(1));
      await settle();
      const res = await h.call<{ id: string; deleted: boolean }>('POST', `/api/giveaways/${c.body.id}/cancel`);
      expect(res.body).toEqual({ id: c.body.id, deleted: true });
      expect(await view(c.body.id)).toBeUndefined();
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries').get()).toEqual({ n: 0 });
      expect((await act(c.body.id, 'end')).status).toBe(404);
      expect(auditActions(h).some((a) => a.action === 'giveaway.cancelled')).toBe(true);
    });

    it('a completed giveaway can be deleted with its entries, winners and draws; one that isn’t completed can’t', async () => {
      const c = await start({ prize: 'Done deal' });
      expect((await h.call('DELETE', `/api/giveaways/${c.body.id}`)).status).toBe(409); // still running: cancel it instead
      await say('!enter', viewer(1));
      await settle();
      await act(c.body.id, 'draw');
      const res = await h.call<{ id: string; deleted: boolean }>('DELETE', `/api/giveaways/${c.body.id}`);
      expect(res.body).toEqual({ id: c.body.id, deleted: true });
      expect(await view(c.body.id)).toBeUndefined();
      for (const table of ['giveaway_entries', 'giveaway_draws', 'giveaway_winners']) expect(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(auditActions(h).some((a) => a.action === 'giveaway.deleted')).toBe(true);
      expect((await h.call('DELETE', `/api/giveaways/${c.body.id}`)).status).toBe(404);
    });

    it('two simultaneous draw requests produce exactly one drawing', async () => {
      const c = await start({ prize: 'p', winnerCount: 2 });
      for (let n = 1; n <= 6; n++) await say('!enter', viewer(n));
      await settle();
      const results = await Promise.all([act(c.body.id, 'draw'), act(c.body.id, 'draw'), act(c.body.id, 'draw')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const g = (await view(c.body.id))!;
      expect(g.draws).toHaveLength(1);
      expect(g.winners).toHaveLength(2);
    });

    it('a restart after the end time closes the giveaway; entries and results survive', async () => {
      const c = await start({ prize: 'p', durationMinutes: 5 });
      await say('!enter', viewer(1));
      await settle();
      await h.server.close();
      h.clock.advance(60 * 60_000);
      await h.restart();
      expect(await view(c.body.id)).toMatchObject({ status: 'closed', entryCount: 1 });
      expect((await act(c.body.id, 'draw')).body.winners).toHaveLength(1);
    });

    it('a draft left by an earlier version is shown and can still be started', async () => {
      h.db
        .prepare(
          `INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, created_at, updated_at)
           VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'Old draft', 'draft', 1, 1, 0, 't', 't')`,
        )
        .run();
      expect((await view('aaaaaaaa-0000-4000-8000-000000000001'))?.status).toBe('draft');
      expect((await act('aaaaaaaa-0000-4000-8000-000000000001', 'start')).body.status).toBe('open');
    });
  });

  describe('Kick entries and public messages', () => {
    it('viewers enter with !enter; duplicates, the streamer and the chatbot are not counted', async () => {
      const c = await start({ prize: 'Steam key' });
      await say('!enter', viewer(1), { messageId: 'dup-1' });
      await say('!enter', viewer(1), { messageId: 'dup-1' });
      await say('!enter', viewer(1));
      await say('!ENTER', viewer(2));
      await say('hello !enter', viewer(3));
      await say('!enter', kick.users.streamer);
      await say('!enter', kick.users.bot);
      await settle();
      expect(await view(c.body.id)).toMatchObject({ entryCount: 2, entriesByPlatform: { kick: 2, discord: 0 } });
    });

    it('announces the start, each new entrant once and the winner — never tickets, totals or odds', async () => {
      const c = await start({ prize: 'Steam key', durationMinutes: 15 });
      await posts(1);
      await say('!enter', viewer(1));
      expect((await posts(2))[1]).toBe('Viewer1 has entered the giveaway!');
      await say('!enter', viewer(1));
      await settle();
      expect(kick.posted).toHaveLength(2);
      h.clock.advance(5000);
      await act(c.body.id, 'draw');
      expect((await posts(3))[2]).toBe('🏆 Winner of Steam key: @Viewer1. Congratulations!');
      const all = kick.posted.map((p) => p.content).join('\n');
      expect(all).not.toMatch(/CONDUIT|\d+ tickets?|\d+ (entries|entrants)|odds|chance|%/i);
      expect(kick.posted.every((p) => p.as === 'RetroBotKick')).toBe(true);
    });

    it('answers "!enter" after entries closed, briefly', async () => {
      const c = await start({ prize: 'p' });
      await posts(1);
      await act(c.body.id, 'end');
      await posts(2); // "Entries for p are now closed…"
      h.clock.advance(5000);
      await say('!enter', viewer(1));
      expect((await posts(3))[2]).toBe('Giveaway entries are closed.');
    });

    it('if Kick refuses the winner announcement, the winners are kept and the failure is shown', async () => {
      const c = await start({ prize: 'Steam key' });
      await posts(1);
      await say('!enter', viewer(1));
      expect((await posts(2))[1]).toBe('Viewer1 has entered the giveaway!');
      h.clock.advance(5000);
      kick.apiFailures.push(403);
      expect((await act(c.body.id, 'draw')).status).toBe(200);
      await h.services.giveaways.idle();
      const g = (await view(c.body.id))!;
      expect(g).toMatchObject({ status: 'drawn', announcement: { kind: 'winners', outcome: 'failed' } });
      expect(g.winners).toHaveLength(1);
    });

    it('existing custom commands keep working next to !enter, which stays reserved', async () => {
      await h.call('POST', '/api/commands/kick', { body: { trigger: '!discord', response: 'discord.gg/retro' } });
      expect((await h.call<any>('POST', '/api/commands/kick', { body: { trigger: '!enter', response: 'x' } })).status).toBe(400);
      const c = await start({ prize: 'p' });
      await posts(1);
      h.clock.advance(5000);
      await say('!discord', viewer(1));
      await say('!enter', viewer(1));
      expect((await posts(3)).slice(1).sort()).toEqual(['Viewer1 has entered the giveaway!', 'discord.gg/retro']);
      expect((await view(c.body.id))!.entryCount).toBe(1);
    });
  });

  describe('Channel Points bonus tickets (simulated Kick rewards API)', () => {
    const reward = { title: 'Bonus ticket', cost: 500, tickets: 1 };

    it('creates a dedicated reward; accepted redemptions add tickets once; the reward is removed after the draw', async () => {
      const c = await start({ prize: 'Steam key', kickReward: reward, subscriberMultiplier: 2 });
      expect(c.status).toBe(201);
      const rewardId = c.body.kickReward!.rewardId!;
      expect(kick.rewards.get(rewardId)).toMatchObject({ title: 'Bonus ticket', cost: 500, should_redemptions_skip_request_queue: false });
      expect(await posts(1)).toEqual([
        '🎉 I’ve started a giveaway for Steam key! To enter, type !enter in chat. Redeem “Bonus ticket” with Channel Points for bonus tickets.',
      ]);
      await say('!enter', viewer(1), { badges: [{ text: 'Subscriber', type: 'subscriber' }] });
      const payload = kick.redeem(rewardId, viewer(1));
      expect(await redeem(payload)).toBe(200);
      expect(await redeem(payload)).toBe(200); // Kick retries the same event
      await settle();
      expect(kick.redemptions[0]!.status).toBe('accepted');
      const g = (await view(c.body.id))!;
      expect(g).toMatchObject({ ticketCount: 4, verifiedSubscribers: 1, kickReward: { accepted: 1, rejected: 0 } }); // (1 + 1) × 2
      await act(c.body.id, 'draw');
      await settle();
      expect(kick.rewards.has(rewardId)).toBe(false);
      expect((await view(c.body.id))!.kickReward?.status).toBe('removed');
      // Public messages never mention the bonus a winner had.
      expect(kick.posted.map((p) => p.content).join('\n')).not.toMatch(/\d+ tickets?|×|subscriber/i);
    });

    it('rejects redemptions without an entry; picks up redemptions whose webhook was missed', async () => {
      const c = await start({ prize: 'p', kickReward: reward });
      const rewardId = c.body.kickReward!.rewardId!;
      await redeem(kick.redeem(rewardId, viewer(1))); // never typed !enter
      await settle();
      expect(kick.redemptions[0]!.status).toBe('rejected');
      await say('!enter', viewer(2));
      await settle();
      kick.redeem(rewardId, viewer(2)); // no webhook delivered
      await h.services.giveaways.syncRewards();
      await settle();
      expect(kick.redemptions[1]!.status).toBe('accepted');
      expect((await view(c.body.id))!.ticketCount).toBe(2);
    });

    it('won’t start bonus tickets without Kick’s channel:rewards:write permission (reauthorize first)', async () => {
      h.db
        .prepare("UPDATE platform_connections SET granted_scopes = ? WHERE platform = 'kick' AND role = 'primary'")
        .run(JSON.stringify(['user:read', 'channel:read', 'events:subscribe']));
      const res = await start({ prize: 'p', kickReward: reward });
      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/channel:rewards:write.*Reauthorize main account/);
      expect((await state()).giveaways).toEqual([]);
      expect((await state()).kickRewards.available).toBe(false);
    });

    it('if Kick refuses to create the reward, nothing is left running', async () => {
      for (let i = 0; i < 50; i++) kick.rewards.set(`X${i}`, { id: `X${i}`, title: 't', description: '', cost: 1, is_enabled: true, is_paused: false, should_redemptions_skip_request_queue: false });
      const res = await start({ prize: 'p', kickReward: reward });
      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/^Not started: Kick couldn’t create the Channel Points reward .*Channel reward limit reached/);
      expect((await state()).giveaways).toEqual([]);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM giveaways').get()).toEqual({ n: 0 });
      expect(kick.posted).toEqual([]); // nothing was announced
    });

    it('cancel removes the reward from Kick and rejects pending redemptions', async () => {
      const c = await start({ prize: 'p', kickReward: reward });
      const rewardId = c.body.kickReward!.rewardId!;
      kick.redeem(rewardId, viewer(1)); // pending, webhook not delivered yet
      await h.call('POST', `/api/giveaways/${c.body.id}/cancel`);
      await settle();
      expect(kick.rewards.has(rewardId)).toBe(false);
      expect(kick.redemptions[0]!.status).toBe('rejected');
    });
  });

  describe('Kick chat messages, edited before they are sent', () => {
    const saveMessages = (body: unknown) => h.call<GiveawaysState>('POST', '/api/giveaways/kick-messages', { body }) as Promise<Res<GiveawaysState>>;
    const issue = async (body: unknown) =>
      ((await saveMessages(body)).body as unknown as { error?: { issues?: Array<{ path: string; message: string }> } }).error?.issues?.[0];

    it('the defaults are offered, and saving checks every message and sends nothing', async () => {
      expect((await state()).kickMessages.entered).toBe('{user} has entered the giveaway!');
      expect((await h.call('POST', '/api/giveaways/kick-messages', { withoutLocalKey: true, body: { entered: 'x' } })).status).toBe(401);
      expect(await issue({ entered: '!enter to win' })).toMatchObject({ path: 'entered', message: expect.stringMatching(/start with/) });
      expect(await issue({ winners: 'Won: {winners} with {tickets} tickets' })).toMatchObject({ path: 'winners', message: expect.stringMatching(/\{tickets\} isn’t a variable/) });
      expect(await issue({ closed: 'Odds were {odds}' })).toMatchObject({ path: 'closed' });
      expect(await issue({ closedReply: 'Closed for {prize}' })).toMatchObject({ message: expect.stringMatching(/no variables/) });
      expect(await issue({ started: 'two\nlines' })).toMatchObject({ path: 'started' });
      expect(await issue({ started: 'x'.repeat(501) })).toMatchObject({ message: expect.stringMatching(/500/) });
      expect(await issue({ entered: '   ' })).toMatchObject({ path: 'entered' });
      expect((await saveMessages({})).status).toBe(400);
      expect((await saveMessages({ bogus: 'x' })).status).toBe(400);
      // A rejected save changes nothing.
      expect((await state()).kickMessages.entered).toBe('{user} has entered the giveaway!');
      const ok = await saveMessages({ entered: '  {user} is in for {prize}!  ' });
      expect(ok.status).toBe(200);
      expect(ok.body.kickMessages.entered).toBe('{user} is in for {prize}!');
      await settle();
      expect(kick.posted).toEqual([]); // saving sends nothing
      expect(auditActions(h).some((a) => a.action === 'giveaway.messages_updated')).toBe(true);
    });

    it('exactly the saved text is posted for every message, with its variables filled in; never tickets or odds', async () => {
      const saved = await saveMessages({
        started: 'New giveaway for {prize}! {how_to_enter}. {winners_note} {reward_note} {closes_note}',
        entered: 'Good luck {user}, you are in for {prize}',
        closed: 'Time is up for {prize}!',
        winners: '{winner_label}: {winners} won {prize}',
        redraw: 'Redraw for {prize}: {winner}',
        closedReply: 'Sorry, too late!',
      });
      expect(saved.status).toBe(200);
      const c = await start({ prize: 'Gift card', winnerCount: 2, durationMinutes: 10 });
      await say('!enter', viewer(1));
      await say('!enter', viewer(2));
      await say('!enter', viewer(3));
      await posts(4);
      expect((await act(c.body.id, 'end')).body.status).toBe('closed');
      await say('!enter', viewer(4)); // just after closing
      const drawn = await act(c.body.id, 'draw');
      const [w1, w2] = drawn.body.winners;
      const out = await posts(7);
      expect(out.slice(0, 4)).toEqual([
        'New giveaway for Gift card! type !enter in chat. 2 winners. Entries close in 10 minutes.',
        'Good luck Viewer1, you are in for Gift card',
        'Good luck Viewer2, you are in for Gift card',
        'Good luck Viewer3, you are in for Gift card',
      ]);
      expect(out.slice(4, 7)).toEqual(['Time is up for Gift card!', 'Sorry, too late!', `Winners: @${w1!.displayName}, @${w2!.displayName} won Gift card`]);
      const redrawn = await act(c.body.id, 'redraw', { winnerId: w1!.id });
      const replacement = redrawn.body.winners.find((w) => w.status === 'won' && w.displayName !== w2!.displayName)!;
      expect((await posts(8)).at(-1)).toBe(`Redraw for Gift card: @${replacement.displayName}`);
      expect(kick.posted.map((p) => p.content).join(' ')).not.toMatch(/ticket|odds|chance|%/i);
    });

    it('Reset restores a default, and saved messages survive a restart', async () => {
      await saveMessages({ closed: 'Closed: {prize}', closedReply: 'Nope' });
      await h.restart();
      expect((await state()).kickMessages).toMatchObject({ closed: 'Closed: {prize}', closedReply: 'Nope' });
      const reset = await saveMessages({ closed: null });
      expect(reset.body.kickMessages).toMatchObject({ closed: 'Entries for {prize} are now closed. Winners will be drawn soon.', closedReply: 'Nope' });
      // Saving the default text is the same as Reset.
      await saveMessages({ closedReply: 'Giveaway entries are closed.' });
      expect(JSON.parse(String((h.db.prepare("SELECT value FROM app_settings WHERE key = 'giveaways.kick_messages'").get() as { value: string }).value))).toEqual({});
    });

    it('a message that is empty once filled in is not posted (and the announcement says why)', async () => {
      await saveMessages({ started: '{reward_note}' });
      const c = await start({ prize: 'p' });
      await settle();
      expect(kick.posted).toEqual([]);
      expect((await view(c.body.id))!.announcement).toMatchObject({ kind: 'started', outcome: 'skipped', detail: expect.stringMatching(/empty/) });
    });
  });
});

describe('Discord: no /enter (simulated Discord)', () => {
  let discord: FakeDiscord;
  let gateway: FakeGateway;

  beforeEach(async () => {
    discord = new FakeDiscord();
    gateway = new FakeGateway();
    h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
    discord.botGuilds = [{ id: '42', name: 'Retro Server' }];
    gateway.guilds = [{ id: '42', name: 'Retro Server' }];
    await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
    const end = Date.now() + 2000;
    for (;;) {
      const s = (await h.call<DiscordSetupState>('GET', '/api/discord/setup')).body;
      if (s.bot.status === 'connected' && s.commands.status === 'registered') break;
      if (Date.now() > end) throw new Error('bot never became ready');
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it('/enter is not registered, and an old /enter interaction enters nobody', async () => {
    expect(discord.guildCommands.get('42')!.map((cmd) => cmd.name)).not.toContain('enter');
    const g = h.services.giveaways.create({ prize: 'Nitro', platforms: ['kick'] });
    const i = await gateway.interact({ commandName: 'enter', userId: '900000000000000001', userName: 'fan' });
    expect(i.replies).toEqual([{ content: 'This command is not available anymore.', ephemeral: true }]);
    expect((await view(g.id))!.entryCount).toBe(0);
  });

  it('/ping answers with the connected Discord bot’s own name', async () => {
    const i = await gateway.interact({ commandName: 'ping' });
    expect(i.replies).toEqual([{ content: 'Pong! I’m connected and ready!' }]);
    expect(JSON.stringify(i.replies)).not.toMatch(/CONDUIT|RetroBotKick/);
  });

  it('a Discord giveaway can’t start without its announcement channel', async () => {
    const res = await start({ prize: 'Nitro', platforms: ['discord'] });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/^Not started: choose the Discord channel/);
    expect((await state()).giveaways).toEqual([]);
  });
});
