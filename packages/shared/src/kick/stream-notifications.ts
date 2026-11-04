/**
 * Stream Notifications: a Discord post when a streamer goes live, optionally deleted when the stream ends.
 *
 * - Kick: live status comes from Kick's public channel API (GET /public/v1/channels?slug=…, up to 50 per request) with an
 *   app access token from the user's own Kick app.
 * - Twitch: live status comes from Twitch's Helix API (GET /helix/users and /helix/streams, up to 100 per request) with
 *   an app access token from the user's own Twitch app.
 * Both are public information, readable for any channel; they don't need or imply any rights over other streamers'
 * channels. Checked every minute while CONDUIT runs. YouTube: planned.
 *
 * One post per live session: the session is identified by the platform's stream start time and stored with the posted Discord
 * message id, so restarts and repeated checks never post twice, and "delete when the stream ends" removes exactly the
 * message of that session.
 */
import { z } from 'zod';
import { canonicalVariables, embedSchema, EMPTY_EMBED, type DiscordEmbed } from '../discord/embeds';

export const NOTIFICATION_PLATFORMS = ['kick', 'twitch'] as const;
export type NotificationPlatform = (typeof NOTIFICATION_PLATFORMS)[number];

/** Variables available in the notification text and embed (all from the platform's API; empty when it didn't provide them). */
export const NOTIFICATION_VARIABLES: Record<string, string> = {
  streamer: 'The streamer’s name',
  title: 'The stream title',
  category: 'The category or game',
  url: 'Link to the stream',
  viewers: 'Viewers when the post was made',
  thumbnail: 'Stream preview image (URL)',
  avatar: 'The streamer’s profile picture (URL)',
};

/**
 * The default notification embed (the "Retronix" layout): the stream title as the linked heading, Category and Viewers
 * side by side, the streamer's profile picture small at the top right, the stream thumbnail as the large image under
 * everything (Discord's `image`, which spans the embed's width), and "kick.com/<streamer>" with the time in the footer.
 * No author: the bot is the author of the message. Kick's public API doesn't provide follower counts, so there's no
 * followers field.
 */
export const DEFAULT_NOTIFICATION_EMBED: DiscordEmbed = {
  ...EMPTY_EMBED,
  authorUrl: '{url}',
  title: '{title}',
  url: '{url}',
  color: '#53FC18',
  fields: [
    { name: 'Category', value: '{category}', inline: true },
    { name: 'Viewers', value: '{viewers}', inline: true },
  ],
  thumbnailUrl: '{avatar}',
  imageUrl: '{thumbnail}',
  footerText: 'kick.com/{streamer}',
  timestamp: true,
};

export const DEFAULT_NOTIFICATION_CONTENT = 'Live now! {streamer} is streaming on Kick!';

/** Twitch's default layout: the same as Kick's, in Twitch purple, with twitch.tv in the footer. */
export const DEFAULT_TWITCH_NOTIFICATION_EMBED: DiscordEmbed = { ...DEFAULT_NOTIFICATION_EMBED, color: '#9146FF', footerText: 'twitch.tv/{streamer}' };
export const DEFAULT_TWITCH_NOTIFICATION_CONTENT = 'Live now! {streamer} is streaming on Twitch!';

/** Discord link buttons under the notification (real components; each on its own row). */
export const NOTIFICATION_BUTTONS_MAX = 2;
export const BUTTON_LABEL_MAX = 80;

export const notificationButtonSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, 'Give the button a label')
    .max(BUTTON_LABEL_MAX, `Button labels: at most ${BUTTON_LABEL_MAX} characters`)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'One line only'),
  /** An http(s) link, or {url} for the streamer's channel. */
  url: z
    .string()
    .trim()
    .max(512, 'At most 512 characters')
    .refine((s) => s.toLowerCase() === '{url}' || /^https?:\/\/[^\s]+$/i.test(s), 'Use an http(s) link, or {url} for the streamer’s channel'),
});
export type NotificationButton = z.output<typeof notificationButtonSchema>;

export const DEFAULT_NOTIFICATION_BUTTONS: NotificationButton[] = [{ label: 'Watch {streamer} on Kick!', url: '{url}' }];
export const DEFAULT_TWITCH_NOTIFICATION_BUTTONS: NotificationButton[] = [{ label: 'Watch {streamer} on Twitch!', url: '{url}' }];

/**
 * A channel name as typed; a kick.com or twitch.tv link is accepted too. The platform checks the name itself when the
 * streamer is added (Twitch names have no dashes, so such a name is reported as not found).
 */
const slug = z
  .string()
  .trim()
  .transform((s) => s.replace(/^https?:\/\/(www\.|m\.)?(kick\.com|twitch\.tv)\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase())
  .pipe(z.string().min(1, 'Enter a channel name').max(25, 'Channel names are at most 25 characters').regex(/^[a-z0-9_-]+$/, 'Use the channel name from the streamer’s link'));

export const notifierSchema = z.strictObject({
  platform: z.enum(NOTIFICATION_PLATFORMS).default('kick'),
  /** The streamer's channel name (kick.com/<name> or twitch.tv/<name>); a link is accepted too. */
  channel: slug,
  enabled: z.boolean().default(true),
  guildId: z.string().regex(/^\d{1,25}$/, 'Choose a server'),
  channelId: z.string().regex(/^\d{1,25}$/, 'Choose a channel'),
  /** Optional role to mention (null: no mention). */
  roleId: z.string().regex(/^\d{1,25}$/).nullable().default(null),
  /** Announcement text above the embed (after the role mention, if any). */
  content: z.string().max(1500, 'At most 1500 characters').default(DEFAULT_NOTIFICATION_CONTENT),
  embed: embedSchema.default(DEFAULT_NOTIFICATION_EMBED),
  /** Link buttons under the embed (0–2). */
  buttons: z.array(notificationButtonSchema).max(NOTIFICATION_BUTTONS_MAX, `At most ${NOTIFICATION_BUTTONS_MAX} buttons`).default(DEFAULT_NOTIFICATION_BUTTONS),
  deleteWhenEnded: z.boolean().default(false),
});
export type NotifierConfig = z.output<typeof notifierSchema>;

/**
 * The layout parts a notification's "Use default layout" replaces: the announcement text, the embed and the buttons.
 * Everything else (streamer, server, channel, role, delete-when-ended, on/off, live tracking) is kept.
 */
export function defaultNotificationLayout(platform: NotificationPlatform = 'kick'): Pick<NotifierConfig, 'content' | 'embed' | 'buttons'> {
  if (platform === 'twitch')
    return { content: DEFAULT_TWITCH_NOTIFICATION_CONTENT, embed: structuredClone(DEFAULT_TWITCH_NOTIFICATION_EMBED), buttons: structuredClone(DEFAULT_TWITCH_NOTIFICATION_BUTTONS) };
  return { content: DEFAULT_NOTIFICATION_CONTENT, embed: structuredClone(DEFAULT_NOTIFICATION_EMBED), buttons: structuredClone(DEFAULT_NOTIFICATION_BUTTONS) };
}

/** Known variables written with other capitalisation ({Streamer}) saved in their canonical lowercase form. */
export function canonicalNotifierVariables<T extends Pick<NotifierConfig, 'content' | 'embed' | 'buttons'>>(c: T): T {
  const known = Object.keys(NOTIFICATION_VARIABLES);
  const fix = (s: string) => canonicalVariables(s, known);
  const e = c.embed;
  return {
    ...c,
    content: fix(c.content),
    embed: {
      ...e,
      authorName: fix(e.authorName),
      authorIconUrl: fix(e.authorIconUrl),
      authorUrl: fix(e.authorUrl),
      title: fix(e.title),
      url: fix(e.url),
      description: fix(e.description),
      fields: e.fields.map((f) => ({ ...f, name: fix(f.name), value: fix(f.value) })),
      thumbnailUrl: fix(e.thumbnailUrl),
      imageUrl: fix(e.imageUrl),
      footerText: fix(e.footerText),
      footerIconUrl: fix(e.footerIconUrl),
    },
    buttons: c.buttons.map((b) => ({ label: fix(b.label), url: fix(b.url) })),
  };
}

/** A test post of a notification (not saved): same fields; uses the streamer's real current data from the platform. */
export const testNotificationSchema = notifierSchema.omit({ enabled: true, deleteWhenEnded: true });

export type NotifierView = NotifierConfig & {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** From the platform when the channel was added/checked. */
  displayName: string | null;
  avatarUrl: string | null;
  /** Latest known state; null before the first check. */
  live: boolean | null;
  liveSince: string | null;
  title: string | null;
  category: string | null;
  lastCheckedAt: string | null;
  /** The current session's posted message (cleared when it's deleted). */
  messageId: string | null;
  lastNotifiedAt: string | null;
  /** What happened last, in plain words (posted, deleted, a problem…). */
  status: string | null;
  problem: string | null;
  destination: string | null;
};

/** Whether CONDUIT can check a platform's live status (its app is set up and the last check worked). */
export interface NotificationSourceState {
  ready: boolean;
  problem: string | null;
  pollSeconds: number;
}

export interface StreamNotificationsState {
  /** Every platform's notifications (each platform's page shows its own). */
  notifiers: NotifierView[];
  kick: NotificationSourceState;
  twitch: NotificationSourceState;
  discord: { ready: boolean; problem: string | null };
}
