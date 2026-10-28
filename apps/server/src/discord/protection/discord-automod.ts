/**
 * AutoMod (Discord Bot → Protection): CONDUIT's own rules, checked by CONDUIT's bot on the gateway's events and acted on
 * through Discord's REST API. Discord's built-in AutoMod isn't used or changed.
 *
 * - Custom words: words and phrases (* wildcards, as Discord reads them), regular expressions and allowed words, on new
 *   messages' text (needs the Message Content intent).
 * - Mention spam: messages that @mention more members and roles than allowed.
 * - Member names: usernames when members join, and nicknames when they change.
 *
 * Each rule logs, deletes the message, deletes and times out, or (member names) times out or kicks, and can post an
 * alert in a channel. The first matching rule acts; one timeout, kick and alert per member and rule per 30 s (each
 * matching message is still deleted). Moderators, exempt roles and exempt channels are skipped; the server owner and
 * CONDUIT's own bot are never acted on. Rules are kept in app_settings; message text is looked at in memory only.
 * Everything is recorded for Discord Bot → Logs. What members and the alert channel see carries no CONDUIT branding.
 */
import crypto from 'node:crypto';
import { discordProtectionEventsRepo, settingsRepo, SETTING_KEYS, type Database, type DiscordProtectionEventRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  automodActionLabel,
  automodMatcher,
  automodRuleSchema,
  AUTOMOD_RULES_MAX,
  AUTOMOD_TRIGGER_LABEL,
  normalizeForAutomod,
  type AutomodMatcher,
  type DiscordAutomodRule,
} from '@conduit/shared';
import { writeAudit } from '../../audit';
import { AppError, notFound } from '../../errors';
import { parseInput } from '../../validation';
import { DiscordApiError, type DiscordApi } from '../discord-api';
import { describeDiscordFailure } from '../discord-errors';
import type { DiscordCredentials } from '../discord-credentials';
import type { GuildEvent } from '../discord-bot';
import type { DiscordPoster } from '../discord-poster';

const COOLDOWN_MS = 30_000;
const TRACKED = 5_000;
const QUEUE_LIMIT = 50;

type MessageEvent = Extract<GuildEvent, { type: 'message_create' }>;
type MemberEvent = Extract<GuildEvent, { type: 'member_join' } | { type: 'member_update' }>;

export interface DiscordAutoModOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<DiscordApi, 'deleteMessage' | 'timeoutMember' | 'kickMember' | 'guildOwner' | 'guildMemberRoles'>;
  poster: Pick<DiscordPoster, 'post'>;
  botUserId: () => string | null;
}

/** What a rule matched on: a message, or a member's name. */
type Target =
  | { kind: 'message'; guildId: string; userId: string; userName: string | null; channelId: string; messageId: string; text: string | null }
  | { kind: 'member'; guildId: string; userId: string; userName: string | null; name: string };

export class DiscordAutoMod {
  private readonly matchers = new Map<string, { version: string; matcher: AutomodMatcher }>();
  private readonly cooldowns = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly o: DiscordAutoModOptions) {}

  // ── rules ──────────────────────────────────────────────────────────────────

  /** Every server's rules (stored ones that no longer make sense are left out). */
  rules(): DiscordAutomodRule[] {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordAutomodRules);
    if (!raw) return [];
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      this.o.logger.warn('stored AutoMod rules are invalid; none are used');
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list.flatMap((stored: Partial<DiscordAutomodRule>) => {
      const { id, guildId, createdAt, updatedAt, ...rule } = stored ?? {};
      const parsed = automodRuleSchema.safeParse(rule);
      if (!parsed.success || typeof id !== 'string' || typeof guildId !== 'string') return [];
      return [{ ...parsed.data, id, guildId, createdAt: String(createdAt ?? ''), updatedAt: String(updatedAt ?? '') }];
    });
  }

  private store(rules: DiscordAutomodRule[]): void {
    settingsRepo.set(this.o.db, SETTING_KEYS.discordAutomodRules, JSON.stringify(rules), this.o.now().toISOString());
  }

  create(guildId: string, raw: unknown): DiscordAutomodRule {
    const input = parseInput(automodRuleSchema, raw);
    const rules = this.rules();
    if (rules.filter((r) => r.guildId === guildId).length >= AUTOMOD_RULES_MAX) throw new AppError('conflict', `A server can have up to ${AUTOMOD_RULES_MAX} AutoMod rules.`);
    const at = this.o.now().toISOString();
    const rule: DiscordAutomodRule = { ...input, id: crypto.randomUUID(), guildId, createdAt: at, updatedAt: at };
    this.store([...rules, rule]);
    this.changed(guildId, 'created', rule.name);
    return rule;
  }

  update(guildId: string, id: string, raw: unknown): DiscordAutomodRule {
    const input = parseInput(automodRuleSchema, raw);
    const rules = this.rules();
    const current = rules.find((r) => r.id === id && r.guildId === guildId);
    if (!current) throw notFound('AutoMod rule');
    const rule: DiscordAutomodRule = { ...input, id, guildId, createdAt: current.createdAt, updatedAt: this.o.now().toISOString() };
    this.store(rules.map((r) => (r.id === id ? rule : r)));
    this.changed(guildId, 'updated', rule.name);
    return rule;
  }

  setEnabled(guildId: string, id: string, enabled: boolean): DiscordAutomodRule {
    const rules = this.rules();
    const current = rules.find((r) => r.id === id && r.guildId === guildId);
    if (!current) throw notFound('AutoMod rule');
    const rule = { ...current, enabled, updatedAt: this.o.now().toISOString() };
    this.store(rules.map((r) => (r.id === id ? rule : r)));
    this.changed(guildId, enabled ? 'enabled' : 'disabled', rule.name);
    return rule;
  }

  delete(guildId: string, id: string): void {
    const rules = this.rules();
    const current = rules.find((r) => r.id === id && r.guildId === guildId);
    if (!current) throw notFound('AutoMod rule');
    this.store(rules.filter((r) => r.id !== id));
    this.matchers.delete(id);
    this.changed(guildId, 'deleted', current.name);
  }

  private changed(guildId: string, what: 'created' | 'updated' | 'enabled' | 'disabled' | 'deleted', name: string): void {
    writeAudit(this.o.db, { action: `discord.automod.rule_${what}`, outcome: 'success', actorUserId: null, metadata: { guildId, name } }, this.o.now());
    this.o.logger.info('discord automod rule changed', { what });
  }

  private matcher(r: DiscordAutomodRule): AutomodMatcher {
    const hit = this.matchers.get(r.id);
    if (hit && hit.version === r.updatedAt) return hit.matcher;
    const matcher = automodMatcher(r);
    this.matchers.set(r.id, { version: r.updatedAt, matcher });
    return matcher;
  }

  // ── checking ───────────────────────────────────────────────────────────────

  /** A new message: true when a rule matched (the message checks then leave it alone). */
  onMessage(e: MessageEvent): boolean {
    if (e.authorBot || e.system || e.authorId === this.o.botUserId()) return false;
    for (const r of this.rules()) {
      if (r.guildId !== e.guildId || !r.enabled || r.trigger === 'member_profile') continue;
      if (r.exemptChannels.includes(e.channelId)) continue;
      if (r.exemptModerators && e.authorModerator) continue;
      if (e.authorRoleIds?.some((id) => r.exemptRoles.includes(id))) continue;
      let detail: string | null = null;
      if (r.trigger === 'keyword' && e.content) {
        const found = this.matcher(r).match(e.content);
        if (found) detail = `Used “${found}”.`;
      }
      if (r.trigger === 'mention_spam' && r.mentionLimit !== null && (e.mentionCount ?? 0) > r.mentionLimit) {
        detail = `${e.mentionCount} mentions in one message (more than ${r.mentionLimit}).`;
      }
      if (!detail) continue;
      this.enqueue(r, { kind: 'message', guildId: e.guildId, userId: e.authorId, userName: e.authorName ?? null, channelId: e.channelId, messageId: e.messageId, text: e.content ?? null }, detail);
      return true;
    }
    return false;
  }

  /** A member joined (their username) or changed nickname (the new one). */
  onMember(e: MemberEvent): void {
    if (e.user.bot || e.user.id === this.o.botUserId()) return;
    const name = e.type === 'member_join' ? e.user.tag : e.nickAfter && e.nickAfter !== e.nickBefore ? e.nickAfter : null;
    if (!name) return;
    for (const r of this.rules()) {
      if (r.guildId !== e.guildId || !r.enabled || r.trigger !== 'member_profile') continue;
      const found = this.matcher(r).match(name);
      if (!found) continue;
      const what = e.type === 'member_join' ? 'Username' : 'Nickname';
      this.enqueue(r, { kind: 'member', guildId: e.guildId, userId: e.user.id, userName: e.user.tag, name }, `${what} “${normalizeForAutomod(name).slice(0, 64)}” uses “${found}”.`);
      return;
    }
  }

  private enqueue(r: DiscordAutomodRule, t: Target, detail: string): void {
    if (this.queued >= QUEUE_LIMIT) return this.record(r, t, 'failed', 'Skipped: too many actions at once.');
    this.queued++;
    this.queue = this.queue
      .then(() => this.act(r, t, detail))
      .catch((err) => this.o.logger.error('discord automod action failed', { err }))
      .finally(() => this.queued--);
  }

  /** Whether this member was already punished and reported for this rule in the last 30 s. */
  private cooling(r: DiscordAutomodRule, t: Target): boolean {
    const key = `${r.id}:${t.userId}`;
    const now = this.o.now().getTime();
    if ((this.cooldowns.get(key) ?? 0) > now) return true;
    this.cooldowns.set(key, now + COOLDOWN_MS);
    if (this.cooldowns.size > TRACKED) for (const [k, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(k);
    return false;
  }

  private async act(r: DiscordAutomodRule, t: Target, detail: string): Promise<void> {
    const cooling = this.cooling(r, t);
    if (r.action === 'log') {
      if (cooling) return;
      this.record(r, t, 'logged', detail);
      return this.alert(r, t, detail, 'Logged only.');
    }
    const token = await this.o.credentials.botToken();
    if (!token) return this.record(r, t, 'failed', 'The Discord bot isn’t set up.');
    const reason = `AutoMod: ${r.name}`.slice(0, 400);
    const done: string[] = [];
    try {
      if (t.kind === 'message') {
        await this.o.api.deleteMessage(token, t.channelId, t.messageId, reason).catch((err) => {
          // Already gone (deleted by the member or a moderator): nothing to delete.
          if (!(err instanceof DiscordApiError && err.kind === 'not_found')) throw err;
        });
        done.push('Message deleted.');
      }
      if ((r.action === 'timeout' || r.action === 'kick') && !cooling) {
        if (await this.untouchable(token, r, t)) {
          done.push('Not punished: the server owner or an exempt role.');
        } else if (r.action === 'timeout') {
          const until = new Date(this.o.now().getTime() + r.timeoutMinutes * 60_000).toISOString();
          await this.o.api.timeoutMember(token, t.guildId, t.userId, until, reason);
          done.push(`Timed out for ${formatMinutes(r.timeoutMinutes)}.`);
        } else {
          await this.o.api.kickMember(token, t.guildId, t.userId, reason);
          done.push('Kicked.');
        }
      }
      if (cooling && t.kind === 'message') return; // deleted again; already punished and reported
      this.record(r, t, 'success', `${detail} ${done.join(' ')}`.trim());
      await this.alert(r, t, detail, done.join(' ') || automodActionLabel(r.trigger, r.action));
    } catch (err) {
      const why = describeDiscordFailure(err, {
        forbidden: 'Discord refused: the bot needs Manage Messages, Timeout Members or Kick Members, and its role must be above the member’s.',
        notFound: 'Discord couldn’t find the member or message (already gone?).',
      });
      this.record(r, t, 'failed', `${detail} ${done.join(' ')} ${why}`.replace(/\s+/g, ' ').trim());
      if (!cooling) await this.alert(r, t, detail, `${done.join(' ')} Failed: ${why}`.trim());
    }
  }

  /** The owner is never punished; neither is a member holding an exempt role (checked for names, which have no roles). */
  private async untouchable(token: string, r: DiscordAutomodRule, t: Target): Promise<boolean> {
    const owner = await this.o.api.guildOwner(token, t.guildId).catch(() => null);
    if (owner === t.userId) return true;
    if (t.kind === 'member' && r.exemptRoles.length > 0) {
      const roles = await this.o.api.guildMemberRoles(token, t.guildId, t.userId).catch(() => [] as string[]);
      return roles.some((id) => r.exemptRoles.includes(id));
    }
    return false;
  }

  /** Posts to the rule's alert channel: who, where, what matched and what was done. */
  private async alert(r: DiscordAutomodRule, t: Target, detail: string, result: string): Promise<void> {
    if (!r.alertChannelId) return;
    const fields = [
      ...(t.kind === 'message' ? [{ name: 'Channel', value: `<#${t.channelId}>`, inline: true }] : []),
      { name: 'Action', value: result.slice(0, 1024), inline: true },
      ...(t.kind === 'message' && t.text ? [{ name: 'Message', value: t.text.slice(0, 1000), inline: false }] : []),
    ];
    const res = await this.o.poster.post(r.alertChannelId, {
      embed: {
        title: `AutoMod: ${r.name}`.slice(0, 256),
        description: `<@${t.userId}>${t.userName ? ` **${t.userName}**` : ''}\n${AUTOMOD_TRIGGER_LABEL[r.trigger]} · ${detail}`.slice(0, 4000),
        color: r.action === 'log' ? 0xf0b232 : 0xda373c,
        fields,
        footer: { text: `User ID: ${t.userId}` },
        timestamp: this.o.now().toISOString(),
      },
    });
    if (!res.ok) this.o.logger.warn('automod alert not posted', { detail: res.detail });
  }

  private record(r: DiscordAutomodRule, t: Target, outcome: DiscordProtectionEventRecord['outcome'], detail: string): void {
    try {
      discordProtectionEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId: t.guildId,
        // Stored with the message checks (the Logs show the rule's name).
        feature: 'message',
        rule: `AutoMod: ${r.name}`.slice(0, 120),
        userId: t.userId,
        userName: t.userName,
        channelId: t.kind === 'message' ? t.channelId : null,
        action: r.action,
        outcome,
        detail,
      });
    } catch (err) {
      this.o.logger.warn('could not record an automod event', { err });
    }
  }

  /** Waits until queued actions are done (tests). */
  idle(): Promise<void> {
    return this.queue;
  }
}

function formatMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}
