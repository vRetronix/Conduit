/**
 * The Discord bot's presence: its online status, an optional custom status line and an optional activity ("Playing …",
 * "Watching …"). Bots set these over their gateway connection (presence update). This is the bot's own presence only:
 * no bot can change a person's status or Rich Presence, and CONDUIT never uses a user account to do so.
 *
 * Discord limits what a bot's presence can show: a status, one activity of type Playing, Streaming (with a Twitch or
 * YouTube link), Listening to, Watching or Competing in, and a custom status text. Rich Presence extras that games
 * use — images, buttons, timestamps, details lines and party sizes — are not shown for bots, so they aren't offered.
 *
 * Discord shows one line under a bot's name: when both an activity and a custom status text are set, the activity is
 * sent and the custom status text is kept for when the activity is turned off.
 */
import { z } from 'zod';

export const BOT_STATUSES = ['online', 'idle', 'dnd', 'invisible'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];
export const BOT_STATUS_LABEL: Record<BotStatus, string> = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible (shown as offline)' };

export const BOT_ACTIVITY_TYPES = ['playing', 'streaming', 'listening', 'watching', 'competing'] as const;
export type BotActivityType = (typeof BOT_ACTIVITY_TYPES)[number];
/** How Discord shows each type, and its gateway activity type number. */
export const BOT_ACTIVITY_HELP: Record<BotActivityType, { label: string; shownAs: string; code: number }> = {
  playing: { label: 'Playing', shownAs: 'Playing', code: 0 },
  streaming: { label: 'Streaming', shownAs: 'Streaming', code: 1 },
  listening: { label: 'Listening', shownAs: 'Listening to', code: 2 },
  watching: { label: 'Watching', shownAs: 'Watching', code: 3 },
  competing: { label: 'Competing', shownAs: 'Competing in', code: 5 },
};
/** Gateway activity type for a custom status. */
export const CUSTOM_STATUS_ACTIVITY = 4;

export const PRESENCE_TEXT_MAX = 128;
/** Discord shows Streaming only with a Twitch or YouTube link. */
export const STREAMING_URL = /^https:\/\/(www\.)?(twitch\.tv\/[A-Za-z0-9_]{1,25}|youtube\.com\/(watch\?v=[\w-]{6,20}|@[\w.-]{1,100}|channel\/[\w-]{10,40}))\/?$/;

const text = z
  .string()
  .trim()
  .max(PRESENCE_TEXT_MAX, `Up to ${PRESENCE_TEXT_MAX} characters`)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Line breaks and control characters aren’t allowed');

export const presenceSchema = z
  .strictObject({
    status: z.enum(BOT_STATUSES),
    /** Custom status text, or null for none. */
    customStatus: text.nullable(),
    /** The activity, or null for none. */
    activity: z
      .strictObject({
        type: z.enum(BOT_ACTIVITY_TYPES),
        name: text.pipe(z.string().min(1, 'Enter what the bot is doing')),
        url: z.string().trim().max(200).nullable(),
      })
      .nullable(),
  })
  .superRefine((p, ctx) => {
    const a = p.activity;
    if (!a) return;
    if (a.type === 'streaming') {
      if (!a.url || !STREAMING_URL.test(a.url))
        ctx.addIssue({ code: 'custom', path: ['activity', 'url'], message: 'Streaming needs a Twitch or YouTube link (https://twitch.tv/… or https://youtube.com/…)' });
    } else if (a.url) {
      ctx.addIssue({ code: 'custom', path: ['activity', 'url'], message: 'Only Streaming uses a link' });
    }
  })
  .transform((p) => ({ ...p, customStatus: p.customStatus ? p.customStatus : null }));
export type BotPresence = z.output<typeof presenceSchema>;

/** What is actually sent to Discord: one activity (the activity, else the custom status). */
export function gatewayPresence(p: BotPresence): { status: BotStatus; activities: Array<{ name: string; type: number; url?: string; state?: string }> } {
  if (p.activity) {
    const a = p.activity;
    return { status: p.status, activities: [{ name: a.name, type: BOT_ACTIVITY_HELP[a.type].code, ...(a.type === 'streaming' && a.url ? { url: a.url } : {}) }] };
  }
  if (p.customStatus) return { status: p.status, activities: [{ name: 'Custom Status', type: CUSTOM_STATUS_ACTIVITY, state: p.customStatus }] };
  return { status: p.status, activities: [] };
}

export interface PresenceState {
  /** The saved presence; null until one is saved (until then CONDUIT leaves Discord's default: online, no activity). */
  saved: BotPresence | null;
  /**
   * The last time it was sent over the bot's gateway connection. Discord doesn't confirm presence updates, so "sent"
   * means the connected session accepted it; it shows in Discord within moments.
   */
  applied: { state: 'sent' | 'not_sent' | 'failed'; at: string | null; presence: BotPresence | null; problem: string | null };
  botConnected: boolean;
  /** Recent presence changes, newest first (this session; kept in memory): what was sent, the result and why. */
  history: PresenceLogEntry[];
}

export interface PresenceLogEntry {
  at: string;
  /** Why it was sent: saved on the Settings tab, or sent again because the bot (re)connected. */
  reason: 'saved' | 'reconnected';
  state: 'sent' | 'not_sent' | 'failed';
  presence: BotPresence;
  problem: string | null;
}
