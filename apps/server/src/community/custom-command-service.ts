/**
 * Custom commands for Discord and Kick: storage, validation and last-run diagnostics. Execution is platform-specific
 * and lives elsewhere (Kick: KickCommandService on the chat feed; Discord: slash commands through
 * DiscordCommandService). Both render responses with renderTemplate() from @conduit/shared.
 *
 * Diagnostics are in memory only and hold the trigger and outcome — never chat text.
 */
import crypto from 'node:crypto';
import { chatCommandsRepo, commandCountersRepo, type ChatCommandRecord, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  commandPlatformSchema,
  cooldownProblem,
  createCommandSchema,
  describeAccess,
  PERMISSION_HELP,
  responseSchema,
  triggerSchema,
  unknownVariables,
  updateCommandSchema,
  type CommandPlatform,
  type CommandRun,
  type CommandsHubState,
  type CustomCommandView,
} from '@conduit/shared';
import { AppError, notFound } from '../errors';
import { parseInput } from '../validation';
import { CooldownTracker, type Admission } from './command-access';

const RECENT_LIMIT = 20;

export class CustomCommandService {
  private readonly runs = new Map<string, { lastRun: CommandRun; runs: number }>();
  private readonly recent: Record<CommandPlatform, CommandsHubState['recent']> = { discord: [], kick: [] };
  private readonly listeners: Array<(platform: CommandPlatform) => void> = [];
  /** In-memory cooldowns (reset on restart). */
  private readonly cooldowns: CooldownTracker;

  constructor(private readonly o: { db: Database; now: () => Date; logger: Logger }) {
    this.cooldowns = new CooldownTracker(() => o.now().getTime());
  }

  /**
   * Cooldown check-and-reserve for one use of a command by a user (platform user id). Call only after the permission
   * check passed; call release() if the command then didn't run, so it doesn't use up the cooldown.
   */
  admit(command: ChatCommandRecord, userKey: string): Admission {
    return this.cooldowns.admit(command, userKey);
  }

  /** Called after a platform's commands change (e.g. Discord re-registers its slash commands). */
  onChanged(listener: (platform: CommandPlatform) => void): void {
    this.listeners.push(listener);
  }

  platform(raw: unknown): CommandPlatform {
    return parseInput(commandPlatformSchema, raw);
  }

  list(platform: CommandPlatform): CustomCommandView[] {
    return chatCommandsRepo.list(this.o.db, platform).map((c) => this.view(c));
  }

  /** Commands that may run: enabled and passing the current rules. */
  runnable(platform: CommandPlatform): ChatCommandRecord[] {
    return chatCommandsRepo.list(this.o.db, platform).filter((c) => c.enabled && storedProblem(c) === null);
  }

  findRunnable(platform: CommandPlatform, trigger: string): ChatCommandRecord | null {
    const c = chatCommandsRepo.findByTrigger(this.o.db, platform, trigger);
    return c && c.enabled && storedProblem(c) === null ? c : null;
  }

  recentRuns(platform: CommandPlatform): CommandsHubState['recent'] {
    return [...this.recent[platform]];
  }

  create(platform: CommandPlatform, raw: unknown): CustomCommandView {
    const input = parseInput(createCommandSchema(platform), raw);
    this.assertTriggerFree(platform, input.trigger, null);
    const at = this.o.now().toISOString();
    const record: ChatCommandRecord = {
      id: crypto.randomUUID(),
      platform,
      trigger: input.trigger,
      description: input.description ?? null,
      response: input.response,
      enabled: input.enabled,
      permission: input.permission,
      cooldownMode: input.cooldownMode,
      cooldownSeconds: input.cooldownMode === 'none' ? 0 : input.cooldownSeconds,
      createdAt: at,
      updatedAt: at,
    };
    chatCommandsRepo.insert(this.o.db, record);
    this.o.logger.info('custom command created', { platform, trigger: record.trigger });
    this.changed(platform);
    return this.view(record);
  }

  update(platform: CommandPlatform, id: string, raw: unknown): CustomCommandView {
    const existing = this.require(platform, id);
    const input = parseInput(updateCommandSchema(platform), raw);
    const cooldownMode = input.cooldownMode ?? existing.cooldownMode;
    const next = {
      trigger: input.trigger ?? existing.trigger,
      description: input.description ?? existing.description,
      response: input.response ?? existing.response,
      enabled: input.enabled ?? existing.enabled,
      permission: input.permission ?? existing.permission,
      cooldownMode,
      cooldownSeconds: cooldownMode === 'none' ? 0 : (input.cooldownSeconds ?? existing.cooldownSeconds),
      updatedAt: this.o.now().toISOString(),
    };
    // The cooldown settings are checked together (e.g. choosing "per user" needs a duration).
    const problem = cooldownProblem(next.cooldownMode, next.cooldownSeconds);
    if (problem)
      throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'cooldownSeconds', message: problem }] });
    if (next.trigger !== existing.trigger) this.assertTriggerFree(platform, next.trigger, id);
    chatCommandsRepo.update(this.o.db, id, next);
    if (next.cooldownMode !== existing.cooldownMode || next.cooldownSeconds !== existing.cooldownSeconds) this.cooldowns.forget(id);
    this.o.logger.info('custom command updated', { platform, trigger: next.trigger, enabled: next.enabled });
    this.changed(platform);
    return this.view(this.require(platform, id));
  }

  remove(platform: CommandPlatform, id: string): void {
    const existing = this.require(platform, id);
    chatCommandsRepo.remove(this.o.db, id);
    commandCountersRepo.delete(this.o.db, `count:${id}`); // its {count}; named counters are shared and stay
    this.runs.delete(id);
    this.cooldowns.forget(id);
    this.o.logger.info('custom command deleted', { platform, trigger: existing.trigger });
    this.changed(platform);
  }

  /** Records what happened when a command ran (in memory, this session). */
  record(command: ChatCommandRecord, outcome: CommandRun['outcome'], detail: string | null): void {
    const at = this.o.now().toISOString();
    const prev = this.runs.get(command.id);
    this.runs.set(command.id, { lastRun: { at, outcome, detail }, runs: (prev?.runs ?? 0) + 1 });
    const list = this.recent[command.platform];
    list.unshift({ at, trigger: command.trigger, outcome, detail });
    if (list.length > RECENT_LIMIT) list.pop();
    this.o.logger.info('custom command ran', { platform: command.platform, trigger: command.trigger, outcome });
  }

  private changed(platform: CommandPlatform): void {
    for (const l of this.listeners) {
      try {
        l(platform);
      } catch (err) {
        this.o.logger.error('command change listener failed', { err });
      }
    }
  }

  private require(platform: CommandPlatform, id: string): ChatCommandRecord {
    const record = /^[0-9a-f-]{36}$/i.test(id) ? chatCommandsRepo.get(this.o.db, id) : undefined;
    if (!record || record.platform !== platform) throw notFound('Command');
    return record;
  }

  private assertTriggerFree(platform: CommandPlatform, trigger: string, exceptId: string | null): void {
    const clash = chatCommandsRepo.findByTrigger(this.o.db, platform, trigger);
    if (clash && clash.id !== exceptId) {
      throw new AppError('conflict', `${trigger} already exists`, {
        issues: [{ path: 'trigger', message: `${trigger} already exists. Edit that command instead.` }],
      });
    }
  }

  private view(c: ChatCommandRecord): CustomCommandView {
    const problem = storedProblem(c);
    const run = this.runs.get(c.id);
    return {
      ...c,
      access: describeAccess(c.platform, c.permission, c.cooldownMode, c.cooldownSeconds),
      valid: problem === null,
      problem,
      unknownVariables: unknownVariables(c.response, c.platform),
      lastRun: run?.lastRun ?? null,
      runs: run?.runs ?? 0,
    };
  }
}

/** Why a stored command can't run under the current rules, or null. Unknown placeholders don't stop it. */
function storedProblem(c: ChatCommandRecord): string | null {
  const t = triggerSchema(c.platform).safeParse(c.trigger);
  if (!t.success) return t.error.issues[0]?.message ?? 'Invalid trigger';
  const r = responseSchema(c.platform, true).safeParse(c.response);
  if (!r.success) return r.error.issues[0]?.message ?? 'Invalid response';
  if (c.platform === 'discord' && !c.description) return 'Discord needs a short description';
  if (!PERMISSION_HELP[c.platform][c.permission]?.available) return PERMISSION_HELP[c.platform][c.permission]?.who ?? 'Invalid permission';
  return cooldownProblem(c.cooldownMode, c.cooldownSeconds);
}
