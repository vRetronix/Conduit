/**
 * Twitch's Helix API for chat, called with a user access token and the app's Client-Id
 * (https://dev.twitch.tv/docs/api/reference/):
 * - POST /helix/eventsub/subscriptions: channel.chat.message v1 on CONDUIT's EventSub WebSocket session
 *   (https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage). With a WebSocket transport
 *   the token must belong to condition.user_id (the reading account) and carry user:read:chat. 202 = created.
 * - POST /helix/chat/messages: sends a message as sender_id (user:write:chat). 200 with is_sent false means Twitch
 *   dropped it (drop_reason says why, e.g. the chat is in followers-only mode); nothing was posted then.
 *
 * Errors name the request and quote Twitch's message; they never contain tokens or the message text.
 */
import type { FetchLike } from '../app/types';
import { TWITCH_API_BASE } from './twitch';

const REQUEST_TIMEOUT_MS = 15_000;
export const CHAT_MESSAGE_EVENT = { type: 'channel.chat.message', version: '1' } as const;

export type TwitchChatApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'conflict'
  | 'rate_limited'
  | 'dropped'
  | 'server_error'
  | 'network'
  | 'unexpected_response';

export class TwitchChatApiError extends Error {
  constructor(
    readonly kind: TwitchChatApiErrorKind,
    message: string,
    /** True when Twitch may have acted although the call failed (network failure or 5xx while sending). */
    readonly outcomeUnknown = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TwitchChatApiError';
  }
}

export interface TwitchUserAuth {
  token: string;
  clientId: string;
}

export class TwitchChatApi {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly onRateLimited: (retryAfterSeconds: number | undefined) => void;

  constructor(o: { fetch?: FetchLike; now?: () => Date; onRateLimited?: (retryAfterSeconds: number | undefined) => void } = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
    this.onRateLimited = o.onRateLimited ?? (() => {});
  }

  /** Subscribes the WebSocket session to a channel's chat, read as `userId`. Returns the subscription id. */
  async subscribeChat(auth: TwitchUserAuth, p: { sessionId: string; broadcasterUserId: string; userId: string }): Promise<string> {
    const body = await this.request(auth, 'POST /eventsub/subscriptions', '/eventsub/subscriptions', {
      type: CHAT_MESSAGE_EVENT.type,
      version: CHAT_MESSAGE_EVENT.version,
      condition: { broadcaster_user_id: p.broadcasterUserId, user_id: p.userId },
      transport: { method: 'websocket', session_id: p.sessionId },
    }, false);
    const sub = Array.isArray(body.data) ? (body.data[0] as { id?: unknown } | undefined) : undefined;
    if (typeof sub?.id !== 'string' || !sub.id) throw new TwitchChatApiError('unexpected_response', 'POST /eventsub/subscriptions: Twitch sent no subscription id');
    return sub.id;
  }

  /** Posts a chat message as `senderId` in `broadcasterUserId`'s chat. Resolves only when Twitch says it was sent. */
  async sendMessage(auth: TwitchUserAuth, p: { broadcasterUserId: string; senderId: string; message: string }): Promise<{ messageId: string | null }> {
    const body = await this.request(auth, 'POST /chat/messages', '/chat/messages', {
      broadcaster_id: p.broadcasterUserId,
      sender_id: p.senderId,
      message: p.message,
    }, true);
    const r = Array.isArray(body.data)
      ? (body.data[0] as { message_id?: unknown; is_sent?: unknown; drop_reason?: { code?: unknown; message?: unknown } | null } | undefined)
      : undefined;
    if (!r || typeof r.is_sent !== 'boolean') throw new TwitchChatApiError('unexpected_response', 'POST /chat/messages: Twitch sent an unexpected answer', true);
    if (!r.is_sent) {
      const why = typeof r.drop_reason?.message === 'string' && r.drop_reason.message.trim() ? r.drop_reason.message.trim().slice(0, 200) : 'no reason given';
      throw new TwitchChatApiError('dropped', why);
    }
    return { messageId: typeof r.message_id === 'string' && r.message_id ? r.message_id : null };
  }

  private async request(auth: TwitchUserAuth, label: string, path: string, json: unknown, sending: boolean): Promise<{ data?: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TWITCH_API_BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(json),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The request may have reached Twitch before the connection failed.
      throw new TwitchChatApiError('network', `${label}: Twitch couldn’t be reached`, sending);
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown; message?: unknown } | null;
    const reason = typeof body?.message === 'string' && body.message.trim() ? `: ${body.message.trim().slice(0, 200)}` : '';
    if (res.ok) {
      if (!body) throw new TwitchChatApiError('unexpected_response', `${label}: Twitch sent an unexpected answer`, sending);
      return body;
    }
    if (res.status === 401) throw new TwitchChatApiError('unauthorized', `${label} was rejected (HTTP 401${reason})`);
    if (res.status === 403) throw new TwitchChatApiError('forbidden', `${label} was refused (HTTP 403${reason})`);
    if (res.status === 409) throw new TwitchChatApiError('conflict', `${label} already exists (HTTP 409${reason})`);
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const seconds = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - this.now().getTime() / 1000)) : undefined;
      this.onRateLimited(seconds);
      throw new TwitchChatApiError('rate_limited', `${label} was rate limited (HTTP 429)`, false, seconds);
    }
    if (res.status === 400 || res.status === 422) throw new TwitchChatApiError('bad_request', `${label} was rejected (HTTP ${res.status}${reason})`);
    if (res.status >= 500) throw new TwitchChatApiError('server_error', `${label} failed (HTTP ${res.status})`, sending);
    throw new TwitchChatApiError('unexpected_response', `${label} failed (HTTP ${res.status}${reason})`);
  }
}
