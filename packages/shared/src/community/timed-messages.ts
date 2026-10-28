/**
 * Timed Messages: a message posted again and again in one place — a Kick chat or a Discord channel.
 *
 * Two intervals, usable alone or together:
 * - every N minutes;
 * - after N new chat messages in that same chat/channel (from people: bots, the chatbot and CONDUIT's own posts never
 *   count, so a timed message can't keep itself going).
 * With both, `combine` decides: 'all' = both must be met (N minutes have passed AND there were N messages — quiet chats
 * aren't spammed), 'any' = whichever comes first. Either way both counters restart after each post, so the two can never
 * produce two posts for the same moment.
 * Kick chat has no embeds: Kick timed messages are one line of text.
 */
import { z } from 'zod';
import { discordMessageSchema } from '../discord/embeds';
import { KICK_CHAT_MAX_BYTES, KICK_CHAT_MAX_CHARS } from '../kick/kick-setup';

export const TIMED_MIN_MINUTES = 5;
export const TIMED_MAX_MINUTES = 1440;
export const TIMED_MIN_MESSAGES = 5;
export const TIMED_MAX_MESSAGES = 1000;
/** Never two posts of the same timed message closer together than this, whatever the settings. */
export const TIMED_MIN_GAP_SECONDS = 60;

const snowflake = (what: string) => z.string().regex(/^\d{1,25}$/, `Choose a ${what}`);

const schedule = {
  intervalMinutes: z
    .number()
    .int()
    .min(TIMED_MIN_MINUTES, `At least every ${TIMED_MIN_MINUTES} minutes`)
    .max(TIMED_MAX_MINUTES, 'At most once a day (1440 minutes)')
    .nullable()
    .default(null),
  messageCount: z
    .number()
    .int()
    .min(TIMED_MIN_MESSAGES, `At least ${TIMED_MIN_MESSAGES} messages`)
    .max(TIMED_MAX_MESSAGES, `At most ${TIMED_MAX_MESSAGES} messages`)
    .nullable()
    .default(null),
  combine: z.enum(['all', 'any']).default('all'),
};

const kickText = z
  .string()
  .trim()
  .min(1, 'Enter the message')
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Kick messages are one line')
  .refine((s) => !/^[!/]/.test(s), 'A Kick message can’t start with "!" or "/" (it could run a command)')
  .refine((s) => [...new Intl.Segmenter().segment(s)].length <= KICK_CHAT_MAX_CHARS && new TextEncoder().encode(s).length <= KICK_CHAT_MAX_BYTES, `Up to ${KICK_CHAT_MAX_CHARS} characters`);

export const timedMessageSchema = z
  .discriminatedUnion('platform', [
    z.strictObject({ platform: z.literal('kick'), name: z.string().trim().min(1, 'Give it a name').max(60), enabled: z.boolean().default(false), content: kickText, ...schedule }),
    z.strictObject({
      platform: z.literal('discord'),
      name: z.string().trim().min(1, 'Give it a name').max(60),
      enabled: z.boolean().default(false),
      guildId: snowflake('server'),
      channelId: snowflake('channel'),
      message: discordMessageSchema,
      ...schedule,
    }),
  ])
  .superRefine((t, ctx) => {
    if (t.intervalMinutes === null && t.messageCount === null)
      ctx.addIssue({ code: 'custom', path: ['intervalMinutes'], message: 'Choose every X minutes, after X messages, or both' });
  });
export type TimedMessageInput = z.input<typeof timedMessageSchema>;
export type TimedMessageConfig = z.output<typeof timedMessageSchema>;

export interface TimedMessageResult {
  at: string;
  ok: boolean;
  /** time / messages: which interval triggered it. */
  reason: 'time' | 'messages' | 'both';
  detail: string;
}

export type TimedMessageView = TimedMessageConfig & {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastSentAt: string | null;
  /** Messages counted since the last post (stored, so it carries on after CONDUIT restarts). */
  messagesSince: number;
  /** When the time interval is next due (null without one, or while off). */
  nextDueAt: string | null;
  /** Newest first, at most 10. */
  recent: TimedMessageResult[];
  /** Destination name (e.g. "#general in Retro Server" or "retronix’s Kick chat"), when known. */
  destination: string | null;
  /** Why it can't post right now, if so. */
  problem: string | null;
};

/** Plain-English summary of a schedule. */
export function describeSchedule(t: Pick<TimedMessageConfig, 'intervalMinutes' | 'messageCount' | 'combine'>): string {
  const time = t.intervalMinutes !== null ? `every ${t.intervalMinutes} minute${t.intervalMinutes === 1 ? '' : 's'}` : null;
  const count = t.messageCount !== null ? `after ${t.messageCount} chat messages` : null;
  if (time && count) return t.combine === 'all' ? `${time}, once there were at least ${t.messageCount} chat messages` : `${time} or ${count}, whichever comes first`;
  return (time ?? count)!;
}

export interface TimedMessagesState {
  timedMessages: TimedMessageView[];
  kick: { ready: boolean; problem: string | null; channel: string | null };
  discord: { ready: boolean; problem: string | null; messageEvents: boolean };
}

