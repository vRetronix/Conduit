/**
 * Moderation: manual actions on Discord and Kick, the history of actions taken through CONDUIT, and automated
 * protection for Kick chat.
 *
 * Every action uses the connected account's own platform permissions and the platform's official API:
 * - Discord, with the bot token. What the bot may do is read from its roles in each server (Discord's permission
 *   algorithm, server level); Discord still has the final say (role hierarchy, channel overwrites), and its refusal is
 *   reported as a failure.
 * - Kick, with the main account's token (the channel owner), scopes moderation:ban and moderation:chat_message:manage.
 * Nothing is reported as done until the platform confirms it. Each attempt (success or failure) is recorded in
 * moderation_actions; validation errors, disconnected platforms and missing permissions stop before anything is sent.
 *
 * Automated protection (Kick only): blocked words/phrases, repeated messages and message flooding, each with its own
 * action (log only, delete the message, or time out). It's off by default and every rule starts as "log only". Each
 * chat event is checked once (by message id), the channel owner, the chatbot account, moderators (optional) and
 * CONDUIT's own messages are never acted on, and actions run one at a time through a bounded queue.
 */
import crypto from 'node:crypto';
import {
  discordLogEntriesRepo,
  discordModerationEventsRepo,
  discordProtectionEventsRepo,
  discordRepo,
  kickChattersRepo,
  moderationRepo,
  SETTING_KEYS,
  settingsRepo,
  type Database,
  type DiscordLogEntryRecord,
  type DiscordModerationEventRecord,
  type DiscordProtectionEventRecord,
  type ModerationRecord,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  AUTOMOD_ACTIONS,
  AUTOMOD_DEFAULTS,
  automodMatcher,
  automodSettingsSchema,
  disallowedLinks,
  kickTextCheck,
  userHistorySchema,
  DISCORD_PERMISSION_BITS,
  MODERATION_ACTIONS,
  moderationActionSchema,
  moderationLookupSchema,
  parseDiscordMessageLink,
  parseDiscordUser,
  type AutomodAction,
  type AutomodMatcher,
  type AutomodRecordRule,
  type AutomodRule,
  type AutomodSettings,
  type AutomodState,
  type ModerationAction,
  type ModerationActionKind,
  type ModerationCapability,
  type ModerationLookupResult,
  type ModerationRecordView,
  type ModerationState,
  type DiscordModerationState,
  type KickModerationState,
  type LoyaltyLogEntry,
  type ModerationUserHistory,
  type RaidState,
  type DiscordServerModerationView,
  type DiscordLogEntryView,
  type ProtectionEventView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { DiscordApiError, type DiscordApi, type GuildRole } from '../discord/discord-api';
import type { GuildEvent } from '../discord/discord-bot';
import type { DiscordCredentials } from '../discord/discord-credentials';
import { KickApiError } from '../kick/kick-chat-api';
import { parseInput } from '../validation';
import { channelPermissions } from '../discord/discord-giveaways';
import type { KickBanEvent, KickChatMessage, KickChatService } from '../kick/kick-chat-service';

const { KICK_MEMBERS, BAN_MEMBERS, MANAGE_MESSAGES, MODERATE_MEMBERS } = DISCORD_PERMISSION_BITS;
const GUILD_CACHE_MS = 60_000;
const HISTORY_LIMIT = 100;
/** Discord Logging entries shown in the Moderation log (messages and members are busier than moderation). */
const LOG_ENTRY_LIMIT = 200;
/** Message ids remembered so a re-delivered chat event is checked once. */
const SEEN_LIMIT = 2000;
/** Users tracked for repeat/flood detection at once (oldest forgotten first). */
const TRACKED_USERS = 5000;
/** At most this many automated actions wait at once; beyond that, new ones are logged and skipped. */
const MAX_PENDING_ACTIONS = 20;
/** The same rule doesn't act on (or log) the same user again within this window. */
const RULE_COOLDOWN_MS = 30_000;
/** A ban Kick reports within this long after CONDUIT's own ban or timeout of that user is CONDUIT's echo. */
const ECHO_WINDOW_MS = 2 * 60_000;
const USER_HISTORY_LIMIT = 300;
/** When CONDUIT started remembering who chats on Kick (raid mode learns the regulars first). */
const CHATTERS_SINCE_KEY = 'kick.chatters.since';
/** Raid mode starts working once CONDUIT has seen chat this long, and this many different chatters. */
const RAID_LEARNING_MS = 2 * 60 * 60_000;
const RAID_LEARNING_CHATTERS = 25;

/** What a check (or raid mode) matched, and what to do. */
interface KickMatch {
  rule: AutomodRecordRule;
  action: AutomodAction;
  timeoutMinutes: number;
  detail: string;
}

/** The settings key of each check. */
const RULE_KEY = {
  blocked_terms: 'blockedTerms',
  links: 'links',
  caps: 'caps',
  emotes: 'emotes',
  symbols: 'symbols',
  long_message: 'longMessage',
  repeat: 'repeat',
  spam: 'spam',
} as const satisfies Record<AutomodRule, keyof AutomodSettings>;
const KICK_CHECK_KEYS = Object.values(RULE_KEY);

export const KICK_SCOPES = { ban: 'moderation:ban', chat: 'moderation:chat_message:manage' } as const;

/**
 * An action's outcome. `message` is for the dashboard and logs (operator wording); `botMessage` is what the bot says in
 * Discord, in the first person, built from the same outcome — success wording only when the platform confirmed it.
 */
export type ModerationResult = { ok: boolean; message: string; botMessage?: string; record: ModerationRecordView };

export interface ModerationServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  discordApi: DiscordApi;
  discordCredentials: DiscordCredentials;
  /** The bot's display name (live or verified). */
  discordBotName: () => string | null;
  /** Loyalty & Rewards history for the Moderation log (none while it isn't set up). */
  loyaltyLog?: () => Promise<LoyaltyLogEntry[]>;
  kick: Pick<
    KickChatService,
    | 'moderator'
    | 'moderationBan'
    | 'moderationUnban'
    | 'moderationDeleteMessage'
    | 'channelBySlug'
    | 'onMessage'
    | 'onBan'
    | 'banEvents'
    | 'sendResult'
    | 'state'
    | 'chatbotIdentity'
    | 'wasRecentlySent'
  >;
}

interface GuildAccess {
  id: string;
  name: string;
  perms: bigint | null;
  problem: string | null;
}

const ok = (): ModerationCapability => ({ available: true, problem: null });
const no = (problem: string): ModerationCapability => ({ available: false, problem });

export class ModerationService {
  private guildCache: { at: number; guilds: GuildAccess[]; problem: string | null } | null = null;
  private readonly seen = new Set<string>();
  private readonly recentByUser = new Map<string, number[]>();
  private readonly repeatsByUser = new Map<string, { text: string; times: number[] }>();
  private readonly lastActed = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private stats = { checked: 0, matched: 0, since: '' };
  private termMatcher: { key: string; matcher: AutomodMatcher } = { key: '', matcher: automodMatcher({ keywords: [], regexPatterns: [], allowList: [] }) };
  private unsubscribe: (() => void) | null = null;
  private unsubscribeBans: (() => void) | null = null;
  private readonly seenBans = new Set<string>();
  /** Raid mode is on until then (ms; 0: off). */
  private raidUntil = 0;
  /** When recent first-time chatters were first seen (raid detection). */
  private firstTimers: number[] = [];
  /** First-time chatters who count as newcomers during raid mode, and when they were first seen. */
  private readonly raidNewcomers = new Map<string, number>();
  private readonly actionListeners = new Set<(r: ModerationRecordView) => void>();

  /** Every recorded moderation action (after it is saved): Discord commands, automated protection. */
  onAction(listener: (r: ModerationRecordView) => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  constructor(private readonly o: ModerationServiceOptions) {
    this.stats.since = o.now().toISOString();
  }

  /** Starts automated protection (listens to Kick chat). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.o.kick.onMessage((m) => this.onKickMessage(m));
    this.unsubscribeBans = this.o.kick.onBan((b) => this.onKickBan(b));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeBans?.();
    this.unsubscribeBans = null;
  }

  /** Waits for queued automated actions (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  // ── state ──────────────────────────────────────────────────────────────────

  /** The Kick Moderation page: recent chat, automated protection and Kick logs. */
  kickState(): KickModerationState {
    const me = this.o.kick.moderator();
    const chat = this.o.kick.state();
    return {
      connected: me !== null,
      problem: me ? null : 'Connect your main Kick account (Dashboard → Kick) to monitor and protect Kick chat.',
      accountName: me?.name ?? null,
      channel: me?.channel ?? null,
      chat: { status: chat.receive.status, problem: chat.receive.problem },
      automod: this.automodState(),
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT, 'kick').map(toView),
    };
  }

  /** The Discord Bot page: automated protection (what's possible) and the moderation logs (CONDUIT's and the server's). */
  async discordModerationState(): Promise<DiscordModerationState> {
    const discord = await this.discordState();
    const names = new Map(discord.guilds.map((g) => [g.id, g.name]));
    // The bot's permissions per server, as just read by discordState().
    const access = discord.connected ? (this.guildCache?.guilds ?? []) : [];
    return {
      ...discord,
      commands: DISCORD_MODERATION_COMMANDS.map((c) => ({
        name: c.name,
        permission: c.permission,
        missingIn: access.filter((g) => g.perms === null || !has(g.perms, c.bit)).map((g) => g.id),
      })),
      automod: this.automodState().discord,
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT, 'discord').map(toView),
      serverHistory: discordModerationEventsRepo.list(this.o.db, HISTORY_LIMIT).map((r) => serverView(r, names)),
      loggingHistory: discordLogEntriesRepo.list(this.o.db, LOG_ENTRY_LIMIT).map((r) => loggingView(r, names)),
      loyaltyHistory: (await this.o.loyaltyLog?.().catch(() => [])) ?? [],
      protectionHistory: discordProtectionEventsRepo.list(this.o.db, HISTORY_LIMIT).map((r) => protectionView(r, names)),
    };
  }

  /**
   * A moderation entry from a server's audit log (a ban, kick or timeout done in Discord or by another bot, or an AutoMod
   * action): kept for Discord Bot → Logs. CONDUIT's own actions (by its bot) are already recorded with the member who ran
   * the command, so they're skipped here.
   */
  recordDiscordAudit(e: Extract<GuildEvent, { type: 'audit' }>): void {
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (e.executor && botUserId && e.executor.id === botUserId) return;
    const automod = e.action.startsWith('automod_');
    try {
      discordModerationEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        entryId: e.entryId,
        createdAt: this.o.now().toISOString(),
        guildId: e.guildId,
        action: e.action,
        targetUserId: e.target?.id ?? e.targetId,
        targetName: e.target?.tag ?? null,
        executorId: automod ? null : (e.executor?.id ?? null),
        executorName: automod ? null : (e.executor?.tag ?? null),
        executorBot: !automod && (e.executor?.bot ?? false),
        reason: e.reason,
        ruleName: e.ruleName ?? null,
        channelId: e.channelId ?? null,
        until: e.until,
      });
    } catch (err) {
      this.o.logger.warn('could not record a discord audit entry', { err });
    }
  }

  async state(): Promise<ModerationState> {
    const [discord] = await Promise.all([this.discordState()]);
    const me = this.o.kick.moderator();
    return {
      discord,
      kick: {
        connected: me !== null,
        problem: me ? null : 'Connect your main Kick account (Dashboard → Kick) to moderate Kick chat.',
        accountName: me?.name ?? null,
        channel: me?.channel ?? null,
        capabilities: this.kickCapabilities(),
      },
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT).map(toView),
      automod: this.automodState(),
    };
  }

  private async discordState(): Promise<ModerationState['discord']> {
    const token = await this.o.discordCredentials.botToken();
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (!token || !botUserId)
      return { connected: false, problem: 'Set up your Discord bot first (Dashboard → Discord → Connect).', botName: null, guilds: [] };
    const access = await this.guildAccess(token, botUserId);
    return {
      connected: true,
      problem: access.problem,
      botName: this.o.discordBotName(),
      guilds: access.guilds.map((g) => ({ id: g.id, name: g.name, capabilities: discordCapabilities(g), problem: g.problem })),
    };
  }

  private async guildAccess(token: string, botUserId: string, force = false): Promise<{ guilds: GuildAccess[]; problem: string | null }> {
    const nowMs = this.o.now().getTime();
    if (!force && this.guildCache && nowMs - this.guildCache.at < GUILD_CACHE_MS) return this.guildCache;
    let list: Array<{ id: string; name: string }>;
    try {
      list = await this.o.discordApi.botGuilds(token);
    } catch (err) {
      return { guilds: [], problem: describeDiscord(err) };
    }
    const guilds: GuildAccess[] = [];
    for (const g of list.slice(0, 25)) {
      try {
        const [roles, memberRoleIds] = await Promise.all([
          this.o.discordApi.guildRoles(token, g.id),
          this.o.discordApi.guildMemberRoles(token, g.id, botUserId),
        ]);
        guilds.push({ id: g.id, name: g.name, perms: channelPermissions({ guildId: g.id, userId: botUserId, roles, memberRoleIds, overwrites: [] }), problem: null });
      } catch (err) {
        guilds.push({ id: g.id, name: g.name, perms: null, problem: describeDiscord(err) });
      }
    }
    const result = { at: nowMs, guilds, problem: list.length === 0 ? 'The bot isn’t in any server yet. Add it to your server first.' : null };
    this.guildCache = result;
    return result;
  }

  private kickCapabilities(): Record<ModerationActionKind | 'lookup', ModerationCapability> {
    const me = this.o.kick.moderator();
    const out = {} as Record<ModerationActionKind | 'lookup', ModerationCapability>;
    if (!me) {
      const missing = no('Connect your main Kick account first.');
      for (const a of [...MODERATION_ACTIONS, 'lookup'] as const) out[a] = missing;
      return out;
    }
    const reauth = (scope: string) =>
      no(`Your main Kick account hasn’t granted “${scope}”. Select Reauthorize main account (Dashboard → Kick → Manage).`);
    const ban = me.scopes.includes(KICK_SCOPES.ban) ? ok() : reauth(KICK_SCOPES.ban);
    out.timeout = ban;
    out.ban = ban;
    out.unban = ban;
    out.untimeout = no('Kick has no separate “remove timeout”: use Unban, which also ends a timeout.');
    out.delete_message = me.scopes.includes(KICK_SCOPES.chat) ? ok() : reauth(KICK_SCOPES.chat);
    out.lookup = me.scopes.includes('channel:read') ? ok() : reauth('channel:read');
    return out;
  }

  // ── lookup ─────────────────────────────────────────────────────────────────

  async lookup(raw: unknown): Promise<ModerationLookupResult> {
    const input = parseInput(moderationLookupSchema, raw);
    if (input.platform === 'kick') {
      const cap = this.kickCapabilities().lookup;
      if (!cap.available) throw new AppError('not_configured', cap.problem!);
      let channel: { broadcasterUserId: string; slug: string } | null;
      try {
        channel = await this.o.kick.channelBySlug(input.username.toLowerCase());
      } catch (err) {
        throw new AppError('service_unavailable', describeKick(err));
      }
      if (!channel) throw new AppError('not_found', `No Kick user named “${input.username}”.`);
      return { platform: 'kick', userId: channel.broadcasterUserId, username: channel.slug, displayName: null, inServer: null, joinedAt: null, timedOutUntil: null, roleCount: null, banned: null };
    }
    const userId = parseDiscordUser(input.user);
    if (!userId) throw invalid('user', 'Enter a Discord user ID (15–25 digits) or @mention. Turn on Developer Mode in Discord, then right-click the user → Copy User ID.');
    const { token, guild } = await this.discordGuild(input.guildId);
    try {
      const member = await this.o.discordApi.guildMember(token, guild.id, userId);
      if (member) {
        return {
          platform: 'discord',
          userId,
          username: member.username,
          displayName: member.nick ?? member.globalName,
          inServer: true,
          joinedAt: member.joinedAt,
          timedOutUntil: member.communicationDisabledUntil && Date.parse(member.communicationDisabledUntil) > this.o.now().getTime() ? member.communicationDisabledUntil : null,
          roleCount: member.roles.length,
          banned: false,
        };
      }
      const user = await this.o.discordApi.user(token, userId);
      if (!user) throw new AppError('not_found', 'No Discord user has that ID.');
      const banned = guild.perms !== null && has(guild.perms, BAN_MEMBERS) ? await this.o.discordApi.isBanned(token, guild.id, userId) : null;
      return { platform: 'discord', userId, username: user.username, displayName: user.globalName, inServer: false, joinedAt: null, timedOutUntil: null, roleCount: null, banned };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('service_unavailable', describeDiscord(err));
    }
  }

  // ── manual actions ─────────────────────────────────────────────────────────

  /** Performs one action. Resolves with the platform's outcome (recorded either way); throws before sending if it can't be attempted. */
  async act(raw: unknown): Promise<ModerationResult> {
    const a = parseInput(moderationActionSchema, raw);
    return a.platform === 'discord' ? this.actDiscord(a) : this.actKick(a, 'manual', null);
  }

  private async actDiscord(
    a: Extract<ModerationAction, { platform: 'discord' }>,
    via?: { actor: string; resolved: ResolvedGuild },
  ): Promise<ModerationResult> {
    const link = a.action === 'delete_message' ? parseDiscordMessageLink(a.messageLink)! : null;
    const guildId = a.action === 'delete_message' ? link!.guildId : a.guildId;
    const { token, guild, botUserId } = via?.resolved ?? (await this.discordGuild(guildId));
    const targetUserId = a.action === 'delete_message' ? 'unknown' : a.userId;
    if (targetUserId === botUserId) throw invalid('userId', 'The bot can’t moderate itself.');
    const cap = discordCapabilities(guild)[a.action];
    if (!cap.available) throw new AppError('forbidden', cap.problem!);
    const actor = via?.actor ?? this.o.discordBotName() ?? 'Discord bot';
    let targetName: string | null = null;
    if (!link) {
      // A name for the history (best effort; the action itself is decided by Discord).
      targetName = await this.o.discordApi
        .guildMember(token, guild.id, targetUserId)
        .then((m) => m?.nick ?? m?.globalName ?? m?.username ?? null)
        .catch(() => null);
      // Not a member (e.g. banned): their Discord name, so replies and logs still say who it was.
      if (!targetName) {
        targetName = await this.o.discordApi
          .user(token, targetUserId)
          .then((u) => u?.globalName ?? u?.username ?? null)
          .catch(() => null);
      }
    }
    const base = {
      platform: 'discord' as const,
      placeId: guild.id,
      placeName: guild.name,
      action: a.action,
      targetUserId,
      targetName,
      messageId: link?.messageId ?? null,
      durationSeconds: a.action === 'timeout' ? a.durationSeconds : null,
      reason: a.reason,
      source: 'manual' as const,
      actor,
      rule: null,
    };
    try {
      switch (a.action) {
        case 'timeout':
          await this.o.discordApi.timeoutMember(token, guild.id, a.userId, new Date(this.o.now().getTime() + a.durationSeconds * 1000).toISOString(), a.reason);
          break;
        case 'untimeout':
          await this.o.discordApi.timeoutMember(token, guild.id, a.userId, null, a.reason);
          break;
        case 'ban':
          await this.o.discordApi.banMember(token, guild.id, a.userId, a.deleteMessageSeconds, a.reason);
          break;
        case 'unban':
          await this.o.discordApi.unbanMember(token, guild.id, a.userId, a.reason);
          break;
        case 'delete_message':
          await this.o.discordApi.deleteMessage(token, link!.channelId, link!.messageId, a.reason);
          break;
      }
    } catch (err) {
      return this.finish(base, false, describeDiscord(err, a.action), botFailureText(err, a.action, targetName ?? 'that user'));
    }
    return this.finish(base, true, successText('discord', a.action, targetName ?? targetUserId, guild.name, base.durationSeconds), botSuccessText(a.action, targetName ?? 'that user', base.durationSeconds));
  }

  private async actKick(
    a: Extract<ModerationAction, { platform: 'kick' }>,
    source: 'manual' | 'automod',
    rule: AutomodRecordRule | null,
    actor?: string,
  ): Promise<ModerationResult> {
    const me = this.o.kick.moderator();
    if (!me) throw new AppError('not_configured', 'Connect your main Kick account first (Dashboard → Kick).');
    if (a.userId === me.userId) throw invalid('userId', 'You can’t moderate your own channel account.');
    const cap = this.kickCapabilities()[a.action];
    if (!cap.available) throw new AppError('forbidden', cap.problem!);
    const base = {
      platform: 'kick' as const,
      placeId: me.userId,
      placeName: me.channel,
      action: a.action,
      targetUserId: a.userId,
      targetName: a.username,
      messageId: a.action === 'delete_message' ? a.messageId : null,
      durationSeconds: a.action === 'timeout' ? a.durationSeconds : null,
      reason: a.reason,
      source,
      actor: actor ?? me.name,
      rule,
    };
    try {
      switch (a.action) {
        case 'timeout':
          await this.o.kick.moderationBan(a.userId, Math.round(a.durationSeconds / 60), a.reason);
          break;
        case 'ban':
          await this.o.kick.moderationBan(a.userId, null, a.reason);
          break;
        case 'unban':
          await this.o.kick.moderationUnban(a.userId);
          break;
        case 'delete_message':
          await this.o.kick.moderationDeleteMessage(a.messageId);
          break;
      }
    } catch (err) {
      return this.finish(base, false, describeKick(err, a.action));
    }
    return this.finish(base, true, successText('kick', a.action, a.username, me.channel, base.durationSeconds));
  }

  private finish(base: Omit<ModerationRecord, 'id' | 'createdAt' | 'outcome' | 'detail'>, success: boolean, message: string, botMessage?: string): ModerationResult {
    const record: ModerationRecord = {
      ...base,
      id: crypto.randomUUID(),
      createdAt: this.o.now().toISOString(),
      outcome: success ? 'success' : 'failed',
      detail: success ? null : message,
    };
    this.save(record);
    return { ok: success, message, ...(botMessage ? { botMessage } : {}), record: toView(record) };
  }

  private save(record: ModerationRecord): void {
    try {
      moderationRepo.insert(this.o.db, record);
      writeAudit(
        this.o.db,
        {
          action: 'moderation.action',
          outcome: record.outcome === 'failed' ? 'failure' : 'success',
          actorUserId: null,
          metadata: { platform: record.platform, action: record.action, source: record.source, rule: record.rule },
        },
        this.o.now(),
      );
    } catch (err) {
      this.o.logger.error('moderation record failed', { err });
    }
    this.o.logger.info('moderation action', { platform: record.platform, action: record.action, source: record.source, outcome: record.outcome });
    const view = toView(record);
    for (const listener of this.actionListeners) {
      try {
        listener(view);
      } catch (err) {
        this.o.logger.error('moderation listener failed', { err });
      }
    }
  }

  /** One server, read fresh: the bot must be in it; its permissions there come from its roles. */
  private async discordGuild(guildId: string): Promise<ResolvedGuild> {
    const token = await this.o.discordCredentials.botToken();
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (!token || !botUserId) throw new AppError('not_configured', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    let list: Array<{ id: string; name: string }>;
    try {
      list = await this.o.discordApi.botGuilds(token);
    } catch (err) {
      throw new AppError('service_unavailable', describeDiscord(err));
    }
    const found = list.find((g) => g.id === guildId);
    if (!found) throw new AppError('not_found', 'The bot isn’t in that Discord server.');
    try {
      const [roles, memberRoleIds] = await Promise.all([
        this.o.discordApi.guildRoles(token, guildId),
        this.o.discordApi.guildMemberRoles(token, guildId, botUserId),
      ]);
      const perms = channelPermissions({ guildId, userId: botUserId, roles, memberRoleIds, overwrites: [] });
      return { token, botUserId, roles, guild: { id: found.id, name: found.name, perms, problem: null } };
    } catch (err) {
      throw new AppError('service_unavailable', describeDiscord(err));
    }
  }

  // ── Discord moderation commands (/timeout, /untimeout, /ban, /unban) ───────

  /**
   * Runs a moderation command used in Discord. Discord has already checked that the member has the command's
   * permission (default_member_permissions) and the dispatcher re-checked it; here CONDUIT also applies Discord's role
   * hierarchy to the member who ran it — the bot must not let a moderator act on someone ranked at or above them —
   * then performs the action through the same path as every other action, so it is recorded the same way.
   * Never throws for expected refusals: the answer is the message to show (privately) in Discord.
   */
  async runDiscordCommand(r: DiscordCommandRequest): Promise<{ ok: boolean; message: string }> {
    if (r.action === 'kick') return this.runDiscordKick(r);
    const parsed = moderationActionSchema.safeParse({
      platform: 'discord',
      action: r.action,
      guildId: r.guildId,
      userId: r.userId,
      ...(r.action === 'timeout' ? { durationSeconds: r.durationSeconds } : {}),
      ...(r.action === 'ban' ? { deleteMessageSeconds: r.deleteMessageSeconds ?? 0 } : {}),
      reason: r.reason ?? '',
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those options aren’t valid.' };
    const a = parsed.data as Extract<ModerationAction, { platform: 'discord' }>;
    try {
      if (r.userId === r.invokerId) return { ok: false, message: 'You can’t use this on yourself.' };
      let resolved: ResolvedGuild;
      try {
        resolved = await this.discordGuild(r.guildId);
      } catch (err) {
        if (err instanceof AppError) return { ok: false, message: 'I couldn’t check my permissions in this server right now. Please try again in a moment.' };
        throw err;
      }
      if (r.userId === resolved.botUserId) return { ok: false, message: 'I can’t moderate myself.' };
      const cap = discordCapabilities(resolved.guild)[a.action];
      if (!cap.available) {
        const permission = a.action === 'ban' || a.action === 'unban' ? 'Ban Members' : 'Timeout Members';
        return { ok: false, message: `I can’t do that because I don’t have the “${permission}” permission here. Ask an admin to give my role that permission.` };
      }
      if (a.action !== 'unban') {
        const refusal = await this.hierarchyRefusal(resolved, r.invokerId, r.userId);
        if (refusal) return { ok: false, message: refusal };
      }
      const result = await this.actDiscord(a, { actor: `${r.invokerName.slice(0, 60)} via /${r.command}`, resolved });
      return { ok: result.ok, message: result.botMessage ?? result.message };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /**
   * /kick: removes a member from the server (they can rejoin with an invite). The same checks as the other commands
   * (the bot's Kick Members permission, Discord's role hierarchy for the member who ran it). Discord records it in the
   * server's audit log, which Discord Logging and the Discord moderation log read, so it isn't stored twice here.
   */
  private async runDiscordKick(r: DiscordCommandRequest): Promise<{ ok: boolean; message: string }> {
    if (r.userId === r.invokerId) return { ok: false, message: 'You can’t use this on yourself.' };
    let resolved: ResolvedGuild;
    try {
      resolved = await this.discordGuild(r.guildId);
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: 'I couldn’t check my permissions in this server right now. Please try again in a moment.' };
      throw err;
    }
    if (r.userId === resolved.botUserId) return { ok: false, message: 'I can’t moderate myself.' };
    if (resolved.guild.perms === null || !has(resolved.guild.perms, KICK_MEMBERS))
      return { ok: false, message: 'I can’t do that because I don’t have the “Kick Members” permission here. Ask an admin to give my role that permission.' };
    try {
      const refusal = await this.hierarchyRefusal(resolved, r.invokerId, r.userId);
      if (refusal) return { ok: false, message: refusal };
      const member = await this.o.discordApi.guildMember(resolved.token, resolved.guild.id, r.userId);
      if (!member) return { ok: false, message: 'That user isn’t in this server.' };
      const who = member.nick ?? member.globalName ?? member.username;
      const reason = `${r.invokerName.slice(0, 60)} via /kick${r.reason ? `: ${r.reason}` : ''}`;
      await this.o.discordApi.kickMember(resolved.token, resolved.guild.id, r.userId, reason);
      return { ok: true, message: `I’ve kicked ${who}.` };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      return { ok: false, message: `I couldn’t kick them because Discord denied the request: ${describeDiscord(err)}` };
    }
  }

  /**
   * A moderator's chat command on Kick (!timeout, !ban, !unban): looks the user up by name, then acts with the main
   * account like a manual action (recorded in the moderation history as "<moderator> via !command"). The message is
   * short, for chat; a refusal is never reported as done.
   */
  async runKickCommand(r: { actorName: string; command: string; action: 'timeout' | 'ban' | 'unban'; username: string; durationSeconds?: number; reason: string | null }): Promise<{ ok: boolean; message: string }> {
    const me = this.o.kick.moderator();
    if (!me) return { ok: false, message: 'The channel’s Kick account isn’t connected to CONDUIT.' };
    const cap = this.kickCapabilities()[r.action];
    if (!cap.available) return { ok: false, message: 'I can’t do that yet: reauthorize the main Kick account in CONDUIT (Dashboard → Kick → Manage).' };
    const username = r.username.replace(/^@+/, '');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) return { ok: false, message: 'That isn’t a Kick username.' };
    let channel: { broadcasterUserId: string; slug: string } | null;
    try {
      channel = await this.o.kick.channelBySlug(username.toLowerCase());
    } catch {
      return { ok: false, message: 'I couldn’t look that user up on Kick right now. Try again in a moment.' };
    }
    if (!channel) return { ok: false, message: `There’s no Kick user named ${username}.` };
    if (channel.broadcasterUserId === me.userId) return { ok: false, message: 'The channel owner can’t be moderated.' };
    const parsed = moderationActionSchema.safeParse({
      platform: 'kick',
      action: r.action,
      userId: channel.broadcasterUserId,
      username: channel.slug,
      ...(r.action === 'timeout' ? { durationSeconds: r.durationSeconds } : {}),
      reason: r.reason ?? '',
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those options aren’t valid.' };
    try {
      const result = await this.actKick(parsed.data as Extract<ModerationAction, { platform: 'kick' }>, 'manual', null, `${r.actorName.slice(0, 60)} via ${r.command}`);
      if (!result.ok) return { ok: false, message: `Kick didn’t ${r.action} ${channel.slug}.` };
      const minutes = Math.round((r.durationSeconds ?? 0) / 60);
      const done =
        r.action === 'timeout'
          ? `${channel.slug} is timed out for ${minutes} minute${minutes === 1 ? '' : 's'}.`
          : r.action === 'ban'
            ? `${channel.slug} is banned.`
            : `${channel.slug} is unbanned.`;
      return { ok: true, message: done };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /** Discord's rule for moderating members, applied to the member who ran the command (the owner may act on anyone). */
  private async hierarchyRefusal(g: ResolvedGuild, invokerId: string, targetId: string): Promise<string | null> {
    const [ownerId, invoker, target] = await Promise.all([
      this.o.discordApi.guildOwner(g.token, g.guild.id),
      this.o.discordApi.guildMember(g.token, g.guild.id, invokerId),
      this.o.discordApi.guildMember(g.token, g.guild.id, targetId),
    ]).catch((err: unknown) => {
      throw new AppError('service_unavailable', describeDiscord(err));
    });
    if (targetId === ownerId) return 'The server owner can’t be moderated.';
    if (invokerId === ownerId || !target) return null; // not a member: nothing to compare (e.g. a ban by ID)
    const top = (roleIds: readonly string[]) => Math.max(0, ...roleIds.map((id) => g.roles.find((r) => r.id === id)?.position ?? 0));
    if (!invoker || top(invoker.roles) <= top(target.roles))
      return 'You can’t moderate members whose highest role is the same as or above yours.';
    return null;
  }

  // ── automated protection (Kick) ────────────────────────────────────────────

  automodSettings(): AutomodSettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.automodSettings);
    if (!raw) return structuredClone(AUTOMOD_DEFAULTS);
    try {
      const parsed = automodSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : structuredClone(AUTOMOD_DEFAULTS);
    } catch {
      return structuredClone(AUTOMOD_DEFAULTS);
    }
  }

  private automodState(): AutomodState {
    const caps = this.kickCapabilities();
    const kickActions = {} as Record<AutomodAction, ModerationCapability>;
    for (const action of AUTOMOD_ACTIONS) kickActions[action] = action === 'log' ? ok() : caps[action];
    return {
      kick: this.automodSettings(),
      kickActions,
      raid: this.raidState(),
      kickModerationEvents: this.o.kick.banEvents(),
      discord: {
        supported: false,
        reason: 'Discord protection is on Discord Bot → Protection: CONDUIT’s own AutoMod rules and message checks.',
      },
      stats: { ...this.stats },
    };
  }

  /** Saves the Kick settings. An action the main account can't perform is refused, with the reason. */
  saveAutomod(raw: unknown): AutomodState {
    const settings = parseInput(automodSettingsSchema, raw);
    const caps = this.automodState().kickActions;
    const issues: Array<{ path: string; message: string }> = [];
    for (const rule of KICK_CHECK_KEYS) {
      const r = settings[rule];
      if (settings.enabled && r.enabled && !caps[r.action].available) issues.push({ path: `${rule}.action`, message: caps[r.action].problem! });
    }
    if (settings.enabled && settings.raid.enabled && !caps[settings.raid.action].available) issues.push({ path: 'raid.action', message: caps[settings.raid.action].problem! });
    if (issues.length > 0) throw new AppError('validation_error', 'Some actions aren’t available on Kick', { issues });
    settingsRepo.set(this.o.db, SETTING_KEYS.automodSettings, JSON.stringify(settings), this.o.now().toISOString());
    if (!settings.enabled || !settings.raid.enabled) this.raidUntil = 0;
    writeAudit(
      this.o.db,
      {
        action: 'moderation.automod_updated',
        outcome: 'success',
        actorUserId: null,
        metadata: {
          enabled: settings.enabled,
          ...Object.fromEntries(KICK_CHECK_KEYS.map((k) => [k, settings[k].enabled ? settings[k].action : 'off'])),
          raid: settings.raid.enabled ? settings.raid.action : 'off',
          terms: settings.blockedTerms.terms.length,
        },
      },
      this.o.now(),
    );
    this.o.logger.info('automod settings saved', { enabled: settings.enabled });
    return this.automodState();
  }

  // ── raid mode ──────────────────────────────────────────────────────────────

  /** Raid mode can start once CONDUIT knows enough of your chat (so regulars aren't taken for raiders). */
  private learning(): boolean {
    const since = Date.parse(settingsRepo.get(this.o.db, CHATTERS_SINCE_KEY) ?? '');
    return !Number.isFinite(since) || this.o.now().getTime() - since < RAID_LEARNING_MS || kickChattersRepo.count(this.o.db) < RAID_LEARNING_CHATTERS;
  }

  private raidState(): RaidState {
    const now = this.o.now().getTime();
    return { activeUntil: this.raidUntil > now ? new Date(this.raidUntil).toISOString() : null, learning: this.learning(), knownChatters: kickChattersRepo.count(this.o.db) };
  }

  /** Starts raid mode now (or ends it) from the dashboard. */
  setRaid(active: boolean): AutomodState {
    const s = this.automodSettings();
    if (active) {
      if (!s.enabled || !s.raid.enabled) throw new AppError('conflict', 'Switch on Automated Protection and Raid mode first.');
      this.startRaid(s, 'started from the dashboard');
    } else {
      this.raidUntil = 0;
      this.raidNewcomers.clear();
      this.o.logger.info('raid mode ended from the dashboard');
    }
    return this.automodState();
  }

  private startRaid(s: AutomodSettings, why: string): void {
    const now = this.o.now().getTime();
    const wasOn = this.raidUntil > now;
    this.raidUntil = now + s.raid.durationMinutes * 60_000;
    this.o.logger.info('raid mode on', { why, minutes: s.raid.durationMinutes });
    if (!wasOn && s.raid.announcement) void this.o.kick.sendResult(s.raid.announcement).catch(() => undefined);
  }

  /**
   * Remembers who chats. A first-time chatter (once CONDUIT knows the chat) counts toward a raid, and while raid mode
   * is on (or the raid is still recent) counts as a newcomer.
   */
  private noteChatter(m: KickChatMessage, s: AutomodSettings): void {
    const now = this.o.now();
    if (!settingsRepo.get(this.o.db, CHATTERS_SINCE_KEY)) settingsRepo.set(this.o.db, CHATTERS_SINCE_KEY, now.toISOString(), now.toISOString());
    const learning = this.learning();
    const first = kickChattersRepo.seen(this.o.db, m.senderUserId, m.senderUsername, now.toISOString());
    if (!first || learning || !s.enabled || !s.raid.enabled) return;
    const ms = now.getTime();
    this.track(this.raidNewcomers, m.senderUserId, ms);
    this.firstTimers = this.firstTimers.filter((t) => ms - t < s.raid.windowSeconds * 1000);
    this.firstTimers.push(ms);
    if (this.firstTimers.length >= s.raid.newChatters) {
      this.firstTimers = [];
      this.startRaid(s, `${s.raid.newChatters} first-time chatters within ${s.raid.windowSeconds} s`);
    }
  }

  /** During raid mode: a newcomer whose message has a link, or that a check matched (even a log-only one), is acted on. */
  private raidMatch(m: KickChatMessage, s: AutomodSettings, match: KickMatch | null): KickMatch | null {
    const now = this.o.now().getTime();
    if (!s.raid.enabled || this.raidUntil <= now) return null;
    const since = this.raidNewcomers.get(m.senderUserId);
    if (since === undefined || now - since > s.raid.durationMinutes * 60_000) return null;
    const link = disallowedLinks(m.content, s.links.allowedSites)[0];
    if (!match && !link) return null;
    const why = match ? match.detail : `Posted a link (${link!.slice(0, 60)}).`;
    return { rule: 'raid', action: s.raid.action, timeoutMinutes: s.raid.timeoutMinutes, detail: `First-time chatter during raid mode. ${why}` };
  }

  // ── moderation done on Kick itself ─────────────────────────────────────────

  /**
   * A ban or timeout from Kick's signed moderation.banned event: recorded for the Logs as done on Kick, unless it's the
   * echo of one CONDUIT just did itself (already recorded, with what triggered it).
   */
  private onKickBan(b: KickBanEvent): void {
    try {
      if (this.seenBans.has(b.id)) return;
      this.seenBans.add(b.id);
      if (this.seenBans.size > SEEN_LIMIT) this.seenBans.delete(this.seenBans.values().next().value!);
      const since = new Date(this.o.now().getTime() - ECHO_WINDOW_MS).toISOString();
      if (moderationRepo.conduitActedSince(this.o.db, 'kick', b.userId, ['ban', 'timeout'], since)) return;
      const me = this.o.kick.moderator();
      const seconds = b.expiresAt ? Math.round((Date.parse(b.expiresAt) - Date.parse(b.at)) / 1000) : null;
      const timeout = seconds !== null && seconds > 0;
      this.save({
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        platform: 'kick',
        placeId: me?.userId ?? b.broadcasterUserId,
        placeName: me?.channel ?? null,
        action: timeout ? 'timeout' : 'ban',
        targetUserId: b.userId,
        targetName: b.userName,
        messageId: null,
        durationSeconds: timeout ? Math.min(seconds, 2_419_200) : null,
        reason: b.reason,
        source: 'platform',
        actor: b.moderatorName,
        rule: null,
        outcome: 'success',
        detail: null,
      });
    } catch (err) {
      this.o.logger.error('kick ban event not recorded', { err });
    }
  }

  // ── one user's history ─────────────────────────────────────────────────────

  /** Everything recorded for one person on one platform (Kick: protection and moderation; Discord: the whole log). */
  async userHistory(raw: unknown): Promise<ModerationUserHistory> {
    const { platform, userId } = parseInput(userHistorySchema, raw);
    const history = moderationRepo.listForUser(this.o.db, platform, userId, USER_HISTORY_LIMIT).map(toView);
    if (platform === 'kick') return { platform, userId, history, serverHistory: [], protectionHistory: [], loggingHistory: [] };
    const discord = await this.discordState();
    const names = new Map(discord.guilds.map((g) => [g.id, g.name]));
    return {
      platform,
      userId,
      history,
      serverHistory: discordModerationEventsRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => serverView(r, names)),
      protectionHistory: discordProtectionEventsRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => protectionView(r, names)),
      loggingHistory: discordLogEntriesRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => loggingView(r, names)),
    };
  }

  // ── checking messages ──────────────────────────────────────────────────────

  /** A signed chat event from the main channel. Checked once; never throws. */
  private onKickMessage(m: KickChatMessage): void {
    try {
      if (this.seen.has(m.messageId)) return;
      this.seen.add(m.messageId);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
      // Never: the channel owner, the chatbot account, CONDUIT's own messages.
      if (m.senderUserId === m.broadcasterUserId) return;
      if (m.senderUserId === this.o.kick.chatbotIdentity().userId) return;
      if (this.o.kick.wasRecentlySent(m.content)) return;
      const settings = this.automodSettings();
      // Everyone else is remembered (raid mode learns the regulars), also while protection is off.
      this.noteChatter(m, settings);
      if (!settings.enabled) return;
      // Not checked: (optionally) moderators, and ignored users.
      if (settings.exemptModerators && m.badgeTypes.some((b) => b === 'moderator' || b === 'broadcaster')) return;
      if (settings.ignoredUsers.includes(m.senderUsername.toLowerCase())) return;
      this.stats.checked++;
      const checked = this.check(m, settings);
      const match = this.raidMatch(m, settings, checked) ?? checked;
      if (!match) return;
      this.stats.matched++;
      const key = `${match.rule}:${m.senderUserId}`;
      const nowMs = this.o.now().getTime();
      // Delete-message acts on every matching message; logging and timeouts once per user per rule per window.
      if (match.action !== 'delete_message') {
        if (nowMs - (this.lastActed.get(key) ?? 0) < RULE_COOLDOWN_MS) return;
        this.lastActed.set(key, nowMs);
        if (this.lastActed.size > TRACKED_USERS) this.lastActed.delete(this.lastActed.keys().next().value!);
      }
      this.enqueue(m, match);
    } catch (err) {
      this.o.logger.error('automod check failed', { err });
    }
  }

  private check(m: KickChatMessage, s: AutomodSettings): KickMatch | null {
    const nowMs = this.o.now().getTime();
    const text = normalize(m.content);
    const b = s.blockedTerms;
    if (b.enabled && (b.terms.length > 0 || b.regexPatterns.length > 0)) {
      const found = this.matcher(s).match(m.content);
      if (found) return { rule: 'blocked_terms', action: b.action, timeoutMinutes: b.timeoutMinutes, detail: `Matched a blocked word or phrase (“${found.slice(0, 60)}”).` };
    }
    const textMatch = kickTextCheck(m.content, s);
    if (textMatch) {
      const r = s[RULE_KEY[textMatch.rule]];
      return { rule: textMatch.rule, action: r.action, timeoutMinutes: r.timeoutMinutes, detail: textMatch.detail };
    }
    // Flooding: more than maxMessages within the window.
    const times = (this.recentByUser.get(m.senderUserId) ?? []).filter((t) => nowMs - t < s.spam.windowSeconds * 1000);
    times.push(nowMs);
    this.track(this.recentByUser, m.senderUserId, times);
    if (s.spam.enabled && times.length > s.spam.maxMessages) {
      this.recentByUser.delete(m.senderUserId); // start counting again
      return { rule: 'spam', action: s.spam.action, timeoutMinutes: s.spam.timeoutMinutes, detail: `More than ${s.spam.maxMessages} messages in ${s.spam.windowSeconds} seconds.` };
    }
    // Repeats: the same text `count` times within the window.
    const prev = this.repeatsByUser.get(m.senderUserId);
    const repeat = prev && prev.text === text ? prev.times.filter((t) => nowMs - t < s.repeat.windowSeconds * 1000) : [];
    repeat.push(nowMs);
    this.track(this.repeatsByUser, m.senderUserId, { text, times: repeat });
    if (s.repeat.enabled && text.length > 0 && repeat.length >= s.repeat.count) {
      this.repeatsByUser.delete(m.senderUserId);
      return { rule: 'repeat', action: s.repeat.action, timeoutMinutes: s.repeat.timeoutMinutes, detail: `The same message ${s.repeat.count} times in ${s.repeat.windowSeconds} seconds.` };
    }
    return null;
  }

  private track<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > TRACKED_USERS) map.delete(map.keys().next().value!);
  }

  /** The blocked words, patterns and allowed words, compiled once per change (Discord AutoMod's matcher). */
  private matcher(s: AutomodSettings): AutomodMatcher {
    const b = s.blockedTerms;
    const key = JSON.stringify([b.terms, b.regexPatterns, b.allowList]);
    if (this.termMatcher.key !== key) this.termMatcher = { key, matcher: automodMatcher({ keywords: b.terms, regexPatterns: b.regexPatterns, allowList: b.allowList }) };
    return this.termMatcher.matcher;
  }

  private enqueue(m: KickChatMessage, match: KickMatch): void {
    const me = this.o.kick.moderator();
    if (match.action === 'log') {
      this.save({
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        platform: 'kick',
        placeId: me?.userId ?? m.broadcasterUserId,
        placeName: me?.channel ?? null,
        action: 'flag',
        targetUserId: m.senderUserId,
        targetName: m.senderUsername,
        messageId: m.messageId,
        durationSeconds: null,
        reason: null,
        source: 'automod',
        actor: null,
        rule: match.rule,
        outcome: 'logged',
        detail: match.detail,
      });
      return;
    }
    if (this.pending >= MAX_PENDING_ACTIONS) {
      this.o.logger.warn('automod action skipped (busy)', { rule: match.rule });
      return;
    }
    this.pending++;
    const username = /^[A-Za-z0-9_.-]{1,64}$/.test(m.senderUsername) ? m.senderUsername : 'user';
    const reason = `Automated: ${match.detail}`.slice(0, 100);
    this.queue = this.queue.then(async () => {
      try {
        const action =
          match.action === 'timeout'
            ? ({ platform: 'kick', action: 'timeout', userId: m.senderUserId, username, durationSeconds: match.timeoutMinutes * 60, reason } as const)
            : ({ platform: 'kick', action: 'delete_message', userId: m.senderUserId, username, messageId: m.messageId, reason } as const);
        await this.actKick(action, 'automod', match.rule);
      } catch (err) {
        // Couldn't be attempted (e.g. the account lost its permission): recorded so it isn't silent.
        this.save({
          id: crypto.randomUUID(),
          createdAt: this.o.now().toISOString(),
          platform: 'kick',
          placeId: me?.userId ?? m.broadcasterUserId,
          placeName: me?.channel ?? null,
          action: match.action === 'timeout' ? 'timeout' : 'delete_message',
          targetUserId: m.senderUserId,
          targetName: m.senderUsername,
          messageId: m.messageId,
          durationSeconds: match.action === 'timeout' ? match.timeoutMinutes * 60 : null,
          reason,
          source: 'automod',
          actor: me?.name ?? null,
          rule: match.rule,
          outcome: 'failed',
          detail: err instanceof AppError ? err.message : 'The automated action couldn’t be attempted.',
        });
      } finally {
        this.pending--;
      }
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ResolvedGuild {
  token: string;
  botUserId: string;
  guild: GuildAccess;
  roles: GuildRole[];
}

/** A moderation command used in Discord (from the command handler). */
export interface DiscordCommandRequest {
  guildId: string;
  invokerId: string;
  invokerName: string;
  command: string;
  action: 'timeout' | 'untimeout' | 'ban' | 'unban' | 'kick';
  userId: string;
  durationSeconds?: number;
  deleteMessageSeconds?: number;
  reason: string | null;
}

const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_ROLES = 1n << 28n;

/**
 * The Discord moderation commands and the permission the bot needs to carry each out (shown on the Discord Moderation
 * page). /lock and /unlock change the channel's @everyone permissions, which takes Manage Roles.
 */
export const DISCORD_MODERATION_COMMANDS: ReadonlyArray<{ name: string; permission: string; bit: bigint }> = [
  { name: 'timeout', permission: 'Timeout Members', bit: MODERATE_MEMBERS },
  { name: 'untimeout', permission: 'Timeout Members', bit: MODERATE_MEMBERS },
  { name: 'kick', permission: 'Kick Members', bit: KICK_MEMBERS },
  { name: 'ban', permission: 'Ban Members', bit: BAN_MEMBERS },
  { name: 'unban', permission: 'Ban Members', bit: BAN_MEMBERS },
  { name: 'slowmode', permission: 'Manage Channels', bit: MANAGE_CHANNELS },
  { name: 'lock', permission: 'Manage Roles', bit: MANAGE_ROLES },
  { name: 'unlock', permission: 'Manage Roles', bit: MANAGE_ROLES },
];

function has(perms: bigint, bit: bigint): boolean {
  return (perms & bit) === bit;
}

function discordCapabilities(g: GuildAccess): Record<ModerationActionKind | 'lookup', ModerationCapability> {
  if (g.perms === null) {
    const n = no(g.problem ?? 'The bot’s permissions in this server couldn’t be read.');
    return { timeout: n, untimeout: n, ban: n, unban: n, delete_message: n, lookup: n };
  }
  const need = (bit: bigint, name: string) =>
    has(g.perms!, bit) ? ok() : no(`The bot needs the “${name}” permission in ${g.name}. Give the bot’s role this permission (Server Settings → Roles).`);
  const moderate = need(MODERATE_MEMBERS, 'Timeout Members');
  const ban = need(BAN_MEMBERS, 'Ban Members');
  return { timeout: moderate, untimeout: moderate, ban, unban: ban, delete_message: need(MANAGE_MESSAGES, 'Manage Messages'), lookup: ok() };
}

function invalid(path: string, message: string): AppError {
  return new AppError('validation_error', message, { issues: [{ path, message }] });
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function successText(platform: 'discord' | 'kick', action: ModerationActionKind, who: string, place: string, duration: number | null): string {
  const where = platform === 'discord' ? `in ${place} (Discord)` : `in ${place}’s Kick chat`;
  switch (action) {
    case 'timeout':
      return `${who} is timed out for ${formatDuration(duration ?? 0)} ${where}.`;
    case 'untimeout':
      return `${who}’s timeout was removed ${where}.`;
    case 'ban':
      return `${who} is banned ${where}.`;
    case 'unban':
      return `${who} is unbanned ${where}.`;
    case 'delete_message':
      return `The message was deleted ${where}.`;
  }
}

const BOT_VERB: Record<ModerationActionKind, string> = {
  timeout: 'time out',
  untimeout: 'remove the timeout for',
  ban: 'ban',
  unban: 'unban',
  delete_message: 'delete the message from',
};

/** What the bot says in Discord after the platform confirmed the action. */
function botSuccessText(action: ModerationActionKind, who: string, duration: number | null): string {
  switch (action) {
    case 'timeout':
      return `I’ve timed out ${who} for ${formatDuration(duration ?? 0)}.`;
    case 'untimeout':
      return `I’ve removed ${who}’s timeout.`;
    case 'ban':
      return `I’ve banned ${who}.`;
    case 'unban':
      return `I’ve unbanned ${who}.`;
    case 'delete_message':
      return 'I’ve deleted the message.';
  }
}

/** What the bot says in Discord when the platform refused: the action it couldn't do, and why, in plain words. */
function botFailureText(err: unknown, action: ModerationActionKind, who: string): string {
  const couldnt = `I couldn’t ${BOT_VERB[action]} ${who}`;
  if (!(err instanceof DiscordApiError)) return `${couldnt}. Something went wrong; please try again.`;
  switch (err.discordCode) {
    case 50013:
      return `${couldnt} because Discord denied the request: my role has to be above theirs and I need the right permission. The server owner can’t be moderated.`;
    case 50001:
      return `${couldnt} because Discord denied the request: I can’t access this server or channel.`;
    case 10007:
      return `${couldnt} because they aren’t a member of this server.`;
    case 10013:
      return `${couldnt} because there’s no Discord user with that ID.`;
    case 10026:
      return `${couldnt} because they aren’t banned.`;
  }
  switch (err.kind) {
    case 'invalid_credentials':
      return `${couldnt} because Discord rejected my login. I need to be set up again.`;
    case 'rate_limited':
      return `${couldnt} because Discord asked me to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
    case 'network':
      return `${couldnt} because I couldn’t reach Discord. Try again in a moment.`;
    case 'not_found':
      return action === 'unban' ? `${couldnt} because they aren’t banned.` : `${couldnt} because Discord couldn’t find them.`;
    case 'server_error':
      return `${couldnt} because Discord had a problem. Try again in a moment.`;
    default:
      return `${couldnt} because Discord denied the request.`;
  }
}

function describeDiscord(err: unknown, action?: ModerationActionKind): string {
  if (err instanceof DiscordApiError) {
    switch (err.discordCode) {
      case 50013:
        return 'Discord refused: the bot is missing a permission, or the member’s highest role is at or above the bot’s role (move the bot’s role higher in Server Settings → Roles). The server owner can’t be moderated.';
      case 50001:
        return 'Discord refused: the bot can’t access that channel or server.';
      case 10007:
        return 'That user isn’t a member of the server.';
      case 10013:
        return 'No Discord user has that ID.';
      case 10026:
        return 'That user isn’t banned.';
      case 10008:
        return 'That message no longer exists.';
      case 10003:
        return 'That channel no longer exists.';
      case 10004:
        return 'The bot is no longer in that server.';
    }
    if (err.kind === 'invalid_credentials') return 'Discord rejected the bot token. Set up Discord again (Dashboard → Discord).';
    if (err.kind === 'rate_limited') return `Discord asked to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
    if (err.kind === 'network') return 'Couldn’t reach Discord. Check your internet connection and try again.';
    if (err.kind === 'not_found') return action === 'unban' ? 'That user isn’t banned.' : 'Discord couldn’t find that user, message or server.';
    if (err.kind === 'forbidden') return 'Discord refused the action (missing permission or role hierarchy).';
    if (err.kind === 'server_error') return 'Discord had a problem. Try again in a moment.';
    return 'Discord rejected the request.';
  }
  return 'The action couldn’t be completed.';
}

function describeKick(err: unknown, action?: ModerationActionKind): string {
  if (err instanceof KickApiError) {
    const said = /: "(.+)"$/.exec(err.message)?.[1];
    switch (err.kind) {
      case 'unauthorized':
        return 'Kick rejected the main account’s authorization. Reconnect it (Dashboard → Kick → Manage).';
      case 'forbidden':
        return `Kick refused${said ? `: “${said}”` : ''}. The main account needs moderation permission in this channel; select Reauthorize main account if you connected it before moderation was added.`;
      case 'not_found':
        return action === 'delete_message' ? 'Kick couldn’t find that message (it may already be deleted).' : `Kick couldn’t find that user${said ? `: “${said}”` : ''}.`;
      case 'bad_request':
        return `Kick rejected the request${said ? `: “${said}”` : ''}.`;
      case 'rate_limited':
        return `Kick asked to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
      case 'network':
        return 'Couldn’t reach Kick. Check your internet connection and try again.';
      case 'server_error':
        return 'Kick had a problem. Try again in a moment.';
      default:
        return 'Kick returned an unexpected response.';
    }
  }
  return 'The action couldn’t be completed.';
}

/** A server's audit-log moderation entry, as the Moderation log shows it. */
function serverView(r: DiscordModerationEventRecord, names: Map<string, string>): DiscordServerModerationView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    action: r.action,
    targetUserId: r.targetUserId,
    targetName: r.targetName,
    via: r.action.startsWith('automod_') ? 'automod' : r.executorBot ? 'bot' : 'discord',
    by: r.executorName,
    reason: r.reason,
    ruleName: r.ruleName,
    until: r.until,
  };
}

function protectionView(r: DiscordProtectionEventRecord, names: Map<string, string>): ProtectionEventView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    feature: r.feature,
    rule: r.rule,
    userId: r.userId,
    userName: r.userName,
    action: r.action,
    outcome: r.outcome,
    detail: r.detail,
  };
}

function loggingView(r: DiscordLogEntryRecord, names: Map<string, string>): DiscordLogEntryView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    category: r.category,
    event: r.event,
    title: r.title,
    userId: r.userId,
    userName: r.userName,
    detail: r.detail,
    posted: r.posted,
  };
}

function toView(r: ModerationRecord): ModerationRecordView {
  return {
    id: r.id,
    at: r.createdAt,
    platform: r.platform,
    place: r.placeName,
    action: r.action,
    targetUserId: r.targetUserId,
    targetName: r.targetName,
    durationSeconds: r.durationSeconds,
    reason: r.reason,
    source: r.source,
    actor: r.actor,
    rule: r.rule,
    outcome: r.outcome,
    detail: r.detail,
  };
}
