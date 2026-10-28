import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/server/src/errors';
import { DiscordApiError } from '../../apps/server/src/discord/discord-api';
import { describeDiscordFailure } from '../../apps/server/src/discord/discord-errors';

const hint = { forbidden: 'Needs Manage Roles.', notFound: 'They left.' };

describe('describeDiscordFailure', () => {
  it('uses the caller’s wording for a refusal and for something missing', () => {
    expect(describeDiscordFailure(new DiscordApiError('forbidden', 'x', undefined, 50013), hint)).toBe('Needs Manage Roles.');
    expect(describeDiscordFailure(new DiscordApiError('not_found', 'x'), hint)).toBe('They left.');
  });

  it.each([
    ['rate_limited', /slow down/],
    ['network', /Couldn’t reach Discord/],
    ['server_error', /Discord had a problem/],
    ['invalid_credentials', /rejected the bot token/],
  ] as const)('%s has its own plain message', (kind, text) => {
    expect(describeDiscordFailure(new DiscordApiError(kind, 'raw detail'), hint)).toMatch(text);
  });

  it('passes on Discord’s own explanation for anything else, never the raw error message', () => {
    expect(describeDiscordFailure(new DiscordApiError('unexpected_response', 'raw', undefined, 50035, 'Invalid regex'), hint)).toBe('Discord said: Invalid regex');
    expect(describeDiscordFailure(new DiscordApiError('unexpected_response', 'raw'), hint)).toBe('Discord returned an unexpected response.');
  });

  it('keeps CONDUIT’s own messages and hides anything unexpected', () => {
    expect(describeDiscordFailure(new AppError('conflict', 'They’re no longer in the server.'), hint)).toBe('They’re no longer in the server.');
    expect(describeDiscordFailure(new Error('token abc'), hint)).toBe('Something went wrong talking to Discord.');
  });
});
