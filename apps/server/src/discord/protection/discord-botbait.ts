/**
 * CONDUIT protection — bot bait (Discord Bot → Protection). Trap channels real members are told not to post in: anyone
 * who posts there anyway (bots, webhooks, moderators and exempt roles aside) is treated as a spam account. CONDUIT's
 * own bot sees the post on the gateway and acts through Discord's REST API: alert only, delete the message, or delete
 * and time out, kick, softban (ban + unban, wiping their recent messages) or ban.
 *
 * Off by default; "Alert only" until an action is chosen. One punishment per member per 30 s (a burst of posts is each
 * deleted, but punished once). Everything is recorded for Discord Bot → Logs. Messages members see carry no CONDUIT
 * branding.
 */
import crypto from 'node:crypto';
import { discordProtectionEventsRepo, settingsRepo, SETTING_KEYS, type Database, type DiscordProtectionEventRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { BOTBAIT_ACTION_LABEL, BOTBAIT_DEFAULTS, botbaitSchema, botbaitWarning, type BotbaitSettings, type DiscordChannelsState } from '@conduit/shared';
import { z } from 'zod';
import { writeAudit } from '../../audit';
import { AppError } from '../../errors';
import { DiscordApiError, type DiscordApi } from '../discord-api';
import { describeDiscordFailure } from '../discord-errors';
import type { DiscordCredentials } from '../discord-credentials';
import type { GuildEvent } from '../discord-bot';
import { parseInput } from '../../validation';
import type { DiscordPoster } from '../discord-poster';

const PUNISH_COOLDOWN_MS = 30_000;
const TRACKED = 5_000;
const QUEUE_LIMIT = 50;

type MessageEvent = Extract<GuildEvent, { type: 'message_create' }>;

export interface DiscordBotBaitOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<DiscordApi, 'deleteMessage' | 'timeoutMember' | 'kickMember' | 'banMember' | 'unbanMember'>;
  poster: Pick<DiscordPoster, 'post'>;
  discordChannels: () => Promise<DiscordChannelsState>;
  botUserId: () => string | null;
}

const warningSchema = z.strictObject({ channelId: z.string().regex(/^\d{1,25}$/, 'Choose a channel') });

export class DiscordBotBait {
  private readonly punished = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly o: DiscordBotBaitOptions) {}

  settings(): BotbaitSettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordBotbait);
    if (!raw) return structuredClone(BOTBAIT_DEFAULTS);
    try {
      const parsed = botbaitSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    this.o.logger.warn('stored bot bait settings are invalid; using the defaults');
    return structuredClone(BOTBAIT_DEFAULTS);
  }

  save(raw: unknown): BotbaitSettings {
    const next = parseInput(botbaitSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.discordBotbait, JSON.stringify(next), this.o.now().toISOString());
    writeAudit(this.o.db, { action: 'discord.protection.botbait_updated', outcome: 'success', actorUserId: null, metadata: { enabled: next.enabled, action: next.action, channels: next.channels.length } }, this.o.now());
    this.o.logger.info('bot bait settings saved', { enabled: next.enabled, action: next.action });
    return next;
  }

  /** Posts the "don't post here" warning in a bait channel. */
  async postWarning(raw: unknown): Promise<void> {
    const { channelId } = parseInput(warningSchema, raw);
    const s = this.settings();
    if (!s.channels.includes(channelId)) throw new AppError('validation_error', 'Not a bait channel', { issues: [{ path: 'channelId', message: 'Add it as a bait channel first' }] });
    const w = botbaitWarning(s.action);
    const res = await this.o.poster.post(channelId, { embed: { title: w.title, description: w.description, color: 0xda373c } });
    if (!res.ok) throw new AppError('conflict', res.detail);
    writeAudit(this.o.db, { action: 'discord.protection.botbait_warning_posted', outcome: 'success', actorUserId: null, metadata: { channelId } }, this.o.now());
  }

  /** A server message; true when it was in a bait channel (so the other message checks skip it). */
  onMessage(e: MessageEvent): boolean {
    const s = this.settings();
    if (!s.enabled || !s.channels.includes(e.channelId)) return false;
    if (e.authorBot || e.system || e.authorId === this.o.botUserId()) return true;
    if (s.exemptModerators && e.authorModerator) return true;
    if (e.authorRoleIds?.some((r) => s.exemptRoles.includes(r))) return true;

    const now = this.o.now().getTime();
    const key = `${e.guildId}:${e.authorId}`;
    const punish = (this.punished.get(key) ?? 0) <= now;
    if (punish) this.punished.set(key, now + PUNISH_COOLDOWN_MS);
    if (this.punished.size > TRACKED) for (const [k, until] of this.punished) if (until <= now) this.punished.delete(k);
    // Within the cooldown, "Alert only" has nothing more to do; other actions still remove each post.
    if (!punish && s.action === 'alert') return true;
    if (this.queued >= QUEUE_LIMIT) {
      this.record(e, s.action, 'failed', 'Skipped: too many actions at once.');
      return true;
    }
    this.queued++;
    this.queue = this.queue
      .then(() => this.act(e, s, punish))
      .catch((err) => this.o.logger.error('bot bait action failed', { err }))
      .finally(() => this.queued--);
    return true;
  }

  private async act(e: MessageEvent, s: BotbaitSettings, punish: boolean): Promise<void> {
    const where = `#${await this.channelName(e.channelId)}`;
    const detail = `Posted in the bait channel ${where}.`;
    if (s.action === 'alert') {
      this.record(e, 'alert', 'logged', detail);
      await this.alert(e, s, detail, 'Alert only — nothing was done.');
      return;
    }
    const token = await this.o.credentials.botToken();
    if (!token) return this.record(e, s.action, 'failed', `${detail} The Discord bot isn’t set up.`);
    const reason = 'Bot bait: posted in a trap channel';
    const done: string[] = [];
    try {
      // A softban or ban deletes the message with the rest of their recent ones; otherwise (or within the cooldown,
      // when no ban happens) delete it here.
      if ((s.action !== 'ban' && s.action !== 'softban') || !punish) {
        await this.o.api.deleteMessage(token, e.channelId, e.messageId, reason).catch((err) => {
          if (!(err instanceof DiscordApiError && err.kind === 'not_found')) throw err;
        });
        done.push('Message deleted.');
      }
      if (punish) {
        const deleteSeconds = s.deleteMessageHours * 3600;
        if (s.action === 'timeout') {
          await this.o.api.timeoutMember(token, e.guildId, e.authorId, new Date(this.o.now().getTime() + s.timeoutMinutes * 60_000).toISOString(), reason);
          done.push(`Timed out for ${s.timeoutMinutes} min.`);
        } else if (s.action === 'kick') {
          await this.o.api.kickMember(token, e.guildId, e.authorId, reason);
          done.push('Kicked.');
        } else if (s.action === 'ban' || s.action === 'softban') {
          await this.o.api.banMember(token, e.guildId, e.authorId, deleteSeconds, reason);
          if (s.action === 'softban') {
            await this.o.api.unbanMember(token, e.guildId, e.authorId, 'Bot bait: softban (unbanned straight away)');
            done.push(`Softbanned: removed from the server${deleteSeconds ? ` and their messages from the last ${hours(s.deleteMessageHours)} deleted` : ''}; they can rejoin.`);
          } else done.push(`Banned${deleteSeconds ? `; their messages from the last ${hours(s.deleteMessageHours)} deleted` : ''}.`);
        }
      }
      const result = done.join(' ');
      this.record(e, s.action, 'success', `${detail} ${result}`);
      if (punish) await this.alert(e, s, detail, result);
    } catch (err) {
      const result = `${done.join(' ')} ${BOTBAIT_ACTION_LABEL[s.action]} failed: ${describeFailure(err)}`.trim();
      this.record(e, s.action, 'failed', `${detail} ${result}`);
      if (punish) await this.alert(e, s, detail, result);
    }
  }

  private async channelName(channelId: string): Promise<string> {
    try {
      const channels = await this.o.discordChannels();
      for (const g of channels.guilds) {
        const c = g.channels.find((x) => x.id === channelId);
        if (c) return c.name;
      }
    } catch {
      // fall through
    }
    return channelId;
  }

  /** Posts to the alert channel (same server only). No CONDUIT branding. */
  private async alert(e: MessageEvent, s: BotbaitSettings, detail: string, result: string): Promise<void> {
    const ch = s.alertChannel;
    if (!ch || ch.guildId !== e.guildId) return;
    const res = await this.o.poster.post(ch.channelId, {
      embed: {
        title: 'Bot bait triggered',
        description: `<@${e.authorId}>${e.authorName ? ` **${e.authorName}**` : ''}\n${detail}`,
        color: s.action === 'alert' ? 0xf0b232 : 0xda373c,
        fields: [{ name: s.action === 'alert' ? 'Mode' : 'Action', value: result.slice(0, 1024), inline: false }],
        footer: { text: `User ID: ${e.authorId}` },
        timestamp: this.o.now().toISOString(),
      },
    });
    if (!res.ok) this.o.logger.warn('bot bait alert not posted', { detail: res.detail });
  }

  private record(e: MessageEvent, action: string, outcome: DiscordProtectionEventRecord['outcome'], detail: string): void {
    try {
      discordProtectionEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId: e.guildId,
        feature: 'botbait',
        rule: 'trap',
        userId: e.authorId,
        userName: e.authorName ?? null,
        channelId: e.channelId,
        action,
        outcome,
        detail,
      });
    } catch (err) {
      this.o.logger.warn('could not record a bot bait event', { err });
    }
  }

  /** Waits until queued actions are done (tests). */
  async idle(): Promise<void> {
    await this.queue;
  }
}

const hours = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`);

function describeFailure(err: unknown): string {
  return describeDiscordFailure(err, {
    forbidden: 'Discord refused: the bot needs Manage Messages (and Timeout, Kick or Ban Members for those actions), with its role above theirs.',
    notFound: 'Discord couldn’t find them (they may have left).',
  });
}
