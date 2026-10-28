/**
 * CONDUIT protection — anti-raid and the join gate (Discord Bot → Protection). CONDUIT's own bot, from the gateway's
 * member joins, acting through Discord's REST API. Works only while CONDUIT runs.
 *
 * - Join bursts: more joins than allowed within a window is a raid alert; in Enforce mode it starts a lockdown.
 * - Lockdown: raises the server's verification level and/or stops @everyone sending messages in chosen channels. What
 *   was there before is saved (app_settings) and put back when the lockdown lifts: automatically after a quiet period,
 *   or by hand. Lockdowns can also be raised by hand.
 * - Join gate: new accounts younger than a minimum age, or without a profile picture, are reported, kicked, or "held"
 *   (Verify buttons — an action of Embed Creator buttons — won't let them in; Verify is also paused during a lockdown).
 *
 * Off by default; switched on, bursts start on "Alert only". Everything is recorded for Discord Bot → Logs. Messages
 * members see carry no CONDUIT branding.
 */
import crypto from 'node:crypto';
import { discordProtectionEventsRepo, settingsRepo, SETTING_KEYS, type Database, type DiscordProtectionEventRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  ANTIRAID_DEFAULTS,
  antiraidSchema,
  joinGateProblem,
  missingDiscordPermissions,
  snowflakeCreatedAt,
  VERIFICATION_LEVEL_LABEL,
  VERIFICATION_LEVELS,
  type AntiraidSettings,
  type DiscordChannelsState,
  type LockdownView,
} from '@conduit/shared';
import { writeAudit } from '../../audit';
import { AppError } from '../../errors';
import { DiscordApiError, type DiscordApi } from '../discord-api';
import { describeDiscordFailure } from '../discord-errors';
import type { DiscordCredentials } from '../discord-credentials';
import type { GuildEvent } from '../discord-bot';
import { parseInput } from '../../validation';
import type { DiscordPoster } from '../discord-poster';

/** What a lockdown takes away from @everyone in a locked channel. */
export const LOCKED_PERMISSIONS =
  (1n << 11n) | // Send Messages
  (1n << 38n) | // Send Messages in Threads
  (1n << 35n) | // Create Public Threads
  (1n << 36n) | // Create Private Threads
  (1n << 6n); // Add Reactions

const TICK_MS = 15_000;

interface StoredLockdown {
  guildId: string;
  since: string;
  reason: string;
  manual: boolean;
  verification: { from: number; to: number } | null;
  /** The @everyone overwrite each locked channel had before (null: none), to put back on lift. */
  channels: Array<{ id: string; name: string | null; previous: { allow: string; deny: string } | null }>;
  problems: string[];
}

export interface DiscordAntiRaidOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<
    DiscordApi,
    'guildVerificationLevel' | 'setGuildVerificationLevel' | 'guildChannels' | 'setChannelOverwrite' | 'deleteChannelOverwrite' | 'kickMember' | 'addMemberRole' | 'guildRoles' | 'guildMemberRoles'
  >;
  poster: Pick<DiscordPoster, 'post'>;
  discordChannels: () => Promise<DiscordChannelsState>;
  botUserId: () => string | null;
}

export class DiscordAntiRaid {
  private readonly joins = new Map<string, number[]>();
  private readonly lastJoin = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: DiscordAntiRaidOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  settings(): AntiraidSettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordAntiraid);
    if (!raw) return structuredClone(ANTIRAID_DEFAULTS);
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      delete stored.verify;
      const parsed = antiraidSchema.safeParse(stored);
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    this.o.logger.warn('stored anti-raid settings are invalid; using the defaults');
    return structuredClone(ANTIRAID_DEFAULTS);
  }

  save(raw: unknown): AntiraidSettings {
    const checked = parseInput(antiraidSchema, raw);
    this.write(checked);
    writeAudit(this.o.db, { action: 'discord.protection.antiraid_updated', outcome: 'success', actorUserId: null, metadata: { enabled: checked.enabled, mode: checked.mode, gate: checked.gate.enabled } }, this.o.now());
    this.o.logger.info('anti-raid settings saved', { enabled: checked.enabled, mode: checked.mode });
    return checked;
  }

  private write(s: AntiraidSettings): void {
    settingsRepo.set(this.o.db, SETTING_KEYS.discordAntiraid, JSON.stringify(s), this.o.now().toISOString());
  }

  // ── lockdown state ─────────────────────────────────────────────────────────

  private stored(): Record<string, StoredLockdown> {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordLockdowns);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredLockdown>) : {};
    } catch {
      return {};
    }
  }

  private store(all: Record<string, StoredLockdown>): void {
    settingsRepo.set(this.o.db, SETTING_KEYS.discordLockdowns, JSON.stringify(all), this.o.now().toISOString());
  }

  lockdowns(names: Map<string, string>): LockdownView[] {
    const s = this.settings();
    return Object.values(this.stored()).map((l) => ({
      guildId: l.guildId,
      place: names.get(l.guildId) ?? null,
      since: l.since,
      reason: l.reason,
      manual: l.manual,
      liftAt: !l.manual && s.autoLiftMinutes > 0 ? new Date(this.lastActivity(l) + s.autoLiftMinutes * 60_000).toISOString() : null,
      verification: l.verification ? { from: VERIFICATION_LEVELS[l.verification.from] ?? 'none', to: VERIFICATION_LEVELS[l.verification.to] ?? 'none' } : null,
      lockedChannels: l.channels.map((c) => ({ id: c.id, name: c.name })),
      problems: l.problems,
    }));
  }

  private lastActivity(l: StoredLockdown): number {
    return Math.max(new Date(l.since).getTime(), this.lastJoin.get(l.guildId) ?? 0);
  }

  // ── events ─────────────────────────────────────────────────────────────────

  onDiscordEvent(e: GuildEvent): void {
    if (e.type !== 'member_join') return;
    try {
      this.onJoin(e);
    } catch (err) {
      this.o.logger.error('anti-raid check failed', { err });
    }
  }

  private onJoin(e: Extract<GuildEvent, { type: 'member_join' }>): void {
    const s = this.settings();
    const now = this.o.now().getTime();
    this.lastJoin.set(e.guildId, now);
    if (e.user.bot) return; // bots added to the server are anti-nuke's business

    // Join gate.
    if (s.gate.enabled) {
      const problem = joinGateProblem(s.gate, { createdAt: e.accountCreatedAt ? new Date(e.accountCreatedAt) : snowflakeCreatedAt(e.user.id), hasAvatar: e.hasAvatar ?? null }, this.o.now());
      if (problem) this.enqueue(() => this.gate(e.guildId, e.user.id, e.user.tag, problem, s));
    }

    // Join bursts.
    if (!s.enabled) return;
    const list = (this.joins.get(e.guildId) ?? []).filter((t) => now - t <= s.joinWindowSeconds * 1000);
    list.push(now);
    this.joins.set(e.guildId, list);
    if (list.length < s.joinThreshold || this.stored()[e.guildId]) return;
    this.joins.set(e.guildId, []);
    const detail = `${list.length} members joined within ${s.joinWindowSeconds} s.`;
    if (s.mode === 'alert') {
      this.record(e.guildId, 'antiraid', 'join_burst', null, 'alert', 'logged', detail);
      this.enqueue(() => this.alert(e.guildId, s, 'Raid alert: join burst', `${detail}\nAlert only — no lockdown was started.`, 0xf0b232));
      return;
    }
    this.enqueue(async () => {
      await this.lockdown(e.guildId, detail, false);
    });
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => this.o.logger.error('anti-raid action failed', { err }));
  }

  private async gate(guildId: string, userId: string, userName: string, problem: string, s: AntiraidSettings): Promise<void> {
    const who = `<@${userId}> **${userName}**`;
    if (s.gate.response === 'kick') {
      const token = await this.o.credentials.botToken();
      try {
        if (!token) throw new AppError('conflict', 'The Discord bot isn’t set up.');
        await this.o.api.kickMember(token, guildId, userId, `Join gate: ${problem}`);
        this.record(guildId, 'joingate', 'gate', { id: userId, name: userName }, 'kick', 'success', `Kicked: ${problem}.`);
        await this.alert(guildId, s, 'Join gate: member kicked', `${who}\n${capitalize(problem)}.`, 0xda373c);
      } catch (err) {
        this.record(guildId, 'joingate', 'gate', { id: userId, name: userName }, 'kick', 'failed', `${capitalize(problem)}. ${describeFailure(err)}`);
        await this.alert(guildId, s, 'Join gate: kick failed', `${who}\n${capitalize(problem)}.\n${describeFailure(err)}`, 0x80848e);
      }
      return;
    }
    const held = s.gate.response === 'hold';
    this.record(guildId, 'joingate', 'gate', { id: userId, name: userName }, held ? 'hold' : 'alert', held ? 'success' : 'logged', `${capitalize(problem)}.${held ? ' Held: Verify buttons won’t let them in.' : ''}`);
    await this.alert(guildId, s, held ? 'Join gate: member held' : 'Join gate: new member flagged', `${who}\n${capitalize(problem)}.${held ? '\nVerify buttons won’t let them in.' : ''}`, 0xf0b232);
  }

  // ── lockdown ───────────────────────────────────────────────────────────────

  /** Raises a lockdown by hand. */
  async raise(guildId: string, reason: string | null): Promise<void> {
    if (this.stored()[guildId]) throw new AppError('conflict', 'This server is already locked down.');
    await this.lockdown(guildId, reason?.trim() ? reason.trim().slice(0, 200) : 'Raised by hand.', true);
  }

  private async lockdown(guildId: string, reason: string, manual: boolean): Promise<void> {
    const s = this.settings();
    const token = await this.o.credentials.botToken();
    if (!token) throw new AppError('conflict', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    const audit = `Lockdown: ${reason}`.slice(0, 400);
    const l: StoredLockdown = { guildId, since: this.o.now().toISOString(), reason, manual, verification: null, channels: [], problems: [] };
    if (s.raiseVerification) {
      const target = VERIFICATION_LEVELS.indexOf(s.verificationLevel);
      try {
        const from = await this.o.api.guildVerificationLevel(token, guildId);
        if (from < target) {
          await this.o.api.setGuildVerificationLevel(token, guildId, target, audit);
          l.verification = { from, to: target };
        }
      } catch (err) {
        l.problems.push(`Verification level not raised: ${describeFailure(err)}`);
      }
    }
    if (s.lockChannels.length) {
      let channels: Awaited<ReturnType<DiscordApi['guildChannels']>> = [];
      try {
        channels = await this.o.api.guildChannels(token, guildId);
      } catch (err) {
        l.problems.push(`Channels not locked: ${describeFailure(err)}`);
      }
      for (const ch of channels.filter((c) => s.lockChannels.includes(c.id))) {
        const before = ch.overwrites.find((o) => o.id === guildId) ?? null;
        try {
          await this.o.api.setChannelOverwrite(token, ch.id, guildId, { type: 0, allow: (before?.allow ?? 0n) & ~LOCKED_PERMISSIONS, deny: (before?.deny ?? 0n) | LOCKED_PERMISSIONS }, audit);
          l.channels.push({ id: ch.id, name: ch.name, previous: before ? { allow: before.allow.toString(), deny: before.deny.toString() } : null });
        } catch (err) {
          l.problems.push(`#${ch.name} not locked: ${describeFailure(err)}`);
        }
      }
    }
    this.store({ ...this.stored(), [guildId]: l });
    this.lastJoin.set(guildId, this.o.now().getTime());
    const did = describeLockdown(l);
    this.record(guildId, 'antiraid', manual ? 'manual' : 'join_burst', null, 'lockdown', l.problems.length && !l.verification && !l.channels.length ? 'failed' : 'success', [reason, did, ...l.problems].join(' '));
    const lift = !manual && s.autoLiftMinutes > 0 ? `\nLifts after ${s.autoLiftMinutes} min without new joins.` : '\nLift it in the dashboard when it’s over.';
    await this.alert(guildId, s, 'Lockdown started', `${reason}\n${did}${l.problems.length ? `\n${l.problems.join('\n')}` : ''}${lift}`, 0xda373c);
    writeAudit(this.o.db, { action: 'discord.protection.lockdown_raised', outcome: 'success', actorUserId: null, metadata: { guildId, manual } }, this.o.now());
  }

  /** Lifts a lockdown: puts back the verification level and each channel's previous @everyone permissions. */
  async lift(guildId: string, why: 'manual' | 'auto'): Promise<void> {
    const all = this.stored();
    const l = all[guildId];
    if (!l) throw new AppError('conflict', 'This server isn’t locked down.');
    const token = await this.o.credentials.botToken();
    if (!token) throw new AppError('conflict', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    const audit = 'Lockdown lifted';
    const problems: string[] = [];
    // What couldn't be put back stays stored, so lifting again retries it (the saved permissions aren't lost).
    let verification = l.verification;
    if (verification) {
      try {
        await this.o.api.setGuildVerificationLevel(token, guildId, verification.from, audit);
        verification = null;
      } catch (err) {
        problems.push(`Verification level not restored: ${describeFailure(err)}`);
      }
    }
    const stillLocked: StoredLockdown['channels'] = [];
    for (const c of l.channels) {
      try {
        if (c.previous) await this.o.api.setChannelOverwrite(token, c.id, guildId, { type: 0, allow: BigInt(c.previous.allow), deny: BigInt(c.previous.deny) }, audit);
        else await this.o.api.deleteChannelOverwrite(token, c.id, guildId, audit);
      } catch (err) {
        if (err instanceof DiscordApiError && err.kind === 'not_found') continue; // the channel is gone
        problems.push(`#${c.name ?? c.id} not unlocked: ${describeFailure(err)}`);
        stillLocked.push(c);
      }
    }
    const rest = { ...this.stored() };
    if (verification || stillLocked.length) {
      // Partly lifted: kept as a by-hand lockdown (no automatic retries every tick) with only what's left.
      rest[guildId] = { ...l, manual: true, verification, channels: stillLocked, problems };
    } else delete rest[guildId];
    this.store(rest);
    const detail = `${why === 'auto' ? 'Lifted after a quiet period.' : 'Lifted by hand.'}${problems.length ? ` ${problems.join(' ')} Lift it again to retry.` : ''}`;
    this.record(guildId, 'antiraid', why === 'auto' ? 'auto_lift' : 'manual', null, 'lift', problems.length ? 'failed' : 'success', detail);
    await this.alert(guildId, this.settings(), problems.length ? 'Lockdown partly lifted' : 'Lockdown lifted', detail, problems.length ? 0xf0b232 : 0x23a55a);
    writeAudit(this.o.db, { action: 'discord.protection.lockdown_lifted', outcome: problems.length ? 'failure' : 'success', actorUserId: null, metadata: { guildId, auto: why === 'auto' } }, this.o.now());
    if (problems.length) throw new AppError('conflict', `Not everything could be put back: ${problems.join(' ')} The lockdown stays listed; lift it again to retry.`);
  }

  /** Auto-lift: automatic lockdowns end after the set minutes without new joins. Public for tests. */
  async tick(): Promise<void> {
    const s = this.settings();
    if (s.autoLiftMinutes <= 0) return;
    const now = this.o.now().getTime();
    for (const l of Object.values(this.stored())) {
      if (l.manual || now - this.lastActivity(l) < s.autoLiftMinutes * 60_000) continue;
      await this.lift(l.guildId, 'auto').catch((err) => this.o.logger.warn('automatic lockdown lift had problems', { err }));
    }
  }

  /** What a lockdown would do in a server right now, and what the bot is missing for it. */
  async preview(guildId: string): Promise<string[]> {
    const s = this.settings();
    const channels = await this.o.discordChannels();
    const g = channels.guilds.find((x) => x.id === guildId);
    if (!g) return ['The bot isn’t in this server (or Discord isn’t reachable).'];
    const lines: string[] = [];
    if (s.raiseVerification) {
      const missing = missingDiscordPermissions(g.permissions, ['manageGuild']);
      lines.push(
        missing.length
          ? `Can’t raise the verification level: the bot needs ${missing.join(', ')}.`
          : `Raise the verification level to ${VERIFICATION_LEVEL_LABEL[s.verificationLevel]} (if it’s lower), and put it back on lift.`,
      );
    }
    const mine = g.channels.filter((c) => s.lockChannels.includes(c.id));
    for (const c of mine) {
      const missing = missingDiscordPermissions(c.permissions, ['manageRoles']);
      lines.push(missing.length ? `Can’t lock #${c.name}: the bot needs ${missing.join(', ')} there.` : `Lock #${c.name}: @everyone can’t send messages, create threads or react.`);
    }
    if (!s.raiseVerification && mine.length === 0) lines.push('Nothing: choose channels to lock and/or raise the verification level.');
    if (!this.o.botUserId()) lines.push('The bot hasn’t connected yet.');
    return lines;
  }

  // ── Verify (an action of Embed Creator buttons and menus) ────────────────────

  /**
   * Why a member can't verify right now, or null when they can: verification is paused during a lockdown, and with the
   * join gate on "Hold" accounts it flags are refused (recorded for Discord Bot → Logs).
   */
  verifyRefusal(guildId: string, userId: string, userName: string, hasAvatar: boolean | null): string | null {
    if (this.stored()[guildId]) return 'Verification is paused while the server is locked down. Please try again later.';
    const s = this.settings();
    if (!s.gate.enabled || s.gate.response !== 'hold') return null;
    const problem = joinGateProblem(s.gate, { createdAt: snowflakeCreatedAt(userId), hasAvatar }, this.o.now());
    if (!problem) return null;
    this.record(guildId, 'joingate', 'verify', { id: userId, name: userName }, 'hold', 'success', `Verify refused: ${problem}.`);
    return `You can’t verify yet: your ${problem}. Please contact a moderator.`;
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  /** Posts to the alert channel (same server only). No CONDUIT branding: the community may see it. */
  private async alert(guildId: string, s: AntiraidSettings, title: string, description: string, color: number): Promise<void> {
    const ch = s.alertChannel;
    if (!ch || ch.guildId !== guildId) return;
    const res = await this.o.poster.post(ch.channelId, { embed: { title, description: description.slice(0, 4000), color, timestamp: this.o.now().toISOString() } });
    if (!res.ok) this.o.logger.warn('anti-raid alert not posted', { detail: res.detail });
  }

  private record(
    guildId: string,
    feature: 'antiraid' | 'joingate',
    rule: string,
    who: { id: string; name: string } | null,
    action: string,
    outcome: DiscordProtectionEventRecord['outcome'],
    detail: string,
  ): void {
    try {
      discordProtectionEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId,
        feature,
        rule,
        userId: who?.id ?? null,
        userName: who?.name ?? null,
        channelId: null,
        action,
        outcome,
        detail,
      });
    } catch (err) {
      this.o.logger.warn('could not record an anti-raid event', { err });
    }
  }

  /** Waits until queued work is done (tests). */
  async idle(): Promise<void> {
    await this.queue;
  }
}

function describeLockdown(l: StoredLockdown): string {
  const parts: string[] = [];
  if (l.verification) parts.push(`Verification raised to ${VERIFICATION_LEVEL_LABEL[VERIFICATION_LEVELS[l.verification.to] ?? 'none']}.`);
  if (l.channels.length) parts.push(`Locked ${l.channels.map((c) => `#${c.name ?? c.id}`).join(', ')}.`);
  return parts.join(' ') || 'Nothing was changed.';
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeFailure(err: unknown): string {
  return describeDiscordFailure(err, {
    forbidden: 'Discord refused: the bot is missing a permission (Manage Server, Manage Roles or Kick Members) or its role is too low.',
    notFound: 'Discord couldn’t find it.',
  });
}
