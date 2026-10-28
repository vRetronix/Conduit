/**
 * Slash command contracts. A command is a plain object: its Discord definition (name, description, options,
 * permissions) plus an execute() handler. The dispatcher (dispatcher.ts) does everything common — validation,
 * permission checks, acknowledging in time, replying, error handling, logging and optional audit — so a command only
 * describes itself and returns its reply.
 */

import type { DiscordAccessGroup } from '@conduit/shared';

/** Discord application command option types used so far (https://docs.discord.com/developers/interactions/application-commands). */
export const OptionType = {
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
} as const;
export type OptionTypeValue = (typeof OptionType)[keyof typeof OptionType];
/** Discord's option type for a subcommand (`/xp add`): holds the options of that subcommand. */
export const SUBCOMMAND_TYPE = 1;

/** Discord channel types an option can offer (0 text, 4 category, 5 announcement). */
export const ChannelType = { Text: 0, Category: 4, Announcement: 5 } as const;

export interface CommandOption {
  name: string;
  description: string;
  type: OptionTypeValue;
  required?: boolean;
  /** Fixed choices Discord offers (String and Integer options); any other value is refused. */
  choices?: ReadonlyArray<{ name: string; value: string | number }>;
  /** Integer options: the allowed range (Discord enforces it in the picker; the dispatcher checks it again). */
  minValue?: number;
  maxValue?: number;
  /** String options: at most this many characters. */
  maxLength?: number;
  /** Channel options: which channel types can be picked (see ChannelType). */
  channelTypes?: readonly number[];
}

/** One subcommand of a command (`/loyalty add-xp`), with its own options. */
export interface Subcommand {
  name: string;
  description: string;
  options?: readonly CommandOption[];
}

export type OptionValue = string | number | boolean;

export interface CommandContext {
  /** Discord's id for this use of the command (unique; used to make sure one use is never processed twice). */
  interactionId: string;
  guildId: string;
  /** The Discord user who ran the command. */
  userId: string;
  /** Their username (for {user}). */
  userName: string;
  /** The text channel's name (for {channel}), when Discord provided it. */
  channelName: string | null;
  /** The channel the command was used in. */
  channelId: string | null;
  /** The subcommand used (`add-xp` in `/loyalty add-xp`); null for commands without subcommands. */
  subcommand: string | null;
  /** The member's permissions as computed by Discord (null outside a server). */
  memberPermissions: bigint | null;
  /** Validated option values, by name (a subcommand's options when one was used). */
  options: ReadonlyMap<string, OptionValue>;
  /** User and channel options: the name Discord showed for the picked member or channel, by option name. */
  optionLabels: ReadonlyMap<string, string>;
  /** The connected Discord bot's username (null if unknown). */
  botName: string | null;
}

export interface CommandReply {
  /** Text above any embeds ('' for an embed-only reply). */
  content: string;
  /** Discord embed objects shown under the text (at most 10). */
  embeds?: ReadonlyArray<Record<string, unknown>>;
  /** Discord message components (rows of buttons) under the reply. */
  components?: ReadonlyArray<Record<string, unknown>>;
  /** Visible only to the user who ran the command. */
  ephemeral?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  /**
   * 'default': built into CONDUIT's code (always registered, cannot be edited or removed in the app).
   * 'user': created by the user in CONDUIT (manageable). Not sent to Discord.
   */
  origin: 'default' | 'user';
  options?: readonly CommandOption[];
  /** A filled-in example for the Commands page (not sent to Discord). */
  example?: string;
  /** What it answers, with {variables} where the details go (Commands page only). */
  message?: string;
  /** Subcommands (`/loyalty add-xp`, `/loyalty reset-user`…). A command has subcommands or options, never both. */
  subcommands?: readonly Subcommand[];
  /**
   * Discord permission bits a member needs (e.g. BanMembers). Sent to Discord as default_member_permissions, so the
   * command is hidden from members without them, and re-checked by the dispatcher on every interaction. Omit for
   * commands everyone may use.
   */
  requiredPermissions?: bigint;
  /**
   * Command Permissions: the group allowed to run it (Admin, Moderator or Anyone), checked by the dispatcher on
   * every use on top of requiredPermissions. Admin also hides it from other members in Discord. Omit: Anyone.
   */
  accessGroup?: DiscordAccessGroup;
  /**
   * Optional access step run before execute (custom commands: permission and cooldown). Returning ok:false skips the
   * command; its message is shown only to the user who tried. On success, release() is called if the command then
   * fails, so a cooldown isn't used up.
   */
  admit?(ctx: CommandContext): { ok: true; release: () => void } | { ok: false; message: string };
  /** Record each use in the audit log (for moderation-style commands). */
  audit?: boolean;
  /** Replies are private to the member who ran it, including the early acknowledgement of a slow command. */
  ephemeral?: boolean;
  execute(ctx: CommandContext): Promise<CommandReply> | CommandReply;
}

export interface IncomingOption {
  name: string;
  type: number;
  value?: unknown;
  label?: string;
  options?: ReadonlyArray<IncomingOption>;
}

/** A command's inputs for the Commands page: subcommands, or its options with optional ones in [brackets]. */
export function commandInputs(c: Pick<SlashCommand, 'options' | 'subcommands'>): { subcommands: string[]; options: string[] } {
  return {
    subcommands: (c.subcommands ?? []).map((s) => s.name),
    options: c.subcommands ? [] : (c.options ?? []).map((o) => (o.required ? o.name : `[${o.name}]`)),
  };
}

/** A failure whose message is safe to show to the Discord user. Anything else gets a generic message. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * A slash-command interaction as received from Discord, independent of the gateway library. discord.js provides it
 * in production (discord-bot.ts); tests provide fakes. Responses go through Discord's interaction callback API.
 */
export interface IncomingCommand {
  id: string;
  /** The application the interaction was sent to. */
  applicationId: string;
  commandName: string;
  /** Null when used outside a server (direct messages). */
  guildId: string | null;
  userId: string;
  /** The user's Discord username. */
  userName: string;
  /** Name of the channel the command was used in, when known. */
  channelName: string | null;
  /** The channel the command was used in, when known. */
  channelId?: string | null;
  /** The member's permissions in that channel, or null outside a server. */
  memberPermissions: bigint | null;
  /** A subcommand arrives as one option of type 1 holding its own options. `label`: a picked member's or channel's name. */
  options: ReadonlyArray<IncomingOption>;
  /** Initial response (must happen within 3 seconds of the interaction). */
  reply(r: CommandReply): Promise<void>;
  /** Acknowledge now and respond later with editReply (for slow commands). */
  defer(ephemeral: boolean): Promise<void>;
  editReply(r: CommandReply): Promise<void>;
}
