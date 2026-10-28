/**
 * Custom commands for Discord and Kick: a trigger, a text response template (Discord markdown welcome on Discord), and variables filled in from the
 * real event that triggered the command. Templates are text with {variable} placeholders — never code. Rendering is a
 * single pass (inserted values are never re-scanned), so a value containing "{user}" stays literal.
 *
 * Variables (the same names on both platforms):
 * - {user}    — username of the person who used the command (Kick: chat username; Discord: their username)
 * - {channel} — channel name (Kick: the channel slug, e.g. retronix; Discord: the text channel's name, e.g. general)
 * - {args}    — text after the command (Kick: words after the trigger; Discord: the command's optional "text" option);
 *               empty when nothing was given
 * - {message} — the full command as typed (Kick: the chat message; Discord: "/name text")
 *
 * Values are cleaned (control characters removed, whitespace collapsed, length capped). The finished reply is fitted to
 * the platform's limit (Kick: 500 characters / 2048 bytes; Discord: 2000 characters), ending with "…" when shortened.
 */
import { z } from 'zod';
import { fillVariables, unsupportedVariables, variableTokens, type VariableData } from './command-variables';
import { GIVEAWAY_ENTER } from './giveaways';
import { KICK_CHAT_MAX_BYTES, KICK_CHAT_MAX_CHARS } from '../kick/kick-setup';

export const COMMAND_PLATFORMS = ['discord', 'kick'] as const;
export type CommandPlatform = (typeof COMMAND_PLATFORMS)[number];
export const commandPlatformSchema = z.enum(COMMAND_PLATFORMS);

export const COMMAND_VARIABLES = ['user', 'channel', 'args', 'message'] as const;
export type CommandVariable = (typeof COMMAND_VARIABLES)[number];
export type CommandVariables = Partial<Record<CommandVariable, string | null>>;

/** Per-platform limits and trigger formats. */
export const PLATFORM_RULES = {
  kick: { prefix: '!', maxChars: KICK_CHAT_MAX_CHARS, maxBytes: KICK_CHAT_MAX_BYTES, triggerPattern: /^![a-z0-9_-]{1,31}$/ },
  // Discord slash command names: lower case, 1–32 characters (letters, digits, - and _ here).
  discord: { prefix: '/', maxChars: 2000, maxBytes: Number.POSITIVE_INFINITY, triggerPattern: /^\/[a-z0-9_-]{1,32}$/ },
} as const;

/** Names that are built into a platform and can't be used for custom commands. */
export const RESERVED_TRIGGERS: Record<CommandPlatform, readonly string[]> = {
  discord: ['/ping', '/timeout', '/untimeout', '/ban', '/unban'],
  kick: [GIVEAWAY_ENTER.kick],
};

/**
 * Placeholders in a template that aren't supported variables (e.g. "{sender.username}"), or (with a platform) aren't
 * available on it (e.g. {mention} in a Kick command). The full catalogue is in command-variables.ts.
 */
export function unknownVariables(template: string, platform?: CommandPlatform): string[] {
  return unsupportedVariables(template, platform);
}

/** Variables that read text typed after the command (besides {1}…{9}). */
const COMMAND_TEXT_VARIABLES = [
  'args',
  'message',
  'touser',
];

/** Whether a reply reads text typed after the command (Discord then offers the optional "text" box). */
export function usesCommandText(template: string): boolean {
  return variableTokens(template).some((t) => COMMAND_TEXT_VARIABLES.includes(t.name) || /^[1-9]$/.test(t.name));
}

const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].map((g) => g.segment);

/** Shortens to the platform's limits (grapheme-safe), ending with "…" when it had to cut. */
export function fitToPlatform(text: string, platform: CommandPlatform): string {
  const rules = PLATFORM_RULES[platform];
  let parts = graphemes(text);
  const fits = (p: string[]) => p.length <= rules.maxChars && new TextEncoder().encode(p.join('')).length <= rules.maxBytes;
  if (fits(parts)) return text;
  parts = parts.slice(0, rules.maxChars - 1);
  while (parts.length > 0 && !fits([...parts, '…'])) parts.pop();
  return `${parts.join('').trimEnd()}…`;
}

/**
 * Fills in the template (see command-variables.ts) and fits it to the platform. Known variables get their (cleaned)
 * value, else their fallback, else nothing; unknown placeholders stay exactly as written. Single pass: inserted text is
 * never treated as a template. Extra spaces (e.g. where an empty variable was) are tidied. Kick replies are one line;
 * Discord replies keep their line breaks, indentation and code exactly, so Discord markdown (lists, quotes, code blocks,
 * headings) comes out as written.
 */
export function renderCommand(template: string, data: VariableData, platform: CommandPlatform): string {
  const filled = fillVariables(template, data, platform);
  const tidy =
    platform === 'discord'
      ? filled
          .split(/(```[\s\S]*?```|`[^`\n]*`)/)
          .map((part, i) => (i % 2 === 1 ? part : part.replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ').replace(/[ \t]+$/gm, '')))
          .join('')
          .trim()
      : filled.replace(/\s{2,}/g, ' ').trim();
  return fitToPlatform(tidy, platform);
}

/** renderCommand with only the basic values ({user}, {channel}, {args}, {message}). */
export function renderTemplate(template: string, vars: CommandVariables, platform: CommandPlatform): string {
  return renderCommand(template, { user: vars.user ?? '', channel: vars.channel ?? null, args: vars.args ?? '', message: vars.message ?? '' }, platform);
}

// ── validation ──────────────────────────────────────────────────────────────

export function normalizeTrigger(raw: string, platform: CommandPlatform): string {
  let t = raw.trim().toLowerCase();
  // Accept "discord" for Discord as "/discord"; Kick triggers must be typed with "!".
  if (platform === 'discord' && t && !t.startsWith('/')) t = `/${t}`;
  return t;
}

export function triggerSchema(platform: CommandPlatform) {
  const rules = PLATFORM_RULES[platform];
  return z
    .string()
    .transform((t) => normalizeTrigger(t, platform))
    .refine(
      (t) => t.startsWith(rules.prefix),
      platform === 'kick' ? 'A trigger starts with "!", for example !discord' : 'A command name is a single word',
    )
    .refine(
      (t) => rules.triggerPattern.test(t),
      platform === 'kick'
        ? 'Use "!" followed by 1–31 letters, numbers, "-" or "_" (no spaces)'
        : 'Use 1–32 lower-case letters, numbers, "-" or "_" (no spaces)',
    )
    .superRefine((t, ctx) => {
      if (RESERVED_TRIGGERS[platform].includes(t))
        ctx.addIssue({ code: 'custom', message: `${t} is a default command and can’t be reused` });
    });
}

/**
 * Rules for a response template. New and edited responses must use only supported variables; a stored command with
 * an unknown placeholder still runs (`allowUnknownVariables`), posting that placeholder as written. Kick responses are
 * one line; Discord responses may have line breaks (for Discord markdown), stored as "\n".
 */
export function responseSchema(platform: CommandPlatform, allowUnknownVariables = false) {
  const rules = PLATFORM_RULES[platform];
  return z
    .string()
    .transform((s) => (platform === 'discord' ? s.replace(/\r\n?/g, '\n') : s))
    .pipe(z.string().trim().min(1, 'Enter the response to post'))
    .refine(
      (s) => !(platform === 'discord' ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s),
      platform === 'discord' ? 'The response contains unsupported characters (tabs or control characters)' : 'Responses are a single line of text',
    )
    .refine(
      (s) => platform !== 'kick' || !/^[!/]/.test(s),
      'A Kick response can’t start with "!" or "/" (so it can’t trigger a command or a Kick chat command)',
    )
    .refine((s) => [...new Intl.Segmenter().segment(s)].length <= rules.maxChars, `Up to ${rules.maxChars} characters`)
    .refine((s) => new TextEncoder().encode(s).length <= rules.maxBytes, 'This response is too long')
    .superRefine((s, ctx) => {
      const unknown = allowUnknownVariables ? [] : unknownVariables(s, platform);
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t a variable' : 'aren’t variables'} ${platform === 'kick' ? 'for Kick commands' : 'for Discord commands'}. See Variables for the list.`,
        });
      }
    });
}

// ── permissions and cooldowns ────────────────────────────────────────────────

/**
 * Who may use a command. Each level includes the ones above it (a moderator may use subscriber commands, the
 * broadcaster may use everything). Decided from the platform's own data, never from names:
 * - Kick (signed chat.message.sent): broadcaster = the sender is the channel owner (same user id); moderator = Kick's
 *   "moderator" badge; subscriber = Kick's "subscriber" badge. Other badges grant nothing; no badge data = no role.
 * - Discord (the interaction's member permissions, computed by Discord): moderator = Manage Messages, Timeout Members,
 *   Kick Members, Ban Members or Administrator; "broadcaster" = Administrator (the server owner always has it).
 *   Discord has no subscribers, so that level isn't available there.
 */
export const COMMAND_PERMISSIONS = ['everyone', 'subscriber', 'moderator', 'broadcaster'] as const;
export type CommandPermission = (typeof COMMAND_PERMISSIONS)[number];

export const PERMISSION_HELP: Record<CommandPlatform, Record<CommandPermission, { label: string; who: string; available: boolean }>> = {
  kick: {
    everyone: { label: 'Anyone', who: 'Anyone in your chat', available: true },
    subscriber: { label: 'Subscribers', who: 'Subscribers (Kick subscriber badge), moderators and you', available: true },
    moderator: { label: 'Moderators', who: 'Your channel’s moderators (Kick moderator badge) and you', available: true },
    broadcaster: { label: 'Broadcaster only', who: 'Only you, the channel owner', available: true },
  },
  discord: {
    // The Discord access groups: Anyone, Moderator, Admin.
    everyone: { label: 'Anyone', who: 'Anyone who can use commands in the server', available: true },
    subscriber: { label: 'Subscribers', who: 'Not available: Discord has no subscribers', available: false },
    moderator: {
      label: 'Moderator',
      who: 'Members with Manage Messages, Timeout Members, Kick Members, Ban Members or Administrator',
      available: true,
    },
    broadcaster: { label: 'Admin', who: 'Members with Administrator (the server owner always has it)', available: true },
  },
};

export const COOLDOWN_MODES = ['none', 'user', 'global'] as const;
export type CooldownMode = (typeof COOLDOWN_MODES)[number];
export const COOLDOWN_MIN_SECONDS = 1;
export const COOLDOWN_MAX_SECONDS = 86_400;
export const COOLDOWN_DEFAULT_SECONDS = 30;

const permissionSchema = (platform: CommandPlatform) =>
  z.enum(COMMAND_PERMISSIONS).superRefine((p, ctx) => {
    if (!PERMISSION_HELP[platform][p].available) ctx.addIssue({ code: 'custom', message: PERMISSION_HELP[platform][p].who });
  });

const cooldownSecondsSchema = z
  .number()
  .int('Use whole seconds')
  .min(0)
  .max(COOLDOWN_MAX_SECONDS, `Up to ${COOLDOWN_MAX_SECONDS} seconds (24 hours)`);

/** A cooldown needs a duration; "no cooldown" stores 0. Checked on the final (merged) values. */
export function cooldownProblem(mode: CooldownMode, seconds: number): string | null {
  if (mode === 'none') return null;
  if (!Number.isInteger(seconds) || seconds < COOLDOWN_MIN_SECONDS || seconds > COOLDOWN_MAX_SECONDS) {
    return `Choose ${COOLDOWN_MIN_SECONDS}–${COOLDOWN_MAX_SECONDS} seconds`;
  }
  return null;
}

/** "Moderators · 30 s per user" — the effective access settings in a few words. */
export function describeAccess(platform: CommandPlatform, permission: CommandPermission, mode: CooldownMode, seconds: number): string {
  const who = PERMISSION_HELP[platform][permission].label;
  if (mode === 'none') return `${who} · no cooldown`;
  return `${who} · ${formatSeconds(seconds)} ${mode === 'user' ? 'per user' : 'for everyone'}`;
}

export function formatSeconds(s: number): string {
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0 && s >= 60) return `${s / 60} min`;
  return `${s} s`;
}

/** Discord requires a short description for every slash command. Kick commands don't have one. */
const descriptionSchema = z.string().trim().min(1, 'Discord needs a short description').max(100, 'Up to 100 characters');

export function createCommandSchema(platform: CommandPlatform) {
  return z
    .strictObject({
      trigger: triggerSchema(platform),
      response: responseSchema(platform),
      enabled: z.boolean().default(true),
      description: platform === 'discord' ? descriptionSchema : z.null().optional(),
      // Defaults keep the original behaviour: everyone, no cooldown.
      permission: permissionSchema(platform).default('everyone'),
      cooldownMode: z.enum(COOLDOWN_MODES).default('none'),
      cooldownSeconds: cooldownSecondsSchema.default(0),
    })
    .superRefine((v, ctx) => {
      const problem = cooldownProblem(v.cooldownMode, v.cooldownSeconds);
      if (problem) ctx.addIssue({ code: 'custom', path: ['cooldownSeconds'], message: problem });
    });
}

export function updateCommandSchema(platform: CommandPlatform) {
  return z
    .strictObject({
      trigger: triggerSchema(platform).optional(),
      response: responseSchema(platform).optional(),
      enabled: z.boolean().optional(),
      description: platform === 'discord' ? descriptionSchema.optional() : z.null().optional(),
      permission: permissionSchema(platform).optional(),
      cooldownMode: z.enum(COOLDOWN_MODES).optional(),
      cooldownSeconds: cooldownSecondsSchema.optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
}

// ── views ───────────────────────────────────────────────────────────────────

export interface CommandRun {
  at: string;
  /**
   * sent: the platform confirmed the reply; failed: not posted; unconfirmed: CONDUIT couldn't tell;
   * blocked: not run (the user lacked permission, or the command was on cooldown).
   */
  outcome: 'sent' | 'failed' | 'unconfirmed' | 'blocked';
  detail: string | null;
}

export interface CustomCommandView {
  id: string;
  platform: CommandPlatform;
  trigger: string;
  description: string | null;
  response: string;
  enabled: boolean;
  permission: CommandPermission;
  cooldownMode: CooldownMode;
  /** 0 when there is no cooldown. */
  cooldownSeconds: number;
  /** e.g. "Moderators · 30 s per user". */
  access: string;
  createdAt: string;
  updatedAt: string;
  /** Whether it can run (a stored command that breaks the current rules can't). */
  valid: boolean;
  problem: string | null;
  /** Placeholders it contains that aren't variables; they are posted exactly as written. */
  unknownVariables: string[];
  lastRun: CommandRun | null;
  runs: number;
}

export interface DefaultCommandView {
  trigger: string;
  description: string;
  /** Who may use it. */
  permission: CommandPermission;
  /** Switched on. */
  enabled: boolean;
  /** Whether it can be switched off (Commands → Kick → Default Commands → Edit). */
  canDisable: boolean;
  /** Why it doesn't answer although it's on (e.g. a custom command uses its trigger), else null. */
  inactiveReason: string | null;
  /** What goes after the trigger (optional ones in [brackets]), shown as tags under the description. */
  args: string[];
  /** A filled-in example, shown under the message. */
  example: string | null;
  /** What it answers, with {variables} where the details go (null: no reply). */
  message: string | null;
}

export interface CommandsHubState {
  platform: CommandPlatform;
  defaults: DefaultCommandView[];
  custom: CustomCommandView[];
  ready: { ok: boolean; note: string | null; sendAs: string | null; channel: string | null };
  /** Discord only: whether Discord has the current set of slash commands (custom ones included). */
  registration: { status: string; problem: string | null } | null;
  recent: Array<{ at: string; trigger: string; outcome: CommandRun['outcome']; detail: string | null }>;
}
