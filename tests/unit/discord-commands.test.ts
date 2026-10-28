import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordRepo, migrate, migrations, openDatabase, type Database } from '@conduit/database';
import { createLogger } from '@conduit/logger';
import { DiscordApi } from '../../apps/server/src/discord/discord-api';
import {
  channelCommands,
  COMMANDS,
  commandPayload,
  stickyCommands,
  commandsHash,
  CommandError,
  OptionType,
  validateCommands,
  type SlashCommand,
} from '../../apps/server/src/discord/commands';
import { CommandDispatcher } from '../../apps/server/src/discord/commands/dispatcher';
import { DiscordCredentials } from '../../apps/server/src/discord/discord-credentials';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { DiscordCommandService } from '../../apps/server/src/discord/discord-command-service';
import { BOT_TOKEN, CLIENT_ID, FakeDiscord } from '../helpers/fake-discord';
import { fakeInteraction } from '../helpers/fake-gateway';

const logger = createLogger({ name: 'test', level: 'error', console: false });
const now = () => new Date('2026-01-01T00:00:00Z');
let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

const BAN_MEMBERS = 1n << 2n;

describe('command definitions', () => {
  it('/ping is a valid guild-only chat command available to everyone', () => {
    expect(validateCommands(COMMANDS)).toEqual([]);
    expect(COMMANDS.map((c) => c.name)).toEqual(['ping']);
    expect(commandPayload(COMMANDS[0]!)).toEqual({
      name: 'ping',
      description: 'Check that I’m connected',
      type: 1,
      options: [],
      default_member_permissions: null,
      contexts: [0],
      integration_types: [0],
    });
  });

  it('/ping answers in the first person, the same whatever the bot is called (no app branding)', async () => {
    const ctx = { interactionId: '9001', guildId: '42', userId: '1', userName: 'u', channelName: null, channelId: null, subcommand: null, optionLabels: new Map<string, string>(), memberPermissions: null, options: new Map() };
    for (const botName of ['MyChatBot', 'MyDiscordBot', null, '  ']) {
      const reply = await COMMANDS[0]!.execute({ ...ctx, botName });
      expect(reply).toEqual({ content: 'Pong! I’m connected and ready!' });
      expect(reply.content).not.toMatch(/CONDUIT|the bot/i);
    }
  });

  it('a future command declares options and permissions in the same shape', () => {
    const ban: SlashCommand = {
      name: 'ban',
      origin: 'default',
      description: 'Ban a member',
      options: [{ name: 'user', description: 'Who', type: OptionType.User, required: true }],
      requiredPermissions: BAN_MEMBERS,
      audit: true,
      execute: () => ({ content: 'x' }),
    };
    expect(validateCommands([ban])).toEqual([]);
    expect(commandPayload(ban)).toMatchObject({ default_member_permissions: '4', options: [{ name: 'user', type: 6, required: true }] });
  });

  it('catches definitions Discord would reject', () => {
    const bad: SlashCommand = {
      name: 'Bad Name',
      origin: 'default',
      description: '',
      options: [
        { name: 'a', description: 'a', type: OptionType.String },
        { name: 'b', description: 'b', type: OptionType.String, required: true },
      ],
      execute: () => ({ content: '' }),
    };
    expect(validateCommands([bad, bad]).join('\n')).toMatch(/name must be.*\n.*description.*\n.*required options must come before/s);
  });

  it('the channel and settings commands fit Discord’s limits; subcommands, choices and channel types are sent as Discord expects', () => {
    const none = null as never;
    const all = [...channelCommands({ api: none, credentials: none }), ...stickyCommands({ stickies: none })];
    expect(validateCommands(all)).toEqual([]);
    const sticky = commandPayload(all.find((c) => c.name === 'sticky')!) as { options: Array<{ name: string; type: number; options: Array<Record<string, unknown>> }> };
    expect(sticky.options.map((o) => [o.name, o.type])).toEqual([['set', 1], ['remove', 1], ['list', 1]]);
    expect(sticky.options[0]!.options).toEqual([
      { name: 'channel', description: 'Which channel', type: 7, required: true, channel_types: [0, 5] },
      { name: 'message', description: 'The text (use \\n for a new line)', type: 3, required: true, max_length: 2000 },
    ]);
    const slowmode = commandPayload(all.find((c) => c.name === 'slowmode')!) as { options: Array<{ name: string; choices?: Array<{ name: string; value: number }> }> };
    expect(slowmode.options[0]!.choices!.slice(0, 2)).toEqual([{ name: 'Off', value: 0 }, { name: '5 seconds', value: 5 }]);
    expect(validateCommands([{ name: 'mixed', description: 'x', origin: 'default', options: [{ name: 'a', description: 'a', type: OptionType.String }], subcommands: [{ name: 'b', description: 'b' }], execute: () => ({ content: '' }) }])).toEqual([
      "mixed: subcommands and options can't be mixed",
    ]);
  });

  it('the fingerprint changes only when definitions change', () => {
    expect(commandsHash()).toBe(commandsHash(COMMANDS));
    expect(commandsHash([{ ...COMMANDS[0]!, description: 'changed' }])).not.toBe(commandsHash());
  });
});

describe('CommandDispatcher', () => {
  const make = (commands: SlashCommand[], deferAfterMs = 2000) =>
    new CommandDispatcher({ commands: () => commands, applicationId: () => CLIENT_ID, logger, db, now, deferAfterMs });

  const ban: SlashCommand = {
    name: 'ban',
    origin: 'default',
    description: 'Ban a member',
    options: [{ name: 'user', description: 'Who', type: OptionType.User, required: true }],
    requiredPermissions: BAN_MEMBERS,
    audit: true,
    execute: (ctx) => ({ content: `would ban ${ctx.options.get('user')}` }),
  };

  it('checks permissions on every use, not only Discord-side visibility', async () => {
    const d = make([ban]);
    const denied = fakeInteraction({ commandName: 'ban', memberPermissions: 0n, options: [{ name: 'user', type: 6, value: '123' }] });
    expect(await d.dispatch(denied)).toBe('forbidden');
    expect(denied.replies[0]).toMatchObject({ ephemeral: true, content: expect.stringMatching(/permission/) });

    const allowed = fakeInteraction({
      commandName: 'ban',
      memberPermissions: BAN_MEMBERS | 1n,
      options: [{ name: 'user', type: 6, value: '123' }],
    });
    expect(await d.dispatch(allowed)).toBe('ok');
    expect(allowed.replies[0]!.content).toBe('would ban 123');
  });

  it('validates option types and required options before running the handler', async () => {
    const execute = vi.fn(() => ({ content: 'ran' }));
    const d = make([{ ...ban, execute }]);
    for (const options of [[], [{ name: 'user', type: 3, value: '123' }], [{ name: 'user', type: 6, value: 'abc' }]]) {
      expect(await d.dispatch(fakeInteraction({ commandName: 'ban', memberPermissions: BAN_MEMBERS, options }))).toBe('invalid_options');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('audits commands that ask for it', async () => {
    await make([ban]).dispatch(
      fakeInteraction({ commandName: 'ban', memberPermissions: BAN_MEMBERS, options: [{ name: 'user', type: 6, value: '1' }] }),
    );
    const rows = db.prepare("SELECT action, outcome, metadata FROM audit_logs WHERE action = 'discord.command.used'").all() as Array<{
      outcome: string;
      metadata: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.metadata)).toEqual({ command: 'ban', guildId: '42' });
  });

  it('acknowledges slow commands before Discord’s 3-second limit, then edits the reply', async () => {
    let finish!: () => void;
    const slow: SlashCommand = {
      name: 'slow',
      origin: 'default',
      description: 'Slow',
      execute: () => new Promise((r) => (finish = () => r({ content: 'done' }))),
    };
    const i = fakeInteraction({ commandName: 'slow' });
    const pending = make([slow], 10).dispatch(i);
    await new Promise((r) => setTimeout(r, 30));
    expect(i.deferred).toBe(true);
    finish();
    expect(await pending).toBe('ok');
    expect(i.edits).toEqual([{ content: 'done' }]);
    expect(i.replies).toEqual([]);
  });

  it('shows CommandError messages, but only a generic message for unexpected errors', async () => {
    const d = make([
      {
        name: 'known',
        origin: 'default',
        description: 'k',
        execute: () => {
          throw new CommandError('That user is not in this server.');
        },
      },
      {
        name: 'boom',
        origin: 'default',
        description: 'b',
        execute: () => {
          throw new Error(`internal detail ${BOT_TOKEN}`);
        },
      },
    ]);
    const known = fakeInteraction({ commandName: 'known' });
    expect(await d.dispatch(known)).toBe('failed');
    expect(known.replies[0]).toEqual({ content: 'That user is not in this server.', ephemeral: true });
    const boom = fakeInteraction({ commandName: 'boom' });
    await d.dispatch(boom);
    expect(boom.replies[0]).toEqual({ content: 'Something went wrong running /boom. Try again.', ephemeral: true });
  });

  it('ignores everything until an application is configured', async () => {
    const d = new CommandDispatcher({ commands: () => COMMANDS, applicationId: () => null, logger, db, now });
    const i = fakeInteraction();
    expect(await d.dispatch(i)).toBe('ignored');
    expect(i.replies).toEqual([]);
  });
});

describe('DiscordCommandService automatic retry', () => {
  it('retries a rate-limited registration after retry_after, then reports registered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const discord = new FakeDiscord();
    discord.botGuilds = [{ id: '42', name: 'S' }];
    discord.commandFailures.push({ status: 429, retryAfter: 40 });
    const vault = new MemoryVault();
    const credentials = new DiscordCredentials(db, vault);
    await credentials.setBotToken(BOT_TOKEN);
    discordRepo.saveApplication(db, {
      applicationId: CLIENT_ID,
      applicationName: 'A',
      botUserId: '1',
      botUsername: 'B',
      validatedAt: now().toISOString(),
      now: now().toISOString(),
    });
    const svc = new DiscordCommandService({
      db,
      now,
      logger,
      credentials,
      api: new DiscordApi({ version: '1', fetch: discord.fetch }),
      commands: () => COMMANDS,
    });
    const guilds = [{ id: '42', name: 'S' }];
    const bot = { applicationId: CLIENT_ID, botUsername: 'B', configured: true };

    await svc.onBotReady(guilds);
    expect(svc.state(guilds, bot)).toMatchObject({
      status: 'failed',
      problem: expect.stringMatching(/retry in 40 seconds/),
      nextRetryAt: expect.any(String),
    });
    await vi.advanceTimersByTimeAsync(39_000);
    expect(discord.commandPuts).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(svc.state(guilds, bot).status).toBe('registered'));
    expect(svc.state(guilds, bot)).toMatchObject({ problem: null, nextRetryAt: null });
    svc.close();
  });

  it('stops retrying by itself after a few attempts and asks the user', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const discord = new FakeDiscord();
    discord.botGuilds = [{ id: '42', name: 'S' }];
    for (let n = 0; n < 10; n++) discord.commandFailures.push({ status: 502 });
    const credentials = new DiscordCredentials(db, new MemoryVault());
    await credentials.setBotToken(BOT_TOKEN);
    discordRepo.saveApplication(db, {
      applicationId: CLIENT_ID,
      applicationName: 'A',
      botUserId: '1',
      botUsername: 'B',
      validatedAt: now().toISOString(),
      now: now().toISOString(),
    });
    const svc = new DiscordCommandService({
      db,
      now,
      logger,
      credentials,
      api: new DiscordApi({ version: '1', fetch: discord.fetch }),
      commands: () => COMMANDS,
    });
    const guilds = [{ id: '42', name: 'S' }];
    await svc.onBotReady(guilds);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => expect(discord.commandFailures.length).toBe(6)); // 1 + 3 automatic retries
    expect(svc.state(guilds, { applicationId: CLIENT_ID, botUsername: 'B', configured: true })).toMatchObject({
      status: 'failed',
      nextRetryAt: null,
      problem: expect.stringMatching(/Select Register commands to try again/),
    });
    svc.close();
  });
});
