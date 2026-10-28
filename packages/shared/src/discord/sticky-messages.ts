/**
 * Discord Sticky Messages: a message kept at the bottom of a channel by reposting it after people post (Discord has no
 * way to pin a message to the bottom, so each repost is a new message; the previous copy is deleted).
 *
 * Needs, in that channel: View Channel, Send Messages, Read Message History (to see whether the sticky is still the
 * latest message after a restart) and Embed Links for embeds. The bot learns that someone posted from the gateway's
 * message events (Guild Messages intent, not privileged); it never reads message text, so the privileged Message
 * Content intent is not needed.
 */
import { z } from 'zod';
import { discordMessageSchema } from './embeds';

export const STICKY_MIN_COOLDOWN = 5;
export const STICKY_MAX_COOLDOWN = 3600;

export const stickyMessageSchema = z.strictObject({
  name: z.string().trim().min(1, 'Give it a name').max(60),
  enabled: z.boolean().default(true),
  guildId: z.string().regex(/^\d{1,25}$/, 'Choose a server'),
  channelId: z.string().regex(/^\d{1,25}$/, 'Choose a channel'),
  message: discordMessageSchema,
  /** At most one repost every this many seconds (several messages in a row → one repost). */
  cooldownSeconds: z.number().int().min(STICKY_MIN_COOLDOWN, `At least ${STICKY_MIN_COOLDOWN} seconds`).max(STICKY_MAX_COOLDOWN, 'At most 1 hour').default(15),
  /** Repost after this many new messages from people (1 = after every message, subject to the cooldown). */
  messagesBeforeRepost: z.number().int().min(1).max(100, 'At most 100').default(1),
});
export type StickyMessageConfig = z.output<typeof stickyMessageSchema>;

export type StickyMessageView = StickyMessageConfig & {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The message currently posted as the sticky (null: none yet, or it was removed). */
  postedMessageId: string | null;
  lastPostedAt: string | null;
  /** e.g. "#rules in Retro Server" when known. */
  destination: string | null;
  status: 'active' | 'off' | 'problem';
  /** Latest problem (missing permission, deleted channel…) with what to do. */
  problem: string | null;
  /** Newest first, at most 10: what it did. */
  recent: Array<{ at: string; ok: boolean; detail: string }>;
};

export interface StickyMessagesState {
  stickies: StickyMessageView[];
  discord: { ready: boolean; problem: string | null; messageEvents: boolean };
}
