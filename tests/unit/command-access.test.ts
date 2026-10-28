import { describe, expect, it } from 'vitest';
import { migrate, migrations, openDatabase } from '@conduit/database';
import { createCommandSchema, describeAccess, DISCORD_PERMISSION_BITS as DISCORD, updateCommandSchema } from '@conduit/shared';
import { CooldownTracker, discordAllows, kickAllows, kickRoles } from '../../apps/server/src/community/command-access';

const BROADCASTER = '4242001';

describe('Kick roles (from the verified chat event)', () => {
  const roles = (userId: string, badgeTypes: string[]) => kickRoles({ userId, badgeTypes }, BROADCASTER);

  it('broadcaster is the channel owner by user id; moderator and subscriber come from Kick badge types', () => {
    expect([...roles(BROADCASTER, [])]).toEqual(['broadcaster']);
    expect([...roles('7', ['moderator'])]).toEqual(['moderator']);
    expect([...roles('7', ['subscriber', 'sub_gifter'])]).toEqual(['subscriber']);
  });

  it('missing, unknown or look-alike data grants nothing', () => {
    expect([...roles('7', [])]).toEqual([]);
    expect([...roles('7', ['vip', 'og', 'founder', 'verified', 'Moderator', 'broadcaster'])]).toEqual([]);
  });

  it('each level includes the ones above it', () => {
    const matrix: Array<[string[], string, boolean[]]> = [
      // badges, user id, [everyone, subscriber, moderator, broadcaster]
      [[], '7', [true, false, false, false]],
      [['subscriber'], '7', [true, true, false, false]],
      [['moderator'], '7', [true, true, true, false]],
      [[], BROADCASTER, [true, true, true, true]],
    ];
    for (const [badges, id, expected] of matrix) {
      const r = roles(id, badges);
      expect((['everyone', 'subscriber', 'moderator', 'broadcaster'] as const).map((p) => kickAllows(p, r))).toEqual(expected);
    }
  });
});

describe('Discord permissions (computed by Discord for the member)', () => {
  it.each([
    ['Manage Messages', DISCORD.MANAGE_MESSAGES],
    ['Timeout Members', DISCORD.MODERATE_MEMBERS],
    ['Kick Members', DISCORD.KICK_MEMBERS],
    ['Ban Members', DISCORD.BAN_MEMBERS],
    ['Administrator', DISCORD.ADMINISTRATOR],
  ])('%s counts as moderator', (_label, bits) => {
    expect(discordAllows('moderator', bits)).toBe(true);
  });

  it('administrator level needs Administrator; nothing else, and no permissions means everyone only', () => {
    expect(discordAllows('broadcaster', DISCORD.ADMINISTRATOR | 1n)).toBe(true);
    expect(discordAllows('broadcaster', DISCORD.MANAGE_MESSAGES | DISCORD.BAN_MEMBERS)).toBe(false);
    expect(discordAllows('moderator', 1n << 11n)).toBe(false); // Send Messages only
    expect(discordAllows('moderator', null)).toBe(false);
    expect(discordAllows('everyone', null)).toBe(true);
    expect(discordAllows('subscriber', DISCORD.ADMINISTRATOR)).toBe(false); // not a Discord concept
  });
});

describe('CooldownTracker', () => {
  const cmd = (
    over: Partial<{ id: string; platform: 'kick' | 'discord'; cooldownMode: 'none' | 'user' | 'global'; cooldownSeconds: number }> = {},
  ) => ({
    id: 'c1',
    platform: 'kick' as const,
    cooldownMode: 'user' as const,
    cooldownSeconds: 30,
    ...over,
  });

  it('no cooldown never blocks and stores nothing', () => {
    const t = new CooldownTracker(() => 0);
    for (let i = 0; i < 5; i++) expect(t.admit(cmd({ cooldownMode: 'none', cooldownSeconds: 0 }), 'u1').ok).toBe(true);
    expect(t.size).toBe(0);
  });

  it('per user: blocks the same user until it expires, never another user', () => {
    let now = 0;
    const t = new CooldownTracker(() => now);
    expect(t.admit(cmd(), 'u1').ok).toBe(true);
    expect(t.admit(cmd(), 'u1')).toEqual({ ok: false, remainingSeconds: 30 });
    expect(t.admit(cmd(), 'u2').ok).toBe(true);
    now = 29_500;
    expect(t.admit(cmd(), 'u1')).toEqual({ ok: false, remainingSeconds: 1 });
    now = 30_000;
    expect(t.admit(cmd(), 'u1').ok).toBe(true);
  });

  it('global: anyone blocks everyone until it expires', () => {
    let now = 0;
    const t = new CooldownTracker(() => now);
    expect(t.admit(cmd({ cooldownMode: 'global' }), 'u1').ok).toBe(true);
    expect(t.admit(cmd({ cooldownMode: 'global' }), 'u2').ok).toBe(false);
    now = 30_000;
    expect(t.admit(cmd({ cooldownMode: 'global' }), 'u2').ok).toBe(true);
  });

  it('release gives the slot back (a reply that failed), but never undoes a newer reservation', () => {
    let now = 0;
    const t = new CooldownTracker(() => now);
    const a = t.admit(cmd(), 'u1');
    if (!a.ok) throw new Error('expected ok');
    a.release();
    const b = t.admit(cmd(), 'u1');
    expect(b.ok).toBe(true);
    a.release(); // stale release: b's reservation stays
    expect(t.admit(cmd(), 'u1').ok).toBe(false);
  });

  it('keys are isolated by platform, command and user; ids are never merged', () => {
    const t = new CooldownTracker(() => 0);
    expect(t.admit(cmd({ cooldownMode: 'global' }), 'x').ok).toBe(true);
    expect(t.admit(cmd({ id: 'c2', cooldownMode: 'global' }), 'x').ok).toBe(true);
    expect(t.admit(cmd({ platform: 'discord', cooldownMode: 'global' }), 'x').ok).toBe(true);
    expect(t.admit(cmd(), '12').ok).toBe(true);
    expect(t.admit(cmd(), '123').ok).toBe(true); // a prefix of another id is a different user
    expect(CooldownTracker.key(cmd(), '1:global')).not.toBe(CooldownTracker.key(cmd({ cooldownMode: 'global' }), 'x'));
  });

  it('forget clears one command only', () => {
    const t = new CooldownTracker(() => 0);
    t.admit(cmd(), 'u1');
    t.admit(cmd({ id: 'c2' }), 'u1');
    t.forget('c1');
    expect(t.admit(cmd(), 'u1').ok).toBe(true);
    expect(t.admit(cmd({ id: 'c2' }), 'u1').ok).toBe(false);
  });

  it('stays bounded: old entries are dropped first', () => {
    let now = 0;
    const t = new CooldownTracker(() => now);
    for (let i = 0; i < 10_500; i++) {
      now = i; // a mix of expired and active entries
      t.admit(cmd({ cooldownSeconds: 5 }), `u${i}`);
    }
    expect(t.size).toBeLessThanOrEqual(10_000);
  });
});

describe('permission and cooldown rules (backend validation)', () => {
  it('defaults keep the original behaviour', () => {
    expect(createCommandSchema('kick').parse({ trigger: '!a', response: 'b' })).toMatchObject({
      permission: 'everyone',
      cooldownMode: 'none',
      cooldownSeconds: 0,
    });
  });

  it('rejects unavailable or invalid values', () => {
    const issues = (p: 'kick' | 'discord', body: object) =>
      (
        createCommandSchema(p).safeParse({
          trigger: p === 'kick' ? '!a' : '/a',
          response: 'b',
          ...(p === 'discord' ? { description: 'd' } : {}),
          ...body,
        }).error?.issues ?? []
      ).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(issues('discord', { permission: 'subscriber' })).toEqual(['permission: Not available: Discord has no subscribers']);
    expect(issues('kick', { permission: 'subscriber' })).toEqual([]);
    expect(issues('kick', { permission: 'admin' })[0]).toMatch(/^permission/);
    expect(issues('kick', { cooldownMode: 'user', cooldownSeconds: 0 })).toEqual(['cooldownSeconds: Choose 1–86400 seconds']);
    expect(issues('kick', { cooldownMode: 'global', cooldownSeconds: 86_401 })[0]).toMatch(/^cooldownSeconds/);
    expect(issues('kick', { cooldownMode: 'user', cooldownSeconds: 1.5 })[0]).toMatch(/whole seconds/);
    expect(issues('kick', { cooldownMode: 'sometimes', cooldownSeconds: 5 })[0]).toMatch(/^cooldownMode/);
    expect(updateCommandSchema('kick').safeParse({ cooldownSeconds: -1 }).success).toBe(false);
  });

  it('describes the effective settings', () => {
    expect(describeAccess('kick', 'moderator', 'user', 30)).toBe('Moderators · 30 s per user');
    expect(describeAccess('discord', 'broadcaster', 'global', 120)).toBe('Admin · 2 min for everyone');
    expect(describeAccess('kick', 'everyone', 'none', 0)).toBe('Anyone · no cooldown');
  });
});

describe('migration 11 (permissions and cooldowns)', () => {
  it('keeps existing commands and gives them the original behaviour (everyone, no cooldown)', () => {
    const db = openDatabase(':memory:');
    migrate(db, migrations.slice(0, 10));
    db.prepare(
      "INSERT INTO chat_commands (id, platform, trigger, description, response, enabled, created_at, updated_at) VALUES ('k1', 'kick', '!english', NULL, 'Speak English please', 1, '2026-10-11T17:22:32Z', '2026-10-11T17:22:32Z')",
    ).run();
    expect(migrate(db, migrations)).toEqual({ applied: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], currentVersion: 29 });
    expect(db.prepare('SELECT * FROM chat_commands').all()).toEqual([
      {
        id: 'k1',
        platform: 'kick',
        trigger: '!english',
        description: null,
        response: 'Speak English please',
        enabled: 1,
        created_at: '2026-10-11T17:22:32Z',
        updated_at: '2026-10-11T17:22:32Z',
        permission: 'everyone',
        cooldown_mode: 'none',
        cooldown_seconds: 0,
      },
    ]);
    const set = (sql: string) => () => db.prepare(sql).run();
    expect(set("UPDATE chat_commands SET permission = 'admin'")).toThrow(/CHECK/);
    expect(set("UPDATE chat_commands SET cooldown_mode = 'sometimes'")).toThrow(/CHECK/);
    expect(set('UPDATE chat_commands SET cooldown_seconds = 90000')).toThrow(/CHECK/);
    db.close();
  });
});
