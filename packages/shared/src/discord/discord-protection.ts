/**
 * Discord Automated Protection (Discord Bot → Protection). CONDUIT's own bot reacting to gateway events and the audit
 * log, acting through Discord's regular REST API. It works only while CONDUIT runs:
 *
 * 1. AutoMod — CONDUIT's own rules: custom words and patterns, mention spam, and member names. (Discord's built-in
 *    AutoMod isn't used or changed; rules made there stay in Server Settings → Safety Setup → AutoMod.)
 * 2. Message checks (repeats, flooding, caps, invite links), anti-nuke, anti-raid with the join gate, and bot bait.
 *
 * Everything starts off (or on "log only"), so nothing is deleted or punished until you choose.
 */
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{1,25}$/, 'Invalid id');
const line = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${what}`)
    .max(max, `Each ${what} is at most ${max} characters`)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'One per line');

// ── 1. AutoMod (CONDUIT's own rules) ─────────────────────────────────────────

export const AUTOMOD_TRIGGERS = ['keyword', 'mention_spam', 'member_profile'] as const;
export type AutomodTrigger = (typeof AUTOMOD_TRIGGERS)[number];

export const AUTOMOD_TRIGGER_LABEL: Record<AutomodTrigger, string> = {
  keyword: 'Custom words',
  mention_spam: 'Mention spam',
  member_profile: 'Member names',
};

export const AUTOMOD_TRIGGER_HELP: Record<AutomodTrigger, string> = {
  keyword: 'Messages with words, phrases or patterns from your list (* wildcards, regular expressions).',
  mention_spam: 'Messages that @mention too many members and roles at once (raids often do).',
  member_profile: 'Usernames and nicknames with words from your list, checked when members join or change nickname.',
};

/** At most this many rules per server. */
export const AUTOMOD_RULES_MAX = 25;

/** What a rule does when it matches. Timeout and kick also delete the message that triggered it (message rules). */
export const DISCORD_AUTOMOD_ACTIONS = ['log', 'delete_message', 'timeout', 'kick'] as const;
export type DiscordAutomodAction = (typeof DISCORD_AUTOMOD_ACTIONS)[number];
export const DISCORD_AUTOMOD_ACTION_LABEL: Record<DiscordAutomodAction, string> = {
  log: 'Log only',
  delete_message: 'Delete the message',
  timeout: 'Delete and time out',
  kick: 'Kick',
};

/** Which actions each kind of rule can take (names have no message to delete). */
export const AUTOMOD_ACTIONS_ALLOWED: Record<AutomodTrigger, readonly DiscordAutomodAction[]> = {
  keyword: ['log', 'delete_message', 'timeout'],
  mention_spam: ['log', 'delete_message', 'timeout'],
  member_profile: ['log', 'timeout', 'kick'],
};

/** For member-name rules, "Delete and time out" reads as just "Time out". */
export function automodActionLabel(trigger: AutomodTrigger, action: DiscordAutomodAction): string {
  return trigger === 'member_profile' && action === 'timeout' ? 'Time out' : DISCORD_AUTOMOD_ACTION_LABEL[action];
}

/** A pattern that compiles (case-insensitive, Unicode), or the reason it doesn't. */
export function regexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch {
    return 'Not a valid regular expression';
  }
}

/** A rule to create or update. */
export const automodRuleSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Give the rule a name').max(100, 'At most 100 characters'),
    enabled: z.boolean(),
    trigger: z.enum(AUTOMOD_TRIGGERS),
    keywords: z.array(line(60, 'word')).max(1000, 'At most 1000 words').default([]),
    regexPatterns: z.array(line(260, 'pattern')).max(10, 'At most 10 patterns').default([]),
    allowList: z.array(line(60, 'allowed word')).max(1000, 'At most 1000 allowed words').default([]),
    mentionLimit: z.number().int().min(1, 'At least 1').max(50, 'At most 50').nullable().default(null),
    action: z.enum(DISCORD_AUTOMOD_ACTIONS),
    timeoutMinutes: z.number().int().min(1, 'At least 1 minute').max(40_320, 'At most 28 days').default(10),
    /** Where a match is reported (with who, where and what). */
    alertChannelId: snowflake.nullable().default(null),
    /** Members with a moderator permission are never checked (message rules; names are always checked). */
    exemptModerators: z.boolean().default(true),
    exemptRoles: z.array(snowflake).max(50, 'At most 50 exempt roles').default([]),
    exemptChannels: z.array(snowflake).max(100, 'At most 100 exempt channels').default([]),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if ((r.trigger === 'keyword' || r.trigger === 'member_profile') && r.keywords.length === 0 && r.regexPatterns.length === 0)
      issue('keywords', 'Add at least one word or pattern');
    const bad = r.regexPatterns.find((p) => regexProblem(p));
    if (bad !== undefined) issue('regexPatterns', `Not a valid regular expression: ${bad}`);
    if (r.trigger === 'mention_spam' && r.mentionLimit === null) issue('mentionLimit', 'Set how many mentions are too many');
    if (!AUTOMOD_ACTIONS_ALLOWED[r.trigger].includes(r.action)) issue('action', `${AUTOMOD_TRIGGER_LABEL[r.trigger]} rules can’t do that`);
  });
export type AutomodRuleInput = z.output<typeof automodRuleSchema>;

/** A rule as CONDUIT keeps and shows it. */
export type DiscordAutomodRule = AutomodRuleInput & { id: string; guildId: string; createdAt: string; updatedAt: string };

export interface DiscordAutomodGuild {
  id: string;
  name: string;
  rules: DiscordAutomodRule[];
  /** For exemptions and alert channels (roles highest first, without @everyone; text channels). */
  roles: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string }>;
}

/** Text as rules compare it: lower case, NFKC (fancy letters become plain ones), single spaces. */
export function normalizeForAutomod(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/**
 * A word or phrase as a pattern, the way Discord's AutoMod reads them: whole words unless * says otherwise —
 * "cat" (whole word), "cat*" (words starting with it), "*cat" (ending with it), "*cat*" (anywhere).
 */
export function keywordPattern(keyword: string): RegExp {
  const k = normalizeForAutomod(keyword);
  const start = k.startsWith('*');
  const end = k.endsWith('*') && k.length > 1;
  const body = escapeRegExp(k.replace(/^\*/, '').replace(/\*$/, ''));
  return new RegExp(`${start ? '' : `(?<!${WORD_CHAR})`}${body}${end ? '' : `(?!${WORD_CHAR})`}`, 'iu');
}

/** Only this much of a message is matched (Discord's limit is 4000; patterns stay quick). */
const MATCH_CHARS = 2000;

/** A rule's words, patterns and allowed words, compiled once. */
export interface AutomodMatcher {
  /** The word, phrase or pattern found in the text, or null. */
  match(text: string): string | null;
}

export function automodMatcher(r: Pick<AutomodRuleInput, 'keywords' | 'regexPatterns' | 'allowList'>): AutomodMatcher {
  const words = r.keywords.filter((k) => k.replace(/\*/g, '').trim()).map((k) => ({ k, re: keywordPattern(k) }));
  const patterns = r.regexPatterns.flatMap((p) => (regexProblem(p) ? [] : [{ k: p, re: new RegExp(p, 'iu') }]));
  const allowed = r.allowList.filter((a) => a.trim()).map((a) => keywordPattern(a.replace(/\*/g, '')));
  return {
    match(raw) {
      let text = normalizeForAutomod(raw).slice(0, MATCH_CHARS);
      // Allowed words never count: they're taken out before matching.
      for (const a of allowed) text = text.replace(new RegExp(a.source, 'giu'), ' ');
      for (const w of [...words, ...patterns]) if (w.re.test(text)) return w.k;
      return null;
    },
  };
}

// ── 2. CONDUIT protection: message checks (gateway events + REST) ────────────

export const MESSAGE_CHECKS = ['repeat', 'flood', 'caps', 'invites'] as const;
export type MessageCheck = (typeof MESSAGE_CHECKS)[number];

export const MESSAGE_CHECK_LABEL: Record<MessageCheck, string> = {
  repeat: 'Repeated messages',
  flood: 'Message flooding',
  caps: 'Excessive caps',
  invites: 'Invite links',
};

/** What CONDUIT does when a check matches. Timeout also deletes the message that triggered it. */
export const PROTECTION_ACTIONS = ['log', 'delete_message', 'timeout'] as const;
export type ProtectionAction = (typeof PROTECTION_ACTIONS)[number];
export const PROTECTION_ACTION_LABEL: Record<ProtectionAction, string> = {
  log: 'Log only',
  delete_message: 'Delete the message',
  timeout: 'Delete and time out',
};

const action = z.enum(PROTECTION_ACTIONS);
const timeoutMinutes = z.number().int().min(1, 'At least 1 minute').max(40_320, 'At most 28 days');

export const messageChecksSchema = z.strictObject({
  enabled: z.boolean(),
  /** Members with a moderator permission (Manage Messages, Timeout/Kick/Ban Members, Administrator) are never checked. */
  exemptModerators: z.boolean(),
  exemptRoles: z.array(snowflake).max(50, 'At most 50 roles').default([]),
  exemptChannels: z.array(snowflake).max(100, 'At most 100 channels').default([]),
  repeat: z.strictObject({
    enabled: z.boolean(),
    count: z.number().int().min(2, 'At least 2').max(20, 'At most 20'),
    windowSeconds: z.number().int().min(5, 'At least 5 seconds').max(600, 'At most 10 minutes'),
    action,
    timeoutMinutes,
  }),
  flood: z.strictObject({
    enabled: z.boolean(),
    maxMessages: z.number().int().min(3, 'At least 3').max(50, 'At most 50'),
    windowSeconds: z.number().int().min(3, 'At least 3 seconds').max(120, 'At most 2 minutes'),
    action,
    timeoutMinutes,
  }),
  caps: z.strictObject({
    enabled: z.boolean(),
    /** Only messages with at least this many letters are checked. */
    minLetters: z.number().int().min(5, 'At least 5').max(500, 'At most 500'),
    percent: z.number().int().min(50, 'At least 50%').max(100, 'At most 100%'),
    action,
    timeoutMinutes,
  }),
  invites: z.strictObject({ enabled: z.boolean(), action, timeoutMinutes }),
});
export type MessageChecks = z.output<typeof messageChecksSchema>;

export const MESSAGE_CHECKS_DEFAULTS: MessageChecks = {
  enabled: false,
  exemptModerators: true,
  exemptRoles: [],
  exemptChannels: [],
  repeat: { enabled: true, count: 3, windowSeconds: 30, action: 'log', timeoutMinutes: 5 },
  flood: { enabled: true, maxMessages: 8, windowSeconds: 10, action: 'log', timeoutMinutes: 5 },
  caps: { enabled: true, minLetters: 12, percent: 80, action: 'log', timeoutMinutes: 5 },
  invites: { enabled: true, action: 'log', timeoutMinutes: 5 },
};

/** A Discord invite link (discord.gg/…, discord.com/invite/…, discordapp.com/invite/…). */
export const DISCORD_INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]{2,}/i;

/** Which check a message trips first, from its text (repeat and flood need history; the service tracks those). */
export function textCheck(text: string, s: MessageChecks): { check: 'caps' | 'invites'; detail: string } | null {
  if (s.invites.enabled && DISCORD_INVITE.test(text)) return { check: 'invites', detail: 'Posted a Discord invite link.' };
  if (s.caps.enabled) {
    const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
    const upper = letters.filter((c) => c === c.toUpperCase()).length;
    if (letters.length >= s.caps.minLetters && (upper / letters.length) * 100 >= s.caps.percent)
      return { check: 'caps', detail: `${Math.round((upper / letters.length) * 100)}% capital letters.` };
  }
  return null;
}

// ── state and log ────────────────────────────────────────────────────────────

// ── 3. CONDUIT protection: anti-nuke (audit log + REST) ──────────────────────

/**
 * Destructive actions counted per person (from the server's audit log). When someone does more than a rule allows within
 * its window, CONDUIT alerts and, in Enforce mode, responds against that person. The server owner, CONDUIT's own bot and
 * trusted people and roles are never acted on.
 */
export const ANTINUKE_RULES = ['channel_delete', 'channel_create', 'role_delete', 'role_create', 'role_update', 'ban', 'kick', 'prune', 'bot_add', 'webhook_create'] as const;
export type AntinukeRule = (typeof ANTINUKE_RULES)[number];

export const ANTINUKE_RULE_LABEL: Record<AntinukeRule, string> = {
  channel_delete: 'Channels deleted',
  channel_create: 'Channels created',
  role_delete: 'Roles deleted',
  role_create: 'Roles created',
  role_update: 'Dangerous permissions given',
  ban: 'Members banned',
  kick: 'Members kicked',
  prune: 'Members pruned',
  bot_add: 'Bots added',
  webhook_create: 'Webhooks created',
};

/** What one counted action is, for "3 channels deleted within 60 s". */
export const ANTINUKE_RULE_UNIT: Record<AntinukeRule, [string, string]> = {
  channel_delete: ['channel deleted', 'channels deleted'],
  channel_create: ['channel created', 'channels created'],
  role_delete: ['role deleted', 'roles deleted'],
  role_create: ['role created', 'roles created'],
  role_update: ['role given dangerous permissions', 'roles given dangerous permissions'],
  ban: ['member banned', 'members banned'],
  kick: ['member kicked', 'members kicked'],
  prune: ['prune', 'prunes'],
  bot_add: ['bot added', 'bots added'],
  webhook_create: ['webhook created', 'webhooks created'],
};

/** Permissions that make a role dangerous when they are added to it (role_update). */
export const DANGEROUS_PERMISSIONS: ReadonlyArray<{ name: string; bit: bigint }> = [
  { name: 'Administrator', bit: 1n << 3n },
  { name: 'Manage Server', bit: 1n << 5n },
  { name: 'Manage Roles', bit: 1n << 28n },
  { name: 'Manage Channels', bit: 1n << 4n },
  { name: 'Manage Webhooks', bit: 1n << 29n },
  { name: 'Ban Members', bit: 1n << 2n },
  { name: 'Kick Members', bit: 1n << 1n },
  { name: 'Mention Everyone', bit: 1n << 17n },
];

/** The dangerous permissions added between two permission values (decimal strings). */
export function dangerousPermissionsAdded(before: string | null | undefined, after: string | null | undefined): string[] {
  const toBits = (v: string | null | undefined) => {
    try {
      return v ? BigInt(v) : 0n;
    } catch {
      return 0n;
    }
  };
  const added = toBits(after) & ~toBits(before);
  return DANGEROUS_PERMISSIONS.filter((p) => (added & p.bit) === p.bit).map((p) => p.name);
}

export const ANTINUKE_MODES = ['alert', 'enforce'] as const;
export type AntinukeMode = (typeof ANTINUKE_MODES)[number];
export const ANTINUKE_MODE_LABEL: Record<AntinukeMode, string> = { alert: 'Alert only (dry run)', enforce: 'Enforce' };

export const ANTINUKE_RESPONSES = ['quarantine', 'timeout', 'kick', 'ban'] as const;
export type AntinukeResponse = (typeof ANTINUKE_RESPONSES)[number];
export const ANTINUKE_RESPONSE_LABEL: Record<AntinukeResponse, string> = {
  quarantine: 'Quarantine (remove their roles)',
  timeout: 'Time out',
  kick: 'Kick',
  ban: 'Ban',
};

const antinukeRule = z.strictObject({
  enabled: z.boolean(),
  threshold: z.number().int().min(1, 'At least 1').max(50, 'At most 50'),
  windowSeconds: z.number().int().min(5, 'At least 5 seconds').max(3600, 'At most 1 hour'),
});
export type AntinukeRuleSettings = z.output<typeof antinukeRule>;

export const antinukeSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(ANTINUKE_MODES),
  response: z.enum(ANTINUKE_RESPONSES),
  timeoutMinutes,
  /** Enforce: also remove a bot that was added by someone who tripped "Bots added". */
  removeAddedBots: z.boolean(),
  alertChannel: z.strictObject({ guildId: snowflake, channelId: snowflake }).nullable(),
  trustedUsers: z.array(snowflake).max(100, 'At most 100 trusted people'),
  trustedRoles: z.array(snowflake).max(50, 'At most 50 trusted roles'),
  rules: z.strictObject(Object.fromEntries(ANTINUKE_RULES.map((r) => [r, antinukeRule])) as Record<AntinukeRule, typeof antinukeRule>),
});
export type AntinukeSettings = z.output<typeof antinukeSchema>;

export const ANTINUKE_PRESETS = ['lenient', 'balanced', 'strict'] as const;
export type AntinukePreset = (typeof ANTINUKE_PRESETS)[number];
export const ANTINUKE_PRESET_LABEL: Record<AntinukePreset, string> = { lenient: 'Lenient', balanced: 'Balanced', strict: 'Strict' };

/** Thresholds per preset: [how many, within seconds]. */
const PRESET_VALUES: Record<AntinukePreset, Record<AntinukeRule, [number, number]>> = {
  lenient: { channel_delete: [5, 60], channel_create: [10, 60], role_delete: [5, 60], role_create: [10, 60], role_update: [3, 60], ban: [10, 60], kick: [10, 60], prune: [2, 600], bot_add: [3, 600], webhook_create: [5, 60] },
  balanced: { channel_delete: [3, 60], channel_create: [5, 60], role_delete: [3, 60], role_create: [5, 60], role_update: [2, 60], ban: [5, 60], kick: [5, 60], prune: [1, 600], bot_add: [2, 600], webhook_create: [3, 60] },
  strict: { channel_delete: [2, 120], channel_create: [3, 60], role_delete: [2, 120], role_create: [3, 60], role_update: [1, 60], ban: [3, 60], kick: [3, 60], prune: [1, 3600], bot_add: [1, 3600], webhook_create: [2, 60] },
};

/** The rules of a preset (every rule on). */
export function antinukePreset(p: AntinukePreset): AntinukeSettings['rules'] {
  return Object.fromEntries(ANTINUKE_RULES.map((r) => [r, { enabled: true, threshold: PRESET_VALUES[p][r][0], windowSeconds: PRESET_VALUES[p][r][1] }])) as AntinukeSettings['rules'];
}

/** Which preset the rules match exactly, if any. */
export function matchingAntinukePreset(rules: AntinukeSettings['rules']): AntinukePreset | null {
  return ANTINUKE_PRESETS.find((p) => ANTINUKE_RULES.every((r) => JSON.stringify(antinukePreset(p)[r]) === JSON.stringify(rules[r]))) ?? null;
}

/** Off, and "Alert only" when switched on, so nothing is done to anyone until you choose Enforce. */
export const ANTINUKE_DEFAULTS: AntinukeSettings = {
  enabled: false,
  mode: 'alert',
  response: 'quarantine',
  timeoutMinutes: 60,
  removeAddedBots: true,
  alertChannel: null,
  trustedUsers: [],
  trustedRoles: [],
  rules: antinukePreset('balanced'),
};

/** A member anti-nuke quarantined (their roles removed). */
export interface QuarantineView {
  id: string;
  at: string;
  guildId: string;
  place: string | null;
  userId: string;
  userName: string | null;
  /** The roles CONDUIT removed (names where still known). */
  roles: Array<{ id: string; name: string | null }>;
  reason: string;
  status: 'active' | 'restored' | 'released';
  resolvedAt: string | null;
}

// ── 4. CONDUIT protection: anti-raid and the join gate (gateway + REST) ──────

/** Discord's verification levels (guild verification_level 0–4). Lockdown can raise it to medium, high or highest. */
export const VERIFICATION_LEVELS = ['none', 'low', 'medium', 'high', 'very_high'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
export const VERIFICATION_LEVEL_LABEL: Record<VerificationLevel, string> = {
  none: 'None',
  low: 'Low (verified email)',
  medium: 'Medium (on Discord 5+ minutes)',
  high: 'High (member 10+ minutes)',
  very_high: 'Highest (verified phone)',
};
export const LOCKDOWN_VERIFICATION_LEVELS = ['medium', 'high', 'very_high'] as const;

/** What happens to a new member who fails the join gate. "Hold": Verify buttons (Embed Creator) won't let them in. */
export const JOIN_GATE_RESPONSES = ['alert', 'hold', 'kick'] as const;
export type JoinGateResponse = (typeof JOIN_GATE_RESPONSES)[number];
export const JOIN_GATE_RESPONSE_LABEL: Record<JoinGateResponse, string> = {
  alert: 'Alert only',
  hold: 'Hold: Verify buttons won’t let them in',
  kick: 'Kick',
};

export const antiraidSchema = z
  .strictObject({
    /** Join-burst detection. */
    enabled: z.boolean(),
    mode: z.enum(ANTINUKE_MODES),
    joinThreshold: z.number().int().min(2, 'At least 2').max(100, 'At most 100'),
    joinWindowSeconds: z.number().int().min(5, 'At least 5 seconds').max(300, 'At most 5 minutes'),
    /** Lockdown: raise the verification level, and/or stop @everyone sending messages in these channels. */
    raiseVerification: z.boolean(),
    verificationLevel: z.enum(LOCKDOWN_VERIFICATION_LEVELS),
    lockChannels: z.array(snowflake).max(50, 'At most 50 channels'),
    /** Lift an automatic lockdown after this many minutes without new joins (0: only by hand). */
    autoLiftMinutes: z.number().int().min(0).max(1440, 'At most 24 hours'),
    alertChannel: z.strictObject({ guildId: snowflake, channelId: snowflake }).nullable(),
    gate: z.strictObject({
      enabled: z.boolean(),
      minAccountAgeDays: z.number().int().min(0).max(365, 'At most 365 days'),
      requireAvatar: z.boolean(),
      response: z.enum(JOIN_GATE_RESPONSES),
    }),
  })
  .superRefine((s, ctx) => {
    if (s.gate.enabled && s.gate.minAccountAgeDays === 0 && !s.gate.requireAvatar)
      ctx.addIssue({ code: 'custom', path: ['gate', 'minAccountAgeDays'], message: 'Set a minimum account age or require an avatar' });
  });
export type AntiraidSettings = z.output<typeof antiraidSchema>;

export const ANTIRAID_PRESETS = ['lenient', 'balanced', 'strict'] as const;
export type AntiraidPreset = (typeof ANTIRAID_PRESETS)[number];
const ANTIRAID_PRESET_VALUES: Record<AntiraidPreset, { joinThreshold: number; joinWindowSeconds: number; minAccountAgeDays: number; requireAvatar: boolean }> = {
  lenient: { joinThreshold: 15, joinWindowSeconds: 10, minAccountAgeDays: 1, requireAvatar: false },
  balanced: { joinThreshold: 10, joinWindowSeconds: 10, minAccountAgeDays: 7, requireAvatar: false },
  strict: { joinThreshold: 5, joinWindowSeconds: 10, minAccountAgeDays: 30, requireAvatar: true },
};

/** Settings with a preset's join threshold and join-gate checks. */
export function applyAntiraidPreset(s: AntiraidSettings, p: AntiraidPreset): AntiraidSettings {
  const v = ANTIRAID_PRESET_VALUES[p];
  return { ...s, joinThreshold: v.joinThreshold, joinWindowSeconds: v.joinWindowSeconds, gate: { ...s.gate, minAccountAgeDays: v.minAccountAgeDays, requireAvatar: v.requireAvatar } };
}

export function matchingAntiraidPreset(s: AntiraidSettings): AntiraidPreset | null {
  return ANTIRAID_PRESETS.find((p) => JSON.stringify(applyAntiraidPreset(s, p)) === JSON.stringify(s)) ?? null;
}

/** Off; switched on, burst detection starts on "Alert only" and the join gate only alerts. */
export const ANTIRAID_DEFAULTS: AntiraidSettings = {
  enabled: false,
  mode: 'alert',
  joinThreshold: 10,
  joinWindowSeconds: 10,
  raiseVerification: true,
  verificationLevel: 'high',
  lockChannels: [],
  autoLiftMinutes: 15,
  alertChannel: null,
  gate: { enabled: false, minAccountAgeDays: 7, requireAvatar: false, response: 'alert' },
};

/** When a Discord account was created, from its id (a snowflake carries its creation time). */
export function snowflakeCreatedAt(id: string): Date | null {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1_420_070_400_000n));
  } catch {
    return null;
  }
}

/** Why a new account fails the join gate, or null when it passes. */
export function joinGateProblem(gate: AntiraidSettings['gate'], account: { createdAt: Date | null; hasAvatar: boolean | null }, now: Date): string | null {
  const problems: string[] = [];
  if (gate.minAccountAgeDays > 0 && account.createdAt) {
    const days = Math.floor((now.getTime() - account.createdAt.getTime()) / 86_400_000);
    if (days < gate.minAccountAgeDays) problems.push(`account is ${days} day${days === 1 ? '' : 's'} old (minimum ${gate.minAccountAgeDays})`);
  }
  if (gate.requireAvatar && account.hasAvatar === false) problems.push('no profile picture');
  return problems.length ? problems.join('; ') : null;
}

/** A lockdown in effect in one server. */
export interface LockdownView {
  guildId: string;
  place: string | null;
  since: string;
  reason: string;
  /** Raised by hand (only lifted by hand). */
  manual: boolean;
  /** When an automatic lockdown lifts if no one else joins. */
  liftAt: string | null;
  verification: { from: VerificationLevel; to: VerificationLevel } | null;
  lockedChannels: Array<{ id: string; name: string | null }>;
  /** What couldn't be done (e.g. a channel the bot can't change). */
  problems: string[];
}

// ── 5. CONDUIT protection: bot bait (gateway + REST) ─────────────────────────

/**
 * Trap channels real members are told not to post in. Anyone who posts there anyway (except bots, moderators and exempt
 * roles) is treated as a spam account. Off by default; "Alert only" until you choose an action.
 */
export const BOTBAIT_ACTIONS = ['alert', 'delete', 'timeout', 'kick', 'softban', 'ban'] as const;
export type BotbaitAction = (typeof BOTBAIT_ACTIONS)[number];
export const BOTBAIT_ACTION_LABEL: Record<BotbaitAction, string> = {
  alert: 'Alert only',
  delete: 'Delete the message',
  timeout: 'Delete and time out',
  kick: 'Delete and kick',
  softban: 'Softban (ban and unban: wipes their recent messages)',
  ban: 'Ban',
};

export const botbaitSchema = z.strictObject({
  enabled: z.boolean(),
  channels: z.array(snowflake).max(10, 'At most 10 bait channels'),
  action: z.enum(BOTBAIT_ACTIONS),
  timeoutMinutes,
  /** Softban and ban: delete their messages from this many recent hours (0–168). */
  deleteMessageHours: z.number().int().min(0).max(168, 'At most 7 days (168 hours)'),
  exemptModerators: z.boolean(),
  exemptRoles: z.array(snowflake).max(50, 'At most 50 roles'),
  alertChannel: z.strictObject({ guildId: snowflake, channelId: snowflake }).nullable(),
});
export type BotbaitSettings = z.output<typeof botbaitSchema>;

export const BOTBAIT_DEFAULTS: BotbaitSettings = {
  enabled: false,
  channels: [],
  action: 'alert',
  timeoutMinutes: 60,
  deleteMessageHours: 1,
  exemptModerators: true,
  exemptRoles: [],
  alertChannel: null,
};

/** The warning CONDUIT can post in a bait channel (no CONDUIT branding: the community sees it). */
export function botbaitWarning(action: BotbaitAction): { title: string; description: string } {
  const consequence: Record<BotbaitAction, string> = {
    alert: 'Anything posted here is reported to the moderators.',
    delete: 'Anything posted here is deleted automatically.',
    timeout: 'Anything posted here is deleted and the account is timed out automatically.',
    kick: 'Anything posted here is deleted and the account is kicked automatically.',
    softban: 'Anything posted here is deleted and the account is removed from the server automatically.',
    ban: 'Anything posted here gets the account banned automatically.',
  };
  return { title: '⚠️ Do not post in this channel', description: `This channel catches spam bots. ${consequence[action]}` };
}

/** One thing CONDUIT protection noticed or did (Discord Bot → Logs). */
export interface ProtectionEventView {
  id: string;
  at: string;
  place: string | null;
  feature: 'message' | 'antinuke' | 'antiraid' | 'joingate' | 'botbait';
  /** e.g. "repeat", "channel_delete", "join_burst". */
  rule: string;
  userId: string | null;
  userName: string | null;
  action: string;
  outcome: 'success' | 'failed' | 'logged';
  detail: string | null;
}

export interface DiscordProtectionState {
  messageChecks: MessageChecks;
  automod: { guilds: DiscordAutomodGuild[]; problem: string | null };
  /** Messages checked and matched since CONDUIT started (not stored). */
  stats: { checked: number; matched: number; since: string };
  /** Whether CONDUIT can read message text (the required Message Content intent is on). */
  messageContent: boolean;
  antinuke: AntinukeSettings;
  /** Newest first. */
  quarantine: QuarantineView[];
  antiraid: AntiraidSettings;
  lockdowns: LockdownView[];
  botbait: BotbaitSettings;
}
