/**
 * Giveaways: contracts shared by the backend and the dashboard.
 *
 * Lifecycle: draft → open (accepting entries) → closed (entries closed) → drawn (winners picked), or cancelled from any
 * state before drawing. At most one giveaway is open at a time, so the entry methods (!enter on Kick, 🎉 on
 * Discord) always mean the same giveaway. Entries are unique per platform and platform user id; the same person on
 * Kick and Discord counts as two entrants (accounts aren't linked across platforms).
 */
import { z } from 'zod';
import { KICK_CHAT_MAX_BYTES, KICK_CHAT_MAX_CHARS } from '../kick/kick-setup';

export const GIVEAWAY_STATUSES = ['draft', 'open', 'closed', 'drawn', 'cancelled'] as const;
export type GiveawayStatus = (typeof GIVEAWAY_STATUSES)[number];

export const GIVEAWAY_PLATFORMS = ['kick', 'discord'] as const;
export type GiveawayPlatform = (typeof GIVEAWAY_PLATFORMS)[number];

export const GIVEAWAY_PRIZE_MAX = 100;
export const GIVEAWAY_DESCRIPTION_MAX = 500;
export const GIVEAWAY_WINNERS_MAX = 50;
/** Up to one week. No duration: entries stay open until ended from the dashboard. */
export const GIVEAWAY_DURATION_MAX_MINUTES = 7 * 24 * 60;
export const GIVEAWAY_REASON_MAX = 200;

/** The Kick entry command (built in; custom Kick commands can't use it). Discord entries are 🎉 reactions only. */
export const GIVEAWAY_ENTER = { kick: '!enter' } as const;

const noControlChars = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

const prizeSchema = z
  .string()
  .trim()
  .min(1, 'Enter the prize')
  .max(GIVEAWAY_PRIZE_MAX, `At most ${GIVEAWAY_PRIZE_MAX} characters`)
  .refine(noControlChars, 'The prize is a single line of text');

const descriptionSchema = z
  .string()
  .trim()
  .max(GIVEAWAY_DESCRIPTION_MAX, `At most ${GIVEAWAY_DESCRIPTION_MAX} characters`)
  .refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), 'The description contains unsupported characters')
  .transform((s) => (s === '' ? null : s))
  .nullable();

const winnerCountSchema = z
  .number({ message: 'Enter a number of winners' })
  .int('Use a whole number')
  .min(1, 'At least 1 winner')
  .max(GIVEAWAY_WINNERS_MAX, `At most ${GIVEAWAY_WINNERS_MAX} winners`);

const durationSchema = z
  .number({ message: 'Enter a duration in minutes' })
  .int('Use whole minutes')
  .min(1, 'At least 1 minute')
  .max(GIVEAWAY_DURATION_MAX_MINUTES, 'At most 7 days (10080 minutes)')
  .nullable();

const platformsSchema = z
  .array(z.enum(GIVEAWAY_PLATFORMS))
  .min(1, 'Choose at least one platform')
  .max(GIVEAWAY_PLATFORMS.length)
  .transform((list) => GIVEAWAY_PLATFORMS.filter((p) => list.includes(p)));

const snowflake = z.string().regex(/^\d{1,25}$/, 'Invalid Discord id');

/** The Discord channel to post the giveaway embed in (null: no Discord announcement). */
const discordChannelSchema = z.strictObject({ guildId: snowflake, channelId: snowflake }).nullable();
export type DiscordChannelRef = z.output<typeof discordChannelSchema>;

/** The button on a Discord giveaway announcement (Discord entry is by this button only, and can't be undone). */
export const GIVEAWAY_BUTTONS = {
  enter: { label: 'Enter Giveaway', emoji: '🎉' },
} as const;

/** Private (ephemeral) replies to the Discord buttons; never sent publicly or by DM. */
export const DISCORD_BUTTON_REPLIES = {
  entered: 'You’ve entered the giveaway! 🎉',
  alreadyEntered: 'You’re already entered in this giveaway!',
  closed: 'This giveaway is closed. Entries are no longer accepted.',
  unavailable: 'This giveaway is no longer available.',
  failed: 'Something went wrong. Please try again.',
} as const;

/**
 * Ticket rule (documented in docs/SETUP.md#giveaways): every entrant has 1 base ticket; each accepted Kick reward
 * redemption adds the reward's bonus tickets; a verified active Kick subscriber's total is multiplied:
 *   weight = (1 + bonus tickets) × (subscriber ? multiplier : 1).
 * Example: 2 bonus tickets, 2× multiplier → (1 + 2) × 2 = 6 tickets.
 */
export const GIVEAWAY_MULTIPLIER_MAX = 10;
export const KICK_REWARD_TITLE_MAX = 50;
export const KICK_REWARD_DEFAULTS = { cost: 500, tickets: 1, title: 'Bonus giveaway ticket' } as const;

const kickRewardSchema = z
  .strictObject({
    cost: z.number({ message: 'Enter the cost in Channel Points' }).int('Use whole points').min(1, 'At least 1 point').max(10_000_000, 'Too many points'),
    tickets: z.number({ message: 'Enter the bonus tickets' }).int('Use whole tickets').min(1, 'At least 1 ticket').max(100, 'At most 100 tickets'),
    title: z
      .string()
      .trim()
      .min(1, 'Enter the reward’s name')
      .max(KICK_REWARD_TITLE_MAX, `At most ${KICK_REWARD_TITLE_MAX} characters (Kick’s limit)`)
      .refine(noControlChars, 'The name is a single line of text'),
  })
  .nullable();

const multiplierSchema = z
  .number({ message: 'Enter the multiplier' })
  .int('Use a whole number')
  .min(1, 'At least 1 (off)')
  .max(GIVEAWAY_MULTIPLIER_MAX, `At most ${GIVEAWAY_MULTIPLIER_MAX}×`);

/** Start Giveaway: everything is configured at once and the giveaway starts immediately (there are no drafts). */
export const createGiveawaySchema = z
  .object({
    prize: prizeSchema,
    description: descriptionSchema.optional().transform((d) => d ?? null),
    winnerCount: winnerCountSchema.default(1),
    durationMinutes: durationSchema.default(null),
    platforms: platformsSchema.default(['kick', 'discord']),
    discordChannel: discordChannelSchema.default(null),
    /** Optional Kick Channel Points reward for bonus tickets. */
    kickReward: kickRewardSchema.default(null),
    /** Ticket multiplier for verified active Kick subscribers (1 = off). */
    subscriberMultiplier: multiplierSchema.default(1),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.kickReward && !g.platforms.includes('kick'))
      ctx.addIssue({ code: 'custom', path: ['kickReward'], message: 'Bonus tickets need Kick entry' });
    if (g.subscriberMultiplier > 1 && !g.platforms.includes('kick'))
      ctx.addIssue({ code: 'custom', path: ['subscriberMultiplier'], message: 'The subscriber multiplier needs Kick entry' });
  });
export type CreateGiveawayInput = z.output<typeof createGiveawaySchema>;

export const updateGiveawaySchema = z
  .object({
    prize: prizeSchema,
    description: descriptionSchema,
    winnerCount: winnerCountSchema,
    durationMinutes: durationSchema,
    platforms: platformsSchema,
    discordChannel: discordChannelSchema,
  })
  .partial()
  .strict();
export type UpdateGiveawayInput = z.output<typeof updateGiveawaySchema>;

export const redrawSchema = z
  .object({
    winnerId: z.string().uuid('Choose a winner to replace'),
    reason: z
      .string()
      .trim()
      .max(GIVEAWAY_REASON_MAX, `At most ${GIVEAWAY_REASON_MAX} characters`)
      .refine(noControlChars, 'The reason is a single line of text')
      .transform((s) => (s === '' ? null : s))
      .nullable()
      .optional()
      .transform((r) => r ?? null),
  })
  .strict();

/**
 * Which fields may change in each state. Drawn and cancelled giveaways are final. The Discord channel can change while
 * open only until the announcement has been posted.
 */
export const EDITABLE_FIELDS: Record<GiveawayStatus, ReadonlyArray<keyof UpdateGiveawayInput>> = {
  draft: ['prize', 'description', 'winnerCount', 'durationMinutes', 'platforms', 'discordChannel'],
  open: ['prize', 'description', 'winnerCount', 'discordChannel'],
  closed: ['prize', 'description', 'winnerCount'],
  drawn: [],
  cancelled: [],
};

// ── views ───────────────────────────────────────────────────────────────────

export interface GiveawayWinnerView {
  id: string;
  /** 1-based place within the giveaway; a redraw keeps the replaced winner's place. */
  position: number;
  platform: GiveawayPlatform;
  platformUserId: string;
  displayName: string;
  /** 'won' = current winner; 'replaced' = drawn earlier and replaced by a redraw (kept for the record). */
  status: 'won' | 'replaced';
  drawId: string;
  selectedAt: string;
  replacedAt: string | null;
}

export interface GiveawayDrawView {
  id: string;
  kind: 'initial' | 'redraw';
  drawnAt: string;
  /** Entries in the pool the winners were picked from. */
  poolSize: number;
  /** Total tickets in that pool (private: dashboard only); null for draws made before tickets were recorded. */
  poolTickets: number | null;
  /** For a redraw: the winner it replaced. */
  replacedWinnerId: string | null;
  reason: string | null;
}

export interface GiveawayAnnouncementView {
  at: string;
  /** What was announced. */
  kind: 'started' | 'closed' | 'winners' | 'redraw';
  outcome: 'sent' | 'failed' | 'unconfirmed' | 'skipped';
  detail: string | null;
}

/** The Discord embed announcement of a giveaway. */
export interface GiveawayDiscordView {
  guildId: string;
  channelId: string;
  /** Channel name when chosen (a snapshot; the channel may be renamed). */
  channelName: string | null;
  /** The posted message, once Discord accepted it. */
  messageId: string | null;
  /** posted: the embed is up to date or an update is pending; failed: the last post/update failed; missing: the message
   * or channel was deleted. null: not posted yet. */
  status: 'posted' | 'failed' | 'missing' | null;
  /** What went wrong, and what to do about it. */
  detail: string | null;
  updatedAt: string | null;
}

export interface GiveawayView {
  id: string;
  prize: string;
  description: string | null;
  status: GiveawayStatus;
  winnerCount: number;
  durationMinutes: number | null;
  platforms: GiveawayPlatform[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  /** When entries close automatically (null: until ended from the dashboard). */
  endsAt: string | null;
  closedAt: string | null;
  drawnAt: string | null;
  cancelledAt: string | null;
  entryCount: number;
  entriesByPlatform: Record<GiveawayPlatform, number>;
  /** Every winner ever selected, current and replaced, by place then selection time. */
  winners: GiveawayWinnerView[];
  draws: GiveawayDrawView[];
  /** The latest Kick chat announcement. */
  announcement: GiveawayAnnouncementView | null;
  /** The Discord embed announcement (null: no channel chosen). */
  discord: GiveawayDiscordView | null;
  /** Total tickets across entries (private: dashboard only; never shown publicly). */
  ticketCount: number;
  /** Ticket multiplier for verified active Kick subscribers (1 = off), and how many entrants were verified. */
  subscriberMultiplier: number;
  verifiedSubscribers: number;
  /** The Kick Channel Points bonus-ticket reward (null: none). */
  kickReward: {
    title: string;
    cost: number;
    tickets: number;
    rewardId: string | null;
    status: 'active' | 'paused' | 'removed' | 'failed' | null;
    detail: string | null;
    accepted: number;
    rejected: number;
  } | null;
}

export interface GiveawaysState {
  giveaways: GiveawayView[];
  /** How viewers enter, per platform, and whether that works right now. */
  entry: Record<GiveawayPlatform, { command: string; ready: boolean; note: string | null }>;
  /** The Discord channel last used for an announcement, preselected for new giveaways. */
  discordChannelDefault: DiscordChannelRef;
  /** Whether Kick Channel Points bonus tickets can be used now, and why not. */
  kickRewards: { available: boolean; problem: string | null };
  /** The Kick chat messages as they will be posted (saved text, or the default), before variables are filled in. */
  kickMessages: KickGiveawayMessages;
  /** Giveaways cancelled before cancellation deleted them (kept in the database, not shown). */
  hiddenCancelled: number;
}

/** Text channels the bot can announce in, per server, with the permissions it's missing there. */
export interface DiscordChannelsState {
  guilds: Array<{
    id: string;
    name: string;
    /** missing: what giveaway announcements need; permissions: the bot's effective bits there (decimal string). */
    channels: Array<{ id: string; name: string; missing: string[]; permissions?: string }>;
    /** The bot's server-level permission bits (decimal string), e.g. for View Audit Log. */
    permissions?: string;
    /** Roles, for choosing one to mention (@everyone and bot-managed roles left out). */
    roles?: Array<{ id: string; name: string; mentionable: boolean }>;
    problem: string | null;
  }>;
  problem: string | null;
}

/** Result of an entry attempt from chat (also the basis of the Discord reply). */
export type EntryResult =
  | { outcome: 'entered'; prize: string; entryCount: number }
  | { outcome: 'already_entered'; prize: string }
  | { outcome: 'no_giveaway' }
  | { outcome: 'closed'; prize: string }
  | { outcome: 'platform_not_allowed'; prize: string; platforms: GiveawayPlatform[] }
  | { outcome: 'not_eligible'; prize: string; reason: string };

// ── Kick chat messages (editable) ────────────────────────────────────────────

/**
 * The giveaway messages the chatbot posts in Kick chat. Each one is a template the host can edit on the Giveaways page
 * before anything is sent; what is saved is exactly what is posted, with its variables filled in. The variables are
 * public facts only (prize, names, how to enter, timing): there is deliberately no ticket, entry-count or odds variable.
 */
export const KICK_GIVEAWAY_MESSAGE_KINDS = ['started', 'entered', 'closed', 'winners', 'redraw', 'closedReply'] as const;
export type KickGiveawayMessageKind = (typeof KICK_GIVEAWAY_MESSAGE_KINDS)[number];

export const KICK_GIVEAWAY_MESSAGES: Record<
  KickGiveawayMessageKind,
  { label: string; when: string; default: string; variables: Record<string, { description: string; example: string }> }
> = {
  started: {
    label: 'Giveaway started',
    when: 'Posted when a giveaway starts.',
    default: '🎉 I’ve started a giveaway for {prize}! To enter, {how_to_enter}. {winners_note} {reward_note} {closes_note}',
    variables: {
      prize: { description: 'The prize', example: 'Steam gift card' },
      how_to_enter: {
        description: 'How to enter on the giveaway’s platforms',
        example: `type ${GIVEAWAY_ENTER.kick} in chat or click ${GIVEAWAY_BUTTONS.enter.label} on the Discord announcement`,
      },
      winner_count: { description: 'Number of winners', example: '2' },
      winners_note: { description: '“2 winners.” (empty with one winner)', example: '2 winners.' },
      reward: { description: 'The Channel Points reward’s title (empty without one)', example: 'Bonus ticket' },
      reward_note: {
        description: 'The Channel Points sentence (empty without a reward)',
        example: 'Redeem “Bonus ticket” with Channel Points for bonus tickets.',
      },
      duration: { description: 'How long entries stay open (empty without a time limit)', example: '10 minutes' },
      closes_note: { description: '“Entries close in 10 minutes.” (empty without a time limit)', example: 'Entries close in 10 minutes.' },
    },
  },
  entered: {
    label: 'Viewer entered',
    when: `Posted when someone enters with ${GIVEAWAY_ENTER.kick}.`,
    default: '{user} has entered the giveaway!',
    variables: {
      user: { description: 'The viewer’s Kick name', example: 'viewer123' },
      prize: { description: 'The prize', example: 'Steam gift card' },
    },
  },
  closed: {
    label: 'Entries closed',
    when: 'Posted when entries close (ended by you or by the time limit).',
    default: 'Entries for {prize} are now closed. Winners will be drawn soon.',
    variables: { prize: { description: 'The prize', example: 'Steam gift card' } },
  },
  winners: {
    label: 'Winners drawn',
    when: 'Posted when winners are drawn.',
    default: '🏆 {winner_label} of {prize}: {winners}. Congratulations!',
    variables: {
      prize: { description: 'The prize', example: 'Steam gift card' },
      winners: { description: 'The winners (Kick winners as @name, Discord winners as “name (Discord)”)', example: '@viewer123, fan (Discord)' },
      winner_label: { description: '“Winner” or “Winners”', example: 'Winners' },
    },
  },
  redraw: {
    label: 'Winner redrawn',
    when: 'Posted when you redraw a winner.',
    default: '🏆 I’ve drawn a new winner for {prize}: {winner}. Congratulations!',
    variables: {
      prize: { description: 'The prize', example: 'Steam gift card' },
      winner: { description: 'The new winner', example: '@viewer456' },
    },
  },
  closedReply: {
    label: 'Entry after closing',
    when: `Posted (at most once a minute) when someone types ${GIVEAWAY_ENTER.kick} just after entries closed.`,
    default: 'Giveaway entries are closed.',
    variables: {},
  },
};

export type KickGiveawayMessages = Record<KickGiveawayMessageKind, string>;

export const KICK_GIVEAWAY_MESSAGE_DEFAULTS: KickGiveawayMessages = Object.fromEntries(
  KICK_GIVEAWAY_MESSAGE_KINDS.map((k) => [k, KICK_GIVEAWAY_MESSAGES[k].default]),
) as KickGiveawayMessages;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Rules for one edited message: one line, Kick's limits, only that message's variables, can't trigger a command. */
export function kickGiveawayMessageSchema(kind: KickGiveawayMessageKind) {
  const allowed = Object.keys(KICK_GIVEAWAY_MESSAGES[kind].variables);
  return z
    .string()
    .trim()
    .min(1, 'Enter the message to post')
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Messages are a single line of text')
    .refine((s) => !/^[!/]/.test(s), 'A Kick message can’t start with "!" or "/" (so it can’t trigger a command)')
    .refine((s) => [...new Intl.Segmenter().segment(s)].length <= KICK_CHAT_MAX_CHARS, `Up to ${KICK_CHAT_MAX_CHARS} characters`)
    .refine((s) => new TextEncoder().encode(s).length <= KICK_CHAT_MAX_BYTES, 'This message is too long')
    .superRefine((s, ctx) => {
      const unknown = [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !allowed.includes(n)))];
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `${unknown.map((n) => `{${n}}`).join(', ')} ${unknown.length === 1 ? 'isn’t a variable' : 'aren’t variables'} of this message. ` +
            (allowed.length ? `Use ${allowed.map((v) => `{${v}}`).join(', ')}.` : 'This message has no variables.'),
        });
      }
    });
}

/** Save edited messages: a message's text, or null to restore its default. Nothing is sent when saving. */
export const setKickGiveawayMessagesSchema = z
  .strictObject(
    Object.fromEntries(KICK_GIVEAWAY_MESSAGE_KINDS.map((k) => [k, kickGiveawayMessageSchema(k).nullable().optional()])) as Record<
      KickGiveawayMessageKind,
      z.ZodOptional<z.ZodNullable<ReturnType<typeof kickGiveawayMessageSchema>>>
    >,
  )
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

/**
 * Fills in a message. Only that message's variables are replaced (single pass: inserted text is never treated as a
 * template); values are made single-line, spaces left by empty variables are collapsed, and the result never starts
 * with "!" or "/". Shortening to Kick's limit happens when sending.
 */
export function renderKickGiveawayMessage(kind: KickGiveawayMessageKind, template: string, vars: Record<string, string>): string {
  const allowed = KICK_GIVEAWAY_MESSAGES[kind].variables;
  const filled = template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(allowed, name) ? (vars[name] ?? '') : whole,
  );
  return filled
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[!/\s]+/, '');
}
