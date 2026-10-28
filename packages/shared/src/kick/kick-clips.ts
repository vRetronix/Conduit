/**
 * Kick → Clips: the clips of your Kick channel (made by anyone on kick.com, e.g. with Kick's own /clip in chat), listed
 * in CONDUIT, posted in Discord with buttons and their video, and saved on this PC. Kick's official API has no clips
 * yet, so they're read from Kick's website (public, read-only, no login).
 */
import { z } from 'zod';

/** Kick's clip ids, e.g. clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY. */
export const KICK_CLIP_ID = /^clip_[0-9A-Za-z]{10,40}$/;

const snowflake = (message: string) => z.string().regex(/^\d{1,25}$/, message);

/** Saved settings. Nothing saved: no Discord channel, nothing posted automatically, the default folder. */
export const kickClipSettingsSchema = z
  .strictObject({
    guildId: snowflake('Choose a server').nullable().default(null),
    /** Where clips are posted (by hand, and automatically when autoPost is on). */
    channelId: snowflake('Choose a channel').nullable().default(null),
    /** Post new clips by themselves (only clips made after this was switched on). */
    autoPost: z.boolean().default(false),
    /** Folder for saved clips; null: Videos\CONDUIT Clips. */
    folder: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .refine((s) => !s.autoPost || s.channelId !== null, { path: ['channelId'], message: 'Choose a channel to post new clips in' });
export type KickClipSettings = z.output<typeof kickClipSettingsSchema>;

export interface KickClipView {
  id: string;
  title: string;
  creatorName: string | null;
  category: string | null;
  durationSeconds: number;
  views: number;
  thumbnailUrl: string | null;
  /** The clip's page on kick.com. */
  url: string;
  createdAt: string;
  /** Saved on this PC (the file may have been moved or deleted since). */
  saved: { path: string; at: string } | null;
  posted: { at: string; channelId: string } | null;
  /** Why the last post didn't go through. */
  postProblem: string | null;
}

export interface KickClipsState {
  /** Your Kick channel (the main account); null until it's connected. */
  channel: { slug: string; name: string } | null;
  settings: KickClipSettings;
  /** The folder clips are saved in (the setting, or the default). */
  folder: string;
  clips: KickClipView[];
  /** The last time Kick's clip list was read, and what went wrong if it didn't work. */
  lastCheck: { at: string; problem: string | null } | null;
}
