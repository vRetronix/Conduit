/**
 * A simulated Discord for automated tests: implements the documented OAuth2 token/revoke endpoints (authorization
 * code, refresh and client credentials grants), GET /users/@me (user and bot), GET /applications/@me,
 * GET /users/@me/guilds and the avatar CDN, tracking which codes and tokens are valid. No real network access.
 */
import type { FetchLike } from '../../apps/server/src/app/types';

export const CLIENT_ID = '123456789012345678';
export const CLIENT_SECRET = 'test-discord-client-secret-value';
export const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** The only avatar hash the fake CDN serves; any other hash 404s. */
export const KNOWN_AVATAR = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** A bot token of the documented shape (three dot-separated parts). Test value only. */
export const BOT_TOKEN = `${'MTIzNDU2Nzg5MDEyMzQ1Njc4'}.${'GhIjKl'}.${'botTokenSecretPart_0123456789abcdefghij'}`;

export interface FakeUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export class FakeDiscord {
  user: FakeUser = { id: '80351110224678912', username: 'retro_live', global_name: 'Retro Live', avatar: KNOWN_AVATAR };
  /** Codes Discord would accept, mapped to the redirect URI they were issued for. */
  readonly validCodes = new Map<string, string>();
  readonly validAccessTokens = new Set<string>();
  readonly validRefreshTokens = new Set<string>();
  readonly requests: RecordedRequest[] = [];
  revoked = 0;
  /** Simulates Discord being unreachable. */
  offline = false;
  /** Scope string Discord reports as granted. */
  grantedScope = 'identify';
  expiresIn = 604800;
  /** The bot behind BOT_TOKEN, its application and the servers it is in. */
  botUser = { id: '223456789012345678', username: 'RetroBot', bot: true };
  botApplication = { id: CLIENT_ID, name: 'Retro Bot', flags: 0 };
  botGuilds: Array<{ id: string; name: string }> = [];
  validBotToken = BOT_TOKEN;
  /** The application's OAuth2 credentials Discord accepts. */
  clientId = CLIENT_ID;
  clientSecret = CLIENT_SECRET;
  /** Extra CDN images by path (e.g. /avatars/{bot id}/{hash}.png, /icons/{server id}/{hash}.png). */
  readonly cdn = new Map<string, Buffer>();
  /** Simulates Discord rate limiting every request. */
  rateLimited = false;
  /** The next bot requests are answered 429, one per entry, asking to wait that many seconds (a per-route limit). */
  readonly rateLimitNext: number[] = [];
  /** Slash commands per server, as registered through the guild commands endpoints. */
  readonly guildCommands = new Map<string, Array<{ id: string; name: string; description: string }>>();
  commandPuts = 0;
  commandGets = 0;
  /** Servers where the app may not create commands (403, code 50001 Missing Access). */
  readonly noCommandAccess = new Set<string>();
  /** One-shot failures for the next guild-command requests: HTTP status, optional retry_after seconds. */
  readonly commandFailures: Array<{ status: number; retryAfter?: number }> = [];
  // ── giveaway announcements: channels, roles, the bot's member, messages and reactions ──
  /** Per server: its channels (Discord's shape, with permission_overwrites). */
  readonly channels = new Map<string, Array<{ id: string; name: string; type: number; position: number; permission_overwrites: Array<{ id: string; type: number; allow: string; deny: string }>; parent_id?: string; topic?: string; rate_limit_per_user?: number }>>();
  /** Per server: roles; the @everyone role has the server's id. */
  readonly roles = new Map<string, Array<{ id: string; permissions: string; position?: number; name?: string; mentionable?: boolean }>>();
  /** Per server: the owner's user id (GET /guilds/{id}). */
  readonly owners = new Map<string, string>();
  /** Per server: the bot member's role ids. */
  readonly botMemberRoles = new Map<string, string[]>();
  /** Posted messages by id, with their reactions (emoji → users). */
  readonly messages = new Map<string, { channelId: string; body: any; edits: number; reactions: Map<string, Array<{ id: string; username: string; bot: boolean }>> }>();
  /** One-shot failures for the next message/reaction write: HTTP status and Discord error code. */
  readonly messageFailures: Array<{ status: number; code: number }> = [];
  private messageCounter = 1_300_000_000_000_000_000n;
  /** Newest message per channel (the bot's posts and simulated posts by people), for GET …/messages?limit=1. */
  readonly channelLatest = new Map<string, string>();

  /** Someone posts in a channel (the newest message there becomes theirs). Returns the new message id. */
  userPosts(channelId: string): string {
    const id = String(++this.messageCounter);
    this.channelLatest.set(channelId, id);
    return id;
  }
  // ── moderation: members, users, bans; permissions come from the bot's roles (Discord's algorithm, server level) ──
  /** Per server: members other than the bot. `above` = their highest role is above the bot's (Discord refuses: 50013). */
  readonly members = new Map<string, Map<string, { user: { id: string; username: string; global_name: string | null }; nick: string | null; joined_at: string; communication_disabled_until: string | null; roles: string[]; above?: boolean }>>();
  /** Users Discord knows (GET /users/{id}). */
  readonly users = new Map<string, { id: string; username: string; global_name: string | null }>();
  readonly bans = new Map<string, Set<string>>();
  readonly deletedMessages: string[] = [];
  /** Messages not sent by the bot (by people or other bots), by id: for reading them. */
  readonly foreignMessages = new Map<string, { channelId: string; content: string; embeds: unknown[]; components?: unknown[]; author: { id: string; username: string; bot?: boolean } }>();

  /** Someone else's message in a channel (a person or another bot). Returns its id. */
  foreignPost(channelId: string, m: { content?: string; embeds?: unknown[]; components?: unknown[]; author?: { id: string; username: string; bot?: boolean } }): string {
    const id = this.userPosts(channelId);
    this.foreignMessages.set(id, { channelId, content: m.content ?? '', embeds: m.embeds ?? [], components: m.components, author: m.author ?? { id: '900000000000000099', username: 'someone' } });
    return id;
  }

  /** Per server: the verification level (GET/PATCH /guilds/{id}); 1 when not set. */
  readonly verificationLevels = new Map<string, number>();
  /** Members removed with a kick, in order. */
  readonly kicked: string[] = [];

  /** Adds a member (and the user) to a server. */
  addMember(guildId: string, user: { id: string; username: string; global_name?: string | null }, o: { nick?: string; above?: boolean; roles?: string[] } = {}): void {
    const u = { id: user.id, username: user.username, global_name: user.global_name ?? null };
    this.users.set(u.id, u);
    const list = this.members.get(guildId) ?? new Map();
    list.set(u.id, { user: u, nick: o.nick ?? null, joined_at: '2026-01-02T03:04:05.000000+00:00', communication_disabled_until: null, roles: o.roles ?? [], above: o.above });
    this.members.set(guildId, list);
  }

  /** A role with a hierarchy position (higher = more senior) and no permissions of its own. */
  addRole(guildId: string, id: string, position: number, o: { name?: string; mentionable?: boolean } = {}): void {
    const roles = (this.roles.get(guildId) ?? []).filter((r) => r.id !== id);
    roles.push({ id, permissions: '0', position, ...o });
    this.roles.set(guildId, roles);
  }

  /** Roles given to members (PUT /guilds/{id}/members/{user}/roles/{role}), in order. */
  readonly roleAdds: Array<{ guildId: string; userId: string; roleId: string; reason: string | null }> = [];
  /** Roles taken from members (DELETE …/roles/{role}), in order. */
  readonly roleRemoves: Array<{ guildId: string; userId: string; roleId: string; reason: string | null }> = [];
  /** Members who left: giving them a role fails with 10007 Unknown Member. */
  readonly departed = new Set<string>();

  /** Moves the bot's own role (from grantBot) to a hierarchy position. */
  setBotRolePosition(guildId: string, position: number): void {
    const roleId = `9${guildId.slice(1)}`;
    const role = this.roles.get(guildId)?.find((r) => r.id === roleId);
    if (role) role.position = position;
  }

  private memberRoleEndpoint(method: string, path: string, reason: string | null): Response | null {
    const m = /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/.exec(path);
    if (!m || (method !== 'PUT' && method !== 'DELETE')) return null;
    const [, guildId, userId, roleId] = m as unknown as [string, string, string, string];
    if (!this.botGuilds.some((g) => g.id === guildId)) return json(404, { message: 'Unknown Guild', code: 10004 });
    const roles = this.roles.get(guildId) ?? [];
    const role = roles.find((r) => r.id === roleId);
    if (!role) return json(404, { message: 'Unknown Role', code: 10011 });
    if (this.departed.has(userId)) return json(404, { message: 'Unknown Member', code: 10007 });
    const top = Math.max(0, ...(this.botMemberRoles.get(guildId) ?? []).map((id) => roles.find((r) => r.id === id)?.position ?? 0));
    if ((this.botPerms(guildId) & (1n << 28n)) !== 1n << 28n || (role.position ?? 0) >= top) return json(403, { message: 'Missing Permissions', code: 50013 });
    const member = this.members.get(guildId)?.get(userId);
    if (method === 'DELETE') {
      this.roleRemoves.push({ guildId, userId, roleId, reason });
      if (member) member.roles = member.roles.filter((r) => r !== roleId);
      return new Response(null, { status: 204 });
    }
    this.roleAdds.push({ guildId, userId, roleId, reason });
    if (member && !member.roles.includes(roleId)) member.roles.push(roleId);
    return new Response(null, { status: 204 });
  }

  /** Gives the bot a role with these permissions in a server. */
  grantBot(guildId: string, permissions: bigint): void {
    const roleId = `9${guildId.slice(1)}`;
    const roles = (this.roles.get(guildId) ?? []).filter((r) => r.id !== roleId);
    roles.push({ id: roleId, permissions: permissions.toString() });
    this.roles.set(guildId, roles);
    this.botMemberRoles.set(guildId, [...new Set([...(this.botMemberRoles.get(guildId) ?? []), roleId])]);
  }

  private botPerms(guildId: string): bigint {
    const roles = new Map((this.roles.get(guildId) ?? []).map((r) => [r.id, BigInt(r.permissions)]));
    let p = roles.get(guildId) ?? 0n;
    for (const id of this.botMemberRoles.get(guildId) ?? []) p |= roles.get(id) ?? 0n;
    return (p & 8n) === 8n ? ~0n : p;
  }

  private moderationEndpoint(method: string, path: string, body: string): Response | null {
    const denied = (bit: bigint, guildId: string) => (this.botPerms(guildId) & bit) !== bit;
    let m = /^\/api\/v10\/guilds\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      const g = this.botGuilds.find((x) => x.id === m![1]);
      if (!g) return json(404, { message: 'Unknown Guild', code: 10004 });
      return json(200, { id: g.id, name: g.name, owner_id: this.owners.get(g.id) ?? '100000000000000001', verification_level: this.verificationLevels.get(g.id) ?? 1 });
    }
    if (m && method === 'PATCH') {
      if (!this.botGuilds.some((x) => x.id === m![1])) return json(404, { message: 'Unknown Guild', code: 10004 });
      if (denied(1n << 5n, m[1]!)) return json(403, { message: 'Missing Permissions', code: 50013 });
      const patch = JSON.parse(body) as { verification_level?: number };
      if (typeof patch.verification_level === 'number') this.verificationLevels.set(m[1]!, patch.verification_level);
      return json(200, { id: m[1] });
    }
    m = /^\/api\/v10\/channels\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const guildId = this.channelGuild(m[1]!);
      if (!guildId) return json(404, { message: 'Unknown Channel', code: 10003 });
      if (denied(1n << 4n, guildId)) return json(403, { message: 'Missing Permissions', code: 50013 });
      const ch = this.channels.get(guildId)!.find((c) => c.id === m![1])!;
      Object.assign(ch, JSON.parse(body) as object);
      return json(200, ch);
    }
    m = /^\/api\/v10\/channels\/(\d+)\/permissions\/(\d+)$/.exec(path);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      const guildId = this.channelGuild(m[1]!);
      if (!guildId) return json(404, { message: 'Unknown Channel', code: 10003 });
      if (denied(1n << 28n, guildId)) return json(403, { message: 'Missing Permissions', code: 50013 });
      const ch = this.channels.get(guildId)!.find((c) => c.id === m![1])!;
      const rest = ch.permission_overwrites.filter((o) => o.id !== m![2]);
      if (method === 'DELETE') {
        if (rest.length === ch.permission_overwrites.length) return json(404, { message: 'Unknown Overwrite', code: 10009 });
        ch.permission_overwrites = rest;
        return new Response(null, { status: 204 });
      }
      const o = JSON.parse(body) as { type: number; allow: string; deny: string };
      ch.permission_overwrites = [...rest, { id: m[2]!, type: o.type, allow: o.allow, deny: o.deny }];
      return new Response(null, { status: 204 });
    }
    m = /^\/api\/v10\/users\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      const u = this.users.get(m[1]!);
      return u ? json(200, { ...u, discriminator: '0', avatar: null }) : json(404, { message: 'Unknown User', code: 10013 });
    }
    m = /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
    if (m && m[2] !== this.botUser.id && (method === 'GET' || method === 'PATCH' || method === 'DELETE')) {
      if (!this.botGuilds.some((g) => g.id === m![1])) return json(404, { message: 'Unknown Guild', code: 10004 });
      const member = this.members.get(m[1]!)?.get(m[2]!);
      if (!member) return json(404, { message: 'Unknown Member', code: 10007 });
      if (method === 'GET') {
        const { above: _above, ...rest } = member;
        return json(200, rest);
      }
      if (method === 'DELETE') {
        // Kick: needs Kick Members and a role above theirs.
        if (denied(1n << 1n, m[1]!) || member.above) return json(403, { message: 'Missing Permissions', code: 50013 });
        this.members.get(m[1]!)!.delete(m[2]!);
        this.kicked.push(m[2]!);
        return new Response(null, { status: 204 });
      }
      const patch = JSON.parse(body) as { communication_disabled_until?: string | null; roles?: string[] };
      if (patch.roles !== undefined) {
        // Roles: needs Manage Roles, and every role added or removed must be below the bot's highest role.
        const roles = this.roles.get(m[1]!) ?? [];
        const top = Math.max(0, ...(this.botMemberRoles.get(m[1]!) ?? []).map((id) => roles.find((r) => r.id === id)?.position ?? 0));
        const changed = [...patch.roles.filter((r) => !member.roles.includes(r)), ...member.roles.filter((r) => !patch.roles!.includes(r))];
        if (denied(1n << 28n, m[1]!) || member.above || changed.some((id) => (roles.find((r) => r.id === id)?.position ?? 0) >= top))
          return json(403, { message: 'Missing Permissions', code: 50013 });
        member.roles = [...patch.roles];
        return json(200, member);
      }
      if (denied(1n << 40n, m[1]!) || member.above) return json(403, { message: 'Missing Permissions', code: 50013 });
      member.communication_disabled_until = patch.communication_disabled_until ?? null;
      return json(200, member);
    }
    m = /^\/api\/v10\/guilds\/(\d+)\/bans\/(\d+)$/.exec(path);
    if (m) {
      if (!this.botGuilds.some((g) => g.id === m![1])) return json(404, { message: 'Unknown Guild', code: 10004 });
      if (denied(1n << 2n, m[1]!)) return json(403, { message: 'Missing Permissions', code: 50013 });
      const bans = this.bans.get(m[1]!) ?? new Set<string>();
      this.bans.set(m[1]!, bans);
      if (method === 'GET') return bans.has(m[2]!) ? json(200, { user: this.users.get(m[2]!), reason: null }) : json(404, { message: 'Unknown Ban', code: 10026 });
      if (method === 'PUT') {
        if (!this.users.has(m[2]!)) return json(404, { message: 'Unknown User', code: 10013 });
        if (this.members.get(m[1]!)?.get(m[2]!)?.above) return json(403, { message: 'Missing Permissions', code: 50013 });
        bans.add(m[2]!);
        this.members.get(m[1]!)?.delete(m[2]!);
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE') {
        if (!bans.delete(m[2]!)) return json(404, { message: 'Unknown Ban', code: 10026 });
        return new Response(null, { status: 204 });
      }
    }
    m = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (m && method === 'DELETE') {
      const guildId = this.channelGuild(m[1]!);
      if (!guildId) return json(404, { message: 'Unknown Channel', code: 10003 });
      if (this.deletedMessages.includes(m[2]!)) return json(404, { message: 'Unknown Message', code: 10008 });
      // The bot may always delete its own messages; others' need Manage Messages.
      if (!this.messages.has(m[2]!) && denied(1n << 13n, guildId)) return json(403, { message: 'Missing Permissions', code: 50013 });
      this.messages.delete(m[2]!);
      this.foreignMessages.delete(m[2]!);
      this.deletedMessages.push(m[2]!);
      if (this.channelLatest.get(m[1]!) === m[2]) this.channelLatest.delete(m[1]!);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  /** A server with one text channel the bot can fully use (via @everyone), and optionally more channels. */
  addServerWithChannels(guildId: string, channels: Array<{ id: string; name: string; deny?: bigint }>): void {
    this.roles.set(guildId, [{ id: guildId, permissions: (85056n | 1n << 11n).toString() }]);
    this.botMemberRoles.set(guildId, []);
    this.channels.set(
      guildId,
      channels.map((ch, i) => ({
        id: ch.id,
        name: ch.name,
        type: 0,
        position: i,
        permission_overwrites: ch.deny ? [{ id: guildId, type: 0, allow: '0', deny: ch.deny.toString() }] : [],
      })),
    );
  }

  /** Someone reacts in Discord (also recorded for GET .../reactions). */
  addReaction(messageId: string, user: { id: string; username: string; bot?: boolean }, emoji = '🎉'): void {
    const m = this.messages.get(messageId);
    if (!m) return;
    const list = m.reactions.get(emoji) ?? [];
    if (!list.some((u) => u.id === user.id)) list.push({ id: user.id, username: user.username, bot: user.bot ?? false });
    m.reactions.set(emoji, list);
  }

  removeReaction(messageId: string, userId: string, emoji = '🎉'): void {
    const m = this.messages.get(messageId);
    if (m) m.reactions.set(emoji, (m.reactions.get(emoji) ?? []).filter((u) => u.id !== userId));
  }

  private channelGuild(channelId: string): string | undefined {
    for (const [guildId, list] of this.channels) if (list.some((c) => c.id === channelId)) return guildId;
    return undefined;
  }

  private announcementEndpoint(method: string, path: string, query: URLSearchParams, body: string): Response | null {
    let m = /^\/api\/v10\/guilds\/(\d+)\/(channels|roles)$/.exec(path);
    if (m && method === 'GET') {
      if (!this.botGuilds.some((g) => g.id === m![1])) return json(404, { message: 'Unknown Guild', code: 10004 });
      return json(200, (m[2] === 'channels' ? this.channels : this.roles).get(m[1]!) ?? []);
    }
    m = /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      if (!this.botGuilds.some((g) => g.id === m![1])) return json(404, { message: 'Unknown Guild', code: 10004 });
      return json(200, { roles: this.botMemberRoles.get(m[1]!) ?? [], user: { id: m[2] } });
    }
    m = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(path);
    if (m && method === 'POST') {
      if (!this.channelGuild(m[1]!)) return json(404, { message: 'Unknown Channel', code: 10003 });
      const failure = this.messageFailures.shift();
      if (failure) return json(failure.status, { message: 'Simulated failure', code: failure.code });
      const id = String(++this.messageCounter);
      this.messages.set(id, { channelId: m[1]!, body: JSON.parse(body), edits: 0, reactions: new Map() });
      this.channelLatest.set(m[1]!, id);
      return json(200, { id, channel_id: m[1] });
    }
    if (m && method === 'GET') {
      const guildId = this.channelGuild(m[1]!);
      if (!guildId) return json(404, { message: 'Unknown Channel', code: 10003 });
      if ((this.botPerms(guildId) & (1n << 16n)) !== 1n << 16n) return json(403, { message: 'Missing Access', code: 50001 });
      const latest = this.channelLatest.get(m[1]!);
      return json(200, latest ? [{ id: latest, channel_id: m[1] }] : []);
    }
    m = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      if (!this.channelGuild(m[1]!)) return json(404, { message: 'Unknown Channel', code: 10003 });
      const own = this.messages.get(m[2]!);
      if (own && own.channelId === m[1])
        return json(200, { id: m[2], channel_id: m[1], content: own.body.content ?? '', embeds: own.body.embeds ?? [], components: own.body.components ?? [], author: { id: this.botUser.id, username: this.botUser.username, bot: true } });
      const other = this.foreignMessages.get(m[2]!);
      if (!other || other.channelId !== m[1]) return json(404, { message: 'Unknown Message', code: 10008 });
      return json(200, { id: m[2], channel_id: m[1], content: other.content, embeds: other.embeds, components: other.components ?? [], author: other.author });
    }
    if (m && method === 'PATCH') {
      const msg = this.messages.get(m[2]!);
      if (!this.channelGuild(m[1]!)) return json(404, { message: 'Unknown Channel', code: 10003 });
      if (!msg || msg.channelId !== m[1]) return json(404, { message: 'Unknown Message', code: 10008 });
      const failure = this.messageFailures.shift();
      if (failure) return json(failure.status, { message: 'Simulated failure', code: failure.code });
      msg.body = JSON.parse(body);
      msg.edits++;
      return json(200, { id: m[2] });
    }
    m = /^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)(\/@me)?$/.exec(path);
    if (m) {
      const msg = this.messages.get(m[2]!);
      if (!msg || msg.channelId !== m[1]) return json(404, { message: 'Unknown Message', code: 10008 });
      const emoji = decodeURIComponent(m[3]!);
      if (method === 'PUT' && m[4]) {
        const failure = this.messageFailures.shift();
        if (failure) return json(failure.status, { message: 'Simulated failure', code: failure.code });
        this.addReaction(m[2]!, { id: this.botUser.id, username: this.botUser.username, bot: true }, emoji);
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && !m[4]) {
        const after = BigInt(query.get('after') ?? '0');
        const limit = Number(query.get('limit') ?? '25');
        const users = [...(msg.reactions.get(emoji) ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).filter((u) => BigInt(u.id) > after);
        return json(200, users.slice(0, limit).map((u) => ({ id: u.id, username: u.username, global_name: null, bot: u.bot })));
      }
    }
    return null;
  }

  /** Simulates Discord confirming a registration without some command (a response that must not count). */
  dropFromConfirmation: string | null = null;
  private counter = 0;

  issueCode(redirectUri: string): string {
    const code = `code-${++this.counter}-abcdef`;
    this.validCodes.set(code, redirectUri);
    return code;
  }

  private issueTokens(): Response {
    const access = `access-token-${++this.counter}-SECRET`;
    const refresh = `refresh-token-${this.counter}-SECRET`;
    this.validAccessTokens.add(access);
    this.validRefreshTokens.add(refresh);
    return json(200, { access_token: access, token_type: 'Bearer', expires_in: this.expiresIn, refresh_token: refresh, scope: this.grantedScope });
  }

  private commandsEndpoint(method: string, applicationId: string, guildId: string, body: string): Response {
    const failure = this.commandFailures.shift();
    if (failure) {
      if (failure.status === 429) {
        return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: failure.retryAfter ?? 1, global: false }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      return json(failure.status, { message: 'Simulated failure', code: 0 });
    }
    if (applicationId !== this.botApplication.id) return json(403, { message: 'Missing Access', code: 50001 });
    if (!this.botGuilds.some((g) => g.id === guildId)) return json(404, { message: 'Unknown Guild', code: 10004 });
    if (this.noCommandAccess.has(guildId)) return json(403, { message: 'Missing Access', code: 50001 });
    if (method === 'GET') {
      this.commandGets++;
      return json(200, this.guildCommands.get(guildId) ?? []);
    }
    if (method === 'PUT') {
      this.commandPuts++;
      const defs = JSON.parse(body) as Array<{ name: string; description: string }>;
      if (!Array.isArray(defs) || defs.some((d) => typeof d.name !== 'string' || typeof d.description !== 'string')) return json(400, { message: 'Invalid Form Body', code: 50035 });
      // Bulk overwrite: exactly these commands afterwards, never duplicates.
      const stored = defs.map((d, i) => ({ id: `9${guildId.slice(-6)}${i}`, name: d.name, description: d.description, application_id: applicationId, guild_id: guildId }));
      this.guildCommands.set(guildId, stored);
      return json(200, stored.filter((c) => c.name !== this.dropFromConfirmation));
    }
    return json(405, { message: 'Method Not Allowed' });
  }

  /** Revokes everything, as when the user removes CONDUIT under Discord's Authorized Apps. */
  revokeAllExternally(): void {
    this.validAccessTokens.clear();
    this.validRefreshTokens.clear();
  }

  fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : '';
    this.requests.push({ url: input, method: init.method ?? 'GET', headers, body });
    if (this.offline) throw new TypeError('fetch failed');
    if (this.rateLimited) return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2 }), { status: 429, headers: { 'retry-after': '2' } });

    const botAuth = headers.authorization?.startsWith('Bot ') ? headers.authorization.slice(4) : null;
    const wait = botAuth !== null ? this.rateLimitNext.shift() : undefined;
    if (wait !== undefined) {
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: wait, global: false }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(Math.ceil(wait)) },
      });
    }
    if (botAuth !== null) {
      if (botAuth !== this.validBotToken) return json(401, { message: '401: Unauthorized', code: 0 });
      if (url.href === 'https://discord.com/api/v10/users/@me') return json(200, { avatar: null, ...this.botUser, discriminator: '0' });
      if (url.href === 'https://discord.com/api/v10/applications/@me') return json(200, { ...this.botApplication, bot_public: true });
      if (url.href === 'https://discord.com/api/v10/users/@me/guilds') return json(200, this.botGuilds.map((g) => ({ ...g, icon: null, owner: false, permissions: '0' })));
      const commands = /^\/api\/v10\/applications\/(\d+)\/guilds\/(\d+)\/commands$/.exec(url.pathname);
      if (commands) return this.commandsEndpoint(init.method ?? 'GET', commands[1]!, commands[2]!, body);
      const auditReason = headers['x-audit-log-reason'];
      const roleGrant = this.memberRoleEndpoint(init.method ?? 'GET', url.pathname, auditReason ? decodeURIComponent(auditReason) : null);
      if (roleGrant) return roleGrant;
      const moderation = this.moderationEndpoint(init.method ?? 'GET', url.pathname, body);
      if (moderation) return moderation;
      const announcement = this.announcementEndpoint(init.method ?? 'GET', url.pathname, url.searchParams, body);
      if (announcement) return announcement;
      return json(404, { message: 'Not Found' });
    }

    const basicOk = headers.authorization === `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    const form = new URLSearchParams(body);

    if (url.href === 'https://discord.com/api/oauth2/token') {
      if (!basicOk) return json(401, { error: 'invalid_client' });
      if (headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request' });
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const issuedFor = this.validCodes.get(code);
        this.validCodes.delete(code); // codes are single-use
        if (!issuedFor || issuedFor !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        return this.issueTokens();
      }
      if (form.get('grant_type') === 'client_credentials') {
        // Bot-owner token for the application (documented client credentials grant).
        const access = `client-credentials-${++this.counter}-SECRET`;
        return json(200, { access_token: access, token_type: 'Bearer', expires_in: 604800, scope: form.get('scope') ?? '' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!this.validRefreshTokens.delete(token)) return json(400, { error: 'invalid_grant' });
        return this.issueTokens();
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    if (url.href === 'https://discord.com/api/oauth2/token/revoke') {
      if (!basicOk) return json(401, { error: 'invalid_client' });
      this.revoked++;
      this.revokeAllExternally();
      return json(200, {});
    }

    if (url.href === 'https://discord.com/api/v10/users/@me') {
      const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!this.validAccessTokens.has(token)) return json(401, { message: '401: Unauthorized', code: 0 });
      return json(200, { ...this.user, discriminator: '0', email: 'must-not-be-requested@example.com' });
    }

    if (url.origin === 'https://cdn.discordapp.com' && url.pathname === `/avatars/${this.user.id}/${KNOWN_AVATAR}.png`) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url.origin === 'https://cdn.discordapp.com' && this.cdn.has(url.pathname)) {
      return new Response(this.cdn.get(url.pathname)!, { status: 200, headers: { 'content-type': 'image/png' } });
    }

    return json(404, { message: 'Not Found' });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
