/**
 * CONDUIT protection — anti-nuke (Discord Bot → Protection). CONDUIT's own bot reads the server's audit log from the
 * gateway (channels and roles created or deleted, dangerous permissions given, bans, kicks, prunes, bots and webhooks
 * added), counts each person's actions per rule, and when someone does more than a rule allows within its window it
 * alerts and — in Enforce mode — responds against them through Discord's REST API: quarantine (their roles removed,
 * saved so they can be given back), time out, kick or ban.
 *
 * Never acted on: CONDUIT's own bot, the server owner (Discord doesn't allow it), trusted people and members with a
 * trusted role. Off by default; switched on it starts on "Alert only". Everything is recorded for Discord Bot → Logs.
 */
import crypto from 'node:crypto';
import { discordProtectionEventsRepo, discordQuarantineRepo, settingsRepo, SETTING_KEYS, type Database, type DiscordProtectionEventRecord, type DiscordQuarantineRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  ANTINUKE_DEFAULTS,
  ANTINUKE_RESPONSE_LABEL,
  ANTINUKE_RULE_LABEL,
  ANTINUKE_RULE_UNIT,
  antinukeSchema,
  type AntinukeRule,
  type AntinukeSettings,
} from '@conduit/shared';
import { writeAudit } from '../../audit';
import { AppError, notFound } from '../../errors';
import { DiscordApiError, type DiscordApi, type GuildMemberInfo } from '../discord-api';
import { describeDiscordFailure } from '../discord-errors';
import type { DiscordCredentials } from '../discord-credentials';
import type { GuildEvent, UserRef } from '../discord-bot';
import { parseInput } from '../../validation';
import type { DiscordPoster } from '../discord-poster';

const OWNER_CACHE_MS = 10 * 60_000;
const TRACKED = 5_000;
const QUEUE_LIMIT = 50;

type Counted = { at: number; targetId: string | null; targetName: string | null; permissions: string[] };

export interface DiscordAntiNukeOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<DiscordApi, 'guildOwner' | 'guildMember' | 'guildRoles' | 'guildMemberRoles' | 'setMemberRoles' | 'timeoutMember' | 'kickMember' | 'banMember'>;
  poster: Pick<DiscordPoster, 'post'>;
  botUserId: () => string | null;
}

export class DiscordAntiNuke {
  private readonly counted = new Map<string, Counted[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly owners = new Map<string, { at: number; id: string }>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly o: DiscordAntiNukeOptions) {}

  settings(): AntinukeSettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordAntinuke);
    if (!raw) return structuredClone(ANTINUKE_DEFAULTS);
    try {
      const parsed = antinukeSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    this.o.logger.warn('stored anti-nuke settings are invalid; using the defaults');
    return structuredClone(ANTINUKE_DEFAULTS);
  }

  save(raw: unknown): AntinukeSettings {
    const next = parseInput(antinukeSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.discordAntinuke, JSON.stringify(next), this.o.now().toISOString());
    writeAudit(this.o.db, { action: 'discord.protection.antinuke_updated', outcome: 'success', actorUserId: null, metadata: { enabled: next.enabled, mode: next.mode, response: next.response } }, this.o.now());
    this.o.logger.info('anti-nuke settings saved', { enabled: next.enabled, mode: next.mode });
    return next;
  }

  // ── counting ───────────────────────────────────────────────────────────────

  onDiscordEvent(e: GuildEvent): void {
    try {
      this.count(e);
    } catch (err) {
      this.o.logger.error('anti-nuke check failed', { err });
    }
  }

  private count(e: GuildEvent): void {
    let rule: AntinukeRule | null = null;
    let item: Omit<Counted, 'at'> = { targetId: null, targetName: null, permissions: [] };
    if (e.type === 'audit' && (e.action === 'ban' || e.action === 'kick')) {
      rule = e.action;
      item = { targetId: e.targetId, targetName: e.target?.tag ?? null, permissions: [] };
    } else if (e.type === 'audit_change') {
      rule = e.kind;
      item = { targetId: e.targetId, targetName: e.targetName, permissions: e.permissionsAdded ?? [] };
    }
    if (!rule || (e.type !== 'audit' && e.type !== 'audit_change')) return;
    const s = this.settings();
    const cfg = s.rules[rule];
    if (!s.enabled || !cfg.enabled) return;
    const executor = e.executor;
    if (!executor || executor.id === this.o.botUserId() || s.trustedUsers.includes(executor.id)) return;

    const now = this.o.now().getTime();
    const key = `${e.guildId}:${executor.id}:${rule}`;
    const list = (this.counted.get(key) ?? []).filter((c) => now - c.at <= cfg.windowSeconds * 1000);
    list.push({ at: now, ...item });
    this.counted.delete(key);
    this.counted.set(key, list);
    if (this.counted.size > TRACKED) this.counted.delete(this.counted.keys().next().value!);
    if (list.length < cfg.threshold) return;

    this.counted.set(key, []);
    const cooldownKey = `${e.guildId}:${executor.id}`;
    if ((this.cooldowns.get(cooldownKey) ?? 0) > now) return;
    this.cooldowns.set(cooldownKey, now + Math.max(60, cfg.windowSeconds) * 1000);
    if (this.cooldowns.size > TRACKED) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);

    if (this.queued >= QUEUE_LIMIT) {
      this.record(e.guildId, rule, executor, 'alert', 'failed', 'Skipped: too many responses at once.');
      return;
    }
    this.queued++;
    this.queue = this.queue
      .then(() => this.respond(e.guildId, executor, rule!, list, s))
      .catch((err) => this.o.logger.error('anti-nuke response failed', { err }))
      .finally(() => this.queued--);
  }

  // ── responding ─────────────────────────────────────────────────────────────

  private async respond(guildId: string, executor: UserRef, rule: AntinukeRule, items: Counted[], s: AntinukeSettings): Promise<void> {
    const token = await this.o.credentials.botToken();
    const detail = describeTrip(rule, items, s.rules[rule].windowSeconds);
    if (!token) return this.record(guildId, rule, executor, 'alert', 'failed', `${detail} The Discord bot isn’t set up.`);
    if ((await this.owner(token, guildId)) === executor.id) return; // the owner can't be acted on, and it's their server
    const member = await this.o.api.guildMember(token, guildId, executor.id).catch(() => null);
    if (member && member.roles.some((r) => s.trustedRoles.includes(r))) return;

    if (s.mode === 'alert') {
      this.record(guildId, rule, executor, 'alert', 'logged', detail);
      await this.alert(guildId, executor, rule, detail, 'Alert only — nothing was done.', s, 'alert');
      return;
    }
    const reason = `Anti-nuke: ${ANTINUKE_RULE_LABEL[rule]}`;
    const results: string[] = [];
    let ok = true;
    try {
      results.push(await this.punish(token, guildId, executor, member, s, reason, detail));
    } catch (err) {
      ok = false;
      results.push(`${ANTINUKE_RESPONSE_LABEL[s.response]} failed: ${describeFailure(err)}`);
    }
    if (rule === 'bot_add' && s.removeAddedBots) {
      for (const bot of items.filter((i) => i.targetId && i.targetId !== this.o.botUserId())) {
        try {
          await this.o.api.kickMember(token, guildId, bot.targetId!, reason);
          results.push(`Removed the added bot ${bot.targetName ?? bot.targetId}.`);
        } catch (err) {
          if (err instanceof DiscordApiError && err.kind === 'not_found') continue;
          ok = false;
          results.push(`Couldn’t remove the added bot ${bot.targetName ?? bot.targetId}: ${describeFailure(err)}`);
        }
      }
    }
    const result = results.join(' ');
    this.record(guildId, rule, executor, s.response, ok ? 'success' : 'failed', `${detail} ${result}`);
    await this.alert(guildId, executor, rule, detail, result, s, ok ? 'done' : 'failed');
  }

  private async punish(token: string, guildId: string, executor: UserRef, member: GuildMemberInfo | null, s: AntinukeSettings, reason: string, detail: string): Promise<string> {
    switch (s.response) {
      case 'ban':
        await this.o.api.banMember(token, guildId, executor.id, 0, reason);
        return 'Banned.';
      case 'kick':
        if (!member) throw new AppError('conflict', 'They’re no longer in the server.');
        await this.o.api.kickMember(token, guildId, executor.id, reason);
        return 'Kicked.';
      case 'timeout': {
        if (!member) throw new AppError('conflict', 'They’re no longer in the server.');
        const until = new Date(this.o.now().getTime() + s.timeoutMinutes * 60_000).toISOString();
        await this.o.api.timeoutMember(token, guildId, executor.id, until, reason);
        return `Timed out for ${s.timeoutMinutes} min.`;
      }
      case 'quarantine': {
        if (!member) throw new AppError('conflict', 'They’re no longer in the server.');
        if (discordQuarantineRepo.active(this.o.db, guildId, executor.id)) return 'Already quarantined.';
        const roles = new Map((await this.o.api.guildRoles(token, guildId)).map((r) => [r.id, r]));
        const botId = this.o.botUserId();
        const botRoles = botId ? await this.o.api.guildMemberRoles(token, guildId, botId) : [];
        const botTop = Math.max(0, ...botRoles.map((id) => roles.get(id)?.position ?? 0));
        // Roles managed by an integration can't be removed, and Discord refuses roles at or above the bot's own.
        const removable = member.roles.filter((id) => {
          const r = roles.get(id);
          return r && !r.managed && (r.position ?? 0) < botTop;
        });
        const kept = member.roles.filter((id) => !removable.includes(id));
        if (removable.length === 0) throw new AppError('conflict', 'None of their roles can be removed (managed, or not below the bot’s highest role).');
        await this.o.api.setMemberRoles(token, guildId, executor.id, kept, reason);
        discordQuarantineRepo.insert(this.o.db, {
          id: crypto.randomUUID(),
          createdAt: this.o.now().toISOString(),
          guildId,
          userId: executor.id,
          userName: executor.tag,
          roles: removable,
          reason: detail.slice(0, 300),
        });
        const n = removable.length;
        return `Quarantined: removed ${n} role${n === 1 ? '' : 's'}${kept.length ? ` (${kept.length} kept: managed or not below the bot’s role)` : ''}.`;
      }
    }
  }

  private async owner(token: string, guildId: string): Promise<string | null> {
    const hit = this.owners.get(guildId);
    const now = this.o.now().getTime();
    if (hit && now - hit.at < OWNER_CACHE_MS) return hit.id;
    try {
      const id = await this.o.api.guildOwner(token, guildId);
      this.owners.set(guildId, { at: now, id });
      return id;
    } catch {
      return hit?.id ?? null;
    }
  }

  /** Posts to the alert channel (in the same server only). No CONDUIT branding: the community sees it. */
  private async alert(guildId: string, executor: UserRef, rule: AntinukeRule, detail: string, result: string, s: AntinukeSettings, tone: 'alert' | 'done' | 'failed'): Promise<void> {
    const ch = s.alertChannel;
    if (!ch || ch.guildId !== guildId) return;
    const res = await this.o.poster.post(ch.channelId, {
      embed: {
        title: `Anti-nuke: ${ANTINUKE_RULE_LABEL[rule]}`,
        description: `<@${executor.id}> **${executor.tag}**${executor.bot ? ' (bot)' : ''}\n${detail}`,
        color: tone === 'alert' ? 0xf0b232 : tone === 'done' ? 0xda373c : 0x80848e,
        fields: [{ name: s.mode === 'alert' ? 'Mode' : 'Response', value: result.slice(0, 1024), inline: false }],
        footer: { text: `User ID: ${executor.id}` },
        timestamp: this.o.now().toISOString(),
      },
    });
    if (!res.ok) this.o.logger.warn('anti-nuke alert not posted', { detail: res.detail });
  }

  // ── quarantine ─────────────────────────────────────────────────────────────

  quarantine(limit = 50): DiscordQuarantineRecord[] {
    return discordQuarantineRepo.list(this.o.db, limit);
  }

  /** Gives the member back the roles CONDUIT removed (keeping any they have now). */
  async restore(id: string): Promise<void> {
    const q = this.active(id);
    const token = await this.o.credentials.botToken();
    if (!token) throw new AppError('conflict', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    let member: GuildMemberInfo | null;
    try {
      member = await this.o.api.guildMember(token, q.guildId, q.userId);
    } catch (err) {
      throw new AppError('conflict', describeFailure(err));
    }
    if (!member) {
      discordQuarantineRepo.resolve(this.o.db, id, 'released', this.o.now().toISOString());
      throw new AppError('conflict', 'They’re no longer in the server, so there’s nothing to restore. The entry was closed.');
    }
    try {
      await this.o.api.setMemberRoles(token, q.guildId, q.userId, [...new Set([...member.roles, ...q.roles])], 'Anti-nuke: roles restored');
    } catch (err) {
      throw new AppError('conflict', describeFailure(err));
    }
    discordQuarantineRepo.resolve(this.o.db, id, 'restored', this.o.now().toISOString());
    this.record(q.guildId, 'quarantine', { id: q.userId, tag: q.userName ?? q.userId, avatarUrl: null, bot: false }, 'restore', 'success', `Restored ${q.roles.length} role${q.roles.length === 1 ? '' : 's'}.`);
    writeAudit(this.o.db, { action: 'discord.protection.quarantine_restored', outcome: 'success', actorUserId: null, metadata: { guildId: q.guildId } }, this.o.now());
  }

  /** Closes a quarantine without giving the roles back. */
  release(id: string): void {
    const q = this.active(id);
    discordQuarantineRepo.resolve(this.o.db, id, 'released', this.o.now().toISOString());
    this.record(q.guildId, 'quarantine', { id: q.userId, tag: q.userName ?? q.userId, avatarUrl: null, bot: false }, 'release', 'success', 'Released without restoring roles.');
    writeAudit(this.o.db, { action: 'discord.protection.quarantine_released', outcome: 'success', actorUserId: null, metadata: { guildId: q.guildId } }, this.o.now());
  }

  private active(id: string): DiscordQuarantineRecord {
    const q = discordQuarantineRepo.get(this.o.db, id);
    if (!q) throw notFound('Quarantine');
    if (q.status !== 'active') throw new AppError('conflict', q.status === 'restored' ? 'Their roles were already restored.' : 'This quarantine was already closed.');
    return q;
  }

  private record(guildId: string, rule: string, who: UserRef, action: string, outcome: DiscordProtectionEventRecord['outcome'], detail: string): void {
    try {
      discordProtectionEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId,
        feature: 'antinuke',
        rule,
        userId: who.id,
        userName: who.tag,
        channelId: null,
        action,
        outcome,
        detail,
      });
    } catch (err) {
      this.o.logger.warn('could not record an anti-nuke event', { err });
    }
  }

  /** Waits until queued responses are done (tests). */
  async idle(): Promise<void> {
    await this.queue;
  }
}

/** "Deleted 3 channels within 60 s: #a, #b, #c." */
export function describeTrip(rule: AntinukeRule, items: Array<{ targetName: string | null; permissions: string[] }>, windowSeconds: number): string {
  const n = items.length;
  const [one, many] = ANTINUKE_RULE_UNIT[rule];
  const names = [...new Set(items.map((i) => i.targetName).filter((x): x is string => !!x))].slice(0, 3);
  const perms = [...new Set(items.flatMap((i) => i.permissions))];
  return `${n} ${n === 1 ? one : many} within ${windowSeconds} s${names.length ? `: ${names.join(', ')}` : ''}${perms.length ? ` (${perms.join(', ')})` : ''}.`;
}

function describeFailure(err: unknown): string {
  return describeDiscordFailure(err, {
    forbidden: 'Discord refused: the bot needs the permission for this response (Manage Roles, Timeout, Kick or Ban Members) and its role must be above theirs.',
    notFound: 'Discord couldn’t find them (they may have left).',
  });
}
