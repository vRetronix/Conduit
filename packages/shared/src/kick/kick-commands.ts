/**
 * Kick default commands: built into CONDUIT and answered by the chatbot, like other bots' defaults (Botrix, Nightbot,
 * StreamElements…). Each can be switched off (Commands → Kick → Default Commands → Edit). A custom command with the
 * same trigger takes its place while it exists, so you can always write your own reply.
 *
 * Moderator commands act with your main Kick account: !timeout, !ban and !unban need "moderation:ban"; changing the
 * title (!title with text) and !setcategory need "channel:write" (granted when the main account is connected or
 * reauthorized).
 */
import { z } from 'zod';
import type { CommandPermission } from '../community/custom-commands';

export interface KickDefaultCommandDefinition {
  trigger: string;
  description: string;
  permission: CommandPermission;
  /** What goes after the trigger, in order; optional ones in [brackets]. */
  args: readonly string[];
  /** A filled-in example, as someone would type it in chat. */
  example: string;
  /** What the chatbot answers, with {variables} where the details go. */
  message: string;
}

export const KICK_DEFAULT_COMMANDS: readonly KickDefaultCommandDefinition[] = [
  { trigger: '!ping', message: 'Pong! I’m connected and ready!', description: 'Checks that the chatbot is connected and answering', permission: 'moderator', args: [], example: '!ping' },
  { trigger: '!commands', message: 'Commands: {commands}', description: 'Lists the commands everyone can use', permission: 'everyone', args: [], example: '!commands' },
  { trigger: '!uptime', message: '{streamer} has been live for {uptime}.', description: 'How long you’ve been live', permission: 'everyone', args: [], example: '!uptime' },
  { trigger: '!followage', message: '{user} has followed {streamer} for 1 year 2 months.', description: 'How long someone has followed you (the person asking, or the one named)', permission: 'everyone', args: ['[@name]'], example: '!followage @viewer' },
  { trigger: '!title', message: 'Title: {title}', description: 'Shows your stream title, or changes it', permission: 'moderator', args: ['[new title]'], example: '!title Chill Sunday stream' },
  { trigger: '!so', message: 'Go check out {name} at kick.com/{name}! They’re live now with {category}!', description: 'Shouts out another streamer, with their link and category', permission: 'moderator', args: ['@name'], example: '!so @coolstreamer' },
  { trigger: '!timeout', message: '{name} is timed out for {minutes} minutes.', description: 'Times someone out (10 minutes unless you say, up to 7 days)', permission: 'moderator', args: ['@name', '[minutes]', '[reason]'], example: '!timeout @troll 10 spamming links' },
  { trigger: '!ban', message: '{name} is banned.', description: 'Bans someone', permission: 'moderator', args: ['@name', '[reason]'], example: '!ban @troll hate speech' },
  { trigger: '!unban', message: '{name} is unbanned.', description: 'Lifts a ban or a timeout', permission: 'moderator', args: ['@name'], example: '!unban @troll' },
  { trigger: '!addcom', message: 'Added {command}.', description: 'Adds a custom command', permission: 'moderator', args: ['!name', 'reply'], example: '!addcom !discord Join us at discord.gg/retro' },
  { trigger: '!editcom', message: 'Updated {command}.', description: 'Changes a custom command’s reply', permission: 'moderator', args: ['!name', 'reply'], example: '!editcom !discord Our new invite: discord.gg/retro2' },
  { trigger: '!delcom', message: 'Deleted {command}.', description: 'Deletes a custom command', permission: 'moderator', args: ['!name'], example: '!delcom !discord' },
  { trigger: '!setcategory', message: 'Category changed to {category}.', description: 'Changes your stream category', permission: 'moderator', args: ['category'], example: '!setcategory Just Chatting' },
];

const trigger = z.string().regex(/^![a-z0-9_]{1,31}$/);

/** Saved settings: the default commands switched off. Nothing saved = all on. */
export const kickDefaultCommandSettingsSchema = z.strictObject({
  disabled: z.array(trigger).max(50).default([]),
});
export type KickDefaultCommandSettings = z.output<typeof kickDefaultCommandSettingsSchema>;
