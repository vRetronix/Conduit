/**
 * A simulated Discord gateway for the bot runner: no network. Tests decide whether login succeeds, which servers
 * the bot is in, and can emit gateway events (disconnects, server joins).
 */
import type { BotClient, BotClientEvent, BotClientFactory, GatewayPresenceData, GuildEvent, IncomingButton, PrivilegedIntents } from '../../apps/server/src/discord/discord-bot';
import type { CommandReply, IncomingCommand } from '../../apps/server/src/discord/commands/types';
import { BOT_TOKEN, CLIENT_ID } from './fake-discord';

/** A slash-command interaction plus what CONDUIT answered through Discord's interaction callback API. */
export interface FakeInteraction extends IncomingCommand {
  replies: CommandReply[];
  deferred: boolean;
  edits: CommandReply[];
}

let interactionCounter = 0;

/** A button click plus the answers sent through Discord's interaction callback (buttons always answer privately). */
export interface FakeButton extends IncomingButton {
  replies: Array<{ content: string; ephemeral: boolean }>;
}

export function fakeInteraction(overrides: Partial<IncomingCommand> = {}): FakeInteraction {
  const i: FakeInteraction = {
    id: `7000000000000${String(++interactionCounter).padStart(5, '0')}`,
    applicationId: CLIENT_ID,
    commandName: 'ping',
    guildId: '42',
    userId: '555555555555555555',
    userName: 'retrofan',
    channelName: 'general',
    memberPermissions: 0n,
    options: [],
    replies: [],
    deferred: false,
    edits: [],
    reply: async (r) => {
      if (i.replies.length > 0 || i.deferred) throw new Error('Interaction has already been acknowledged.');
      i.replies.push(r);
    },
    defer: async () => {
      i.deferred = true;
    },
    editReply: async (r) => {
      i.edits.push(r);
    },
    ...overrides,
  };
  return i;
}

export type LoginOutcome = 'ok' | 'invalid_token' | 'disallowed_intents' | 'network' | 'hang';

export class FakeGateway {
  validToken = BOT_TOKEN;
  outcome: LoginOutcome = 'ok';
  guilds: Array<{ id: string; name: string; icon?: string | null; memberCount?: number | null }> = [];
  user: { id: string; username: string; avatar?: string | null } = { id: '223456789012345678', username: 'RetroBot', avatar: null };
  logins = 0;
  destroyed = 0;
  readonly clients: FakeClient[] = [];

  /** Privileged intents each connection asked for, in order. */
  readonly intentRequests: PrivilegedIntents[] = [];
  /** Presence updates sent by any client, in order; set failPresence to make the session refuse them. */
  readonly presences: GatewayPresenceData[] = [];
  failPresence = false;

  /** Refuse privileged intents (as Discord does when they're off on the Developer Portal). */
  refusePrivileged = false;

  factory: BotClientFactory = (privileged) => {
    this.intentRequests.push(privileged);
    const client = new FakeClient(this, privileged);
    this.clients.push(client);
    return client;
  };

  /** Live (not destroyed) clients: more than one would be a duplicate connection. */
  get live(): FakeClient[] {
    return this.clients.filter((c) => c.loggedIn && !c.destroyed);
  }

  /** Delivers a slash command to a client (default: the live one) and waits for CONDUIT to answer. */
  async interact(overrides: Partial<IncomingCommand> = {}, client: FakeClient | undefined = this.live[0]): Promise<FakeInteraction> {
    if (!client) throw new Error('no live gateway client');
    const i = fakeInteraction(overrides);
    client.emit('interaction', i);
    for (let n = 0; n < 50 && i.replies.length === 0 && i.edits.length === 0; n++) await new Promise((r) => setTimeout(r, 5));
    return i;
  }

  /**
   * A click on a message button, delivered as a component interaction on the live session. Resolves once answered
   * (or after a short wait). Replies are recorded with their visibility (always ephemeral for buttons).
   */
  async click(
    customId: string,
    r: { userId: string; messageId: string | null; channelId?: string | null; guildId?: string | null; userName?: string; applicationId?: string; id?: string; userHasAvatar?: boolean; values?: string[] },
    client: FakeClient | undefined = this.live[0],
  ): Promise<FakeButton> {
    if (!client) throw new Error('no live gateway client');
    const b: FakeButton = {
      id: r.id ?? `8000000000000${String(++interactionCounter).padStart(5, '0')}`,
      applicationId: r.applicationId ?? CLIENT_ID,
      customId,
      guildId: r.guildId === undefined ? '42' : r.guildId,
      channelId: r.channelId === undefined ? '500000000000000001' : r.channelId,
      messageId: r.messageId,
      userId: r.userId,
      userName: r.userName ?? `user${r.userId.slice(-4)}`,
      userHasAvatar: r.userHasAvatar ?? true,
      ...(r.values ? { values: r.values } : {}),
      replies: [],
      reply: async (content) => {
        if (b.replies.length > 0) throw new Error('Interaction has already been acknowledged.');
        b.replies.push({ content, ephemeral: true });
      },
    };
    client.emit('button', b);
    for (let n = 0; n < 50 && b.replies.length === 0; n++) await new Promise((res) => setTimeout(res, 5));
    return b;
  }

  /** A server event on the live session (messages, members, channels, roles, audit log). */
  event(e: GuildEvent): void {
    for (const c of this.live) c.emit('guildEvent', e);
  }

  /** The bot is added to (or removed from) a server: the live session hears about it. */
  setGuilds(guilds: Array<{ id: string; name: string; icon?: string | null }>): void {
    this.guilds = guilds;
    for (const c of this.live) c.emit('guildsChanged');
  }
}

export class FakeClient implements BotClient {
  loggedIn = false;
  destroyed = false;
  private readonly handlers = new Map<BotClientEvent, Array<(d?: unknown) => void>>();

  constructor(
    private readonly gw: FakeGateway,
    readonly privileged: PrivilegedIntents = { members: false, messageContent: false, presences: false },
  ) {}

  async login(token: string): Promise<unknown> {
    this.gw.logins++;
    const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
    if (this.gw.outcome === 'network') return fail('ECONNRESET');
    if (this.gw.outcome === 'hang') return new Promise(() => {});
    if (token !== this.gw.validToken || this.gw.outcome === 'invalid_token') return fail('TokenInvalid');
    if (this.gw.outcome === 'disallowed_intents') return fail('DisallowedIntents');
    if (this.gw.refusePrivileged && (this.privileged.members || this.privileged.messageContent)) return fail('DisallowedIntents');
    this.loggedIn = true;
    queueMicrotask(() => this.emit('ready'));
    return token;
  }

  async destroy(): Promise<void> {
    if (!this.destroyed) this.gw.destroyed++;
    this.destroyed = true;
  }

  userInfo() {
    return this.loggedIn ? this.gw.user : null;
  }

  setPresence(p: GatewayPresenceData): void {
    if (!this.loggedIn || this.destroyed) throw new Error('The bot session isn’t ready.');
    if (this.gw.failPresence) throw new Error('Shard is not ready.');
    this.gw.presences.push(p);
  }

  guilds() {
    return this.gw.guilds;
  }

  on(event: BotClientEvent, listener: (d?: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }

  emit(event: BotClientEvent, detail?: unknown): void {
    if (!this.destroyed) this.handlers.get(event)?.forEach((h) => h(detail));
  }

  /** Delivers an event even after destroy(), like a late event from a closing connection. */
  emitLate(event: BotClientEvent, detail?: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(detail));
  }

  listenerCount(event: BotClientEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}
