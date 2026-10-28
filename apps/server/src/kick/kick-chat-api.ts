/**
 * Kick's official chat and events API (https://api.kick.com/public/v1), per docs.kick.com:
 * - GET/POST/DELETE /events/subscriptions — webhook subscriptions (events:subscribe; with a user token the channel is
 *   the token owner's). POST body: { events: [{ name, version }], method: 'webhook' }.
 * - POST /chat — { type: 'user' | 'bot', content, broadcaster_user_id? } (chat:write). 'bot' messages always go to the
 *   token owner's own channel, so CONDUIT sends as 'user' with the main account's broadcaster_user_id.
 *   Response: data.is_sent, data.message_id.
 * - GET /public-key — data.public_key, used to verify webhook signatures.
 * - Channel rewards (docs.kick.com/apis/channel-rewards; channel:rewards:write, token owner's channel):
 *   POST /channels/rewards (create), PATCH /channels/rewards/{id}, DELETE /channels/rewards/{id},
 *   GET /channels/rewards/redemptions?reward_id&status (pending by default, paginated with cursor),
 *   POST /channels/rewards/redemptions/accept | reject { ids: [1–25] } → only the failed ids, with a reason
 *   (UNKNOWN, NOT_PENDING, NOT_FOUND, NOT_OWNED). Kick documents no fulfil or refund endpoints.
 * - Moderation (docs.kick.com/apis/moderation; the token owner must be the broadcaster or a moderator):
 *   POST /moderation/bans { broadcaster_user_id, user_id, duration? (minutes, 1–10080: a timeout), reason? (≤100) }
 *   and DELETE /moderation/bans { broadcaster_user_id, user_id } (scope moderation:ban);
 *   DELETE /chat/{message_id} (scope moderation:chat_message:manage).
 * - GET /channels?slug= — a channel by its slug (a Kick username), for its broadcaster_user_id (channel:read).
 * - PATCH /channels { stream_title?, category_id? } — the token owner's stream title and category (channel:write).
 * - GET /public/v2/categories?name= — categories by exact name; GET /categories?q= (v1, deprecated) — search by word.
 * - Webhook event channel.reward.redemption.updated (v1): id, status (pending/accepted/rejected), redeemed_at,
 *   reward { id, title, cost }, redeemer { user_id, username }, broadcaster { user_id }.
 * Errors never include tokens or message content.
 */
import type { FetchLike } from '../app/types';

const API = 'https://api.kick.com/public/v1';
const API_V2 = 'https://api.kick.com/public/v2';
const TIMEOUT_MS = 15_000;

export type KickApiErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'bad_request' | 'server_error' | 'network' | 'unexpected_response';

export class KickApiError extends Error {
  constructor(
    readonly kind: KickApiErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
    /** Whether the request may already have taken effect (network failure after sending). */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'KickApiError';
  }
}

export interface KickSubscription {
  id: string;
  event: string;
  version: number;
  broadcasterUserId: string | null;
  method: string;
}

export const CHAT_EVENT = { name: 'chat.message.sent', version: 1 } as const;
export const REDEMPTION_EVENT = { name: 'channel.reward.redemption.updated', version: 1 } as const;
/** Bans and timeouts in the channel, by anyone (Kick's own buttons, other bots, CONDUIT). */
export const BAN_EVENT = { name: 'moderation.banned', version: 1 } as const;

export interface KickRewardInput {
  title: string;
  description: string;
  cost: number;
  is_enabled?: boolean;
  is_paused?: boolean;
  should_redemptions_skip_request_queue?: boolean;
}

/** Public information about a channel, as CONDUIT keeps it. */
export interface KickChannelInfo {
  slug: string;
  broadcasterUserId: string;
  live: boolean;
  /** When the current stream started (Kick's value; identifies the live session). */
  startTime: string | null;
  thumbnail: string | null;
  viewerCount: number | null;
  title: string | null;
  category: string | null;
}

export interface KickRedemption {
  id: string;
  rewardId: string;
  redeemerUserId: string;
  redeemedAt: string;
  status: 'pending' | 'accepted' | 'rejected';
}

const REDEMPTION_STATUSES = new Set(['pending', 'accepted', 'rejected']);

export class KickChatApi {
  private readonly fetchImpl: FetchLike;
  private readonly onRateLimited: (retryAfterSeconds: number | undefined) => void;

  /** onRateLimited: told whenever Kick answers 429 (the dashboard shows a pop-up alert). */
  constructor(o: { fetch?: FetchLike; onRateLimited?: (retryAfterSeconds: number | undefined) => void } = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.onRateLimited = o.onRateLimited ?? (() => {});
  }

  async listSubscriptions(token: string): Promise<KickSubscription[]> {
    const body = (await this.request(token, 'GET', '/events/subscriptions')) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) throw new KickApiError('unexpected_response', 'Kick returned an unexpected subscription list');
    return body.data
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof (s as { id?: unknown }).id === 'string')
      .map((s) => ({
        id: String(s.id),
        event: typeof s.event === 'string' ? s.event : '',
        version: typeof s.version === 'number' ? s.version : 0,
        broadcasterUserId: s.broadcaster_user_id == null ? null : String(s.broadcaster_user_id),
        method: typeof s.method === 'string' ? s.method : '',
      }));
  }

  /** Creates the chat.message.sent webhook subscription for the token owner's channel; returns its id. */
  async subscribeToChat(token: string): Promise<string> {
    const body = (await this.request(token, 'POST', '/events/subscriptions', { events: [CHAT_EVENT], method: 'webhook' })) as {
      data?: unknown;
    } | null;
    const first = Array.isArray(body?.data) ? (body.data[0] as { subscription_id?: unknown; error?: unknown } | undefined) : undefined;
    if (first && typeof first.error === 'string' && first.error)
      throw new KickApiError('bad_request', `Kick refused the chat subscription: ${first.error.slice(0, 200)}`);
    if (!first || typeof first.subscription_id !== 'string' || !first.subscription_id) {
      throw new KickApiError('unexpected_response', 'Kick did not confirm the chat subscription');
    }
    return first.subscription_id;
  }

  /** Subscribes the token owner's channel to an event (e.g. reward redemptions); returns the subscription id. */
  async subscribeTo(token: string, event: { name: string; version: number }): Promise<string> {
    const body = (await this.request(token, 'POST', '/events/subscriptions', { events: [event], method: 'webhook' })) as { data?: unknown } | null;
    const first = Array.isArray(body?.data) ? (body.data[0] as { subscription_id?: unknown; error?: unknown } | undefined) : undefined;
    if (first && typeof first.error === 'string' && first.error) throw new KickApiError('bad_request', `Kick refused the ${event.name} subscription: ${first.error.slice(0, 200)}`);
    if (!first || typeof first.subscription_id !== 'string' || !first.subscription_id) {
      throw new KickApiError('unexpected_response', `Kick did not confirm the ${event.name} subscription`);
    }
    return first.subscription_id;
  }

  // ── channel rewards ──

  /** Creates a channel points reward on the token owner's channel; returns its id. */
  async createReward(token: string, reward: KickRewardInput): Promise<string> {
    const body = (await this.request(token, 'POST', '/channels/rewards', reward)) as { data?: { id?: unknown } } | null;
    const id = body?.data?.id;
    if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new KickApiError('unexpected_response', 'Kick did not return the new reward');
    return id;
  }

  async updateReward(token: string, rewardId: string, patch: Partial<KickRewardInput>): Promise<void> {
    await this.request(token, 'PATCH', `/channels/rewards/${encodeURIComponent(rewardId)}`, patch);
  }

  async deleteReward(token: string, rewardId: string): Promise<void> {
    await this.request(token, 'DELETE', `/channels/rewards/${encodeURIComponent(rewardId)}`);
  }

  /** Redemptions of one reward with one status (all pages, bounded). */
  async redemptions(token: string, rewardId: string, status: 'pending' | 'accepted' | 'rejected' = 'pending'): Promise<KickRedemption[]> {
    const out: KickRedemption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ reward_id: rewardId, status });
      if (cursor) q.set('cursor', cursor);
      const body = (await this.request(token, 'GET', `/channels/rewards/redemptions?${q.toString()}`)) as {
        data?: unknown;
        pagination?: { next_cursor?: unknown };
      } | null;
      const groups = Array.isArray(body?.data) ? (body.data as Array<{ reward?: { id?: unknown }; redemptions?: unknown }>) : [];
      for (const group of groups) {
        const rid = typeof group?.reward?.id === 'string' ? group.reward.id : rewardId;
        for (const r of Array.isArray(group?.redemptions) ? (group.redemptions as Array<Record<string, unknown>>) : []) {
          const redeemer = r.redeemer as { user_id?: unknown } | undefined;
          if (typeof r.id !== 'string' || !REDEMPTION_STATUSES.has(String(r.status)) || redeemer?.user_id == null) continue;
          out.push({
            id: r.id,
            rewardId: rid,
            redeemerUserId: String(redeemer.user_id),
            redeemedAt: typeof r.redeemed_at === 'string' ? r.redeemed_at : '',
            status: r.status as KickRedemption['status'],
          });
        }
      }
      const next = body?.pagination?.next_cursor;
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }
    return out;
  }

  /** Accepts or rejects redemptions (at most 25); returns the ones Kick couldn't change, with Kick's reason. */
  async decideRedemptions(token: string, decision: 'accept' | 'reject', ids: string[]): Promise<Array<{ id: string; reason: string }>> {
    if (ids.length === 0) return [];
    const body = (await this.request(token, 'POST', `/channels/rewards/redemptions/${decision}`, { ids: ids.slice(0, 25) })) as {
      data?: unknown;
    } | null;
    const failed = Array.isArray(body?.data) ? (body.data as Array<{ id?: unknown; reason?: unknown }>) : [];
    return failed
      .filter((x) => typeof x?.id === 'string')
      .map((x) => ({ id: x.id as string, reason: typeof x.reason === 'string' ? x.reason : 'UNKNOWN' }));
  }

  async deleteSubscriptions(token: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const q = new URLSearchParams();
    for (const id of ids) q.append('id', id);
    await this.request(token, 'DELETE', `/events/subscriptions?${q.toString()}`);
  }

  /** Posts a chat message. Resolves only when Kick reports it sent. Never retried here (it could duplicate). */
  async sendMessage(token: string, broadcasterUserId: string, content: string): Promise<{ messageId: string | null }> {
    const body = (await this.request(
      token,
      'POST',
      '/chat',
      { type: 'user', broadcaster_user_id: Number(broadcasterUserId), content },
      true,
    )) as {
      data?: { is_sent?: unknown; message_id?: unknown };
    } | null;
    if (body?.data?.is_sent !== true) throw new KickApiError('unexpected_response', 'Kick did not send the message');
    return { messageId: typeof body.data.message_id === 'string' ? body.data.message_id : null };
  }

  // ── moderation ──

  /** Bans a user from the channel, or times them out for `durationMinutes` (1–10080). */
  async ban(token: string, broadcasterUserId: string, userId: string, durationMinutes: number | null, reason: string | null): Promise<void> {
    await this.request(token, 'POST', '/moderation/bans', {
      broadcaster_user_id: Number(broadcasterUserId),
      user_id: Number(userId),
      ...(durationMinutes !== null ? { duration: durationMinutes } : {}),
      ...(reason ? { reason: reason.slice(0, 100) } : {}),
    });
  }

  /** Lifts a ban or a timeout. */
  async unban(token: string, broadcasterUserId: string, userId: string): Promise<void> {
    await this.request(token, 'DELETE', '/moderation/bans', { broadcaster_user_id: Number(broadcasterUserId), user_id: Number(userId) });
  }

  async deleteChatMessage(token: string, messageId: string): Promise<void> {
    await this.request(token, 'DELETE', `/chat/${encodeURIComponent(messageId)}`);
  }

  /**
   * Public channel information for up to 50 channels by slug (GET /channels?slug=…), including live status. Works with
   * an app access token. Only the fields CONDUIT shows are kept — never the stream key Kick includes for your own
   * channel.
   */
  async channelsBySlugs(token: string, slugs: string[]): Promise<KickChannelInfo[]> {
    if (slugs.length === 0) return [];
    const q = new URLSearchParams();
    for (const s of slugs.slice(0, 50)) q.append('slug', s);
    const body = (await this.request(token, 'GET', `/channels?${q.toString()}`)) as { data?: unknown } | null;
    const list = Array.isArray(body?.data) ? (body.data as Array<Record<string, unknown>>) : [];
    const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : null);
    return list
      .filter((c) => typeof c?.slug === 'string' && c.broadcaster_user_id != null)
      .map((c) => {
        const stream = (c.stream ?? null) as Record<string, unknown> | null;
        const category = (c.category ?? null) as Record<string, unknown> | null;
        return {
          slug: String(c.slug).toLowerCase(),
          broadcasterUserId: String(c.broadcaster_user_id),
          live: stream?.is_live === true,
          startTime: str(stream?.start_time, 100),
          thumbnail: str(stream?.thumbnail, 2048),
          viewerCount: typeof stream?.viewer_count === 'number' ? stream.viewer_count : null,
          title: str(c.stream_title, 300),
          category: str(category?.name, 200),
        };
      });
  }

  /**
   * Current stream thumbnails by broadcaster id (GET /livestreams?broadcaster_user_id=…), for live channels whose
   * channel info came without one. Works with an app access token. Channels that aren't live, or have no thumbnail yet
   * (Kick makes the first one a few minutes into a stream), are left out.
   */
  async livestreamThumbnails(token: string, broadcasterIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (broadcasterIds.length === 0) return out;
    const q = new URLSearchParams();
    for (const id of broadcasterIds.slice(0, 50)) q.append('broadcaster_user_id', id);
    const body = (await this.request(token, 'GET', `/livestreams?${q.toString()}`)) as { data?: unknown } | null;
    const list = Array.isArray(body?.data) ? (body.data as Array<Record<string, unknown>>) : [];
    for (const s of list) {
      const thumb = typeof s?.thumbnail === 'string' ? s.thumbnail.trim() : '';
      if (s?.broadcaster_user_id != null && /^https:\/\//i.test(thumb) && thumb.length <= 2048) out.set(String(s.broadcaster_user_id), thumb);
    }
    return out;
  }

  /** Users by id (GET /users?id=…): names and profile pictures. Works with an app access token. */
  async usersByIds(token: string, ids: string[]): Promise<Array<{ userId: string; name: string; profilePicture: string | null }>> {
    if (ids.length === 0) return [];
    const q = new URLSearchParams();
    for (const id of ids.slice(0, 50)) q.append('id', id);
    const body = (await this.request(token, 'GET', `/users?${q.toString()}`)) as { data?: unknown } | null;
    const list = Array.isArray(body?.data) ? (body.data as Array<Record<string, unknown>>) : [];
    return list
      .filter((u) => u?.user_id != null && typeof u.name === 'string')
      .map((u) => ({ userId: String(u.user_id), name: String(u.name).slice(0, 100), profilePicture: typeof u.profile_picture === 'string' && /^https:\/\//.test(u.profile_picture) ? u.profile_picture : null }));
  }

  /** A channel by slug (a Kick username); null when there's none. */
  async channelBySlug(token: string, slug: string): Promise<{ broadcasterUserId: string; slug: string } | null> {
    const body = (await this.request(token, 'GET', `/channels?${new URLSearchParams({ slug }).toString()}`)) as { data?: unknown } | null;
    const first = Array.isArray(body?.data) ? (body.data[0] as { broadcaster_user_id?: unknown; slug?: unknown } | undefined) : undefined;
    const id = first?.broadcaster_user_id;
    if (id == null || !/^\d{1,20}$/.test(String(id))) return null;
    return { broadcasterUserId: String(id), slug: typeof first?.slug === 'string' ? first.slug.slice(0, 64) : slug };
  }

  /** Changes the token owner's stream title and/or category (PATCH /channels; channel:write). */
  async updateChannel(token: string, patch: { streamTitle?: string; categoryId?: number }): Promise<void> {
    await this.request(token, 'PATCH', '/channels', {
      ...(patch.streamTitle !== undefined ? { stream_title: patch.streamTitle } : {}),
      ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {}),
    });
  }

  /**
   * A category by name: Kick's exact-name lookup first (v2), else the first result of its word search (v1). Works with
   * any token. Null when nothing matches.
   */
  async findCategory(token: string, name: string): Promise<{ id: number; name: string } | null> {
    const pick = (body: unknown) => {
      const list = Array.isArray((body as { data?: unknown } | null)?.data) ? ((body as { data: Array<Record<string, unknown>> }).data) : [];
      const valid = list.filter((c) => typeof c?.id === 'number' && Number.isInteger(c.id) && c.id > 0 && typeof c.name === 'string');
      const exact = valid.find((c) => String(c.name).toLowerCase() === name.toLowerCase());
      const hit = exact ?? valid[0];
      return hit ? { id: hit.id as number, name: String(hit.name).slice(0, 200) } : null;
    };
    if (name.length >= 3) {
      const exact = pick(await this.request(token, 'GET', `${API_V2}/categories?${new URLSearchParams({ name, limit: '5' }).toString()}`).catch(() => null));
      if (exact) return exact;
    }
    return pick(await this.request(token, 'GET', `/categories?${new URLSearchParams({ q: name }).toString()}`));
  }

  /** Kick's current webhook-signing public key (PEM or base64 DER, as published). */
  async publicKey(): Promise<string> {
    const res = await this.send(`${API}/public-key`, { headers: { Accept: 'application/json' } }, false);
    if (!res.ok)
      throw new KickApiError(
        res.status >= 500 ? 'server_error' : 'unexpected_response',
        `Kick public key request failed (HTTP ${res.status})`,
      );
    const body = (await res.json().catch(() => null)) as { data?: { public_key?: unknown } } | null;
    const key = body?.data?.public_key;
    if (typeof key !== 'string' || key.length < 100) throw new KickApiError('unexpected_response', 'Kick returned no public key');
    return key;
  }

  private async request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, json?: unknown, sending = false): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    // A path, or a full URL for the few v2 endpoints.
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    const res = await this.send(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }, sending);
    if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
    const what = `${method} ${path.replace(/^https:\/\/api\.kick\.com\/public/, '').split('?')[0]}`;
    const retry = Number(res.headers.get('retry-after'));
    // Kick's own explanation (e.g. why a request was rejected), shown to the user. It describes the request, never our
    // credentials; it is still sanitized and capped.
    const detail = kickErrorDetail(await res.text().catch(() => ''));
    const said = detail ? `: "${detail}"` : '';
    if (res.status === 401) throw new KickApiError('unauthorized', 'Kick rejected the access token');
    if (res.status === 403) throw new KickApiError('forbidden', `Kick refused ${what} (HTTP 403)${said}`);
    if (res.status === 404) throw new KickApiError('not_found', `Kick could not find ${what} (HTTP 404)${said}`);
    if (res.status === 429) {
      const seconds = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
      this.onRateLimited(seconds);
      throw new KickApiError('rate_limited', 'Kick is rate limiting requests', seconds);
    }
    if (res.status === 400) throw new KickApiError('bad_request', `Kick rejected ${what} (HTTP 400)${said}`);
    if (res.status >= 500)
      throw new KickApiError('server_error', `Kick had a problem with ${what} (HTTP ${res.status})`, undefined, sending);
    throw new KickApiError('unexpected_response', `Kick ${what} failed (HTTP ${res.status})`);
  }

  private async send(url: string, init: RequestInit, sending: boolean): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      // A failure while sending a chat message may have happened after Kick received it.
      throw new KickApiError('network', 'Kick could not be reached', undefined, sending);
    }
  }
}

/** Kick's error text from a JSON ({ message } / { error }) or plain-text body: one line, printable, at most 200 chars. */
export function kickErrorDetail(body: string): string | null {
  let text = body.slice(0, 2000);
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    text = typeof j.message === 'string' && j.message ? j.message : typeof j.error === 'string' ? j.error : '';
  } catch {
    if (/<html|<!doctype/i.test(text)) return null;
  }
  const clean = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return clean || null;
}
