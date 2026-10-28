/**
 * Discord → Embed Creator: whole messages (text, up to 10 embeds, and buttons / select menus) sent as CONDUIT's bot,
 * and kept so they can be edited later. Messages already in Discord can be loaded from their link: the bot's own are
 * kept and edited directly; anyone else's (only its author can edit it) can be recreated — posted again as the bot, and
 * the original deleted if you choose (that needs Manage Messages).
 *
 * Buttons and select menus: their custom_id is "c:<message id in CONDUIT>:<component id>"; what they do is read from the
 * saved message when someone uses them (never from Discord), so a click can only run actions you set up. Actions: add,
 * remove or toggle a role, Verify (the join gate's checks and lockdown pause, then a role), and a private reply.
 */
import crypto from 'node:crypto';
import { discordPostedMessagesRepo, type Database, type DiscordPostedMessageRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  componentsToJson,
  loadMessageSchema,
  MESSAGE_NAME_MAX,
  messageDraftSchema,
  messageFromJson,
  missingDiscordPermissions,
  parseDiscordMessageLink,
  recreateMessageSchema,
  sendMessageSchema,
  toDiscordEmbed,
  updateMessageSchema,
  type ComponentAction,
  type DiscordChannelsState,
  type LoadMessageResult,
  type MessageDraft,
  type PostedMessageView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import { DiscordApiError, type ChannelMessage, type DiscordApi, type MessageBody } from './discord-api';
import type { IncomingButton } from './discord-bot';
import type { DiscordCredentials } from './discord-credentials';
import { parseInput } from '../validation';

/** custom_id of an Embed Creator button or menu. */
const CUSTOM_ID = /^c:([0-9a-f-]{36}):([a-z0-9]{1,12})$/;
const REMEMBERED_CLICKS = 1000;

export interface EmbedCreatorOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  credentials: Pick<DiscordCredentials, 'botToken'>;
  api: Pick<DiscordApi, 'createMessage' | 'editMessage' | 'deleteMessage' | 'channelMessage' | 'addMemberRole' | 'removeMemberRole' | 'guildMemberRoles'>;
  discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
  botUserId: () => string | null;
  /** The join gate and lockdown, for the Verify action: why this member can't verify now, or null. */
  verifyRefusal: (guildId: string, userId: string, userName: string, hasAvatar: boolean | null) => string | null;
}

export class EmbedCreatorService {
  private readonly clicks = new Set<string>();

  constructor(private readonly o: EmbedCreatorOptions) {}

  async list(): Promise<PostedMessageView[]> {
    const channels = await this.o.discordChannels().catch(() => null);
    return discordPostedMessagesRepo.list(this.o.db).map((r) => this.view(r, channels));
  }

  private view(r: DiscordPostedMessageRecord, channels: DiscordChannelsState | null): PostedMessageView {
    const g = channels?.guilds.find((x) => x.id === r.guildId);
    return {
      id: r.id,
      name: r.name,
      guildId: r.guildId,
      channelId: r.channelId,
      messageId: r.messageId,
      place: g?.name ?? null,
      channelName: g?.channels.find((c) => c.id === r.channelId)?.name ?? null,
      draft: draftOf(r),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      link: `https://discord.com/channels/${r.guildId}/${r.channelId}/${r.messageId}`,
    };
  }

  /** What Discord gets. Buttons another feature owns are left out (an edit then keeps them); mentions never ping. */
  private body(draft: MessageDraft, recordId: string): MessageBody {
    return {
      content: draft.content,
      embeds: draft.embeds.map((e) => toDiscordEmbed(e, {}, this.o.now())),
      ...(draft.externalComponents ? {} : { components: componentsToJson(draft.components, (id) => `c:${recordId}:${id}`) }),
      allowed_mentions: { parse: [] },
    };
  }

  private async token(): Promise<string> {
    const token = await this.o.credentials.botToken();
    if (!token) throw new AppError('conflict', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    return token;
  }

  /** The bot can post here (it can see the channel, send, and embed links). */
  private async checkChannel(guildId: string, channelId: string, embeds: boolean): Promise<string> {
    const channels = await this.o.discordChannels(true);
    const channel = channels.guilds.find((g) => g.id === guildId)?.channels.find((c) => c.id === channelId);
    if (!channel) throw new AppError('validation_error', 'Choose a channel the bot can see', { issues: [{ path: 'channelId', message: channels.problem ?? 'The bot can’t see that channel.' }] });
    const missing = missingDiscordPermissions(channel.permissions, ['viewChannel', 'sendMessages', ...(embeds ? (['embedLinks'] as const) : [])]);
    if (missing.length) throw new AppError('validation_error', `The bot needs ${missing.join(', ')} in #${channel.name}.`, { issues: [{ path: 'channelId', message: `The bot needs ${missing.join(', ')} in #${channel.name}.` }] });
    return channel.name;
  }

  /** Sends a new message as the bot and keeps it for later edits. */
  async send(raw: unknown): Promise<PostedMessageView> {
    const input = parseInput(sendMessageSchema, raw);
    await this.checkChannel(input.guildId, input.channelId, input.draft.embeds.length > 0);
    const id = crypto.randomUUID();
    const draft = { ...input.draft, externalComponents: false };
    const messageId = await this.discord(async () => this.o.api.createMessage(await this.token(), input.channelId, this.body(draft, id)));
    const r = this.track({ id, name: input.name, guildId: input.guildId, channelId: input.channelId, messageId, draft });
    this.audit('embed.message_sent', r);
    return this.view(r, await this.o.discordChannels().catch(() => null));
  }

  /** Saves changes to a kept message in Discord. */
  async update(id: string, raw: unknown): Promise<PostedMessageView> {
    const input = parseInput(updateMessageSchema, raw);
    const r = discordPostedMessagesRepo.get(this.o.db, id);
    if (!r) throw notFound('Message');
    // Whether the buttons belong to another feature is decided when the message is loaded, not by the editor.
    const draft = { ...input.draft, externalComponents: draftOf(r).externalComponents };
    if (draft.externalComponents) draft.components = [];
    await this.discord(async () => this.o.api.editMessage(await this.token(), r.channelId, r.messageId, this.body(draft, r.id)));
    discordPostedMessagesRepo.update(this.o.db, id, input.name, JSON.stringify(draft), this.o.now().toISOString());
    this.audit('embed.message_edited', r);
    return this.view(discordPostedMessagesRepo.get(this.o.db, id)!, await this.o.discordChannels().catch(() => null));
  }

  /** Reads a message from its link: keeps it when it's the bot's own, otherwise returns it for recreating. */
  async load(raw: unknown): Promise<LoadMessageResult> {
    const input = parseInput(loadMessageSchema, raw);
    const where = parseDiscordMessageLink(input.link);
    if (!where) throw new AppError('validation_error', 'Paste a Discord message link', { issues: [{ path: 'link', message: 'Paste a Discord message link (right-click the message → Copy Message Link)' }] });
    const message = await this.read(where.channelId, where.messageId);
    const notes: string[] = [];
    const parsed = messageFromJson({ content: message.content, embeds: message.embeds, components: message.components }, notes);
    if (message.authorId !== this.o.botUserId()) return { status: 'recreate', draft: parsed, notes, author: message.authorName };

    const existing = discordPostedMessagesRepo.byMessage(this.o.db, where.channelId, where.messageId);
    let r: DiscordPostedMessageRecord;
    if (existing) {
      // Text and embeds as they are in Discord now; buttons and what they do as saved here (Discord doesn't know that).
      const saved = draftOf(existing);
      const draft: MessageDraft = { ...parsed, components: saved.components, externalComponents: saved.externalComponents };
      discordPostedMessagesRepo.update(this.o.db, existing.id, existing.name, JSON.stringify(draft), this.o.now().toISOString());
      r = discordPostedMessagesRepo.get(this.o.db, existing.id)!;
    } else {
      // A message another feature posted (e.g. a giveaway): its buttons stay its own.
      const external = message.components.length > 0;
      notes.length = 0;
      const draft: MessageDraft = { ...messageFromJson({ content: message.content, embeds: message.embeds }, notes), externalComponents: external };
      if (external) notes.push('Its buttons belong to another feature (for example a giveaway) and stay as they are when you save changes.');
      r = this.track({ id: crypto.randomUUID(), name: defaultName(draft), guildId: where.guildId, channelId: where.channelId, messageId: where.messageId, draft });
    }
    this.audit('embed.message_loaded', r);
    return { status: 'tracked', message: this.view(r, await this.o.discordChannels().catch(() => null)), notes };
  }

  /** Posts a message again as the bot (in the same channel), optionally deleting the original. */
  async recreate(raw: unknown): Promise<{ message: PostedMessageView; note: string | null }> {
    const input = parseInput(recreateMessageSchema, raw);
    const where = parseDiscordMessageLink(input.link);
    if (!where) throw new AppError('validation_error', 'Paste a Discord message link', { issues: [{ path: 'link', message: 'Paste a Discord message link' }] });
    await this.checkChannel(where.guildId, where.channelId, input.draft.embeds.length > 0);
    const token = await this.token();
    const id = crypto.randomUUID();
    const draft = { ...input.draft, externalComponents: false };
    const messageId = await this.discord(() => this.o.api.createMessage(token, where.channelId, this.body(draft, id)));
    const r = this.track({ id, name: input.name, guildId: where.guildId, channelId: where.channelId, messageId, draft });
    let note: string | null = null;
    if (input.deleteOriginal) {
      try {
        await this.o.api.deleteMessage(token, where.channelId, where.messageId, 'Recreated in CONDUIT', { ownFeature: true });
      } catch (err) {
        if (!(err instanceof DiscordApiError && err.kind === 'not_found'))
          note = `The new message was posted, but the original wasn’t deleted: ${err instanceof DiscordApiError && err.kind === 'forbidden' ? 'the bot needs Manage Messages there.' : describe(err)}`;
      }
    }
    this.audit('embed.message_recreated', r);
    return { message: this.view(r, await this.o.discordChannels().catch(() => null)), note };
  }

  /** Stops keeping a message; with fromDiscord, deletes it in Discord too. */
  async remove(id: string, fromDiscord: boolean): Promise<void> {
    const r = discordPostedMessagesRepo.get(this.o.db, id);
    if (!r) throw notFound('Message');
    if (fromDiscord) {
      try {
        await this.o.api.deleteMessage(await this.token(), r.channelId, r.messageId, 'Deleted in CONDUIT', { ownFeature: true });
      } catch (err) {
        if (!(err instanceof DiscordApiError && err.kind === 'not_found')) throw err instanceof AppError ? err : new AppError('conflict', describe(err));
      }
    }
    discordPostedMessagesRepo.delete(this.o.db, id);
    this.audit('embed.message_removed', r);
  }

  // ── buttons and select menus ────────────────────────────────────────────────

  /** True when the click was on an Embed Creator button or menu (and was answered). */
  async onComponent(i: IncomingButton): Promise<boolean> {
    const m = CUSTOM_ID.exec(i.customId);
    if (!m) return false;
    if (this.clicks.has(i.id)) return true;
    this.clicks.add(i.id);
    if (this.clicks.size > REMEMBERED_CLICKS) this.clicks.delete(this.clicks.values().next().value!);
    const reply = (text: string) => i.reply(text.slice(0, 2000)).catch((err) => this.o.logger.warn('component reply failed', { err }));

    const r = discordPostedMessagesRepo.get(this.o.db, m[1]!);
    // Only the message it was posted on, in its server.
    if (!r || r.messageId !== i.messageId || r.guildId !== i.guildId) {
      await reply('This button isn’t active any more.');
      return true;
    }
    const component = draftOf(r)
      .components.flatMap((row) => row.components)
      .find((c) => c.id === m[2]);
    let actions: ComponentAction[] = [];
    if (component?.kind === 'button' && component.style !== 'link') actions = component.actions;
    else if (component?.kind === 'select') actions = component.options.filter((o) => (i.values ?? []).includes(o.id)).flatMap((o) => o.actions);
    else {
      await reply('This button isn’t active any more.');
      return true;
    }
    await reply(await this.run(r.guildId, i, actions));
    return true;
  }

  /** Runs the actions in order (stopping at the first that can't be done) and says what happened. */
  private async run(guildId: string, i: IncomingButton, actions: ComponentAction[]): Promise<string> {
    const said: string[] = [];
    const done: string[] = [];
    let token: string;
    try {
      token = await this.token();
    } catch {
      return 'This isn’t working right now. Please ask a moderator.';
    }
    // The member's roles, read once (only when a role action needs them) and kept up to date as actions change them.
    let roles: string[] | null = null;
    const memberRoles = async (): Promise<string[]> => {
      if (roles === null) roles = await this.o.api.guildMemberRoles(token, guildId, i.userId);
      return roles;
    };
    for (const a of actions) {
      try {
        if (a.type === 'reply') {
          said.push(a.content);
          continue;
        }
        if (a.type === 'verify') {
          const refusal = this.o.verifyRefusal(guildId, i.userId, i.userName, i.userHasAvatar ?? null);
          if (refusal) return refusal;
          await this.o.api.addMemberRole(token, guildId, i.userId, a.roleId, 'Verified with a button');
          done.push('You’re verified. Welcome!');
          continue;
        }
        const current = await memberRoles();
        const has = current.includes(a.roleId);
        const add = a.type === 'add_role' || (a.type === 'toggle_role' && !has);
        if (add) {
          if (!has) await this.o.api.addMemberRole(token, guildId, i.userId, a.roleId, 'Embed Creator button');
          roles = [...current, a.roleId];
          done.push(`You now have <@&${a.roleId}>.`);
        } else {
          if (has) await this.o.api.removeMemberRole(token, guildId, i.userId, a.roleId, 'Embed Creator button');
          roles = current.filter((x) => x !== a.roleId);
          done.push(`<@&${a.roleId}> was removed.`);
        }
      } catch (err) {
        this.o.logger.warn('component action failed', { type: a.type, err });
        return err instanceof DiscordApiError && err.kind === 'forbidden'
          ? 'I can’t change that role (it’s above my role, or I’m missing Manage Roles). Please tell a moderator.'
          : 'That didn’t work right now. Please try again, or ask a moderator.';
      }
    }
    return (said.length ? said : done).join('\n') || 'Done.';
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async read(channelId: string, messageId: string): Promise<ChannelMessage> {
    try {
      return await this.o.api.channelMessage(await this.token(), channelId, messageId);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof DiscordApiError && err.kind === 'not_found') throw new AppError('not_found', 'Discord couldn’t find that message. Check the link, and that the bot is in that server.');
      if (err instanceof DiscordApiError && err.kind === 'forbidden') throw new AppError('conflict', 'The bot can’t read that channel: it needs View Channel and Read Message History there.');
      throw new AppError('conflict', describe(err));
    }
  }

  private track(r: { id: string; name: string; guildId: string; channelId: string; messageId: string; draft: MessageDraft }): DiscordPostedMessageRecord {
    const at = this.o.now().toISOString();
    const record: DiscordPostedMessageRecord = { ...r, via: 'bot', webhookId: null, draft: JSON.stringify(r.draft), createdAt: at, updatedAt: at };
    discordPostedMessagesRepo.insert(this.o.db, record);
    return record;
  }

  private async discord<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('conflict', describe(err));
    }
  }

  private audit(action: 'embed.message_sent' | 'embed.message_edited' | 'embed.message_loaded' | 'embed.message_recreated' | 'embed.message_removed', r: DiscordPostedMessageRecord): void {
    writeAudit(this.o.db, { action, outcome: 'success', actorUserId: null, metadata: { id: r.id } }, this.o.now());
  }
}

function draftOf(r: DiscordPostedMessageRecord): MessageDraft {
  try {
    return messageDraftSchema.parse(JSON.parse(r.draft));
  } catch {
    return { content: '', embeds: [], components: [], externalComponents: false };
  }
}

/** A name for a loaded message: its first embed's title, else the start of its text. */
function defaultName(d: MessageDraft): string {
  const t = (d.embeds[0]?.title || d.embeds[0]?.authorName || d.content.split('\n')[0] || 'Message').trim();
  return t.length > MESSAGE_NAME_MAX ? `${t.slice(0, MESSAGE_NAME_MAX - 1)}…` : t;
}

function describe(err: unknown): string {
  if (!(err instanceof DiscordApiError)) return 'Something went wrong talking to Discord.';
  switch (err.kind) {
    case 'forbidden':
      return 'Discord refused: the bot is missing a permission in that channel (View Channel, Send Messages, Embed Links).';
    case 'not_found':
      return 'Discord couldn’t find the message (it may have been deleted).';
    case 'rate_limited':
      return 'Discord asked CONDUIT to slow down; try again in a moment.';
    case 'network':
      return 'Couldn’t reach Discord.';
    case 'server_error':
      return 'Discord had a problem; try again in a moment.';
    case 'invalid_credentials':
      return 'Discord rejected the bot token.';
    default:
      return err.discordMessage ? `Discord said: ${err.discordMessage}` : 'Discord returned an unexpected response.';
  }
}
