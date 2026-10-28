/**
 * Who may run a custom command, and cooldowns. Decisions use only platform-provided data:
 * - Kick: the signed chat.message.sent payload — the sender's user id (compared with the channel owner's) and the
 *   badge types Kick documents ("moderator", "subscriber"). Unknown badges grant nothing; missing data = no role.
 * - Discord: the interaction's member permissions, computed by Discord.
 *
 * Cooldowns are kept in memory (single backend process) and reset when CONDUIT restarts. Keys use the platform,
 * the command's id and, for per-user cooldowns, the platform's numeric user id — never a username — so different users,
 * commands and platforms can't collide. Checking and reserving happen in one synchronous step, so concurrent messages
 * can't slip through; a reservation is released if the command doesn't actually run (blocked or failed to send).
 */
import type { ChatCommandRecord } from '@conduit/database';
import { groupAllows, groupForPermission, PERMISSION_HELP, type CommandPermission } from '@conduit/shared';

// ── permissions ───────────────────────────────────────────────────────────────

export type KickRole = 'broadcaster' | 'moderator' | 'subscriber';

const RANK: Record<CommandPermission, number> = { everyone: 0, subscriber: 1, moderator: 2, broadcaster: 3 };

/** The sender's Kick roles from the verified event. */
export function kickRoles(sender: { userId: string; badgeTypes: readonly string[] }, broadcasterUserId: string): Set<KickRole> {
  const roles = new Set<KickRole>();
  if (sender.userId === broadcasterUserId) roles.add('broadcaster');
  if (sender.badgeTypes.includes('moderator')) roles.add('moderator');
  if (sender.badgeTypes.includes('subscriber')) roles.add('subscriber');
  return roles;
}

/** Highest level a Kick sender qualifies for. */
function kickLevel(roles: Set<KickRole>): number {
  if (roles.has('broadcaster')) return RANK.broadcaster;
  if (roles.has('moderator')) return RANK.moderator;
  if (roles.has('subscriber')) return RANK.subscriber;
  return RANK.everyone;
}

export function kickAllows(permission: CommandPermission, roles: Set<KickRole>): boolean {
  return kickLevel(roles) >= RANK[permission];
}

/** A custom command's permission on Discord: the same groups as the default commands. */
export function discordAllows(permission: CommandPermission, memberPermissions: bigint | null): boolean {
  if (permission === 'subscriber') return false; // not available on Discord (rejected when saving)
  return groupAllows(groupForPermission(permission), memberPermissions);
}

export function deniedMessage(platform: 'kick' | 'discord', permission: CommandPermission): string {
  return `Not allowed: ${PERMISSION_HELP[platform][permission].label.toLowerCase()} only.`;
}

// ── cooldowns ─────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 10_000;

export type Admission = { ok: true; release: () => void } | { ok: false; remainingSeconds: number };

export class CooldownTracker {
  /** key → time (ms) until which the command is cooling down. */
  private readonly until = new Map<string, { until: number; token: symbol }>();

  constructor(private readonly now: () => number) {}

  static key(command: Pick<ChatCommandRecord, 'platform' | 'id' | 'cooldownMode'>, userKey: string): string | null {
    if (command.cooldownMode === 'none') return null;
    return command.cooldownMode === 'global'
      ? `${command.platform}:${command.id}:global`
      : `${command.platform}:${command.id}:user:${userKey}`;
  }

  /**
   * Checks and reserves in one step. On success the cooldown starts now; call release() if the command didn't run
   * after all, so a blocked or failed reply doesn't use it up.
   */
  admit(command: Pick<ChatCommandRecord, 'platform' | 'id' | 'cooldownMode' | 'cooldownSeconds'>, userKey: string): Admission {
    const key = CooldownTracker.key(command, userKey);
    if (!key || command.cooldownSeconds <= 0) return { ok: true, release: () => {} };
    const t = this.now();
    const busy = this.until.get(key);
    if (busy !== undefined && busy.until > t) return { ok: false, remainingSeconds: Math.ceil((busy.until - t) / 1000) };
    // A unique token per reservation: two made in the same millisecond must not be mistaken for each other.
    const reserved = { until: t + command.cooldownSeconds * 1000, token: Symbol(key) };
    this.until.set(key, reserved);
    this.bound(t);
    return {
      ok: true,
      release: () => {
        // Only undo our own reservation (not a later one).
        if (this.until.get(key)?.token === reserved.token) this.until.delete(key);
      },
    };
  }

  /** Forgets a command's cooldowns (deleted, or its cooldown settings changed). */
  forget(commandId: string): void {
    for (const key of this.until.keys()) if (key.split(':')[1] === commandId) this.until.delete(key);
  }

  get size(): number {
    return this.until.size;
  }

  /** Keeps the map bounded: drop expired entries, then the oldest if still too many. */
  private bound(t: number): void {
    if (this.until.size <= MAX_ENTRIES) return;
    for (const [k, v] of this.until) if (v.until <= t) this.until.delete(k);
    while (this.until.size > MAX_ENTRIES) this.until.delete(this.until.keys().next().value!);
  }
}
