/**
 * Runs custom Kick commands from live chat. Definitions and diagnostics come from CustomCommandService.
 *
 * Execution reuses the existing pieces only: incoming messages come from KickChatService.onMessage (the one signed
 * webhook receiver and subscription), and replies go out through KickChatService.sendResult (the one send path, with
 * its validation, account selection, 2-second spacing and confirmed-only results).
 *
 * Matching: the first word of a message from the main channel, compared case-insensitively and as a whole word
 * ("!hello there" matches !hello; "!helloworld" and "say !hello" don't). Every guard must allow it (today: no replies
 * to the chatbot's own messages), then the command's permission and cooldown are checked. The response template is then filled in
 * (command variables: the message, your Kick stream, counters, … — see CommandVariableService) before sending. Replies are queued and sent one at a time, so the webhook
 * handler never waits and bursts don't trip the send spacing. Nothing is retried after Kick saw the request; only
 * CONDUIT's own spacing is waited out (nothing was sent then).
 *
 * A reply can never trigger another command: templates can't start with "!" or "/", and a reply that would (because
 * a variable put it there) isn't sent. The chatbot's own messages are ignored. Diagnostics hold the trigger and outcome
 * only — never chat text — in memory.
 */
import type { ChatCommandRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { PLATFORM_RULES, renderCommand, type CommandRun, type KickDefaultCommandDefinition } from '@conduit/shared';
import type { CommandVariableService } from '../community/command-variable-service';
import { deniedMessage, kickAllows, kickRoles } from '../community/command-access';
import type { CustomCommandService } from '../community/custom-command-service';
import type { KickChatMessage, KickChatService } from './kick-chat-service';
import type { KickDefaultCommandService } from './kick-default-commands';

const QUEUE_LIMIT = 20;
const REMEMBERED_MESSAGES = 1000;
/** Upper bound for waiting out CONDUIT's own send spacing before giving up on a reply. */
const MAX_SPACING_WAIT_MS = 10_000;

/** What a guard sees. Future guards (permissions, cooldowns) decide from this, without changing the pipeline. */
export interface CommandContext {
  command: ChatCommandRecord;
  message: KickChatMessage;
}
export type CommandGuard = (ctx: CommandContext) => { allow: true } | { allow: false; reason: string };

export interface KickCommandServiceOptions {
  logger: Logger;
  chat: KickChatService;
  commands: CustomCommandService;
  /** The data for command variables (stream info, counters, …). */
  variables: CommandVariableService;
  /** Built-in commands (!uptime, !so…); a custom command with the same trigger answers instead. */
  defaults?: KickDefaultCommandService;
  /** Waits (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

interface Job {
  reply: string;
  /** Gives the cooldown back if the reply isn't posted. */
  release: () => void;
  /** Where the outcome is shown (the custom command's runs, or the default commands' recent runs). */
  record: (outcome: CommandRun['outcome'], detail: string | null) => void;
}

export class KickCommandService {
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];
  private working = false;
  private readonly guards: CommandGuard[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: KickCommandServiceOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.guards = [this.notFromChatbot];
    o.chat.onMessage((m) => this.onMessage(m));
  }

  /** Called for every new chat message from the main channel (already signature-checked and de-duplicated upstream). */
  private onMessage(m: KickChatMessage): void {
    try {
      if (this.seen.has(m.messageId)) return;
      this.seen.add(m.messageId);
      if (this.seen.size > REMEMBERED_MESSAGES) this.seen.delete(this.seen.values().next().value!);

      // People chatting, for {randomuser} (names only; not the chatbot).
      if (this.notFromChatbot({ message: m }).allow) this.o.variables.noteChatter('kick', m.broadcasterUserId, m.senderUsername);

      const parsed = parseCommand(m.content);
      if (!parsed) return; // an ordinary message
      const command = this.o.commands.findRunnable('kick', parsed.trigger);
      if (!command) {
        const builtIn = this.o.defaults?.find(parsed.trigger);
        if (builtIn) this.onDefault(builtIn, m, parsed.args);
        return;
      }

      for (const guard of this.guards) {
        const verdict = guard({ command, message: m });
        if (!verdict.allow) {
          this.o.logger.info('kick command not run', { trigger: command.trigger, reason: verdict.reason });
          return;
        }
      }

      // Permission, from the verified event (sender id vs channel owner, Kick's badge types). Blocked silently in chat.
      if (!kickAllows(command.permission, kickRoles({ userId: m.senderUserId, badgeTypes: m.badgeTypes }, m.broadcasterUserId))) {
        return this.o.commands.record(command, 'blocked', deniedMessage('kick', command.permission));
      }

      // Cooldown: checked and reserved in this same synchronous step, so concurrent messages can't both get through.
      const admission = this.o.commands.admit(command, m.senderUserId);
      if (!admission.ok) return this.o.commands.record(command, 'blocked', `On cooldown (${admission.remainingSeconds} s left).`);
      if (this.queue.length >= QUEUE_LIMIT) {
        admission.release();
        return this.o.commands.record(command, 'failed', 'Not sent: too many commands at once.');
      }
      void this.prepare(command, m, parsed.args, admission.release);
    } catch (err) {
      // A command problem must never break the chat feed.
      this.o.logger.error('kick command handling failed', { err });
    }
  }

  /** A default command: the same guards, permission check (silent when refused) and queue as custom commands. */
  private onDefault(d: KickDefaultCommandDefinition, m: KickChatMessage, args: string): void {
    const defaults = this.o.defaults!;
    if (!this.notFromChatbot({ message: m }).allow) return;
    const roles = kickRoles({ userId: m.senderUserId, badgeTypes: m.badgeTypes }, m.broadcasterUserId);
    if (!kickAllows(d.permission, roles)) return defaults.record(d.trigger, 'blocked', deniedMessage('kick', d.permission));
    const privileged = kickAllows('moderator', roles);
    const admission = defaults.admit(d, privileged);
    if (!admission.ok) return defaults.record(d.trigger, 'blocked', `On cooldown (${admission.remainingSeconds} s left).`);
    if (this.queue.length >= QUEUE_LIMIT) {
      admission.release();
      return defaults.record(d.trigger, 'failed', 'Not sent: too many commands at once.');
    }
    void (async () => {
      try {
        const reply = await defaults.run(d, { user: m.senderUsername, userId: m.senderUserId, args, privileged });
        if (!reply) {
          admission.release();
          return;
        }
        this.queue.push({ reply, release: admission.release, record: (o, detail) => defaults.record(d.trigger, o, detail) });
        void this.work();
      } catch (err) {
        admission.release();
        this.o.logger.error('kick default command failed', { trigger: d.trigger, err });
        defaults.record(d.trigger, 'failed', 'Not sent: the reply couldn’t be prepared.');
      }
    })();
  }

  /** Fills in the reply (looking up only what its variables need), then queues it. */
  private async prepare(command: ChatCommandRecord, m: KickChatMessage, args: string, release: () => void): Promise<void> {
    try {
      const data = await this.o.variables.data({
        platform: 'kick',
        commandId: command.id,
        template: command.response,
        user: m.senderUsername,
        userId: m.senderUserId,
        channel: this.o.chat.mainChannelName(),
        chatKey: m.broadcasterUserId,
        args,
        message: m.content,
        kick: { roles: m.badges, subMonths: m.subscriberMonths ?? null },
      });
      const reply = renderCommand(command.response, data, 'kick');
      if (!reply) {
        release();
        return this.o.commands.record(command, 'failed', 'Not sent: the reply was empty after filling in variables.');
      }
      if (/^[!/]/.test(reply)) {
        release();
        return this.o.commands.record(command, 'failed', 'Not sent: after filling in variables the reply would start with "!" or "/".');
      }
      this.queue.push({ reply, release, record: (o, detail) => this.o.commands.record(command, o, detail) });
      void this.work();
    } catch (err) {
      release();
      this.o.logger.error('kick command reply could not be prepared', { err });
      this.o.commands.record(command, 'failed', 'Not sent: the reply couldn’t be prepared.');
    }
  }

  /** No replies to the chatbot's own messages (loop protection). */
  private readonly notFromChatbot = ({ message }: { message: KickChatMessage }): ReturnType<CommandGuard> => {
    const bot = this.o.chat.chatbotIdentity();
    if (!bot.isMainAccount && bot.userId && message.senderUserId === bot.userId)
      return { allow: false, reason: 'message from the chatbot account' };
    // When the chatbot is the main account itself, its own posts are recognized by their exact recent text.
    if (bot.isMainAccount && message.senderUserId === bot.userId && this.o.chat.wasRecentlySent(message.content)) {
      return { allow: false, reason: 'message posted by CONDUIT' };
    }
    return { allow: true };
  };

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        await this.run(job).catch((err) => this.o.logger.error('kick command reply failed', { err }));
      }
    } finally {
      this.working = false;
    }
  }

  private async run(job: Job): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.o.chat.msUntilNextSend();
      if (wait > 0) await this.sleep(Math.min(wait, MAX_SPACING_WAIT_MS));
      const outcome = await this.o.chat.sendResult(job.reply);
      if (outcome.ok) return job.record('sent', `Posted as ${outcome.result.as}.`);
      // CONDUIT's own spacing refused it (nothing reached Kick): wait and try once more.
      if (outcome.locallyThrottled && attempt === 0) continue;
      // Not posted: the cooldown isn't used up. (If the outcome is unknown it may have posted, so it stays.)
      if (outcome.outcome === 'failed') job.release();
      return job.record(outcome.outcome, outcome.message);
    }
  }
}

/**
 * The command in a chat message: its first word (lower-cased) if that is a valid trigger, and the rest as {args}.
 * Never a substring of a longer word, never a trigger in the middle of a message.
 */
export function parseCommand(content: string): { trigger: string; args: string } | null {
  const text = content.trim();
  const token = text.split(/\s+/, 1)[0] ?? '';
  if (!token.startsWith('!')) return null;
  const trigger = token.toLowerCase();
  if (!PLATFORM_RULES.kick.triggerPattern.test(trigger)) return null;
  return { trigger, args: text.slice(token.length).trim() };
}
