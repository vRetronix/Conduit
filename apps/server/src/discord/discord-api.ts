/**
 * Discord REST calls used to validate the user's application and bot, and to verify installations. Per the official
 * docs (https://docs.discord.com/developers/topics/oauth2, /resources/application, /resources/user):
 * - Client credentials grant (POST /oauth2/token, grant_type=client_credentials, HTTP Basic) proves an Application ID
 *   + Client Secret pair; the returned bearer token is revoked immediately.
 * - With `Authorization: Bot <token>`: GET /users/@me (the bot user), GET /applications/@me (the token's
 *   application, to confirm it matches the Application ID), GET /users/@me/guilds (servers the bot is in).
 * - Giveaway announcements (/resources/guild, /resources/channel, /resources/message): a server's channels and roles
 *   and the bot's own member (to compute its channel permissions), creating and editing the bot's own message (an
 *   embed with buttons).
 * - Moderation (/resources/guild, /resources/user, /resources/message): get a member, a user and a ban; time out or
 *   un-time-out a member (PATCH member communication_disabled_until; Moderate Members), ban / unban (PUT / DELETE
 *   /guilds/{id}/bans/{user}; Ban Members), delete a message (DELETE /channels/{id}/messages/{id}; Manage Messages).
 *   The reason goes in the X-Audit-Log-Reason header, so it appears in the server's audit log.
 * Errors never include credentials.
 */
import type { FetchLike } from '../app/types';

const API = 'https://discord.com/api/v10';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke';
const TIMEOUT_MS = 15_000;
/**
 * Discord's 429 says how long to wait. A short wait (typical for per-route limits during bulk work such as a lockdown)
 * is waited out and the request sent again, a couple of times; a longer one fails at once and the caller decides.
 */
const RATE_LIMIT_MAX_WAIT_MS = 5_000;
const RATE_LIMIT_RETRIES = 2;

export type DiscordApiErrorKind =
  | 'invalid_credentials'
  /** Discord refused the action (HTTP 403), e.g. the app may not create commands in that server. */
  | 'forbidden'
  /** The server (or application) does not exist for this bot (HTTP 404). */
  | 'not_found'
  | 'network'
  | 'rate_limited'
  /** Discord had an outage or internal error (HTTP 5xx). */
  | 'server_error'
  | 'unexpected_response';

export class DiscordApiError extends Error {
  constructor(
    readonly kind: DiscordApiErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
    /** Discord's JSON error code, when it sent one (e.g. 50001 Missing Access). */
    readonly discordCode?: number,
    /** Discord's own explanation, when it sent one (e.g. why it refused an AutoMod rule). */
    readonly discordMessage?: string,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

export interface BotIdentity {
  id: string;
  username: string;
  /** Avatar hash, null when the bot has none. */
  avatar: string | null;
}

const IMAGE_HASH = /^(a_)?[0-9a-f]{32}$/;
const imageHash = (v: unknown): string | null => (typeof v === 'string' && IMAGE_HASH.test(v) ? v : null);

export interface BotApplication {
  id: string;
  name: string;
  /** Application flags (bit field), e.g. which privileged gateway intents are enabled. */
  flags: number;
}

/** A slash command as Discord reports it. */
/** A server channel as Discord returns it (only the fields used for permissions and choosing a channel). */
export interface GuildChannel {
  id: string;
  name: string;
  /** 0 = text, 5 = announcement; other types can't hold a giveaway embed. */
  type: number;
  position: number;
  overwrites: Array<{ id: string; type: number; allow: bigint; deny: bigint }>;
}

export interface GuildRole {
  id: string;
  permissions: bigint;
  /** Hierarchy position (higher = more senior); 0 when Discord didn't say. */
  position?: number;
  name?: string;
  mentionable?: boolean;
  /** Managed by an integration (bot roles, boosts): can't be assigned or usefully mentioned. */
  managed?: boolean;
}

/** A message as read back from Discord (for the Embed Creator). */
export interface ChannelMessage {
  id: string;
  channelId: string;
  content: string;
  /** Discord's embed objects, as sent. */
  embeds: unknown[];
  /** Discord's component rows (buttons, menus), as sent. */
  components: unknown[];
  authorId: string;
  authorName: string;
  authorBot: boolean;
}

/** A message body the bot posts: embeds and button rows; mentions never ping. */
export interface MessageBody {
  content?: string;
  embeds: unknown[];
  components?: unknown[];
  /** Nobody is pinged, except roles listed here (a role chosen for stream notifications). */
  allowed_mentions: { parse: []; roles?: string[] };
}

const bits = (v: unknown): bigint => (typeof v === 'string' && /^\d{1,25}$/.test(v) ? BigInt(v) : 0n);

/** A server member as moderation needs it. */
export interface GuildMemberInfo {
  userId: string;
  username: string;
  globalName: string | null;
  nick: string | null;
  joinedAt: string | null;
  /** When the member's timeout ends (null: not timed out). */
  communicationDisabledUntil: string | null;
  roles: string[];
}

export interface DiscordUserInfo {
  userId: string;
  username: string;
  globalName: string | null;
}

const str = (v: unknown, max = 100): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

export interface RegisteredCommand {
  id: string;
  name: string;
  description: string;
}

/** Discord's error message and the first field error it lists (e.g. "keyword_filter[0]: Must be 60 or fewer in length."). */
function describeDiscordError(body: { message?: unknown; errors?: unknown } | null): string | undefined {
  if (!body) return undefined;
  const first = (node: unknown, path: string[]): string | null => {
    if (!node || typeof node !== 'object') return null;
    const errs = (node as { _errors?: Array<{ message?: unknown }> })._errors;
    if (Array.isArray(errs) && typeof errs[0]?.message === 'string') return `${path.join('.')}: ${errs[0].message}`;
    for (const [k, v] of Object.entries(node)) {
      if (k === '_errors') continue;
      const found = first(v, [...path, k]);
      if (found) return found;
    }
    return null;
  };
  const detail = first(body.errors, []);
  const message = typeof body.message === 'string' ? body.message : null;
  const text = [message, detail].filter(Boolean).join(' — ');
  return text ? text.slice(0, 300) : undefined;
}

function snowflake(id: string): string {
  if (!/^\d{1,25}$/.test(id)) throw new DiscordApiError('unexpected_response', 'Invalid Discord id');
  return id;
}

function parseCommands(body: unknown): RegisteredCommand[] {
  if (!Array.isArray(body)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected command list');
  return body
    .filter((c): c is RegisteredCommand => typeof c?.id === 'string' && typeof c?.name === 'string' && typeof c?.description === 'string')
    .map((c) => ({ id: c.id, name: c.name, description: c.description }));
}

/**
 * How long a 429 asks to wait, in ms: the body's retry_after (seconds, with fractions), else the Retry-After header;
 * null when neither says. Reads a copy, so the response can still be read for the error.
 */
async function retryAfterMs(res: Response): Promise<number | null> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { retry_after?: unknown } | null;
  if (typeof body?.retry_after === 'number' && Number.isFinite(body.retry_after)) return Math.max(0, Math.ceil(body.retry_after * 1000));
  const header = res.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

/** How long a deletion CONDUIT made is remembered (Discord reports it over the gateway within seconds). */
const OWN_DELETION_MS = 5 * 60_000;

export class DiscordApi {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly onRateLimited: (retryAfterSeconds: number | undefined) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Messages CONDUIT deleted for its own features (message id → when), so Discord Logging doesn't log them. */
  private readonly ownDeletions = new Map<string, number>();

  /**
   * onRateLimited: told when a request fails because Discord is rate limiting (the dashboard shows a pop-up alert);
   * short waits that are retried here don't count. sleep: how waits happen (tests use a fake clock).
   */
  constructor(o: {
    version: string;
    fetch?: FetchLike;
    onRateLimited?: (retryAfterSeconds: number | undefined) => void;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.onRateLimited = o.onRateLimited ?? (() => {});
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = `DiscordBot (https://github.com/vRetronix/CONDUIT, ${o.version}) CONDUIT`;
  }

  /** Checks an Application ID + Client Secret with Discord. Resolves on success; the test token is revoked. */
  async verifyClientCredentials(clientId: string, clientSecret: string): Promise<void> {
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: this.basic(clientId, clientSecret),
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }).toString(),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
    if (res.status === 401 || body?.error === 'invalid_client') throw new DiscordApiError('invalid_credentials', 'Discord rejected the Application ID / Client Secret pair');
    await this.throwForStatus(res, 'client credentials check');
    if (typeof body?.access_token !== 'string') throw new DiscordApiError('unexpected_response', 'Discord returned no token for the client credentials check');
    // Only a probe: revoke the bot-owner token straight away (best effort).
    await this.send(REVOKE_URL, {
      method: 'POST',
      headers: this.basic(clientId, clientSecret),
      body: new URLSearchParams({ token: body.access_token, token_type_hint: 'access_token' }).toString(),
    }).catch(() => undefined);
  }

  /**
   * Exchanges the code from the add-bot redirect, which completes the install when the application has "Requires
   * OAuth2 Code Grant" enabled. The resulting token (bot scope only, no user data) is not kept. It is deliberately not
   * revoked, so revoking can never undo the installation.
   */
  async completeInstallCodeGrant(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<void> {
    const res = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: this.basic(clientId, clientSecret),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) throw new DiscordApiError('invalid_credentials', 'Discord rejected the application credentials');
    if (!res.ok) throw new DiscordApiError('unexpected_response', `Install code exchange failed (HTTP ${res.status})`);
  }

  async botUser(token: string): Promise<BotIdentity> {
    const body = (await this.botGet(token, '/users/@me')) as { id?: unknown; username?: unknown; bot?: unknown; avatar?: unknown } | null;
    if (!body || typeof body.id !== 'string' || typeof body.username !== 'string' || body.bot !== true) {
      throw new DiscordApiError('unexpected_response', 'Discord did not identify this token as a bot');
    }
    return { id: body.id, username: body.username.slice(0, 100), avatar: imageHash(body.avatar) };
  }

  async botApplication(token: string): Promise<BotApplication> {
    const body = (await this.botGet(token, '/applications/@me')) as { id?: unknown; name?: unknown; flags?: unknown } | null;
    if (!body || typeof body.id !== 'string' || typeof body.name !== 'string') {
      throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected application');
    }
    return { id: body.id, name: body.name.slice(0, 100), flags: typeof body.flags === 'number' ? body.flags : 0 };
  }

  async botGuilds(token: string): Promise<Array<{ id: string; name: string; icon: string | null }>> {
    const body = await this.botGet(token, '/users/@me/guilds');
    if (!Array.isArray(body)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected server list');
    return body
      .filter((g): g is { id: string; name: string } => typeof g?.id === 'string' && /^\d{1,25}$/.test(g.id) && typeof g?.name === 'string')
      .map((g) => ({ id: g.id, name: g.name.slice(0, 100), icon: imageHash((g as { icon?: unknown }).icon) }));
  }

  /** The application's slash commands in one server (GET /applications/{id}/guilds/{guild}/commands). */
  async guildCommands(token: string, applicationId: string, guildId: string): Promise<RegisteredCommand[]> {
    const body = await this.botRequest(token, 'GET', `/applications/${snowflake(applicationId)}/guilds/${snowflake(guildId)}/commands`);
    return parseCommands(body);
  }

  /**
   * Replaces the application's slash commands in one server with exactly `commands` (bulk overwrite). Idempotent:
   * repeating it never creates duplicates. Returns the commands Discord confirmed.
   */
  async putGuildCommands(token: string, applicationId: string, guildId: string, commands: unknown[]): Promise<RegisteredCommand[]> {
    const body = await this.botRequest(token, 'PUT', `/applications/${snowflake(applicationId)}/guilds/${snowflake(guildId)}/commands`, commands);
    return parseCommands(body);
  }

  // ── giveaway announcements ──

  /** The server's channels (GET /guilds/{id}/channels). */
  async guildChannels(token: string, guildId: string): Promise<GuildChannel[]> {
    const body = await this.botGet(token, `/guilds/${snowflake(guildId)}/channels`);
    if (!Array.isArray(body)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected channel list');
    return body
      .filter((ch) => typeof ch?.id === 'string' && /^\d{1,25}$/.test(ch.id) && typeof ch?.type === 'number')
      .map((ch) => ({
        id: ch.id as string,
        name: typeof ch.name === 'string' ? ch.name.slice(0, 100) : ch.id,
        type: ch.type as number,
        position: typeof ch.position === 'number' ? ch.position : 0,
        overwrites: (Array.isArray(ch.permission_overwrites) ? ch.permission_overwrites : [])
          .filter((o: { id?: unknown }) => typeof o?.id === 'string')
          .map((o: { id: string; type?: unknown; allow?: unknown; deny?: unknown }) => ({
            id: o.id,
            type: typeof o.type === 'number' ? o.type : Number(o.type),
            allow: bits(o.allow),
            deny: bits(o.deny),
          })),
      }));
  }

  /** The server's roles (GET /guilds/{id}/roles). */
  async guildRoles(token: string, guildId: string): Promise<GuildRole[]> {
    const body = await this.botGet(token, `/guilds/${snowflake(guildId)}/roles`);
    if (!Array.isArray(body)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected role list');
    return body
      .filter((r) => typeof r?.id === 'string')
      .map((r) => ({
        id: r.id as string,
        permissions: bits(r.permissions),
        position: Number.isSafeInteger(r.position) ? (r.position as number) : 0,
        name: typeof r.name === 'string' ? r.name.slice(0, 100) : '',
        mentionable: r.mentionable === true,
        managed: r.managed === true,
      }));
  }

  /** The server's owner (GET /guilds/{id}): the one member Discord never lets anyone moderate. */
  async guildOwner(token: string, guildId: string): Promise<string> {
    const body = (await this.botGet(token, `/guilds/${snowflake(guildId)}`)) as { owner_id?: unknown } | null;
    if (typeof body?.owner_id !== 'string' || !/^\d{1,25}$/.test(body.owner_id)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected server');
    return body.owner_id;
  }

  /** The role ids of a member (GET /guilds/{id}/members/{user}); used for the bot's own member. */
  async guildMemberRoles(token: string, guildId: string, userId: string): Promise<string[]> {
    const body = (await this.botGet(token, `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}`)) as { roles?: unknown } | null;
    if (!body || !Array.isArray(body.roles)) throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected member');
    return body.roles.filter((r): r is string => typeof r === 'string');
  }

  /**
   * Gives a member a role (PUT /guilds/{id}/members/{user}/roles/{role}); adding a role they already have is a no-op on
   * Discord's side. Needs Manage Roles and a bot role above the role being given.
   */
  async addMemberRole(token: string, guildId: string, userId: string, roleId: string, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PUT', `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}/roles/${snowflake(roleId)}`, undefined, reason);
  }

  /** Takes a role from a member (DELETE /guilds/{id}/members/{user}/roles/{role}); needs Manage Roles, above the role. */
  async removeMemberRole(token: string, guildId: string, userId: string, roleId: string, reason: string | null): Promise<void> {
    await this.botRequest(token, 'DELETE', `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}/roles/${snowflake(roleId)}`, undefined, reason);
  }

  /** Posts a message (POST /channels/{id}/messages); returns its id. */
  async createMessage(token: string, channelId: string, message: MessageBody): Promise<string> {
    const body = (await this.botRequest(token, 'POST', `/channels/${snowflake(channelId)}/messages`, message)) as { id?: unknown } | null;
    if (typeof body?.id !== 'string' || !/^\d{1,25}$/.test(body.id)) throw new DiscordApiError('unexpected_response', 'Discord returned no message id');
    return body.id;
  }

  /** Edits the bot's own message (PATCH /channels/{id}/messages/{message}). */
  async editMessage(token: string, channelId: string, messageId: string, message: MessageBody): Promise<void> {
    await this.botRequest(token, 'PATCH', `/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}`, message);
  }

  /** One message as Discord stores it (GET /channels/{id}/messages/{message}; needs View Channel and Read Message History). */
  async channelMessage(token: string, channelId: string, messageId: string): Promise<ChannelMessage> {
    const body = (await this.botGet(token, `/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}`)) as Record<string, unknown> | null;
    const author = (body?.author ?? null) as { id?: unknown; username?: unknown; bot?: unknown } | null;
    if (typeof body?.id !== 'string' || typeof author?.id !== 'string') throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected message');
    return {
      id: body.id,
      channelId: typeof body.channel_id === 'string' ? body.channel_id : channelId,
      content: typeof body.content === 'string' ? body.content : '',
      embeds: Array.isArray(body.embeds) ? body.embeds : [],
      components: Array.isArray(body.components) ? body.components : [],
      authorId: author.id,
      authorName: typeof author.username === 'string' ? author.username.slice(0, 100) : 'someone',
      authorBot: author.bot === true,
    };
  }

  // ── moderation ──

  /** A server member (GET /guilds/{id}/members/{user}); null when the user isn't in the server (10007 Unknown Member). */
  async guildMember(token: string, guildId: string, userId: string): Promise<GuildMemberInfo | null> {
    let body: Record<string, unknown> | null;
    try {
      body = (await this.botGet(token, `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}`)) as Record<string, unknown> | null;
    } catch (err) {
      if (err instanceof DiscordApiError && err.kind === 'not_found' && err.discordCode === 10007) return null;
      throw err;
    }
    const user = body?.user as Record<string, unknown> | undefined;
    if (!user || typeof user.id !== 'string' || typeof user.username !== 'string')
      throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected member');
    return {
      userId: user.id,
      username: user.username.slice(0, 100),
      globalName: str(user.global_name),
      nick: str(body!.nick),
      joinedAt: str(body!.joined_at, 40),
      communicationDisabledUntil: str(body!.communication_disabled_until, 40),
      roles: Array.isArray(body!.roles) ? (body!.roles as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    };
  }

  /** A Discord user (GET /users/{id}); null when there's no such user. */
  async user(token: string, userId: string): Promise<DiscordUserInfo | null> {
    let body: Record<string, unknown> | null;
    try {
      body = (await this.botGet(token, `/users/${snowflake(userId)}`)) as Record<string, unknown> | null;
    } catch (err) {
      if (err instanceof DiscordApiError && err.kind === 'not_found') return null;
      throw err;
    }
    if (typeof body?.id !== 'string' || typeof body.username !== 'string') throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected user');
    return { userId: body.id, username: body.username.slice(0, 100), globalName: str(body.global_name) };
  }

  /** Whether the user is banned from the server (GET /guilds/{id}/bans/{user}; 10026 Unknown Ban = not banned). */
  async isBanned(token: string, guildId: string, userId: string): Promise<boolean> {
    try {
      await this.botGet(token, `/guilds/${snowflake(guildId)}/bans/${snowflake(userId)}`);
      return true;
    } catch (err) {
      if (err instanceof DiscordApiError && err.kind === 'not_found') return false;
      throw err;
    }
  }

  /** Times a member out until `until` (ISO), or removes the timeout (null). */
  async timeoutMember(token: string, guildId: string, userId: string, until: string | null, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PATCH', `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}`, { communication_disabled_until: until }, reason);
  }

  async banMember(token: string, guildId: string, userId: string, deleteMessageSeconds: number, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PUT', `/guilds/${snowflake(guildId)}/bans/${snowflake(userId)}`, { delete_message_seconds: deleteMessageSeconds }, reason);
  }

  /** The server's verification level, 0–4 (GET /guilds/{id}). */
  async guildVerificationLevel(token: string, guildId: string): Promise<number> {
    const body = (await this.botGet(token, `/guilds/${snowflake(guildId)}`)) as { verification_level?: unknown } | null;
    if (typeof body?.verification_level !== 'number') throw new DiscordApiError('unexpected_response', 'Discord returned an unexpected server');
    return body.verification_level;
  }

  /** Sets the server's verification level (PATCH /guilds/{id}; needs Manage Server). */
  async setGuildVerificationLevel(token: string, guildId: string, level: number, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PATCH', `/guilds/${snowflake(guildId)}`, { verification_level: level }, reason);
  }

  /** Sets a channel permission overwrite (PUT /channels/{id}/permissions/{overwrite}; type 0 = role, 1 = member). */
  async setChannelOverwrite(token: string, channelId: string, overwriteId: string, o: { type: number; allow: bigint; deny: bigint }, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PUT', `/channels/${snowflake(channelId)}/permissions/${snowflake(overwriteId)}`, { type: o.type, allow: o.allow.toString(), deny: o.deny.toString() }, reason);
  }

  /** Changes a channel's settings, e.g. slowmode (PATCH /channels/{id}; needs Manage Channels). */
  async modifyChannel(token: string, channelId: string, patch: { rate_limit_per_user?: number }, reason: string | null): Promise<void> {
    await this.botRequest(token, 'PATCH', `/channels/${snowflake(channelId)}`, patch, reason);
  }

  async deleteChannelOverwrite(token: string, channelId: string, overwriteId: string, reason: string | null): Promise<void> {
    await this.botRequest(token, 'DELETE', `/channels/${snowflake(channelId)}/permissions/${snowflake(overwriteId)}`, undefined, reason);
  }

  /** Removes a member from the server (DELETE /guilds/{id}/members/{user}; needs Kick Members). */
  async kickMember(token: string, guildId: string, userId: string, reason: string | null): Promise<void> {
    await this.botRequest(token, 'DELETE', `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}`, undefined, reason);
  }

  /** Replaces a member's roles (PATCH /guilds/{id}/members/{user}; needs Manage Roles, above every role changed). */
  async setMemberRoles(token: string, guildId: string, userId: string, roleIds: string[], reason: string | null): Promise<void> {
    await this.botRequest(token, 'PATCH', `/guilds/${snowflake(guildId)}/members/${snowflake(userId)}`, { roles: roleIds }, reason);
  }

  async unbanMember(token: string, guildId: string, userId: string, reason: string | null): Promise<void> {
    await this.botRequest(token, 'DELETE', `/guilds/${snowflake(guildId)}/bans/${snowflake(userId)}`, undefined, reason);
  }

  /**
   * Deletes a message. `ownFeature`: CONDUIT is tidying up after one of its own features (replacing a sticky or
   * notification, recreating or removing an Embed Creator message), which Discord Logging leaves out. It's noted before
   * the request, as Discord can report the deletion over the gateway before answering it.
   */
  async deleteMessage(token: string, channelId: string, messageId: string, reason: string | null, opts: { ownFeature?: boolean } = {}): Promise<void> {
    if (opts.ownFeature) {
      const now = Date.now();
      for (const [id, at] of this.ownDeletions) if (now - at > OWN_DELETION_MS) this.ownDeletions.delete(id);
      this.ownDeletions.set(messageId, now);
    }
    try {
      await this.botRequest(token, 'DELETE', `/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}`, undefined, reason);
    } catch (err) {
      this.ownDeletions.delete(messageId);
      throw err;
    }
  }

  /** Whether CONDUIT deleted this message for one of its own features (see deleteMessage). */
  deletedByOwnFeature(messageId: string): boolean {
    const at = this.ownDeletions.get(messageId);
    return at !== undefined && Date.now() - at <= OWN_DELETION_MS;
  }

  /** The id of a channel's newest message (GET /channels/{id}/messages?limit=1; needs Read Message History), or null. */
  async latestMessageId(token: string, channelId: string): Promise<string | null> {
    const body = await this.botGet(token, `/channels/${snowflake(channelId)}/messages?limit=1`);
    const first = Array.isArray(body) ? (body[0] as { id?: unknown } | undefined) : undefined;
    return typeof first?.id === 'string' ? first.id : null;
  }

  private botGet(token: string, path: string): Promise<unknown> {
    return this.botRequest(token, 'GET', path);
  }

  private async botRequest(
    token: string,
    method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    json?: unknown,
    auditReason?: string | null,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bot ${token}`, 'User-Agent': this.userAgent, Accept: 'application/json' };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    // Shown in the server's audit log; Discord expects it URL-encoded.
    if (auditReason) headers['X-Audit-Log-Reason'] = encodeURIComponent(auditReason.slice(0, 400));
    const init: RequestInit = { method, headers, body: json === undefined ? undefined : JSON.stringify(json) };
    let res = await this.send(`${API}${path}`, init);
    for (let retry = 0; res.status === 429 && retry < RATE_LIMIT_RETRIES; retry++) {
      const waitMs = await retryAfterMs(res);
      if (waitMs === null || waitMs > RATE_LIMIT_MAX_WAIT_MS) break;
      await res.body?.cancel().catch(() => undefined);
      await this.sleep(waitMs);
      res = await this.send(`${API}${path}`, init);
    }
    if (res.status === 401) throw new DiscordApiError('invalid_credentials', 'Discord rejected the bot token');
    await this.throwForStatus(res, `${method} ${path.replace(/\d{15,25}/g, ':id').replace(/\?.*$/, '')}`);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  private async throwForStatus(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { retry_after?: unknown; code?: unknown; message?: unknown; errors?: unknown } | null;
    const discordCode = typeof body?.code === 'number' ? body.code : undefined;
    const discordMessage = describeDiscordError(body);
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retry = Number.isFinite(header) && res.headers.get('retry-after') !== null ? header : typeof body?.retry_after === 'number' ? body.retry_after : NaN;
      const seconds = Number.isFinite(retry) ? Math.max(1, Math.ceil(retry)) : undefined;
      this.onRateLimited(seconds);
      throw new DiscordApiError('rate_limited', 'Discord is rate limiting requests', seconds);
    }
    if (res.status === 403) throw new DiscordApiError('forbidden', `Discord refused ${what} (HTTP 403)`, undefined, discordCode);
    if (res.status === 404) throw new DiscordApiError('not_found', `Discord could not find ${what} (HTTP 404)`, undefined, discordCode, discordMessage);
    if (res.status >= 500) throw new DiscordApiError('server_error', `Discord had a problem with ${what} (HTTP ${res.status})`);
    throw new DiscordApiError('unexpected_response', `Discord ${what} failed (HTTP ${res.status})`, undefined, discordCode, discordMessage);
  }

  private basic(clientId: string, clientSecret: string): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new DiscordApiError('network', 'Discord could not be reached');
    }
  }
}
