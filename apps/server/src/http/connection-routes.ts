import { Router } from 'express';
import { GIVEAWAY_ENTER, type CommandPlatform, type CommandsHubState, type DiscordCommandsOverview } from '@conduit/shared';
import { commandInputs } from '../discord/commands';
import { AppError } from '../errors';
import type { Services } from '../services';

/** One of CONDUIT's own ids from the URL. */
function uuidParam(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new AppError('bad_request', 'Invalid id');
  return value;
}

/** A Discord id from the URL (servers and AutoMod rules are snowflakes). */
function snowflakeParam(value: string | undefined): string {
  if (!value || !/^\d{17,20}$/.test(value)) throw new AppError('bad_request', 'Invalid Discord id');
  return value;
}

/** Everything the Commands page shows for one platform, from the authoritative services. */
async function commandsHub(services: Services, platform: CommandPlatform): Promise<CommandsHubState> {
  const custom = services.customCommands.list(platform);
  const recent = services.customCommands.recentRuns(platform);
  if (platform === 'discord') {
    const s = await services.discord.state();
    const registered = s.commands.status === 'registered';
    let note: string | null = null;
    if (!s.application.configured) note = 'Set up Discord first (Dashboard → Discord → Connect).';
    else if (s.bot.status !== 'connected') note = 'The Discord bot is not connected, so commands can’t respond right now.';
    else if (!registered)
      note = s.commands.problem ?? 'Discord doesn’t have the latest commands yet; they appear once registration finishes.';
    return {
      platform,
      defaults: services.discordBuiltInCommands
        .filter((c) => c.origin === 'default')
        .map((c) => ({
          trigger: `/${c.name}`,
          description: c.description,
          permission: c.accessGroup === 'admin' ? 'broadcaster' : c.requiredPermissions !== undefined || c.accessGroup === 'moderator' ? 'moderator' : 'everyone',
          enabled: true,
          canDisable: false,
          inactiveReason: null,
          args: [...commandInputs(c).subcommands, ...commandInputs(c).options],
          example: c.example ?? null,
          message: c.message ?? null,
        })),
      custom,
      ready: { ok: s.bot.status === 'connected' && registered, note, sendAs: s.bot.username ?? s.application.botUsername, channel: null },
      registration: { status: s.commands.status, problem: s.commands.problem },
      recent,
    };
  }
  const chat = services.kickChat.state();
  const receiving = chat.receive.status === 'connected';
  let note: string | null = null;
  if (!receiving) note = 'Commands respond only while Kick chat is connected (Dashboard → Kick → Manage → 4. Live chat).';
  else if (!chat.send.ready) note = chat.send.problem ?? 'The chatbot account can’t send chat messages yet.';
  return {
    platform,
    defaults: [
      {
        trigger: GIVEAWAY_ENTER.kick,
        description: 'Enters the current giveaway (silent: no reply in chat)',
        permission: 'everyone',
        enabled: true,
        canDisable: false,
        inactiveReason: null,
        args: [],
        example: GIVEAWAY_ENTER.kick,
        message: null,
      },
      ...services.kickDefaults.views(),
    ],
    custom,
    ready: { ok: receiving && chat.send.ready, note, sendAs: chat.send.accountName, channel: chat.send.channel },
    registration: null,
    // Custom and default commands, newest first.
    recent: [...recent, ...services.kickDefaults.recent()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
  };
}

function discordCommandsOverview(services: Services): DiscordCommandsOverview {
  return services.commandAccess.overview({
    builtIns: services.discordBuiltInCommands,
    loyalty: services.loyalty.commandCatalog(),
  });
}

/**
 * /api/connections — the dashboard's connection cards. Protected by the local access key (applied in app.ts) and
 * needs no CONDUIT account. The OAuth browser redirect does not come here: it goes to the separate, on-demand
 * loopback callback listener (integrations/callback-server.ts).
 */
export function createConnectionRouter(services: Services): Router {
  const { connections } = services;
  const router = Router();

  router.get('/connections', async (_req, res) => {
    res.json(await connections.list());
  });

  // Returns the platform authorization URL. Only the desktop main process calls this: it validates the URL and opens
  // it in the user's browser (the renderer's IPC allow-list does not include this endpoint).
  // Optional JSON body { role: 'primary' | 'bot' } (default primary): which of the platform's accounts this is about.
  const role = (req: { body?: unknown }) => (req.body && typeof req.body === 'object' ? (req.body as { role?: unknown }).role : undefined);

  router.post('/connections/:platform/connect', async (req, res) => {
    res.json(await connections.startAuthorization(req.params.platform, role(req)));
  });

  router.post('/connections/:platform/cancel', async (req, res) => {
    await connections.cancel(req.params.platform, role(req));
    res.status(204).end();
  });

  router.post('/connections/:platform/disconnect', async (req, res) => {
    res.json(await connections.disconnect(req.params.platform, role(req)));
  });

  // ── Kick setup ────────────────────────────────────────────────────────────

  const { kick } = services;

  router.get('/kick/setup', async (_req, res) => {
    res.json(await kick.state());
  });

  // The Client Secret arrives here once and goes straight to the encrypted vault; responses never include it.
  router.post('/kick/application', async (req, res) => {
    res.json(await kick.saveApplication(req.body));
  });

  router.post('/kick/chatbot', async (req, res) => {
    res.json(await kick.setChatbot(req.body));
  });

  // Posts to live Kick chat: only on an explicit user action (validated on the backend; never automatic).
  router.post('/kick/chat/send', async (req, res) => {
    res.json(await services.kickChat.send(req.body));
  });

  // ── Commands hub (Discord and Kick) ─────────────────────────────────────────

  router.get('/commands/:platform', async (req, res) => {
    res.json(await commandsHub(services, services.customCommands.platform(req.params.platform)));
  });

  router.post('/commands/:platform', async (req, res) => {
    res.status(201).json(services.customCommands.create(services.customCommands.platform(req.params.platform), req.body));
  });

  router.patch('/commands/:platform/:id', async (req, res) => {
    res.json(services.customCommands.update(services.customCommands.platform(req.params.platform), req.params.id, req.body));
  });

  router.delete('/commands/:platform/:id', async (req, res) => {
    services.customCommands.remove(services.customCommands.platform(req.params.platform), req.params.id);
    res.status(204).end();
  });

  // Commands → Kick → Default Commands: which are switched on (body { disabled: ['!so', …] }).
  router.post('/kick/default-commands', async (req, res) => {
    services.kickDefaults.save(req.body);
    res.json(await commandsHub(services, 'kick'));
  });

  // ── Commands → Discord: categories, Command Permissions, bot presence ───────

  router.get('/discord/commands', (_req, res) => {
    res.json(discordCommandsOverview(services));
  });

  router.post('/discord/command-access', (req, res) => {
    services.commandAccess.save(req.body);
    res.json(discordCommandsOverview(services));
  });

  router.get('/discord/presence', (_req, res) => {
    res.json(services.presence.state());
  });

  router.post('/discord/presence', (req, res) => {
    res.json(services.presence.save(req.body));
  });

  // ── Discord Bot → Protection: Discord AutoMod (Discord's API) and CONDUIT's message checks ───────

  router.get('/discord/protection', async (_req, res) => {
    res.json(await services.protection.state());
  });

  router.post('/discord/protection/messages', (req, res) => {
    res.json(services.protection.saveMessageChecks(req.body));
  });

  router.post('/discord/protection/antinuke', (req, res) => {
    res.json(services.protection.antinuke.save(req.body));
  });

  router.post('/discord/protection/botbait', (req, res) => {
    res.json(services.protection.botbait.save(req.body));
  });

  router.post('/discord/protection/botbait/warning', async (req, res) => {
    await services.protection.botbait.postWarning(req.body);
    res.status(204).end();
  });

  router.post('/discord/protection/antiraid', (req, res) => {
    res.json(services.protection.antiraid.save(req.body));
  });

  router.post('/discord/protection/lockdown/:guildId', async (req, res) => {
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    await services.protection.antiraid.raise(snowflakeParam(req.params.guildId), typeof reason === 'string' ? reason : null);
    res.status(204).end();
  });

  router.post('/discord/protection/lockdown/:guildId/lift', async (req, res) => {
    await services.protection.antiraid.lift(snowflakeParam(req.params.guildId), 'manual');
    res.status(204).end();
  });

  router.post('/discord/protection/lockdown/:guildId/preview', async (req, res) => {
    res.json({ lines: await services.protection.antiraid.preview(snowflakeParam(req.params.guildId)) });
  });

  router.post('/discord/protection/quarantine/:id/restore', async (req, res) => {
    await services.protection.antinuke.restore(uuidParam(req.params.id));
    res.status(204).end();
  });

  router.post('/discord/protection/quarantine/:id/release', (req, res) => {
    services.protection.antinuke.release(uuidParam(req.params.id));
    res.status(204).end();
  });

  router.post('/discord/protection/automod/:guildId', async (req, res) => {
    res.json(await services.protection.createRule(snowflakeParam(req.params.guildId), req.body));
  });

  router.patch('/discord/protection/automod/:guildId/:ruleId', async (req, res) => {
    res.json(await services.protection.updateRule(snowflakeParam(req.params.guildId), uuidParam(req.params.ruleId), req.body));
  });

  router.post('/discord/protection/automod/:guildId/:ruleId/enabled', async (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') throw new AppError('validation_error', 'enabled must be true or false');
    res.json(await services.protection.setRuleEnabled(snowflakeParam(req.params.guildId), uuidParam(req.params.ruleId), enabled));
  });

  router.delete('/discord/protection/automod/:guildId/:ruleId', async (req, res) => {
    await services.protection.deleteRule(snowflakeParam(req.params.guildId), uuidParam(req.params.ruleId));
    res.status(204).end();
  });

  router.post('/kick/chat/retry', async (_req, res) => {
    await services.kickChat.ensure();
    res.json(await kick.state());
  });

  // ── Discord setup wizard ──────────────────────────────────────────────────

  const { discord } = services;

  router.get('/discord/setup', async (_req, res) => {
    res.json(await discord.state());
  });

  // Secrets arrive here once and go straight to the encrypted vault; responses never include them.
  router.post('/discord/application', async (req, res) => {
    res.json(await discord.saveApplication(req.body));
  });

  // Returns Discord's add-bot URL. Main process only (validated and opened by the desktop, like /connect).
  router.post('/discord/install', async (_req, res) => {
    res.json(await discord.startInstall());
  });

  router.post('/discord/install/cancel', async (_req, res) => {
    res.json(await discord.cancelInstall());
  });

  router.post('/discord/installation/check', async (_req, res) => {
    res.json(await discord.checkInstallation());
  });

  router.post('/discord/bot/restart', async (_req, res) => {
    res.json(await discord.restartBot());
  });

  // Registration status is computed by the backend from Discord's responses; the renderer can only ask to retry.
  router.post('/discord/commands/register', async (_req, res) => {
    res.json(await discord.registerCommands());
  });

  router.post('/discord/reset', async (_req, res) => {
    res.json(await discord.reset());
  });

  return router;
}
