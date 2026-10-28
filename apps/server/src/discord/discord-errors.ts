import { AppError } from '../errors';
import { DiscordApiError } from './discord-api';

/**
 * A Discord failure in plain words for the dashboard (never a token or raw response). Only "forbidden" and "not found"
 * depend on what was being done, so the caller says which permission was likely missing and what couldn't be found.
 */
export function describeDiscordFailure(err: unknown, hint: { forbidden: string; notFound: string }): string {
  if (err instanceof AppError) return err.message;
  if (!(err instanceof DiscordApiError)) return 'Something went wrong talking to Discord.';
  switch (err.kind) {
    case 'forbidden':
      return hint.forbidden;
    case 'not_found':
      return hint.notFound;
    case 'rate_limited':
      return 'Discord asked CONDUIT to slow down; try again in a moment.';
    case 'network':
      return 'Couldn’t reach Discord.';
    case 'server_error':
      return 'Discord had a problem; try again in a moment.';
    case 'invalid_credentials':
      return 'Discord rejected the bot token.';
    default:
      return err.discordMessage ? `Discord said: ${err.discordMessage}` : 'Discord returned an unexpected response.';
  }
}
