/**
 * Posting and deleting the bot's own Discord messages, shared by Timed Messages, Sticky Messages, Stream Notifications
 * and Discord Logging: the bot token, Discord's error codes translated once, mentions off by default, and "already
 * deleted" treated as done rather than as a failure.
 */
import { toDiscordEmbed, type DiscordMessageInput } from '@conduit/shared';
import { DiscordApiError, type DiscordApi } from './discord-api';
import type { DiscordCredentials } from './discord-credentials';

export type PostResult = { ok: true; messageId: string } | { ok: false; detail: string; retryable: boolean };

export class DiscordPoster {
  constructor(
    private readonly o: {
      api: Pick<DiscordApi, 'createMessage' | 'editMessage' | 'deleteMessage' | 'latestMessageId'>;
      credentials: Pick<DiscordCredentials, 'botToken'>;
      now: () => Date;
    },
  ) {}

  /** Posts text and/or an embed (variables filled). Only `mentionRoles` can be pinged. */
  async post(
    channelId: string,
    m: { content?: string; embed?: DiscordMessageInput['embed'] | Record<string, unknown> | null },
    vars: Record<string, string> = {},
    mentionRoles: string[] = [],
    /** Message components (e.g. link buttons), already built. */
    components: unknown[] = [],
  ): Promise<PostResult> {
    const token = await this.o.credentials.botToken();
    if (!token) return { ok: false, detail: 'Discord isn’t set up (no bot token).', retryable: false };
    const embed = m.embed ? ('color' in m.embed && typeof m.embed.color === 'string' ? toDiscordEmbed(m.embed as NonNullable<DiscordMessageInput['embed']>, vars, this.o.now()) : m.embed) : null;
    const content = (m.content ?? '').slice(0, 2000);
    if (!content.trim() && !embed) return { ok: false, detail: 'Nothing to post (no text or embed).', retryable: false };
    try {
      const messageId = await this.o.api.createMessage(token, channelId, {
        ...(content.trim() ? { content } : {}),
        embeds: embed ? [embed] : [],
        ...(components.length ? { components } : {}),
        allowed_mentions: { parse: [], ...(mentionRoles.length ? { roles: mentionRoles.slice(0, 5) } : {}) },
      });
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, ...describePostError(err) };
    }
  }

  /** Replaces one of the bot's messages with new text/embed/components. An edit never pings anyone. */
  async edit(
    channelId: string,
    messageId: string,
    m: { content?: string; embed?: DiscordMessageInput['embed'] | null },
    vars: Record<string, string> = {},
    components: unknown[] = [],
  ): Promise<{ ok: true } | { ok: false; detail: string; gone: boolean }> {
    const token = await this.o.credentials.botToken();
    if (!token) return { ok: false, detail: 'Discord isn’t set up (no bot token).', gone: false };
    const embed = m.embed ? toDiscordEmbed(m.embed, vars, this.o.now()) : null;
    const content = (m.content ?? '').slice(0, 2000);
    try {
      await this.o.api.editMessage(token, channelId, messageId, {
        content,
        embeds: embed ? [embed] : [],
        components,
        allowed_mentions: { parse: [] },
      });
      return { ok: true };
    } catch (err) {
      const gone = err instanceof DiscordApiError && (err.discordCode === 10008 || err.discordCode === 10003);
      return { ok: false, detail: describePostError(err).detail, gone };
    }
  }

  /** Deletes one of the bot's messages. Already gone (deleted by someone, channel removed) counts as done. */
  async delete(channelId: string, messageId: string): Promise<{ ok: boolean; detail: string; alreadyGone: boolean }> {
    const token = await this.o.credentials.botToken();
    if (!token) return { ok: false, detail: 'Discord isn’t set up (no bot token).', alreadyGone: false };
    try {
      await this.o.api.deleteMessage(token, channelId, messageId, null, { ownFeature: true });
      return { ok: true, detail: 'Deleted.', alreadyGone: false };
    } catch (err) {
      if (err instanceof DiscordApiError && (err.discordCode === 10008 || err.discordCode === 10003)) return { ok: true, detail: 'It was already deleted.', alreadyGone: true };
      return { ok: false, detail: describePostError(err).detail, alreadyGone: false };
    }
  }

  /** The newest message in a channel (null: empty or unreadable — see the error). */
  async latestMessageId(channelId: string): Promise<{ ok: true; messageId: string | null } | { ok: false; detail: string }> {
    const token = await this.o.credentials.botToken();
    if (!token) return { ok: false, detail: 'Discord isn’t set up (no bot token).' };
    try {
      return { ok: true, messageId: await this.o.api.latestMessageId(token, channelId) };
    } catch (err) {
      return { ok: false, detail: describePostError(err).detail };
    }
  }
}

/** Discord's answer in plain words, with what to do. */
export function describePostError(err: unknown): { detail: string; retryable: boolean } {
  if (!(err instanceof DiscordApiError)) return { detail: 'Something went wrong talking to Discord.', retryable: true };
  switch (err.discordCode) {
    case 50013:
      return { detail: 'The bot is missing a permission in that channel (it needs View Channel, Send Messages, Embed Links and, for stickies, Read Message History).', retryable: false };
    case 50001:
      return { detail: 'The bot can’t access that channel. Give its role View Channel there.', retryable: false };
    case 10003:
      return { detail: 'That channel no longer exists. Choose another one.', retryable: false };
    case 10004:
      return { detail: 'The bot is no longer in that server.', retryable: false };
    case 50035:
      return { detail: 'Discord rejected the message content (check the embed’s links and lengths).', retryable: false };
  }
  switch (err.kind) {
    case 'invalid_credentials':
      return { detail: 'Discord rejected the bot token. Enter a new one under Discord → Manage.', retryable: false };
    case 'rate_limited':
      return { detail: `Discord asked to slow down${err.retryAfterSeconds ? ` (${err.retryAfterSeconds} s)` : ''}; it will be tried again.`, retryable: true };
    case 'network':
      return { detail: 'Couldn’t reach Discord.', retryable: true };
    case 'server_error':
      return { detail: 'Discord had a problem.', retryable: true };
    case 'forbidden':
      return { detail: 'Discord refused (missing permission in that channel).', retryable: false };
    case 'not_found':
      return { detail: 'Discord couldn’t find that channel or message.', retryable: false };
    default:
      return { detail: 'Discord rejected the request.', retryable: false };
  }
}
