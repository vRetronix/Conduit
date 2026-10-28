/**
 * Custom Discord commands become slash commands registered next to the built-in ones (guild-scoped, like /ping).
 * The reply is the stored template filled in with command variables (render(), see CommandVariableService):
 * e.g. {user} = the user's username, {channel} = the channel's name, {args} = the optional "text" option,
 * {message} = "/name text". Replies never mention anyone (allowedMentions is empty for every response), so {mention}
 * shows as a mention without pinging.
 */
import type { ChatCommandRecord } from '@conduit/database';
import { formatSeconds } from '@conduit/shared';
import { deniedMessage, discordAllows, type Admission } from '../../community/command-access';
import { usesCommandText } from '@conduit/shared';
import { CommandError, OptionType, type CommandContext, type SlashCommand } from './types';

export const TEXT_OPTION = 'text';

/** Cooldown check-and-reserve (CustomCommandService.admit). */
export type AdmitFn = (command: ChatCommandRecord, userKey: string) => Admission;
/** Fills in the reply's variables for this interaction (text = the "text" option, or ''). */
export type RenderFn = (command: ChatCommandRecord, ctx: CommandContext, text: string) => Promise<string>;

export function customSlashCommand(record: ChatCommandRecord, admit: AdmitFn, render: RenderFn): SlashCommand {
  const name = record.trigger.slice(1);
  // Only commands whose reply uses the text offer the box, so Discord doesn't show an option that does nothing.
  const takesText = usesCommandText(record.response);
  return {
    name,
    description: record.description ?? 'Custom command',
    origin: 'user',
    options: takesText
      ? [{ name: TEXT_OPTION, description: 'Text to include in the reply', type: OptionType.String, required: false }]
      : [],
    // Permission from Discord's computed member permissions, then the cooldown (per Discord user id, or global).
    admit: (ctx) => {
      if (!discordAllows(record.permission, ctx.memberPermissions))
        return { ok: false, message: deniedMessage('discord', record.permission) };
      const admission = admit(record, ctx.userId);
      if (!admission.ok)
        return { ok: false, message: `/${name} is on cooldown. Try again in ${formatSeconds(admission.remainingSeconds)}.` };
      return admission;
    },
    execute: async (ctx) => {
      const raw = ctx.options.get(TEXT_OPTION);
      const text = typeof raw === 'string' ? raw : '';
      const content = await render(record, ctx, text);
      if (!content) throw new CommandError('This command’s reply was empty after filling in its variables.');
      return { content };
    },
  };
}
