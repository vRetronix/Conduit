/**
 * Discord Logging: server events posted as detailed embeds to the channels chosen per category.
 *
 * Sources (the bot's existing gateway session; see discord-bot.ts):
 * - Moderation: Discord's audit log as it's written (Guild Moderation intent; the bot needs View Audit Log) — entries
 *   exist only for completed actions, with who did it and why, including AutoMod's (blocked, flagged, timed out) —
 *   and CONDUIT's own moderation records (success only;
 *   failures only if "Failed CONDUIT commands" is on, and then labelled Failed). Audit entries written by the bot itself
 *   are skipped: those are CONDUIT commands, already logged with the member who ran them.
 * - Messages: deleted, edited, bulk-deleted (Guild Messages intent). Text needs the privileged Message Content intent.
 *   discord.js only knows the text of messages it saw since it connected, so while Messages logging is on the text of
 *   new messages in the logged server is kept (discord_message_texts, 7 days) and used when Discord doesn't send it.
 * - Members: joins, leaves, nicknames, roles (privileged Server Members intent).
 * - Server: channels and roles created, deleted or changed.
 * - XP & Loyalty: Loyalty & Rewards' own changes (level-ups, adjustments, redemptions, level roles, resets), for the
 *   logged server (points belong to the member's account, not a server, so they're logged there too).
 * Each event is logged once (database key); bots' own messages and the log channels' own traffic aren't logged.
 * What's posted (members, messages, server) is also kept (discord_log_entries) for Discord Bot → Logs → Moderation log;
 * moderation and loyalty events are already kept there by their own services.
 * Logging only posts; it never acts on anything and is independent of command replies and moderation.
 */
import crypto from 'node:crypto';
import { discordLogEntriesRepo, discordMessageTextsRepo, logEventsRepo, settingsRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  DEFAULT_LOGGING_SETTINGS,
  formatPoints,
  LOG_CATEGORIES,
  LOG_EVENTS,
  loggingSettingsSchema,
  missingDiscordPermissions,
  type DiscordChannelsState,
  type LogCategory,
  type LoggingSettings,
  type LoggingState,
  type ModerationRecordView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import type { GuildEvent, PrivilegedIntents, UserRef } from './discord-bot';
import { parseInput } from '../validation';
import type { DiscordPoster } from './discord-poster';
import type { LoyaltyEvent } from './loyalty-service';

const SETTINGS_KEY = 'discord.logging';
/** Application flags (Developer Portal toggles): GATEWAY_PRESENCE(_LIMITED), GATEWAY_GUILD_MEMBERS(_LIMITED), GATEWAY_MESSAGE_CONTENT(_LIMITED). */
const FLAG_PRESENCE = (1 << 12) | (1 << 13);
const FLAG_MEMBERS = (1 << 14) | (1 << 15);
const FLAG_CONTENT = (1 << 18) | (1 << 19);
/** At most one automatic reconnect to pick up newly enabled intents per this long. */
const INTENT_RECONNECT_MS = 10 * 60_000;
/** Message text is kept this long for deleted and edited messages, and old text is removed at most this often. */
const TEXT_KEPT_MS = 7 * 24 * 3600_000;
const TEXT_PRUNE_MS = 60_000;

const COLOR = { red: 0xe74c3c, orange: 0xe67e22, amber: 0xf1c40f, green: 0x2ecc71, blue: 0x3498db, gray: 0x95a5a6, purple: 0x9b59b6 };

export interface DiscordLoggingServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  poster: Pick<DiscordPoster, 'post'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
  botUserId: () => string | null;
  /** CONDUIT deleted this message itself for one of its features (a replaced sticky, a recreated Embed Creator message). */
  deletedByConduit?: (messageId: string) => boolean;
  /** The application's flags from Discord (which privileged intents are enabled on the Developer Portal). */
  applicationFlags: () => Promise<number | null>;
  /** What the current bot connection actually uses. */
  activeIntents: () => PrivilegedIntents & { refused: boolean };
  /** Reconnects the bot so changed intents take effect. */
  restartBot: () => Promise<void>;
  onModerationAction: (listener: (r: ModerationRecordView) => void) => () => void;
  /** Loyalty & Rewards' saved changes, and whether it (and XP) is switched on. */
  onLoyaltyEvent?: (listener: (e: LoyaltyEvent) => void) => () => void;
  loyaltyStatus?: () => { enabled: boolean; xp: boolean };
}

type Embed = Record<string, unknown>;

export class DiscordLoggingService {
  private flags: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private off: (() => void) | null = null;
  private offLoyalty: (() => void) | null = null;

  constructor(private readonly o: DiscordLoggingServiceOptions) {}

  private flagsTimer: NodeJS.Timeout | null = null;
  private lastTextPrune = 0;

  async start(): Promise<void> {
    this.off ??= this.o.onModerationAction((r) => this.onModeration(r));
    this.offLoyalty ??= this.o.onLoyaltyEvent?.((e) => this.onLoyalty(e)) ?? null;
    await this.refreshFlags();
    // The required privileged intents: notice when one is turned on in the Developer Portal, even with no page open.
    this.flagsTimer ??= setInterval(() => void this.refreshFlags(), 5 * 60_000);
    this.flagsTimer.unref();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.offLoyalty?.();
    this.offLoyalty = null;
    if (this.flagsTimer) clearInterval(this.flagsTimer);
    this.flagsTimer = null;
  }

  idle(): Promise<void> {
    return this.queue;
  }

  // ── settings and intents ───────────────────────────────────────────────────

  settings(): LoggingSettings {
    const raw = settingsRepo.get(this.o.db, SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_LOGGING_SETTINGS);
    try {
      const parsed = loggingSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : structuredClone(DEFAULT_LOGGING_SETTINGS);
    } catch {
      return structuredClone(DEFAULT_LOGGING_SETTINGS);
    }
  }

  /**
   * Privileged intents for the next bot connection. All three are required by CONDUIT: each is requested whenever it's
   * enabled on the Developer Portal (Discord refuses a connection asking for one that isn't).
   */
  privilegedIntents(): PrivilegedIntents {
    const on = (mask: number) => this.flags !== null && (this.flags & mask) !== 0;
    return { members: on(FLAG_MEMBERS), messageContent: on(FLAG_CONTENT), presences: on(FLAG_PRESENCE) };
  }

  private lastIntentReconnect = 0;

  /** Reads the portal toggles; when one was just turned on, reconnects the bot once to start using it. */
  private async refreshFlags(): Promise<void> {
    this.flags = await this.o.applicationFlags().catch(() => null);
    const want = this.privilegedIntents();
    const active = this.o.activeIntents();
    const missing = (want.members && !active.members) || (want.messageContent && !active.messageContent) || (want.presences && !active.presences);
    const now = this.o.now().getTime();
    if (missing && !active.refused && now - this.lastIntentReconnect > INTENT_RECONNECT_MS) {
      this.lastIntentReconnect = now;
      await this.o.restartBot().catch(() => undefined);
    }
  }

  async state(): Promise<LoggingState> {
    await this.refreshFlags();
    const s = this.settings();
    const channels = await this.o.discordChannels().catch(() => null);
    const guild = channels?.guilds.find((g) => g.id === s.guildId) ?? null;
    const active = this.o.activeIntents();
    const portal = (mask: number) => (this.flags === null ? null : (this.flags & mask) !== 0);
    const audit = guild ? missingDiscordPermissions(guild.permissions, ['viewAuditLog']).length === 0 : null;
    const portalNote = (toggle: string) => `CONDUIT needs “${toggle}”: turn it on on the Bot page of your application in the Discord Developer Portal.`;
    return {
      settings: s,
      availability: {
        moderation: {
          available: audit !== false,
          problem: audit === false ? 'The bot needs View Audit Log in this server to see bans, kicks and timeouts (Server Settings → Roles → the bot’s role).' : null,
          partial: null,
        },
        members: {
          available: active.members,
          problem: active.members ? null : (active.refused ? 'Discord refused the Server Members intent. ' : '') + portalNote('Server Members Intent'),
          partial: null,
        },
        messages: { available: true, problem: null, partial: active.messageContent ? null : 'Message text isn’t available (privileged Message Content intent off): logs show who and where, not what was written.' },
        server: { available: true, problem: null, partial: null },
        loyalty: { available: true, problem: null, partial: loyaltyNote(this.o.loyaltyStatus?.() ?? null) },
      },
      intents: {
        members: { portal: portal(FLAG_MEMBERS), inUse: active.members },
        messageContent: { portal: portal(FLAG_CONTENT), inUse: active.messageContent },
        presences: { portal: portal(FLAG_PRESENCE), inUse: active.presences },
      },
      auditLogAccess: audit,
      discord: { ready: channels !== null && channels.problem === null, problem: channels?.problem ?? (channels ? null : 'Discord isn’t reachable.') },
    };
  }

  async save(raw: unknown): Promise<LoggingState> {
    const next = parseInput(loggingSettingsSchema, raw);
    const issues: Array<{ path: string; message: string }> = [];
    const channels = await this.o.discordChannels(true);
    const guild = channels.guilds.find((g) => g.id === next.guildId);
    for (const c of LOG_CATEGORIES) {
      if (!next[c].enabled || !next[c].channelId) continue;
      const ch = guild?.channels.find((x) => x.id === next[c].channelId);
      if (!ch) issues.push({ path: `${c}.channelId`, message: 'The bot can’t see that channel.' });
      else {
        const missing = missingDiscordPermissions(ch.permissions, ['viewChannel', 'sendMessages', 'embedLinks']);
        if (missing.length) issues.push({ path: `${c}.channelId`, message: `The bot needs ${missing.join(', ')} in #${ch.name}.` });
      }
    }
    if (issues.length) throw new AppError('validation_error', 'Some log channels can’t be used', { issues });
    settingsRepo.set(this.o.db, SETTINGS_KEY, JSON.stringify(next), this.o.now().toISOString());
    // Message text is only kept while it's needed: Messages logging on, for the logged server.
    if (!next.messages.enabled || !next.guildId) discordMessageTextsRepo.clear(this.o.db);
    else discordMessageTextsRepo.clear(this.o.db, next.guildId);
    writeAudit(this.o.db, { action: 'discord_logging.updated', outcome: 'success', actorUserId: null, metadata: { categories: LOG_CATEGORIES.filter((c) => next[c].enabled) } }, this.o.now());
    return this.state();
  }

  // ── events ─────────────────────────────────────────────────────────────────

  onDiscordEvent(e: GuildEvent): void {
    try {
      const s = this.settings();
      if (!s.guildId || e.guildId !== s.guildId) return;
      if (e.type === 'message_create') return this.keepText(e, s);
      // CONDUIT tidying up after its own features isn't news (and the old message is often one it never saw).
      if (e.type === 'message_delete' && this.o.deletedByConduit?.(e.messageId)) return this.updateKeptText(e);
      const built = this.build(this.withKeptText(e), s);
      if (built) this.emit(built.category, built.event, built.key, built.embed, s);
      this.updateKeptText(e);
    } catch (err) {
      this.o.logger.error('discord log event failed', { err });
    }
  }

  /** Keeps a new message's text while deleted or edited messages are logged (see the file comment). */
  private keepText(e: Extract<GuildEvent, { type: 'message_create' }>, s: LoggingSettings): void {
    const m = s.messages;
    if (!m.enabled || !m.channelId || (m.off.includes('delete') && m.off.includes('edit'))) return;
    // Messages with no text (only an embed, image or file) are kept too, so their deletion shows "No text".
    if (e.authorBot || e.system || e.content === undefined || this.isLogChannel(e.channelId, s)) return;
    const now = this.o.now().getTime();
    discordMessageTextsRepo.put(this.o.db, {
      messageId: e.messageId,
      guildId: e.guildId,
      channelId: e.channelId,
      authorId: e.authorId,
      authorName: e.authorName ?? null,
      content: e.content,
      createdAt: new Date(now).toISOString(),
    });
    if (now - this.lastTextPrune > TEXT_PRUNE_MS) {
      this.lastTextPrune = now;
      discordMessageTextsRepo.prune(this.o.db, new Date(now - TEXT_KEPT_MS).toISOString());
    }
  }

  /** Fills in text (and the author) Discord didn't send, from what was kept. */
  private withKeptText<E extends Exclude<GuildEvent, { type: 'message_create' }>>(e: E): E {
    if (e.type === 'message_delete' && e.content === null) {
      const kept = discordMessageTextsRepo.get(this.o.db, e.messageId);
      if (kept) return { ...e, content: kept.content, author: e.author ?? { id: kept.authorId, tag: kept.authorName ?? 'Unknown', avatarUrl: null, bot: false } };
    }
    if (e.type === 'message_update' && e.before === null) {
      const kept = discordMessageTextsRepo.get(this.o.db, e.messageId);
      if (kept) return { ...e, before: kept.content, author: e.author ?? { id: kept.authorId, tag: kept.authorName ?? 'Unknown', avatarUrl: null, bot: false } };
    }
    return e;
  }

  /** Deleted messages' text is let go; edited ones keep their new text. */
  private updateKeptText(e: GuildEvent): void {
    if (e.type === 'message_delete') discordMessageTextsRepo.remove(this.o.db, [e.messageId]);
    else if (e.type === 'message_delete_bulk') discordMessageTextsRepo.remove(this.o.db, e.messageIds);
    else if (e.type === 'message_update' && e.after !== null) discordMessageTextsRepo.setContent(this.o.db, e.messageId, e.after);
  }

  /** Why a message's text isn't shown. */
  private textUnavailable(): string {
    return this.o.activeIntents().messageContent
      ? 'CONDUIT hadn’t seen this message: it was sent before Messages logging was on, while CONDUIT was closed, or more than 7 days ago'
      : 'the Message Content intent is off';
  }

  private onModeration(r: ModerationRecordView): void {
    if (r.platform !== 'discord') return;
    const s = this.settings();
    if (!s.guildId) return;
    const event = r.outcome === 'success' ? r.action : 'failed';
    if (!['ban', 'unban', 'timeout', 'untimeout', 'failed'].includes(event)) return;
    const moderator = r.actor ?? 'CONDUIT';
    const target = r.targetUserId !== 'unknown' ? `<@${r.targetUserId}> **${r.targetName ?? r.targetUserId}**` : (r.targetName ?? 'Unknown');
    const embed: Embed =
      r.outcome === 'success'
        ? {
            color: r.action === 'ban' ? COLOR.red : r.action === 'timeout' ? COLOR.amber : COLOR.green,
            title: { ban: 'Member banned', unban: 'Member unbanned', timeout: 'Member timed out', untimeout: 'Timeout removed' }[r.action as 'ban'] ?? 'Moderation',
            description: target,
            fields: [
              { name: 'Moderator', value: moderator, inline: true },
              ...(r.durationSeconds ? [{ name: 'Duration', value: formatDuration(r.durationSeconds), inline: true }] : []),
              { name: 'Reason', value: r.reason ?? 'No reason given', inline: false },
            ],
            footer: { text: `User ID: ${r.targetUserId} · via CONDUIT` },
            timestamp: r.at,
          }
        : {
            color: COLOR.gray,
            title: 'Moderation command failed (nothing was done)',
            description: target,
            fields: [
              { name: 'Attempted', value: r.action, inline: true },
              { name: 'By', value: moderator, inline: true },
              { name: 'Discord’s answer', value: cut(r.detail ?? 'Refused', 1024), inline: false },
            ],
            footer: { text: `User ID: ${r.targetUserId}` },
            timestamp: r.at,
          };
    this.emit('moderation', event, `conduit:${r.id}`, embed, s);
  }

  private onLoyalty(e: LoyaltyEvent): void {
    try {
      const s = this.settings();
      if (!s.guildId || ('guildId' in e && e.guildId !== s.guildId)) return;
      this.emit('loyalty', e.kind, `loyalty:${e.id}`, loyaltyEmbed(e), s);
    } catch (err) {
      this.o.logger.error('discord loyalty log failed', { err });
    }
  }

  /** Builds the log embed for an event, or null when it isn't logged. */
  private build(e: Exclude<GuildEvent, { type: 'message_create' }>, s: LoggingSettings): { category: LogCategory; event: string; key: string; embed: Embed } | null {
    const at = this.o.now().toISOString();
    const footerUser = (u: UserRef | null, extra = '') => ({ text: `${u ? `User ID: ${u.id}` : 'User unknown'}${extra}` });
    const author = (u: UserRef | null) => (u ? { name: u.tag, ...(u.avatarUrl ? { icon_url: u.avatarUrl } : {}) } : undefined);
    switch (e.type) {
      case 'audit_change':
        return null; // channel and role changes are logged from their own events; these feed anti-nuke
      case 'audit': {
        if (e.executor && e.executor.id === this.o.botUserId()) return null; // a CONDUIT command: logged from its own record
        const targetText = e.target ? `<@${e.target.id}> **${e.target.tag}**` : e.targetId ? `<@${e.targetId}>` : 'Unknown';
        if (e.action === 'automod_block' || e.action === 'automod_flag' || e.action === 'automod_timeout') {
          const titles = { automod_block: 'Message blocked by AutoMod', automod_flag: 'Message flagged by AutoMod', automod_timeout: 'Member timed out by AutoMod' };
          return {
            category: 'moderation',
            event: 'automod',
            key: `audit:${e.entryId}`,
            embed: {
              color: e.action === 'automod_flag' ? COLOR.amber : COLOR.purple,
              author: author(e.target),
              title: titles[e.action],
              description: targetText,
              fields: [
                { name: 'Rule', value: cut(e.ruleName ?? 'Unknown rule', 256), inline: true },
                ...(e.channelId ? [{ name: 'Channel', value: `<#${e.channelId}>`, inline: true }] : []),
                ...(e.reason ? [{ name: 'Reason', value: cut(e.reason, 1024), inline: false }] : []),
              ],
              footer: { text: `User ID: ${e.targetId ?? e.target?.id ?? 'unknown'} · Audit log entry ${e.entryId}` },
              timestamp: at,
            },
          };
        }
        const titles = { ban: 'Member banned', unban: 'Member unbanned', kick: 'Member kicked', timeout: 'Member timed out', untimeout: 'Timeout removed' };
        const colors = { ban: COLOR.red, unban: COLOR.green, kick: COLOR.orange, timeout: COLOR.amber, untimeout: COLOR.green };
        const until = e.until ? Math.floor(Date.parse(e.until) / 1000) : null;
        return {
          category: 'moderation',
          event: e.action,
          key: `audit:${e.entryId}`,
          embed: {
            color: colors[e.action],
            author: author(e.target),
            title: titles[e.action],
            description: targetText,
            fields: [
              { name: 'Moderator', value: e.executor ? `<@${e.executor.id}> ${e.executor.tag}` : 'Unknown', inline: true },
              ...(until ? [{ name: 'Until', value: `<t:${until}:F> (<t:${until}:R>)`, inline: true }] : []),
              { name: 'Reason', value: cut(e.reason ?? 'No reason given', 1024), inline: false },
            ],
            footer: { text: `User ID: ${e.targetId ?? e.target?.id ?? 'unknown'} · Audit log entry ${e.entryId}` },
            timestamp: at,
          },
        };
      }
      case 'message_delete': {
        if (e.author?.bot) return null;
        if (this.isLogChannel(e.channelId, s)) return null;
        const content = e.content === null ? `*Text unavailable (${this.textUnavailable()}).*` : e.content || '*No text*';
        return {
          category: 'messages',
          event: 'delete',
          key: `msgdel:${e.messageId}`,
          embed: {
            color: COLOR.red,
            author: author(e.author),
            title: 'Message deleted',
            description: `In <#${e.channelId}>${e.author ? ` · sent by <@${e.author.id}>` : ''}\n\n${cut(content, 3800)}`,
            ...(e.attachments ? { fields: [{ name: 'Attachments', value: String(e.attachments), inline: true }] } : {}),
            footer: footerUser(e.author, ` · Message ID: ${e.messageId}`),
            timestamp: at,
          },
        };
      }
      case 'message_delete_bulk':
        if (this.isLogChannel(e.channelId, s)) return null;
        return {
          category: 'messages',
          event: 'bulk_delete',
          key: `bulk:${e.channelId}:${e.messageIds.slice().sort()[0] ?? ''}:${e.messageIds.length}`,
          embed: { color: COLOR.red, title: 'Messages bulk-deleted', description: `**${e.messageIds.length}** messages deleted in <#${e.channelId}>.`, footer: { text: `Channel ID: ${e.channelId}` }, timestamp: at },
        };
      case 'message_update': {
        if (e.author?.bot) return null;
        if (this.isLogChannel(e.channelId, s)) return null;
        const show = (t: string | null) => (t === null ? `*Unavailable (${this.textUnavailable()})*` : t ? cut(t, 1024) : '*No text*');
        return {
          category: 'messages',
          event: 'edit',
          key: `edit:${e.messageId}:${hash(`${e.before ?? ''}→${e.after ?? ''}`)}`,
          embed: {
            color: COLOR.blue,
            author: author(e.author),
            title: 'Message edited',
            description: `In <#${e.channelId}>${e.author ? ` by <@${e.author.id}>` : ''} · [Jump to message](https://discord.com/channels/${e.guildId}/${e.channelId}/${e.messageId})`,
            fields: [
              { name: 'Before', value: show(e.before), inline: false },
              { name: 'After', value: show(e.after), inline: false },
            ],
            footer: footerUser(e.author, ` · Message ID: ${e.messageId}`),
            timestamp: at,
          },
        };
      }
      case 'member_join': {
        const created = e.accountCreatedAt ? Math.floor(Date.parse(e.accountCreatedAt) / 1000) : null;
        return {
          category: 'members',
          event: 'join',
          key: `join:${e.user.id}:${at.slice(0, 16)}`,
          embed: {
            color: COLOR.green,
            author: author(e.user),
            title: 'Member joined',
            description: `<@${e.user.id}> **${e.user.tag}**`,
            ...(created ? { fields: [{ name: 'Account created', value: `<t:${created}:D> (<t:${created}:R>)`, inline: true }] } : {}),
            ...(e.user.avatarUrl ? { thumbnail: { url: e.user.avatarUrl } } : {}),
            footer: footerUser(e.user),
            timestamp: at,
          },
        };
      }
      case 'member_leave':
        return {
          category: 'members',
          event: 'leave',
          key: `leave:${e.user.id}:${at.slice(0, 16)}`,
          embed: {
            color: COLOR.orange,
            author: author(e.user),
            title: 'Member left',
            description: `<@${e.user.id}> **${e.user.tag}**`,
            fields: [
              ...(e.joinedAt ? [{ name: 'Joined', value: `<t:${Math.floor(Date.parse(e.joinedAt) / 1000)}:R>`, inline: true }] : []),
              ...(e.roles.length ? [{ name: 'Roles', value: cut(e.roles.map((r) => `<@&${r.id}>`).join(' '), 1024), inline: false }] : []),
            ],
            footer: footerUser(e.user),
            timestamp: at,
          },
        };
      case 'member_update': {
        if (e.nickBefore !== e.nickAfter)
          return {
            category: 'members',
            event: 'nickname',
            key: `nick:${e.user.id}:${hash(`${e.nickBefore}→${e.nickAfter}`)}:${at.slice(0, 16)}`,
            embed: {
              color: COLOR.blue,
              author: author(e.user),
              title: 'Nickname changed',
              description: `<@${e.user.id}>`,
              fields: [
                { name: 'Before', value: e.nickBefore ?? '*None*', inline: true },
                { name: 'After', value: e.nickAfter ?? '*None*', inline: true },
              ],
              footer: footerUser(e.user),
              timestamp: at,
            },
          };
        return {
          category: 'members',
          event: 'roles',
          key: `roles:${e.user.id}:${hash(JSON.stringify([e.rolesAdded, e.rolesRemoved]))}:${at.slice(0, 16)}`,
          embed: {
            color: COLOR.blue,
            author: author(e.user),
            title: 'Roles changed',
            description: `<@${e.user.id}>`,
            fields: [
              ...(e.rolesAdded.length ? [{ name: 'Added', value: cut(e.rolesAdded.map((r) => `<@&${r.id}>`).join(' '), 1024), inline: false }] : []),
              ...(e.rolesRemoved.length ? [{ name: 'Removed', value: cut(e.rolesRemoved.map((r) => `<@&${r.id}>`).join(' '), 1024), inline: false }] : []),
            ],
            footer: footerUser(e.user),
            timestamp: at,
          },
        };
      }
      case 'channel':
      case 'role': {
        const isChannel = e.type === 'channel';
        const id = isChannel ? e.channelId : e.roleId;
        const mention = isChannel ? (e.action === 'delete' ? `#${e.name}` : `<#${id}>`) : e.action === 'delete' ? `@${e.name}` : `<@&${id}>`;
        const noun = isChannel ? 'Channel' : 'Role';
        return {
          category: 'server',
          event: isChannel ? 'channels' : 'roles',
          key: `${e.type}:${e.action}:${id}:${hash(JSON.stringify(e.changes))}:${at.slice(0, 16)}`,
          embed: {
            color: e.action === 'create' ? COLOR.green : e.action === 'delete' ? COLOR.red : COLOR.purple,
            title: `${noun} ${e.action === 'create' ? 'created' : e.action === 'delete' ? 'deleted' : 'updated'}`,
            description: `${mention} **${e.name}**`,
            ...(e.changes.length ? { fields: e.changes.slice(0, 10).map((ch) => ({ name: ch.key, value: cut(`${ch.before || '—'} → ${ch.after || '—'}`, 1024), inline: false })) } : {}),
            footer: { text: `${noun} ID: ${id}` },
            timestamp: at,
          },
        };
      }
    }
  }

  private isLogChannel(channelId: string, s: LoggingSettings): boolean {
    return LOG_CATEGORIES.some((c) => s[c].channelId === channelId);
  }

  private emit(category: LogCategory, event: string, key: string, embed: Embed, s: LoggingSettings): void {
    const c = s[category];
    if (!c.enabled || !c.channelId || c.off.includes(event)) return;
    if (!logEventsRepo.claim(this.o.db, key, this.o.now().toISOString())) return; // already logged
    const channelId = c.channelId;
    const guildId = s.guildId!;
    this.queue = this.queue.then(async () => {
      const res = await this.o.poster.post(channelId, { embed });
      if (!res.ok) this.o.logger.warn('discord log not posted', { category, event, detail: res.detail });
      // Moderation and loyalty are already in the Moderation log (from their own records); the rest is added here.
      if (category !== 'moderation' && category !== 'loyalty') await this.remember(guildId, category, event, embed, res.ok);
    });
  }

  /** Keeps what was logged for Discord Bot → Logs → Moderation log: the embed's title, who, and its text in short. */
  private async remember(guildId: string, category: Exclude<LogCategory, 'loyalty'>, event: string, embed: Embed, posted: boolean): Promise<void> {
    try {
      const channels = await this.o.discordChannels().catch(() => null);
      const names = new Map((channels?.guilds.find((g) => g.id === guildId)?.channels ?? []).map((c) => [c.id, c.name]));
      const clean = (t: string) =>
        t
          .replace(/<@!?\d+>/g, '')
          .replace(/<@&\d+>/g, '')
          .replace(/<#(\d+)>/g, (_, id: string) => `#${names.get(id) ?? 'channel'}`)
          .replace(/\*\*/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const author = (embed.author ?? null) as { name?: unknown } | null;
      const footer = (embed.footer ?? null) as { text?: unknown } | null;
      const fields = Array.isArray(embed.fields) ? (embed.fields as Array<{ name?: unknown; value?: unknown }>) : [];
      const userName = typeof author?.name === 'string' ? author.name : null;
      const description = typeof embed.description === 'string' ? clean(embed.description) : '';
      const parts = [
        userName && description === userName ? '' : description,
        ...fields.map((f) => `${typeof f.name === 'string' ? f.name : ''}: ${clean(typeof f.value === 'string' ? f.value : '')}`),
      ].filter(Boolean);
      discordLogEntriesRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        guildId,
        category,
        event,
        title: typeof embed.title === 'string' ? embed.title : (LOG_EVENTS[category][event] ?? event),
        userId: typeof footer?.text === 'string' ? (/User ID: (\d+)/.exec(footer.text)?.[1] ?? null) : null,
        userName,
        detail: parts.length ? cut(parts.join(' · '), 300) : null,
        posted,
      });
    } catch (err) {
      this.o.logger.warn('could not keep a discord log entry', { err });
    }
  }
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** Why XP & Loyalty logs may stay quiet: Loyalty & Rewards (or its XP) is switched off. */
function loyaltyNote(status: { enabled: boolean; xp: boolean } | null): string | null {
  if (!status) return null;
  if (!status.enabled) return 'Loyalty & Rewards is off, so there’s nothing to log until it’s switched on.';
  if (!status.xp) return 'XP & levels are off: only points, rewards and resets are logged.';
  return null;
}

/** The log embed for a Loyalty & Rewards change (for the server's staff: who, what changed, and why). */
function loyaltyEmbed(e: LoyaltyEvent): Embed {
  const n = (v: number) => v.toLocaleString('en-US');
  const pts = (v: number) => formatPoints(v, e.pointsName);
  const signed = (v: number, text: string) => `${v >= 0 ? '+' : '−'}${text}`;
  const member = e.userId ? `<@${e.userId}>${e.userName ? ` **${e.userName}**` : ''}` : 'Unknown member';
  const footer = { text: e.userId ? `User ID: ${e.userId}` : 'Loyalty & Rewards' };
  const base = { description: member, footer, timestamp: e.at };
  const reason = (r: string | null) => [{ name: 'Reason', value: cut(r || 'No reason given', 1024), inline: false }];
  switch (e.kind) {
    case 'level_up':
      return { ...base, color: COLOR.green, title: `Reached level ${e.level}`, fields: [{ name: 'Total XP', value: n(e.xp), inline: true }] };
    case 'xp':
      return {
        ...base,
        color: e.amount >= 0 ? COLOR.blue : COLOR.orange,
        title: e.amount >= 0 ? 'XP added' : 'XP removed',
        fields: [
          { name: 'Change', value: `${signed(e.amount, n(Math.abs(e.amount)))} XP`, inline: true },
          { name: 'Now', value: `${n(e.xp)} XP · level ${e.level}`, inline: true },
          ...reason(e.reason),
        ],
      };
    case 'points':
      return {
        ...base,
        color: e.amount >= 0 ? COLOR.blue : COLOR.orange,
        title: `${capitalize(e.pointsName)} ${e.amount >= 0 ? 'added' : 'removed'}`,
        fields: [
          { name: 'Change', value: signed(e.amount, pts(Math.abs(e.amount))), inline: true },
          { name: 'Balance', value: pts(e.balance), inline: true },
          ...reason(e.reason),
        ],
      };
    case 'redeemed':
      return {
        ...base,
        color: COLOR.amber,
        title: 'Reward redeemed',
        fields: [
          { name: 'Reward', value: cut(e.reward, 256), inline: true },
          { name: 'Cost', value: pts(e.cost), inline: true },
          { name: 'Balance', value: pts(e.balance), inline: true },
        ],
      };
    case 'resolved':
      return {
        ...base,
        color: e.status === 'fulfilled' ? COLOR.green : COLOR.red,
        title: e.status === 'fulfilled' ? 'Redemption fulfilled' : 'Redemption rejected',
        fields: [
          { name: 'Reward', value: cut(e.reward, 256), inline: true },
          ...(e.status === 'rejected' ? [{ name: 'Refunded', value: pts(e.cost), inline: true }] : []),
          ...(e.note ? [{ name: 'Note', value: cut(e.note, 1024), inline: false }] : []),
        ],
      };
    case 'roles':
      return {
        ...base,
        color: e.ok ? COLOR.green : COLOR.gray,
        title: e.ok ? 'Level role given' : 'Level role not given',
        fields: [
          { name: 'Role', value: `<@&${e.roleId}>`, inline: true },
          { name: 'Level', value: String(e.level), inline: true },
          ...(e.detail ? [{ name: 'Discord’s answer', value: cut(e.detail, 1024), inline: false }] : []),
        ],
      };
    case 'reset':
      if (e.members !== null)
        return {
          color: COLOR.orange,
          title: 'Leaderboard reset',
          description: `The XP of **${n(e.members)}** members was set to 0.`,
          fields: [{ name: 'By', value: cut(e.by, 256), inline: true }],
          footer,
          timestamp: e.at,
        };
      return {
        ...base,
        color: COLOR.orange,
        title: 'Member reset',
        fields: [
          { name: 'XP', value: `${n(e.xp)} → 0`, inline: true },
          { name: capitalize(e.pointsName), value: `${n(e.points)} → 0`, inline: true },
          { name: 'By', value: cut(e.by, 256), inline: true },
        ],
      };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
