/**
 * Kick default commands (see packages/shared/src/kick/kick-commands.ts): what each one answers, which are switched on,
 * and their cooldowns. The Kick command service runs them through the same pipeline as custom commands (the chatbot
 * sends the reply, with its spacing and loop protection); this service only decides the reply.
 *
 * - A custom command with the same trigger takes the default's place while it exists and is on.
 * - Everyone's commands have a short shared cooldown so chat can't be flooded; moderator commands have none.
 * - Replies never start with "!" or "/", so they can't trigger another command.
 * - Moderator actions go through CONDUIT's existing services: moderation (recorded in the moderation history), custom
 *   commands (the same checks as the Commands page) and Kick's API with the main account's token.
 */
import { settingsRepo, SETTING_KEYS, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  formatDuration,
  KICK_DEFAULT_COMMANDS,
  kickDefaultCommandSettingsSchema,
  type CommandRun,
  type CommandsHubState,
  type DefaultCommandView,
  type KickDefaultCommandDefinition,
  type KickDefaultCommandSettings,
} from '@conduit/shared';
import { AppError } from '../errors';
import { parseInput } from '../validation';
import type { CustomCommandService } from '../community/custom-command-service';
import type { ModerationService } from '../community/moderation-service';
import type { KickChannelInfo } from './kick-chat-api';

/** Shared cooldown of everyone's default commands (seconds). */
const EVERYONE_COOLDOWN_S = 10;
/** Kick chat messages are at most 500 characters. */
const MAX_REPLY = 480;
const DEFAULT_TIMEOUT_MINUTES = 10;
const RECENT_KEPT = 20;

export interface KickDefaultContext {
  /** The sender's Kick username and id. */
  user: string;
  userId: string;
  /** Everything after the trigger. */
  args: string;
  /** A moderator or the broadcaster (skips the shared cooldown of everyone's commands). */
  privileged: boolean;
}

export interface KickDefaultCommandDeps {
  db: Database;
  now: () => Date;
  logger: Logger;
  customCommands: CustomCommandService;
  moderation: () => Pick<ModerationService, 'runKickCommand'>;
  /** Your channel: its name and slug, and the scopes the main account granted. */
  mainChannel: () => { name: string; slug: string | null; scopes: string[] } | null;
  /** Your stream's live status, title and category (Kick's public API, cached briefly). */
  streamInfo: () => Promise<{ live: boolean; title: string | null; category: string | null; startedAt: string | null } | null>;
  /** Another channel, for !so. */
  channelInfo: (slug: string) => Promise<KickChannelInfo | null>;
  /** When a user started following your channel (Kick's unofficial website data). */
  followingSince: (username: string) => Promise<string | null | undefined>;
  updateStreamInfo: (patch: { streamTitle?: string; categoryId?: number }) => Promise<void>;
  findCategory: (name: string) => Promise<{ id: number; name: string } | null>;
  /** Triggers everyone may use in Kick chat now (default and custom), for !commands. */
  everyoneCommands: () => string[];
}

type Outcome = CommandRun['outcome'];

export class KickDefaultCommandService {
  private readonly cooling = new Map<string, number>();
  private readonly recentRuns: CommandsHubState['recent'] = [];

  constructor(private readonly o: KickDefaultCommandDeps) {}

  settings(): KickDefaultCommandSettings {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.kickDefaultCommands);
    try {
      const parsed = kickDefaultCommandSettingsSchema.safeParse(raw ? JSON.parse(raw) : {});
      if (parsed.success) return { disabled: parsed.data.disabled.filter((t) => KICK_DEFAULT_COMMANDS.some((d) => d.trigger === t)) };
    } catch {
      // unreadable: all on
    }
    return { disabled: [] };
  }

  save(raw: unknown): DefaultCommandView[] {
    const input = parseInput(kickDefaultCommandSettingsSchema, raw);
    const unknown = input.disabled.filter((t) => !KICK_DEFAULT_COMMANDS.some((d) => d.trigger === t));
    if (unknown.length) throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'disabled', message: `${unknown[0]} isn’t a Kick default command` }] });
    settingsRepo.set(this.o.db, SETTING_KEYS.kickDefaultCommands, JSON.stringify({ disabled: [...new Set(input.disabled)].sort() }), this.o.now().toISOString());
    this.o.logger.info('kick default commands saved', { disabled: input.disabled.length });
    return this.views();
  }

  /** The defaults as Commands → Kick shows them. */
  views(): DefaultCommandView[] {
    const off = new Set(this.settings().disabled);
    return KICK_DEFAULT_COMMANDS.map((d) => ({
      trigger: d.trigger,
      description: d.description,
      permission: d.permission,
      enabled: !off.has(d.trigger),
      canDisable: true,
      inactiveReason: !off.has(d.trigger) && this.o.customCommands.findRunnable('kick', d.trigger) ? `Your custom ${d.trigger} answers instead` : null,
      args: [...d.args],
      example: d.example,
      message: d.message,
    }));
  }

  /** The default command for a trigger, when it's on and no custom command takes its place. */
  find(trigger: string): KickDefaultCommandDefinition | null {
    const d = KICK_DEFAULT_COMMANDS.find((c) => c.trigger === trigger);
    if (!d || this.settings().disabled.includes(d.trigger)) return null;
    return this.o.customCommands.findRunnable('kick', trigger) ? null : d;
  }

  /** Checks and reserves the shared cooldown of everyone's commands (moderators and the broadcaster skip it). */
  admit(d: KickDefaultCommandDefinition, privileged = false): { ok: true; release: () => void } | { ok: false; remainingSeconds: number } {
    if (d.permission !== 'everyone' || privileged) return { ok: true, release: () => {} };
    const now = this.o.now().getTime();
    const until = this.cooling.get(d.trigger) ?? 0;
    if (until > now) return { ok: false, remainingSeconds: Math.ceil((until - now) / 1000) };
    const mine = now + EVERYONE_COOLDOWN_S * 1000;
    this.cooling.set(d.trigger, mine);
    return { ok: true, release: () => this.cooling.get(d.trigger) === mine && this.cooling.delete(d.trigger) };
  }

  record(trigger: string, outcome: Outcome, detail: string | null): void {
    this.recentRuns.unshift({ at: this.o.now().toISOString(), trigger, outcome, detail });
    this.recentRuns.splice(RECENT_KEPT);
  }

  recent(): CommandsHubState['recent'] {
    return [...this.recentRuns];
  }

  /** The reply to post (null: nothing to say). Never starts with "!" or "/". */
  async run(d: KickDefaultCommandDefinition, ctx: KickDefaultContext): Promise<string | null> {
    const reply = await this.answer(d.trigger, ctx);
    if (!reply) return null;
    const safe = reply.replace(/^[!/]+/, '').trim();
    return safe.length > MAX_REPLY ? `${safe.slice(0, MAX_REPLY - 1)}…` : safe;
  }

  private async answer(trigger: string, ctx: KickDefaultContext): Promise<string | null> {
    const words = ctx.args.split(/\s+/).filter(Boolean);
    const main = this.o.mainChannel();
    const streamer = main?.name ?? 'The streamer';
    switch (trigger) {
      case '!ping':
        return 'Pong! I’m connected and ready!';
      case '!commands': {
        const list = this.o.everyoneCommands();
        return list.length ? `Commands: ${list.join(', ')}` : 'There are no commands yet.';
      }
      case '!uptime': {
        const s = await this.o.streamInfo().catch(() => null);
        if (!s) return 'I couldn’t check the stream right now.';
        const since = s.startedAt ? Date.parse(s.startedAt) : NaN;
        if (!s.live) return `${streamer} is offline right now.`;
        return Number.isFinite(since) ? `${streamer} has been live for ${formatDuration(this.o.now().getTime() - since)}.` : `${streamer} is live right now.`;
      }
      case '!title': {
        // Moderators and the broadcaster only: with text it changes the title, without it shows the title.
        if (ctx.args.trim()) return this.setStreamInfo('!title', ctx.args.trim());
        const s = await this.o.streamInfo().catch(() => null);
        if (!s) return 'I couldn’t check the stream right now.';
        return s.title ? `Title: ${s.title}` : 'There’s no stream title set.';
      }
      case '!followage': {
        const who = words[0]?.replace(/^@+/, '') || ctx.user;
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(who)) return 'That isn’t a Kick username.';
        if (main?.slug && who.toLowerCase() === main.slug.toLowerCase()) return `${streamer} is the streamer!`;
        const since = await this.o.followingSince(who).catch(() => undefined);
        if (since === undefined) return 'I couldn’t check that right now.';
        if (since === null || !Number.isFinite(Date.parse(since))) return `${who} isn’t following ${streamer}.`;
        return `${who} has followed ${streamer} for ${formatDuration(this.o.now().getTime() - Date.parse(since))}.`;
      }
      case '!so': {
        const who = words[0]?.replace(/^@+/, '');
        if (!who) return 'Who should I shout out? Use: !so @name';
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(who)) return 'That isn’t a Kick username.';
        const c = await this.o.channelInfo(who.toLowerCase()).catch(() => undefined);
        if (c === undefined) return 'I couldn’t look that channel up right now.';
        if (!c) return `I couldn’t find a Kick channel called ${who}.`;
        const what = c.category ? (c.live ? ` They’re live now with ${c.category}!` : ` They were last streaming ${c.category}.`) : '';
        return `Go check out ${c.slug} at kick.com/${c.slug}!${what}`;
      }
      case '!timeout':
      case '!ban':
      case '!unban':
        return this.moderate(trigger, ctx, words);
      case '!addcom':
      case '!editcom':
      case '!delcom':
        return this.manageCommand(trigger, words, ctx.args);
      case '!setcategory':
        return this.setStreamInfo(trigger, ctx.args.trim());
      default:
        return null;
    }
  }

  private async moderate(trigger: string, ctx: KickDefaultContext, words: string[]): Promise<string> {
    const name = words[0]?.replace(/^@+/, '');
    if (!name) return `Who? Use: ${trigger} @name`;
    let minutes = DEFAULT_TIMEOUT_MINUTES;
    let rest = words.slice(1);
    if (trigger === '!timeout' && rest[0] && /^\d+$/.test(rest[0])) {
      minutes = Number(rest[0]);
      rest = rest.slice(1);
      if (minutes < 1 || minutes > 10_080) return 'Timeouts are 1 to 10080 minutes (7 days).';
    }
    const reason = rest.join(' ').slice(0, 100) || null;
    const action = trigger === '!timeout' ? 'timeout' : trigger === '!ban' ? 'ban' : 'unban';
    const r = await this.o.moderation().runKickCommand({
      actorName: ctx.user,
      command: trigger,
      action,
      username: name,
      ...(action === 'timeout' ? { durationSeconds: minutes * 60 } : {}),
      reason: action === 'unban' ? null : reason,
    });
    return r.message;
  }

  private manageCommand(trigger: string, words: string[], args: string): string {
    const target = words[0]?.toLowerCase();
    const usage = trigger === '!delcom' ? '!delcom !name' : `${trigger} !name reply`;
    if (!target) return `Use: ${usage}`;
    const name = target.startsWith('!') ? target : `!${target}`;
    const reply = args.trim().slice(words[0]!.length).trim();
    const reason = (err: unknown) => (err instanceof AppError ? (err.options.issues?.[0]?.message ?? err.message) : 'Something went wrong.');
    const existing = this.o.customCommands.list('kick').find((c) => c.trigger === name);
    try {
      if (trigger === '!addcom') {
        if (!reply) return `Use: ${usage}`;
        this.o.customCommands.create('kick', { trigger: name, response: reply });
        return `Added ${name}.`;
      }
      if (!existing) return `There’s no custom ${name}.`;
      if (trigger === '!editcom') {
        if (!reply) return `Use: ${usage}`;
        this.o.customCommands.update('kick', existing.id, { response: reply });
        return `Updated ${name}.`;
      }
      this.o.customCommands.remove('kick', existing.id);
      return `Deleted ${name}.`;
    } catch (err) {
      return `Couldn’t ${trigger === '!addcom' ? 'add' : trigger === '!editcom' ? 'update' : 'delete'} ${name}: ${reason(err)}`;
    }
  }

  private async setStreamInfo(trigger: string, value: string): Promise<string> {
    if (!value) return 'Use: !setcategory name';
    const main = this.o.mainChannel();
    if (!main) return 'The channel’s Kick account isn’t connected to CONDUIT.';
    if (!main.scopes.includes('channel:write')) return 'I can’t change the stream yet: reauthorize the main Kick account in CONDUIT (Dashboard → Kick → Manage).';
    try {
      if (trigger === '!title') {
        const title = value.slice(0, 140);
        await this.o.updateStreamInfo({ streamTitle: title });
        return `Title changed to: ${title}`;
      }
      const category = await this.o.findCategory(value.slice(0, 100));
      if (!category) return `I couldn’t find a category called ${value}.`;
      await this.o.updateStreamInfo({ categoryId: category.id });
      return `Category changed to ${category.name}.`;
    } catch (err) {
      this.o.logger.warn('kick stream info change failed', { err });
      return 'Kick didn’t accept that change.';
    }
  }
}
