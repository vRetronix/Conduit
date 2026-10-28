/**
 * Registers CONDUIT's slash commands for the user's own application, in each server the bot is in (guild-scoped:
 * available immediately, unlike global commands), and routes incoming commands to the dispatcher.
 *
 * - Registration uses Discord's bulk overwrite (PUT .../guilds/{guild}/commands), so repeating it can never create
 *   duplicates. A server is marked registered only when Discord's response contains every command.
 * - It is not repeated on every interaction or restart: when a new bot session starts, CONDUIT asks Discord which
 *   commands exist (one GET per server) and registers only if the definitions changed or Discord no longer has them.
 *   New servers are registered when the bot joins them.
 * - Rate limits, network failures and Discord outages are retried automatically (honouring retry_after, at most a few
 *   times); rejected tokens and missing access need the user and are not retried until they act.
 */
import { discordCommandsRepo, discordRepo, type CommandRegistrationRecord, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import type { DiscordCommandsState } from '@conduit/shared';
import { writeAudit } from '../audit';
import { DiscordApiError, type DiscordApi } from './discord-api';
import { commandPayloads, commandsHash, type IncomingCommand, type SlashCommand } from './commands';
import { CommandDispatcher, type DispatchOutcome } from './commands/dispatcher';
import type { DiscordCredentials } from './discord-credentials';

const AUTO_RETRY_DELAYS_S = [30, 120, 600];

type Guild = { id: string; name: string };
/** verify: confirm with Discord, register if needed; missing: only servers never tried; retry: everything not registered; force: all. */
type Mode = 'verify' | 'missing' | 'retry' | 'force';

interface Failure {
  message: string;
  /** Worth retrying automatically (rate limit, network, outage). */
  transient: boolean;
  retryAfterSeconds?: number;
  /** The bot is not in this server anymore: forget it. */
  gone?: boolean;
}

export interface DiscordCommandServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: DiscordCredentials;
  api: DiscordApi;
  /** The slash commands to register and handle: built-in ones plus enabled custom commands (read on each use). */
  commands: () => readonly SlashCommand[];
  /** Reports each run (custom-command diagnostics). */
  onRun?: (name: string, outcome: DispatchOutcome, detail: string | null) => void;
  /** The connected bot's username (for /ping). */
  botName?: () => string | null;
}

export class DiscordCommandService {
  private running: Promise<void> | null = null;
  private problem: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private nextRetryAt: number | null = null;
  private autoRetries = 0;
  private closed = false;
  private readonly dispatcher: CommandDispatcher;

  constructor(private readonly o: DiscordCommandServiceOptions) {
    this.dispatcher = new CommandDispatcher({
      commands: o.commands,
      onRun: o.onRun,
      botName: o.botName,
      applicationId: () => o.credentials.applicationId(),
      logger: o.logger,
      db: o.db,
      now: o.now,
    });
  }

  /** Fingerprint and payloads of the current definitions: they change when custom commands change. */
  private get hash(): string {
    return commandsHash(this.o.commands());
  }

  private get payloads(): Array<Record<string, unknown>> {
    return commandPayloads(this.o.commands());
  }

  /** A slash command arrived on the bot's gateway connection. */
  handleInteraction(interaction: IncomingCommand): Promise<DispatchOutcome> {
    return this.dispatcher.dispatch(interaction);
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  /** A new bot session is ready: confirm the commands exist in each server, registering only where needed. */
  onBotReady(guilds: Guild[]): Promise<void> {
    return this.run(guilds, 'verify');
  }

  /** The bot joined or left servers: register new ones, forget the ones it left. */
  onGuildsChanged(guilds: Guild[]): Promise<void> {
    return this.run(guilds, 'missing');
  }

  /** The Register / Retry action: register in every server the bot is in, now. */
  async registerNow(guilds: Guild[]): Promise<void> {
    this.autoRetries = 0;
    await this.run(guilds, 'force');
  }

  // ── status ────────────────────────────────────────────────────────────────

  state(installed: Guild[], bot: { applicationId: string | null; botUsername: string | null; configured: boolean }): DiscordCommandsState {
    const records = new Map(discordCommandsRepo.list(this.o.db).map((r) => [r.guildId, r]));
    const guilds = installed.map((g) => {
      const r = records.get(g.id);
      const current = r && r.applicationId === bot.applicationId && r.commandsHash === this.hash;
      return {
        id: g.id,
        name: g.name,
        status: (current && r.status === 'registered'
          ? 'registered'
          : r?.status === 'failed' && r.applicationId === bot.applicationId
            ? 'failed'
            : 'pending') as 'registered' | 'failed' | 'pending',
        registeredAt: current ? r.registeredAt : null,
        lastAttemptAt: r?.lastAttemptAt ?? null,
        error: r?.status === 'failed' ? r.lastError : null,
      };
    });
    const registered = guilds.filter((g) => g.status === 'registered').length;
    const failed = guilds.filter((g) => g.status === 'failed').length;
    const status: DiscordCommandsState['status'] = this.running
      ? 'registering'
      : guilds.length > 0 && registered === guilds.length
        ? 'registered'
        : registered > 0 && failed > 0
          ? 'partial'
          : failed > 0
            ? 'failed'
            : 'not_registered';
    const lastAttempt =
      guilds
        .map((g) => g.lastAttemptAt)
        .filter((x): x is string => x !== null)
        .sort()
        .at(-1) ?? null;

    let problem = this.problem;
    if (!bot.configured) problem = null;
    else if (installed.length === 0) problem = 'Add the bot to a server first. Commands are registered in each server the bot is in.';
    else if (!problem && failed > 0) problem = guilds.find((g) => g.error)?.error ?? null;

    return {
      status: bot.configured ? status : 'not_registered',
      scope: 'guild',
      names: this.o.commands().map((c) => c.name),
      definitions: this.o.commands().map((c) => ({
        name: c.name,
        description: c.description,
        requiresPermissions: c.requiredPermissions !== undefined || c.accessGroup === 'admin',
        origin: c.origin,
      })),
      applicationId: bot.applicationId,
      botUsername: bot.botUsername,
      guilds,
      lastAttemptAt: lastAttempt,
      problem,
      canRegister: bot.configured && installed.length > 0 && !this.running,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
    };
  }

  // ── registration ──────────────────────────────────────────────────────────

  /** One registration pass at a time; a request arriving during a pass runs after it. */
  private run(guilds: Guild[], mode: Mode): Promise<void> {
    if (this.closed) return Promise.resolve();
    const previous = this.running ?? Promise.resolve();
    const next = previous
      .then(() => this.pass(guilds, mode))
      .catch((err) => this.o.logger.error('command registration failed', { err }))
      .finally(() => {
        if (this.running === next) this.running = null;
      });
    this.running = next;
    return next;
  }

  private async pass(guilds: Guild[], mode: Mode): Promise<void> {
    if (this.closed) return;
    const applicationId = this.o.credentials.applicationId();
    const token = await this.o.credentials.botToken();
    if (!applicationId || !token) return;
    this.clearRetry();

    // Forget servers the bot has left.
    const ids = new Set(guilds.map((g) => g.id));
    for (const r of discordCommandsRepo.list(this.o.db)) if (!ids.has(r.guildId)) discordCommandsRepo.remove(this.o.db, r.guildId);
    const records = new Map(discordCommandsRepo.list(this.o.db).map((r) => [r.guildId, r]));

    let transient: Failure | null = null;
    let anyFailure: Failure | null = null;
    for (const guild of guilds) {
      if (this.closed) return;
      const r = records.get(guild.id);
      const current = r?.status === 'registered' && r.applicationId === applicationId && r.commandsHash === this.hash;
      if ((mode === 'missing' || mode === 'retry') && current) continue;
      // A server that failed for a reason the user must fix isn't retried on every server-list change.
      if (mode === 'missing' && r?.status === 'failed' && r.applicationId === applicationId && r.commandsHash === this.hash) continue;
      if (transient) break; // after a rate limit or outage, stop and retry later

      const failure = await this.registerGuild(guild, applicationId, token, current && mode === 'verify' ? r : null);
      if (failure) {
        anyFailure = failure;
        if (failure.transient) transient = failure;
      }
    }

    if (transient) this.scheduleRetry(guilds, transient);
    else if (!anyFailure) {
      this.problem = null;
      this.autoRetries = 0;
    }
  }

  /** Registers (or, given a current record, verifies) one server. Returns the failure, if any. */
  private async registerGuild(
    guild: Guild,
    applicationId: string,
    token: string,
    verify: CommandRegistrationRecord | null,
  ): Promise<Failure | null> {
    const at = this.o.now().toISOString();
    const expected = this.o.commands().map((c) => c.name);
    try {
      if (verify) {
        const existing = await this.o.api.guildCommands(token, applicationId, guild.id);
        const byName = new Map(existing.map((c) => [c.name, c]));
        const intact =
          this.o.commands().every((c) => byName.get(c.name)?.description === c.description) && existing.length === expected.length;
        if (intact) return null; // Discord still has exactly these commands: nothing to do.
      }
      const confirmed = await this.o.api.putGuildCommands(token, applicationId, guild.id, this.payloads);
      const names = new Set(confirmed.map((c) => c.name));
      const missing = expected.filter((n) => !names.has(n));
      if (missing.length > 0) {
        return this.recordFailure(guild, applicationId, at, {
          message: `Discord didn't confirm /${missing.join(', /')} in ${guild.name}. Select Register commands to try again.`,
          transient: false,
        });
      }
      discordCommandsRepo.upsert(this.o.db, {
        guildId: guild.id,
        applicationId,
        commandsHash: this.hash,
        status: 'registered',
        registeredAt: at,
        lastAttemptAt: at,
        lastError: null,
      });
      writeAudit(
        this.o.db,
        {
          action: 'discord.commands.registered',
          outcome: 'success',
          actorUserId: null,
          metadata: { guildId: guild.id, commands: expected },
        },
        this.o.now(),
      );
      this.o.logger.info('discord commands registered', { guildId: guild.id, commands: expected.length });
      return null;
    } catch (err) {
      return this.recordFailure(guild, applicationId, at, describe(err, guild));
    }
  }

  private recordFailure(guild: Guild, applicationId: string, at: string, failure: Failure): Failure {
    this.o.logger.warn('discord command registration failed', {
      guildId: guild.id,
      transient: failure.transient,
      gone: failure.gone ?? false,
    });
    if (failure.gone) {
      discordCommandsRepo.remove(this.o.db, guild.id);
      return failure;
    }
    const previous = discordCommandsRepo.list(this.o.db).find((r) => r.guildId === guild.id);
    // A transient failure doesn't undo a registration Discord confirmed earlier for the same definitions.
    if (
      failure.transient &&
      previous?.status === 'registered' &&
      previous.applicationId === applicationId &&
      previous.commandsHash === this.hash
    ) {
      this.problem = failure.message;
      return failure;
    }
    discordCommandsRepo.upsert(this.o.db, {
      guildId: guild.id,
      applicationId,
      commandsHash: this.hash,
      status: 'failed',
      registeredAt: null,
      lastAttemptAt: at,
      lastError: failure.message,
    });
    this.problem = failure.message;
    if (!failure.transient)
      writeAudit(
        this.o.db,
        { action: 'discord.commands.registered', outcome: 'failure', actorUserId: null, metadata: { guildId: guild.id } },
        this.o.now(),
      );
    return failure;
  }

  private scheduleRetry(guilds: Guild[], failure: Failure): void {
    if (this.autoRetries >= AUTO_RETRY_DELAYS_S.length) {
      this.problem = `${failure.message} Select Register commands to try again.`;
      return;
    }
    const delayS = Math.max(failure.retryAfterSeconds ?? 0, AUTO_RETRY_DELAYS_S[this.autoRetries]!);
    this.autoRetries++;
    this.problem = `${failure.message} CONDUIT will retry in ${delayS} seconds.`;
    this.nextRetryAt = this.o.now().getTime() + delayS * 1000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.run(guilds, 'retry');
    }, delayS * 1000);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  // ── removal ───────────────────────────────────────────────────────────────

  /**
   * Removes CONDUIT's commands from Discord (best effort, with the current credentials) and forgets the
   * registrations. Used when the application is removed or replaced, so stale commands don't linger in servers.
   */
  async unregisterAll(): Promise<void> {
    this.clearRetry();
    await this.running?.catch(() => undefined);
    const applicationId = this.o.credentials.applicationId();
    const token = await this.o.credentials.botToken();
    if (applicationId && token) {
      for (const r of discordCommandsRepo.list(this.o.db)) {
        if (r.applicationId !== applicationId) continue;
        await this.o.api
          .putGuildCommands(token, applicationId, r.guildId, [])
          .catch((err) =>
            this.o.logger.warn('could not remove discord commands', {
              guildId: r.guildId,
              kind: err instanceof DiscordApiError ? err.kind : 'unknown',
            }),
          );
      }
    }
    discordCommandsRepo.clear(this.o.db);
    this.problem = null;
    this.autoRetries = 0;
  }

  /** Forgets registrations without contacting Discord. */
  forget(): void {
    this.clearRetry();
    discordCommandsRepo.clear(this.o.db);
    this.problem = null;
  }

  /** Shutting down: stop retries, and answer commands with "restarting" instead of running them. */
  close(): void {
    this.closed = true;
    this.dispatcher.setClosing(true);
    this.clearRetry();
  }

  /** Servers the bot is verifiably in (live list, else the last API check). */
  static installedGuilds(db: Database, live: Guild[] | null): Guild[] {
    return live ?? discordRepo.listGuilds(db).map((g) => ({ id: g.guildId, name: g.guildName }));
  }
}

function describe(err: unknown, guild: Guild): Failure {
  if (!(err instanceof DiscordApiError))
    return { message: `CONDUIT couldn't register commands in ${guild.name}. Select Register commands to try again.`, transient: false };
  switch (err.kind) {
    case 'invalid_credentials':
      return {
        message: 'Discord rejected the bot token, so commands could not be registered. Enter a new token under Reconfigure.',
        transient: false,
      };
    case 'forbidden':
      return {
        message: `Discord didn't allow CONDUIT to add commands in ${guild.name}${err.discordCode === 50001 ? ' (Missing Access)' : ''}. Select Add bot to server and add the bot to that server again (this grants the commands permission), then select Register commands.`,
        transient: false,
      };
    case 'not_found':
      return { message: `The bot is no longer in ${guild.name}.`, transient: false, gone: true };
    case 'rate_limited':
      return {
        message: 'Discord is rate limiting command registration.',
        transient: true,
        retryAfterSeconds: err.retryAfterSeconds,
      };
    case 'network':
      return { message: "CONDUIT couldn't reach Discord to register commands.", transient: true };
    case 'server_error':
      return { message: 'Discord is having problems right now (outage or internal error).', transient: true };
    default:
      return {
        message: `Discord rejected the command registration in ${guild.name}. Select Register commands to try again.`,
        transient: false,
      };
  }
}
