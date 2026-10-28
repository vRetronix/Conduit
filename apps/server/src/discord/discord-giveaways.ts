/**
 * Discord side of giveaways: choosing an announcement channel, checking the bot's permissions there, and posting and
 * updating the embed with its Enter/Leave buttons. Everything goes through the bot's own REST credentials (DiscordApi),
 * so it works whether or not the gateway is connected; button clicks themselves arrive as interactions on the gateway
 * (DiscordBotRunner → GiveawayService.onDiscordButton).
 *
 * Failures are translated into messages that say what to do (missing permission, deleted channel or message, bot
 * removed, token rejected, network), and are never reported as success. Logs hold ids and outcomes only.
 */
import { discordRepo, type Database, type GiveawayRecord, type GiveawayWinnerRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  GIVEAWAY_BUTTONS,
  GIVEAWAY_CHANNEL_PERMISSIONS,
  type DiscordChannelRef,
  type DiscordChannelsState,
} from '@conduit/shared';
import { DiscordApiError, type DiscordApi, type GuildChannel, type GuildRole, type MessageBody } from './discord-api';
import type { DiscordCredentials } from './discord-credentials';

const ADMINISTRATOR = 1n << 3n;
/** Text and announcement channels can hold the embed. */
const MESSAGE_CHANNEL_TYPES = new Set([0, 5]);
/**
 * Button custom_id: "giveaway:enter:<giveaway id>". It only says which giveaway (no user data, nothing secret); a click
 * is still checked against the stored message, channel and server. There is no leave button: entering is one-way.
 */
const BUTTON_ID = /^giveaway:enter:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function giveawayButtonId(giveawayId: string): string {
  return `giveaway:enter:${giveawayId}`;
}

/** The giveaway of an Enter button's custom_id; null for anything that isn't exactly one of ours. */
export function parseGiveawayButtonId(customId: unknown): { giveawayId: string } | null {
  if (typeof customId !== 'string' || customId.length > 100) return null;
  const m = BUTTON_ID.exec(customId);
  return m ? { giveawayId: m[1]! } : null;
}
const CHANNEL_CACHE_MS = 30_000;

export const BRAND_COLORS = { blue: 0x048ba8, gold: 0xeec584, olive: 0x353531 } as const;

export type DiscordOutcome =
  | { ok: true; messageId: string }
  | { ok: false; status: 'failed' | 'missing'; detail: string; retryAfterSeconds?: number };

export interface DiscordGiveawaysOptions {
  db: Database;
  logger: Logger;
  api: DiscordApi;
  credentials: DiscordCredentials;
  now: () => Date;
}

/**
 * The bot's effective permissions in a channel (Discord's documented algorithm): @everyone and the member's roles,
 * Administrator grants everything, then the channel's @everyone, role and member overwrites in that order.
 */
export function channelPermissions(o: {
  guildId: string;
  userId: string;
  roles: readonly GuildRole[];
  memberRoleIds: readonly string[];
  overwrites: GuildChannel['overwrites'];
}): bigint {
  const roleById = new Map(o.roles.map((r) => [r.id, r.permissions]));
  let perms = roleById.get(o.guildId) ?? 0n;
  for (const id of o.memberRoleIds) perms |= roleById.get(id) ?? 0n;
  if ((perms & ADMINISTRATOR) === ADMINISTRATOR) return ~0n;
  const everyone = o.overwrites.find((w) => w.id === o.guildId);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
  let allow = 0n;
  let deny = 0n;
  for (const w of o.overwrites) {
    if (w.type === 0 && w.id !== o.guildId && o.memberRoleIds.includes(w.id)) {
      allow |= w.allow;
      deny |= w.deny;
    }
  }
  perms = (perms & ~deny) | allow;
  const member = o.overwrites.find((w) => w.type === 1 && w.id === o.userId);
  if (member) perms = (perms & ~member.deny) | member.allow;
  return perms;
}

/** Names of the giveaway permissions missing from `perms`. */
export function missingPermissions(perms: bigint): string[] {
  return GIVEAWAY_CHANNEL_PERMISSIONS.filter((p) => (perms & p.bit) !== p.bit).map((p) => p.name);
}

export class DiscordGiveaways {
  private cache: { at: number; state: DiscordChannelsState } | null = null;
  /** The last list Discord answered in full, per server: shown again while Discord is busy or unreachable. */
  private readonly lastGood = new Map<string, DiscordChannelsState['guilds'][number]>();
  /** No requests before this time (ms): set when Discord rate limits or fails, so polling never keeps hammering it. */
  private backoffUntil = 0;
  /** A refresh in progress: callers at the same moment share it (several features ask at startup). */
  private inFlight: Promise<DiscordChannelsState> | null = null;

  constructor(private readonly o: DiscordGiveawaysOptions) {}

  /**
   * Text channels in each of the bot's servers, with the permissions the bot lacks in each. Cached for 30 s. When
   * Discord rate limits (or fails), CONDUIT waits before asking again — also for forced refreshes — and keeps showing
   * the last channels it knew, so pages keep their channel names instead of an error.
   */
  async channels(force = false): Promise<DiscordChannelsState> {
    const nowMs = this.o.now().getTime();
    if (this.cache && ((!force && nowMs - this.cache.at < CHANNEL_CACHE_MS) || nowMs < this.backoffUntil)) return this.cache.state;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(nowMs).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(nowMs: number): Promise<DiscordChannelsState> {
    const token = await this.o.credentials.botToken();
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (!token || !botUserId) return { guilds: [], problem: 'Set up Discord first (Dashboard → Discord → Connect).' };
    const backOff = (err: unknown) => {
      const seconds = err instanceof DiscordApiError && err.kind === 'rate_limited' ? Math.max(err.retryAfterSeconds ?? 5, 5) : 10;
      this.backoffUntil = nowMs + seconds * 1000;
    };
    let guilds: Array<{ id: string; name: string }>;
    try {
      guilds = await this.o.api.botGuilds(token);
    } catch (err) {
      backOff(err);
      const known = [...this.lastGood.values()];
      const state: DiscordChannelsState = known.length > 0 ? { guilds: known, problem: null } : { guilds: [], problem: describe(err, null).detail };
      this.cache = { at: nowMs, state };
      return state;
    }
    const state: DiscordChannelsState = { guilds: [], problem: guilds.length === 0 ? 'The bot isn’t in any server yet. Add it to your server first.' : null };
    let busy = false;
    for (const guild of guilds.slice(0, 25)) {
      // Once Discord is busy, the remaining servers keep what was known (no further requests this round).
      const known = this.lastGood.get(guild.id);
      if (busy && known) {
        state.guilds.push(known);
        continue;
      }
      try {
        const [channels, roles, memberRoleIds] = await Promise.all([
          this.o.api.guildChannels(token, guild.id),
          this.o.api.guildRoles(token, guild.id),
          this.o.api.guildMemberRoles(token, guild.id, botUserId),
        ]);
        const toBits = (p: bigint) => (p < 0n ? ((1n << 64n) - 1n).toString() : p.toString()); // Administrator: all bits
        state.guilds.push({
          id: guild.id,
          name: guild.name,
          channels: channels
            .filter((ch) => MESSAGE_CHANNEL_TYPES.has(ch.type))
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
            .map((ch) => {
              const perms = channelPermissions({ guildId: guild.id, userId: botUserId, roles, memberRoleIds, overwrites: ch.overwrites });
              return { id: ch.id, name: ch.name, missing: missingPermissions(perms), permissions: toBits(perms) };
            }),
          permissions: toBits(channelPermissions({ guildId: guild.id, userId: botUserId, roles, memberRoleIds, overwrites: [] })),
          roles: roles
            .filter((r) => r.id !== guild.id && !r.managed)
            .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
            .map((r) => ({ id: r.id, name: r.name ?? r.id, mentionable: r.mentionable ?? false })),
          problem: null,
        });
        this.lastGood.set(guild.id, state.guilds.at(-1)!);
      } catch (err) {
        if (err instanceof DiscordApiError && (err.kind === 'rate_limited' || err.kind === 'network' || err.kind === 'server_error')) {
          busy = true;
          backOff(err);
        }
        state.guilds.push(busy && known ? known : { id: guild.id, name: guild.name, channels: [], problem: describe(err, null).detail });
      }
    }
    for (const id of this.lastGood.keys()) if (!guilds.some((g) => g.id === id)) this.lastGood.delete(id);
    this.cache = { at: nowMs, state };
    return state;
  }

  /** Whether the bot can announce in `ref` right now; the channel's name if so. Fresh (not cached). */
  async check(ref: NonNullable<DiscordChannelRef>): Promise<{ ok: true; channelName: string } | { ok: false; problem: string }> {
    const state = await this.channels(true);
    const guild = state.guilds.find((g) => g.id === ref.guildId);
    if (!guild) return { ok: false, problem: state.problem ?? 'The bot isn’t in that Discord server anymore. Choose another channel.' };
    if (guild.problem) return { ok: false, problem: guild.problem };
    const channel = guild.channels.find((c) => c.id === ref.channelId);
    if (!channel) return { ok: false, problem: 'That Discord channel no longer exists (or isn’t a text channel). Choose another channel.' };
    if (channel.missing.length > 0) {
      return {
        ok: false,
        problem: `The bot is missing ${channel.missing.join(', ')} in #${channel.name}. Give the bot’s role these permissions in that channel (Edit Channel → Permissions), or add the bot again from Discord setup, then try again.`,
      };
    }
    return { ok: true, channelName: channel.name };
  }

  /** Posts the announcement (embed and buttons). */
  async post(g: GiveawayRecord, message: MessageBody): Promise<DiscordOutcome> {
    const token = await this.o.credentials.botToken();
    if (!token || !g.discordChannelId) return { ok: false, status: 'failed', detail: 'Set up Discord first (Dashboard → Discord → Connect).' };
    let messageId: string;
    try {
      messageId = await this.o.api.createMessage(token, g.discordChannelId, message);
    } catch (err) {
      this.o.logger.warn('discord giveaway post failed', { giveawayId: g.id, kind: kindOf(err) });
      return describe(err, g.discordChannelName);
    }
    return { ok: true, messageId };
  }

  /** Edits the existing announcement. */
  async edit(g: GiveawayRecord, message: MessageBody): Promise<DiscordOutcome> {
    const token = await this.o.credentials.botToken();
    if (!token || !g.discordChannelId || !g.discordMessageId) return { ok: false, status: 'failed', detail: 'Set up Discord first (Dashboard → Discord → Connect).' };
    try {
      await this.o.api.editMessage(token, g.discordChannelId, g.discordMessageId, message);
      return { ok: true, messageId: g.discordMessageId };
    } catch (err) {
      this.o.logger.warn('discord giveaway update failed', { giveawayId: g.id, kind: kindOf(err) });
      return describe(err, g.discordChannelName);
    }
  }

}

function kindOf(err: unknown): string {
  return err instanceof DiscordApiError ? `${err.kind}${err.discordCode ? `:${err.discordCode}` : ''}` : 'unknown';
}

/** A Discord failure as a status and a message that says what to do. */
export function describe(err: unknown, channelName: string | null): Extract<DiscordOutcome, { ok: false }> {
  const where = channelName ? `#${channelName}` : 'the announcement channel';
  if (!(err instanceof DiscordApiError)) return { ok: false, status: 'failed', detail: 'Something went wrong talking to Discord. Select Retry.' };
  switch (err.kind) {
    case 'invalid_credentials':
      return { ok: false, status: 'failed', detail: 'Discord rejected the bot token. Enter a new one under Dashboard → Discord → Manage, then select Retry.' };
    case 'forbidden':
      if (err.discordCode === 50001)
        return { ok: false, status: 'failed', detail: `The bot can’t access ${where}. Give its role View Channel there (or choose another channel), then select Retry.` };
      return {
        ok: false,
        status: 'failed',
        detail: `The bot is missing permissions in ${where}: it needs View Channel, Send Messages and Embed Links. Fix the channel’s permissions, then select Retry.`,
      };
    case 'not_found':
      if (err.discordCode === 10008) return { ok: false, status: 'missing', detail: 'The announcement message was deleted in Discord. Select Repost to post it again.' };
      if (err.discordCode === 10004) return { ok: false, status: 'missing', detail: 'The bot is no longer in that Discord server. Add it again, or choose another channel.' };
      return { ok: false, status: 'missing', detail: `${where[0]!.toUpperCase()}${where.slice(1)} no longer exists in Discord. Choose another channel and repost.` };
    case 'rate_limited':
      return { ok: false, status: 'failed', detail: 'Discord asked the bot to slow down; CONDUIT will try again shortly.', retryAfterSeconds: err.retryAfterSeconds ?? 5 };
    case 'network':
      return { ok: false, status: 'failed', detail: 'Couldn’t reach Discord. Check your internet connection, then select Retry.' };
    case 'server_error':
      return { ok: false, status: 'failed', detail: 'Discord had a problem. Select Retry in a moment.' };
    default:
      return { ok: false, status: 'failed', detail: 'Discord returned an unexpected response. Select Retry.' };
  }
}

// ── the embed ──

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * The announcement message for a giveaway in its current state: a clean embed and the Enter Giveaway button, enabled
 * only while entries are open. It explains entering on Discord only (Kick's !enter is announced in Kick chat). Mentions
 * in embeds never ping (and none are allowed).
 */
export function giveawayMessage(g: GiveawayRecord, d: { winners: readonly GiveawayWinnerRecord[] }): MessageBody {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  const lines: string[] = [];
  if (g.description) lines.push(clip(g.description, 1500));

  if (g.status === 'open' || g.status === 'draft') {
    fields.push({ name: 'How to enter', value: `Click **${GIVEAWAY_BUTTONS.enter.emoji} ${GIVEAWAY_BUTTONS.enter.label}** below.` });
    fields.push({ name: 'Winners', value: String(g.winnerCount), inline: true });
    fields.push({ name: 'Closes', value: g.endsAt ? `<t:${unix(g.endsAt)}:R> (<t:${unix(g.endsAt)}:f>)` : 'When the host ends it', inline: true });
  } else if (g.status === 'closed') {
    lines.push('**Entries are closed.** Winners will be drawn soon.');
    fields.push({ name: 'Winners', value: String(g.winnerCount), inline: true });
  } else if (g.status === 'drawn') {
    const current = d.winners.filter((w) => w.status === 'won');
    lines.push(current.length === 1 ? '**The winner has been drawn. Congratulations!**' : '**The winners have been drawn. Congratulations!**');
    fields.push({ name: current.length === 1 ? '🏆 Winner' : '🏆 Winners', value: winnerLines(current) });
    if (d.winners.some((w) => w.status === 'replaced')) fields.push({ name: 'Note', value: 'Some winners were redrawn by the host.', inline: true });
  } else {
    lines.push('**This giveaway was cancelled.**');
  }

  const embed = {
    title: clip(`${g.status === 'drawn' ? '🏆' : '🎉'} ${g.prize}`, 256),
    description: lines.length ? clip(lines.join('\n\n'), 4096) : undefined,
    color: g.status === 'open' || g.status === 'draft' ? BRAND_COLORS.blue : g.status === 'cancelled' ? BRAND_COLORS.olive : BRAND_COLORS.gold,
    fields,
    ...(g.status === 'drawn' && g.drawnAt ? { timestamp: g.drawnAt } : g.endsAt ? { timestamp: g.endsAt } : {}),
  };
  const open = g.status === 'open';
  // Type 1 = action row, 2 = button; style 1 = primary (blurple).
  const buttons = {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: giveawayButtonId(g.id),
        label: GIVEAWAY_BUTTONS.enter.label,
        emoji: { name: GIVEAWAY_BUTTONS.enter.emoji },
        disabled: !open,
      },
    ],
  };
  return { embeds: [embed], components: [buttons], allowed_mentions: { parse: [] } };
}

function winnerLines(winners: readonly GiveawayWinnerRecord[]): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, w] of winners.entries()) {
    const line = `${w.position}. ${w.platform === 'discord' ? `<@${w.platformUserId}>` : `${clip(w.displayName, 60)} (Kick)`}`;
    if (used + line.length + 1 > 980) {
      out.push(`… and ${winners.length - i} more`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n') || '—';
}
