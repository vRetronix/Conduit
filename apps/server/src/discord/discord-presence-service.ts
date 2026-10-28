/**
 * The Discord bot's presence (Commands → Discord → Discord Moderation Commands → Status Updates and Rich Presence
 * Updates; both edit this one presence, see packages/shared/src/discord/discord-presence.ts).
 *
 * - Saving validates and stores it, then sends it on the bot's live gateway session if there is one. The state keeps
 *   "saved" apart from "sent": a presence saved while the bot is offline is sent when it next connects.
 * - Nothing saved: CONDUIT sends nothing and Discord shows its default (online, no activity), as before.
 * - It is sent again whenever a session starts or resumes, because a new gateway session starts without it.
 * - Discord limits presence updates; more than PRESENCE_UPDATES_PER_MINUTE saves a minute are refused with a clear
 *   message instead of being dropped by Discord without notice.
 */
import { settingsRepo, SETTING_KEYS, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { gatewayPresence, presenceSchema, type BotPresence, type PresenceLogEntry, type PresenceState } from '@conduit/shared';
import { AppError } from '../errors';
import type { GatewayPresenceData } from './discord-bot';
import { parseInput } from '../validation';

export const PRESENCE_UPDATES_PER_MINUTE = 5;
const HISTORY_KEPT = 20;

export interface PresenceBot {
  connected(): boolean;
  sendPresence(p: GatewayPresenceData): { ok: true } | { ok: false; problem: string };
}

export class DiscordPresenceService {
  private applied: PresenceState['applied'] = { state: 'not_sent', at: null, presence: null, problem: null };
  private readonly saves: number[] = [];
  private readonly history: PresenceLogEntry[] = [];

  constructor(private readonly o: { db: Database; now: () => Date; logger: Logger; bot: PresenceBot }) {}

  /** The saved presence, or null when none is saved (or what is stored no longer fits; it is then ignored). */
  saved(): BotPresence | null {
    const raw = settingsRepo.get(this.o.db, SETTING_KEYS.discordPresence);
    if (!raw) return null;
    try {
      const parsed = presenceSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    this.o.logger.warn('stored discord presence is invalid; ignoring it');
    return null;
  }

  state(): PresenceState {
    return { saved: this.saved(), applied: { ...this.applied }, botConnected: this.o.bot.connected(), history: this.history.map((e) => ({ ...e })) };
  }

  /** Validates, saves and sends the presence (when the bot is connected). */
  save(raw: unknown): PresenceState {
    const next = parseInput(presenceSchema, raw);
    const t = this.o.now().getTime();
    while (this.saves.length > 0 && this.saves[0]! <= t - 60_000) this.saves.shift();
    if (this.saves.length >= PRESENCE_UPDATES_PER_MINUTE)
      throw new AppError('rate_limited', 'Discord allows only a few presence changes a minute. Wait a moment and save again.');
    this.saves.push(t);
    settingsRepo.set(this.o.db, SETTING_KEYS.discordPresence, JSON.stringify(next), this.o.now().toISOString());
    this.send(next, 'saved');
    return this.state();
  }

  /** A gateway session became ready or resumed: send the saved presence (nothing when none is saved). */
  onSession(): void {
    const saved = this.saved();
    if (saved) this.send(saved, 'reconnected');
  }

  private send(p: BotPresence, reason: PresenceLogEntry['reason']): void {
    const at = this.o.now().toISOString();
    if (!this.o.bot.connected()) {
      this.applied = { state: 'not_sent', at: this.applied.at, presence: this.applied.presence, problem: 'Saved. It is sent when the bot connects to Discord.' };
    } else {
      const result = this.o.bot.sendPresence(gatewayPresence(p));
      this.applied = result.ok ? { state: 'sent', at, presence: p, problem: null } : { state: 'failed', at, presence: this.applied.presence, problem: result.problem };
    }
    this.history.unshift({ at, reason, state: this.applied.state, presence: p, problem: this.applied.problem });
    if (this.history.length > HISTORY_KEPT) this.history.pop();
  }
}
