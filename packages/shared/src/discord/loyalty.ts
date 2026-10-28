/**
 * Loyalty & Rewards — Discord only. Two separate systems:
 *
 * - XP and levels: members earn XP for messages in a Discord server (a random amount between a minimum and maximum,
 *   at most once per cooldown) and level up. XP is per server; it is never spent. Level-ups can be announced and can
 *   give Discord roles.
 * - Points: a spendable balance per Discord account, earned for messages if switched on (its own amount, cooldown and
 *   daily limit) and from administrators, spent on rewards with "/redeem". Points are taken when the redemption is
 *   made; a rejected redemption gives them back. CONDUIT never delivers a reward itself.
 *
 * XP is never converted into points or the other way round. Bots, webhooks and system messages never earn. Kick chat
 * takes no part (older Kick points history, if any, is kept as it was).
 */
import { z } from 'zod';
import { embedSchema, fillTemplate } from './embeds';

export const LOYALTY_PLATFORMS = ['discord', 'kick'] as const;
/** 'kick' only appears on older history; everything new is Discord. */
export type LoyaltyPlatform = (typeof LOYALTY_PLATFORMS)[number];

/** Discord slash commands (registered while Loyalty and its commands are on). */
export const LOYALTY_COMMANDS = { points: 'points', rewards: 'rewards', redeem: 'redeem', level: 'level', leaderboard: 'leaderboard', manage: 'loyalty' } as const;

// ── levels ────────────────────────────────────────────────────────────────────

/** XP needed to go from `level` to the next one: 5 × level² + 50 × level + 100 (100, 155, 220, 295, …). */
export function xpForNextLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP needed to reach `level` from 0. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpForNextLevel(l);
  return total;
}

/** The level for a total amount of XP. */
export function levelForXp(xp: number): number {
  let level = 0;
  let remaining = Math.max(0, Math.floor(xp));
  while (level < 1000 && remaining >= xpForNextLevel(level)) {
    remaining -= xpForNextLevel(level);
    level++;
  }
  return level;
}

/** Where a member stands: level, XP into it and XP needed for the next one. */
export function levelProgress(xp: number): { level: number; xpIntoLevel: number; xpForNext: number; totalForNext: number } {
  const level = levelForXp(xp);
  const start = totalXpForLevel(level);
  return { level, xpIntoLevel: xp - start, xpForNext: xpForNextLevel(level), totalForNext: start + xpForNextLevel(level) };
}

// ── settings ──────────────────────────────────────────────────────────────────

const snowflake = z.string().regex(/^\d{1,25}$/, 'Choose one');

export const LEVEL_UP_VARIABLES = ['{user}', '{username}', '{level}'] as const;
/** The level-up variables with what they become (shown under the text and embed editors). */
export const LEVEL_UP_VARIABLE_HELP: Record<string, string> = {
  user: 'The member as a mention (shown, never pinged)',
  username: 'The member’s Discord username',
  level: 'The level they reached',
};
export const DEFAULT_LEVEL_UP_TEMPLATE = 'GG {user}, you reached level {level}!';

const xpSettings = z
  .strictObject({
    /** Earn XP for messages (switching it off keeps everyone's XP and levels). */
    enabled: z.boolean().default(true),
    minXp: z.number().int().min(1, 'At least 1 XP').max(1000, 'At most 1000 XP').default(15),
    maxXp: z.number().int().min(1, 'At least 1 XP').max(1000, 'At most 1000 XP').default(25),
    /** A member earns XP at most once per this many seconds. */
    cooldownSeconds: z.number().int().min(10, 'At least 10 seconds').max(3600, 'At most 1 hour').default(60),
    /** No XP for a message identical to the member's last one that earned XP (needs the Message Content intent). */
    ignoreRepeats: z.boolean().default(true),
    announce: z
      .strictObject({
        enabled: z.boolean().default(false),
        /** Where to announce; null = in the channel where the member reached the level. */
        guildId: snowflake.nullable().default(null),
        channelId: snowflake.nullable().default(null),
        /** Message text (optional when there is an embed). */
        template: z
          .string()
          .trim()
          .max(2000, 'Up to 2000 characters')
          .refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), 'Plain text only')
          .default(DEFAULT_LEVEL_UP_TEMPLATE),
        /** An optional embed, with the same {variables} as the text. */
        embed: embedSchema.nullable().default(null),
      })
      .refine((a) => (a.channelId === null) === (a.guildId === null), { message: 'Choose a channel', path: ['channelId'] })
      .refine((a) => a.template !== '' || a.embed !== null, { message: 'Add message text or an embed', path: ['template'] })
      .default({ enabled: false, guildId: null, channelId: null, template: DEFAULT_LEVEL_UP_TEMPLATE, embed: null }),
  })
  .refine((x) => x.maxXp >= x.minXp, { message: 'The maximum can’t be below the minimum', path: ['maxXp'] });

const pointsSettings = z.strictObject({
  /** Messages also earn points (separately from XP). Off: points come only from administrators. */
  earn: z.boolean().default(false),
  pointsPerMessage: z.number().int().min(1, 'At least 1 point').max(1000, 'At most 1000 points').default(5),
  /** A member earns points at most once per this many seconds. */
  cooldownSeconds: z.number().int().min(10, 'At least 10 seconds').max(3600, 'At most 1 hour').default(60),
  /** Most points a member can earn from messages per day (UTC); 0 = no limit. */
  dailyLimit: z.number().int().min(0).max(1_000_000).default(0),
  /** Register and answer /points, /rewards, /redeem (and /level, /leaderboard while XP is on). */
  commands: z.boolean().default(true),
});

export const loyaltySettingsSchema = z.strictObject({
  /** Master switch: off = nothing is earned and no command answers (XP, levels, balances and history are kept). */
  enabled: z.boolean().default(false),
  /** What points are called in replies, e.g. "points" or "coins". */
  pointsName: z
    .string()
    .trim()
    .min(1, 'Give the points a name')
    .max(20, 'Up to 20 characters')
    .regex(/^[\p{L}\p{N} ]+$/u, 'Letters, numbers and spaces only')
    .default('points'),
  xp: xpSettings.default({
    enabled: true,
    minXp: 15,
    maxXp: 25,
    cooldownSeconds: 60,
    ignoreRepeats: true,
    announce: { enabled: false, guildId: null, channelId: null, template: DEFAULT_LEVEL_UP_TEMPLATE, embed: null },
  }),
  /** Points earning and the Discord commands. */
  discord: pointsSettings.default({ earn: false, pointsPerMessage: 5, cooldownSeconds: 60, dailyLimit: 0, commands: true }),
});
export type LoyaltySettings = z.output<typeof loyaltySettingsSchema>;
export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = loyaltySettingsSchema.parse({});

/**
 * Settings saved by an earlier version may still hold Kick options; they are ignored (Loyalty is Discord-only), and
 * anything else that no longer fits falls back to the defaults for that part.
 */
export function readStoredLoyaltySettings(raw: unknown): LoyaltySettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kick: _kick, ...rest } = raw as Record<string, unknown>;
  const parsed = loyaltySettingsSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

// ── inputs ────────────────────────────────────────────────────────────────────

const rewardName = z
  .string()
  .trim()
  .min(1, 'Give the reward a name')
  .max(40, 'Up to 40 characters')
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'One line only')
  .refine((s) => !/^[!/]/.test(s), 'Can’t start with "!" or "/"');

export const rewardSchema = z.strictObject({
  name: rewardName,
  description: z.string().trim().max(200, 'Up to 200 characters').nullable().default(null).transform((s) => (s ? s : null)),
  cost: z.number().int().min(1, 'At least 1 point').max(10_000_000),
  enabled: z.boolean().default(true),
  /** Limited quantity left; null = unlimited. */
  stock: z.number().int().min(0).max(1_000_000).nullable().default(null),
});
export type RewardInput = z.input<typeof rewardSchema>;

const memberId = z.string().regex(/^\d{1,25}$/, 'Unknown member');
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200, 'Up to 200 characters');
const nonZero = (max: number) =>
  z
    .number()
    .int('Whole numbers only')
    .min(-max)
    .max(max)
    .refine((n) => n !== 0, 'Enter a number other than 0');

/** An administrator's points adjustment (Discord accounts only). */
export const pointsAdjustmentSchema = z.strictObject({ userId: memberId, amount: nonZero(10_000_000), reason });
/** An administrator's XP adjustment in one server; the level is recalculated. */
export const xpAdjustmentSchema = z.strictObject({ guildId: snowflake, userId: memberId, amount: nonZero(100_000_000), reason });

export const memberQuerySchema = z.strictObject({
  guildId: snowflake.nullable().default(null),
  sort: z.enum(['xp', 'points']).default('xp'),
  query: z.string().trim().max(100).nullable().default(null).transform((s) => (s ? s : null)),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

export const memberRefSchema = z.strictObject({ userId: memberId });

export const roleRewardSchema = z.strictObject({
  guildId: snowflake,
  roleId: snowflake,
  level: z.number().int().min(1, 'Level 1 or higher').max(1000, 'Level 1000 at most'),
});

export const resolveRedemptionSchema = z.strictObject({
  note: z.string().trim().max(200, 'Up to 200 characters').nullable().default(null).transform((s) => (s ? s : null)),
});

// ── views ─────────────────────────────────────────────────────────────────────

export interface LoyaltyProgress {
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
}

export interface LoyaltyMember {
  guildId: string;
  userId: string;
  displayName: string | null;
  xp: number;
  progress: LoyaltyProgress;
  points: number;
  /** 1 = most XP in that server. */
  rank: number;
}

export interface LoyaltyTransactionView {
  id: string;
  platform: LoyaltyPlatform;
  userId: string;
  displayName?: string | null;
  amount: number;
  balanceAfter: number;
  kind: 'chat' | 'adjustment' | 'redemption' | 'refund';
  reason: string | null;
  createdAt: string;
}

export interface LoyaltyXpEventView {
  id: string;
  guildId: string;
  userId: string;
  displayName?: string | null;
  amount: number;
  xpAfter: number;
  levelAfter: number;
  kind: 'message' | 'adjustment';
  reason: string | null;
  createdAt: string;
}

export interface LoyaltyRewardView {
  id: string;
  name: string;
  description: string | null;
  cost: number;
  enabled: boolean;
  stock: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyRedemptionView {
  id: string;
  rewardId: string;
  rewardName: string;
  platform: LoyaltyPlatform;
  userId: string;
  displayName: string | null;
  cost: number;
  status: 'pending' | 'fulfilled' | 'rejected';
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface LoyaltyRoleRewardView {
  id: string;
  guildId: string;
  level: number;
  roleId: string;
  /** The role's name, when the bot can see it. */
  roleName: string | null;
  /** Why the bot can't give this role right now (missing, permission, hierarchy), or null. */
  problem: string | null;
}

/**
 * One Loyalty & Rewards entry in Discord Bot → Logs → Moderation log: points changes, XP adjustments, and changes to
 * settings, rewards, redemptions and role rewards.
 */
export interface LoyaltyLogEntry {
  id: string;
  at: string;
  /** What happened: "Points adjusted", "XP adjusted", "Settings saved"… */
  title: string;
  /** The server it was about, by name (its id when the bot can't see it). */
  place: string | null;
  /** The member it was about. */
  userId: string | null;
  userName: string | null;
  /** The change itself, e.g. "+50 points · balance 60" or "−20 XP · level 3". */
  change: string | null;
  reason: string | null;
  /** Anything else recorded (reward names, settings…). */
  detail: string | null;
}

export interface LoyaltyAuditEntry {
  at: string;
  action: string;
  detail: string;
  /** The member it was about (points adjusted, reset…), with their name when CONDUIT knows it; null otherwise. */
  userId: string | null;
  displayName: string | null;
  /** The server it was about (settings, role rewards, leaderboard reset), with its name when the bot can see it. */
  guildId: string | null;
  guildName: string | null;
}

export interface LoyaltyGuild {
  id: string;
  name: string | null;
  members: number;
}

export interface LoyaltyState {
  settings: LoyaltySettings;
  stats: {
    /** Discord accounts with a points balance, and the points they hold. */
    viewers: number;
    outstanding: number;
    pending: number;
    /** Members with XP (all servers) and their total XP. */
    members: number;
    totalXp: number;
    /** Points history from Kick before Loyalty became Discord-only: kept, not used. */
    legacyKick: { accounts: number; points: number };
  };
  /** Servers the bot is in (and any with XP records), for the leaderboard and settings. */
  guilds: LoyaltyGuild[];
  rewards: LoyaltyRewardView[];
  roleRewards: LoyaltyRoleRewardView[];
  /** Pending first (oldest first), then the most recent resolved ones. */
  redemptions: LoyaltyRedemptionView[];
  /** Newest first. */
  /** Recent problems giving role rewards or announcing level-ups (never secrets). */
  problems: Array<{ at: string; detail: string }>;
  discord: {
    ready: boolean;
    problem: string | null;
    /** Whether repeated messages can be recognised (the Message Content intent is in use). */
    contentAvailable: boolean;
    commandConflicts: string[];
  };
}

export interface LoyaltyMemberPage {
  guildId: string | null;
  members: LoyaltyMember[];
  total: number;
  offset: number;
  pageSize: number;
}

export interface LoyaltyMemberHistory {
  userId: string;
  displayName: string | null;
  points: { balance: number; lifetimeEarned: number };
  levels: Array<{ guildId: string; xp: number; progress: LoyaltyProgress; rank: number | null }>;
  transactions: LoyaltyTransactionView[];
  xpEvents: LoyaltyXpEventView[];
}

export interface LoyaltyRoleOptions {
  guilds: Array<{ id: string; name: string; roles: Array<{ id: string; name: string; assignable: boolean; problem: string | null }> }>;
  problem: string | null;
}

/** "1 point" / "250 points" with the configured name ("coins"). A name ending in "s" is used as the plural. */
export function formatPoints(n: number, name = 'points'): string {
  const plural = name.endsWith('s') ? name : `${name}s`;
  const singular = name.endsWith('s') && name.length > 1 ? name.slice(0, -1) : name;
  return `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? singular : plural}`;
}

/** The values of the level-up variables. {user} is a mention (shown, but announcements never ping anyone). */
export function levelUpVars(v: { userId: string; username: string; level: number }): Record<string, string> {
  return { user: `<@${v.userId}>`, username: v.username, level: String(v.level) };
}

/** Fills a level-up message text (the embed is filled with the same values when it is posted). */
export function renderLevelUp(template: string, v: { userId: string; username: string; level: number }): string {
  return fillTemplate(template, levelUpVars(v));
}
