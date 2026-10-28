/**
 * Discord Automated Protection (Discord Bot → Protection). Two separate systems with separate APIs (see
 * packages/shared/src/discord/discord-protection.ts):
 *
 * 1. AutoMod — CONDUIT's own rules (custom words, mention spam, member names; discord-automod.ts), checked on the
 *    gateway's events. Discord's built-in AutoMod isn't used or changed.
 * 2. CONDUIT protection — message checks on the gateway's message events (repeats, flooding, caps, invite links),
 *    acting through Discord's REST API (delete the message, time out). Only while CONDUIT runs; off by default and every
 *    check starts on "log only". Message text is looked at in memory only and never stored.
 *
 * 3. CONDUIT protection — anti-nuke on the audit log (discord-antinuke.ts).
 * 4. CONDUIT protection — anti-raid, lockdown and the join gate (discord-antiraid.ts); Verify is an Embed Creator button action.
 * 5. CONDUIT protection — bot bait: trap channels (discord-botbait.ts).
 *
 * Everything CONDUIT protection notices or does is recorded (discord_protection_events) for Discord Bot → Logs.
 */
import crypto from 'node:crypto';
import { discordProtectionEventsRepo, discordRepo, settingsRepo, SETTING_KEYS, type Database, type DiscordProtectionEventRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  MESSAGE_CHECK_LABEL,
  MESSAGE_CHECKS_DEFAULTS,
  messageChecksSchema,
  textCheck,
  type DiscordAutomodGuild,
  type DiscordAutomodRule,
  type DiscordChannelsState,
  type DiscordProtectionState,
  type MessageCheck,
  type MessageChecks,
  type ProtectionAction,
} from '@conduit/shared';
import { writeAudit } from '../../audit';
import { notFound } from '../../errors';
import { DiscordApiError, type DiscordApi } from '../discord-api';
import { describeDiscordFailure } from '../discord-errors';
import type { DiscordCredentials } from '../discord-credentials';
import type { GuildEvent } from '../discord-bot';
import { parseInput } from '../../validation';
import { DiscordAntiNuke } from './discord-antinuke';
import { DiscordAutoMod } from './discord-automod';
import { DiscordAntiRaid } from './discord-antiraid';
import { DiscordBotBait } from './discord-botbait';
import type { DiscordPoster } from '../discord-poster';

const ROLES_CACHE_MS = 30_000;
/** One action per member and check per this long, so a burst gets one response, not dozens. */
const ACTION_COOLDOWN_MS = 30_000;
const HISTORY_PER_MEMBER = 60;
const MEMBERS_TRACKED = 5_000;
const QUEUE_LIMIT = 50;

type MessageEvent = Extract<GuildEvent, { type: 'message_create' }>;

export interface DiscordProtectionServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<
    DiscordApi,
    | 'guildRoles'
    | 'deleteMessage'
    | 'timeoutMember'
    | 'guildOwner'
    | 'guildMember'
    | 'guildMemberRoles'
    | 'setMemberRoles'
    | 'kickMember'
    | 'banMember'
    | 'guildVerificationLevel'
    | 'setGuildVerificationLevel'
    | 'guildChannels'
    | 'setChannelOverwrite'
    | 'deleteChannelOverwrite'
    | 'addMemberRole'
    | 'unbanMember'
  >;
  poster: Pick<DiscordPoster, 'post' | 'delete'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
  /** Whether the bot's connection receives message text (the required Message Content intent). */
  messageContent: () => boolean;
}

export class DiscordProtectionService {
  private readonly rolesCache = new Map<string, { at: number; roles: Array<{ id: string; name: string }> }>();
  private readonly history = new Map<string, Array<{ at: number; hash: string | null }>>();
  private readonly cooldowns = new Map<string, number>();
  private readonly stats = { checked: 0, matched: 0, since: '' };
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  readonly automod: DiscordAutoMod;
  readonly antinuke: DiscordAntiNuke;
  readonly antiraid: DiscordAntiRaid;
  readonly botbait: DiscordBotBait;

  constructor(private readonly o: DiscordProtectionServiceOptions) {
    this.stats.since = o.now().toISOString();
    this.automod = new DiscordAutoMod({ db: o.db, now: o.now, logger: o.logger, credentials: o.credentials, api: o.api, poster: o.poster, botUserId: () => this.botUserId() });
    this.antinuke = new DiscordAntiNuke({ db: o.db, now: o.now, logger: o.logger, credentials: o.credentials, api: o.api, poster: o.poster, botUserId: () => this.botUserId() });
    this.antiraid = new DiscordAntiRaid({
      db: o.db,
      now: o.now,
      logger: o.logger,
      credentials: o.credentials,
      api: o.api,
      poster: o.poster,
      discordChannels: () => o.discordChannels(),
      botUserId: () => this.botUserId(),
    });
    this.botbait = new DiscordBotBait({
      db: o.db,
      now: o.now,
      logger: o.logger,
      credentials: o.credentials,
      api: o.api,
      poster: o.poster,
      discordChannels: () => o.discordChannels(),
      botUserId: () => this.botUserId(),
    });
  }

  // ── state ──────────────────────────────────────────────────────────────────

  messageChecks(): MessageChecks {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordMessageChecks);
    if (!raw) return structuredClone(MESSAGE_CHECKS_DEFAULTS);
    try {
      const parsed = messageChecksSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    this.o.logger.warn('stored discord message checks are invalid; using the defaults');
    return structuredClone(MESSAGE_CHECKS_DEFAULTS);
  }

  async state(): Promise<DiscordProtectionState> {
    const channels = await this.o.discordChannels().catch(() => null);
    const token = await this.o.credentials.botToken();
    const guilds: DiscordAutomodGuild[] = [];
    const rules = this.automod.rules();
    for (const g of channels?.guilds ?? []) {
      guilds.push({
        id: g.id,
        name: g.name,
        rules: rules.filter((r) => r.guildId === g.id),
        roles: token ? await this.roles(token, g.id) : [],
        channels: g.channels.map((c) => ({ id: c.id, name: c.name })),
      });
    }
    const names = new Map(guilds.map((g) => [g.id, g.name]));
    const roleNames = new Map(guilds.flatMap((g) => g.roles.map((r) => [r.id, r.name] as const)));
    return {
      botbait: this.botbait.settings(),
      antiraid: this.antiraid.settings(),
      lockdowns: this.antiraid.lockdowns(names),
      antinuke: this.antinuke.settings(),
      quarantine: this.antinuke.quarantine().map((q) => ({
        id: q.id,
        at: q.createdAt,
        guildId: q.guildId,
        place: names.get(q.guildId) ?? null,
        userId: q.userId,
        userName: q.userName,
        roles: q.roles.map((id) => ({ id, name: roleNames.get(id) ?? null })),
        reason: q.reason,
        status: q.status,
        resolvedAt: q.resolvedAt,
      })),
      messageChecks: this.messageChecks(),
      automod: { guilds, problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.') },
      stats: { ...this.stats },
      messageContent: this.o.messageContent(),
    };
  }

  saveMessageChecks(raw: unknown): MessageChecks {
    const next = parseInput(messageChecksSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.discordMessageChecks, JSON.stringify(next), this.o.now().toISOString());
    writeAudit(this.o.db, { action: 'discord.protection.messages_updated', outcome: 'success', actorUserId: null, metadata: { enabled: next.enabled } }, this.o.now());
    this.o.logger.info('discord message checks saved', { enabled: next.enabled });
    return next;
  }

  // ── 1. AutoMod (CONDUIT's own rules; discord-automod.ts) ──────────────────

  /** A server's roles for the exemption pickers (highest first, without @everyone); none when Discord can't say. */
  private async roles(token: string, guildId: string): Promise<Array<{ id: string; name: string }>> {
    const hit = this.rolesCache.get(guildId);
    const now = this.o.now().getTime();
    if (hit && now - hit.at < ROLES_CACHE_MS) return hit.roles;
    const roles = await this.o.api
      .guildRoles(token, guildId)
      .then((list) => list.filter((r) => r.id !== guildId).sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map((r) => ({ id: r.id, name: r.name || r.id })))
      .catch(() => hit?.roles ?? []);
    this.rolesCache.set(guildId, { at: now, roles });
    return roles;
  }

  /** Rules are only made for servers the bot is in. */
  private async knownGuild(guildId: string): Promise<void> {
    const channels = await this.o.discordChannels().catch(() => null);
    if (!channels?.guilds.some((g) => g.id === guildId)) throw notFound('Discord server');
  }

  async createRule(guildId: string, raw: unknown): Promise<DiscordAutomodRule> {
    await this.knownGuild(guildId);
    return this.automod.create(guildId, raw);
  }

  async updateRule(guildId: string, ruleId: string, raw: unknown): Promise<DiscordAutomodRule> {
    return this.automod.update(guildId, ruleId, raw);
  }

  async setRuleEnabled(guildId: string, ruleId: string, enabled: boolean): Promise<DiscordAutomodRule> {
    return this.automod.setEnabled(guildId, ruleId, enabled);
  }

  async deleteRule(guildId: string, ruleId: string): Promise<void> {
    this.automod.delete(guildId, ruleId);
  }

  private botUserId(): string | null {
    return discordRepo.getApplication(this.o.db)?.botUserId ?? null;
  }

  // ── 2. CONDUIT protection: message checks (gateway + REST) ─────────────────

  /** Every server message from the gateway (the bot's own and other bots' are skipped). */
  onDiscordEvent(e: GuildEvent): void {
    if (e.type === 'audit' || e.type === 'audit_change') return this.antinuke.onDiscordEvent(e);
    if (e.type === 'member_join' || e.type === 'member_update') {
      try {
        this.automod.onMember(e);
      } catch (err) {
        this.o.logger.error('discord automod check failed', { err });
      }
      if (e.type === 'member_join') this.antiraid.onDiscordEvent(e);
      return;
    }
    if (e.type !== 'message_create') return;
    try {
      // A post in a bait channel is bot bait's; a message an AutoMod rule acted on is AutoMod's. The checks skip both.
      if (this.botbait.onMessage(e)) return;
      if (this.automod.onMessage(e)) return;
      this.check(e);
    } catch (err) {
      this.o.logger.error('discord message check failed', { err });
    }
  }

  private check(e: MessageEvent): void {
    const s = this.messageChecks();
    if (!s.enabled || e.authorBot || e.system) return;
    if (e.authorId === this.botUserId()) return;
    if (s.exemptChannels.includes(e.channelId)) return;
    if (s.exemptModerators && e.authorModerator) return;
    if (e.authorRoleIds?.some((r) => s.exemptRoles.includes(r))) return;
    this.stats.checked++;

    const now = this.o.now().getTime();
    const key = `${e.guildId}:${e.authorId}`;
    const keep = Math.max(s.repeat.windowSeconds, s.flood.windowSeconds) * 1000;
    const list = (this.history.get(key) ?? []).filter((m) => now - m.at <= keep);
    list.push({ at: now, hash: e.contentHash ?? null });
    if (list.length > HISTORY_PER_MEMBER) list.shift();
    this.history.delete(key);
    this.history.set(key, list);
    if (this.history.size > MEMBERS_TRACKED) this.history.delete(this.history.keys().next().value!);

    let match: { check: MessageCheck; detail: string } | null = e.content ? textCheck(e.content, s) : null;
    if (!match && s.repeat.enabled && e.contentHash) {
      const same = list.filter((m) => m.hash === e.contentHash && now - m.at <= s.repeat.windowSeconds * 1000).length;
      if (same >= s.repeat.count) match = { check: 'repeat', detail: `Sent the same message ${same} times within ${s.repeat.windowSeconds} s.` };
    }
    if (!match && s.flood.enabled) {
      const recent = list.filter((m) => now - m.at <= s.flood.windowSeconds * 1000).length;
      if (recent > s.flood.maxMessages) match = { check: 'flood', detail: `${recent} messages within ${s.flood.windowSeconds} s.` };
    }
    if (!match) return;

    const cooldownKey = `${key}:${match.check}`;
    if ((this.cooldowns.get(cooldownKey) ?? 0) > now) return;
    this.cooldowns.set(cooldownKey, now + ACTION_COOLDOWN_MS);
    if (this.cooldowns.size > MEMBERS_TRACKED) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);
    if (match.check === 'repeat' || match.check === 'flood') this.history.set(key, []);
    this.stats.matched++;

    const rule = s[match.check];
    if (this.queued >= QUEUE_LIMIT) {
      this.record(e, match.check, rule.action, 'failed', 'Skipped: too many actions at once.');
      return;
    }
    this.queued++;
    this.queue = this.queue
      .then(() => this.act(e, match!.check, rule.action, rule.timeoutMinutes, match!.detail))
      .catch((err) => this.o.logger.error('discord protection action failed', { err }))
      .finally(() => this.queued--);
  }

  private async act(e: MessageEvent, check: MessageCheck, action: ProtectionAction, timeoutMinutes: number, detail: string): Promise<void> {
    if (action === 'log') return this.record(e, check, action, 'logged', detail);
    const token = await this.o.credentials.botToken();
    if (!token) return this.record(e, check, action, 'failed', 'The Discord bot isn’t set up.');
    const reason = `CONDUIT protection: ${MESSAGE_CHECK_LABEL[check]}`;
    try {
      await this.o.api.deleteMessage(token, e.channelId, e.messageId, reason).catch((err) => {
        // Already gone (deleted by the member, AutoMod or a moderator): nothing to delete.
        if (!(err instanceof DiscordApiError && err.kind === 'not_found')) throw err;
      });
      if (action === 'timeout') {
        const until = new Date(this.o.now().getTime() + timeoutMinutes * 60_000).toISOString();
        await this.o.api.timeoutMember(token, e.guildId, e.authorId, until, reason);
      }
      this.record(e, check, action, 'success', action === 'timeout' ? `${detail} Timed out for ${timeoutMinutes} min.` : detail);
    } catch (err) {
      this.record(e, check, action, 'failed', `${detail} ${describe(err)}`);
    }
  }

  private record(e: MessageEvent, rule: string, action: string, outcome: DiscordProtectionEventRecord['outcome'], detail: string): void {
    try {
      discordProtectionEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId: e.guildId,
        feature: 'message',
        rule,
        userId: e.authorId,
        userName: e.authorName ?? null,
        channelId: e.channelId,
        action,
        outcome,
        detail,
      });
    } catch (err) {
      this.o.logger.warn('could not record a protection event', { err });
    }
  }

  /** Waits until queued actions are done (tests). */
  async idle(): Promise<void> {
    await this.queue;
    await this.automod.idle();
    await this.antinuke.idle();
    await this.antiraid.idle();
    await this.botbait.idle();
  }
}

/** A Discord failure in plain words. */
function describe(err: unknown): string {
  return describeDiscordFailure(err, {
    forbidden: 'Discord refused: the bot needs Manage Messages / Timeout Members for the actions, and its role must be above the member’s.',
    notFound: 'Discord couldn’t find it (it may have been deleted).',
  });
}
