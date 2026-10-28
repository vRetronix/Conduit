/**
 * The data behind custom command variables (see packages/shared/src/community/command-variables.ts), gathered for one command
 * run. Only what the reply uses is looked up, in parallel; every source fails softly (the variable is then empty or
 * uses its fallback), so a slow or unavailable source can never break a command.
 *
 * - Counters ({count}, {counter:name…}) are stored in the database and change only when a command that uses them runs.
 * - Your Kick stream ({title}, {uptime}…) comes from Kick's official public API, cached for 30 seconds.
 * - {randomuser} picks from people who chatted recently (kept in memory only, never message text).
 */
import { commandCountersRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { counterOps, variableTokens, type CommandPlatform, type StreamVariables, type VariableData } from '@conduit/shared';

const STREAM_CACHE_MS = 30_000;
const CHATTERS_KEPT = 50;
const STREAM_NAMES = new Set(['streamer', 'title', 'category', 'viewers', 'uptime', 'url']);

/** One command run, as the platform reported it. */
export interface CommandRun {
  platform: CommandPlatform;
  commandId: string;
  template: string;
  user: string;
  userId: string;
  channel: string | null;
  /** Where recent chatters are tracked for {randomuser}: the Kick channel, or the Discord server. */
  chatKey: string;
  args: string;
  message: string;
  kick?: { roles: string[]; subMonths: number | null };
  discord?: { guildId: string };
}

export interface CommandVariableServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  /** Your main Kick channel (slug and name), when connected. */
  mainKickChannel: () => { slug: string | null; name: string | null } | null;
  /** Your Kick channel's live status from Kick's official API. */
  kickChannelInfo: (slug: string) => Promise<{ live: boolean; title: string | null; category: string | null; viewers: number | null; startedAt: string | null } | null>;
  loyalty: (guildId: string, userId: string) => VariableData['loyalty'];
  discordGuild: (guildId: string) => { name: string; memberCount: number | null } | null;
  /** The commands people can use on a platform, for {commands}. */
  commandList: (platform: CommandPlatform) => string[];
  random?: () => number;
}

export class CommandVariableService {
  private stream: { at: number; value: StreamVariables | null } | null = null;
  private readonly chatters = new Map<string, string[]>();

  constructor(private readonly o: CommandVariableServiceOptions) {}

  /** Someone chatted (Kick chat, or a Discord server): remembered for {randomuser}. Names only. */
  noteChatter(platform: CommandPlatform, chatKey: string, name: string): void {
    const key = `${platform}:${chatKey}`;
    const list = (this.chatters.get(key) ?? []).filter((n) => n !== name);
    list.push(name);
    if (list.length > CHATTERS_KEPT) list.shift();
    this.chatters.set(key, list);
    if (this.chatters.size > 200) this.chatters.delete(this.chatters.keys().next().value!);
  }

  /** Everything the template needs for this run (counters are changed here, once). */
  async data(run: CommandRun): Promise<VariableData> {
    const names = new Set(variableTokens(run.template).map((t) => t.name));
    const uses = (n: string) => names.has(n);
    const nowIso = this.o.now().toISOString();
    const data: VariableData = {
      user: run.user,
      userId: run.userId,
      channel: run.channel,
      args: run.args,
      message: run.message,
      now: this.o.now(),
      random: this.o.random,
      roles: run.kick?.roles,
      subMonths: run.kick?.subMonths ?? null,
      mention: run.platform === 'discord' ? `<@${run.userId}>` : null,
    };

    // Counters: this run's changes, in the order they're written.
    try {
      if (uses('count')) data.count = commandCountersRepo.add(this.o.db, `count:${run.commandId}`, 1, nowIso);
      const counters: Record<string, number> = {};
      for (const op of counterOps(run.template)) {
        const key = `counter:${op.name}`;
        counters[op.name] =
          op.op === 'add' ? commandCountersRepo.add(this.o.db, key, op.amount, nowIso) : op.op === 'set' ? commandCountersRepo.set(this.o.db, key, op.amount, nowIso) : commandCountersRepo.get(this.o.db, key);
      }
      data.counters = counters;
    } catch (err) {
      this.o.logger.warn('command counters unavailable', { err });
    }

    if (uses('commands')) data.commands = this.o.commandList(run.platform);
    if (uses('randomuser')) {
      const others = (this.chatters.get(`${run.platform}:${run.chatKey}`) ?? []).filter((n) => n !== run.user);
      data.randomUser = others.length ? others[Math.floor((this.o.random ?? Math.random)() * others.length)]! : null;
    }
    if (run.discord) {
      if (uses('server') || uses('membercount')) {
        const g = this.o.discordGuild(run.discord.guildId);
        data.server = g?.name ?? null;
        data.memberCount = g?.memberCount ?? null;
      }
      if (['points', 'level', 'xp', 'rank'].some(uses)) data.loyalty = this.o.loyalty(run.discord.guildId, run.userId);
    }

    // Network sources, in parallel; each one fails softly.
    const main = this.o.mainKickChannel();
    const slug = main?.slug ?? null;
    const wantsStream = [...names].some((n) => STREAM_NAMES.has(n));
    const stream = wantsStream && slug ? this.streamInfo(slug, main?.name ?? slug).catch(() => null) : null;
    data.stream = await stream;
    return data;
  }

  private async streamInfo(slug: string, name: string): Promise<StreamVariables | null> {
    const now = this.o.now().getTime();
    if (this.stream && now - this.stream.at < STREAM_CACHE_MS) return this.stream.value;
    const info = await this.o.kickChannelInfo(slug).catch(() => null);
    const value: StreamVariables = {
      streamer: name,
      url: `https://kick.com/${slug}`,
      live: info?.live ?? false,
      title: info?.title ?? null,
      category: info?.category ?? null,
      viewers: info?.viewers ?? null,
      startedAt: info?.startedAt ?? null,
    };
    // Kick unreachable: no stream values (variables use their fallback), rather than claiming you're offline.
    this.stream = { at: now, value: info ? value : null };
    return this.stream.value;
  }
}
