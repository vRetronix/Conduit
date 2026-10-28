/**
 * Channel moderation slash commands: /slowmode, /lock, /unlock.
 *
 * Each acts on the channel it's used in, or on the channel picked in its `channel` option (text and announcement
 * channels of the same server). Discord shows them only to members with Manage Channels, the dispatcher re-checks that
 * on every use, and the Moderator group applies on top (Commands → Discord → Default Commands).
 *
 * - /slowmode sets how long members wait between messages (Discord's "Slowmode"; 0 turns it off).
 * - /lock stops @everyone posting there: the channel's @everyone permission overwrite gets Send Messages, Send
 *   Messages in Threads and Create Threads denied; everything else in that overwrite is kept. Roles with their own
 *   allow (moderators, for example) can still post. A short notice is posted in the channel first.
 * - /unlock removes exactly those denies again (the overwrite is deleted if nothing else is left in it) and posts a
 *   notice.
 *
 * The bot uses its own token: it needs Manage Channels (slowmode) and Manage Roles (channel permission overwrites).
 * Replies are private, and a refusal from Discord is shown as a failure, never as done. The reason, if given, goes to
 * the server's audit log.
 */
import { AppError } from '../../errors';
import { DiscordApiError, type DiscordApi } from '../discord-api';
import type { DiscordCredentials } from '../discord-credentials';
import { ChannelType, CommandError, OptionType, type CommandContext, type SlashCommand } from './types';

const MANAGE_CHANNELS = 1n << 4n;
const SEND_MESSAGES = 1n << 11n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const CREATE_PRIVATE_THREADS = 1n << 36n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
/** What /lock denies @everyone. */
export const LOCK_BITS = SEND_MESSAGES | SEND_MESSAGES_IN_THREADS | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS;

/** Slowmode choices (seconds), as Discord's own channel settings offer them. */
const SLOWMODE_CHOICES = [
  { name: 'Off', value: 0 },
  { name: '5 seconds', value: 5 },
  { name: '10 seconds', value: 10 },
  { name: '15 seconds', value: 15 },
  { name: '30 seconds', value: 30 },
  { name: '1 minute', value: 60 },
  { name: '2 minutes', value: 120 },
  { name: '5 minutes', value: 300 },
  { name: '10 minutes', value: 600 },
  { name: '15 minutes', value: 900 },
  { name: '30 minutes', value: 1800 },
  { name: '1 hour', value: 3600 },
  { name: '2 hours', value: 7200 },
  { name: '6 hours', value: 21600 },
] as const;

export interface ChannelCommandDeps {
  api: DiscordApi;
  credentials: Pick<DiscordCredentials, 'botToken'>;
}

const channelOption = { name: 'channel', description: 'Which channel (default: this one)', type: OptionType.Channel, required: false, channelTypes: [ChannelType.Text, ChannelType.Announcement] } as const;
const reasonOption = { name: 'reason', description: 'Why (shown in the server’s audit log)', type: OptionType.String, required: false, maxLength: 400 } as const;

/** A Discord refusal or outage as a short message for the member who ran the command. */
export function discordProblem(err: unknown, permission: string): CommandError {
  if (err instanceof CommandError) return err;
  // A CONDUIT check (e.g. the bot can't post in the chosen channel): its first specific reason.
  if (err instanceof AppError) return new CommandError(err.options.issues?.[0]?.message ?? err.message);
  if (err instanceof DiscordApiError) {
    if (err.kind === 'forbidden')
      return new CommandError(`Discord refused: I need ${permission} there. Give my role ${permission}, or add me to the server again from CONDUIT (Discord Bot → Settings).`);
    if (err.kind === 'rate_limited') return new CommandError('Discord is rate limiting me. Try again in a moment.');
    if (err.kind === 'not_found') return new CommandError('Discord couldn’t find that channel.');
    if (err.kind === 'network' || err.kind === 'server_error') return new CommandError('Discord couldn’t be reached. Try again in a moment.');
  }
  return new CommandError('Something went wrong. Try again.');
}

async function target(d: ChannelCommandDeps, ctx: CommandContext) {
  const token = await d.credentials.botToken();
  if (!token) throw new CommandError('I’m not set up yet.');
  const picked = ctx.options.get('channel');
  const channelId = typeof picked === 'string' ? picked : ctx.channelId;
  if (!channelId) throw new CommandError('Pick a channel.');
  const channels = await d.api.guildChannels(token, ctx.guildId).catch((err) => {
    throw discordProblem(err, 'View Channels');
  });
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) throw new CommandError('That channel isn’t in this server, or I can’t see it.');
  if (channel.type !== ChannelType.Text && channel.type !== ChannelType.Announcement) throw new CommandError('Choose a text or announcement channel.');
  return { token, channel };
}

function reasonOf(ctx: CommandContext, action: string): string {
  const r = ctx.options.get('reason');
  const why = typeof r === 'string' && r.trim() ? r.trim() : null;
  return `${action} by ${ctx.userName} with /${action}${why ? `: ${why}` : ''}`.slice(0, 400);
}

const seconds = (s: number) => SLOWMODE_CHOICES.find((c) => c.value === s)?.name.toLowerCase() ?? `${s} seconds`;

export function channelCommands(d: ChannelCommandDeps): SlashCommand[] {
  return [
    {
      name: 'slowmode',
      description: 'Set how long members wait between messages',
      origin: 'default',
      example: '/slowmode duration:30 seconds',
      message: 'Slowmode in {channel} is now {duration}.',
      requiredPermissions: MANAGE_CHANNELS,
      ephemeral: true,
      audit: true,
      options: [{ name: 'duration', description: 'How long to wait between messages', type: OptionType.Integer, required: true, choices: SLOWMODE_CHOICES }, channelOption, reasonOption],
      execute: async (ctx) => {
        const duration = Number(ctx.options.get('duration'));
        const { token, channel } = await target(d, ctx);
        await d.api.modifyChannel(token, channel.id, { rate_limit_per_user: duration }, reasonOf(ctx, 'slowmode')).catch((err) => {
          throw discordProblem(err, 'Manage Channels');
        });
        return { content: duration === 0 ? `Slowmode is off in <#${channel.id}>.` : `Slowmode in <#${channel.id}> is now ${seconds(duration)}.`, ephemeral: true };
      },
    },
    {
      name: 'lock',
      description: 'Stop members posting in a channel',
      origin: 'default',
      example: '/lock channel:#general reason:raid',
      message: '{channel} is locked. Use /unlock to open it again.',
      requiredPermissions: MANAGE_CHANNELS,
      ephemeral: true,
      audit: true,
      options: [channelOption, reasonOption],
      execute: async (ctx) => {
        const { token, channel } = await target(d, ctx);
        const everyone = channel.overwrites.find((o) => o.id === ctx.guildId) ?? { allow: 0n, deny: 0n };
        if ((everyone.deny & SEND_MESSAGES) === SEND_MESSAGES) throw new CommandError(`<#${channel.id}> is already locked.`);
        // The notice first: once locked, only roles allowed to post can (the bot may not be one of them).
        await d.api.createMessage(token, channel.id, { content: '🔒 This channel is locked.', embeds: [], allowed_mentions: { parse: [] } }).catch(() => undefined);
        await d.api
          .setChannelOverwrite(token, channel.id, ctx.guildId, { type: 0, allow: everyone.allow & ~LOCK_BITS, deny: everyone.deny | LOCK_BITS }, reasonOf(ctx, 'lock'))
          .catch((err) => {
            throw discordProblem(err, 'Manage Roles');
          });
        return { content: `<#${channel.id}> is locked. Use /unlock to open it again.`, ephemeral: true };
      },
    },
    {
      name: 'unlock',
      description: 'Let members post in a locked channel again',
      origin: 'default',
      example: '/unlock channel:#general',
      message: '{channel} is unlocked.',
      requiredPermissions: MANAGE_CHANNELS,
      ephemeral: true,
      audit: true,
      options: [channelOption, reasonOption],
      execute: async (ctx) => {
        const { token, channel } = await target(d, ctx);
        const everyone = channel.overwrites.find((o) => o.id === ctx.guildId);
        if (!everyone || (everyone.deny & SEND_MESSAGES) === 0n) throw new CommandError(`<#${channel.id}> isn’t locked.`);
        const deny = everyone.deny & ~LOCK_BITS;
        const reason = reasonOf(ctx, 'unlock');
        await (everyone.allow === 0n && deny === 0n
          ? d.api.deleteChannelOverwrite(token, channel.id, ctx.guildId, reason)
          : d.api.setChannelOverwrite(token, channel.id, ctx.guildId, { type: 0, allow: everyone.allow, deny }, reason)
        ).catch((err) => {
          throw discordProblem(err, 'Manage Roles');
        });
        await d.api.createMessage(token, channel.id, { content: '🔓 This channel is unlocked.', embeds: [], allowed_mentions: { parse: [] } }).catch(() => undefined);
        return { content: `<#${channel.id}> is unlocked.`, ephemeral: true };
      },
    },
  ];
}
