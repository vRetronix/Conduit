/**
 * The embed library: saved Discord embeds (reusable by Timed Messages, Sticky Messages and Stream Notifications —
 * loading one copies it into the feature, so later library edits never change what's already configured) and test
 * sends to a channel before saving anything. The Embed Creator saves its messages' embeds here automatically, under the
 * message's name ("Rules", "Rules (2)"…).
 */
import crypto from 'node:crypto';
import { savedEmbedsRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  autosaveEmbedsSchema,
  EMBEDS_PER_MESSAGE,
  embedSchema,
  libraryNames,
  missingDiscordPermissions,
  saveEmbedSchema,
  testEmbedSchema,
  type DiscordChannelsState,
  type SavedEmbedView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import { parseInput } from '../validation';
import type { DiscordPoster } from './discord-poster';

export class EmbedLibraryService {
  constructor(
    private readonly o: {
      db: Database;
      now: () => Date;
      logger: Logger;
      poster: Pick<DiscordPoster, 'post'>;
      discordChannels: (force?: boolean) => Promise<DiscordChannelsState>;
    },
  ) {}

  list(): SavedEmbedView[] {
    return savedEmbedsRepo.list(this.o.db).flatMap((r) => {
      try {
        const embed = embedSchema.parse(JSON.parse(r.embed));
        return [{ id: r.id, name: r.name, embed, updatedAt: r.updatedAt }];
      } catch {
        return [];
      }
    });
  }

  save(raw: unknown, id?: string): SavedEmbedView {
    const input = parseInput(saveEmbedSchema, raw);
    const at = this.o.now().toISOString();
    if (id) {
      if (!savedEmbedsRepo.update(this.o.db, id, input.name, JSON.stringify(input.embed), at)) throw notFound('Saved embed');
    } else {
      id = crypto.randomUUID();
      savedEmbedsRepo.insert(this.o.db, { id, name: input.name, embed: JSON.stringify(input.embed), createdAt: at, updatedAt: at });
    }
    writeAudit(this.o.db, { action: 'embed.saved', outcome: 'success', actorUserId: null, metadata: { id } }, this.o.now());
    return { id, name: input.name, embed: input.embed, updatedAt: at };
  }

  /**
   * The Embed Creator's automatic save: the message's embeds become the library entries named after it ("Rules", then
   * "Rules (2)"… for more embeds). A rename moves the entries saved under the previous name; entries for embeds that
   * were removed are deleted. Returns the entries as saved.
   */
  autosave(raw: unknown): SavedEmbedView[] {
    const input = parseInput(autosaveEmbedsSchema, raw);
    const at = this.o.now().toISOString();
    const byName = new Map(savedEmbedsRepo.list(this.o.db).map((r) => [r.name, r]));
    const names = libraryNames(input.name, input.embeds.length);
    if (input.previousName && input.previousName !== input.name) {
      libraryNames(input.previousName, EMBEDS_PER_MESSAGE).forEach((old, i) => {
        const r = byName.get(old);
        if (!r) return;
        byName.delete(old);
        if (i < names.length && !byName.has(names[i]!)) {
          savedEmbedsRepo.update(this.o.db, r.id, names[i]!, r.embed, at);
          byName.set(names[i]!, { ...r, name: names[i]! });
        } else savedEmbedsRepo.delete(this.o.db, r.id);
      });
    }
    const saved = names.map((n, i) => {
      const embed = JSON.stringify(input.embeds[i]);
      const existing = byName.get(n);
      if (existing) {
        if (existing.embed !== embed) savedEmbedsRepo.update(this.o.db, existing.id, n, embed, at);
        return { id: existing.id, name: n, embed: input.embeds[i]!, updatedAt: existing.embed !== embed ? at : existing.updatedAt };
      }
      const id = crypto.randomUUID();
      savedEmbedsRepo.insert(this.o.db, { id, name: n, embed, createdAt: at, updatedAt: at });
      return { id, name: n, embed: input.embeds[i]!, updatedAt: at };
    });
    // Embeds removed from the message: their entries go too.
    for (const extra of libraryNames(input.name, EMBEDS_PER_MESSAGE).slice(names.length)) {
      const r = byName.get(extra);
      if (r) savedEmbedsRepo.delete(this.o.db, r.id);
    }
    return saved;
  }

  delete(id: string): { id: string; deleted: true } {
    if (!savedEmbedsRepo.delete(this.o.db, id)) throw notFound('Saved embed');
    writeAudit(this.o.db, { action: 'embed.deleted', outcome: 'success', actorUserId: null, metadata: { id } }, this.o.now());
    return { id, deleted: true };
  }

  /** Posts a test (variables shown as written). Reports Discord's real answer. */
  async test(raw: unknown): Promise<{ ok: boolean; message: string }> {
    const input = parseInput(testEmbedSchema, raw);
    const channels = await this.o.discordChannels(true);
    const channel = channels.guilds.find((g) => g.id === input.guildId)?.channels.find((c) => c.id === input.channelId);
    if (!channel) throw new AppError('validation_error', 'Choose a channel the bot can see', { issues: [{ path: 'channelId', message: channels.problem ?? 'The bot can’t see that channel.' }] });
    const missing = missingDiscordPermissions(channel.permissions, ['viewChannel', 'sendMessages', ...(input.message.embed ? (['embedLinks'] as const) : [])]);
    if (missing.length) return { ok: false, message: `The bot needs ${missing.join(', ')} in #${channel.name}.` };
    const res = await this.o.poster.post(input.channelId, input.message);
    return res.ok ? { ok: true, message: `Test posted in #${channel.name}.` } : { ok: false, message: res.detail };
  }
}
