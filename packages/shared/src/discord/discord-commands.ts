/**
 * Discord default commands: who may run each one (Access) and whether it is on (Commands → Discord → Default Commands).
 *
 * Access is one of three groups, from Discord's own member permissions (computed by Discord for each interaction, so
 * CONDUIT never guesses roles):
 * - Admin: members with Administrator (the server owner always has it);
 * - Moderator: members with Manage Messages, Timeout Members, Kick Members, Ban Members or Administrator;
 * - Anyone: everyone who can use commands in the server (internally "community").
 * Each group includes the ones above it (an Admin can run Moderator and Anyone commands).
 *
 * A default command can be limited to a higher group than its default, never opened to a lower one than its minimum.
 * Moderation commands keep their Discord permission (Timeout Members or Ban Members) on top of the group, and the
 * moderation service still applies Discord's role hierarchy. A disabled command is removed from Discord. The backend's
 * command dispatcher enforces all of this on every use, so a command invoked directly (or one a server admin made
 * visible in Discord's Integrations settings) is refused the same way.
 */
import { z } from 'zod';
import type { CommandPermission } from '../community/custom-commands';

export const DISCORD_ACCESS_GROUPS = ['admin', 'moderator', 'community'] as const;
export type DiscordAccessGroup = (typeof DISCORD_ACCESS_GROUPS)[number];

/** Higher rank = fewer members. */
export const ACCESS_GROUP_RANK: Record<DiscordAccessGroup, number> = { community: 0, moderator: 1, admin: 2 };

export const ACCESS_GROUP_HELP: Record<DiscordAccessGroup, { label: string; who: string }> = {
  admin: { label: 'Admin', who: 'Members with Administrator (the server owner always has it)' },
  moderator: { label: 'Moderator', who: 'Members with Manage Messages, Timeout Members, Kick Members, Ban Members or Administrator' },
  community: { label: 'Anyone', who: 'Anyone who can use commands in the server' },
};

/** Custom commands store their own permission; on Discord it is one of these groups. */
export function groupForPermission(p: CommandPermission): DiscordAccessGroup {
  return p === 'broadcaster' ? 'admin' : p === 'moderator' ? 'moderator' : 'community';
}

/** Discord permission bits (https://docs.discord.com/developers/topics/permissions). */
export const DISCORD_PERMISSION_BITS = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_MESSAGES: 1n << 13n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;
const MODERATOR_BITS =
  DISCORD_PERMISSION_BITS.MANAGE_MESSAGES |
  DISCORD_PERMISSION_BITS.MODERATE_MEMBERS |
  DISCORD_PERMISSION_BITS.KICK_MEMBERS |
  DISCORD_PERMISSION_BITS.BAN_MEMBERS |
  DISCORD_PERMISSION_BITS.ADMINISTRATOR;

/** Whether a member with these Discord permissions (null: unknown, e.g. outside a server) is in the group. */
export function groupAllows(group: DiscordAccessGroup, memberPermissions: bigint | null): boolean {
  const p = memberPermissions ?? 0n;
  if (group === 'community') return true;
  if (group === 'moderator') return (p & MODERATOR_BITS) !== 0n;
  return (p & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n;
}

const commandName = z.string().regex(/^[a-z0-9_-]{1,32}$/, 'Invalid command name');

/** Saved settings of the default commands: each one's group (when not its default) and the ones switched off. */
export const commandAccessSchema = z.strictObject({
  groups: z.record(commandName, z.enum(DISCORD_ACCESS_GROUPS)),
  disabled: z.array(commandName).max(50).default([]),
});
export type CommandAccess = z.output<typeof commandAccessSchema>;

/** One Discord default command as the Commands page shows it. */
export interface DiscordCommandView {
  name: string;
  description: string;
  /** Its subcommands (`/sticky set`, `/sticky remove`…), in order; empty for commands without any. */
  subcommands: string[];
  /** Its options (`user`, `[reason]`: optional ones in brackets), for commands without subcommands. */
  options: string[];
  /** A filled-in example, shown under the message. */
  example: string | null;
  /** What the bot answers, with {variables} where the details go. */
  message: string | null;
  /** 'builtin': part of CONDUIT; 'loyalty': registered while Loyalty & Rewards and its commands are on. */
  kind: 'builtin' | 'loyalty';
  /** Who may run it now. */
  group: DiscordAccessGroup;
  defaultGroup: DiscordAccessGroup;
  /** The lowest group it can be opened to (moderation commands: Moderator). */
  minimumGroup: DiscordAccessGroup;
  /** A Discord permission the member also needs, whatever the group (e.g. "Ban Members"), or null. */
  discordPermission: string | null;
  /** Switched on (Enabled) or off (Disabled) on the Commands page. */
  enabled: boolean;
  /** Registered with Discord now (enabled, and its feature is on); when not, why (e.g. Loyalty & Rewards is off). */
  active: boolean;
  inactiveReason: string | null;
}

export interface DiscordCommandsOverview {
  commands: DiscordCommandView[];
}
