/**
 * The Discord setup wizard's backend: the user's own application (Application ID, Client Secret, Bot Token), their
 * account sign-in (ConnectionService), adding the bot to a server, and the bot's gateway connection.
 *
 * Every status here is verified with Discord, never inferred:
 * - the Application ID + Client Secret by the client credentials grant;
 * - the bot token by GET /users/@me and GET /applications/@me (which must be the same application);
 * - installation by the bot's live server list (gateway) or GET /users/@me/guilds — never by a browser redirect;
 * - the bot by a ready gateway session.
 * A connected account is not evidence that the bot token works, and vice versa.
 *
 * Secrets go from the request straight to the DPAPI vault. They are never returned, logged or written to SQLite, and
 * validation errors name the failing field without echoing values.
 */
import { connectionsRepo, discordRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  saveDiscordApplicationSchema,
  type ApiErrorBody,
  type DiscordInstallStatus,
  type DiscordSetupState,
  type DiscordSetupStep,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import type { CallbackPage } from '../app/callback-server';
import { DISCORD_AUTHORIZE_URL } from './discord';
import { DiscordApiError, type BotApplication, type BotIdentity, type DiscordApi } from './discord-api';
import { BOT_INTENTS, type DiscordBotRunner } from './discord-bot';
import { DISCORD_INSTALL_PERMISSIONS } from '@conduit/shared';
import type { DiscordCredentials } from './discord-credentials';
import type { PendingAuthorization } from '../app/oauth';
import type { DiscordImageCache } from './discord-images';
import type { CredentialVault } from '../app/vault';
import { parseInput } from '../validation';
import type { ConnectionService } from '../app/connection-service';
import { DiscordCommandService } from './discord-command-service';

/**
 * Permissions requested when adding the bot: exactly what giveaway announcements need (View Channel, Send Messages,
 * Embed Links). Never Administrator.
 */
export const INSTALL_PERMISSIONS = DISCORD_INSTALL_PERMISSIONS;
/** Re-check installation over the API at most this often when the bot's live connection can't tell us. */
const INSTALL_RECHECK_MS = 60_000;

type Issue = NonNullable<ApiErrorBody['issues']>[number];

interface InstallCheck {
  at: number;
  ok: boolean;
  problem: string | null;
}

export interface DiscordSetupServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  vault: CredentialVault;
  credentials: DiscordCredentials;
  api: DiscordApi;
  bot: DiscordBotRunner;
  connections: ConnectionService;
  commands: DiscordCommandService;
  images: DiscordImageCache;
}

export class DiscordSetupService {
  private lastCheck: InstallCheck | null = null;
  private checking: Promise<void> | null = null;
  /** Outcome of the last add-the-bot attempt that did not end in a verified installation. */
  private installProblem: string | null = null;
  /** Server icon hashes Discord reported (gateway or API), by server id. Display only; not persisted. */
  private readonly iconHashes = new Map<string, string | null>();
  /** The bot's avatar hash as Discord last reported it (gateway, or API when offline). */
  private botAvatar: { userId: string; hash: string | null } | null = null;
  private avatarLookup: Promise<void> | null = null;

  constructor(private readonly o: DiscordSetupServiceOptions) {
    o.connections.registerCallbackHandler('discord', 'bot-install', (pending, params) => this.handleInstallCallback(pending, params));
  }

  /** Called by the bot runner whenever its live connection reports the servers it is in. */
  recordLiveGuilds(guilds: Array<{ id: string; name: string; icon?: string | null }>): void {
    for (const g of guilds) this.iconHashes.set(g.id, g.icon ?? null);
    discordRepo.replaceGuilds(this.o.db, guilds, this.o.now().toISOString());
    this.lastCheck = { at: this.o.now().getTime(), ok: true, problem: null };
    if (guilds.length > 0) this.installProblem = null;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  async state(): Promise<DiscordSetupState> {
    const app = discordRepo.getApplication(this.o.db);
    const [clientSecretStored, botTokenStored] = await Promise.all([
      this.o.credentials.hasClientSecret(),
      this.o.credentials.hasBotToken(),
    ]);
    const configured = Boolean(app) && clientSecretStored && botTokenStored;

    const card = (await this.o.connections.list()).find((c) => c.platform === 'discord');
    const account: DiscordSetupState['account'] = {
      connected: card?.status === 'connected',
      name: card?.account?.name ?? null,
      handle: card?.account?.handle ?? null,
      avatarDataUrl: card?.account?.avatarDataUrl ?? null,
      pending: card?.pending ?? false,
      problem: card?.status === 'connected' ? null : (card?.problem ?? card?.lastAttempt?.message ?? null),
    };

    const runner = this.o.bot.status();
    const bot: DiscordSetupState['bot'] = configured
      ? { ...runner }
      : {
          status: 'not_configured',
          username: null,
          userId: null,
          problem: null,
          retryable: false,
          since: null,
        };
    if (configured && runner.status === 'not_configured') {
      bot.status = 'disconnected';
      bot.problem = 'The bot is not running. Select Reconnect to start it.';
      bot.retryable = true;
    }
    const botUserId = runner.userId ?? app?.botUserId ?? null;
    bot.avatarDataUrl = configured && botUserId ? this.o.images.get('avatar', botUserId, this.botAvatarHash(botUserId)) : null;

    const installation = await this.installationState(configured);
    const nextStep: DiscordSetupStep = !configured
      ? 'application'
      : !account.connected
        ? 'account'
        : installation.status !== 'installed'
          ? 'install'
          : bot.status !== 'connected'
            ? 'bot'
            : 'done';

    return {
      nextStep,
      application: {
        configured,
        applicationId: app?.applicationId ?? null,
        applicationName: app?.applicationName ?? null,
        clientSecretStored,
        botTokenStored,
        validatedAt: app?.validatedAt ?? null,
        botUserId: app?.botUserId ?? null,
        botUsername: app?.botUsername ?? null,
      },
      account,
      bot,
      installation,
      commands: this.o.commands.state(installation.status === 'installed' ? installation.guilds : [], {
        applicationId: app?.applicationId ?? null,
        botUsername: bot.username ?? app?.botUsername ?? null,
        configured,
      }),
      redirectUri: this.o.connections.redirectUri('discord'),
      installPermissions: INSTALL_PERMISSIONS,
      intents: BOT_INTENTS.map((i) => ({
        name: i.name,
        privileged: i.privileged,
      })),
    };
  }

  private async installationState(configured: boolean): Promise<DiscordSetupState['installation']> {
    const pending = this.o.connections.isPending('discord', 'bot-install');
    if (!configured) {
      return {
        status: 'unknown',
        guilds: [],
        checkedAt: null,
        source: null,
        pending,
        problem: null,
      };
    }
    const live = this.o.bot.liveGuilds();
    if (live) {
      return {
        status: live.length > 0 ? 'installed' : 'not_installed',
        guilds: live.map((g) => ({ id: g.id, name: g.name.slice(0, 100), iconDataUrl: this.o.images.get('icon', g.id, g.icon) })),
        checkedAt: this.o.now().toISOString(),
        source: 'gateway',
        pending,
        problem: live.length > 0 ? null : this.installProblem,
      };
    }
    // The bot is not connected: ask Discord's API instead (throttled).
    if (!this.lastCheck || this.o.now().getTime() - this.lastCheck.at > INSTALL_RECHECK_MS) await this.runInstallCheck();
    const guilds = discordRepo.listGuilds(this.o.db);
    const check = this.lastCheck;
    let status: DiscordInstallStatus;
    if (check && !check.ok) status = 'unable_to_verify';
    else status = guilds.length > 0 ? 'installed' : 'not_installed';
    return {
      status,
      guilds: guilds.map((g) => ({ id: g.guildId, name: g.guildName, iconDataUrl: this.o.images.get('icon', g.guildId, this.iconHashes.get(g.guildId)) })),
      checkedAt: check ? new Date(check.at).toISOString() : null,
      source: check?.ok ? 'api' : null,
      pending,
      problem: check && !check.ok ? check.problem : guilds.length > 0 ? null : this.installProblem,
    };
  }

  /** Checks which servers the bot is in with Discord's API. Never throws; records the outcome. */
  private runInstallCheck(): Promise<void> {
    this.checking ??= (async () => {
      const at = this.o.now().getTime();
      const token = await this.o.credentials.botToken();
      if (!token) {
        this.lastCheck = {
          at,
          ok: false,
          problem: 'No bot token is stored. Open Discord setup and enter it.',
        };
        return;
      }
      try {
        const guilds = await this.o.api.botGuilds(token);
        for (const g of guilds) this.iconHashes.set(g.id, g.icon);
        discordRepo.replaceGuilds(this.o.db, guilds, this.o.now().toISOString());
        this.lastCheck = { at, ok: true, problem: null };
        if (guilds.length > 0) this.installProblem = null;
      } catch (err) {
        const kind = err instanceof DiscordApiError ? err.kind : 'unknown';
        this.o.logger.warn('discord installation check failed', { kind });
        this.lastCheck = {
          at,
          ok: false,
          problem:
            kind === 'invalid_credentials'
              ? "CONDUIT couldn't check the bot's servers because Discord rejected the bot token. Enter a new token under Reconfigure."
              : kind === 'rate_limited'
                ? 'Discord asked CONDUIT to slow down. The installation will be checked again shortly.'
                : "CONDUIT couldn't reach Discord to check the bot's servers. Check your internet connection and select Check again.",
        };
      }
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /**
   * The bot's avatar hash: live from the gateway when connected, otherwise what Discord last reported. If nothing is
   * known yet (bot offline since start-up), asks Discord's API once in the background.
   */
  private botAvatarHash(userId: string): string | null {
    const live = this.o.bot.liveAvatar();
    if (live !== undefined) {
      this.botAvatar = { userId, hash: live };
      return live;
    }
    if (this.botAvatar?.userId === userId) return this.botAvatar.hash;
    this.avatarLookup ??= (async () => {
      const token = await this.o.credentials.botToken();
      if (!token) return;
      try {
        const user = await this.o.api.botUser(token);
        this.botAvatar = { userId: user.id, hash: user.avatar };
      } catch {
        // Display only: the UI shows a fallback icon.
      }
    })();
    return null;
  }

  /** The Check again action. */
  async checkInstallation(): Promise<DiscordSetupState> {
    await this.requireConfigured();
    if (!this.o.bot.liveGuilds()) await this.runInstallCheck();
    return this.state();
  }

  // ── application ───────────────────────────────────────────────────────────

  /** Validates the application details with Discord and, only if every check passes, stores them. */
  async saveApplication(raw: unknown): Promise<DiscordSetupState> {
    const input = parseInput(saveDiscordApplicationSchema, raw);
    const vaultProblem = await this.o.vault.unavailableReason();
    if (vaultProblem) throw new AppError('not_configured', vaultProblem);

    const existing = discordRepo.getApplication(this.o.db);
    const sameApp = existing?.applicationId === input.applicationId;
    const secret = input.clientSecret ?? (sameApp ? (await this.o.credentials.client())?.clientSecret : undefined);
    const token = input.botToken ?? (sameApp ? ((await this.o.credentials.botToken()) ?? undefined) : undefined);
    const missing: Issue[] = [];
    if (!secret)
      missing.push({
        path: 'clientSecret',
        message: 'Enter the Client Secret from the OAuth2 page of your application.',
      });
    if (!token)
      missing.push({
        path: 'botToken',
        message: 'Enter the bot token from the Bot page of your application.',
      });
    if (missing.length > 0)
      throw new AppError('validation_error', 'Some details are missing', {
        issues: missing,
      });

    const { botUser, botApp } = await this.validate(input.applicationId, secret!, token!);
    this.botAvatar = { userId: botUser.id, hash: botUser.avatar };
    this.avatarLookup = null;
    const applicationChanged = Boolean(existing) && !sameApp;

    if (applicationChanged) {
      // A different application: the account authorization, installations, commands and bot session belong to the
      // old one. Its commands are removed with its (still stored) token first.
      await this.o.commands.unregisterAll();
      await this.o.bot.stop();
      if (connectionsRepo.listForPlatform(this.o.db, 'discord').length > 0) {
        await this.o.connections.disconnect('discord').catch((err) =>
          this.o.logger.warn('could not disconnect old discord account', {
            err,
          }),
        );
      }
      discordRepo.replaceGuilds(this.o.db, [], this.o.now().toISOString());
      await this.o.connections.cancelPurpose('discord', 'bot-install');
    }

    try {
      // Secrets first: the application is only recorded as configured once its secrets are safely stored.
      if (input.clientSecret || applicationChanged || !existing) await this.o.credentials.setClientSecret(secret!);
      if (input.botToken || applicationChanged || !existing) await this.o.credentials.setBotToken(token!);
    } catch (err) {
      this.o.logger.error('could not store discord application secrets', {
        err,
      });
      throw new AppError(
        'service_unavailable',
        "CONDUIT couldn't store your Discord credentials securely, so nothing was saved. Try again.",
      );
    }
    const now = this.o.now();
    discordRepo.saveApplication(this.o.db, {
      applicationId: input.applicationId,
      applicationName: botApp.name,
      botUserId: botUser.id,
      botUsername: botUser.username,
      validatedAt: now.toISOString(),
      now: now.toISOString(),
    });
    writeAudit(
      this.o.db,
      {
        action: 'discord.application.saved',
        outcome: 'success',
        actorUserId: null,
        metadata: {
          replaced: Boolean(existing),
          applicationChanged,
          changedFields: [input.clientSecret ? 'client' : null, input.botToken ? 'bot' : null].filter(Boolean),
        },
      },
      now,
    );
    this.o.logger.info('discord application saved', { applicationChanged });

    this.lastCheck = null;
    this.installProblem = null;
    if (input.botToken || applicationChanged) await this.o.bot.stop();
    await this.o.bot.start(token!);
    return this.state();
  }

  /** Checks each credential with Discord and reports exactly which one failed. Stores nothing. */
  private async validate(
    applicationId: string,
    clientSecret: string,
    botToken: string,
  ): Promise<{ botUser: BotIdentity; botApp: BotApplication }> {
    const issues: Issue[] = [];
    let botUser: BotIdentity | null = null;
    let botApp: BotApplication | null = null;
    let clientOk = false;

    try {
      botUser = await this.o.api.botUser(botToken);
      botApp = await this.o.api.botApplication(botToken);
    } catch (err) {
      this.rethrowTransient(err);
      issues.push({
        path: 'botToken',
        message:
          err instanceof DiscordApiError && err.kind === 'invalid_credentials'
            ? 'Discord rejected this bot token. On the Bot page of your application, select Reset Token, then paste the new token here.'
            : "Discord didn't recognise this as a bot token. Copy it from the Bot page of your application (not the Client Secret).",
      });
    }

    try {
      await this.o.api.verifyClientCredentials(applicationId, clientSecret);
      clientOk = true;
    } catch (err) {
      this.rethrowTransient(err);
    }

    if (botApp && botApp.id !== applicationId) {
      issues.push(
        clientOk
          ? {
              path: 'botToken',
              message: `This bot token belongs to a different application ("${botApp.name}", ID ${botApp.id}). Copy the token from the Bot page of the application you entered.`,
            }
          : {
              path: 'applicationId',
              message: `This doesn't match your bot token, which belongs to "${botApp.name}" (ID ${botApp.id}). Copy the Application ID from that application's General Information page.`,
            },
      );
    }
    if (!clientOk && !(botApp && botApp.id !== applicationId)) {
      issues.push({
        path: 'clientSecret',
        message: botApp
          ? 'Discord rejected this Client Secret. On the OAuth2 page of your application, select Reset Secret, then paste the new secret here.'
          : 'Discord rejected this Application ID and Client Secret. Check that both come from the same application (General Information and OAuth2 pages).',
      });
    }

    if (issues.length > 0 || !botUser || !botApp) {
      writeAudit(
        this.o.db,
        {
          action: 'discord.application.saved',
          outcome: 'failure',
          actorUserId: null,
          metadata: { failedFields: issues.map((i) => i.path) },
        },
        this.o.now(),
      );
      this.o.logger.warn('discord application validation failed', {
        failedFields: issues.map((i) => i.path),
      });
      throw new AppError('validation_error', 'Discord did not accept some of these details', { issues });
    }
    return { botUser, botApp };
  }

  /** Network trouble and rate limits say nothing about the credentials: report them instead of blaming a field. */
  private rethrowTransient(err: unknown): void {
    if (!(err instanceof DiscordApiError)) throw err;
    if (err.kind === 'network') {
      throw new AppError(
        'service_unavailable',
        "CONDUIT couldn't reach Discord to check these details. Check your internet connection and try again. Nothing was saved.",
      );
    }
    if (err.kind === 'rate_limited') {
      throw new AppError('rate_limited', 'Discord asked CONDUIT to slow down. Wait a moment and try again. Nothing was saved.', {
        retryAfterSeconds: err.retryAfterSeconds ?? 30,
      });
    }
  }

  // ── installation ──────────────────────────────────────────────────────────

  /** Starts adding the bot to a server: returns Discord's official authorization URL (opened by the desktop). */
  async startInstall(): Promise<{ authorizationUrl: string }> {
    const applicationId = await this.requireConfigured();
    const started = await this.o.connections.beginAuthorization('discord', 'bot-install');
    this.installProblem = null;
    const params = new URLSearchParams({
      client_id: applicationId,
      // applications.commands lets the app register slash commands in the server.
      scope: 'bot applications.commands',
      permissions: INSTALL_PERMISSIONS,
      // Guild install (not a user install).
      integration_type: '0',
      response_type: 'code',
      redirect_uri: started.redirectUri,
      state: started.state,
    });
    this.o.logger.info('discord bot install started');
    return {
      authorizationUrl: `${DISCORD_AUTHORIZE_URL}?${params.toString()}`,
    };
  }

  async cancelInstall(): Promise<DiscordSetupState> {
    if (await this.o.connections.cancelPurpose('discord', 'bot-install')) {
      this.installProblem = 'You cancelled adding the bot. Select Add bot to server to try again.';
    }
    return this.state();
  }

  /** The browser came back from Discord's add-bot page (state already verified and consumed). */
  private async handleInstallCallback(pending: PendingAuthorization, params: URLSearchParams): Promise<CallbackPage> {
    const error = params.get('error');
    if (error) {
      const code = /^[a-z_]{1,40}$/.test(error) ? error : 'unknown_error';
      this.installProblem =
        code === 'access_denied'
          ? 'You cancelled adding the bot. Select Add bot to server to try again.'
          : `Discord reported an error (${code}) while adding the bot. Select Add bot to server to try again.`;
      return code === 'access_denied'
        ? {
            status: 200,
            title: 'Bot not added',
            message: 'The bot was not added to a server. You can close this tab and return to CONDUIT.',
          }
        : {
            status: 400,
            title: 'Bot not added',
            message: `Discord reported an error (${code}). Return to CONDUIT and try again.`,
          };
    }

    const code = params.get('code');
    const creds = await this.o.credentials.client();
    if (code && code.length <= 512 && creds) {
      // Completes the install when the application has "Requires OAuth2 Code Grant" enabled; harmless otherwise. The
      // resulting token has only the bot scope (no access to the user's data) and is discarded, not stored.
      await this.o.api.completeInstallCodeGrant(creds.clientId, creds.clientSecret, code, pending.redirectUri).catch((err) =>
        this.o.logger.info('discord install code exchange skipped', {
          kind: err instanceof DiscordApiError ? err.kind : 'unknown',
        }),
      );
    }

    // The redirect (and its guild_id) is only a hint: confirm with Discord which servers the bot is really in.
    await this.runInstallCheck();
    const hinted = params.get('guild_id');
    const guilds = this.o.bot.liveGuilds() ?? discordRepo.listGuilds(this.o.db).map((g) => ({ id: g.guildId, name: g.guildName }));
    const match = guilds.find((g) => g.id === hinted) ?? (hinted ? undefined : guilds[0]);
    if (match) {
      this.installProblem = null;
      writeAudit(
        this.o.db,
        {
          action: 'discord.bot.installed',
          outcome: 'success',
          actorUserId: null,
          metadata: { verified: true },
        },
        this.o.now(),
      );
      return {
        status: 200,
        title: 'Bot added',
        message: `Discord confirms the bot is in "${match.name}". You can close this tab and return to CONDUIT.`,
      };
    }
    this.installProblem = this.lastCheck?.ok
      ? "Discord doesn't list the bot in that server yet. Select Check again in a moment; if it still isn't there, add the bot again."
      : (this.lastCheck?.problem ?? "CONDUIT couldn't confirm the installation with Discord. Select Check again.");
    return {
      status: 200,
      title: 'Not confirmed yet',
      message: "CONDUIT couldn't confirm the bot is in the server yet. Return to CONDUIT to check again.",
    };
  }

  // ── bot ───────────────────────────────────────────────────────────────────

  /** Starts the bot at backend start-up when the application is configured. */
  async startBot(): Promise<void> {
    const token = await this.o.credentials.botToken();
    if (token && discordRepo.getApplication(this.o.db)) await this.o.bot.start(token);
  }

  /** The Reconnect action for the bot. */
  async restartBot(): Promise<DiscordSetupState> {
    await this.requireConfigured();
    const token = await this.o.credentials.botToken();
    await this.o.bot.stop();
    await this.o.bot.start(token!);
    return this.state();
  }

  /** Shutdown: commands in flight get a "restarting" reply, retries stop, then the gateway session closes. */
  async stopBot(): Promise<void> {
    this.o.commands.close();
    await this.o.bot.stop();
  }

  /** The Register commands / Retry action. Uses the servers Discord confirmed the bot is in. */
  /**
   * After custom Discord commands change: update the servers' slash commands (best effort; the Commands status shows
   * the result). Does nothing until the bot is set up and in a server.
   */
  async refreshCommands(): Promise<void> {
    try {
      const app = discordRepo.getApplication(this.o.db);
      if (!app || !(await this.o.credentials.hasBotToken())) return;
      const guilds = this.o.bot.liveGuilds() ?? DiscordCommandService.installedGuilds(this.o.db, null);
      if (guilds.length > 0) await this.o.commands.registerNow(guilds);
    } catch (err) {
      this.o.logger.warn('could not refresh discord commands', { err });
    }
  }

  async registerCommands(): Promise<DiscordSetupState> {
    await this.requireConfigured();
    let guilds = this.o.bot.liveGuilds();
    if (!guilds) {
      await this.runInstallCheck();
      guilds = DiscordCommandService.installedGuilds(this.o.db, null);
    }
    if (guilds.length === 0) throw new AppError('conflict', 'Add the bot to a server first. Commands are registered in each server the bot is in.');
    await this.o.commands.registerNow(guilds);
    return this.state();
  }

  // ── removal ───────────────────────────────────────────────────────────────

  /** Removes the whole Discord setup: account authorization (revoked), bot session, secrets and application. */
  async reset(): Promise<DiscordSetupState> {
    // Remove the commands from the servers while the token is still available (best effort).
    await this.o.commands.unregisterAll();
    await this.o.bot.stop();
    await this.o.connections.cancelPurpose('discord', 'bot-install');
    await this.o.connections.cancelPurpose('discord', 'account');
    if (connectionsRepo.listForPlatform(this.o.db, 'discord').length > 0) {
      await this.o.connections.disconnect('discord').catch((err) => this.o.logger.warn('could not disconnect discord account', { err }));
    }
    try {
      await this.o.credentials.deleteSecrets();
    } catch (err) {
      this.o.logger.error('could not delete discord secrets', { err });
      throw new AppError('service_unavailable', "CONDUIT couldn't remove the stored Discord credentials. Try again.");
    }
    discordRepo.replaceGuilds(this.o.db, [], this.o.now().toISOString());
    discordRepo.deleteApplication(this.o.db);
    this.lastCheck = null;
    this.installProblem = null;
    writeAudit(
      this.o.db,
      {
        action: 'discord.application.removed',
        outcome: 'success',
        actorUserId: null,
        metadata: {},
      },
      this.o.now(),
    );
    this.o.logger.info('discord setup removed');
    return this.state();
  }

  private async requireConfigured(): Promise<string> {
    const vaultProblem = await this.o.vault.unavailableReason();
    if (vaultProblem) throw new AppError('not_configured', vaultProblem);
    const app = discordRepo.getApplication(this.o.db);
    if (!app || !(await this.o.credentials.hasBotToken()) || !(await this.o.credentials.hasClientSecret())) {
      throw new AppError('not_configured', "Your Discord application isn't set up yet. Enter its details first.");
    }
    return app.applicationId;
  }
}
