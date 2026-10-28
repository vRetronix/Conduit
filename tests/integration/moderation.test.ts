/**
 * Moderation end to end against simulated platforms (automated, mocked — not proof of live Kick or Discord behaviour):
 * capabilities from real scopes/role permissions, user lookup, manual actions and their failures, the history of
 * actions taken through CONDUIT, and Kick automated protection from signed webhook deliveries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOMOD_DEFAULTS, type AutomodSettings, type AutomodState, type DiscordModerationState, type ModerationLookupResult, type ModerationState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeDiscord } from '../helpers/fake-discord';
import { FakeGateway } from '../helpers/fake-gateway';
import { chatPayload, deliverWebhook, FakeKick, KICK_CLIENT_ID, KICK_CLIENT_SECRET, type FakeKickUser } from '../helpers/fake-kick';
import { auditActions, createHarness, freePort, type Harness } from '../helpers/harness';

let h: Harness;

afterEach(async () => {
  await h.close();
});

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
type ActResult = { ok: boolean; message: string; record: ModerationState['history'][number] };
const state = async () => (await h.call<ModerationState>('GET', '/api/moderation')).body;
const act = (body: Record<string, unknown>) => h.call<ActResult>('POST', '/api/moderation/actions', { body }) as Promise<Res<ActResult>>;
const lookup = (body: Record<string, unknown>) => h.call<ModerationLookupResult>('POST', '/api/moderation/lookup', { body }) as Promise<Res<ModerationLookupResult>>;
const saveAutomod = (body: AutomodSettings) => h.call<AutomodState>('POST', '/api/moderation/automod', { body }) as Promise<Res<AutomodState>>;
const historyCount = () => (h.db.prepare('SELECT COUNT(*) AS n FROM moderation_actions').get() as { n: number }).n;

describe('Kick (simulated Kick)', () => {
  let kick: FakeKick;
  let port: number;
  const viewer = (n: number): FakeKickUser => ({ user_id: 5550000 + n, name: `Viewer${n}`, slug: `viewer${n}`, profile_picture: null });

  async function connect(who: FakeKickUser, role: 'primary' | 'bot' = 'primary'): Promise<void> {
    const res = await h.call<{ authorizationUrl: string }>('POST', '/api/connections/kick/connect', { body: { role } });
    const back = kick.approve(new URL(res.body.authorizationUrl), who);
    expect((await fetch(back)).status).toBe(200);
  }
  const say = (content: string, from: FakeKickUser, opts: { messageId?: string; badges?: Array<{ text: string; type: string }> } = {}) =>
    deliverWebhook(kick, port, chatPayload({ content, sender: from, broadcaster: kick.users.streamer, messageId: opts.messageId, badges: opts.badges ?? [] }));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 40));
    await h.services.moderation.idle();
  };
  /** The main account's granted scopes, as an older authorization would have them. */
  const setScopes = (scopes: string[]) =>
    h.db.prepare("UPDATE platform_connections SET granted_scopes = ? WHERE platform = 'kick' AND role = 'primary'").run(JSON.stringify(scopes));

  beforeEach(async () => {
    kick = new FakeKick();
    for (let n = 1; n <= 5; n++) kick.directory.set(`viewer${n}`, viewer(n));
    port = await freePort();
    h = await createHarness({ CONDUIT_KICK_WEBHOOK_PORT: String(port) }, { vault: new MemoryVault(), fetch: kick.fetch });
    await h.call('POST', '/api/kick/application', { body: { clientId: KICK_CLIENT_ID, clientSecret: KICK_CLIENT_SECRET } });
    await connect(kick.users.streamer);
    await h.call('POST', '/api/kick/chatbot', { body: { mode: 'separate' } });
    await connect(kick.users.bot, 'bot');
    await h.services.kickChat.start();
  });

  describe('manual moderation', () => {
    it('reports the channel and what the main account can do; history starts empty and says nothing it can’t know', async () => {
      const s = await state();
      expect(s.kick).toMatchObject({ connected: true, accountName: 'RetroLive', channel: 'retrolive' });
      expect(s.kick.capabilities.timeout).toEqual({ available: true, problem: null });
      expect(s.kick.capabilities.delete_message.available).toBe(true);
      expect(s.kick.capabilities.untimeout).toMatchObject({ available: false, problem: expect.stringMatching(/Unban/) });
      expect(s.history).toEqual([]);
      expect(s.automod.discord).toMatchObject({ supported: false, reason: expect.stringMatching(/Discord Bot → Protection: CONDUIT’s own AutoMod rules and message checks/) });
      expect((await h.call('GET', '/api/moderation', { withoutLocalKey: true })).status).toBe(401);
    });

    it('looks users up by username (Kick’s channel lookup), not by guessing', async () => {
      expect((await lookup({ platform: 'kick', username: '@Viewer1' })).body).toMatchObject({ platform: 'kick', userId: '5550001', username: 'viewer1' });
      const missing = await lookup({ platform: 'kick', username: 'nobody_here' });
      expect(missing.status).toBe(404);
      expect(missing.body.error?.message).toMatch(/No Kick user named/);
      expect((await lookup({ platform: 'kick', username: 'bad name!' })).status).toBe(400);
    });

    it('timeout, ban and unban are sent as the channel owner, confirmed by Kick, and recorded', async () => {
      const t = await act({ platform: 'kick', action: 'timeout', userId: '5550001', username: 'viewer1', durationSeconds: 600, reason: 'Spoilers' });
      expect(t.status).toBe(200);
      expect(t.body).toMatchObject({ ok: true, message: 'viewer1 is timed out for 10 minutes in retrolive’s Kick chat.' });
      expect(kick.bans.get(5550001)).toEqual({ duration: 10, reason: 'Spoilers', by: 'RetroLive' });
      const b = await act({ platform: 'kick', action: 'ban', userId: '5550002', username: 'viewer2' });
      expect(b.body.ok).toBe(true);
      expect(kick.bans.get(5550002)).toMatchObject({ duration: null, reason: null });
      expect((await act({ platform: 'kick', action: 'unban', userId: '5550002', username: 'viewer2' })).body.ok).toBe(true);
      expect(kick.bans.has(5550002)).toBe(false);
      const history = (await state()).history;
      expect(history.map((r) => [r.action, r.targetName, r.outcome, r.source, r.actor, r.place])).toEqual([
        ['unban', 'viewer2', 'success', 'manual', 'RetroLive', 'retrolive'],
        ['ban', 'viewer2', 'success', 'manual', 'RetroLive', 'retrolive'],
        ['timeout', 'viewer1', 'success', 'manual', 'RetroLive', 'retrolive'],
      ]);
      expect(history[2]).toMatchObject({ durationSeconds: 600, reason: 'Spoilers', detail: null });
      expect(auditActions(h).filter((a) => a.action === 'moderation.action')).toHaveLength(3);
    });

    it('a refusal from Kick is reported as a failure with Kick’s reason, and recorded as failed', async () => {
      kick.protectedUsers.set(5550003, 'Cannot ban a moderator');
      const res = await act({ platform: 'kick', action: 'ban', userId: '5550003', username: 'viewer3' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, message: expect.stringMatching(/Cannot ban a moderator/) });
      const notBanned = await act({ platform: 'kick', action: 'unban', userId: '5550004', username: 'viewer4' });
      expect(notBanned.body).toMatchObject({ ok: false, message: expect.stringMatching(/User is not banned/) });
      expect((await state()).history.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    });

    it('deletes a message from chat', async () => {
      await say('buy followers at example dot com', viewer(1), { messageId: 'msg-to-delete' });
      const res = await act({ platform: 'kick', action: 'delete_message', userId: '5550001', username: 'Viewer1', messageId: 'msg-to-delete' });
      expect(res.body).toMatchObject({ ok: true, message: 'The message was deleted in retrolive’s Kick chat.' });
      expect(kick.deletedMessages).toEqual(['msg-to-delete']);
      const again = await act({ platform: 'kick', action: 'delete_message', userId: '5550001', username: 'Viewer1', messageId: 'msg-to-delete' });
      expect(again.body).toMatchObject({ ok: false, message: expect.stringMatching(/couldn’t find that message/) });
    });

    it('invalid requests are refused before anything is sent to Kick, and nothing is recorded', async () => {
      const sent = kick.requests.length;
      const bad = async (body: Record<string, unknown>) => (await act(body)).status;
      expect(await bad({ platform: 'kick', action: 'timeout', userId: '5550001', username: 'viewer1', durationSeconds: 90 })).toBe(400); // whole minutes
      expect(await bad({ platform: 'kick', action: 'timeout', userId: '5550001', username: 'viewer1', durationSeconds: 8 * 86_400 })).toBe(400);
      expect(await bad({ platform: 'kick', action: 'untimeout', userId: '5550001', username: 'viewer1' })).toBe(400); // not a Kick action
      expect(await bad({ platform: 'kick', action: 'ban', userId: 'abc', username: 'viewer1' })).toBe(400);
      expect(await bad({ platform: 'kick', action: 'ban', userId: '5550001', username: 'viewer1', reason: 'x'.repeat(101) })).toBe(400);
      expect(await bad({ platform: 'kick', action: 'nuke', userId: '5550001', username: 'viewer1' })).toBe(400);
      const self = await act({ platform: 'kick', action: 'ban', userId: String(kick.users.streamer.user_id), username: 'retrolive' });
      expect(self.status).toBe(400);
      expect(self.body.error?.message).toMatch(/own channel account/);
      expect(kick.requests.slice(sent).some((r) => r.url.includes('/moderation/'))).toBe(false);
      expect(historyCount()).toBe(0);
    });

    it('without the moderation scopes, actions are unavailable and say to reauthorize; nothing is sent', async () => {
      setScopes(['user:read', 'channel:read', 'events:subscribe', 'channel:rewards:write']); // authorized before moderation existed
      const s = await state();
      expect(s.kick.capabilities.ban).toMatchObject({ available: false, problem: expect.stringMatching(/moderation:ban.*Reauthorize main account/) });
      expect(s.kick.capabilities.delete_message.problem).toMatch(/moderation:chat_message:manage/);
      const res = await act({ platform: 'kick', action: 'ban', userId: '5550001', username: 'viewer1' });
      expect(res.status).toBe(403);
      expect(kick.bans.size).toBe(0);
      expect(historyCount()).toBe(0);
    });

    it('with no main Kick account, Kick moderation explains what to connect', async () => {
      await h.call('POST', '/api/connections/kick/disconnect', { body: { role: 'primary' } });
      const s = await state();
      expect(s.kick).toMatchObject({ connected: false, problem: expect.stringMatching(/Connect your main Kick account/) });
      const res = await act({ platform: 'kick', action: 'ban', userId: '5550001', username: 'viewer1' });
      expect(res.status).toBe(503);
    });
  });

  describe('automated protection', () => {
    // What the dashboard would send (the backend fills in what's left out, like the newer checks' fields).
    const settings = (over: Record<string, unknown> = {}): Record<string, unknown> & AutomodSettings => ({ ...structuredClone(AUTOMOD_DEFAULTS), enabled: true, ...over }) as Record<string, unknown> & AutomodSettings;

    it('is off by default: nothing is checked or recorded', async () => {
      expect((await state()).automod.kick).toEqual(AUTOMOD_DEFAULTS);
      await say('spam spam spam', viewer(1));
      await say('spam spam spam', viewer(1));
      await say('spam spam spam', viewer(1));
      await settle();
      expect(historyCount()).toBe(0);
      expect((await state()).automod.stats.checked).toBe(0);
    });

    it('log only: records a flag and changes nothing on Kick; a re-delivered event is checked once', async () => {
      expect((await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['Bad Word'], action: 'log', timeoutMinutes: 5 } }))).status).toBe(200);
      await say('this has a bad word in it', viewer(1), { messageId: 'm-1' });
      await say('this has a bad word in it', viewer(1), { messageId: 'm-1' }); // duplicate delivery
      await settle();
      const s = await state();
      expect(s.history).toHaveLength(1);
      expect(s.history[0]).toMatchObject({ action: 'flag', outcome: 'logged', source: 'automod', rule: 'blocked_terms', targetName: 'Viewer1' });
      expect(kick.deletedMessages).toEqual([]);
      expect(kick.bans.size).toBe(0);
      expect(s.automod.stats).toMatchObject({ checked: 1, matched: 1 });
    });

    it('delete: removes each matching message; whole words only; moderators, the owner and the chatbot are never acted on', async () => {
      await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['scam'], action: 'delete_message', timeoutMinutes: 5 } }));
      await say('this is a SCAM!', viewer(1), { messageId: 'a1' });
      await say('scam again', viewer(1), { messageId: 'a2' });
      await say('a scampi recipe', viewer(2), { messageId: 'a3' }); // not the word
      await say('scam talk', viewer(3), { messageId: 'a4', badges: [{ text: 'Moderator', type: 'moderator' }] });
      await say('scam', kick.users.streamer, { messageId: 'a5' });
      await say('scam', kick.users.bot, { messageId: 'a6' });
      await settle();
      expect(kick.deletedMessages).toEqual(['a1', 'a2']);
      const history = (await state()).history;
      expect(history.map((r) => [r.action, r.outcome, r.rule])).toEqual([
        ['delete_message', 'success', 'blocked_terms'],
        ['delete_message', 'success', 'blocked_terms'],
      ]);
      expect(history[0]!.reason).toMatch(/^Automated: /);
    });

    it('repeated messages time the user out once (no loop), using Kick minutes', async () => {
      await saveAutomod(settings({ repeat: { enabled: true, count: 3, windowSeconds: 30, action: 'timeout', timeoutMinutes: 2 } }));
      for (let i = 0; i < 6; i++) await say('FOLLOW   me', viewer(1), { messageId: `r${i}` });
      await say('follow me', viewer(2), { messageId: 'other' }); // someone else, once
      await settle();
      expect(kick.bans.get(5550001)).toMatchObject({ duration: 2, reason: expect.stringMatching(/^Automated: The same message 3 times/) });
      expect(kick.bans.has(5550002)).toBe(false);
      expect((await state()).history.filter((r) => r.action === 'timeout')).toHaveLength(1); // the cooldown stops repeats
    });

    it('flooding is detected per user', async () => {
      await saveAutomod(settings({ spam: { enabled: true, maxMessages: 4, windowSeconds: 10, action: 'log', timeoutMinutes: 1 }, repeat: { ...AUTOMOD_DEFAULTS.repeat, enabled: false } }));
      for (let i = 0; i < 5; i++) await say(`message number ${i}`, viewer(1), { messageId: `s${i}` });
      for (let i = 0; i < 3; i++) await say(`hello ${i}`, viewer(2), { messageId: `t${i}` });
      await settle();
      expect((await state()).history.map((r) => [r.rule, r.targetName])).toEqual([['spam', 'Viewer1']]);
    });

    it('ignored users are never checked (by Kick username, any case)', async () => {
      await saveAutomod(settings({ ignoredUsers: ['@VIEWER2'], blockedTerms: { enabled: true, terms: ['scam'], action: 'delete_message', timeoutMinutes: 5 } }));
      expect((await state()).automod.kick.ignoredUsers).toEqual(['viewer2']);
      await say('scam', viewer(2), { messageId: 'i1' });
      await say('scam', viewer(1), { messageId: 'i2' });
      await settle();
      expect(kick.deletedMessages).toEqual(['i2']);
      expect((await saveAutomod(settings({ ignoredUsers: ['not a name!'] }))).status).toBe(400);
    });

    it('settings saved before "ignored users" existed still load (nothing is reset)', async () => {
      const old = { ...settings({ blockedTerms: { enabled: true, terms: ['spoiler'], action: 'log', timeoutMinutes: 5 } }) } as Record<string, unknown>;
      delete old.ignoredUsers;
      h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('moderation.automod', ?, 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(old));
      const s = (await h.call<{ automod: AutomodState }>('GET', '/api/moderation/kick')).body.automod.kick;
      expect(s).toMatchObject({ enabled: true, ignoredUsers: [], blockedTerms: { terms: ['spoiler'] } });
    });

    it('the Kick page state has protection and Kick-only logs (no chat messages)', async () => {
      await say('hello', viewer(1), { messageId: 'k1' });
      const s = (await h.call<import('@conduit/shared').KickModerationState>('GET', '/api/moderation/kick')).body;
      expect(s).toMatchObject({ connected: true, channel: 'retrolive', chat: { status: 'connected' } });
      expect(JSON.stringify(s)).not.toContain('k1');
      expect(s.history).toEqual([]);
      expect(s.automod.kick.enabled).toBe(false);
    });

    it('CONDUIT’s own messages never trigger it (loop protection)', async () => {
      await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['giveaway'], action: 'delete_message', timeoutMinutes: 5 } }));
      await h.call('POST', '/api/kick/chat/send', { body: { content: 'giveaway starts soon' } });
      // Kick echoes the chatbot's own message back as a chat event.
      await say('giveaway starts soon', kick.users.bot, { messageId: 'echo' });
      await settle();
      expect(kick.deletedMessages).toEqual([]);
      expect(historyCount()).toBe(0);
    });

    it('an action the account can’t perform can’t be chosen (explained), and settings are validated', async () => {
      setScopes(['user:read', 'channel:read', 'events:subscribe', 'channel:rewards:write', 'moderation:ban']);
      const s = await state();
      expect(s.automod.kickActions.delete_message).toMatchObject({ available: false, problem: expect.stringMatching(/moderation:chat_message:manage/) });
      expect(s.automod.kickActions.timeout.available).toBe(true);
      const refused = await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['x'], action: 'delete_message', timeoutMinutes: 5 } }));
      expect(refused.status).toBe(400);
      expect(refused.body.error?.issues?.[0]).toMatchObject({ path: 'blockedTerms.action', message: expect.stringMatching(/Reauthorize/) });
      expect((await saveAutomod({ ...settings(), repeat: { ...AUTOMOD_DEFAULTS.repeat, count: 1 } })).status).toBe(400);
      expect((await saveAutomod({ ...settings(), spam: { ...AUTOMOD_DEFAULTS.spam, action: 'ban' as never } })).status).toBe(400);
      expect((await saveAutomod({ ...settings(), blockedTerms: { ...AUTOMOD_DEFAULTS.blockedTerms, terms: ['two\nlines'] } })).status).toBe(400);
      // Nothing was saved by the refused requests.
      expect((await state()).automod.kick.enabled).toBe(false);
      // Saved settings survive a restart.
      expect((await saveAutomod(settings({ blockedTerms: { enabled: true, terms: [' Spoiler ', 'spoiler'], action: 'timeout', timeoutMinutes: 3 } }))).status).toBe(200);
      await h.restart();
      expect((await state()).automod.kick.blockedTerms).toEqual({ enabled: true, terms: ['spoiler'], regexPatterns: [], allowList: [], action: 'timeout', timeoutMinutes: 3 });
      expect(auditActions(h).some((a) => a.action === 'moderation.automod_updated')).toBe(true);
    });
  });

  /** Protection on, with these settings (the backend fills in what's left out). */
  const settings = (over: Record<string, unknown> = {}): Record<string, unknown> & AutomodSettings => ({ ...structuredClone(AUTOMOD_DEFAULTS), enabled: true, ...over }) as Record<string, unknown> & AutomodSettings;

  describe('more checks (wildcards, links, caps, emotes, symbols, long messages)', () => {
    const history = async () => (await h.call<import('@conduit/shared').KickModerationState>('GET', '/api/moderation/kick')).body.history;

    it('blocked words: * wildcards, regular expressions and allowed words, whatever the capitals or fonts', async () => {
      await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['scam*'], regexPatterns: ['fr[e3]{2}\\s*nitro'], allowList: ['scampi'], action: 'delete_message', timeoutMinutes: 5 } }));
      await say('total SCAMMER here', viewer(1), { messageId: 'w1' });
      await say('I love scampi', viewer(2), { messageId: 'w2' });
      await say('get FRE3 nitro now', viewer(3), { messageId: 'w3' });
      await say('𝐬𝐜𝐚𝐦 alert', viewer(4), { messageId: 'w4' }); // mathematical bold letters
      await settle();
      expect(kick.deletedMessages.sort()).toEqual(['w1', 'w3', 'w4']);
      // A deletion's reason says what it matched.
      expect((await history()).find((r) => r.targetName === 'Viewer1')?.reason).toBe('Automated: Matched a blocked word or phrase (“scam*”).');
    });

    it('links: any link except to the sites you allow (and their subdomains)', async () => {
      await saveAutomod(settings({ links: { enabled: true, allowedSites: ['kick.com', 'youtube.com'], action: 'delete_message', timeoutMinutes: 5 } }));
      await say('watch https://www.youtube.com/watch?v=1', viewer(1), { messageId: 'l1' });
      await say('my channel kick.com/viewer2', viewer(2), { messageId: 'l2' });
      await say('free skins at free-skins.gg/claim', viewer(3), { messageId: 'l3' });
      await say('go to https://evil.example/x', viewer(4), { messageId: 'l4' });
      await settle();
      expect(kick.deletedMessages.sort()).toEqual(['l3', 'l4']);
      const rows = await history();
      expect(rows.every((r) => r.rule === 'links')).toBe(true);
      expect(rows.map((r) => r.reason).sort()).toEqual(['Automated: Posted a link (evil.example).', 'Automated: Posted a link (free-skins.gg).']);
    });

    it('caps, emote spam, symbol spam and long messages are logged under their own names', async () => {
      await saveAutomod(
        settings({
          caps: { enabled: true, minLetters: 12, percent: 80, action: 'log', timeoutMinutes: 1 },
          emotes: { enabled: true, maxEmotes: 3, action: 'log', timeoutMinutes: 1 },
          symbols: { enabled: true, percent: 50, action: 'log', timeoutMinutes: 1 },
          longMessage: { enabled: true, maxLength: 40, action: 'log', timeoutMinutes: 1 },
        }),
      );
      await say('WHY IS NOBODY TALKING TO ME', viewer(1));
      await say('[emote:37226:KEKW] [emote:37226:KEKW] [emote:1:LUL] 😂😂', viewer(2));
      await say('!!!!!!$$$######@@@@', viewer(3));
      await say('this is a perfectly calm message but it goes on and on and on for far too long', viewer(4));
      await say('hello friends', viewer(5));
      await settle();
      const rows = await history();
      expect(Object.fromEntries(rows.map((r) => [r.targetName, [r.rule, r.outcome]]))).toEqual({
        Viewer1: ['caps', 'logged'],
        Viewer2: ['emotes', 'logged'],
        Viewer3: ['symbols', 'logged'],
        Viewer4: ['long_message', 'logged'],
      });
      expect(rows.find((r) => r.targetName === 'Viewer2')?.detail).toBe('5 emotes in one message (more than 3).');
      expect(kick.deletedMessages).toEqual([]);
    });

    it('settings saved before these checks existed still load, with them switched off', async () => {
      const old = { ...settings() } as Record<string, unknown>;
      for (const k of ['links', 'caps', 'emotes', 'symbols', 'longMessage', 'raid']) delete old[k];
      delete (old.blockedTerms as Record<string, unknown>).regexPatterns;
      delete (old.blockedTerms as Record<string, unknown>).allowList;
      h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('moderation.automod', ?, 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(old));
      const s = (await h.call<{ automod: AutomodState }>('GET', '/api/moderation/kick')).body.automod.kick;
      expect(s).toMatchObject({ enabled: true, links: { enabled: false, allowedSites: ['kick.com'] }, caps: { enabled: false }, raid: { enabled: false }, blockedTerms: { regexPatterns: [], allowList: [] } });
    });
  });

  describe('raid mode', () => {
    const raid = (over: Record<string, unknown> = {}) => ({ enabled: true, newChatters: 3, windowSeconds: 60, durationMinutes: 5, action: 'delete_message', timeoutMinutes: 5, announcement: 'Raid protection is on.', ...over });
    const kickState = async () => (await h.call<import('@conduit/shared').KickModerationState>('GET', '/api/moderation/kick')).body;
    /** CONDUIT has known the chat for a while: 25 regulars, the first seen 3 hours ago. */
    const learned = () => {
      const since = new Date(h.clock.now().getTime() - 3 * 3600_000).toISOString();
      h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('kick.chatters.since', ?, 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(since);
      for (let i = 0; i < 25; i++) h.db.prepare('INSERT INTO kick_chatters (user_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(String(7770000 + i), `regular${i}`, since, since);
    };

    it('waits until it knows your regulars: first-time chatters right after it starts learning don’t start it', async () => {
      await saveAutomod(settings({ raid: raid() }));
      for (let n = 1; n <= 4; n++) await say('hi', viewer(n));
      await settle();
      const s = await kickState();
      expect(s.automod.raid).toMatchObject({ activeUntil: null, learning: true, knownChatters: 4 });
      expect(kick.posted.map((p) => p.content)).not.toContain('Raid protection is on.');
    });

    it('starts when many first-time chatters arrive; says so in chat; their links (or anything a check matches) are removed; regulars aren’t affected', async () => {
      learned();
      await saveAutomod(settings({ raid: raid() }));
      await say('hi', viewer(1));
      await say('hi', viewer(2));
      await say('hi', viewer(3));
      await settle();
      expect((await kickState()).automod.raid.activeUntil).not.toBeNull();
      expect(kick.posted.map((p) => p.content)).toContain('Raid protection is on.');
      await say('join my server free-stuff.gg', viewer(2), { messageId: 'r1' });
      await say('look kick.com/clip', viewer(3), { messageId: 'r2' }); // an allowed site
      await say('the link is free-stuff.gg', { user_id: 7770001, name: 'regular1', slug: 'regular1', profile_picture: null }, { messageId: 'r3' });
      await settle();
      expect(kick.deletedMessages).toEqual(['r1']);
      const [e] = (await kickState()).history;
      expect(e).toMatchObject({ rule: 'raid', action: 'delete_message', outcome: 'success', targetName: 'Viewer2' });
      expect(e!.reason).toBe('Automated: First-time chatter during raid mode. Posted a link (free-stuff.gg).');
      // Ended from the dashboard.
      expect((await h.call<AutomodState>('POST', '/api/moderation/raid', { body: { active: false } })).body.raid.activeUntil).toBeNull();
    });

    it('can be started from the dashboard, only when switched on', async () => {
      expect((await h.call('POST', '/api/moderation/raid', { body: { active: true } })).status).toBe(409);
      await saveAutomod(settings({ raid: raid() }));
      const on = await h.call<AutomodState>('POST', '/api/moderation/raid', { body: { active: true } });
      expect(on.body.raid.activeUntil).not.toBeNull();
      expect((await h.call('POST', '/api/moderation/raid', { body: { active: 'yes' } })).status).toBe(400);
    });
  });

  describe('moderation done on Kick itself', () => {
    const banned = (who: FakeKickUser, o: { by?: string; reason?: string; minutes?: number } = {}) => {
      const at = new Date();
      return deliverWebhook(
        kick,
        port,
        {
          broadcaster: { user_id: kick.users.streamer.user_id, username: kick.users.streamer.name },
          moderator: { user_id: 4242, username: o.by ?? 'SomeMod' },
          banned_user: { user_id: who.user_id, username: who.name },
          metadata: { reason: o.reason ?? 'spam', created_at: at.toISOString(), expires_at: o.minutes ? new Date(at.getTime() + o.minutes * 60_000).toISOString() : null },
        },
        { type: 'moderation.banned' },
      );
    };
    const kickHistory = async () => (await h.call<import('@conduit/shared').KickModerationState>('GET', '/api/moderation/kick')).body.history;

    it('subscribes to Kick’s ban events; bans and timeouts by moderators or other bots are in the Logs', async () => {
      expect(kick.subscriptions.map((s) => s.event)).toContain('moderation.banned');
      expect((await h.call<import('@conduit/shared').KickModerationState>('GET', '/api/moderation/kick')).body.automod.kickModerationEvents).toEqual({ ok: true, problem: null });
      expect(await banned(viewer(1), { minutes: 10, by: 'ModAlice', reason: 'rude' })).toBe(200);
      expect(await banned(viewer(2), { by: 'Botrix' })).toBe(200);
      await settle();
      const rows = await kickHistory();
      expect(rows.map((r) => [r.targetName, r.action, r.durationSeconds, r.source, r.actor, r.reason])).toEqual([
        ['Viewer2', 'ban', null, 'platform', 'Botrix', 'spam'],
        ['Viewer1', 'timeout', 600, 'platform', 'ModAlice', 'rude'],
      ]);
    });

    it('CONDUIT’s own timeouts aren’t listed twice when Kick reports them back', async () => {
      await saveAutomod(settings({ repeat: { enabled: true, count: 2, windowSeconds: 30, action: 'timeout', timeoutMinutes: 2 } }));
      await say('same', viewer(3));
      await say('same', viewer(3));
      await settle();
      await banned(viewer(3), { minutes: 2, by: 'RetroLive' });
      await settle();
      const rows = (await kickHistory()).filter((r) => r.targetName === 'Viewer3');
      expect(rows.map((r) => [r.action, r.source])).toEqual([['timeout', 'automod']]);
    });
  });

  describe('one person’s history', () => {
    it('everything recorded for one Kick user, and nobody else’s', async () => {
      await saveAutomod(settings({ blockedTerms: { enabled: true, terms: ['spoiler'], action: 'log', timeoutMinutes: 5 } }));
      await say('spoiler alert', viewer(1));
      await say('spoiler again', viewer(2));
      await settle();
      const res = await h.call<import('@conduit/shared').ModerationUserHistory>('POST', '/api/moderation/user-history', { body: { platform: 'kick', userId: String(viewer(1).user_id) } });
      expect(res.status).toBe(200);
      expect(res.body.history.map((r) => r.targetName)).toEqual(['Viewer1']);
      expect((await h.call('POST', '/api/moderation/user-history', { body: { platform: 'kick', userId: 'not-an-id' } })).status).toBe(400);
    });
  });
});

describe('Discord (simulated Discord)', () => {
  const GUILD = '700000000000000001';
  const CHANNEL = '700000000000000101';
  const FAN = '900000000000000011';
  const BOSS = '900000000000000012';
  const STRANGER = '900000000000000013';
  let discord: FakeDiscord;
  let gateway: FakeGateway;
  const link = (messageId: string) => `https://discord.com/channels/${GUILD}/${CHANNEL}/${messageId}`;

  beforeEach(async () => {
    discord = new FakeDiscord();
    gateway = new FakeGateway();
    discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
    gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
    discord.addServerWithChannels(GUILD, [{ id: CHANNEL, name: 'general' }]);
    discord.addMember(GUILD, { id: FAN, username: 'fan', global_name: 'Fan One' });
    discord.addMember(GUILD, { id: BOSS, username: 'boss' }, { above: true });
    discord.users.set(STRANGER, { id: STRANGER, username: 'stranger', global_name: null });
    h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
    await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
  });

  it('capabilities come from the bot’s roles; without them nothing is attempted', async () => {
    const s = await state();
    expect(s.discord).toMatchObject({ connected: true, botName: expect.any(String) });
    const guild = s.discord.guilds.find((g) => g.id === GUILD)!;
    expect(guild.capabilities.timeout).toMatchObject({ available: false, problem: expect.stringMatching(/Timeout Members.*Retro Server/) });
    expect(guild.capabilities.ban.problem).toMatch(/Ban Members/);
    expect(guild.capabilities.delete_message.problem).toMatch(/Manage Messages/);
    expect(guild.capabilities.lookup.available).toBe(true);
    const res = await act({ platform: 'discord', action: 'ban', guildId: GUILD, userId: FAN });
    expect(res.status).toBe(403);
    expect(discord.requests.some((r) => r.url.includes('/bans/'))).toBe(false);
    expect(historyCount()).toBe(0);
  });

  it('timeout and its removal, with the reason in Discord’s audit log', async () => {
    discord.grantBot(GUILD, 1n << 40n);
    const res = await act({ platform: 'discord', action: 'timeout', guildId: GUILD, userId: FAN, durationSeconds: 3600, reason: 'Calm down, please' });
    expect(res.body).toMatchObject({ ok: true, message: 'Fan One is timed out for 1 hour in Retro Server (Discord).' });
    // Until = when it was done + 1 hour (the backend's clock).
    expect(Date.parse(discord.members.get(GUILD)!.get(FAN)!.communication_disabled_until!) - Date.parse(res.body.record.at)).toBe(3600_000);
    const patch = discord.requests.find((r) => r.method === 'PATCH' && r.url.includes(`/members/${FAN}`))!;
    expect(patch.headers['x-audit-log-reason']).toBe(encodeURIComponent('Calm down, please'));
    expect((await lookup({ platform: 'discord', guildId: GUILD, user: `<@${FAN}>` })).body).toMatchObject({ inServer: true, timedOutUntil: expect.any(String), displayName: 'Fan One' });
    expect((await act({ platform: 'discord', action: 'untimeout', guildId: GUILD, userId: FAN })).body.ok).toBe(true);
    expect(discord.members.get(GUILD)!.get(FAN)!.communication_disabled_until).toBeNull();
    expect((await state()).history.map((r) => [r.action, r.targetName, r.place, r.outcome])).toEqual([
      ['untimeout', 'Fan One', 'Retro Server', 'success'],
      ['timeout', 'Fan One', 'Retro Server', 'success'],
    ]);
  });

  it('role hierarchy refusals are failures with an explanation (and recorded)', async () => {
    discord.grantBot(GUILD, (1n << 40n) | (1n << 2n));
    const res = await act({ platform: 'discord', action: 'timeout', guildId: GUILD, userId: BOSS, durationSeconds: 60 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, message: expect.stringMatching(/highest role is at or above the bot’s role/) });
    expect((await state()).history[0]).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/role/) });
  });

  it('ban (also a non-member), unban, and unbanning someone who isn’t banned', async () => {
    discord.grantBot(GUILD, 1n << 2n);
    expect((await act({ platform: 'discord', action: 'ban', guildId: GUILD, userId: FAN, deleteMessageSeconds: 3600 })).body.ok).toBe(true);
    expect(discord.bans.get(GUILD)!.has(FAN)).toBe(true);
    expect(JSON.parse(discord.requests.find((r) => r.method === 'PUT' && r.url.includes('/bans/'))!.body)).toEqual({ delete_message_seconds: 3600 });
    expect((await lookup({ platform: 'discord', guildId: GUILD, user: FAN })).body).toMatchObject({ inServer: false, banned: true });
    expect((await act({ platform: 'discord', action: 'ban', guildId: GUILD, userId: STRANGER })).body.ok).toBe(true);
    expect((await act({ platform: 'discord', action: 'unban', guildId: GUILD, userId: FAN })).body.ok).toBe(true);
    const again = await act({ platform: 'discord', action: 'unban', guildId: GUILD, userId: FAN });
    expect(again.body).toMatchObject({ ok: false, message: 'That user isn’t banned.' });
  });

  it('deletes a message from its link; a link to another server or a bad link is refused', async () => {
    discord.grantBot(GUILD, 1n << 13n);
    const res = await act({ platform: 'discord', action: 'delete_message', messageLink: link('700000000000009999') });
    expect(res.body).toMatchObject({ ok: true, message: 'The message was deleted in Retro Server (Discord).' });
    expect(discord.deletedMessages).toEqual(['700000000000009999']);
    expect((await act({ platform: 'discord', action: 'delete_message', messageLink: 'https://example.com/x' })).status).toBe(400);
    expect((await act({ platform: 'discord', action: 'delete_message', messageLink: `https://discord.com/channels/800000000000000001/${CHANNEL}/1234567890123456789` })).status).toBe(404);
  });

  it('lookup: members, other users and unknown ids; invalid input is explained', async () => {
    expect((await lookup({ platform: 'discord', guildId: GUILD, user: FAN })).body).toMatchObject({ username: 'fan', inServer: true, roleCount: 0, joinedAt: expect.any(String) });
    expect((await lookup({ platform: 'discord', guildId: GUILD, user: STRANGER })).body).toMatchObject({ username: 'stranger', inServer: false, banned: null }); // can't check bans without Ban Members
    expect((await lookup({ platform: 'discord', guildId: GUILD, user: '900000000000000099' })).status).toBe(404);
    const bad = await lookup({ platform: 'discord', guildId: GUILD, user: 'fan#1234' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toMatch(/Copy User ID/);
    expect((await act({ platform: 'discord', action: 'timeout', guildId: GUILD, userId: FAN, durationSeconds: 29 * 86_400 })).status).toBe(400);
    expect((await act({ platform: 'discord', action: 'ban', guildId: GUILD, userId: '223456789012345678' })).status).toBe(400); // the bot itself
  });

  it('without a Discord bot, Discord moderation explains the setup step', async () => {
    await h.close();
    h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
    const s = await state();
    expect(s.discord).toMatchObject({ connected: false, problem: expect.stringMatching(/Set up your Discord bot/), guilds: [] });
    expect((await act({ platform: 'discord', action: 'ban', guildId: GUILD, userId: FAN })).status).toBe(503);
  });
});

describe('Discord moderation commands (simulated Discord gateway and REST)', () => {
  const GUILD = '42';
  const MOD = '555555555555555555'; // the member running the command (fake interaction default)
  const FAN = '900000000000000021';
  const ADMIN = '900000000000000022';
  const OWNER = '900000000000000023';
  const TIMEOUT_MEMBERS = 1n << 40n;
  const BAN_MEMBERS = 1n << 2n;
  let discord: FakeDiscord;
  let gateway: FakeGateway;

  const command = async (
    commandName: string,
    options: Array<{ name: string; type: number; value: unknown }>,
    memberPermissions = TIMEOUT_MEMBERS | BAN_MEMBERS,
    extra: Record<string, unknown> = {},
  ) => {
    const i = await gateway.interact({ commandName, guildId: GUILD, memberPermissions, options, ...extra });
    await h.services.moderation.idle();
    return [...i.replies, ...i.edits];
  };
  const user = (id: string) => ({ name: 'user', type: 6, value: id });
  const discordLog = async () => (await h.call<{ history: ModerationState['history'] }>('GET', '/api/moderation/discord')).body.history;

  beforeEach(async () => {
    discord = new FakeDiscord();
    gateway = new FakeGateway();
    discord.botGuilds = [{ id: GUILD, name: 'Retro Server' }];
    gateway.guilds = [{ id: GUILD, name: 'Retro Server' }];
    discord.addServerWithChannels(GUILD, [{ id: '700000000000000101', name: 'general' }]);
    discord.owners.set(GUILD, OWNER);
    discord.addRole(GUILD, '800000000000000001', 1); // member
    discord.addRole(GUILD, '800000000000000005', 5); // moderator
    discord.addRole(GUILD, '800000000000000009', 9); // admin
    discord.addMember(GUILD, { id: MOD, username: 'retrofan' }, { roles: ['800000000000000005'] });
    discord.addMember(GUILD, { id: FAN, username: 'fan', global_name: 'Fan One' }, { roles: ['800000000000000001'] });
    discord.addMember(GUILD, { id: ADMIN, username: 'boss' }, { roles: ['800000000000000009'] });
    discord.addMember(GUILD, { id: OWNER, username: 'owner' });
    h = await createHarness({}, { vault: new MemoryVault(), fetch: discord.fetch, botFactory: gateway.factory });
    await h.call('POST', '/api/discord/application', { body: { applicationId: CLIENT_ID, clientSecret: CLIENT_SECRET, botToken: BOT_TOKEN } });
    const end = Date.now() + 3000;
    while ((await h.call<{ bot: { status: string } }>('GET', '/api/discord/setup')).body.bot.status !== 'connected' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 15));
    }
  });

  it('/timeout: Discord confirms, then the member gets a private success reply and it is logged under Discord', async () => {
    discord.grantBot(GUILD, TIMEOUT_MEMBERS);
    const replies = await command('timeout', [user(FAN), { name: 'minutes', type: 4, value: 10 }, { name: 'reason', type: 3, value: 'Spam' }]);
    expect(replies).toEqual([{ content: 'I’ve timed out Fan One for 10 minutes.', ephemeral: true }]);
    expect(discord.members.get(GUILD)!.get(FAN)!.communication_disabled_until).not.toBeNull();
    const log = await discordLog();
    expect(log.map((r) => [r.action, r.targetName, r.actor, r.reason, r.outcome, r.source])).toEqual([
      ['timeout', 'Fan One', 'retrofan via /timeout', 'Spam', 'success', 'manual'],
    ]);
    // Platform logs are separate.
    expect((await h.call<{ history: unknown[] }>('GET', '/api/moderation/kick')).body.history).toEqual([]);
    expect(auditActions(h).some((a) => a.action === 'discord.command.used')).toBe(true);
  });

  it('members without the permission are refused by the dispatcher; nothing is sent or logged', async () => {
    discord.grantBot(GUILD, TIMEOUT_MEMBERS | BAN_MEMBERS);
    const replies = await command('ban', [user(FAN)], TIMEOUT_MEMBERS); // has Timeout Members, not Ban Members
    expect(replies).toEqual([{ content: "You don't have permission to use this command.", ephemeral: true }]);
    expect(discord.bans.get(GUILD)?.has(FAN) ?? false).toBe(false);
    expect(await discordLog()).toEqual([]);
  });

  it('Discord’s role hierarchy applies to the member who ran it: not on someone ranked at or above them, nor the owner', async () => {
    discord.grantBot(GUILD, TIMEOUT_MEMBERS | BAN_MEMBERS);
    const above = await command('timeout', [user(ADMIN), { name: 'minutes', type: 4, value: 5 }]);
    expect(above).toEqual([{ content: 'You can’t moderate members whose highest role is the same as or above yours.', ephemeral: true }]);
    expect(await command('ban', [user(OWNER)])).toEqual([{ content: 'The server owner can’t be moderated.', ephemeral: true }]);
    expect(await command('ban', [user(MOD)])).toEqual([{ content: 'You can’t use this on yourself.', ephemeral: true }]);
    expect(discord.requests.some((r) => r.method === 'PATCH' || (r.method === 'PUT' && r.url.includes('/bans/')))).toBe(false);
    expect(await discordLog()).toEqual([]);
    // The owner may act on anyone.
    const byOwner = await command('timeout', [user(ADMIN), { name: 'minutes', type: 4, value: 5 }], TIMEOUT_MEMBERS, { userId: OWNER, userName: 'owner' });
    expect(byOwner[0]).toMatchObject({ content: 'I’ve timed out boss for 5 minutes.' });
  });

  it('Command Permissions add to the protections, never replace them: an Admin-only /timeout still follows the role hierarchy', async () => {
    discord.grantBot(GUILD, TIMEOUT_MEMBERS | BAN_MEMBERS);
    expect((await h.call('POST', '/api/discord/command-access', { body: { groups: { timeout: 'admin' } } })).status).toBe(200);
    const minutes = { name: 'minutes', type: 4, value: 5 };
    // A moderator with Timeout Members is no longer enough.
    expect(await command('timeout', [user(FAN), minutes])).toEqual([{ content: 'Not allowed: admin only.', ephemeral: true }]);
    // A member with Administrator whose highest role is below the target's is still refused by the hierarchy check.
    const ADMINISTRATOR = 1n << 3n;
    expect(await command('timeout', [user(ADMIN), minutes], ADMINISTRATOR | TIMEOUT_MEMBERS)).toEqual([
      { content: 'You can’t moderate members whose highest role is the same as or above yours.', ephemeral: true },
    ]);
    expect(discord.requests.some((r) => r.method === 'PATCH')).toBe(false);
    expect(await command('timeout', [user(FAN), minutes], ADMINISTRATOR | TIMEOUT_MEMBERS)).toEqual([{ content: 'I’ve timed out Fan One for 5 minutes.', ephemeral: true }]);
  });

  it('when the bot lacks the permission, the member is told which one; nothing is attempted', async () => {
    const replies = await command('timeout', [user(FAN), { name: 'minutes', type: 4, value: 5 }]);
    expect(replies[0]).toEqual({ content: 'I can’t do that because I don’t have the “Timeout Members” permission here. Ask an admin to give my role that permission.', ephemeral: true });
    expect(await discordLog()).toEqual([]);
  });

  it('a refusal from Discord is a failure in Discord and in the log, never a success', async () => {
    discord.grantBot(GUILD, TIMEOUT_MEMBERS | BAN_MEMBERS);
    discord.members.get(GUILD)!.get(FAN)!.above = true; // ranked above the bot's role: Discord answers 50013
    const replies = await command('ban', [user(FAN)]);
    // In Discord: first person, the failure stated plainly, never success wording.
    expect(replies[0]).toMatchObject({ content: expect.stringMatching(/^I couldn’t ban Fan One because Discord denied the request: my role has to be above theirs/), ephemeral: true });
    expect(replies[0]!.content).not.toMatch(/I’ve|banned Fan One\./);
    // In the log: the operator's wording, recorded as a failure.
    expect((await discordLog()).map((r) => [r.action, r.outcome, r.detail?.slice(0, 16)])).toEqual([['ban', 'failed', 'Discord refused:']]);
  });

  it('/ban then /unban, logged as what happened; an unban of someone not banned is a failure; a duplicated interaction runs once', async () => {
    discord.grantBot(GUILD, BAN_MEMBERS);
    const id = '7000000000009999999';
    const first = await gateway.interact({ id, commandName: 'ban', guildId: GUILD, memberPermissions: BAN_MEMBERS, options: [user(FAN), { name: 'delete_days', type: 4, value: 1 }] });
    await gateway.interact({ id, commandName: 'ban', guildId: GUILD, memberPermissions: BAN_MEMBERS, options: [user(FAN)] }); // the same event again
    await h.services.moderation.idle();
    expect(first.replies[0]).toMatchObject({ content: 'I’ve banned Fan One.', ephemeral: true });
    expect(JSON.parse(discord.requests.find((r) => r.method === 'PUT' && r.url.includes('/bans/'))!.body)).toEqual({ delete_message_seconds: 86_400 });
    expect((await command('unban', [user(FAN)]))[0]).toMatchObject({ content: 'I’ve unbanned Fan One.' });
    expect((await command('unban', [user(FAN)]))[0]).toMatchObject({ content: 'I couldn’t unban Fan One because they aren’t banned.' });
    expect((await discordLog()).map((r) => [r.action, r.outcome])).toEqual([
      ['unban', 'failed'],
      ['unban', 'success'],
      ['ban', 'success'],
    ]);
  });

  it('the Discord page points to Protection and lists the commands with their permissions', async () => {
    const s = (await h.call<DiscordModerationState>('GET', '/api/moderation/discord')).body;
    expect(s.automod).toMatchObject({ supported: false, reason: expect.stringMatching(/Discord Bot → Protection: CONDUIT’s own AutoMod rules and message checks/) });
    expect(s.commands.map((c) => [c.name, c.permission])).toEqual([
      ['timeout', 'Timeout Members'],
      ['untimeout', 'Timeout Members'],
      ['kick', 'Kick Members'],
      ['ban', 'Ban Members'],
      ['unban', 'Ban Members'],
      ['slowmode', 'Manage Channels'],
      ['lock', 'Manage Roles'], // what the bot needs to change the channel's @everyone permissions
      ['unlock', 'Manage Roles'],
    ]);
    expect(s.guilds[0]!.capabilities.timeout.available).toBe(false);
    // The bot has none of them yet in this server.
    expect(s.commands.every((c) => c.missingIn.includes(s.guilds[0]!.id))).toBe(true);
  });
});
