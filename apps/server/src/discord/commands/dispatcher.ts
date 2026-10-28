/**
 * Runs slash commands received by the bot. Shared by every command:
 * - each interaction is handled at most once (Discord ids are remembered briefly), so a duplicated event can never
 *   produce two responses;
 * - only interactions for the configured application, from a server, for a known command are executed;
 * - permissions are re-checked here (Discord's default_member_permissions can be changed by server admins), and so is
 *   the command's group from Command Permissions (Admin, Moderator, Anyone);
 * - options are checked against the command's declaration before its handler runs;
 * - slow handlers are acknowledged (deferred) before Discord's 3-second limit;
 * - failures get a short message for the user; details go to the log, never secrets or message content.
 */
import type { Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { ACCESS_GROUP_HELP, groupAllows } from '@conduit/shared';
import { writeAudit } from '../../audit';
import { CommandError, OptionType, SUBCOMMAND_TYPE, type CommandOption, type CommandReply, type IncomingCommand, type IncomingOption, type OptionValue, type SlashCommand } from './types';

/** Acknowledge before this so Discord's 3-second response window is never missed. */
const DEFER_AFTER_MS = 2000;
const REMEMBERED_INTERACTIONS = 500;

export type DispatchOutcome =
  | 'ok'
  | 'duplicate'
  | 'ignored'
  | 'shutting_down'
  | 'not_in_server'
  | 'unknown_command'
  | 'forbidden'
  | 'invalid_options'
  | 'blocked'
  | 'failed';

export interface CommandDispatcherOptions {
  /** Current commands (built-in and custom), looked up on every interaction. */
  commands: () => readonly SlashCommand[];
  /** Called after each handled command with its outcome (diagnostics). */
  onRun?: (name: string, outcome: DispatchOutcome, detail: string | null) => void;
  /** The connected bot's username (for replies such as /ping). */
  botName?: () => string | null;
  /** The configured application's id; interactions for any other application are ignored. */
  applicationId: () => string | null;
  logger: Logger;
  db: Database;
  now: () => Date;
  deferAfterMs?: number;
}

export class CommandDispatcher {
  private readonly seen = new Set<string>();
  private closing = false;

  constructor(private readonly o: CommandDispatcherOptions) {}

  /** While shutting down, commands get a "try again" reply instead of running. */
  setClosing(closing: boolean): void {
    this.closing = closing;
  }

  async dispatch(i: IncomingCommand): Promise<DispatchOutcome> {
    if (!/^\d{1,25}$/.test(i.id)) return 'ignored';
    if (this.seen.has(i.id)) return 'duplicate';
    this.remember(i.id);

    const expected = this.o.applicationId();
    if (!expected || i.applicationId !== expected) {
      this.o.logger.warn('ignored interaction for another application');
      return 'ignored';
    }
    const name = typeof i.commandName === 'string' ? i.commandName : '';
    if (this.closing) return this.refuse(i, name, 'shutting_down', 'I’m restarting. Try again in a moment.');
    if (!i.guildId) return this.refuse(i, name, 'not_in_server', 'Commands work in servers only.');

    const command = this.o.commands().find((c) => c.name === name);
    if (!command) return this.refuse(i, name, 'unknown_command', 'This command is not available anymore.');

    if (command.requiredPermissions !== undefined) {
      const has = i.memberPermissions ?? 0n;
      if ((has & command.requiredPermissions) !== command.requiredPermissions) {
        return this.refuse(i, name, 'forbidden', "You don't have permission to use this command.");
      }
    }

    // Command Permissions (Admin / Moderator / Anyone), from Discord's computed member permissions.
    if (command.accessGroup && !groupAllows(command.accessGroup, i.memberPermissions)) {
      return this.refuse(i, name, 'forbidden', `Not allowed: ${ACCESS_GROUP_HELP[command.accessGroup].label.toLowerCase()} only.`);
    }

    const parsed = parseCommandOptions(command, i.options);
    if (!parsed) return this.refuse(i, name, 'invalid_options', "That command's options weren't valid. Try again.");

    const ctx = {
      interactionId: i.id,
      guildId: i.guildId,
      userId: i.userId,
      userName: i.userName,
      channelName: i.channelName,
      channelId: typeof i.channelId === 'string' && /^\d{1,25}$/.test(i.channelId) ? i.channelId : null,
      subcommand: parsed.subcommand,
      memberPermissions: i.memberPermissions,
      options: parsed.values,
      optionLabels: parsed.labels,
      botName: this.o.botName?.() ?? null,
    };
    // Access (custom commands): permission and cooldown. Blocked uses get a private note, nothing in the channel.
    let release: () => void = () => {};
    if (command.admit) {
      const admission = command.admit(ctx);
      if (!admission.ok) {
        await i
          .reply({ content: admission.message, ephemeral: true })
          .catch((err) => this.o.logger.warn('could not respond to interaction', { err }));
        this.o.logger.info('discord command blocked', { command: name });
        this.o.onRun?.(name, 'blocked', admission.message);
        return 'blocked';
      }
      release = admission.release;
    }

    let deferred = false;
    const deferTimer = setTimeout(() => {
      deferred = true;
      void i.defer(command.ephemeral ?? false).catch((err) => this.o.logger.warn('could not acknowledge interaction', { command: name, err }));
    }, this.o.deferAfterMs ?? DEFER_AFTER_MS);

    let reply: CommandReply;
    let outcome: DispatchOutcome = 'ok';
    let failure: string | null = null;
    try {
      reply = await command.execute(ctx);
    } catch (err) {
      outcome = 'failed';
      failure = err instanceof CommandError ? err.message : 'The command failed.';
      release();
      if (err instanceof CommandError) reply = { content: err.message, ephemeral: true };
      else {
        this.o.logger.error('command failed', { command: name, err });
        reply = { content: `Something went wrong running /${name}. Try again.`, ephemeral: true };
      }
    } finally {
      clearTimeout(deferTimer);
    }

    try {
      if (deferred) await i.editReply(reply);
      else await i.reply(reply);
    } catch (err) {
      this.o.logger.warn('could not respond to interaction', { command: name, err });
      outcome = 'failed';
      failure = 'Discord didn’t accept the reply (the interaction may have expired).';
      release();
    }
    this.o.logger.info('discord command handled', { command: name, outcome });
    this.o.onRun?.(name, outcome, failure);
    if (command.audit) {
      writeAudit(
        this.o.db,
        {
          action: 'discord.command.used',
          outcome: outcome === 'ok' ? 'success' : 'failure',
          actorUserId: null,
          metadata: { command: name, guildId: i.guildId },
        },
        this.o.now(),
      );
    }
    return outcome;
  }

  private async refuse(i: IncomingCommand, name: string, outcome: DispatchOutcome, message: string): Promise<DispatchOutcome> {
    this.o.logger.info('discord command refused', { command: /^[a-z0-9_-]{1,32}$/.test(name) ? name : 'invalid', outcome });
    await i.reply({ content: message, ephemeral: true }).catch((err) => this.o.logger.warn('could not respond to interaction', { err }));
    return outcome;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > REMEMBERED_INTERACTIONS) this.seen.delete(this.seen.values().next().value!);
  }
}

interface ParsedOptions {
  subcommand: string | null;
  values: Map<string, OptionValue>;
  labels: Map<string, string>;
}

/** The subcommand (if the command has them) and its option values; null if anything is missing, unknown or mistyped. */
function parseCommandOptions(command: SlashCommand, raw: IncomingCommand['options']): ParsedOptions | null {
  if (!Array.isArray(raw)) return null;
  if (!command.subcommands) {
    const parsed = parseOptions(command.options ?? [], raw);
    return parsed && { subcommand: null, ...parsed };
  }
  // Exactly one subcommand, holding that subcommand's options.
  if (raw.length !== 1 || raw[0]?.type !== SUBCOMMAND_TYPE) return null;
  const sub = command.subcommands.find((s) => s.name === raw[0]!.name);
  if (!sub) return null;
  const parsed = parseOptions(sub.options ?? [], Array.isArray(raw[0].options) ? raw[0].options : []);
  return parsed && { subcommand: sub.name, ...parsed };
}

function parseOptions(declaredList: readonly CommandOption[], raw: ReadonlyArray<IncomingOption>): { values: Map<string, OptionValue>; labels: Map<string, string> } | null {
  if (!Array.isArray(raw) || raw.length > 25) return null;
  const declared = new Map(declaredList.map((o) => [o.name, o]));
  const values = new Map<string, OptionValue>();
  const labels = new Map<string, string>();
  for (const opt of raw) {
    const decl = declared.get(opt?.name);
    if (!decl || opt.type !== decl.type || values.has(decl.name)) return null;
    const v = opt.value;
    const ok =
      (decl.type === OptionType.String && typeof v === 'string' && v.length <= Math.min(6000, decl.maxLength ?? 6000)) ||
      (decl.type === OptionType.Integer &&
        typeof v === 'number' &&
        Number.isSafeInteger(v) &&
        (decl.minValue === undefined || v >= decl.minValue) &&
        (decl.maxValue === undefined || v <= decl.maxValue)) ||
      (decl.type === OptionType.Boolean && typeof v === 'boolean') ||
      ((decl.type === OptionType.User || decl.type === OptionType.Channel) && typeof v === 'string' && /^\d{1,25}$/.test(v));
    if (!ok) return null;
    if (decl.choices && !decl.choices.some((c) => c.value === v)) return null;
    values.set(decl.name, v as OptionValue);
    if (typeof opt.label === 'string' && opt.label.trim()) labels.set(decl.name, opt.label.trim().slice(0, 100));
  }
  for (const decl of declaredList) if (decl.required && !values.has(decl.name)) return null;
  return { values, labels };
}
