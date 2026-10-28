/**
 * The slash commands CONDUIT registers for the user's bot. To add a command: create a file exporting a
 * SlashCommand (see ping.ts) and add it to COMMANDS. Registration, dispatch, validation and permission checks are
 * shared.
 */
import crypto from 'node:crypto';
import { DISCORD_PERMISSION_BITS } from '@conduit/shared';
import { ping } from './ping';
import { SUBCOMMAND_TYPE, type CommandOption, type SlashCommand } from './types';

export const COMMANDS: readonly SlashCommand[] = [ping];

const NAME = /^[a-z0-9_-]{1,32}$/;

/** Discord's application command JSON for a command (type 1 = chat input; guild-only contexts). */
export function commandPayload(c: SlashCommand): Record<string, unknown> {
  return {
    name: c.name,
    description: c.description,
    type: 1,
    options: c.subcommands
      ? c.subcommands.map((s) => ({ name: s.name, description: s.description, type: SUBCOMMAND_TYPE, options: (s.options ?? []).map(optionPayload) }))
      : (c.options ?? []).map(optionPayload),
    default_member_permissions: memberPermissionsFor(c),
    // Server channels only (no direct messages): CONDUIT commands act on a server.
    contexts: [0],
    integration_types: [0],
  };
}

/** One option as Discord expects it (extra keys only when used, so existing definitions keep their fingerprint). */
function optionPayload(o: CommandOption): Record<string, unknown> {
  return {
    name: o.name,
    description: o.description,
    type: o.type,
    required: o.required ?? false,
    ...(o.choices ? { choices: o.choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
    ...(o.minValue !== undefined ? { min_value: o.minValue } : {}),
    ...(o.maxValue !== undefined ? { max_value: o.maxValue } : {}),
    ...(o.maxLength !== undefined ? { max_length: o.maxLength } : {}),
    ...(o.channelTypes ? { channel_types: [...o.channelTypes] } : {}),
  };
}

/**
 * Who Discord shows the command to (default_member_permissions: a member needs all of these bits; Administrators see
 * everything). Admin-only commands are shown to Administrators only. Discord can't express "any of the moderator
 * permissions", so a Moderator-group command without its own permission stays visible and the dispatcher refuses
 * members outside the group.
 */
function memberPermissionsFor(c: SlashCommand): string | null {
  if (c.accessGroup === 'admin') return DISCORD_PERMISSION_BITS.ADMINISTRATOR.toString();
  return c.requiredPermissions === undefined ? null : c.requiredPermissions.toString();
}

export function commandPayloads(commands: readonly SlashCommand[] = COMMANDS): Array<Record<string, unknown>> {
  return commands.map(commandPayload);
}

/** Fingerprint of the definitions: registration is repeated only when this changes (or Discord lost them). */
export function commandsHash(commands: readonly SlashCommand[] = COMMANDS): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(commandPayloads(commands)))
    .digest('hex')
    .slice(0, 32);
}

/** Checks definitions against Discord's limits, so a bad definition fails in tests rather than at registration. */
export function validateCommands(commands: readonly SlashCommand[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const c of commands) {
    if (!NAME.test(c.name)) problems.push(`${c.name}: name must be 1–32 lowercase letters, digits, - or _`);
    if (names.has(c.name)) problems.push(`${c.name}: duplicate name`);
    names.add(c.name);
    if (c.description.length < 1 || c.description.length > 100) problems.push(`${c.name}: description must be 1–100 characters`);
    if (c.subcommands && c.options?.length) problems.push(`${c.name}: subcommands and options can't be mixed`);
    if (c.subcommands) {
      if (c.subcommands.length < 1 || c.subcommands.length > 25) problems.push(`${c.name}: 1–25 subcommands`);
      const subNames = new Set<string>();
      for (const s of c.subcommands) {
        if (!NAME.test(s.name)) problems.push(`${c.name} ${s.name}: invalid subcommand name`);
        if (subNames.has(s.name)) problems.push(`${c.name} ${s.name}: duplicate subcommand`);
        subNames.add(s.name);
        if (s.description.length < 1 || s.description.length > 100) problems.push(`${c.name} ${s.name}: description must be 1–100 characters`);
        problems.push(...validateOptions(`${c.name} ${s.name}`, s.options ?? []));
      }
    } else problems.push(...validateOptions(c.name, c.options ?? []));
  }
  return problems;
}

function validateOptions(where: string, options: readonly CommandOption[]): string[] {
  const problems: string[] = [];
  if (options.length > 25) problems.push(`${where}: at most 25 options`);
  let optionalSeen = false;
  for (const o of options) {
    if (!NAME.test(o.name)) problems.push(`${where}.${o.name}: invalid option name`);
    if (o.description.length < 1 || o.description.length > 100) problems.push(`${where}.${o.name}: description must be 1–100 characters`);
    if (o.required && optionalSeen) problems.push(`${where}.${o.name}: required options must come before optional ones`);
    if (!o.required) optionalSeen = true;
    if (o.choices && (o.choices.length < 1 || o.choices.length > 25)) problems.push(`${where}.${o.name}: 1–25 choices`);
    for (const ch of o.choices ?? []) if (ch.name.length < 1 || ch.name.length > 100) problems.push(`${where}.${o.name}: choice names must be 1–100 characters`);
  }
  return problems;
}

export { ChannelType, CommandError, commandInputs, OptionType, type IncomingCommand, type SlashCommand } from './types';
export { moderationCommands, type ModerationCommandRunner } from './moderation';
export { channelCommands, discordProblem, type ChannelCommandDeps } from './channels';
export { stickyCommands, type StickyCommandDeps } from './sticky';
