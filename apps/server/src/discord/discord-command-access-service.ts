/**
 * Commands → Discord → Default Commands: who may run each built-in command (Access: Admin, Moderator or Anyone; see
 * packages/shared/src/discord/discord-commands.ts) and whether it is enabled.
 *
 * - Built-in commands have a default group (today's behaviour) and a minimum group. Saving can only move a command to
 *   its minimum or higher, so moderation commands can never be opened to everyone.
 * - Moderation commands also keep their Discord permission (Timeout Members / Ban Members) and the moderation service's
 *   role-hierarchy check; the group is an extra condition, never a replacement.
 * - A disabled command is removed from Discord and, if invoked anyway, refused like a command that no longer exists.
 * - Nothing saved = every command enabled at its default group: existing setups behave exactly as before.
 * - Custom commands keep the permission set in their own editor and are not affected here.
 * - The settings are applied to the commands the dispatcher runs (apply()), so they are enforced on every interaction.
 */
import { settingsRepo, SETTING_KEYS, type Database } from '@conduit/database';
import {
  ACCESS_GROUP_HELP,
  ACCESS_GROUP_RANK,
  commandAccessSchema,
  DISCORD_ACCESS_GROUPS,
  LOYALTY_COMMANDS,
  type CommandAccess,
  type DiscordAccessGroup,
  type DiscordCommandsOverview,
  type DiscordCommandView,
} from '@conduit/shared';
import { AppError } from '../errors';
import { commandInputs, type SlashCommand } from './commands';
import { parseInput } from '../validation';

interface BuiltInAccess {
  kind: 'builtin' | 'loyalty';
  defaultGroup: DiscordAccessGroup;
  minimumGroup: DiscordAccessGroup;
  /** A Discord permission the member needs whatever the group. */
  discordPermission: string | null;
}

const moderation = (discordPermission: string): BuiltInAccess => ({ kind: 'builtin', defaultGroup: 'moderator', minimumGroup: 'moderator', discordPermission });
const loyalty: BuiltInAccess = { kind: 'loyalty', defaultGroup: 'community', minimumGroup: 'community', discordPermission: null };
/** Settings commands (/sticky): Admin, and can't be opened to anyone else. */
const adminOnly: BuiltInAccess = { kind: 'builtin', defaultGroup: 'admin', minimumGroup: 'admin', discordPermission: null };

/** Every built-in Discord command CONDUIT has, by name. */
export const BUILT_IN_ACCESS: Readonly<Record<string, BuiltInAccess>> = {
  ping: { kind: 'builtin', defaultGroup: 'community', minimumGroup: 'community', discordPermission: null },
  timeout: moderation('Timeout Members'),
  untimeout: moderation('Timeout Members'),
  kick: moderation('Kick Members'),
  ban: moderation('Ban Members'),
  unban: moderation('Ban Members'),
  slowmode: moderation('Manage Channels'),
  lock: moderation('Manage Channels'),
  unlock: moderation('Manage Channels'),
  sticky: adminOnly,
  ...Object.fromEntries(Object.values(LOYALTY_COMMANDS).map((name) => [name, loyalty])),
  // /loyalty changes members' XP and points: Admin only.
  [LOYALTY_COMMANDS.manage]: { kind: 'loyalty', defaultGroup: 'admin', minimumGroup: 'admin', discordPermission: null },
};

const atLeast = (group: DiscordAccessGroup, minimum: DiscordAccessGroup) => ACCESS_GROUP_RANK[group] >= ACCESS_GROUP_RANK[minimum];

export class DiscordCommandAccessService {
  constructor(private readonly o: { db: Database; now: () => Date; onChanged: () => void }) {}

  /** The saved settings. Anything unreadable, unknown or below a command's minimum is ignored (that command's default). */
  get(): CommandAccess {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordCommandAccess);
    let parsed: { groups?: unknown; disabled?: unknown } | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as { groups?: unknown; disabled?: unknown }) : null;
    } catch {
      parsed = null;
    }
    const groups: Record<string, DiscordAccessGroup> = {};
    if (parsed && typeof parsed.groups === 'object' && parsed.groups !== null) {
      for (const [name, group] of Object.entries(parsed.groups as Record<string, unknown>)) {
        const b = BUILT_IN_ACCESS[name];
        if (b && (DISCORD_ACCESS_GROUPS as readonly unknown[]).includes(group) && atLeast(group as DiscordAccessGroup, b.minimumGroup))
          groups[name] = group as DiscordAccessGroup;
      }
    }
    const disabled = Array.isArray(parsed?.disabled) ? parsed.disabled.filter((n): n is string => typeof n === 'string' && n in BUILT_IN_ACCESS) : [];
    return { groups, disabled: [...new Set(disabled)] };
  }

  /** The group a built-in command runs with now; null for commands that aren't built in (custom commands). */
  groupFor(name: string): DiscordAccessGroup | null {
    const b = BUILT_IN_ACCESS[name];
    if (!b) return null;
    return this.get().groups[name] ?? b.defaultGroup;
  }

  /** Saves the settings (only changes from the defaults are stored). */
  save(raw: unknown): CommandAccess {
    const input = parseInput(commandAccessSchema, raw);
    const issues: Array<{ path: string; message: string }> = [];
    const groups: Record<string, DiscordAccessGroup> = {};
    const builtIn = (name: string, path: string) => {
      const b = BUILT_IN_ACCESS[name];
      if (!b) issues.push({ path, message: `/${name} isn’t a default command (custom commands are set in their own editor)` });
      return b;
    };
    for (const [name, group] of Object.entries(input.groups)) {
      const b = builtIn(name, `groups.${name}`);
      if (!b) continue;
      if (!atLeast(group, b.minimumGroup)) issues.push({ path: `groups.${name}`, message: `/${name} can’t be opened below ${ACCESS_GROUP_HELP[b.minimumGroup].label}` });
      else if (group !== b.defaultGroup) groups[name] = group;
    }
    input.disabled.forEach((name, i) => builtIn(name, `disabled.${i}`));
    if (issues.length > 0) throw new AppError('validation_error', 'Some fields are invalid', { issues });
    const next: CommandAccess = { groups, disabled: [...new Set(input.disabled)].sort() };
    const current = this.get();
    const before = JSON.stringify({ groups: current.groups, disabled: [...current.disabled].sort() });
    settingsRepo.set(this.o.db, SETTING_KEYS.discordCommandAccess, JSON.stringify(next), this.o.now().toISOString());
    // Disabled and Admin-only commands change what is registered with Discord.
    if (before !== JSON.stringify(next)) this.o.onChanged();
    return next;
  }

  /**
   * The commands as the dispatcher runs and Discord registers them: disabled built-in commands left out, the others
   * with their group. Custom commands are unchanged.
   */
  apply(commands: readonly SlashCommand[]): SlashCommand[] {
    const { groups, disabled } = this.get();
    const off = new Set(disabled);
    return commands.flatMap((c) => {
      const b = c.origin === 'default' ? BUILT_IN_ACCESS[c.name] : undefined;
      if (!b) return [c];
      if (off.has(c.name)) return [];
      return [{ ...c, accessGroup: groups[c.name] ?? b.defaultGroup }];
    });
  }

  /** The default commands with their access and status (Commands → Discord → Default Commands). */
  overview(o: {
    builtIns: readonly SlashCommand[];
    loyalty: Array<{ name: string; description: string; subcommands: string[]; options: string[]; example: string; message: string; active: boolean; reason: string | null }>;
  }): DiscordCommandsOverview {
    const { groups, disabled } = this.get();
    const off = new Set(disabled);
    const view = (
      name: string,
      description: string,
      inputs: { subcommands: string[]; options: string[] },
      example: string | null,
      message: string | null,
      featureActive: boolean,
      reason: string | null,
    ): DiscordCommandView => {
      const b = BUILT_IN_ACCESS[name]!;
      const enabled = !off.has(name);
      return {
        name,
        description,
        subcommands: inputs.subcommands,
        options: inputs.options,
        example,
        message,
        kind: b.kind,
        group: groups[name] ?? b.defaultGroup,
        defaultGroup: b.defaultGroup,
        minimumGroup: b.minimumGroup,
        discordPermission: b.discordPermission,
        enabled,
        active: enabled && featureActive,
        inactiveReason: !enabled ? null : reason,
      };
    };
    return {
      commands: [
        ...o.builtIns.filter((c) => BUILT_IN_ACCESS[c.name]).map((c) => view(c.name, c.description, commandInputs(c), c.example ?? null, c.message ?? null, true, null)),
        ...o.loyalty.map((l) => view(l.name, l.description, { subcommands: l.subcommands, options: l.options }, l.example, l.message, l.active, l.reason)),
      ],
    };
  }
}
