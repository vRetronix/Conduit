/**
 * Discord Logging (inspired by Carl-bot's): server events posted as detailed embeds, each category to a channel you
 * choose (several categories may share one).
 *
 * Where events come from (the bot's existing gateway connection):
 * - Moderation: Discord's audit log as it's written (Guild Moderation intent, not privileged; the bot needs View Audit
 *   Log) — bans, unbans, kicks, timeouts and their removal, with who did it and why; plus CONDUIT's own moderation
 *   commands (with the member who ran them). Only completed actions (audit entries exist only for them; CONDUIT records
 *   only after Discord confirmed). Failed CONDUIT commands can optionally be logged, clearly marked as failed.
 * - Messages: deletions, edits and bulk deletions (Guild Messages intent, not privileged). Message text needs the
 *   privileged Message Content intent: without it, logs say the content is unavailable.
 * - Members: joins, leaves, nickname and role changes — need the privileged Server Members intent.
 * - Server: channels and roles created, deleted or changed (Guilds intent).
 * - XP & Loyalty: level-ups, XP and points adjustments, rewards redeemed and handled, level roles given (or refused) and
 *   resets — from Loyalty & Rewards itself, after each change is saved.
 * The privileged intents (Server Members, Message Content, Presence) are required by CONDUIT and requested whenever
 * they're enabled on the Developer Portal (read from the application's flags); CONDUIT never requests one Discord
 * would refuse, and says which to turn on.
 */
import { z } from 'zod';

export const LOG_CATEGORIES = ['moderation', 'members', 'messages', 'server', 'loyalty'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const LOG_EVENTS: Record<LogCategory, Record<string, string>> = {
  moderation: {
    ban: 'Bans',
    unban: 'Unbans',
    kick: 'Kicks',
    timeout: 'Timeouts',
    untimeout: 'Timeouts removed',
    automod: 'AutoMod actions (blocked, flagged, timed out)',
    failed: 'Failed CONDUIT commands (marked as failed)',
  },
  members: { join: 'Joins', leave: 'Leaves', nickname: 'Nickname changes', roles: 'Role changes' },
  messages: { delete: 'Deleted messages', edit: 'Edited messages', bulk_delete: 'Bulk deletions' },
  server: { channels: 'Channels created, deleted or changed', roles: 'Roles created, deleted or changed' },
  loyalty: {
    level_up: 'Level-ups',
    xp: 'XP adjustments',
    points: 'Points adjustments',
    redeemed: 'Rewards redeemed',
    resolved: 'Redemptions fulfilled or rejected',
    roles: 'Level roles given (or refused)',
    reset: 'Resets (a member, or the leaderboard)',
  },
};

export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = {
  moderation: 'Moderation',
  members: 'Members',
  messages: 'Messages',
  server: 'Server & roles',
  loyalty: 'XP & Loyalty',
};

const snowflake = z.string().regex(/^\d{1,25}$/);

const categorySchema = z.strictObject({
  enabled: z.boolean().default(false),
  channelId: snowflake.nullable().default(null),
  /** Event types turned off within the category (all on by default, except "failed"). */
  off: z.array(z.string().max(30)).max(20).default([]),
});

export const loggingSettingsSchema = z
  .strictObject({
    guildId: snowflake.nullable().default(null),
    moderation: categorySchema.default({ enabled: false, channelId: null, off: ['failed'] }),
    members: categorySchema.default({ enabled: false, channelId: null, off: [] }),
    messages: categorySchema.default({ enabled: false, channelId: null, off: [] }),
    server: categorySchema.default({ enabled: false, channelId: null, off: [] }),
    loyalty: categorySchema.default({ enabled: false, channelId: null, off: [] }),
    /** No longer used (the privileged intents are always requested now); kept so saved settings stay valid. */
    useMembersIntent: z.boolean().default(false),
    useMessageContentIntent: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    for (const c of LOG_CATEGORIES) {
      if (s[c].enabled && !s[c].channelId) ctx.addIssue({ code: 'custom', path: [c, 'channelId'], message: 'Choose a channel to log to' });
      for (const e of s[c].off) if (!Object.hasOwn(LOG_EVENTS[c], e)) ctx.addIssue({ code: 'custom', path: [c, 'off'], message: `Unknown event “${e}”` });
    }
    if (LOG_CATEGORIES.some((c) => s[c].enabled) && !s.guildId) ctx.addIssue({ code: 'custom', path: ['guildId'], message: 'Choose the server to log' });
  });
export type LoggingSettings = z.output<typeof loggingSettingsSchema>;

export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = loggingSettingsSchema.parse({});

/** Something Discord Logging posted, as listed in Discord Bot → Logs → Moderation log. */
export interface DiscordLogEntryView {
  id: string;
  at: string;
  place: string | null;
  category: LogCategory;
  event: string;
  /** The log embed's title, e.g. "Message deleted". */
  title: string;
  userId: string | null;
  userName: string | null;
  /** The embed's text in short (what changed, where). */
  detail: string | null;
  /** Posted to the log channel (false: Discord refused it). */
  posted: boolean;
}

export interface LoggingState {
  settings: LoggingSettings;
  /** What the bot can receive now, per category: why not, when not. */
  availability: Record<LogCategory, { available: boolean; problem: string | null; partial: string | null }>;
  /** Privileged intents: enabled on the Developer Portal? (null: couldn't check) and in use now. */
  intents: {
    members: { portal: boolean | null; inUse: boolean };
    messageContent: { portal: boolean | null; inUse: boolean };
    presences: { portal: boolean | null; inUse: boolean };
  };
  /** The bot needs View Audit Log in the chosen server for moderation logs. */
  auditLogAccess: boolean | null;
  discord: { ready: boolean; problem: string | null };
}
