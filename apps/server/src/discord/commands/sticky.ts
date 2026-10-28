/**
 * /sticky: Sticky Messages from Discord itself (Admin only).
 *
 * - /sticky set <#channel> <message>: keeps that text at the bottom of the channel. A channel that already has a
 *   sticky gets the new text (an embed it has is kept) and is switched on.
 * - /sticky remove <#channel>: removes the channel's sticky and its posted copy.
 * - /sticky list: this server's stickies.
 *
 * Slash command text can't hold line breaks, so "\n" in the message starts a new line. Everything goes through the
 * Sticky Messages service: the same permission checks as in CONDUIT, and the sticky shows up there to edit further.
 */
import type { StickyMessageView } from '@conduit/shared';
import { discordProblem } from './channels';
import { ChannelType, CommandError, OptionType, type SlashCommand } from './types';

export interface StickyCommandDeps {
  stickies: () => {
    state(): Promise<{ stickies: StickyMessageView[] }>;
    create(raw: unknown): Promise<StickyMessageView>;
    update(id: string, raw: unknown): Promise<StickyMessageView>;
    delete(id: string): Promise<unknown>;
  };
}

const channelOption = { name: 'channel', description: 'Which channel', type: OptionType.Channel, required: true, channelTypes: [ChannelType.Text, ChannelType.Announcement] } as const;

export function stickyCommands(d: StickyCommandDeps): SlashCommand[] {
  return [
    {
      name: 'sticky',
      description: 'Keep a message at the bottom of a channel',
      origin: 'default',
      example: '/sticky set channel:#rules message:Read the rules before posting!',
      message: '{channel} now has a sticky message.',
      ephemeral: true,
      audit: true,
      subcommands: [
        {
          name: 'set',
          description: 'Set a channel’s sticky message',
          options: [channelOption, { name: 'message', description: 'The text (use \\n for a new line)', type: OptionType.String, required: true, maxLength: 2000 }],
        },
        { name: 'remove', description: 'Remove a channel’s sticky message', options: [channelOption] },
        { name: 'list', description: 'See this server’s sticky messages' },
      ],
      execute: async (ctx) => {
        const service = d.stickies();
        const { stickies } = await service.state();
        if (ctx.subcommand === 'list') {
          const here = stickies.filter((s) => s.guildId === ctx.guildId);
          if (here.length === 0) return { content: 'There are no sticky messages in this server. Add one with /sticky set.', ephemeral: true };
          return { content: `Sticky messages:\n${here.map((s) => `• <#${s.channelId}> — ${s.name}${s.enabled ? '' : ' (off)'}`).join('\n')}`.slice(0, 2000), ephemeral: true };
        }
        const channelId = String(ctx.options.get('channel'));
        const existing = stickies.find((s) => s.channelId === channelId);
        if (ctx.subcommand === 'remove') {
          if (!existing) throw new CommandError(`<#${channelId}> has no sticky message.`);
          await service.delete(existing.id).catch((err) => {
            throw discordProblem(err, 'Manage Messages');
          });
          return { content: `The sticky message in <#${channelId}> is removed.`, ephemeral: true };
        }
        const text = String(ctx.options.get('message')).replace(/\\n/g, '\n').trim();
        if (!text) throw new CommandError('Write the message to keep at the bottom.');
        const problem = (err: unknown) => discordProblem(err, 'Send Messages and Read Message History');
        if (existing) {
          await service.update(existing.id, { enabled: true, message: { ...existing.message, content: text } }).catch((err) => {
            throw problem(err);
          });
          return { content: `The sticky message in <#${channelId}> is updated.`, ephemeral: true };
        }
        const label = ctx.optionLabels.get('channel');
        await service.create({ name: (label ? `#${label}` : 'Sticky message').slice(0, 60), guildId: ctx.guildId, channelId, message: { content: text } }).catch((err) => {
          throw problem(err);
        });
        return { content: `<#${channelId}> now has a sticky message. Edit it further in CONDUIT → Sticky Messages.`, ephemeral: true };
      },
    },
  ];
}
