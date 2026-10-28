/**
 * Moderation: contracts shared by the backend and the dashboard.
 *
 * Manual actions go through each platform's official API with the connected account's own permissions:
 * - Discord (bot token): timeout / remove timeout (Moderate Members), ban / unban (Ban Members), delete a message
 *   (Manage Messages), member lookup.
 * - Kick (main account token): timeout / ban / unban (scope moderation:ban), delete a chat message (scope
 *   moderation:chat_message:manage), user lookup by username.
 * Actions are started by automated protection (Kick) or by CONDUIT's Discord moderation commands (/timeout, /untimeout,
 * /ban, /unban); the dashboard configures protection and shows logs, and has no manual action controls.
 * The history records actions taken through CONDUIT, plus bans and timeouts done on Kick itself (Kick's moderation.banned
 * events); Discord moderation done outside CONDUIT comes from the audit log, kept separately.
 * Automated protection reads Kick chat only (signed chat events). Discord message content would need the privileged
 * Message Content intent, which CONDUIT doesn't use.
 */
import { z } from 'zod';
import type { DiscordLogEntryView } from '../discord/discord-logging';
import type { LoyaltyLogEntry } from '../discord/loyalty';
import { regexProblem, type ProtectionEventView } from '../discord/discord-protection';

export const MODERATION_PLATFORMS = ['discord', 'kick'] as const;
export type ModerationPlatform = (typeof MODERATION_PLATFORMS)[number];

export const MODERATION_ACTIONS = ['timeout', 'untimeout', 'ban', 'unban', 'delete_message'] as const;
export type ModerationActionKind = (typeof MODERATION_ACTIONS)[number];

export const MODERATION_ACTION_LABEL: Record<ModerationActionKind, string> = {
  timeout: 'Timeout',
  untimeout: 'Remove timeout',
  ban: 'Ban',
  unban: 'Unban',
  delete_message: 'Delete message',
};

/** Timeout limits: Discord up to 28 days; Kick 1 minute to 7 days (whole minutes). */
export const TIMEOUT_LIMITS: Record<ModerationPlatform, { minSeconds: number; maxSeconds: number }> = {
  discord: { minSeconds: 60, maxSeconds: 28 * 24 * 3600 },
  kick: { minSeconds: 60, maxSeconds: 7 * 24 * 3600 },
};

export const MODERATION_REASON_MAX = 100;

const snowflake = z.string().trim().regex(/^\d{15,25}$/, 'Enter a Discord user ID (15–25 digits) or @mention');
const guildId = z.string().regex(/^\d{1,25}$/, 'Choose a Discord server');
const kickUserId = z.string().trim().regex(/^\d{1,20}$/, 'Choose a Kick user (look them up by username first)');
const reason = z
  .string()
  .trim()
  .max(MODERATION_REASON_MAX, `At most ${MODERATION_REASON_MAX} characters`)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'The reason is a single line of text')
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .default(null);

/** A Discord user given as an ID or a mention (<@123> / <@!123>). */
export function parseDiscordUser(raw: string): string | null {
  const m = /^\s*(?:<@!?(\d{15,25})>|(\d{15,25}))\s*$/.exec(raw);
  return m ? (m[1] ?? m[2]!) : null;
}

/** A Discord message link: https://discord.com/channels/<guild>/<channel>/<message> (also ptb/canary). */
export function parseDiscordMessageLink(raw: string): { guildId: string; channelId: string; messageId: string } | null {
  const m = /^\s*https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{1,25})\/(\d{15,25})\/(\d{15,25})\/?\s*$/.exec(raw);
  return m ? { guildId: m[1]!, channelId: m[2]!, messageId: m[3]! } : null;
}

const discordAction = z.discriminatedUnion('action', [
  z.strictObject({
    platform: z.literal('discord'),
    action: z.literal('timeout'),
    guildId,
    userId: snowflake,
    durationSeconds: z
      .number()
      .int()
      .min(TIMEOUT_LIMITS.discord.minSeconds, 'At least 1 minute')
      .max(TIMEOUT_LIMITS.discord.maxSeconds, 'Discord timeouts last at most 28 days'),
    reason,
  }),
  z.strictObject({ platform: z.literal('discord'), action: z.literal('untimeout'), guildId, userId: snowflake, reason }),
  z.strictObject({
    platform: z.literal('discord'),
    action: z.literal('ban'),
    guildId,
    userId: snowflake,
    /** Also delete this much of the user's recent message history (Discord allows up to 7 days). */
    deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
    reason,
  }),
  z.strictObject({ platform: z.literal('discord'), action: z.literal('unban'), guildId, userId: snowflake, reason }),
  z.strictObject({
    platform: z.literal('discord'),
    action: z.literal('delete_message'),
    messageLink: z.string().trim().refine((s) => parseDiscordMessageLink(s) !== null, 'Paste a Discord message link (Copy Message Link)'),
    reason,
  }),
]);

const kickTarget = { userId: kickUserId, username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Invalid Kick username') };

const kickAction = z.discriminatedUnion('action', [
  z.strictObject({
    platform: z.literal('kick'),
    action: z.literal('timeout'),
    ...kickTarget,
    durationSeconds: z
      .number()
      .int()
      .min(TIMEOUT_LIMITS.kick.minSeconds, 'At least 1 minute')
      .max(TIMEOUT_LIMITS.kick.maxSeconds, 'Kick timeouts last at most 7 days')
      .refine((s) => s % 60 === 0, 'Kick timeouts are in whole minutes'),
    reason,
  }),
  z.strictObject({ platform: z.literal('kick'), action: z.literal('ban'), ...kickTarget, reason }),
  z.strictObject({ platform: z.literal('kick'), action: z.literal('unban'), ...kickTarget, reason }),
  z.strictObject({
    platform: z.literal('kick'),
    action: z.literal('delete_message'),
    ...kickTarget,
    messageId: z.string().trim().regex(/^[0-9A-Za-z-]{1,64}$/, 'Choose a message from recent chat'),
    reason,
  }),
]);

export const moderationActionSchema = z.union([discordAction, kickAction]);
export type ModerationActionInput = z.input<typeof moderationActionSchema>;
export type ModerationAction = z.output<typeof moderationActionSchema>;

export const moderationLookupSchema = z.discriminatedUnion('platform', [
  z.strictObject({ platform: z.literal('discord'), guildId, user: z.string().trim().min(1).max(40) }),
  z.strictObject({
    platform: z.literal('kick'),
    username: z
      .string()
      .trim()
      .transform((s) => s.replace(/^@/, ''))
      .pipe(z.string().min(1, 'Enter a Kick username').max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Kick usernames use letters, numbers, "_", "-" and "."')),
  }),
]);

export interface ModerationLookupResult {
  platform: ModerationPlatform;
  userId: string;
  username: string;
  displayName: string | null;
  /** Discord: whether the user is in the server; Kick: always null (Kick's API doesn't say). */
  inServer: boolean | null;
  /** Discord: when the member joined; null when unknown. */
  joinedAt: string | null;
  /** Discord: the member's current timeout end, if timed out. */
  timedOutUntil: string | null;
  /** Discord: number of roles. */
  roleCount: number | null;
  /** Discord: whether the user is banned (only checked when not in the server). */
  banned: boolean | null;
}

export interface ModerationCapability {
  available: boolean;
  /** Why it isn't available, and what to do. */
  problem: string | null;
}

export interface ModerationState {
  discord: {
    connected: boolean;
    problem: string | null;
    botName: string | null;
    guilds: Array<{ id: string; name: string; capabilities: Record<ModerationActionKind | 'lookup', ModerationCapability>; problem: string | null }>;
  };
  kick: {
    connected: boolean;
    problem: string | null;
    /** The main account: actions are taken as the channel owner. */
    accountName: string | null;
    channel: string | null;
    capabilities: Record<ModerationActionKind | 'lookup', ModerationCapability>;
  };
  history: ModerationRecordView[];
  automod: AutomodState;
}

/** The Kick Moderation page: automated protection and Kick logs. */
export interface KickModerationState {
  connected: boolean;
  problem: string | null;
  accountName: string | null;
  channel: string | null;
  /** Whether chat is being received (from the chat service; protection only sees messages while connected). */
  chat: { status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'permission_required'; problem: string | null };
  automod: AutomodState;
  history: ModerationRecordView[];
}

/** The Discord Moderation page: what automated protection can do on Discord, the moderation commands, and Discord logs. */
export interface DiscordModerationState {
  connected: boolean;
  problem: string | null;
  botName: string | null;
  guilds: ModerationState['discord']['guilds'];
  /**
   * CONDUIT's Discord moderation commands and the permission each needs (members need it, and so does the bot), with
   * the servers (ids) where the bot doesn't have it.
   */
  commands: Array<{ name: string; permission: string; missingIn: string[] }>;
  automod: AutomodState['discord'];
  history: ModerationRecordView[];
  /** Moderation in the server outside CONDUIT, from Discord's audit log (Discord's own buttons, other bots, AutoMod). */
  serverHistory: DiscordServerModerationView[];
  /** What CONDUIT protection noticed or did (Discord Bot → Protection). */
  protectionHistory: ProtectionEventView[];
  /** What Discord Logging posted (members, messages, server changes). */
  loggingHistory: DiscordLogEntryView[];
  /** Loyalty & Rewards: points changes, XP adjustments and changes to its settings and rewards. */
  loyaltyHistory: LoyaltyLogEntry[];
}

/** One moderation action from a server's audit log, done outside CONDUIT. */
export interface DiscordServerModerationView {
  id: string;
  at: string;
  /** The server's name, when the bot can see it. */
  place: string | null;
  action: 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout' | 'automod_block' | 'automod_flag' | 'automod_timeout';
  targetUserId: string | null;
  targetName: string | null;
  /** How it was done: in Discord by a person, by another bot, or by AutoMod. */
  via: 'discord' | 'bot' | 'automod';
  /** Who did it (moderator or bot name); null for AutoMod or when Discord didn't say. */
  by: string | null;
  reason: string | null;
  /** AutoMod: the rule that acted. */
  ruleName: string | null;
  /** Timeouts: when they end. */
  until: string | null;
}

export interface ModerationRecordView {
  id: string;
  at: string;
  platform: ModerationPlatform;
  /** Discord server or Kick channel. */
  place: string | null;
  action: ModerationActionKind | 'flag';
  targetUserId: string;
  targetName: string | null;
  durationSeconds: number | null;
  reason: string | null;
  /**
   * manual = started by a person (a Discord moderation command, or the dashboard before Phase 10.1); automod = automated
   * protection; platform = done on Kick itself (Kick's own buttons or another bot), from Kick's ban and timeout events.
   */
  source: 'manual' | 'automod' | 'platform';
  /** Who started it: e.g. "modname via /ban" for a Discord command, or the account used. */
  actor: string | null;
  rule: AutomodRecordRule | null;
  outcome: 'success' | 'failed' | 'logged';
  detail: string | null;
}

// ── automated protection (Kick) ──────────────────────────────────────────────

/** The checks, in the order they're tried (blocked words first; flooding and repeats need the user's recent messages). */
export const AUTOMOD_RULES = ['blocked_terms', 'links', 'caps', 'emotes', 'symbols', 'long_message', 'repeat', 'spam'] as const;
export type AutomodRule = (typeof AUTOMOD_RULES)[number];
/** As stored with what protection did: a check, or raid mode. */
export type AutomodRecordRule = AutomodRule | 'raid';

/** What to do when a rule matches. "log" records it in the history and does nothing on Kick. */
export const AUTOMOD_ACTIONS = ['log', 'delete_message', 'timeout'] as const;
export type AutomodAction = (typeof AUTOMOD_ACTIONS)[number];

export const AUTOMOD_ACTION_LABEL: Record<AutomodAction, string> = {
  log: 'Log only',
  delete_message: 'Delete the message',
  timeout: 'Timeout the user',
};

export const AUTOMOD_RULE_LABEL: Record<AutomodRecordRule, string> = {
  blocked_terms: 'Blocked words and phrases',
  links: 'Links',
  caps: 'Excessive caps',
  emotes: 'Emote spam',
  symbols: 'Symbol spam',
  long_message: 'Long messages',
  repeat: 'Repeated messages',
  spam: 'Message flooding',
  raid: 'Raid mode',
};

export const AUTOMOD_TERMS_MAX = 200;
export const AUTOMOD_TERM_MAX_LENGTH = 60;

const automodActionSchema = z.enum(AUTOMOD_ACTIONS);
const timeoutMinutes = z.number().int().min(1, 'At least 1 minute').max(10_080, 'At most 7 days (10080 minutes)');

export const AUTOMOD_IGNORED_MAX = 100;

const term = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(AUTOMOD_TERM_MAX_LENGTH, `Each word or phrase is at most ${AUTOMOD_TERM_MAX_LENGTH} characters`)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'One word or phrase per line');

/** A site links may go to: "youtube.com" (and its subdomains). */
const site = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
  .pipe(z.string().min(3).max(100).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Sites look like example.com'));

export const automodSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Moderators and the broadcaster are never acted on (Kick badges from the signed event). */
  exemptModerators: z.boolean(),
  /**
   * Kick usernames never checked (e.g. other bots you trust). Matched case-insensitively against the sender's name on
   * the signed event. Optional so settings saved before this existed still load.
   */
  ignoredUsers: z
    .array(
      z
        .string()
        .trim()
        .transform((s) => s.replace(/^@/, '').toLowerCase())
        .pipe(z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/, 'Kick usernames use letters, numbers, "_", "-" and "."')),
    )
    .max(AUTOMOD_IGNORED_MAX, `At most ${AUTOMOD_IGNORED_MAX} ignored users`)
    .transform((list) => [...new Set(list)])
    .default([]),
  blockedTerms: z.strictObject({
    enabled: z.boolean(),
    /** Words and phrases; * as a wildcard (cat*, *cat, *cat*), like Discord's AutoMod. */
    terms: z
      .array(term)
      .max(AUTOMOD_TERMS_MAX, `At most ${AUTOMOD_TERMS_MAX} words or phrases`)
      .transform((list) => [...new Set(list)]),
    regexPatterns: z
      .array(z.string().trim().min(1).max(260, 'Each pattern is at most 260 characters'))
      .max(10, 'At most 10 patterns')
      .default([])
      .superRefine((list, ctx) => {
        const bad = list.find((p) => regexProblem(p));
        if (bad !== undefined) ctx.addIssue({ code: 'custom', message: `Not a valid regular expression: ${bad}` });
      }),
    /** Never matched, even when a word or pattern would. */
    allowList: z.array(term).max(AUTOMOD_TERMS_MAX, `At most ${AUTOMOD_TERMS_MAX} allowed words`).default([]),
    action: automodActionSchema,
    timeoutMinutes,
  }),
  links: z
    .strictObject({
      enabled: z.boolean(),
      /** Links to these sites (and their subdomains) are fine. */
      allowedSites: z.array(site).max(50, 'At most 50 sites').transform((l) => [...new Set(l)]),
      action: automodActionSchema,
      timeoutMinutes,
    })
    .default({ enabled: false, allowedSites: ['kick.com'], action: 'log', timeoutMinutes: 5 }),
  caps: z
    .strictObject({
      enabled: z.boolean(),
      /** Only messages with at least this many letters are checked. */
      minLetters: z.number().int().min(5, 'At least 5').max(500, 'At most 500'),
      percent: z.number().int().min(50, 'At least 50%').max(100, 'At most 100%'),
      action: automodActionSchema,
      timeoutMinutes,
    })
    .default({ enabled: false, minLetters: 12, percent: 80, action: 'log', timeoutMinutes: 1 }),
  emotes: z
    .strictObject({
      enabled: z.boolean(),
      /** More than this many emotes (Kick emotes and emoji) in one message. */
      maxEmotes: z.number().int().min(1, 'At least 1').max(100, 'At most 100'),
      action: automodActionSchema,
      timeoutMinutes,
    })
    .default({ enabled: false, maxEmotes: 10, action: 'log', timeoutMinutes: 1 }),
  symbols: z
    .strictObject({
      enabled: z.boolean(),
      /** At least this share of a message (10+ characters) is symbols, or it has stacked accent marks (Zalgo). */
      percent: z.number().int().min(30, 'At least 30%').max(100, 'At most 100%'),
      action: automodActionSchema,
      timeoutMinutes,
    })
    .default({ enabled: false, percent: 50, action: 'log', timeoutMinutes: 1 }),
  longMessage: z
    .strictObject({
      enabled: z.boolean(),
      /** More than this many characters (an emote counts as one). */
      maxLength: z.number().int().min(20, 'At least 20').max(500, 'At most 500'),
      action: automodActionSchema,
      timeoutMinutes,
    })
    .default({ enabled: false, maxLength: 300, action: 'log', timeoutMinutes: 1 }),
  repeat: z.strictObject({
    enabled: z.boolean(),
    /** The same message this many times… */
    count: z.number().int().min(2, 'At least 2').max(20, 'At most 20'),
    /** …within this many seconds. */
    windowSeconds: z.number().int().min(5, 'At least 5 seconds').max(600, 'At most 10 minutes'),
    action: automodActionSchema,
    timeoutMinutes,
  }),
  spam: z.strictObject({
    enabled: z.boolean(),
    /** More than this many messages… */
    maxMessages: z.number().int().min(3, 'At least 3').max(50, 'At most 50'),
    /** …within this many seconds. */
    windowSeconds: z.number().int().min(3, 'At least 3 seconds').max(120, 'At most 2 minutes'),
    action: automodActionSchema,
    timeoutMinutes,
  }),
  /**
   * Raid mode: when many first-time chatters arrive at once, CONDUIT is stricter with them for a while — their messages
   * with a link, or that any check matches (even one set to Log only), are deleted (or they're timed out). Optionally
   * the chatbot says so in chat. (Kick's own chat modes, like slow or followers-only, can't be changed by apps.)
   */
  raid: z
    .strictObject({
      enabled: z.boolean(),
      /** This many first-time chatters… */
      newChatters: z.number().int().min(3, 'At least 3').max(200, 'At most 200'),
      /** …within this many seconds starts raid mode. */
      windowSeconds: z.number().int().min(10, 'At least 10 seconds').max(600, 'At most 10 minutes'),
      /** How long raid mode lasts (and how long a first-time chatter counts as new). */
      durationMinutes: z.number().int().min(1, 'At least 1 minute').max(60, 'At most 60 minutes'),
      action: z.enum(['delete_message', 'timeout']),
      timeoutMinutes,
      /** The chatbot posts this when raid mode starts (empty: says nothing). */
      announcement: z.string().trim().max(300, 'At most 300 characters'),
    })
    .default({
      enabled: false,
      newChatters: 10,
      windowSeconds: 60,
      durationMinutes: 5,
      action: 'delete_message',
      timeoutMinutes: 5,
      announcement: 'Lots of new chatters at once: links from new accounts are removed for a few minutes.',
    }),
});
export type AutomodSettings = z.output<typeof automodSettingsSchema>;

/** Safe defaults: off, and every rule only logs until the streamer chooses an action; the new checks start switched off. */
export const AUTOMOD_DEFAULTS: AutomodSettings = automodSettingsSchema.parse({
  enabled: false,
  exemptModerators: true,
  ignoredUsers: [],
  blockedTerms: { enabled: true, terms: [], action: 'log', timeoutMinutes: 5 },
  repeat: { enabled: true, count: 3, windowSeconds: 30, action: 'log', timeoutMinutes: 1 },
  spam: { enabled: true, maxMessages: 8, windowSeconds: 10, action: 'log', timeoutMinutes: 1 },
});

/** Raid mode right now. */
export interface RaidState {
  /** Raid mode is on until then (null: off). */
  activeUntil: string | null;
  /** Raid mode can't start until CONDUIT has learned your regulars (it needs to have seen enough chat first). */
  learning: boolean;
  /** Different chatters CONDUIT knows in your Kick chat. */
  knownChatters: number;
}

export interface AutomodState {
  kick: AutomodSettings;
  /** Actions Kick can perform for automated protection now (from the main account's scopes). */
  kickActions: Record<AutomodAction, ModerationCapability>;
  raid: RaidState;
  /** Whether bans and timeouts done on Kick itself reach CONDUIT (its moderation.banned subscription), and why not. */
  kickModerationEvents: { ok: boolean; problem: string | null };
  /** Discord isn't supported, and why. */
  discord: { supported: false; reason: string };
  /** Messages checked and matched since the backend started (not persisted). */
  stats: { checked: number; matched: number; since: string };
}

// ── the checks (pure; the backend runs them on each chat message) ────────────

/** Kick writes emotes into the text as [emote:ID:NAME]. */
const KICK_EMOTE = /\[emote:\d+:[^\]\s]{1,64}\]/g;
const EMOJI = /\p{Extended_Pictographic}/gu;
/** A link: with http(s)://, www., or a domain with a common top-level domain. */
const LINK = /(?:https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gg|tv|io|co|me|ly|xyz|ru|info|app|live|link|site|shop|store|online|top|club|fun|biz|cc|to|in|us|uk|de)\b(?:\/[^\s]*)?)/giu;

/** The sites in a message's links (host names, lower case). */
export function linkHosts(text: string): string[] {
  return [...text.matchAll(LINK)].map((m) =>
    m[0]
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/?#:].*$/, ''),
  );
}

/** Whether a host is one of the allowed sites or a subdomain of one. */
const allowedHost = (host: string, sites: string[]) => sites.some((s) => host === s || host.endsWith(`.${s}`));

/** The links in a message that aren't to an allowed site. */
export function disallowedLinks(text: string, allowedSites: string[]): string[] {
  return linkHosts(text).filter((h) => !allowedHost(h, allowedSites));
}

/** The first text check a message trips (blocked words aside), with what it found; null when none. */
export function kickTextCheck(text: string, s: AutomodSettings): { rule: Exclude<AutomodRule, 'blocked_terms' | 'repeat' | 'spam'>; detail: string } | null {
  if (s.links.enabled) {
    const bad = disallowedLinks(text, s.links.allowedSites);
    if (bad.length) return { rule: 'links', detail: `Posted a link (${bad[0]!.slice(0, 60)}).` };
  }
  const plain = text.replace(KICK_EMOTE, '◆');
  if (s.caps.enabled) {
    const letters = [...plain.replace(/◆/g, '')].filter((c) => c.toLowerCase() !== c.toUpperCase());
    const upper = letters.filter((c) => c === c.toUpperCase()).length;
    if (letters.length >= s.caps.minLetters && (upper / letters.length) * 100 >= s.caps.percent) {
      return { rule: 'caps', detail: `${Math.round((upper / letters.length) * 100)}% capital letters.` };
    }
  }
  if (s.emotes.enabled) {
    const count = (text.match(KICK_EMOTE)?.length ?? 0) + (text.match(EMOJI)?.length ?? 0);
    if (count > s.emotes.maxEmotes) return { rule: 'emotes', detail: `${count} emotes in one message (more than ${s.emotes.maxEmotes}).` };
  }
  if (s.symbols.enabled) {
    const chars = [...plain.replace(/◆/g, '').replace(/\s/g, '')];
    const marks = (plain.match(/\p{M}/gu) ?? []).length;
    if (marks >= 10) return { rule: 'symbols', detail: 'Stacked accent marks (Zalgo text).' };
    if (chars.length >= 10) {
      const symbols = chars.filter((c) => !/[\p{L}\p{N}]/u.test(c)).length;
      const share = (symbols / chars.length) * 100;
      if (share >= s.symbols.percent) return { rule: 'symbols', detail: `${Math.round(share)}% symbols.` };
    }
  }
  if (s.longMessage.enabled) {
    const length = [...plain].length;
    if (length > s.longMessage.maxLength) return { rule: 'long_message', detail: `${length} characters (more than ${s.longMessage.maxLength}).` };
  }
  return null;
}

// ── one user's history (click a name in the Logs) ────────────────────────────

export const userHistorySchema = z.strictObject({
  platform: z.enum(['kick', 'discord']),
  userId: z.string().regex(/^\d{1,25}$/, 'Invalid user id'),
});

/** Everything recorded for one person on one platform: Kick's Logs, or Discord's whole Moderation log. */
export interface ModerationUserHistory {
  platform: 'kick' | 'discord';
  userId: string;
  history: ModerationRecordView[];
  serverHistory: DiscordServerModerationView[];
  protectionHistory: ProtectionEventView[];
  loggingHistory: DiscordLogEntryView[];
}
