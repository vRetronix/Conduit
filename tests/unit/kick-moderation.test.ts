/**
 * Kick protection's newer checks (links, caps, emotes, symbols, long messages), settings saved before they existed, and
 * migration 29 (moderation_actions rebuilt with the new rules and "done on Kick" source; known chatters).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AUTOMOD_DEFAULTS, automodSettingsSchema, disallowedLinks, kickTextCheck, linkHosts, type AutomodSettings } from '@conduit/shared';
import { kickChattersRepo, migrate, migrations, moderationRepo, openDatabase, type Database } from '@conduit/database';

const on = (patch: Partial<AutomodSettings>): AutomodSettings => ({ ...structuredClone(AUTOMOD_DEFAULTS), enabled: true, ...patch });

describe('links', () => {
  it('finds links with http(s)://, www. or a common top-level domain; not ordinary punctuation', () => {
    expect(linkHosts('see https://Example.com/a?b and www.foo.org and spam.gg/x')).toEqual(['example.com', 'foo.org', 'spam.gg']);
    for (const t of ['e.g. this', 'wait...what', 'pi is 3.14', 'ok.lol', 'kick is fun']) expect(linkHosts(t)).toEqual([]);
  });

  it('allowed sites include their subdomains, nothing else', () => {
    expect(disallowedLinks('clips.kick.com/x and kick.com and kickk.com', ['kick.com'])).toEqual(['kickk.com']);
  });

  it('saved sites are cleaned up: no scheme, www. or path; one each', () => {
    const s = automodSettingsSchema.parse({ ...AUTOMOD_DEFAULTS, links: { enabled: true, allowedSites: ['https://www.YouTube.com/watch', 'youtube.com'], action: 'log', timeoutMinutes: 1 } });
    expect(s.links.allowedSites).toEqual(['youtube.com']);
    expect(automodSettingsSchema.safeParse({ ...AUTOMOD_DEFAULTS, links: { enabled: true, allowedSites: ['not a site'], action: 'log', timeoutMinutes: 1 } }).success).toBe(false);
  });
});

describe('text checks', () => {
  it('caps, emotes (Kick emotes and emoji), symbols, Zalgo and long messages; switched-off checks never match', () => {
    const all = on({
      caps: { enabled: true, minLetters: 12, percent: 80, action: 'log', timeoutMinutes: 1 },
      emotes: { enabled: true, maxEmotes: 2, action: 'log', timeoutMinutes: 1 },
      symbols: { enabled: true, percent: 50, action: 'log', timeoutMinutes: 1 },
      longMessage: { enabled: true, maxLength: 30, action: 'log', timeoutMinutes: 1 },
    });
    expect(kickTextCheck('THIS IS SO LOUD RIGHT NOW', all)).toEqual({ rule: 'caps', detail: '100% capital letters.' });
    expect(kickTextCheck('[emote:1:KEKW] [emote:2:LUL] 😂', all)?.rule).toBe('emotes');
    expect(kickTextCheck('$$$$$$######!!!!', all)?.rule).toBe('symbols');
    expect(kickTextCheck('z̷̡̛̛̖̗̘̙̜̝̞̟a', all)).toEqual({ rule: 'symbols', detail: 'Stacked accent marks (Zalgo text).' });
    // Emotes count as one character each.
    expect(kickTextCheck('[emote:37226:KEKWLAUGHINGHARD] nice one mate', all)).toBeNull();
    expect(kickTextCheck('a calm message that goes on and on for a while', all)?.rule).toBe('long_message');
    expect(kickTextCheck('THIS IS SO LOUD RIGHT NOW', on({}))).toBeNull();
  });
});

describe('older settings', () => {
  it('load with the newer checks off and blocked words without patterns or allowed words', () => {
    const old = { enabled: true, exemptModerators: true, ignoredUsers: [], blockedTerms: { enabled: true, terms: ['x'], action: 'log', timeoutMinutes: 5 }, repeat: AUTOMOD_DEFAULTS.repeat, spam: AUTOMOD_DEFAULTS.spam };
    const s = automodSettingsSchema.parse(old);
    expect(s.blockedTerms).toMatchObject({ terms: ['x'], regexPatterns: [], allowList: [] });
    for (const k of ['links', 'caps', 'emotes', 'symbols', 'longMessage', 'raid'] as const) expect(s[k].enabled).toBe(false);
    expect(automodSettingsSchema.safeParse({ ...old, blockedTerms: { ...old.blockedTerms, regexPatterns: ['(bad'] } }).success).toBe(false);
  });
});

describe('migration 29', () => {
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  });

  it('keeps every moderation record, and then accepts the new rules, "done on Kick" and known chatters', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    migrate(db, migrations.slice(0, 28));
    db.prepare(
      `INSERT INTO moderation_actions (id, created_at, platform, place_id, place_name, action, target_user_id, target_name, message_id, duration_seconds, reason, source, actor, rule, outcome, detail)
       VALUES ('00000000-0000-0000-0000-000000000001', '2026-10-01T00:00:00.000Z', 'kick', '1', 'retrolive', 'timeout', '42', 'troll', NULL, 60, 'spam', 'automod', 'RetroLive', 'spam', 'success', NULL)`,
    ).run();
    expect(() => db.prepare("UPDATE moderation_actions SET rule = 'links'").run()).toThrow(/CHECK/);
    expect(migrate(db, migrations)).toEqual({ applied: [29], currentVersion: 29 });
    expect(moderationRepo.list(db, 10)).toEqual([expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', rule: 'spam', source: 'automod', durationSeconds: 60, targetName: 'troll' })]);
    moderationRepo.insert(db, {
      id: '00000000-0000-0000-0000-000000000002',
      createdAt: '2026-10-02T00:00:00.000Z',
      platform: 'kick',
      placeId: '1',
      placeName: 'retrolive',
      action: 'ban',
      targetUserId: '43',
      targetName: 'raider',
      messageId: null,
      durationSeconds: null,
      reason: null,
      source: 'platform',
      actor: 'ModAlice',
      rule: null,
      outcome: 'success',
      detail: null,
    });
    expect(() => db.prepare("UPDATE moderation_actions SET rule = 'links' WHERE id LIKE '%1'").run()).not.toThrow();
    expect(() => db.prepare("UPDATE moderation_actions SET source = 'elsewhere'").run()).toThrow(/CHECK/);
    expect(moderationRepo.listForUser(db, 'kick', '43', 10).map((r) => r.actor)).toEqual(['ModAlice']);
    expect(kickChattersRepo.seen(db, '42', 'troll', '2026-10-02T00:00:00.000Z')).toBe(true);
    expect(kickChattersRepo.seen(db, '42', 'troll2', '2026-10-03T00:00:00.000Z')).toBe(false);
    expect(db.prepare("SELECT username, first_seen_at AS f, last_seen_at AS l FROM kick_chatters WHERE user_id = '42'").get()).toEqual({ username: 'troll2', f: '2026-10-02T00:00:00.000Z', l: '2026-10-03T00:00:00.000Z' });
  });
});
