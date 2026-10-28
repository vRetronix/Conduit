/**
 * Moderation slash commands: /timeout, /untimeout, /kick, /ban, /unban.
 *
 * Each is a SlashCommand like /ping. Discord shows it only to members with the matching permission
 * (default_member_permissions) and the dispatcher re-checks that permission on every use. The handler only translates
 * options into a request for the moderation service, which applies Discord's role hierarchy to the member who ran it,
 * performs the action with the bot's token and records the outcome in the Discord moderation log. Replies are private
 * (ephemeral) and are sent only after Discord answered the action: a refusal is shown as a failure, never as done.
 */
import { DISCORD_PERMISSION_BITS } from '@conduit/shared';
import { CommandError, OptionType, type CommandContext, type SlashCommand } from './types';

const { MODERATE_MEMBERS, KICK_MEMBERS, BAN_MEMBERS } = DISCORD_PERMISSION_BITS;
/** Discord's limits: timeouts up to 28 days; a ban may delete up to 7 days of the user's messages. */
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const MAX_DELETE_DAYS = 7;

export interface ModerationCommandRunner {
  runDiscordCommand(r: {
    guildId: string;
    invokerId: string;
    invokerName: string;
    command: string;
    action: 'timeout' | 'untimeout' | 'ban' | 'unban' | 'kick';
    userId: string;
    durationSeconds?: number;
    deleteMessageSeconds?: number;
    reason: string | null;
  }): Promise<{ ok: boolean; message: string }>;
}

const userOption = { name: 'user', description: 'The member', type: OptionType.User, required: true } as const;
const reasonOption = { name: 'reason', description: 'Why (shown in the server’s audit log)', type: OptionType.String, required: false } as const;

function base(ctx: CommandContext, command: string) {
  const reason = ctx.options.get('reason');
  return {
    guildId: ctx.guildId,
    invokerId: ctx.userId,
    invokerName: ctx.userName,
    command,
    userId: String(ctx.options.get('user')),
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
  };
}

async function run(runner: ModerationCommandRunner, request: Parameters<ModerationCommandRunner['runDiscordCommand']>[0]) {
  const result = await runner.runDiscordCommand(request);
  // A refusal (permission, hierarchy, Discord said no) is a failed command, answered privately.
  if (!result.ok) throw new CommandError(result.message);
  return { content: result.message, ephemeral: true };
}

export function moderationCommands(runner: ModerationCommandRunner): SlashCommand[] {
  return [
    {
      name: 'timeout',
      description: 'Time a member out',
      origin: 'default',
      example: '/timeout user:@troll minutes:10 reason:spamming',
      message: 'I’ve timed out {user} for {minutes} minutes.',
      requiredPermissions: MODERATE_MEMBERS,
      ephemeral: true,
      audit: true,
      options: [userOption, { name: 'minutes', description: `How long (1–${MAX_TIMEOUT_MINUTES} minutes)`, type: OptionType.Integer, required: true }, reasonOption],
      execute: (ctx) => {
        const minutes = Number(ctx.options.get('minutes'));
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES)
          throw new CommandError(`Choose 1 to ${MAX_TIMEOUT_MINUTES} minutes (Discord allows up to 28 days).`);
        return run(runner, { ...base(ctx, 'timeout'), action: 'timeout', durationSeconds: minutes * 60 });
      },
    },
    {
      name: 'untimeout',
      description: 'Remove a member’s timeout',
      origin: 'default',
      example: '/untimeout user:@troll',
      message: 'I’ve removed {user}’s timeout.',
      requiredPermissions: MODERATE_MEMBERS,
      ephemeral: true,
      audit: true,
      options: [userOption, reasonOption],
      execute: (ctx) => run(runner, { ...base(ctx, 'untimeout'), action: 'untimeout' }),
    },
    {
      name: 'kick',
      description: 'Remove a member from the server (they can rejoin with an invite)',
      origin: 'default',
      example: '/kick user:@troll reason:spamming',
      message: 'I’ve kicked {user}.',
      requiredPermissions: KICK_MEMBERS,
      ephemeral: true,
      audit: true,
      options: [userOption, reasonOption],
      execute: (ctx) => run(runner, { ...base(ctx, 'kick'), action: 'kick' }),
    },
    {
      name: 'ban',
      description: 'Ban a user from the server',
      origin: 'default',
      example: '/ban user:@troll reason:raid delete_days:1',
      message: 'I’ve banned {user}.',
      requiredPermissions: BAN_MEMBERS,
      ephemeral: true,
      audit: true,
      options: [
        userOption,
        reasonOption,
        { name: 'delete_days', description: `Also delete their messages from the last 0–${MAX_DELETE_DAYS} days`, type: OptionType.Integer, required: false },
      ],
      execute: (ctx) => {
        const days = ctx.options.has('delete_days') ? Number(ctx.options.get('delete_days')) : 0;
        if (!Number.isInteger(days) || days < 0 || days > MAX_DELETE_DAYS) throw new CommandError(`delete_days must be 0 to ${MAX_DELETE_DAYS}.`);
        return run(runner, { ...base(ctx, 'ban'), action: 'ban', deleteMessageSeconds: days * 86_400 });
      },
    },
    {
      name: 'unban',
      description: 'Lift a ban',
      origin: 'default',
      example: '/unban user:123456789012345678',
      message: 'I’ve unbanned {user}.',
      requiredPermissions: BAN_MEMBERS,
      ephemeral: true,
      audit: true,
      options: [{ ...userOption, description: 'The banned user (paste their user ID)' }, reasonOption],
      execute: (ctx) => run(runner, { ...base(ctx, 'unban'), action: 'unban' }),
    },
  ];
}
