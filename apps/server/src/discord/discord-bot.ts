/**
 * The user's Discord bot's gateway connection (discord.js), one at a time.
 *
 * - Intents: Guilds (servers, channels, roles), Guild Messages (someone posted / edited / deleted a message — for Sticky
 *   Messages, timed-message counts and message logs) and Guild Moderation (audit-log entries and bans, for moderation
 *   logs). None of these is privileged. The privileged Server Members and Message Content intents are added only when
 *   the caller says they're enabled on the Developer Portal and wanted (Discord Logging); if Discord still refuses
 *   them, the bot reconnects once without them instead of staying offline. Slash commands and button clicks are
 *   interactions, which arrive over this same connection without any further intent.
 * - Duplicate connections are prevented: start() with the token already running is a no-op; a different token
 *   replaces the connection.
 * - discord.js handles reconnects, resumes and REST rate limits once logged in. Initial login failures caused by
 *   network problems are retried with a conservative backoff (Discord allows 1000 IDENTIFY calls per 24 h, and
 *   exceeding that resets the bot token). A rejected token or disallowed intents are not retried.
 */
import { createHash } from 'node:crypto';
import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type Role,
  type User,
  type PartialUser,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type ActivitiesOptions,
  type APIEmbed,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type CommandInteractionOption,
} from 'discord.js';
import type { Logger } from '@conduit/logger';
import type { DiscordBotStatus } from '@conduit/shared';
import { dangerousPermissionsAdded } from '@conduit/shared/discord/discord-protection';
import type { CommandReply, IncomingCommand, IncomingOption } from './commands/types';

/** The minimal client surface the runner needs; real discord.js behind it, a fake in tests. */
export interface BotClient {
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
  /** avatar: Discord's avatar hash, null when the bot has none. */
  userInfo(): { id: string; username: string; avatar?: string | null } | null;
  /** icon: Discord's server icon hash, null when the server has none; memberCount when Discord said. */
  guilds(): Array<{ id: string; name: string; icon?: string | null; memberCount?: number | null }>;
  on(event: BotClientEvent, listener: (detail?: unknown) => void): void;
  /**
   * Sends the bot's presence (status and activities) over the gateway connection. Throws when the session isn't
   * ready. Discord doesn't acknowledge presence updates.
   */
  setPresence?(presence: GatewayPresenceData): void;
}

/** A presence update as sent to Discord (see gatewayPresence in @conduit/shared). */
export interface GatewayPresenceData {
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  activities: Array<{ name: string; type: number; url?: string; state?: string }>;
}

/** A user as logs show them (from the gateway; never tokens). */
export interface UserRef {
  id: string;
  /** Username (or "Unknown" when Discord didn't send it). */
  tag: string;
  avatarUrl: string | null;
  bot: boolean;
}
export interface RoleRef {
  id: string;
  name: string;
}
export interface Change {
  key: string;
  before: string;
  after: string;
}

/**
 * A server event from the gateway, independent of discord.js. Message text is present only when the privileged
 * Message Content intent is in use (otherwise null); member events only with the Server Members intent.
 */
export type GuildEvent =
  | {
      type: 'message_create';
      guildId: string;
      channelId: string;
      messageId: string;
      authorId: string;
      authorBot: boolean;
      authorName?: string;
      /** A Discord system message (join, boost, pin notice…) rather than something the member wrote. */
      system?: boolean;
      /**
       * SHA-256 (truncated) of the normalized text, only when the Message Content intent is already in use; never the
       * text itself. Lets Loyalty notice a member repeating the same message.
       */
      contentHash?: string;
      /**
       * The text, only when the Message Content intent is in use: for Automated Protection's message checks (in memory
       * only), and for Discord Logging, which keeps it for 7 days while Messages logging is on, to show deleted and
       * edited messages.
       */
      content?: string;
      /** The author's roles in the server (for exemptions), when Discord sent the member. */
      authorRoleIds?: string[];
      /** The author has a moderator permission (Manage Messages, Timeout/Kick/Ban Members or Administrator). */
      authorModerator?: boolean;
      /** Different members and roles @mentioned (AutoMod's mention spam; Discord sends these even without the text). */
      mentionCount?: number;
    }
  | { type: 'message_delete'; guildId: string; channelId: string; messageId: string; author: UserRef | null; content: string | null; attachments: number; createdAt: string | null }
  | { type: 'message_delete_bulk'; guildId: string; channelId: string; messageIds: string[] }
  | { type: 'message_update'; guildId: string; channelId: string; messageId: string; author: UserRef | null; before: string | null; after: string | null }
  | { type: 'member_join'; guildId: string; user: UserRef; accountCreatedAt: string | null; hasAvatar?: boolean }
  | { type: 'member_leave'; guildId: string; user: UserRef; joinedAt: string | null; roles: RoleRef[] }
  | { type: 'member_update'; guildId: string; user: UserRef; nickBefore: string | null; nickAfter: string | null; rolesAdded: RoleRef[]; rolesRemoved: RoleRef[] }
  | { type: 'channel'; action: 'create' | 'delete' | 'update'; guildId: string; channelId: string; name: string; changes: Change[] }
  | { type: 'role'; action: 'create' | 'delete' | 'update'; guildId: string; roleId: string; name: string; changes: Change[] }
  | {
      type: 'audit';
      guildId: string;
      entryId: string;
      /** automod_*: Discord's AutoMod blocked a message, flagged it to a channel, or timed the member out. */
      action: 'ban' | 'unban' | 'kick' | 'timeout' | 'untimeout' | 'automod_block' | 'automod_flag' | 'automod_timeout';
      executor: UserRef | null;
      target: UserRef | null;
      targetId: string | null;
      reason: string | null;
      /** timeout: when it ends. */
      until: string | null;
      /** AutoMod: the rule's name and the channel of the message. */
      ruleName?: string | null;
      channelId?: string | null;
    }
  | {
      /** Server changes from the audit log, with who made them (for anti-nuke). */
      type: 'audit_change';
      guildId: string;
      entryId: string;
      kind: 'channel_create' | 'channel_delete' | 'role_create' | 'role_delete' | 'role_update' | 'prune' | 'bot_add' | 'webhook_create';
      executor: UserRef | null;
      targetId: string | null;
      targetName: string | null;
      /** role_update: the dangerous permissions added (only reported when there are some). */
      permissionsAdded?: string[];
      /** prune: how many members were removed. */
      removed?: number;
    };

/** Privileged intents to request (only when enabled on the Developer Portal and wanted). */
export interface PrivilegedIntents {
  members: boolean;
  messageContent: boolean;
  presences: boolean;
}
/** 'interaction' carries an IncomingCommand (slash commands); 'button' an IncomingButton (message component clicks). */
export type BotClientEvent = 'ready' | 'disconnected' | 'reconnecting' | 'resumed' | 'invalidated' | 'guildsChanged' | 'interaction' | 'button' | 'guildEvent';

/**
 * A click on a button of one of the bot's messages (a message component interaction), independent of the gateway
 * library. The response is always ephemeral (only the clicking user sees it) and never mentions anyone.
 */
export interface IncomingButton {
  id: string;
  applicationId: string;
  /** The button's custom_id, as set when the message was posted (untrusted until validated). */
  customId: string;
  guildId: string | null;
  channelId: string | null;
  /** The message the button belongs to. */
  messageId: string | null;
  userId: string;
  /** The member's server nickname, else their display name, else their username. */
  userName: string;
  /** The user has a profile picture of their own (for the join gate). */
  userHasAvatar?: boolean;
  /** A select menu: the options chosen (their values). */
  values?: string[];
  /** Answers the interaction (must happen within 3 seconds), visible only to the user who clicked. */
  reply(content: string): Promise<void>;
}

export type BotClientFactory = (privileged: PrivilegedIntents) => BotClient;

/**
 * Intents CONDUIT uses. The privileged ones (Server Members, Message Content, Presence) are required: they're
 * requested whenever they're enabled on the Developer Portal (Bot → Privileged Gateway Intents).
 */
export const BOT_INTENTS = [
  { name: 'Guilds', privileged: false },
  { name: 'Guild Messages', privileged: false },
  { name: 'Guild Moderation', privileged: false },
  { name: 'Server Members', privileged: true },
  { name: 'Message Content', privileged: true },
  { name: 'Presence', privileged: true },
] as const;
export const NO_PRIVILEGED_INTENTS: PrivilegedIntents = { members: false, messageContent: false, presences: false };

/** Production factory: discord.js with CONDUIT's intents (privileged ones only when asked). */
export const discordJsFactory: BotClientFactory = (privileged) => {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration];
  if (privileged.members) intents.push(GatewayIntentBits.GuildMembers);
  if (privileged.messageContent) intents.push(GatewayIntentBits.MessageContent);
  if (privileged.presences) intents.push(GatewayIntentBits.GuildPresences);
  // Partials: deletions and edits of messages sent before this session (not cached) still produce events.
  const client = new Client({ intents, partials: [Partials.Message, Partials.GuildMember, Partials.User] });
  const handlers = new Map<BotClientEvent, Array<(d?: unknown) => void>>();
  const emit = (e: BotClientEvent, d?: unknown) => handlers.get(e)?.forEach((h) => h(d));
  client.once(Events.ClientReady, () => emit('ready'));
  client.on(Events.ShardDisconnect, (event) => emit('disconnected', (event as { code?: number })?.code));
  client.on(Events.ShardReconnecting, () => emit('reconnecting'));
  client.on(Events.ShardResume, () => emit('resumed'));
  // A full reconnect (new session) fires ShardReady; ClientReady only fires once per client.
  client.on(Events.ShardReady, () => emit('resumed'));
  client.on(Events.Invalidated, () => emit('invalidated'));
  client.on(Events.GuildCreate, () => emit('guildsChanged'));
  client.on(Events.GuildDelete, () => emit('guildsChanged'));
  // Slash commands arrive over this same gateway connection (no second connection, no public endpoint).
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) emit('interaction', toIncomingCommand(interaction));
    else if (interaction.isButton() || interaction.isStringSelectMenu()) emit('button', toIncomingButton(interaction));
  });
  // Server events for Sticky Messages, timed-message counts and Discord Logging (mapped to library-independent shapes).
  const guildEvent = (e: GuildEvent | null) => e && emit('guildEvent', e);
  client.on(Events.MessageCreate, (m) => {
    if (!m.guildId) return;
    const text = messageText(m, privileged.messageContent);
    guildEvent({
      type: 'message_create',
      guildId: m.guildId,
      channelId: m.channelId,
      messageId: m.id,
      authorId: m.author.id,
      authorBot: m.author.bot || m.webhookId !== null,
      authorName: m.author.username,
      system: m.system,
      mentionCount: m.mentions.users.size + m.mentions.roles.size,
      ...(text ? { contentHash: contentHash(text), content: text.slice(0, 4000) } : {}),
      ...(m.member
        ? {
            authorRoleIds: [...m.member.roles.cache.keys()].filter((id) => id !== m.guildId),
            authorModerator: m.member.permissions.any([
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ModerateMembers,
              PermissionFlagsBits.KickMembers,
              PermissionFlagsBits.BanMembers,
              PermissionFlagsBits.Administrator,
            ]),
          }
        : {}),
    });
  });
  client.on(Events.MessageDelete, (m) => {
    if (!m.guildId) return;
    guildEvent({
      type: 'message_delete',
      guildId: m.guildId,
      channelId: m.channelId,
      messageId: m.id,
      author: m.author ? userRef(m.author) : null,
      content: messageText(m, privileged.messageContent),
      attachments: m.attachments?.size ?? 0,
      createdAt: m.createdAt ? m.createdAt.toISOString() : null,
    });
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (!('guildId' in channel) || !channel.guildId) return;
    guildEvent({ type: 'message_delete_bulk', guildId: channel.guildId, channelId: channel.id, messageIds: [...messages.keys()] });
  });
  client.on(Events.MessageUpdate, (before, after) => {
    if (!after.guildId) return;
    const b = messageText(before, privileged.messageContent);
    const a = messageText(after, privileged.messageContent);
    // Embeds unfurling also fire updates: only real text edits (or unknown text) are reported.
    if (b !== null && a !== null && a === b) return;
    guildEvent({ type: 'message_update', guildId: after.guildId, channelId: after.channelId, messageId: after.id, author: after.author ? userRef(after.author) : null, before: b, after: a });
  });
  client.on(Events.GuildMemberAdd, (m) =>
    guildEvent({ type: 'member_join', guildId: m.guild.id, user: userRef(m.user), accountCreatedAt: m.user.createdAt?.toISOString() ?? null, hasAvatar: m.user.avatar !== null }),
  );
  client.on(Events.GuildMemberRemove, (m) =>
    guildEvent({
      type: 'member_leave',
      guildId: m.guild.id,
      user: userRef(m.user),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      roles: m.roles ? [...m.roles.cache.values()].filter((r) => r.id !== m.guild.id).map(roleRef) : [],
    }),
  );
  client.on(Events.GuildMemberUpdate, (before, after) => guildEvent(memberUpdate(before, after)));
  client.on(Events.ChannelCreate, (ch) => guildEvent({ type: 'channel', action: 'create', guildId: ch.guild.id, channelId: ch.id, name: ch.name, changes: [] }));
  client.on(Events.ChannelDelete, (ch) => {
    if ('guild' in ch && ch.guild) guildEvent({ type: 'channel', action: 'delete', guildId: ch.guild.id, channelId: ch.id, name: ch.name, changes: [] });
  });
  client.on(Events.ChannelUpdate, (before, after) => {
    if (!('guild' in after) || !after.guild || !('guild' in before)) return;
    const changes: Change[] = [];
    if (before.name !== after.name) changes.push({ key: 'Name', before: before.name, after: after.name });
    const topic = (c: unknown) => (typeof (c as { topic?: unknown }).topic === 'string' ? (c as { topic: string }).topic : '');
    if (topic(before) !== topic(after)) changes.push({ key: 'Topic', before: topic(before) || '(none)', after: topic(after) || '(none)' });
    const nsfw = (c: unknown) => ((c as { nsfw?: unknown }).nsfw === true ? 'Yes' : 'No');
    if (nsfw(before) !== nsfw(after)) changes.push({ key: 'Age-restricted', before: nsfw(before), after: nsfw(after) });
    const slow = (c: unknown) => String((c as { rateLimitPerUser?: unknown }).rateLimitPerUser ?? 0);
    if (slow(before) !== slow(after)) changes.push({ key: 'Slowmode (seconds)', before: slow(before), after: slow(after) });
    if ('permissionOverwrites' in before && 'permissionOverwrites' in after && before.permissionOverwrites.cache.size !== after.permissionOverwrites.cache.size)
      changes.push({ key: 'Permission overwrites', before: String(before.permissionOverwrites.cache.size), after: String(after.permissionOverwrites.cache.size) });
    if (changes.length) guildEvent({ type: 'channel', action: 'update', guildId: after.guild.id, channelId: after.id, name: after.name, changes });
  });
  client.on(Events.GuildRoleCreate, (r) => guildEvent({ type: 'role', action: 'create', guildId: r.guild.id, roleId: r.id, name: r.name, changes: [] }));
  client.on(Events.GuildRoleDelete, (r) => guildEvent({ type: 'role', action: 'delete', guildId: r.guild.id, roleId: r.id, name: r.name, changes: [] }));
  client.on(Events.GuildRoleUpdate, (before, after) => {
    const changes = roleChanges(before, after);
    if (changes.length) guildEvent({ type: 'role', action: 'update', guildId: after.guild.id, roleId: after.id, name: after.name, changes });
  });
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => guildEvent(auditEvent(entry, guild.id) ?? auditChangeEvent(entry, guild.id)));
  // Without a listener, an 'error' event would crash the process.
  client.on(Events.Error, () => undefined);
  return {
    login: (token) => client.login(token),
    destroy: () => client.destroy(),
    userInfo: () => (client.user ? { id: client.user.id, username: client.user.username, avatar: client.user.avatar } : null),
    guilds: () => [...client.guilds.cache.values()].map((g: Guild) => ({ id: g.id, name: g.name, icon: g.icon, memberCount: g.memberCount ?? null })),
    on: (event, listener) => handlers.set(event, [...(handlers.get(event) ?? []), listener]),
    setPresence: (p) => {
      if (!client.user) throw new Error('The bot session isn’t ready.');
      client.user.setPresence({ status: p.status, activities: p.activities as ActivitiesOptions[] });
    },
  };
};

function userRef(u: User | PartialUser): UserRef {
  return { id: u.id, tag: u.username ?? 'Unknown', avatarUrl: u.username ? u.displayAvatarURL({ size: 128 }) : null, bot: u.bot ?? false };
}

function roleRef(r: Role): RoleRef {
  return { id: r.id, name: r.name };
}

/** A short fingerprint of a message's text (case and spacing ignored), for repeat detection. */
function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 32);
}

/** The text of a message, or null when it isn't known (not cached, or no Message Content intent). */
function messageText(m: Message | PartialMessage, contentIntent: boolean): string | null {
  if (!contentIntent || m.partial) return null;
  return typeof m.content === 'string' ? m.content : null;
}

function memberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember): GuildEvent | null {
  if (before.partial) return null; // nothing to compare with
  const was = new Set(before.roles.cache.keys());
  const now = new Set(after.roles.cache.keys());
  const rolesAdded = [...after.roles.cache.values()].filter((r) => !was.has(r.id)).map(roleRef);
  const rolesRemoved = [...before.roles.cache.values()].filter((r) => !now.has(r.id)).map(roleRef);
  const nickBefore = before.nickname ?? null;
  const nickAfter = after.nickname ?? null;
  if (!rolesAdded.length && !rolesRemoved.length && nickBefore === nickAfter) return null;
  return { type: 'member_update', guildId: after.guild.id, user: userRef(after.user), nickBefore, nickAfter, rolesAdded, rolesRemoved };
}

function roleChanges(before: Role, after: Role): Change[] {
  const changes: Change[] = [];
  if (before.name !== after.name) changes.push({ key: 'Name', before: before.name, after: after.name });
  if (before.hexColor !== after.hexColor) changes.push({ key: 'Color', before: before.hexColor, after: after.hexColor });
  if (before.hoist !== after.hoist) changes.push({ key: 'Shown separately', before: before.hoist ? 'Yes' : 'No', after: after.hoist ? 'Yes' : 'No' });
  if (before.mentionable !== after.mentionable) changes.push({ key: 'Mentionable', before: before.mentionable ? 'Yes' : 'No', after: after.mentionable ? 'Yes' : 'No' });
  if (before.permissions.bitfield !== after.permissions.bitfield) {
    const added = after.permissions.toArray().filter((p) => !before.permissions.has(p));
    const removed = before.permissions.toArray().filter((p) => !after.permissions.has(p));
    changes.push({ key: 'Permissions', before: removed.length ? `removed ${removed.join(', ')}` : '—', after: added.length ? `added ${added.join(', ')}` : '—' });
  }
  return changes;
}

/** Audit-log entries for moderation (written by Discord only when the action happened). */
function auditEvent(entry: GuildAuditLogsEntry, guildId: string): GuildEvent | null {
  let action: Extract<GuildEvent, { type: 'audit' }>['action'] | null = null;
  let until: string | null = null;
  if (entry.action === AuditLogEvent.MemberBanAdd) action = 'ban';
  else if (entry.action === AuditLogEvent.MemberBanRemove) action = 'unban';
  else if (entry.action === AuditLogEvent.MemberKick) action = 'kick';
  else if (entry.action === AuditLogEvent.AutoModerationBlockMessage) action = 'automod_block';
  else if (entry.action === AuditLogEvent.AutoModerationFlagToChannel) action = 'automod_flag';
  else if (entry.action === AuditLogEvent.AutoModerationUserCommunicationDisabled) action = 'automod_timeout';
  else if (entry.action === AuditLogEvent.MemberUpdate) {
    const change = entry.changes.find((ch) => ch.key === 'communication_disabled_until');
    if (!change) return null;
    if (typeof change.new === 'string' && change.new) {
      action = 'timeout';
      until = change.new;
    } else action = 'untimeout';
  }
  if (!action) return null;
  const target = entry.target && typeof entry.target === 'object' && 'username' in entry.target ? userRef(entry.target as User) : null;
  return {
    type: 'audit',
    guildId,
    entryId: entry.id,
    action,
    executor: entry.executor ? userRef(entry.executor) : null,
    target,
    targetId: entry.targetId ?? null,
    reason: entry.reason ?? null,
    until,
    ...(action.startsWith('automod_')
      ? (() => {
          const extra = (entry.extra ?? null) as { autoModerationRuleName?: unknown; channel?: { id?: unknown } | null } | null;
          return {
            ruleName: typeof extra?.autoModerationRuleName === 'string' ? extra.autoModerationRuleName.slice(0, 100) : null,
            channelId: typeof extra?.channel?.id === 'string' ? extra.channel.id : null,
          };
        })()
      : {}),
  };
}

const CHANGE_KINDS = new Map<AuditLogEvent, Extract<GuildEvent, { type: 'audit_change' }>['kind']>([
  [AuditLogEvent.ChannelCreate, 'channel_create'],
  [AuditLogEvent.ChannelDelete, 'channel_delete'],
  [AuditLogEvent.RoleCreate, 'role_create'],
  [AuditLogEvent.RoleDelete, 'role_delete'],
  [AuditLogEvent.RoleUpdate, 'role_update'],
  [AuditLogEvent.MemberPrune, 'prune'],
  [AuditLogEvent.BotAdd, 'bot_add'],
  [AuditLogEvent.WebhookCreate, 'webhook_create'],
]);

/** Audit-log entries for server changes anti-nuke counts. A role update counts only when it adds a dangerous permission. */
function auditChangeEvent(entry: GuildAuditLogsEntry, guildId: string): GuildEvent | null {
  const kind = CHANGE_KINDS.get(entry.action);
  if (!kind) return null;
  const change = (key: string) => entry.changes.find((ch) => ch.key === key);
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 100) : null);
  const name = change('name');
  let targetName = text(name?.new) ?? text(name?.old);
  if (!targetName && entry.target && typeof entry.target === 'object') {
    const t = entry.target as { username?: unknown; name?: unknown };
    targetName = text(t.username) ?? text(t.name);
  }
  let permissionsAdded: string[] | undefined;
  if (kind === 'role_update') {
    const perms = change('permissions');
    permissionsAdded = dangerousPermissionsAdded(perms?.old === undefined ? null : String(perms.old), perms?.new === undefined ? null : String(perms.new));
    if (permissionsAdded.length === 0) return null;
  }
  const extra = (entry.extra ?? null) as { removed?: unknown } | null;
  return {
    type: 'audit_change',
    guildId,
    entryId: entry.id,
    kind,
    executor: entry.executor ? userRef(entry.executor) : null,
    targetId: entry.targetId ?? null,
    targetName,
    ...(permissionsAdded ? { permissionsAdded } : {}),
    ...(kind === 'prune' && typeof extra?.removed === 'number' ? { removed: extra.removed } : {}),
  };
}

/** discord.js button interaction → library-independent IncomingButton (ephemeral replies, no mentions). */
function toIncomingButton(i: ButtonInteraction | StringSelectMenuInteraction): IncomingButton {
  const member = i.member as { nick?: unknown } | null;
  const name = [member?.nick, i.user.globalName, i.user.username].find((n): n is string => typeof n === 'string' && n.trim() !== '');
  return {
    id: i.id,
    applicationId: i.applicationId,
    customId: i.customId,
    guildId: i.guildId,
    channelId: i.channelId,
    messageId: i.message?.id ?? null,
    userId: i.user.id,
    userName: name ?? i.user.username,
    userHasAvatar: i.user.avatar !== null,
    ...(i.isStringSelectMenu() ? { values: [...i.values] } : {}),
    reply: async (content) => {
      await i.reply({ content: content.slice(0, 2000), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
    },
  };
}

/** One option of a slash command; a subcommand carries its own options. Members and channels keep the name shown. */
function toIncomingOption(o: CommandInteractionOption): IncomingOption {
  const member = o.member as { nick?: unknown; displayName?: unknown } | null | undefined;
  const label = [member?.displayName, member?.nick, o.user?.globalName, o.user?.username, o.channel && 'name' in o.channel ? o.channel.name : null].find(
    (n): n is string => typeof n === 'string' && n.trim() !== '',
  );
  return {
    name: o.name,
    type: o.type,
    value: o.value,
    ...(label ? { label } : {}),
    ...(o.options ? { options: o.options.map(toIncomingOption) } : {}),
  };
}

/** discord.js interaction → library-independent IncomingCommand. Responses use Discord's interaction callback API. */
function toIncomingCommand(i: ChatInputCommandInteraction): IncomingCommand {
  // Never ping anyone from a command response.
  const body = (r: CommandReply) => ({
    content: r.content.slice(0, 2000),
    ...(r.embeds?.length ? { embeds: r.embeds.slice(0, 10) as APIEmbed[] } : {}),
    ...(r.components?.length ? { components: r.components.slice(0, 5) as unknown as APIActionRowComponent<APIComponentInMessageActionRow>[] } : {}),
    allowedMentions: { parse: [] },
  });
  return {
    id: i.id,
    applicationId: i.applicationId,
    commandName: i.commandName,
    guildId: i.guildId,
    userId: i.user.id,
    userName: i.user.username,
    channelName: i.channel && 'name' in i.channel && typeof i.channel.name === 'string' ? i.channel.name : null,
    channelId: i.channelId,
    memberPermissions: i.memberPermissions?.bitfield ?? null,
    options: i.options.data.map(toIncomingOption),
    reply: async (r) => {
      await i.reply({ ...body(r), ...(r.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
    },
    defer: async (ephemeral) => {
      await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    },
    editReply: async (r) => {
      await i.editReply(body(r));
    },
  };
}

const RETRY_DELAYS_MS =[10_000, 30_000, 60_000, 120_000, 300_000];
const MAX_LOGIN_ATTEMPTS = 8;

export interface BotRunnerStatus {
  status: DiscordBotStatus;
  username: string | null;
  userId: string | null;
  problem: string | null;
  retryable: boolean;
  since: string | null;
}

export class DiscordBotRunner {
  private client: BotClient | null = null;
  private token: string | null = null;
  private generation = 0;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private state: BotRunnerStatus = { status: 'not_configured', username: null, userId: null, problem: null, retryable: false, since: null };

  constructor(
    private readonly o: {
      logger: Logger;
      now: () => Date;
      factory?: BotClientFactory;
      /** Called with the bot's servers whenever the live connection reports them. */
      onGuilds?: (guilds: Array<{ id: string; name: string; icon?: string | null }>) => void;
      /** Called when the bot joins or leaves a server during a session. */
      onGuildsChanged?: (guilds: Array<{ id: string; name: string }>) => void;
      /** Called once per new gateway session when it is ready (not on resumes). */
      onReady?: (guilds: Array<{ id: string; name: string }>) => void;
      /** Slash commands received by the current session. */
      onInteraction?: (interaction: IncomingCommand) => void;
      /** Button clicks received by the current session. */
      onButton?: (button: IncomingButton) => void;
      /** Server events (messages, members, channels, roles, audit log) from the current session. */
      onGuildEvent?: (event: GuildEvent) => void;
      /** Privileged intents to request at the next connection (default: none). */
      privilegedIntents?: () => PrivilegedIntents;
      /** The session came back (resumed, or a new session after a reconnect): e.g. send the bot's presence again. */
      onResumed?: () => void;
    },
  ) {}

  private requested: PrivilegedIntents = NO_PRIVILEGED_INTENTS;
  /** Discord refused the privileged intents at the last attempt: connect without them until settings change. */
  private privilegedRefused = false;

  /** The privileged intents the current connection uses. */
  activePrivilegedIntents(): PrivilegedIntents & { refused: boolean } {
    return { ...this.requested, refused: this.privilegedRefused };
  }

  status(): BotRunnerStatus {
    return { ...this.state };
  }

  /** Live server list from the gateway, or null when not connected. */
  liveGuilds(): Array<{ id: string; name: string; icon?: string | null; memberCount?: number | null }> | null {
    return this.state.status === 'connected' && this.client ? this.client.guilds() : null;
  }

  /** Sends the bot's presence on the live session. Not connected, or the session refused it: ok false with why. */
  sendPresence(presence: GatewayPresenceData): { ok: true } | { ok: false; problem: string } {
    const client = this.client;
    if (this.state.status !== 'connected' || !client) return { ok: false, problem: 'The bot isn’t connected to Discord.' };
    if (!client.setPresence) return { ok: false, problem: 'This connection can’t update the bot’s presence.' };
    try {
      client.setPresence(presence);
      return { ok: true };
    } catch (err) {
      this.o.logger.warn('discord presence update failed', { err });
      return { ok: false, problem: err instanceof Error && err.message ? err.message : 'Discord didn’t accept the presence update.' };
    }
  }

  /** The connected bot's avatar hash (null: no avatar), or undefined when not connected. */
  liveAvatar(): string | null | undefined {
    if (this.state.status !== 'connected' || !this.client) return undefined;
    return this.client.userInfo()?.avatar ?? null;
  }

  private set(patch: Partial<BotRunnerStatus>): void {
    const changed = patch.status !== undefined && patch.status !== this.state.status;
    this.state = { ...this.state, ...patch, ...(changed ? { since: this.o.now().toISOString() } : {}) };
  }

  /** Connects with `token`. Idempotent for the same token; a different token replaces the connection. */
  async start(token: string): Promise<void> {
    if (this.token === token && this.client && this.state.status !== 'error' && this.state.status !== 'disconnected') return;
    await this.stop();
    this.token = token;
    this.attempts = 0;
    this.connect();
  }

  /** Reconnect after a failure (the Reconnect action). */
  async restart(): Promise<void> {
    const token = this.token;
    if (!token) return;
    this.privilegedRefused = false;
    await this.stop();
    this.token = token;
    this.attempts = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    this.token = null;
    if (client) await client.destroy().catch(() => undefined);
    this.set({ status: 'not_configured', username: null, userId: null, problem: null, retryable: false });
  }

  private connect(): void {
    const token = this.token;
    if (!token) return;
    const generation = this.generation;
    const wanted = this.o.privilegedIntents?.() ?? NO_PRIVILEGED_INTENTS;
    this.requested = this.privilegedRefused ? NO_PRIVILEGED_INTENTS : wanted;
    const client = (this.o.factory ?? discordJsFactory)(this.requested);
    this.client = client;
    this.attempts++;
    this.set({ status: 'connecting', problem: null, retryable: false });
    const current = () => generation === this.generation && this.client === client;

    client.on('ready', () => {
      if (!current()) return;
      this.attempts = 0;
      const user = client.userInfo();
      this.set({ status: 'connected', username: user?.username ?? null, userId: user?.id ?? null, problem: null });
      this.o.logger.info('discord bot connected', { guilds: client.guilds().length });
      this.o.onGuilds?.(client.guilds());
      this.o.onReady?.(client.guilds());
    });
    // Exactly one interaction listener per client, and clients are never reused, so reconnecting can't stack
    // listeners. Interactions reaching a replaced or stopped client get a short reply instead of running.
    client.on('interaction', (detail) => {
      const interaction = detail as IncomingCommand;
      if (current() && this.state.status !== 'not_configured') {
        this.o.onInteraction?.(interaction);
        return;
      }
      void interaction.reply({ content: 'I’m restarting. Try again in a moment.', ephemeral: true }).catch(() => undefined);
    });
    // Like slash commands: one listener per client; clicks reaching a replaced or stopped client get a short reply.
    client.on('button', (detail) => {
      const button = detail as IncomingButton;
      if (current() && this.state.status !== 'not_configured' && this.o.onButton) {
        this.o.onButton(button);
        return;
      }
      void button.reply('I’m restarting. Try again in a moment.').catch(() => undefined);
    });
    client.on('guildEvent', (detail) => {
      if (!current() || this.state.status === 'not_configured') return;
      try {
        this.o.onGuildEvent?.(detail as GuildEvent);
      } catch (err) {
        this.o.logger.error('discord guild event handler failed', { err });
      }
    });
    client.on('guildsChanged', () => {
      if (!current()) return;
      this.o.onGuilds?.(client.guilds());
      this.o.onGuildsChanged?.(client.guilds());
    });
    client.on('reconnecting', () => current() && this.set({ status: 'reconnecting', problem: 'Connection to Discord lost; reconnecting…' }));
    client.on('resumed', () => {
      if (!current()) return;
      this.set({ status: 'connected', problem: null });
      this.o.onResumed?.();
    });
    client.on('disconnected', (code) => {
      if (!current()) return;
      this.set({ status: 'disconnected', problem: describeClose(code as number | undefined), retryable: code !== 4004 && code !== 4014 });
    });
    client.on('invalidated', () => {
      if (!current()) return;
      this.set({ status: 'error', problem: 'Discord ended the bot session. Select Reconnect to try again.', retryable: true });
    });

    client.login(token).catch((err: unknown) => {
      if (!current()) return;
      const code = (err as { code?: unknown })?.code;
      this.client = null;
      void client.destroy().catch(() => undefined);
      if (code === 'TokenInvalid' || code === 'TokenMissing') {
        this.set({ status: 'error', problem: 'Discord rejected the bot token. Reset it on the Bot page of your application and enter the new one under Reconfigure.', retryable: false });
      } else if (code === 'DisallowedIntents' && (this.requested.members || this.requested.messageContent || this.requested.presences) && !this.privilegedRefused) {
        // A privileged intent was refused (switched off on the Developer Portal since): keep the bot online without it.
        this.privilegedRefused = true;
        this.o.logger.warn('discord refused privileged intents; reconnecting without them');
        this.connect();
        return;
      } else if (code === 'DisallowedIntents') {
        this.set({ status: 'error', problem: 'Discord refused an intent the bot asked for. Enable it on the Bot page of your application, then select Reconnect.', retryable: true });
      } else if (this.attempts < MAX_LOGIN_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[Math.min(this.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
        this.set({ status: 'disconnected', problem: `Couldn't connect the bot to Discord; retrying in ${Math.round(delay / 1000)} seconds.`, retryable: true });
        this.retryTimer = setTimeout(() => {
          if (generation === this.generation) this.connect();
        }, delay);
        this.retryTimer.unref();
      } else {
        this.set({ status: 'error', problem: "Couldn't connect the bot to Discord after several attempts. Check your internet connection and select Reconnect.", retryable: true });
      }
      this.o.logger.warn('discord bot login failed', { code: typeof code === 'string' ? code : 'unknown', attempt: this.attempts });
    });
  }
}

function describeClose(code: number | undefined): string {
  switch (code) {
    case 4004:
      return 'Discord rejected the bot token. Reset it on the Bot page of your application and enter the new one under Reconfigure.';
    case 4014:
      return 'Discord refused an intent the bot asked for. Enable it on the Bot page of your application, then select Reconnect.';
    default:
      return 'The bot is disconnected from Discord. Select Reconnect to try again.';
  }
}
