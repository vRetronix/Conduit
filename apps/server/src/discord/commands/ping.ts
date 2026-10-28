import type { SlashCommand } from './types';

/**
 * /ping — the bot confirms, in the first person, that it is running and receiving commands. Answered by the live
 * gateway session, so a reply itself proves the connection.
 */
export const ping: SlashCommand = {
  name: 'ping',
  description: 'Check that I’m connected',
  origin: 'default',
  example: '/ping',
  message: 'Pong! I’m connected and ready!',
  execute: () => ({ content: 'Pong! I’m connected and ready!' }),
};
