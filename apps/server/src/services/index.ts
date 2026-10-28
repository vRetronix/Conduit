import os from 'node:os';
import path from 'node:path';
import { discordRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import type { PasswordHasher } from '@conduit/security';
import { GIVEAWAY_ENTER, renderCommand, type ServerConfig } from '@conduit/shared';
import { EventBus } from '../events';
import { AlertService } from '../app/alert-service';
import { AppearanceService } from '../app/appearance-service';
import { DiscordCommandAccessService } from '../discord/discord-command-access-service';
import { DiscordPresenceService } from '../discord/discord-presence-service';
import { DiscordProtectionService } from '../discord/protection/discord-protection-service';
import { EmbedCreatorService } from '../discord/embed-creator-service';
import { BackupService } from '../app/backup-service';
import { LogService } from '../app/log-service';
import { DiscordApi } from '../discord/discord-api';
import { DiscordBotRunner, type BotClientFactory } from '../discord/discord-bot';
import { DiscordCredentials } from '../discord/discord-credentials';
import { DiscordImageCache } from '../discord/discord-images';
import type { KickAdapter } from '../kick/kick';
import { KickChatApi } from '../kick/kick-chat-api';
import { KickCredentials } from '../kick/kick-credentials';
import { createAdapters, type Adapters } from '../app/registry';
import type { FetchLike } from '../app/types';
import { UnavailableVault, type CredentialVault } from '../app/vault';
import { AuthService } from '../app/auth-service';
import { ConnectionService } from '../app/connection-service';
import { channelCommands, COMMANDS, moderationCommands, stickyCommands, type SlashCommand } from '../discord/commands';
import { customSlashCommand } from '../discord/commands/custom';
import { KickWebData } from '../kick/kick-web';
import { CommandVariableService } from '../community/command-variable-service';
import { CustomCommandService } from '../community/custom-command-service';
import { DiscordCommandService } from '../discord/discord-command-service';
import { DiscordSetupService } from '../discord/discord-setup-service';
import { DiscordGiveaways } from '../discord/discord-giveaways';
import { GiveawayService } from '../community/giveaway-service';
import { KickChatService } from '../kick/kick-chat-service';
import { KickCommandService } from '../kick/kick-command-service';
import { KickSetupService } from '../kick/kick-setup-service';
import { LoyaltyService } from '../discord/loyalty-service';
import { KickDefaultCommandService } from '../kick/kick-default-commands';
import { ModerationService } from '../community/moderation-service';
import { DiscordLoggingService } from '../discord/discord-logging-service';
import { DiscordPoster } from '../discord/discord-poster';
import { EmbedLibraryService } from '../discord/embed-library-service';
import { StickyService } from '../discord/sticky-service';
import { StreamNotificationService } from '../kick/stream-notification-service';
import { KickClipService } from '../kick/kick-clip-service';
import { KickClipsApi } from '../kick/kick-clips-api';
import { TimedMessageService } from '../community/timed-message-service';
import { ProfileService } from '../app/profile-service';
import { UserAdminService } from '../app/user-admin-service';

export interface Services {
  events: EventBus;
  /** Pop-up alerts for the dashboard (rate limits, accounts going down or coming back). */
  alerts: AlertService;
  connections: ConnectionService;
  discord: DiscordSetupService;
  kick: KickSetupService;
  kickChat: KickChatService;
  kickCommands: KickCommandService;
  kickDefaults: KickDefaultCommandService;
  customCommands: CustomCommandService;
  giveaways: GiveawayService;
  moderation: ModerationService;
  timedMessages: TimedMessageService;
  /** Discord → Loyalty & Rewards. */
  loyalty: LoyaltyService;
  stickies: StickyService;
  notifications: StreamNotificationService;
  /** Kick → Clips. */
  clips: KickClipService;
  logging: DiscordLoggingService;
  embeds: EmbedLibraryService;
  /** Settings → Appearance & Themes. */
  appearance: AppearanceService;
  /** Settings → Backup & Restore, and Logs. */
  backups: BackupService;
  logs: LogService;
  /** CONDUIT's built-in Discord commands (/ping and the moderation commands), as registered. */
  discordBuiltInCommands: readonly SlashCommand[];
  /** Commands → Discord: categories and Command Permissions (Admin, Moderator, Anyone). */
  commandAccess: DiscordCommandAccessService;
  /** The Discord bot's presence (Status Updates and Rich Presence Updates). */
  presence: DiscordPresenceService;
  /** Automated Protection: Discord AutoMod rules (Discord's API) and CONDUIT's own message checks (gateway + REST). */
  protection: DiscordProtectionService;
  /** Discord → Embed Creator: messages sent as the bot and edited later. */
  embedCreator: EmbedCreatorService;
  // Account services: dormant on the desktop since Phase 2.3 (no CONDUIT sign-in); retained for future
  // multi-user/remote access.
  auth: AuthService;
  profiles: ProfileService;
  users: UserAdminService;
}

export function createServices(opts: {
  db: Database;
  config: Pick<ServerConfig, 'sessionTtlHours' | 'sessionIdleHours' | 'oauthCallbackPort'> & Partial<Pick<ServerConfig, 'kickWebhookPort' | 'dataDir'>>;
  hasher: PasswordHasher;
  logger: Logger;
  setupToken: string;
  /** Used in the User-Agent of platform API calls. */
  version?: string;
  /** Platform OAuth adapters. Defaults to the real ones (integrations/registry.ts) using `fetch`. */
  adapters?: Adapters;
  /** HTTP implementation for platform APIs (tests substitute a simulated platform). */
  fetch?: FetchLike;
  /** Requests to Kick's website for its unofficial data, such as !followage and clips (default: the platform fetch above). */
  kickWebFetch?: FetchLike;
  /** Where Kick clips are saved unless the user chooses a folder (default: Videos\CONDUIT Clips). */
  clipsFolder?: string;
  /** Creates the Discord bot's gateway client (tests substitute a fake). Defaults to discord.js. */
  discordBotFactory?: BotClientFactory;
  /** Waits used by background work such as command replies (tests advance a fake clock instead). */
  sleep?: (ms: number) => Promise<void>;
  /** Random numbers 0 ≤ n < 1 (Loyalty XP amounts; tests make them predictable). */
  random?: () => number;
  /** Minimum time between giveaway embed count edits on Discord (tests shorten it). */
  giveawayEditIntervalMs?: number;
  /** Encrypted credential storage. Defaults to "unavailable" (no OS-backed encryption, nothing is stored). */
  vault?: CredentialVault;
  now?: () => Date;
  /** Restarts the backend (a staged restore is applied on the next start). Without it, a restore applies at the next start. */
  requestRestart?: () => void;
}): Services {
  const now = opts.now ?? (() => new Date());
  const events = new EventBus();
  const hour = 60 * 60_000;
  const auth = new AuthService({
    db: opts.db,
    hasher: opts.hasher,
    events,
    logger: opts.logger,
    now,
    sessionTtlMs: opts.config.sessionTtlHours * hour,
    sessionIdleMs: opts.config.sessionIdleHours * hour,
    setupToken: opts.setupToken,
  });
  auth.restoreFailureWindows();
  const version = opts.version ?? '0.0.0';
  const vault = opts.vault ?? new UnavailableVault();
  const discordCredentials = new DiscordCredentials(opts.db, vault);
  const kickCredentials = new KickCredentials(opts.db, vault, now);
  const adapters = { ...createAdapters({ discordCredentials, kickCredentials }, { version, fetch: opts.fetch, now }), ...opts.adapters };
  const connections = new ConnectionService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'connections' }),
    adapters,
    vault,
    callbackPort: opts.config.oauthCallbackPort,
  });
  const alerts = new AlertService({ now, logger: opts.logger.child({ module: 'alerts' }) });
  const discordApi = new DiscordApi({
    version,
    fetch: opts.fetch,
    sleep: opts.sleep,
    onRateLimited: (s) =>
      alerts.push({
        key: 'discord-rate-limit',
        level: 'warn',
        title: 'Discord is rate limiting',
        detail: `Discord asked CONDUIT to wait${s ? ` about ${s} s` : ''}, so a request was refused. Whatever it was for says so on its page or in its log.`,
      }),
  });
  // Built-in commands: /ping and the moderation commands, which run through the moderation service (created below;
  // the commands only call it when used).
  let moderation: ModerationService | null = null;
  const builtIns: readonly SlashCommand[] = [
    ...COMMANDS,
    ...moderationCommands({ runDiscordCommand: (r) => moderation!.runDiscordCommand(r) }),
    ...channelCommands({ api: discordApi, credentials: discordCredentials }),
    ...stickyCommands({ stickies: () => stickies! }),
  ];
  let variables: CommandVariableService = null as never;
  const customCommands = new CustomCommandService({ db: opts.db, now, logger: opts.logger.child({ module: 'commands' }) });
  // Command Permissions: the group of each built-in command, enforced by the dispatcher (applied to the commands below).
  // Admin-only commands are hidden from other members in Discord, so a change re-registers the commands.
  const commandAccess = new DiscordCommandAccessService({ db: opts.db, now, onChanged: () => void discord?.refreshCommands() });
  const commands = new DiscordCommandService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'discord-commands' }),
    credentials: discordCredentials,
    api: discordApi,
    // Built-in commands, the loyalty commands (while switched on), then enabled custom Discord commands (read on every
    // use, so edits apply right away).
    commands: () => [
      ...commandAccess.apply([...builtIns, ...(loyalty?.slashCommands() ?? [])]),
      ...customCommands.runnable('discord').map((r) =>
        customSlashCommand(
          r,
          (c, u) => customCommands.admit(c, u),
          async (c, ctx, text) =>
            renderCommand(
              c.response,
              await variables.data({
                platform: 'discord',
                commandId: c.id,
                template: c.response,
                user: ctx.userName,
                userId: ctx.userId,
                channel: ctx.channelName,
                chatKey: ctx.guildId,
                args: text,
                message: text ? `${c.trigger} ${text}` : c.trigger,
                discord: { guildId: ctx.guildId },
              }),
              'discord',
            ),
        ),
      ),
    ],
    onRun: (name, outcome, detail) => {
      const record = customCommands.findRunnable('discord', `/${name}`);
      if (!record) return; // built-in commands (e.g. /ping) aren't tracked here
      if (outcome === 'ok') customCommands.record(record, 'sent', 'Discord accepted the reply.');
      else if (outcome === 'failed') customCommands.record(record, 'failed', detail);
      else if (outcome === 'blocked') customCommands.record(record, 'blocked', detail);
    },
    // The live Discord bot's username (from its gateway session), else the one verified when it was set up.
    botName: () => bot.status().username ?? discordRepo.getApplication(opts.db)?.botUsername ?? null,
  });
  let discord: DiscordSetupService | null = null;
  // Discord features that listen to the bot's gateway events (created below; used only once events arrive).
  let stickies: StickyService | null = null;
  let timedMessages: TimedMessageService | null = null;
  let logging: DiscordLoggingService | null = null;
  let loyalty: LoyaltyService | null = null;
  let protection: DiscordProtectionService | null = null;
  // One bot connection: setup status, command registration and command handling all use it.
  const bot = new DiscordBotRunner({
    logger: opts.logger.child({ module: 'discord-bot' }),
    now,
    factory: opts.discordBotFactory,
    onGuilds: (guilds) => discord?.recordLiveGuilds(guilds),
    onReady: (guilds) => {
      presence.onSession();
      void commands.onBotReady(guilds);
      void giveaways.onDiscordReady();
      // A new session: make sure every sticky is still the newest message in its channel.
      void stickies?.recover();
    },
    onGuildEvent: (event) => {
      // Moderation done outside CONDUIT (Discord's buttons, other bots, AutoMod), for Discord Bot → Logs.
      if (event.type === 'audit') moderation?.recordDiscordAudit(event);
      // People chatting in a server, for {randomuser} (names only).
      if (event.type === 'message_create' && !event.authorBot && !event.system && event.authorName) variables.noteChatter('discord', event.guildId, event.authorName);
      protection?.onDiscordEvent(event);
      stickies?.onDiscordEvent(event);
      timedMessages?.onDiscordEvent(event);
      loyalty?.onDiscordEvent(event);
      logging?.onDiscordEvent(event);
    },
    privilegedIntents: () => logging?.privilegedIntents() ?? { members: false, messageContent: false, presences: false },
    onGuildsChanged: (guilds) => void commands.onGuildsChanged(guilds),
    onInteraction: (interaction) => void commands.handleInteraction(interaction),
    onButton: (button) =>
      void (async () => {
        // Embed Creator buttons and menus; everything else is a giveaway's.
        if (await loyalty?.onButton(button)) return; // /loyalty reset-leaderboard's Confirm
        if (await embedCreator.onComponent(button)) return;
        await giveaways.onDiscordButton(button);
      })().catch((err) => opts.logger.error('discord button failed', { err })),
    onResumed: () => presence.onSession(),
  });
  const presence = new DiscordPresenceService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'discord-presence' }),
    bot: { connected: () => bot.status().status === 'connected', sendPresence: (p) => bot.sendPresence(p) },
  });
  discord = new DiscordSetupService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'discord-setup' }),
    vault,
    credentials: discordCredentials,
    api: discordApi,
    bot,
    commands,
    images: new DiscordImageCache({ version, fetch: opts.fetch }),
    connections,
  });
  const kickApi = new KickChatApi({
    fetch: opts.fetch,
    onRateLimited: (s) => alerts.push({ key: 'kick-rate-limit', level: 'warn', title: 'Kick is rate limiting', detail: `Requests are paused${s ? ` for about ${s} s` : ' briefly'}; CONDUIT tries again on its own.` }),
  });
  const kickChat = new KickChatService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'kick-chat' }),
    connections,
    credentials: kickCredentials,
    api: kickApi,
    webhookPort: opts.config.kickWebhookPort ?? 47822,
  });
  const kick = new KickSetupService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'kick-setup' }),
    vault,
    credentials: kickCredentials,
    // The registry's Kick adapter (tests may substitute adapters; Kick setup always needs the real contract).
    adapter: adapters.kick as KickAdapter,
    connections,
    chat: kickChat,
  });
  // Discord channels the bot can see, with its permissions in each (cached briefly): shared by every Discord feature.
  const discordGiveaways = new DiscordGiveaways({ db: opts.db, logger: opts.logger.child({ module: 'discord-giveaways' }), api: discordApi, credentials: discordCredentials, now });
  const discordChannels = (force?: boolean) => discordGiveaways.channels(force);
  const poster = new DiscordPoster({ api: discordApi, credentials: discordCredentials, now });
  const discordConnected = () => bot.status().status === 'connected';
  const botUserId = () => bot.status().userId ?? discordRepo.getApplication(opts.db)?.botUserId ?? null;
  const giveaways = new GiveawayService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'giveaways' }),
    kick: kickChat,
    kickRewards: kickChat,
    discordReadiness: async () => {
      const s = await discord!.state();
      if (!s.application.configured) return { ready: false, note: 'Set up Discord first (Dashboard → Discord → Connect).' };
      if (s.bot.status !== 'connected') return { ready: false, note: 'The Discord bot is not connected, so the giveaway buttons don’t respond right now.' };
      return { ready: true, note: null };
    },
    sleep: opts.sleep,
    discordEditIntervalMs: opts.giveawayEditIntervalMs,
    discordApplicationId: () => discordCredentials.applicationId(),
    discord: discordGiveaways,
  });
  moderation = new ModerationService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'moderation' }),
    discordApi,
    discordCredentials,
    discordBotName: () => bot.status().username ?? discordRepo.getApplication(opts.db)?.botUsername ?? null,
    kick: kickChat,
    loyaltyLog: async () => loyalty?.logEntries() ?? [],
  });
  timedMessages = new TimedMessageService({ db: opts.db, now, logger: opts.logger.child({ module: 'timed-messages' }), kick: kickChat, poster, discordChannels, discordConnected, sleep: opts.sleep });
  // Discord only: earning comes from the bot's message events (onGuildEvent above); Kick takes no part.
  // Command variables: counters, your Kick stream (official API), Loyalty, servers.
  let kickAppTokenCache: { token: string; expiresAt: number } | null = null;
  const kickChannelInfo = async (slug: string) => {
    if (!kickAppTokenCache || kickAppTokenCache.expiresAt - 60_000 < now().getTime()) kickAppTokenCache = await (adapters.kick as KickAdapter).appAccessToken();
    const [c] = await kickApi.channelsBySlugs(kickAppTokenCache.token, [slug]);
    return c ? { live: c.live, title: c.title, category: c.category, viewers: c.viewerCount, startedAt: c.startTime } : null;
  };
  const kickWeb = new KickWebData({ now, fetch: opts.kickWebFetch ?? opts.fetch });
  // Kick default commands (!uptime, !so, !timeout…): answered through the same pipeline as custom commands.
  const kickDefaults = new KickDefaultCommandService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'kick-default-commands' }),
    customCommands,
    moderation: () => moderation!,
    mainChannel: () => {
      const me = kickChat.moderator();
      const main = kickChat.mainChannel();
      return me ? { name: main?.name ?? me.name, slug: main?.slug ?? null, scopes: me.scopes } : null;
    },
    streamInfo: async () => {
      const slug = kickChat.mainChannel()?.slug;
      return slug ? kickChannelInfo(slug) : null;
    },
    channelInfo: (slug) => kickChat.channelInfo(slug),
    followingSince: async (username) => {
      const slug = kickChat.mainChannel()?.slug;
      if (!slug) return undefined;
      const v = await kickWeb.viewer(slug, username);
      return v ? v.followingSince : undefined;
    },
    updateStreamInfo: (patch) => kickChat.updateStreamInfo(patch),
    findCategory: (name) => kickChat.findCategory(name),
    everyoneCommands: () => kickEveryoneCommands(),
  });
  /** Triggers everyone may use in Kick chat: !enter, the default commands that answer, and custom commands for everyone. */
  const kickEveryoneCommands = () => [
    GIVEAWAY_ENTER.kick,
    ...kickDefaults
      .views()
      .filter((d) => d.permission === 'everyone' && d.enabled && !d.inactiveReason)
      .map((d) => d.trigger),
    ...customCommands
      .runnable('kick')
      .filter((c) => c.permission === 'everyone')
      .map((c) => c.trigger),
  ];
  variables = new CommandVariableService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'command-variables' }),
    random: opts.random,
    mainKickChannel: () => kickChat.mainChannel(),
    kickChannelInfo,
    loyalty: (guildId, userId) => loyalty?.commandStats(guildId, userId) ?? null,
    discordGuild: (guildId) => {
      const g = bot.liveGuilds()?.find((x) => x.id === guildId);
      return g ? { name: g.name, memberCount: g.memberCount ?? null } : null;
    },
    commandList: (platform) =>
      platform === 'kick'
        ? kickEveryoneCommands()
        : commandAccess.apply([...builtIns, ...(loyalty?.slashCommands() ?? [])]).map((c) => `/${c.name}`).concat(customCommands.runnable('discord').map((c) => c.trigger)),
  });
  loyalty = new LoyaltyService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'loyalty' }),
    customCommands,
    discordConnected,
    contentIntentActive: () => {
      const intents = bot.activePrivilegedIntents();
      return discordConnected() && intents.messageContent && !intents.refused;
    },
    onDiscordCommandsChanged: () => void discord!.refreshCommands(),
    poster,
    api: discordApi,
    credentials: discordCredentials,
    botUserId,
    discordChannels: () => discordChannels(),
    random: opts.random,
    alert: (detail) => alerts.push({ key: `loyalty:${detail}`, level: 'warn', title: 'Loyalty & Rewards', detail }),
  });
  // Accounts going down or coming back: a pop-up alert (their status itself is shown on the Dashboard only).
  alerts.watch('discord-bot', () => {
    const s = bot.status();
    if (s.status === 'not_configured') return null;
    const healthy = s.status === 'connected' ? true : s.status === 'connecting' ? null : false;
    return { healthy, problem: { level: s.status === 'error' ? 'error' : 'warn', title: 'Discord bot disconnected', detail: s.problem }, recovered: 'Discord bot connected again' };
  });
  alerts.watch('kick-chat', () => {
    const r = kickChat.state().receive;
    const healthy = r.status === 'connected' ? true : r.status === 'connecting' || r.status === 'disconnected' ? null : false;
    return { healthy, problem: { level: 'warn', title: 'Kick chat disconnected', detail: r.problem ?? null }, recovered: 'Kick chat connected again' };
  });
  stickies = new StickyService({ db: opts.db, now, logger: opts.logger.child({ module: 'stickies' }), poster, discordChannels, discordConnected, botUserId });
  const notifications = new StreamNotificationService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'notifications' }),
    kickApi,
    kickAppToken: () => (adapters.kick as KickAdapter).appAccessToken(),
    kickConfigured: async () => (await kickCredentials.client()) !== null,
    poster,
    discordChannels,
  });
  const clips = new KickClipService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'kick-clips' }),
    api: new KickClipsApi({ fetch: opts.kickWebFetch ?? opts.fetch }),
    poster,
    discordChannels,
    mainChannel: () => {
      const main = kickChat.mainChannel();
      return main?.slug ? { slug: main.slug.toLowerCase(), name: main.name ?? main.slug } : null;
    },
    isLive: async (slug) => (await kickChannelInfo(slug))?.live ?? null,
    defaultFolder: opts.clipsFolder ?? path.join(os.homedir(), 'Videos', 'CONDUIT Clips'),
    vault,
  });
  const moderationService = moderation;
  logging = new DiscordLoggingService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'discord-logging' }),
    poster,
    discordChannels,
    botUserId,
    deletedByConduit: (messageId) => discordApi.deletedByOwnFeature(messageId),
    applicationFlags: async () => {
      const token = await discordCredentials.botToken();
      return token ? (await discordApi.botApplication(token)).flags : null;
    },
    activeIntents: () => bot.activePrivilegedIntents(),
    restartBot: () => bot.restart(),
    onModerationAction: (listener) => moderationService.onAction(listener),
    onLoyaltyEvent: (listener) => loyalty!.onEvent(listener),
    loyaltyStatus: () => {
      const s = loyalty!.settings();
      return { enabled: s.enabled, xp: s.xp.enabled };
    },
  });
  protection = new DiscordProtectionService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'discord-protection' }),
    credentials: discordCredentials,
    api: discordApi,
    poster,
    discordChannels,
    messageContent: () => {
      const intents = bot.activePrivilegedIntents();
      return discordConnected() && intents.messageContent && !intents.refused;
    },
  });
  const embedCreator = new EmbedCreatorService({
    db: opts.db,
    now,
    logger: opts.logger.child({ module: 'embed-creator' }),
    credentials: discordCredentials,
    api: discordApi,
    discordChannels,
    botUserId,
    verifyRefusal: (guildId, userId, userName, hasAvatar) => protection?.antiraid.verifyRefusal(guildId, userId, userName, hasAvatar) ?? null,
  });
  const embeds = new EmbedLibraryService({ db: opts.db, now, logger: opts.logger.child({ module: 'embeds' }), poster, discordChannels });
  customCommands.onChanged((platform) => {
    if (platform === 'discord') void discord!.refreshCommands();
  });
  return {
    events,
    alerts,
    connections,
    discord,
    kick,
    kickChat,
    kickCommands: new KickCommandService({ logger: opts.logger.child({ module: 'kick-commands' }), chat: kickChat, commands: customCommands, variables, defaults: kickDefaults, sleep: opts.sleep }),
    kickDefaults,
    customCommands,
    giveaways,
    moderation,
    timedMessages,
    loyalty,
    stickies,
    notifications,
    clips,
    logging,
    embeds,
    backups: new BackupService({
      db: opts.db,
      dataDir: opts.config.dataDir ?? '.',
      now,
      logger: opts.logger.child({ module: 'backups' }),
      appVersion: opts.version ?? '0.0.0',
      requestRestart: opts.requestRestart ?? (() => opts.logger.warn('restore staged; it is applied when the server next starts')),
    }),
    appearance: new AppearanceService({ db: opts.db, now }),
    logs: new LogService({ logDir: path.join(opts.config.dataDir ?? '.', 'logs') }),
    discordBuiltInCommands: builtIns,
    commandAccess,
    presence,
    protection,
    embedCreator,
    auth,
    profiles: new ProfileService(opts.db, events, now),
    users: new UserAdminService(opts.db, opts.hasher, events, now, (username) => auth.clearLoginFailures(username)),
  };
}
