/**
 * Loyalty & Rewards — Discord only: XP and levels (per server), and a separate spendable points balance (per Discord
 * account) with a reward catalog and redemptions the streamer fulfils by hand.
 *
 * Earning (while Loyalty is on): message events from the bot's gateway session. Bots, webhooks and system messages
 * never earn. Each message can earn
 * - XP: a random amount between the minimum and maximum, at most once per cooldown per member in that server; no XP
 *   for a message identical to the member's last XP message (only recognisable while the Message Content intent is in
 *   use — CONDUIT never turns it on for this);
 * - points: only if "messages also earn points" is on, with their own amount, cooldown and daily limit.
 * Each award carries the Discord message id as its unique key, so a redelivered event never counts twice, also after a
 * restart. XP and points are never converted into each other.
 *
 * Levels: computed from total XP (shared levelForXp) and stored with it in the same transaction. A level-up is
 * announced at most once per level (announced_level is claimed atomically before posting; a failed post is recorded
 * and not retried, so nothing is announced twice and no XP is lost) and gives the role rewards up to that level. Roles
 * already given are not requested again; failures are recorded (with a readable reason, never a token) and tried again
 * at the member's next level-up. Removing a role reward never takes roles away.
 *
 * Points ledger: every balance change is a loyalty_transactions row written with the balance; balances never go below
 * 0; redemptions take the points atomically with the redemption and the limited stock; a rejection gives them back
 * exactly once. Kick takes no part any more: older Kick points history is kept as it was.
 *
 * Slash commands (while Loyalty and its commands are on): /points, /rewards, /redeem, and /level, /leaderboard while XP
 * is on — all answered privately. A custom command with the same name wins. Replies never mention CONDUIT.
 */
import crypto from 'node:crypto';
import {
  auditRepo,
  loyaltyLevelsRepo,
  loyaltyRepo,
  settingsRepo,
  SETTING_KEYS,
  withTransaction,
  type Database,
  type LoyaltyRedemptionRecord,
  type LoyaltyRewardRecord,
  type LoyaltyTransactionRecord,
  type LoyaltyXpEventRecord,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  DEFAULT_LOYALTY_SETTINGS,
  formatPoints,
  levelForXp,
  levelProgress,
  LOYALTY_COMMANDS,
  loyaltySettingsSchema,
  memberQuerySchema,
  memberRefSchema,
  pointsAdjustmentSchema,
  levelUpVars,
  readStoredLoyaltySettings,
  renderLevelUp,
  resolveRedemptionSchema,
  rewardSchema,
  roleRewardSchema,
  xpAdjustmentSchema,
  type DiscordChannelsState,
  type LoyaltyGuild,
  type LoyaltyMemberHistory,
  type LoyaltyMemberPage,
  type LoyaltyRedemptionView,
  type LoyaltyRewardView,
  type LoyaltyRoleOptions,
  type LoyaltyRoleRewardView,
  type LoyaltyAuditEntry,
  type LoyaltyLogEntry,
  type LoyaltySettings,
  type LoyaltyState,
  type LoyaltyTransactionView,
  type LoyaltyXpEventView,
} from '@conduit/shared';
import { writeAudit, type AuditAction } from '../audit';
import { AppError, notFound } from '../errors';
import { DiscordApiError, type DiscordApi } from './discord-api';
import type { GuildEvent, IncomingButton } from './discord-bot';
import type { DiscordCredentials } from './discord-credentials';
import { CommandError, OptionType, type CommandContext, type CommandReply, type SlashCommand } from './commands/types';
import { parseInput } from '../validation';
import type { CustomCommandService } from '../community/custom-command-service';
import type { DiscordPoster } from './discord-poster';

const PAGE_SIZE = 50;
const HISTORY_LIMIT = 100;
/** How much of each kind of Loyalty & Rewards history goes to the Moderation log. */
const LOG_POINTS = 50;
const LOG_XP = 50;
const LOG_CHANGES = 50;
const AUDIT_TITLE: Record<string, string> = {
  'loyalty.settings_updated': 'Loyalty settings saved',
  'loyalty.adjusted': 'Points adjusted',
  'loyalty.reward_created': 'Reward created',
  'loyalty.reward_updated': 'Reward edited',
  'loyalty.reward_removed': 'Reward removed',
  'loyalty.redemption_resolved': 'Redemption handled',
  'loyalty.role_reward_added': 'Role reward added',
  'loyalty.role_reward_removed': 'Role reward removed',
  'loyalty.reset': 'Loyalty reset',
};
const RECENT_RESOLVED = 50;
const LEADERBOARD_SIZE = 10;
/** /level: the progress bar's length and the embed colour. */
const PROGRESS_SEGMENTS = 12;
const LEVEL_COLOR = 0x3498db;
/** How long the Confirm button of /loyalty reset-leaderboard works. */
const RESET_CONFIRM_MS = 2 * 60_000;
const RESET_BUTTON_PREFIX = 'loyalty:reset:';
/** The Loyalty commands' options and examples, for the Commands page. */
const LOYALTY_COMMAND_OPTIONS: Record<keyof typeof LOYALTY_COMMANDS, string[]> = { points: [], rewards: [], redeem: ['reward'], level: ['[user]'], leaderboard: [], manage: [] };
const LOYALTY_COMMAND_EXAMPLES: Record<keyof typeof LOYALTY_COMMANDS, string> = {
  points: '/points',
  rewards: '/rewards',
  redeem: '/redeem reward:Shoutout',
  level: '/level user:@alice',
  leaderboard: '/leaderboard',
  manage: '/loyalty add-xp user:@alice amount:100 reason:Event winner',
};
const LOYALTY_COMMAND_MESSAGES: Record<keyof typeof LOYALTY_COMMANDS, string> = {
  points: 'You have {points}.',
  rewards: 'Rewards (redeem with /redeem): {reward} — {cost}',
  redeem: 'You redeemed {reward} for {cost}. It’s waiting for the streamer.',
  level: 'Level {level} · {xp} XP · rank #{rank} (an embed with a progress bar)',
  leaderboard: '🏆 Leaderboard: the top 10 by XP (an embed)',
  manage: 'Gave {amount} XP to {user}. They now have {xp} XP (level {level}).',
};
/** /loyalty's subcommands, in the order Discord shows them. */
const MANAGE_SUBCOMMANDS = ['add-xp', 'remove-xp', 'add-points', 'remove-points', 'reset-user', 'reset-leaderboard'] as const;
const PROBLEMS_KEPT = 20;
const ROLE_CACHE_MS = 30_000;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_ROLES = 1n << 28n;

export interface LoyaltyServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  customCommands: Pick<CustomCommandService, 'findRunnable'>;
  discordConnected: () => boolean;
  /** Whether the bot's gateway session currently receives message text (the Message Content intent). */
  contentIntentActive: () => boolean;
  /** Called when the set of Discord loyalty commands changes (to re-register slash commands). */
  onDiscordCommandsChanged: () => void;
  poster: Pick<DiscordPoster, 'post'>;
  api: Pick<DiscordApi, 'guildRoles' | 'guildMemberRoles' | 'addMemberRole'>;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  botUserId: () => string | null;
  discordChannels: () => Promise<DiscordChannelsState>;
  /** 0 ≤ n < 1 (tests make XP amounts predictable). */
  random?: () => number;
  /** Shows a problem as a pop-up alert on the dashboard. */
  alert?: (detail: string) => void;
}

/**
 * Something that changed in Loyalty & Rewards, told to listeners (Discord Logging) after it was saved. `id` is unique
 * per change; `guildId` is set for what belongs to one server (XP, levels, roles), not for points (one balance per
 * account).
 */
export type LoyaltyEvent = { id: string; at: string; userId: string | null; userName: string | null; pointsName: string } & (
  | { kind: 'level_up'; guildId: string; level: number; xp: number }
  | { kind: 'xp'; guildId: string; amount: number; xp: number; level: number; reason: string }
  | { kind: 'points'; amount: number; balance: number; reason: string }
  | { kind: 'redeemed'; reward: string; cost: number; balance: number }
  | { kind: 'resolved'; reward: string; status: 'fulfilled' | 'rejected'; cost: number; note: string | null }
  | { kind: 'roles'; guildId: string; roleId: string; level: number; ok: boolean; detail: string | null }
  | { kind: 'reset'; guildId: string; xp: number; points: number; members: number | null; by: string }
);
type LoyaltyEventBody = LoyaltyEvent extends infer E ? (E extends LoyaltyEvent ? Omit<E, 'id' | 'at' | 'pointsName'> : never) : never;

export type AwardOutcome = 'awarded' | 'off' | 'cooldown' | 'limit' | 'duplicate' | 'repeat';
export type RedeemOutcome =
  | { outcome: 'redeemed'; redemption: LoyaltyRedemptionRecord; balance: number }
  | { outcome: 'unknown_reward' | 'unavailable' | 'out_of_stock' | 'duplicate' }
  | { outcome: 'insufficient'; cost: number; balance: number };

type RoleInfo = { at: number; roles: Array<{ id: string; name: string; assignable: boolean; problem: string | null }>; problem: string | null };

/** Thrown inside a transaction to roll it back with a known outcome. */
class Rollback extends Error {
  constructor(readonly result: RedeemOutcome) {
    super('rollback');
  }
}

export class LoyaltyService {
  private queue: Promise<void> = Promise.resolve();
  private readonly granting = new Set<string>();
  private readonly roleCache = new Map<string, RoleInfo>();
  private readonly problems: Array<{ at: string; detail: string }> = [];
  private readonly random: () => number;
  private readonly listeners = new Set<(e: LoyaltyEvent) => void>();

  constructor(private readonly o: LoyaltyServiceOptions) {
    this.random = o.random ?? Math.random;
  }

  /** Every saved change worth logging: level-ups, adjustments, redemptions, level roles and resets. */
  onEvent(listener: (e: LoyaltyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tell(body: LoyaltyEventBody): void {
    if (this.listeners.size === 0) return;
    const e = { ...body, id: crypto.randomUUID(), at: this.iso(), pointsName: this.settings().pointsName } as LoyaltyEvent;
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch (err) {
        this.o.logger.error('loyalty event listener failed', { err });
      }
    }
  }

  /** Resolves when queued level-up work (announcements, roles) has finished (tests). */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  // ── settings and state ─────────────────────────────────────────────────────

  settings(): LoyaltySettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.loyaltySettings);
    if (!raw) return DEFAULT_LOYALTY_SETTINGS;
    let parsed: LoyaltySettings | null = null;
    try {
      parsed = readStoredLoyaltySettings(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) this.o.logger.warn('stored loyalty settings are invalid; using defaults');
    return parsed ?? DEFAULT_LOYALTY_SETTINGS;
  }

  async saveSettings(raw: unknown): Promise<LoyaltyState> {
    const next = parseInput(loyaltySettingsSchema, raw);
    const before = this.discordCommandNames();
    // The server the settings are for: the level-up announcement's, else the bot's only server (none when unclear).
    const servers = (await this.o.discordChannels().catch(() => null))?.guilds ?? [];
    const guildId = next.xp.announce.guildId ?? (servers.length === 1 ? servers[0]!.id : null);
    withTransaction(this.o.db, () => {
      settingsRepo.set(this.o.db, SETTING_KEYS.loyaltySettings, JSON.stringify(next), this.iso());
      this.audit('loyalty.settings_updated', { guildId, enabled: next.enabled, xp: next.xp.enabled, pointsFromMessages: next.discord.earn, announce: next.xp.announce.enabled });
    });
    if (before.join() !== this.discordCommandNames().join()) this.o.onDiscordCommandsChanged();
    return this.state();
  }

  async state(): Promise<LoyaltyState> {
    const settings = this.settings();
    const pending = loyaltyRepo.listRedemptions(this.o.db, 'pending', 200).reverse();
    const resolved = loyaltyRepo
      .listRedemptions(this.o.db, null, RECENT_RESOLVED + pending.length)
      .filter((r) => r.status !== 'pending')
      .slice(0, RECENT_RESOLVED);
    const connected = this.o.discordConnected();
    const levelStats = loyaltyLevelsRepo.stats(this.o.db);
    const guilds = await this.guilds();
    return {
      settings,
      stats: { ...loyaltyRepo.stats(this.o.db), members: levelStats.members, totalXp: levelStats.totalXp },
      guilds,
      rewards: loyaltyRepo.listRewards(this.o.db).map(rewardView),
      roleRewards: await this.roleRewardViews(),
      redemptions: [...pending, ...resolved].map(redemptionView),
      problems: [...this.problems],
      discord: {
        ready: connected,
        problem: connected ? null : 'The Discord bot isn’t connected, so nothing is earned and the commands don’t answer.',
        contentAvailable: this.o.contentIntentActive(),
        commandConflicts: this.conflicts(),
      },
    };
  }

  // ── members ────────────────────────────────────────────────────────────────

  async members(raw: unknown): Promise<LoyaltyMemberPage> {
    const q = parseInput(memberQuerySchema, raw ?? {});
    const guildId = q.guildId ?? (await this.guilds())[0]?.id ?? null;
    if (!guildId) return { guildId: null, members: [], total: 0, offset: q.offset, pageSize: PAGE_SIZE };
    const { rows, total } = loyaltyLevelsRepo.members(this.o.db, { guildId, query: q.query, sort: q.sort, limit: PAGE_SIZE, offset: q.offset });
    return {
      guildId,
      total,
      offset: q.offset,
      pageSize: PAGE_SIZE,
      members: rows.map((r, i) => ({
        guildId,
        userId: r.userId,
        displayName: r.displayName,
        xp: r.xp,
        progress: progressOf(r.xp),
        points: r.points,
        rank: q.sort === 'xp' && !q.query ? q.offset + i + 1 : (loyaltyLevelsRepo.rank(this.o.db, guildId, r.userId) ?? 0),
      })),
    };
  }

  history(raw: unknown): LoyaltyMemberHistory {
    const { userId } = parseInput(memberRefSchema, raw);
    const account = loyaltyRepo.getAccount(this.o.db, 'discord', userId);
    const levels = loyaltyLevelsRepo.forUser(this.o.db, userId);
    if (!account && levels.length === 0) throw notFound('Member');
    return {
      userId,
      displayName: levels[0]?.displayName ?? account?.displayName ?? null,
      points: { balance: account?.balance ?? 0, lifetimeEarned: account?.lifetimeEarned ?? 0 },
      levels: levels.map((l) => ({ guildId: l.guildId, xp: l.xp, progress: progressOf(l.xp), rank: loyaltyLevelsRepo.rank(this.o.db, l.guildId, userId) })),
      transactions: account ? loyaltyRepo.transactions(this.o.db, 'discord', userId, HISTORY_LIMIT).map(transactionView) : [],
      xpEvents: loyaltyLevelsRepo.xpEvents(this.o.db, userId, HISTORY_LIMIT).map(xpEventView),
    };
  }

  /** An administrator's points adjustment (award or deduction) with a required reason; ledger and audit log. */
  adjustPoints(raw: unknown): LoyaltyMemberHistory {
    const a = parseInput(pointsAdjustmentSchema, raw);
    const done = withTransaction(this.o.db, () => {
      const known = loyaltyRepo.getAccount(this.o.db, 'discord', a.userId) ?? loyaltyLevelsRepo.forUser(this.o.db, a.userId)[0];
      if (!known) throw notFound('Member');
      loyaltyRepo.ensureAccount(this.o.db, 'discord', a.userId, known.displayName, this.iso());
      const r = loyaltyRepo.applyChange(this.o.db, { id: crypto.randomUUID(), platform: 'discord', userId: a.userId, amount: a.amount, kind: 'adjustment', reason: a.reason, eventKey: null, redemptionId: null, at: this.iso() });
      if (r.outcome === 'insufficient') {
        throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'amount', message: `That would take the balance below 0 (it is ${r.balance}).` }] });
      }
      this.audit('loyalty.adjusted', { userId: a.userId, amount: a.amount, reason: a.reason, balance: r.balance });
      return { balance: r.balance, name: known.displayName ?? null };
    });
    this.o.logger.info('loyalty points adjusted', { amount: a.amount });
    this.tell({ kind: 'points', userId: a.userId, userName: done.name, amount: a.amount, balance: done.balance, reason: a.reason });
    return this.history({ userId: a.userId });
  }

  /** An administrator's XP adjustment in one server; the level is recalculated, and role rewards follow a level-up. */
  adjustXp(raw: unknown): LoyaltyMemberHistory {
    const a = parseInput(xpAdjustmentSchema, raw);
    let change: { before: number; after: number; xp: number; name: string | null } | null = null;
    withTransaction(this.o.db, () => {
      const member = loyaltyLevelsRepo.get(this.o.db, a.guildId, a.userId);
      if (!member) throw notFound('Member');
      const r = loyaltyLevelsRepo.applyXp(this.o.db, { id: crypto.randomUUID(), guildId: a.guildId, userId: a.userId, amount: a.amount, levelFor: levelForXp, kind: 'adjustment', reason: a.reason, eventKey: null, contentHash: null, at: this.iso() });
      if (r.outcome === 'below_zero') {
        throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'amount', message: `That would take the XP below 0 (it is ${r.xp}).` }] });
      }
      // An administrator's change is never announced: mark the level as announced so it isn't later either.
      if (r.level > member.level) loyaltyLevelsRepo.claimAnnouncement(this.o.db, a.guildId, a.userId, r.level);
      change = { before: member.level, after: r.level, xp: r.xp, name: member.displayName ?? null };
      this.audit('loyalty.xp_adjusted', { guildId: a.guildId, userId: a.userId, amount: a.amount, reason: a.reason, xp: r.xp, level: r.level });
    });
    const c = change as { before: number; after: number; xp: number; name: string | null } | null;
    if (c) this.tell({ kind: 'xp', guildId: a.guildId, userId: a.userId, userName: c.name, amount: a.amount, xp: c.xp, level: c.after, reason: a.reason });
    if (c && c.after > c.before) this.enqueue(() => this.grantRoles(a.guildId, a.userId, c.after));
    return this.history({ userId: a.userId });
  }

  // ── role rewards ───────────────────────────────────────────────────────────

  /** Roles the bot could give, per server, with why not when it can't. */
  async roleOptions(): Promise<LoyaltyRoleOptions> {
    const channels = await this.o.discordChannels().catch(() => null);
    if (!channels) return { guilds: [], problem: 'Discord isn’t reachable.' };
    const guilds = [];
    for (const g of channels.guilds) {
      const info = await this.roleInfo(g.id, true);
      guilds.push({ id: g.id, name: g.name, roles: info.roles });
    }
    return { guilds, problem: channels.problem };
  }

  async addRoleReward(raw: unknown): Promise<LoyaltyRoleRewardView> {
    const input = parseInput(roleRewardSchema, raw);
    const info = await this.roleInfo(input.guildId, true);
    if (info.problem) throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'roleId', message: info.problem }] });
    const role = info.roles.find((r) => r.id === input.roleId);
    if (!role) throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'roleId', message: 'That role doesn’t exist in this server.' }] });
    if (!role.assignable) throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'roleId', message: role.problem ?? 'The bot can’t give this role.' }] });
    const id = crypto.randomUUID();
    withTransaction(this.o.db, () => {
      if (!loyaltyLevelsRepo.insertRoleReward(this.o.db, { id, ...input, createdAt: this.iso() })) {
        throw new AppError('conflict', 'That role is already a reward', { issues: [{ path: 'roleId', message: 'This role is already given at a level. Remove that one first.' }] });
      }
      this.audit('loyalty.role_reward_added', { guildId: input.guildId, roleId: input.roleId, level: input.level });
    });
    return (await this.roleRewardViews()).find((r) => r.id === id)!;
  }

  /** Removes a role reward. Members who already received the role keep it. */
  removeRoleReward(id: string): { id: string; deleted: true } {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Role reward');
    withTransaction(this.o.db, () => {
      const removed = loyaltyLevelsRepo.deleteRoleReward(this.o.db, id);
      if (!removed) throw notFound('Role reward');
      this.audit('loyalty.role_reward_removed', { guildId: removed.guildId, roleId: removed.roleId, level: removed.level });
    });
    return { id, deleted: true };
  }

  // ── rewards ────────────────────────────────────────────────────────────────

  createReward(raw: unknown): LoyaltyRewardView {
    const input = parseInput(rewardSchema, raw);
    const at = this.iso();
    const id = crypto.randomUUID();
    withTransaction(this.o.db, () => {
      this.assertNameFree(input.name, null);
      loyaltyRepo.insertReward(this.o.db, { id, ...input, createdAt: at, updatedAt: at });
      this.audit('loyalty.reward_created', { id, name: input.name, cost: input.cost });
    });
    return rewardView(loyaltyRepo.getReward(this.o.db, id)!);
  }

  updateReward(id: string, raw: unknown): LoyaltyRewardView {
    const current = this.activeReward(id);
    // A partial body (e.g. only { enabled }) is applied over the saved reward, then validated as a whole.
    const merged = { name: current.name, description: current.description, cost: current.cost, enabled: current.enabled, stock: current.stock, ...(raw && typeof raw === 'object' ? raw : {}) };
    const input = parseInput(rewardSchema, merged);
    withTransaction(this.o.db, () => {
      this.assertNameFree(input.name, id);
      loyaltyRepo.updateReward(this.o.db, id, input, this.iso());
      this.audit('loyalty.reward_updated', { id, name: input.name, cost: input.cost, enabled: input.enabled });
    });
    return rewardView(loyaltyRepo.getReward(this.o.db, id)!);
  }

  /** Removes a reward from the catalog. It is archived, so past and pending redemptions keep their history. */
  removeReward(id: string): { id: string; deleted: true } {
    this.activeReward(id);
    withTransaction(this.o.db, () => {
      loyaltyRepo.archiveReward(this.o.db, id, this.iso());
      this.audit('loyalty.reward_removed', { id });
    });
    return { id, deleted: true };
  }

  // ── redemptions ────────────────────────────────────────────────────────────

  fulfill(id: string, raw: unknown): LoyaltyRedemptionView {
    const { note } = parseInput(resolveRedemptionSchema, raw ?? {});
    withTransaction(this.o.db, () => {
      if (!loyaltyRepo.resolveRedemption(this.o.db, id, 'fulfilled', note, this.iso())) throw this.notPending(id);
      this.audit('loyalty.redemption_resolved', { id, status: 'fulfilled' });
    });
    return this.resolved(id);
  }

  /** A handled redemption for the dashboard, told to listeners. */
  private resolved(id: string): LoyaltyRedemptionView {
    const r = loyaltyRepo.getRedemption(this.o.db, id)!;
    if (r.status === 'fulfilled' || r.status === 'rejected')
      this.tell({ kind: 'resolved', userId: r.userId, userName: r.displayName, reward: r.rewardName, status: r.status, cost: r.cost, note: r.note });
    return redemptionView(r);
  }

  /** Rejects a pending redemption and gives the points (and limited stock) back, atomically and exactly once. */
  reject(id: string, raw: unknown): LoyaltyRedemptionView {
    const { note } = parseInput(resolveRedemptionSchema, raw ?? {});
    withTransaction(this.o.db, () => {
      const r = loyaltyRepo.getRedemption(this.o.db, id);
      if (!r || !loyaltyRepo.resolveRedemption(this.o.db, id, 'rejected', note, this.iso())) throw this.notPending(id);
      const refund = loyaltyRepo.applyChange(this.o.db, { id: crypto.randomUUID(), platform: r.platform, userId: r.userId, amount: r.cost, kind: 'refund', reason: `Refund: ${r.rewardName}`, eventKey: `refund:${id}`, redemptionId: id, at: this.iso() });
      if (refund.outcome !== 'ok') throw new Error(`refund not applied: ${refund.outcome}`);
      loyaltyRepo.returnStock(this.o.db, r.rewardId);
      this.audit('loyalty.redemption_resolved', { id, status: 'rejected', refunded: r.cost });
    });
    return this.resolved(id);
  }

  // ── earning ────────────────────────────────────────────────────────────────

  /** A Discord message from the bot's gateway session: XP and (if switched on) points. */
  onDiscordEvent(e: GuildEvent): void {
    if (e.type !== 'message_create' || e.authorBot || e.system) return;
    const s = this.settings();
    if (!s.enabled) return;
    const user = { id: e.authorId, name: e.authorName ?? null };
    if (s.xp.enabled) this.awardXp(e.guildId, user, e.messageId, e.contentHash ?? null, e.channelId, s);
    if (s.discord.earn) this.award(user, `discord:chat:${e.messageId}`);
  }

  /** XP for one message, if the rules allow it: cooldown, repeat check, duplicate check, XP, level — one transaction. */
  awardXp(guildId: string, user: { id: string; name: string | null }, messageId: string, contentHash: string | null, channelId: string | null, s = this.settings()): AwardOutcome {
    if (!s.enabled || !s.xp.enabled) return 'off';
    const now = this.o.now();
    const at = now.toISOString();
    let levelUp: { from: number; to: number; xp: number } | null = null;
    let outcome: AwardOutcome;
    try {
      outcome = withTransaction(this.o.db, (): AwardOutcome => {
        // An event already applied is reported as such before any other rule.
        if (loyaltyLevelsRepo.hasEvent(this.o.db, `discord:xp:${messageId}`)) return 'duplicate';
        const member = loyaltyLevelsRepo.ensure(this.o.db, guildId, user.id, user.name, at);
        if (member.lastXpAt && now.getTime() - Date.parse(member.lastXpAt) < s.xp.cooldownSeconds * 1000) return 'cooldown';
        if (s.xp.ignoreRepeats && contentHash && contentHash === member.lastContentHash) return 'repeat';
        const amount = s.xp.minXp + Math.floor(this.random() * (s.xp.maxXp - s.xp.minXp + 1));
        const r = loyaltyLevelsRepo.applyXp(this.o.db, { id: crypto.randomUUID(), guildId, userId: user.id, amount, levelFor: levelForXp, kind: 'message', reason: null, eventKey: `discord:xp:${messageId}`, contentHash, at });
        if (r.outcome !== 'ok') return 'duplicate';
        if (r.level > member.level) levelUp = { from: member.level, to: r.level, xp: r.xp };
        return 'awarded';
      });
    } catch (err) {
      this.o.logger.error('loyalty xp award failed', { err });
      return 'off';
    }
    const up = levelUp as { from: number; to: number; xp: number } | null;
    if (up) {
      this.tell({ kind: 'level_up', guildId, userId: user.id, userName: user.name, level: up.to, xp: up.xp });
      const name = user.name ?? user.id;
      this.enqueue(async () => {
        await this.announce(guildId, user.id, name, up.to, channelId, s);
        await this.grantRoles(guildId, user.id, up.to);
      });
    }
    return outcome;
  }

  /**
   * Points for one message, if "messages also earn points" is on: cooldown, daily limit, duplicate check, ledger entry
   * and balance — one transaction.
   */
  award(user: { id: string; name: string | null }, eventKey: string): AwardOutcome {
    const settings = this.settings();
    const cfg = settings.discord;
    if (!settings.enabled || !cfg.earn) return 'off';
    const now = this.o.now();
    const at = now.toISOString();
    try {
      return withTransaction(this.o.db, (): AwardOutcome => {
        if (loyaltyRepo.hasEvent(this.o.db, eventKey)) return 'duplicate';
        const account = loyaltyRepo.ensureAccount(this.o.db, 'discord', user.id, user.name, at);
        if (account.lastEarnedAt && now.getTime() - Date.parse(account.lastEarnedAt) < cfg.cooldownSeconds * 1000) return 'cooldown';
        let amount = cfg.pointsPerMessage;
        if (cfg.dailyLimit > 0) {
          const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
          const room = cfg.dailyLimit - loyaltyRepo.chatEarnedSince(this.o.db, 'discord', user.id, dayStart);
          if (room <= 0) return 'limit';
          amount = Math.min(amount, room);
        }
        const r = loyaltyRepo.applyChange(this.o.db, { id: crypto.randomUUID(), platform: 'discord', userId: user.id, amount, kind: 'chat', reason: 'Discord message', eventKey, redemptionId: null, at });
        return r.outcome === 'ok' ? 'awarded' : 'duplicate';
      });
    } catch (err) {
      this.o.logger.error('loyalty points award failed', { err });
      return 'off';
    }
  }

  /** A member's points (formatted with the points name), level, XP and rank, for command variables; null while Loyalty is off. */
  commandStats(guildId: string, userId: string): { points: string; level: number; xp: number; rank: number | null } | null {
    const s = this.settings();
    if (!s.enabled) return null;
    const m = loyaltyLevelsRepo.get(this.o.db, guildId, userId);
    return {
      points: formatPoints(this.balance(userId), s.pointsName),
      level: m?.level ?? 0,
      xp: m?.xp ?? 0,
      rank: m && m.xp > 0 ? loyaltyLevelsRepo.rank(this.o.db, guildId, userId) : null,
    };
  }

  balance(userId: string): number {
    return loyaltyRepo.getAccount(this.o.db, 'discord', userId)?.balance ?? 0;
  }

  /** Redeems a reward by name for a Discord member: one transaction for the redemption, the charge and the stock. */
  redeem(user: { id: string; name: string | null }, rewardName: string, requestKey: string): RedeemOutcome {
    const at = this.iso();
    let result: RedeemOutcome;
    try {
      result = withTransaction(this.o.db, (): RedeemOutcome => {
        const reward = loyaltyRepo.findRewardByName(this.o.db, rewardName.trim());
        if (!reward) return { outcome: 'unknown_reward' };
        if (!reward.enabled) return { outcome: 'unavailable' };
        loyaltyRepo.ensureAccount(this.o.db, 'discord', user.id, user.name, at);
        const id = crypto.randomUUID();
        const redemption = { id, rewardId: reward.id, rewardName: reward.name, platform: 'discord' as const, userId: user.id, displayName: user.name, cost: reward.cost, requestKey, createdAt: at };
        if (!loyaltyRepo.insertRedemption(this.o.db, redemption)) return { outcome: 'duplicate' };
        const charge = loyaltyRepo.applyChange(this.o.db, { id: crypto.randomUUID(), platform: 'discord', userId: user.id, amount: -reward.cost, kind: 'redemption', reason: `Redeemed: ${reward.name}`, eventKey: `redeem:${id}`, redemptionId: id, at });
        if (charge.outcome === 'insufficient') throw new Rollback({ outcome: 'insufficient', cost: reward.cost, balance: charge.balance });
        if (!loyaltyRepo.takeStock(this.o.db, reward.id)) throw new Rollback({ outcome: 'out_of_stock' });
        return { outcome: 'redeemed', redemption: loyaltyRepo.getRedemption(this.o.db, id)!, balance: charge.balance };
      });
    } catch (err) {
      if (err instanceof Rollback) return err.result;
      throw err;
    }
    if (result.outcome === 'redeemed') {
      const r = result.redemption;
      this.tell({ kind: 'redeemed', userId: r.userId, userName: r.displayName, reward: r.rewardName, cost: r.cost, balance: result.balance });
    }
    return result;
  }

  // ── level-ups ──────────────────────────────────────────────────────────────

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((err) => this.o.logger.error('loyalty level-up work failed', { err }));
  }

  /** Announces a level once: the level is claimed before posting, so a retry or restart never repeats it. */
  private async announce(guildId: string, userId: string, name: string, level: number, eventChannelId: string | null, s: LoyaltySettings): Promise<void> {
    const a = s.xp.announce;
    if (!a.enabled) return;
    const channelId = a.channelId && a.guildId === guildId ? a.channelId : eventChannelId;
    if (!channelId) return;
    if (!loyaltyLevelsRepo.claimAnnouncement(this.o.db, guildId, userId, level)) return;
    const vars = levelUpVars({ userId, username: name, level });
    const res = await this.o.poster.post(channelId, { content: renderLevelUp(a.template, { userId, username: name, level }), embed: a.embed }, vars);
    if (!res.ok) this.problem(`Level-up announcement for ${name} (level ${level}) wasn’t posted: ${res.detail}`);
  }

  /** Gives every role reward up to `level` that the member hasn't received yet. */
  private async grantRoles(guildId: string, userId: string, level: number): Promise<void> {
    const due = loyaltyLevelsRepo.roleRewards(this.o.db, guildId).filter((r) => r.level <= level);
    if (due.length === 0) return;
    const token = await this.o.credentials.botToken();
    if (!token) return this.problem('Role rewards weren’t given: Discord isn’t set up (no bot token).');
    for (const reward of due) {
      const key = `${guildId}:${userId}:${reward.roleId}`;
      if (this.granting.has(key) || loyaltyLevelsRepo.grant(this.o.db, guildId, userId, reward.roleId)?.status === 'granted') continue;
      this.granting.add(key);
      try {
        await this.o.api.addMemberRole(token, guildId, userId, reward.roleId, `Level ${reward.level} reward`);
        loyaltyLevelsRepo.recordGrant(this.o.db, { guildId, userId, roleId: reward.roleId, level: reward.level, status: 'granted', detail: null, updatedAt: this.iso() });
        const userName = loyaltyLevelsRepo.get(this.o.db, guildId, userId)?.displayName ?? null;
        this.tell({ kind: 'roles', guildId, userId, userName, roleId: reward.roleId, level: reward.level, ok: true, detail: null });
      } catch (err) {
        const detail = roleError(err);
        loyaltyLevelsRepo.recordGrant(this.o.db, { guildId, userId, roleId: reward.roleId, level: reward.level, status: 'failed', detail, updatedAt: this.iso() });
        const userName = loyaltyLevelsRepo.get(this.o.db, guildId, userId)?.displayName ?? null;
        this.tell({ kind: 'roles', guildId, userId, userName, roleId: reward.roleId, level: reward.level, ok: false, detail });
        const name = userName ?? userId;
        this.problem(`Level ${reward.level} role for ${name} wasn’t given: ${detail}`);
      } finally {
        this.granting.delete(key);
      }
    }
  }

  private problem(detail: string): void {
    this.o.logger.warn('loyalty problem', { detail });
    this.problems.unshift({ at: this.iso(), detail });
    this.o.alert?.(detail);
    if (this.problems.length > PROBLEMS_KEPT) this.problems.pop();
  }

  /** The server's roles and whether the bot can give each (Manage Roles, and below the bot's highest role). Cached briefly. */
  private async roleInfo(guildId: string, force = false): Promise<RoleInfo> {
    const now = this.o.now().getTime();
    const cached = this.roleCache.get(guildId);
    if (!force && cached && now - cached.at < ROLE_CACHE_MS) return cached;
    const token = await this.o.credentials.botToken();
    const botId = this.o.botUserId();
    let info: RoleInfo;
    if (!token || !botId) info = { at: now, roles: [], problem: 'Set up Discord first (Dashboard → Discord → Connect).' };
    else {
      try {
        const [roles, botRoles] = await Promise.all([this.o.api.guildRoles(token, guildId), this.o.api.guildMemberRoles(token, guildId, botId)]);
        let perms = roles.find((r) => r.id === guildId)?.permissions ?? 0n;
        for (const id of botRoles) perms |= roles.find((r) => r.id === id)?.permissions ?? 0n;
        const canManage = (perms & ADMINISTRATOR) === ADMINISTRATOR || (perms & MANAGE_ROLES) === MANAGE_ROLES;
        const top = Math.max(0, ...botRoles.map((id) => roles.find((r) => r.id === id)?.position ?? 0));
        info = {
          at: now,
          problem: null,
          roles: roles
            .filter((r) => r.id !== guildId)
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
            .map((r) => {
              const problem = r.managed
                ? 'Managed by an integration or bot; Discord doesn’t let anyone give it.'
                : !canManage
                  ? 'The bot needs the Manage Roles permission.'
                  : (r.position ?? 0) >= top
                    ? 'This role is at or above the bot’s highest role. Move the bot’s role above it (Server Settings → Roles).'
                    : null;
              return { id: r.id, name: r.name || r.id, assignable: problem === null, problem };
            }),
        };
      } catch (err) {
        info = { at: now, roles: [], problem: roleError(err) };
      }
    }
    this.roleCache.set(guildId, info);
    return info;
  }

  private async roleRewardViews(): Promise<LoyaltyRoleRewardView[]> {
    const rewards = loyaltyLevelsRepo.roleRewards(this.o.db, null);
    const out: LoyaltyRoleRewardView[] = [];
    for (const r of rewards) {
      const info = await this.roleInfo(r.guildId).catch(() => null);
      const role = info?.roles.find((x) => x.id === r.roleId);
      out.push({
        id: r.id,
        guildId: r.guildId,
        level: r.level,
        roleId: r.roleId,
        roleName: role?.name ?? null,
        problem: !info ? 'Discord isn’t reachable.' : info.problem ? info.problem : !role ? 'This role no longer exists.' : role.problem,
      });
    }
    return out;
  }

  /** Servers the bot is in, plus any server with XP records (named when the bot can see it). */
  private async guilds(): Promise<LoyaltyGuild[]> {
    const channels = await this.o.discordChannels().catch(() => null);
    const counts = new Map(loyaltyLevelsRepo.guilds(this.o.db).map((g) => [g.guildId, g.members]));
    const list: LoyaltyGuild[] = (channels?.guilds ?? []).map((g) => ({ id: g.id, name: g.name, members: counts.get(g.id) ?? 0 }));
    for (const [id, members] of counts) if (!list.some((g) => g.id === id)) list.push({ id, name: null, members });
    return list;
  }

  // ── Discord commands ───────────────────────────────────────────────────────

  /** Each Loyalty command's description (the points name comes from the settings). */
  private commandDescriptions(s: LoyaltySettings): Record<keyof typeof LOYALTY_COMMANDS, string> {
    return {
      points: `See how many ${s.pointsName} you have`,
      rewards: 'See the rewards you can redeem',
      redeem: `Spend your ${s.pointsName} on a reward`,
      level: 'See your level, or another member’s, in this server',
      leaderboard: 'See the top members by XP in this server',
      manage: `Give or take XP and ${s.pointsName}, or reset them (admins)`,
    };
  }

  /** Every Loyalty command, whether it is registered now and, if not, why (Commands → Loyalty & Reward Commands). */
  commandCatalog(): Array<{ name: string; description: string; subcommands: string[]; options: string[]; example: string; message: string; active: boolean; reason: string | null }> {
    const s = this.settings();
    const conflicts = new Set(this.conflicts());
    const descriptions = this.commandDescriptions(s);
    return (Object.keys(LOYALTY_COMMANDS) as Array<keyof typeof LOYALTY_COMMANDS>).map((key) => {
      const name = LOYALTY_COMMANDS[key];
      const reason = !s.enabled
        ? 'Loyalty & Rewards is off'
        : !s.discord.commands
          ? 'Loyalty commands are switched off in Loyalty & Rewards'
          : (key === 'level' || key === 'leaderboard') && !s.xp.enabled
            ? 'Needs XP & levels on (Loyalty & Rewards)'
            : conflicts.has(`/${name}`)
              ? `A custom command already uses /${name}`
              : null;
      return {
        name,
        description: descriptions[key],
        subcommands: key === 'manage' ? [...MANAGE_SUBCOMMANDS] : [],
        options: LOYALTY_COMMAND_OPTIONS[key],
        example: LOYALTY_COMMAND_EXAMPLES[key],
        message: LOYALTY_COMMAND_MESSAGES[key],
        active: reason === null,
        reason,
      };
    });
  }

  /** The Discord slash commands to register now (none while Loyalty or its commands are off). */
  slashCommands(): SlashCommand[] {
    const s = this.settings();
    if (!s.enabled || !s.discord.commands) return [];
    const conflicts = new Set(this.conflicts());
    const d = this.commandDescriptions(s);
    const all: SlashCommand[] = [
      {
        name: LOYALTY_COMMANDS.points,
        description: d.points,
        origin: 'default',
        ephemeral: true,
        execute: (ctx) => ({ content: `You have ${formatPoints(this.balance(ctx.userId), this.settings().pointsName)}.`, ephemeral: true }),
      },
      {
        name: LOYALTY_COMMANDS.rewards,
        description: d.rewards,
        origin: 'default',
        ephemeral: true,
        execute: () => ({ content: this.rewardsText(this.settings()) ?? 'There are no rewards yet.', ephemeral: true }),
      },
      {
        name: LOYALTY_COMMANDS.redeem,
        description: d.redeem,
        origin: 'default',
        ephemeral: true,
        options: [{ name: 'reward', description: 'The reward’s name (see /rewards)', type: OptionType.String, required: true }],
        execute: (ctx) => {
          const rewardName = String(ctx.options.get('reward') ?? '');
          const result = this.redeem({ id: ctx.userId, name: ctx.userName }, rewardName, `discord:interaction:${ctx.interactionId}`);
          return { content: redeemText(result, rewardName, this.settings()), ephemeral: true };
        },
      },
    ];
    if (s.xp.enabled) {
      all.push(
        {
          name: LOYALTY_COMMANDS.level,
          description: d.level,
          origin: 'default',
          ephemeral: true,
          options: [{ name: 'user', description: 'Whose level (default: yours)', type: OptionType.User, required: false }],
          execute: async (ctx) => {
            const picked = ctx.options.get('user');
            const userId = typeof picked === 'string' ? picked : ctx.userId;
            const name = typeof picked === 'string' ? (ctx.optionLabels.get('user') ?? null) : ctx.userName;
            return { content: '', embeds: [await this.levelEmbed(ctx.guildId, userId, name, userId === ctx.userId)], ephemeral: true };
          },
        },
        {
          name: LOYALTY_COMMANDS.leaderboard,
          description: d.leaderboard,
          origin: 'default',
          ephemeral: true,
          execute: async (ctx) => ({ content: '', embeds: [await this.leaderboardEmbed(ctx.guildId, ctx.userId)], ephemeral: true }),
        },
      );
    }
    all.push(this.manageCommand(s, d.manage));
    return all.filter((c) => !conflicts.has(`/${c.name}`));
  }

  // ── /loyalty (admins) ──────────────────────────────────────────────────────

  /** Leaderboard resets waiting for their Confirm button: nonce → who asked, where, until when. */
  private readonly pendingResets = new Map<string, { guildId: string; userId: string; userName: string; expires: number }>();

  /**
   * /loyalty add-xp, remove-xp, add-points, remove-points, reset-user, reset-leaderboard. Admin only (Commands →
   * Discord), recorded like the same changes made in CONDUIT (history and audit log). Resetting the leaderboard needs a
   * second click on a Confirm button that only the admin who asked sees, within 2 minutes.
   */
  private manageCommand(s: LoyaltySettings, description: string): SlashCommand {
    const user = { name: 'user', description: 'The member', type: OptionType.User, required: true } as const;
    const reason = { name: 'reason', description: 'Why (kept in their history)', type: OptionType.String, required: false, maxLength: 200 } as const;
    const xpAmount = { name: 'amount', description: 'How much XP', type: OptionType.Integer, required: true, minValue: 1, maxValue: 1_000_000 } as const;
    const pointsAmount = { name: 'amount', description: `How many ${s.pointsName}`, type: OptionType.Integer, required: true, minValue: 1, maxValue: 10_000_000 } as const;
    return {
      name: LOYALTY_COMMANDS.manage,
      description,
      origin: 'default',
      ephemeral: true,
      audit: true,
      subcommands: [
        { name: 'add-xp', description: 'Give a member XP', options: [user, xpAmount, reason] },
        { name: 'remove-xp', description: 'Take XP from a member', options: [user, xpAmount, reason] },
        { name: 'add-points', description: `Give a member ${s.pointsName}`.slice(0, 100), options: [user, pointsAmount, reason] },
        { name: 'remove-points', description: `Take ${s.pointsName} from a member`.slice(0, 100), options: [user, pointsAmount, reason] },
        { name: 'reset-user', description: `Set a member’s XP and ${s.pointsName} back to 0`.slice(0, 100), options: [user] },
        { name: 'reset-leaderboard', description: 'Set everyone’s XP in this server back to 0' },
      ],
      execute: (ctx) => this.runManage(ctx),
    };
  }

  private runManage(ctx: CommandContext): CommandReply {
    const s = this.settings();
    const sub = ctx.subcommand;
    if ((sub === 'add-xp' || sub === 'remove-xp' || sub === 'reset-leaderboard') && !s.xp.enabled) throw new CommandError('XP & levels are off in Loyalty & Rewards.');
    if (sub === 'reset-leaderboard') return this.askResetLeaderboard(ctx);
    const userId = String(ctx.options.get('user'));
    const name = ctx.optionLabels.get('user') ?? null;
    const who = name ? `**${escapeMarkdown(name)}**` : `<@${userId}>`;
    const given = ctx.options.get('reason');
    const why = (typeof given === 'string' && given.trim().length >= 3 ? given.trim() : `/loyalty ${sub} by ${ctx.userName}`).slice(0, 200);
    const amount = Number(ctx.options.get('amount') ?? 0);
    const n = (v: number) => v.toLocaleString('en-US');
    try {
      if (sub === 'add-xp' || sub === 'remove-xp') {
        if (sub === 'add-xp') loyaltyLevelsRepo.ensure(this.o.db, ctx.guildId, userId, name, this.iso());
        else if (!loyaltyLevelsRepo.get(this.o.db, ctx.guildId, userId)) throw new CommandError(`${who} has no XP here.`);
        this.adjustXp({ guildId: ctx.guildId, userId, amount: sub === 'add-xp' ? amount : -amount, reason: why });
        const m = loyaltyLevelsRepo.get(this.o.db, ctx.guildId, userId)!;
        return { content: `${sub === 'add-xp' ? 'Gave' : 'Took'} ${n(amount)} XP ${sub === 'add-xp' ? 'to' : 'from'} ${who}. They now have ${n(m.xp)} XP (level ${m.level}).`, ephemeral: true };
      }
      if (sub === 'add-points' || sub === 'remove-points') {
        if (sub === 'add-points') loyaltyRepo.ensureAccount(this.o.db, 'discord', userId, name, this.iso());
        else if (!loyaltyRepo.getAccount(this.o.db, 'discord', userId)) throw new CommandError(`${who} has no ${s.pointsName}.`);
        const h = this.adjustPoints({ userId, amount: sub === 'add-points' ? amount : -amount, reason: why });
        return {
          content: `${sub === 'add-points' ? 'Gave' : 'Took'} ${formatPoints(amount, s.pointsName)} ${sub === 'add-points' ? 'to' : 'from'} ${who}. They now have ${formatPoints(h.points.balance, s.pointsName)}.`,
          ephemeral: true,
        };
      }
      return this.resetUser(ctx, userId, who, s);
    } catch (err) {
      if (err instanceof AppError) throw new CommandError(err.options.issues?.[0]?.message ?? err.message);
      throw err;
    }
  }

  /** A member's XP in this server and their points back to 0 (recorded as adjustments in their history). */
  private resetUser(ctx: CommandContext, userId: string, who: string, s: LoyaltySettings): CommandReply {
    const reason = `Reset with /loyalty by ${ctx.userName}`.slice(0, 200);
    const at = this.iso();
    let before: { xp: number; points: number } = { xp: 0, points: 0 };
    withTransaction(this.o.db, () => {
      const m = loyaltyLevelsRepo.get(this.o.db, ctx.guildId, userId);
      const a = loyaltyRepo.getAccount(this.o.db, 'discord', userId);
      before = { xp: m?.xp ?? 0, points: a?.balance ?? 0 };
      if (m && m.xp > 0) {
        loyaltyLevelsRepo.applyXp(this.o.db, { id: crypto.randomUUID(), guildId: ctx.guildId, userId, amount: -m.xp, levelFor: levelForXp, kind: 'adjustment', reason, eventKey: null, contentHash: null, at });
        loyaltyLevelsRepo.resetAnnouncements(this.o.db, ctx.guildId, userId);
      }
      if (a && a.balance > 0) {
        loyaltyRepo.applyChange(this.o.db, { id: crypto.randomUUID(), platform: 'discord', userId, amount: -a.balance, kind: 'adjustment', reason, eventKey: null, redemptionId: null, at });
      }
      if (before.xp > 0 || before.points > 0) this.audit('loyalty.reset', { guildId: ctx.guildId, userId, xp: before.xp, points: before.points });
    });
    if (before.xp === 0 && before.points === 0) throw new CommandError(`${who} has no XP or ${s.pointsName} to reset.`);
    const userName = ctx.optionLabels.get('user') ?? loyaltyLevelsRepo.get(this.o.db, ctx.guildId, userId)?.displayName ?? null;
    this.tell({ kind: 'reset', guildId: ctx.guildId, userId, userName, xp: before.xp, points: before.points, members: null, by: ctx.userName });
    const n = (v: number) => v.toLocaleString('en-US');
    return {
      content: `Reset ${who}: ${n(before.xp)} XP and ${formatPoints(before.points, s.pointsName)} → 0. Level roles they already have are kept.`,
      ephemeral: true,
    };
  }

  /** The first step of /loyalty reset-leaderboard: a Confirm button only the admin who asked sees. */
  private askResetLeaderboard(ctx: CommandContext): CommandReply {
    const members = loyaltyLevelsRepo.withXp(this.o.db, ctx.guildId).length;
    if (members === 0) throw new CommandError('Nobody has XP in this server yet.');
    const now = this.o.now().getTime();
    for (const [k, p] of this.pendingResets) if (p.expires < now) this.pendingResets.delete(k);
    const nonce = crypto.randomBytes(16).toString('hex');
    this.pendingResets.set(nonce, { guildId: ctx.guildId, userId: ctx.userId, userName: ctx.userName, expires: now + RESET_CONFIRM_MS });
    return {
      content: `This sets the XP of all ${members.toLocaleString('en-US')} members with XP in this server back to 0 (points aren’t changed, and level roles they have are kept). It can’t be undone. Confirm within 2 minutes:`,
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Reset everyone’s XP', custom_id: `${RESET_BUTTON_PREFIX}${nonce}` }] }],
      ephemeral: true,
    };
  }

  /** The Confirm button of /loyalty reset-leaderboard. False for any other button. */
  async onButton(b: IncomingButton): Promise<boolean> {
    if (typeof b.customId !== 'string' || !b.customId.startsWith(RESET_BUTTON_PREFIX)) return false;
    const nonce = b.customId.slice(RESET_BUTTON_PREFIX.length);
    const pending = /^[0-9a-f]{32}$/.test(nonce) ? this.pendingResets.get(nonce) : undefined;
    if (!pending || pending.expires < this.o.now().getTime() || pending.guildId !== b.guildId || pending.userId !== b.userId) {
      await b.reply('This confirmation has expired. Run /loyalty reset-leaderboard again.').catch(() => undefined);
      return true;
    }
    this.pendingResets.delete(nonce);
    const reason = `Leaderboard reset with /loyalty by ${pending.userName}`.slice(0, 200);
    const at = this.iso();
    let count = 0;
    withTransaction(this.o.db, () => {
      for (const m of loyaltyLevelsRepo.withXp(this.o.db, pending.guildId)) {
        loyaltyLevelsRepo.applyXp(this.o.db, { id: crypto.randomUUID(), guildId: pending.guildId, userId: m.userId, amount: -m.xp, levelFor: levelForXp, kind: 'adjustment', reason, eventKey: null, contentHash: null, at });
        count++;
      }
      loyaltyLevelsRepo.resetAnnouncements(this.o.db, pending.guildId, null);
      this.audit('loyalty.reset', { guildId: pending.guildId, members: count, leaderboard: true });
    });
    this.o.logger.info('loyalty leaderboard reset', { members: count });
    this.tell({ kind: 'reset', guildId: pending.guildId, userId: null, userName: null, xp: 0, points: 0, members: count, by: pending.userName });
    await b.reply(`Done: the XP of ${count.toLocaleString('en-US')} members is back to 0.`).catch(() => undefined);
    return true;
  }

  /**
   * /level as an embed (shown only to the member who asked): a member's level, a progress bar to the next one, their
   * place on the leaderboard, total XP and points.
   */
  private async levelEmbed(guildId: string, userId: string, name: string | null, self: boolean): Promise<Record<string, unknown>> {
    const s = this.settings();
    const n = (v: number) => v.toLocaleString('en-US');
    const who = name ?? 'This member';
    const m = loyaltyLevelsRepo.get(this.o.db, guildId, userId);
    if (!m || m.xp === 0) {
      return {
        author: { name: who },
        title: 'Level 0',
        description: self ? 'You haven’t earned any XP here yet. Chat to start levelling up!' : `<@${userId}> hasn’t earned any XP here yet.`,
        color: LEVEL_COLOR,
      };
    }
    const p = levelProgress(m.xp);
    const rank = loyaltyLevelsRepo.rank(this.o.db, guildId, userId);
    const ranked = loyaltyLevelsRepo.withXp(this.o.db, guildId).length;
    const filled = Math.min(PROGRESS_SEGMENTS, Math.round((p.xpIntoLevel / Math.max(1, p.xpForNext)) * PROGRESS_SEGMENTS));
    const percent = Math.floor((p.xpIntoLevel / Math.max(1, p.xpForNext)) * 100);
    return {
      author: { name: who },
      title: `Level ${p.level}`,
      description: `${'▰'.repeat(filled)}${'▱'.repeat(PROGRESS_SEGMENTS - filled)} ${percent}%\n-# ${n(p.xpIntoLevel)} / ${n(p.xpForNext)} XP to level ${p.level + 1}`,
      fields: [
        { name: 'Rank', value: rank ? `#${n(rank)} of ${n(ranked)}` : '—', inline: true },
        { name: 'Total XP', value: n(m.xp), inline: true },
        { name: s.pointsName.charAt(0).toUpperCase() + s.pointsName.slice(1), value: n(this.balance(userId)), inline: true },
      ],
      color: LEVEL_COLOR,
    };
  }

  /**
   * /leaderboard as an embed (shown only to the member who asked): the top members with medals for the first three
   * (each member's own place is on /level).
   */
  private async leaderboardEmbed(guildId: string, userId: string): Promise<Record<string, unknown>> {
    const { rows } = loyaltyLevelsRepo.members(this.o.db, { guildId, query: null, sort: 'xp', limit: LEADERBOARD_SIZE, offset: 0 });
    const ranked = rows.filter((r) => r.xp > 0);
    const server = (await this.o.discordChannels().catch(() => null))?.guilds.find((g) => g.id === guildId)?.name ?? null;
    const n = (v: number) => v.toLocaleString('en-US');
    const lines = ranked.map((r, i) => {
      const place = ['🥇', '🥈', '🥉'][i] ?? `\`#${i + 1}\``;
      const name = escapeMarkdown(r.displayName ?? 'Unknown member');
      return `${place} **${name}**${r.userId === userId ? ' *(you)*' : ''}\n-# Level ${r.level} · ${n(r.xp)} XP`;
    });
    return {
      title: '🏆 Leaderboard',
      ...(server ? { author: { name: server } } : {}),
      description: (lines.length ? lines.join('\n') : 'Nobody has earned XP here yet. Be the first!').slice(0, 4000),
      color: 0xf1c40f,
      footer: { text: `Top ${LEADERBOARD_SIZE} by XP · your level: /level` },
      timestamp: this.o.now().toISOString(),
    };
  }

  /** Enabled, in-stock rewards; null when there are none. */
  private rewardsText(s: LoyaltySettings): string | null {
    const list = loyaltyRepo.listRewards(this.o.db).filter((r) => r.enabled && r.stock !== 0);
    if (list.length === 0) return null;
    return `Rewards (redeem with /redeem):\n${list.map((r) => `• ${r.name} — ${formatPoints(r.cost, s.pointsName)}`).join('\n')}`.slice(0, 1900);
  }

  /** Loyalty command names that a runnable custom Discord command already uses. */
  private conflicts(): string[] {
    return Object.values(LOYALTY_COMMANDS)
      .map((c) => `/${c}`)
      .filter((t) => this.o.customCommands.findRunnable('discord', t) !== null);
  }

  private discordCommandNames(): string[] {
    return this.slashCommands().map((c) => c.name);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private activeReward(id: string): LoyaltyRewardRecord {
    const r = /^[0-9a-f-]{36}$/i.test(id) ? loyaltyRepo.getReward(this.o.db, id) : undefined;
    if (!r || r.archivedAt) throw notFound('Reward');
    return r;
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const clash = loyaltyRepo.findRewardByName(this.o.db, name);
    if (clash && clash.id !== exceptId) {
      throw new AppError('conflict', `${name} already exists`, { issues: [{ path: 'name', message: 'A reward with this name already exists.' }] });
    }
  }

  private notPending(id: string): AppError {
    return loyaltyRepo.getRedemption(this.o.db, id) ? new AppError('conflict', 'This redemption was already handled.') : notFound('Redemption');
  }

  /**
   * Loyalty & Rewards entries for Discord Bot → Logs → Moderation log, newest first: points changes, XP adjustments
   * (with the member, the change and its reason) and changes to settings, rewards, redemptions and role rewards. The
   * audit log's own "XP adjusted" and "Points adjusted" lines aren't repeated (the histories have the details).
   */
  async logEntries(): Promise<LoyaltyLogEntry[]> {
    const s = this.settings();
    const names = new Map((await this.guilds()).map((g) => [g.id, g.name]));
    const place = (guildId: string | null) => (guildId ? (names.get(guildId) ?? guildId) : null);
    const n = (v: number) => v.toLocaleString('en-US');
    const signed = (v: number) => `${v > 0 ? '+' : '−'}${n(Math.abs(v))}`;
    const pointsTitle: Record<LoyaltyTransactionView['kind'], string> = {
      chat: `${capitalize(s.pointsName)} earned`,
      adjustment: `${capitalize(s.pointsName)} adjusted`,
      redemption: 'Reward redeemed',
      refund: `${capitalize(s.pointsName)} refunded`,
    };
    const points: LoyaltyLogEntry[] = loyaltyRepo.recentTransactions(this.o.db, LOG_POINTS).map((t) => ({
      id: `loyalty-points-${t.id}`,
      at: t.createdAt,
      title: pointsTitle[t.kind],
      place: null,
      userId: t.userId,
      userName: t.platform === 'kick' ? `${t.displayName ?? t.userId} (Kick, older)` : (t.displayName ?? null),
      change: `${signed(t.amount)} ${s.pointsName} · balance ${n(t.balanceAfter)}`,
      reason: t.reason,
      detail: null,
    }));
    const xp: LoyaltyLogEntry[] = loyaltyLevelsRepo.recentAdjustments(this.o.db, LOG_XP).map((e) => ({
      id: `loyalty-xp-${e.id}`,
      at: e.createdAt,
      title: 'XP adjusted',
      place: place(e.guildId),
      userId: e.userId,
      userName: e.displayName ?? null,
      change: `${signed(e.amount)} XP · level ${e.levelAfter}`,
      reason: e.reason,
      detail: null,
    }));
    const changes: LoyaltyLogEntry[] = auditRepo
      .listByPrefix(this.o.db, 'loyalty.', LOG_CHANGES)
      // Points and XP adjustments are already listed from their histories (with the change and reason).
      .filter((a) => a.action !== 'loyalty.xp_adjusted' && a.action !== 'loyalty.adjusted')
      .map((a, i) => {
        const v = this.auditView(a.occurredAt, a.action, a.metadata, names);
        return {
          id: `loyalty-change-${a.occurredAt}-${i}`,
          at: v.at,
          title: AUDIT_TITLE[v.action] ?? v.action,
          place: place(v.guildId),
          userId: v.userId,
          userName: v.displayName,
          change: null,
          reason: null,
          detail: v.detail || null,
        };
      });
    return [...points, ...xp, ...changes].sort((a, b) => b.at.localeCompare(a.at));
  }

  /** An audit record for the logs: the member and server it was about (shown by name) and the rest as details. */
  private auditView(at: string, action: string, metadata: string, guildNames: ReadonlyMap<string, string | null>): LoyaltyAuditEntry {
    const id = (v: unknown) => (typeof v === 'string' && /^\d{1,25}$/.test(v) ? v : null);
    let userId: string | null = null;
    let guildId: string | null = null;
    try {
      const m = JSON.parse(metadata) as { userId?: unknown; guildId?: unknown };
      userId = id(m.userId);
      guildId = id(m.guildId);
    } catch {
      // nothing to show
    }
    const displayName = userId
      ? (loyaltyRepo.getAccount(this.o.db, 'discord', userId)?.displayName ?? loyaltyLevelsRepo.forUser(this.o.db, userId).find((l) => l.displayName)?.displayName ?? null)
      : null;
    return { at, action, detail: auditDetail(metadata, ['userId', 'guildId']), userId, displayName, guildId, guildName: guildId ? (guildNames.get(guildId) ?? null) : null };
  }

  private audit(action: Extract<AuditAction, `loyalty.${string}`>, metadata: Record<string, unknown>): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata }, this.o.now());
  }

  private iso(): string {
    return this.o.now().toISOString();
  }
}

function redeemText(r: RedeemOutcome, rewardName: string, s: LoyaltySettings): string {
  switch (r.outcome) {
    case 'redeemed':
      return `You redeemed ${r.redemption.rewardName} for ${formatPoints(r.redemption.cost, s.pointsName)}. It’s waiting for the streamer. You have ${formatPoints(r.balance, s.pointsName)} left.`;
    case 'insufficient':
      return `You need ${formatPoints(r.cost, s.pointsName)} for that (you have ${formatPoints(r.balance, s.pointsName)}).`;
    case 'unknown_reward':
      return `There’s no reward called "${[...rewardName].slice(0, 40).join('')}". /rewards lists them.`;
    case 'unavailable':
      return 'That reward isn’t available right now.';
    case 'out_of_stock':
      return 'That reward is sold out.';
    case 'duplicate':
      return 'That redemption was already made.';
  }
}

/** A readable reason a role couldn't be given or checked (never a token or raw response). */
function roleError(err: unknown): string {
  if (err instanceof DiscordApiError) {
    if (err.discordCode === 10007) return 'The member isn’t in the server any more.';
    if (err.discordCode === 10011) return 'The role no longer exists.';
    if (err.kind === 'forbidden') return 'Discord refused: the bot needs Manage Roles, and its highest role must be above this role.';
    if (err.kind === 'rate_limited') return 'Discord is rate limiting requests; it will be tried again at the next level-up.';
    if (err.kind === 'network') return 'Discord couldn’t be reached.';
    return err.message;
  }
  return 'Something went wrong.';
}

/** A member's name shown as written, so characters like * or _ in it don't turn into Discord formatting. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>#-]/g, '\\$&');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function progressOf(xp: number) {
  const p = levelProgress(xp);
  return { level: p.level, xpIntoLevel: p.xpIntoLevel, xpForNext: p.xpForNext };
}

/** A short, non-sensitive summary of an audit record's metadata. */
function auditDetail(metadata: string, leaveOut: readonly string[] = []): string {
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>;
    return Object.entries(m)
      .filter(([k, v]) => !leaveOut.includes(k) && v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ')
      .slice(0, 300);
  } catch {
    return '';
  }
}

const transactionView = (t: LoyaltyTransactionRecord & { displayName?: string | null }): LoyaltyTransactionView => ({
  id: t.id,
  platform: t.platform,
  userId: t.userId,
  ...(t.displayName !== undefined ? { displayName: t.displayName } : {}),
  amount: t.amount,
  balanceAfter: t.balanceAfter,
  kind: t.kind,
  reason: t.reason,
  createdAt: t.createdAt,
});

const xpEventView = (e: LoyaltyXpEventRecord & { displayName?: string | null }): LoyaltyXpEventView => ({
  id: e.id,
  guildId: e.guildId,
  userId: e.userId,
  ...(e.displayName !== undefined ? { displayName: e.displayName } : {}),
  amount: e.amount,
  xpAfter: e.xpAfter,
  levelAfter: e.levelAfter,
  kind: e.kind,
  reason: e.reason,
  createdAt: e.createdAt,
});

const rewardView = (r: LoyaltyRewardRecord): LoyaltyRewardView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  cost: r.cost,
  enabled: r.enabled,
  stock: r.stock,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const redemptionView = (r: LoyaltyRedemptionRecord): LoyaltyRedemptionView => ({
  id: r.id,
  rewardId: r.rewardId,
  rewardName: r.rewardName,
  platform: r.platform,
  userId: r.userId,
  displayName: r.displayName,
  cost: r.cost,
  status: r.status,
  note: r.note,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});
