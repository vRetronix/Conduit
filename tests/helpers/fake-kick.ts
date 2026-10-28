/**
 * A simulated Kick for automated tests (no network), implementing the documented contract:
 * id.kick.com /oauth/token (authorization_code with PKCE S256, refresh_token, client_credentials; client credentials in
 * the form body), /oauth/revoke (query parameters), and api.kick.com /public/v1/users and /channels with per-token
 * scopes. Profile pictures are served from files.kick.com.
 */
import crypto from 'node:crypto';
import type { FetchLike } from '../../apps/server/src/app/types';

export const KICK_CLIENT_ID = '01JKICKCLIENTID0000000000';
export const KICK_CLIENT_SECRET = 'kick-client-secret-value-for-tests';
export const AVATAR_BYTES = Buffer.from('fake-kick-avatar-webp');

export interface FakeKickUser {
  user_id: number;
  name: string;
  slug: string;
  profile_picture: string | null;
}

interface Grant {
  user: FakeKickUser;
  scopes: string[];
}

export class FakeKick {
  readonly users = {
    streamer: {
      user_id: 4242001,
      name: 'RetroLive',
      slug: 'retrolive',
      profile_picture: 'https://files.kick.com/images/user/4242001/profile_image/conversion/a.webp',
    },
    bot: { user_id: 4242002, name: 'RetroBotKick', slug: 'retrobotkick', profile_picture: null },
    otherBot: { user_id: 4242003, name: 'SecondBot', slug: 'secondbot', profile_picture: null },
  } satisfies Record<string, FakeKickUser>;

  /** Codes Kick would accept: redirect URI, PKCE challenge and the account that approved. */
  private readonly codes = new Map<string, { redirectUri: string; challenge: string; grant: Grant }>();
  readonly accessTokens = new Map<string, Grant>();
  readonly refreshTokens = new Map<string, Grant>();
  readonly requests: Array<{ url: string; method: string; body: string }> = [];
  readonly revoked: string[] = [];
  offline = false;
  /** Channel points rewards on the token owner's channel (docs.kick.com/apis/channel-rewards). */
  readonly rewards = new Map<string, { id: string; title: string; description: string; cost: number; is_enabled: boolean; is_paused: boolean; should_redemptions_skip_request_queue: boolean }>();
  /** Redemptions as Kick holds them. */
  readonly redemptions: Array<{ id: string; rewardId: string; userId: number; username: string; redeemedAt: string; status: 'pending' | 'accepted' | 'rejected' }> = [];
  /** Accept/reject calls received. */
  readonly redemptionDecisions: Array<{ decision: string; ids: string[] }> = [];
  private rewardCounter = 0;
  // ── moderation (docs.kick.com/apis/moderation) ──
  /** Bans and timeouts in the token owner's channel: user id → minutes (null = permanent). */
  readonly bans = new Map<number, { duration: number | null; reason: string | null; by: string }>();
  readonly deletedMessages: string[] = [];
  /** Kick users known by slug (GET /channels?slug=). */
  readonly directory = new Map<string, FakeKickUser>();
  /** Live status per channel slug (GET /channels?slug=…); absent = offline. */
  readonly live = new Map<string, { startTime: string | null; title?: string; category?: string; thumbnail?: string; viewers?: number; /** What GET /livestreams reports (defaults to thumbnail). */ livestreamThumbnail?: string }>();
  /** GET /public/v1/livestreams requests made with the app token. */
  livestreamRequests = 0;
  /** Make GET /channels fail with HTTP 500 (Kick outage). */
  channelsDown = false;
  /** Stream title / category changes (PATCH /public/v1/channels, channel:write), in order. */
  readonly channelUpdates: Array<{ slug: string; stream_title?: string; category_id?: number }> = [];
  /** Kick's categories (GET /public/v2/categories?name=, /public/v1/categories?q=). */
  readonly categories: Array<{ id: number; name: string }> = [
    { id: 15, name: 'Just Chatting' },
    { id: 28, name: 'Minecraft' },
    { id: 29, name: 'Minecraft Dungeons' },
  ];
  /** Requests to GET /channels with an app access token. */
  appChannelRequests = 0;
  /** Users Kick refuses to ban (e.g. another moderator): HTTP 400 with this message. */
  readonly protectedUsers = new Map<number, string>();

  private moderationEndpoint(path: string, method: string, body: string, g: Grant): Response | null {
    if (path === '/public/v1/moderation/bans') {
      if (!g.scopes.includes('moderation:ban')) return json(403, { message: 'Forbidden' });
      const b = JSON.parse(body || '{}') as { broadcaster_user_id?: number; user_id?: number; duration?: number; reason?: string };
      if (typeof b.broadcaster_user_id !== 'number' || typeof b.user_id !== 'number') return json(400, { message: 'broadcaster_user_id and user_id are required' });
      if (b.broadcaster_user_id !== g.user.user_id) return json(403, { message: 'You are not a moderator of this channel' });
      if (method === 'POST') {
        if (b.duration !== undefined && (!Number.isInteger(b.duration) || b.duration < 1 || b.duration > 10080)) return json(400, { message: 'Invalid duration' });
        if (b.reason !== undefined && b.reason.length > 100) return json(400, { message: 'Reason too long' });
        const refusal = this.protectedUsers.get(b.user_id);
        if (refusal) return json(400, { message: refusal });
        this.bans.set(b.user_id, { duration: b.duration ?? null, reason: b.reason ?? null, by: g.user.name });
        return json(200, { message: 'OK', data: {} });
      }
      if (method === 'DELETE') {
        if (!this.bans.delete(b.user_id)) return json(400, { message: 'User is not banned' });
        return json(200, { message: 'OK', data: {} });
      }
    }
    const del = /^\/public\/v1\/chat\/([0-9A-Za-z-]+)$/.exec(path);
    if (del && method === 'DELETE') {
      if (!g.scopes.includes('moderation:chat_message:manage')) return json(403, { message: 'Forbidden' });
      if (this.deletedMessages.includes(del[1]!)) return json(404, { message: 'Message not found' });
      this.deletedMessages.push(del[1]!);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  /** A viewer redeems a reward on Kick; returns the signed webhook payload Kick would send (channel.reward.redemption.updated). */
  redeem(rewardId: string, user: FakeKickUser, at = new Date().toISOString()): Record<string, unknown> {
    const reward = this.rewards.get(rewardId);
    const id = `01RDM${String(++this.rewardCounter).padStart(8, '0')}`;
    this.redemptions.push({ id, rewardId, userId: user.user_id, username: user.name, redeemedAt: at, status: 'pending' });
    return redemptionPayload({ id, status: 'pending', redeemedAt: at, reward: { id: rewardId, title: reward?.title ?? 'x', cost: reward?.cost ?? 1 }, redeemer: user, broadcaster: this.users.streamer });
  }

  private rewardsEndpoint(path: string, method: string, query: URLSearchParams, body: string, scopes: string[]): Response | null {
    if (!path.startsWith('/public/v1/channels/rewards')) return null;
    const canWrite = scopes.includes('channel:rewards:write');
    if (!canWrite && !(method === 'GET' && scopes.includes('channel:rewards:read'))) return json(403, { message: 'Forbidden' });
    if (path === '/public/v1/channels/rewards' && method === 'POST') {
      const b = JSON.parse(body) as { title?: string; cost?: number; description?: string; should_redemptions_skip_request_queue?: boolean; is_enabled?: boolean };
      if (!b.title || b.title.length > 50 || typeof b.cost !== 'number' || b.cost < 1) return json(400, { message: 'Invalid reward' });
      if (this.rewards.size >= 50) return json(400, { message: 'Channel reward limit reached' }); // documented: up to 50 per channel
      const id = `01REW${String(++this.rewardCounter).padStart(8, '0')}`;
      this.rewards.set(id, {
        id,
        title: b.title,
        description: b.description ?? '',
        cost: b.cost,
        is_enabled: b.is_enabled ?? true,
        is_paused: false,
        should_redemptions_skip_request_queue: b.should_redemptions_skip_request_queue ?? false,
      });
      return json(200, { message: 'OK', data: this.rewards.get(id) });
    }
    const one = /^\/public\/v1\/channels\/rewards\/([0-9A-Z]+)$/.exec(path);
    if (one && (method === 'PATCH' || method === 'DELETE')) {
      const r = this.rewards.get(one[1]!);
      if (!r) return json(404, { message: 'Not Found' });
      if (method === 'DELETE') {
        this.rewards.delete(r.id);
        return new Response(null, { status: 204 });
      }
      Object.assign(r, JSON.parse(body));
      return json(200, { message: 'OK', data: r });
    }
    if (path === '/public/v1/channels/rewards/redemptions' && method === 'GET') {
      const rewardId = query.get('reward_id');
      const status = query.get('status') ?? 'pending';
      const list = this.redemptions.filter((r) => (!rewardId || r.rewardId === rewardId) && r.status === status);
      return json(200, {
        message: 'OK',
        data: rewardId
          ? [
              {
                reward: { id: rewardId, title: this.rewards.get(rewardId)?.title ?? '', cost: 1, can_manage: true, is_deleted: !this.rewards.has(rewardId) },
                redemptions: list.map((r) => ({ id: r.id, redeemed_at: r.redeemedAt, redeemer: { user_id: r.userId }, status: r.status, user_input: '' })),
              },
            ]
          : [],
        pagination: { next_cursor: '' },
      });
    }
    const decide = /^\/public\/v1\/channels\/rewards\/redemptions\/(accept|reject)$/.exec(path);
    if (decide && method === 'POST') {
      const ids = (JSON.parse(body) as { ids?: string[] }).ids ?? [];
      if (ids.length < 1 || ids.length > 25) return json(400, { message: 'Invalid ids' });
      this.redemptionDecisions.push({ decision: decide[1]!, ids });
      const failed: Array<{ id: string; reason: string }> = [];
      for (const id of ids) {
        const r = this.redemptions.find((x) => x.id === id);
        if (!r) failed.push({ id, reason: 'NOT_FOUND' });
        else if (r.status !== 'pending') failed.push({ id, reason: 'NOT_PENDING' });
        else r.status = decide[1] === 'accept' ? 'accepted' : 'rejected';
      }
      return json(200, { message: 'OK', data: failed });
    }
    return json(404, { message: 'Not Found' });
  }

  /** Event subscriptions (chat.message.sent etc.), as GET /public/v1/events/subscriptions lists them. */
  readonly subscriptions: Array<{ id: string; event: string; version: number; broadcaster_user_id: number; method: string }> = [];
  /** Messages accepted by POST /public/v1/chat. */
  readonly posted: Array<{ as: string; type: string; broadcaster_user_id: number | null; content: string }> = [];
  /** One-shot failures for the next chat/subscription API calls: HTTP status, or 'network', or 'not_sent'. */
  readonly apiFailures: Array<number | 'network' | 'not_sent'> = [];
  /** Reject subscription creation with HTTP 400 and this message (as real Kick did before webhooks were set up). */
  rejectSubscribe: string | null = null;
  /** Kick's webhook signing key pair; the public half is served at /public/v1/public-key. */
  signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  /** Omit the scope field from token responses (Kick's docs don't type it). */
  omitScope = false;
  /** Grant fewer scopes than requested. */
  grantOnly: string[] | null = null;
  expiresIn: number | string = 3600;
  private counter = 0;

  /** The browser side: the user approves on Kick's page, signed in as `who`. Returns the redirect back to CONDUIT. */
  approve(authorizationUrl: URL, who: FakeKickUser): URL {
    const p = authorizationUrl.searchParams;
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('Kick requires PKCE S256');
    const code = `kick-code-${++this.counter}`;
    const requested = (p.get('scope') ?? '').split(' ').filter(Boolean);
    this.codes.set(code, {
      redirectUri: p.get('redirect_uri')!,
      challenge: p.get('code_challenge')!,
      grant: { user: who, scopes: this.grantOnly ?? requested },
    });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    return back;
  }

  /** Kick-side revocation (e.g. the user removed the app), or expiry beyond refresh. */
  revokeAllFor(who: FakeKickUser): void {
    for (const map of [this.accessTokens, this.refreshTokens]) for (const [t, g] of map) if (g.user.user_id === who.user_id) map.delete(t);
  }

  private issue(grant: Grant, withRefresh = true): Response {
    const access = `kick-access-${++this.counter}-SECRET`;
    const refresh = `kick-refresh-${this.counter}-SECRET`;
    this.accessTokens.set(access, grant);
    if (withRefresh) this.refreshTokens.set(refresh, grant);
    return json(200, {
      access_token: access,
      token_type: 'Bearer',
      ...(withRefresh ? { refresh_token: refresh } : {}),
      expires_in: this.expiresIn,
      ...(this.omitScope ? {} : { scope: grant.scopes.join(' ') }),
    });
  }

  fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    this.requests.push({ url: input, method, body });
    if (this.offline) throw new TypeError('fetch failed');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );

    if (url.origin === 'https://id.kick.com' && url.pathname === '/oauth/token' && method === 'POST') {
      if (headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'Invalid request' });
      const f = new URLSearchParams(body);
      if (f.get('client_id') !== KICK_CLIENT_ID || f.get('client_secret') !== KICK_CLIENT_SECRET)
        return json(401, { error: 'invalid_client' });
      switch (f.get('grant_type')) {
        case 'authorization_code': {
          const c = this.codes.get(f.get('code') ?? '');
          this.codes.delete(f.get('code') ?? ''); // single use
          if (!c || c.redirectUri !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          const verifier = f.get('code_verifier') ?? '';
          const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (challenge !== c.challenge) return json(400, { error: 'invalid_grant' });
          return this.issue(c.grant);
        }
        case 'refresh_token': {
          const g = this.refreshTokens.get(f.get('refresh_token') ?? '');
          if (!g) return json(400, { error: 'invalid_grant' });
          this.refreshTokens.delete(f.get('refresh_token')!); // rotated
          return this.issue(g);
        }
        case 'client_credentials':
          return this.issue({ user: { user_id: 0, name: 'app', slug: '', profile_picture: null }, scopes: [] }, false);
        default:
          return json(400, { error: 'unsupported_grant_type' });
      }
    }

    if (url.origin === 'https://id.kick.com' && url.pathname === '/oauth/revoke' && method === 'POST') {
      const token = url.searchParams.get('token') ?? '';
      this.revoked.push(url.searchParams.get('token_hint_type') ?? '');
      const g = this.accessTokens.get(token) ?? this.refreshTokens.get(token);
      if (g) this.revokeAllFor(g.user);
      this.accessTokens.delete(token);
      return new Response('OK', { status: 200 });
    }

    if (url.origin === 'https://api.kick.com' && url.pathname === '/public/v1/public-key') {
      return json(200, {
        message: 'OK',
        data: { public_key: this.signingKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      });
    }

    if (url.origin === 'https://api.kick.com') {
      const g = this.accessTokens.get(headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!g) return json(401, { message: 'Unauthorized' });
      const appToken = g.user.user_id === 0;
      if (url.pathname === '/public/v1/users' && url.searchParams.getAll('id').length > 0) {
        if (!appToken && !g.scopes.includes('user:read')) return json(403, { message: 'Forbidden' });
        const ids = url.searchParams.getAll('id').map(Number);
        const all = [...Object.values(this.users), ...this.directory.values()];
        const found = ids.map((id) => all.find((u) => u.user_id === id)).filter((u): u is FakeKickUser => !!u);
        return json(200, { message: 'OK', data: found.map((u) => ({ user_id: u.user_id, name: u.name, email: '', profile_picture: u.profile_picture ?? '' })) });
      }
      if (url.pathname === '/public/v1/users') {
        if (!g.scopes.includes('user:read')) return json(403, { message: 'Forbidden' });
        const u = g.user;
        return json(200, {
          message: 'OK',
          data: [{ user_id: u.user_id, name: u.name, email: 'must-not-be-used@example.com', profile_picture: u.profile_picture ?? '' }],
        });
      }
      if (url.pathname === '/public/v1/events/subscriptions' || url.pathname === '/public/v1/chat') {
        const failure = this.apiFailures.shift();
        if (failure === 'network') throw new TypeError('fetch failed');
        if (typeof failure === 'number') {
          return new Response(JSON.stringify({ message: 'Simulated failure' }), {
            status: failure,
            headers: { 'content-type': 'application/json', ...(failure === 429 ? { 'retry-after': '7' } : {}) },
          });
        }
        if (url.pathname === '/public/v1/chat') {
          if (method !== 'POST') return json(405, { message: 'Method Not Allowed' });
          if (!g.scopes.includes('chat:write')) return json(403, { message: 'Forbidden' });
          const b = JSON.parse(body) as { type?: string; broadcaster_user_id?: number; content?: string };
          // Kick counts grapheme clusters (max 500) and at most 2048 UTF-8 bytes.
          const graphemes = typeof b.content === 'string' ? [...new Intl.Segmenter().segment(b.content)].length : 0;
          if (
            (b.type !== 'user' && b.type !== 'bot') ||
            typeof b.content !== 'string' ||
            graphemes > 500 ||
            Buffer.byteLength(b.content) > 2048
          ) {
            return json(400, { message: 'Bad Request' });
          }
          if (b.type === 'user' && typeof b.broadcaster_user_id !== 'number')
            return json(400, { message: 'broadcaster_user_id is required' });
          if (failure === 'not_sent') return json(200, { message: 'OK', data: { is_sent: false, message_id: '' } });
          this.posted.push({ as: g.user.name, type: b.type, broadcaster_user_id: b.broadcaster_user_id ?? null, content: b.content });
          return json(200, { message: 'OK', data: { is_sent: true, message_id: crypto.randomUUID() } });
        }
        if (method === 'GET') {
          return json(200, {
            message: 'OK',
            data: this.subscriptions.map((s) => ({
              ...s,
              app_id: 'app',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            })),
          });
        }
        if (!g.scopes.includes('events:subscribe')) return json(403, { message: 'Forbidden' });
        if (method === 'POST' && this.rejectSubscribe) return json(400, { message: this.rejectSubscribe });
        if (method === 'POST') {
          const b = JSON.parse(body) as { events: Array<{ name: string; version: number }>; method: string };
          if (b.method !== 'webhook') return json(400, { message: 'Bad Request' });
          return json(200, {
            message: 'OK',
            data: b.events.map((e) => {
              const id = `01SUB${String(++this.counter).padStart(8, '0')}`;
              this.subscriptions.push({ id, event: e.name, version: e.version, broadcaster_user_id: g.user.user_id, method: 'webhook' });
              return { name: e.name, version: e.version, subscription_id: id, error: '' };
            }),
          });
        }
        if (method === 'DELETE') {
          const ids = url.searchParams.getAll('id');
          for (const id of ids) {
            const i = this.subscriptions.findIndex((s) => s.id === id);
            if (i >= 0) this.subscriptions.splice(i, 1);
          }
          return new Response(null, { status: 204 });
        }
      }
      const moderationResponse = this.moderationEndpoint(url.pathname, method, body, g);
      if (moderationResponse) return moderationResponse;
      const rewardsResponse = this.rewardsEndpoint(url.pathname, method, url.searchParams, body, g.scopes);
      if (rewardsResponse) return rewardsResponse;
      if (url.pathname === '/public/v1/livestreams') {
        if (!appToken) return json(403, { message: 'Forbidden' });
        this.livestreamRequests++;
        const ids = url.searchParams.getAll('broadcaster_user_id');
        const data = ids.flatMap((id) => {
          const u = [...this.directory.values(), ...Object.values(this.users)].find((x) => String(x.user_id) === id);
          const l = u && this.live.get(u.slug);
          return l ? [{ broadcaster_user_id: u.user_id, slug: u.slug, thumbnail: l.livestreamThumbnail ?? l.thumbnail ?? '', viewer_count: l.viewers ?? 0 }] : [];
        });
        return json(200, { message: 'OK', data });
      }
      if (url.pathname === '/public/v1/channels' && method === 'PATCH') {
        if (appToken || !g.scopes.includes('channel:write')) return json(403, { message: 'Forbidden' });
        const b = JSON.parse(body) as { stream_title?: string; category_id?: number };
        this.channelUpdates.push({ slug: g.user.slug, ...b });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/public/v2/categories' || url.pathname === '/public/v1/categories') {
        const names = url.pathname.includes('v2') ? url.searchParams.getAll('name').map((n) => n.toLowerCase()) : [];
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const data = this.categories.filter((c) => (names.length ? names.includes(c.name.toLowerCase()) : q && c.name.toLowerCase().includes(q)));
        return json(200, { message: 'OK', data: data.map((c) => ({ ...c, thumbnail: '', tags: [] })) });
      }
      if (url.pathname === '/public/v1/channels') {
        if (!appToken && !g.scopes.includes('channel:read')) return json(403, { message: 'Forbidden' });
        const slugs = url.searchParams.getAll('slug');
        if (slugs.length > 0) {
          if (appToken) this.appChannelRequests++;
          if (this.channelsDown) return json(500, { message: 'Internal Server Error' });
          if (slugs.length > 50) return json(400, { message: 'Too many slugs' });
          const data = slugs.flatMap((slug) => {
            const u = this.directory.get(slug.toLowerCase()) ?? Object.values(this.users).find((x) => x.slug === slug.toLowerCase());
            if (!u) return [];
            const l = this.live.get(u.slug);
            return [
              {
                broadcaster_user_id: u.user_id,
                slug: u.slug,
                stream_title: l?.title ?? 'Offline title',
                category: { id: 1, name: l?.category ?? 'Just Chatting', thumbnail: '' },
                stream: {
                  is_live: !!l,
                  start_time: l ? l.startTime : '0001-01-01T00:00:00Z',
                  thumbnail: l?.thumbnail ?? '',
                  viewer_count: l?.viewers ?? 0,
                  key: 'STREAM-KEY-MUST-NOT-LEAK',
                  url: 'rtmps://must-not-leak',
                },
              },
            ];
          });
          return json(200, { message: 'OK', data });
        }
        return json(200, {
          message: 'OK',
          data: [{ broadcaster_user_id: g.user.user_id, slug: g.user.slug, stream: { key: 'STREAM-KEY-MUST-NOT-LEAK' } }],
        });
      }
    }

    if (url.origin === 'https://files.kick.com' && url.pathname.endsWith('.webp')) {
      return new Response(AVATAR_BYTES, { status: 200, headers: { 'content-type': 'image/webp' } });
    }
    return json(404, { message: 'Not Found' });
  };
}

/** A chat.message.sent (v1) payload, shaped like Kick's documented example. */
export function chatPayload(o: {
  content: string;
  sender: FakeKickUser;
  broadcaster: FakeKickUser;
  messageId?: string;
  /** Kick badges on the sender (default: a moderator badge). null = no identity data at all. */
  badges?: Array<{ text: string; type: string; count?: number }> | null;
}): Record<string, unknown> {
  const person = (u: FakeKickUser, identity: unknown) => ({
    is_anonymous: false,
    user_id: u.user_id,
    username: u.name,
    is_verified: false,
    profile_picture: u.profile_picture ?? '',
    channel_slug: u.slug,
    identity,
  });
  return {
    message_id: o.messageId ?? crypto.randomUUID(),
    replies_to: null,
    broadcaster: person(o.broadcaster, null),
    sender: person(
      o.sender,
      o.badges === null ? null : { username_color: '#FF5733', badges: o.badges ?? [{ text: 'Moderator', type: 'moderator' }] },
    ),
    content: o.content,
    emotes: [{ emote_id: '12345', positions: [{ s: 0, e: 3 }] }],
    created_at: new Date().toISOString(),
  };
}

/**
 * Delivers a webhook exactly as Kick documents it: headers plus an RSA-SHA256 signature over
 * "<message id>.<timestamp>.<raw body>". Options let tests forge, replay or age a delivery.
 */
/** A channel.reward.redemption.updated (v1) payload, as documented on docs.kick.com/events/event-types. */
export function redemptionPayload(o: {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  redeemedAt: string;
  reward: { id: string; title: string; cost: number };
  redeemer: FakeKickUser;
  broadcaster: FakeKickUser;
}): Record<string, unknown> {
  const person = (u: FakeKickUser) => ({ user_id: u.user_id, username: u.name, is_verified: false, profile_picture: u.profile_picture ?? '', channel_slug: u.slug });
  return {
    id: o.id,
    user_input: '',
    status: o.status,
    redeemed_at: o.redeemedAt,
    reward: { ...o.reward, description: '' },
    redeemer: person(o.redeemer),
    broadcaster: person(o.broadcaster),
  };
}

export async function deliverWebhook(
  kick: FakeKick,
  port: number,
  payload: unknown,
  opts: { messageId?: string; timestamp?: string; type?: string; signWith?: crypto.KeyObject; path?: string; host?: string } = {},
): Promise<number> {
  const body = JSON.stringify(payload);
  const messageId = opts.messageId ?? `01J${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const signature = crypto
    .sign('sha256', Buffer.from(`${messageId}.${timestamp}.${body}`), opts.signWith ?? kick.signingKey.privateKey)
    .toString('base64');
  const res = await fetch(`http://${opts.host ?? '127.0.0.1'}:${port}${opts.path ?? '/kick/webhook'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Kick-Event-Message-Id': messageId,
      'Kick-Event-Subscription-Id': '01SUB',
      'Kick-Event-Signature': signature,
      'Kick-Event-Message-Timestamp': timestamp,
      'Kick-Event-Type': opts.type ?? 'chat.message.sent',
      'Kick-Event-Version': '1',
    },
    body,
  });
  await res.text();
  return res.status;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
