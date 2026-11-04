/**
 * Runs custom Twitch commands from live chat. Definitions and diagnostics come from CustomCommandService, exactly as
 * for Kick (see kick-command-service.ts): incoming messages come from TwitchChatService.onMessage (the one EventSub
 * subscription) and replies go out through TwitchChatService.sendResult (the one send path, with its validation,
 * account selection, 2-second spacing and confirmed-only results).
 *
 * Matching: the first word of a message, compared case-insensitively and as a whole word. No replies to the chatbot's
 * own messages; then the command's permission (Twitch badges, see command-access.ts) and cooldown are checked, the reply
 * is filled in (CommandVariableService, with your Twitch stream) and queued. Replies are sent one at a time, so the
 * chat handler never waits and bursts don't trip the send spacing. Nothing is retried after Twitch saw the request.
 *
 * A reply can never trigger another command: templates can't start with "!" or "/", and a reply that would (because a
 * variable put it there) isn't sent. Diagnostics hold the trigger and outcome only — never chat text — in memory.
 */
import type { ChatCommandRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { renderCommand, type CommandRun } from '@conduit/shared';
import type { CommandVariableService } from '../community/command-variable-service';
import { chatAllows, deniedMessage, twitchRoles } from '../community/command-access';
import type { CustomCommandService } from '../community/custom-command-service';
import { parseCommand } from '../kick/kick-command-service';
import type { TwitchChatMessage, TwitchChatService } from './twitch-chat-service';

const QUEUE_LIMIT = 20;
const REMEMBERED_MESSAGES = 1000;
/** Upper bound for waiting out CONDUIT's own send spacing before giving up on a reply. */
const MAX_SPACING_WAIT_MS = 10_000;

export interface TwitchCommandServiceOptions {
  logger: Logger;
  chat: Pick<TwitchChatService, 'onMessage' | 'sendResult' | 'msUntilNextSend' | 'chatbotIdentity' | 'wasRecentlySent' | 'mainChannelName'>;
  commands: CustomCommandService;
  variables: CommandVariableService;
  sleep?: (ms: number) => Promise<void>;
}

interface Job {
  reply: string;
  release: () => void;
  record: (outcome: CommandRun['outcome'], detail: string | null) => void;
}

export class TwitchCommandService {
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];
  private working = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: TwitchCommandServiceOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    o.chat.onMessage((m) => this.onMessage(m));
  }

  private onMessage(m: TwitchChatMessage): void {
    try {
      if (this.seen.has(m.messageId)) return;
      this.seen.add(m.messageId);
      if (this.seen.size > REMEMBERED_MESSAGES) this.seen.delete(this.seen.values().next().value!);
      if (this.fromChatbot(m)) return;

      // People chatting, for {randomuser} (names only; not the chatbot).
      this.o.variables.noteChatter('twitch', m.broadcasterUserId, m.senderUsername);

      const parsed = parseCommand(m.content);
      if (!parsed) return;
      const command = this.o.commands.findRunnable('twitch', parsed.trigger);
      if (!command) return;

      // Permission, from the event (chatter id vs channel owner, Twitch's badges). Blocked silently in chat.
      if (!chatAllows(command.permission, twitchRoles({ userId: m.senderUserId, badgeTypes: m.badgeTypes }, m.broadcasterUserId))) {
        return this.o.commands.record(command, 'blocked', deniedMessage('twitch', command.permission));
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
      this.o.logger.error('twitch command handling failed', { err });
    }
  }

  /** The chatbot's own messages (loop protection): a separate bot by its id; the main account by its recent text. */
  private fromChatbot(m: TwitchChatMessage): boolean {
    const bot = this.o.chat.chatbotIdentity();
    if (!bot.userId || m.senderUserId !== bot.userId) return false;
    return !bot.isMainAccount || this.o.chat.wasRecentlySent(m.content);
  }

  private async prepare(command: ChatCommandRecord, m: TwitchChatMessage, args: string, release: () => void): Promise<void> {
    try {
      const data = await this.o.variables.data({
        platform: 'twitch',
        commandId: command.id,
        template: command.response,
        user: m.senderUsername,
        userId: m.senderUserId,
        channel: this.o.chat.mainChannelName(),
        chatKey: m.broadcasterUserId,
        args,
        message: m.content,
        chat: { roles: m.badges, subMonths: m.subscriberMonths },
      });
      const reply = renderCommand(command.response, data, 'twitch');
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
      this.o.logger.error('twitch command reply could not be prepared', { err });
      this.o.commands.record(command, 'failed', 'Not sent: the reply couldn’t be prepared.');
    }
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        await this.run(job).catch((err) => this.o.logger.error('twitch command reply failed', { err }));
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
      if (outcome.locallyThrottled && attempt === 0) continue;
      if (outcome.outcome === 'failed') job.release();
      return job.record(outcome.outcome, outcome.message);
    }
  }
}
