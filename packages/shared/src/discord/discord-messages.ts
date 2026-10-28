/**
 * Discord → Embed Creator: whole messages (text plus up to 10 embeds), and Discord's JSON for every embed in CONDUIT.
 * The JSON is Discord's own message format, so embeds can be copied in and out as text.
 *
 * Messages CONDUIT can edit later are "posted messages": ones its bot sent. Anyone else's message can be recreated:
 * posted again as the bot.
 */
import { z } from 'zod';
import { componentRowsSchema, componentsFromJson, componentsToJson } from './discord-components';
import { EMBED_LIMITS, EMPTY_EMBED, embedSchema, type DiscordEmbed } from './embeds';

export const EMBEDS_PER_MESSAGE = 10;

/** A message being made in the Embed Creator. */
export const messageDraftSchema = z
  .strictObject({
    content: z.string().max(EMBED_LIMITS.content, `Message text: at most ${EMBED_LIMITS.content} characters`).default(''),
    embeds: z.array(embedSchema).max(EMBEDS_PER_MESSAGE, `At most ${EMBEDS_PER_MESSAGE} embeds per message`).default([]),
    /** Buttons and select menus (see discord-components.ts). */
    components: componentRowsSchema,
    /**
     * The message's buttons belong to another CONDUIT feature (e.g. a giveaway's Enter button): saving leaves them as
     * they are, and the Creator doesn't show them.
     */
    externalComponents: z.boolean().default(false),
  })
  .refine((m) => m.content.trim() !== '' || m.embeds.length > 0, 'Add message text or an embed')
  .superRefine((m, ctx) => {
    // Discord also limits all embeds of one message together.
    const total = m.embeds.reduce((n, e) => n + [e.authorName, e.title, e.description, e.footerText, ...e.fields.flatMap((f) => [f.name, f.value])].join('').length, 0);
    if (total > EMBED_LIMITS.total) ctx.addIssue({ code: 'custom', path: ['embeds'], message: `All embeds together are at most ${EMBED_LIMITS.total} characters (now ${total})` });
  });
export type MessageDraft = z.output<typeof messageDraftSchema>;

export const EMPTY_DRAFT: MessageDraft = { content: '', embeds: [structuredClone(EMPTY_EMBED)], components: [], externalComponents: false };

// ── JSON (Discord's format) ──────────────────────────────────────────────────

/** An embed as Discord's JSON, as written (variables are kept; nothing is filled in). */
export function embedToJson(e: DiscordEmbed, now: Date = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.title) out.title = e.title;
  if (e.description) out.description = e.description;
  if (e.url) out.url = e.url;
  out.color = Number.parseInt(e.color.replace('#', ''), 16) || 0;
  if (e.authorName) out.author = { name: e.authorName, ...(e.authorUrl ? { url: e.authorUrl } : {}), ...(e.authorIconUrl ? { icon_url: e.authorIconUrl } : {}) };
  if (e.fields.length) out.fields = e.fields.map((f) => ({ name: f.name, value: f.value, ...(f.inline ? { inline: true } : {}) }));
  if (e.thumbnailUrl) out.thumbnail = { url: e.thumbnailUrl };
  if (e.imageUrl) out.image = { url: e.imageUrl };
  if (e.footerText) out.footer = { text: e.footerText, ...(e.footerIconUrl ? { icon_url: e.footerIconUrl } : {}) };
  // Discord wants a time here; CONDUIT replaces it with the time of posting.
  if (e.timestamp) out.timestamp = now.toISOString();
  return out;
}

/** A message as Discord's JSON: { content, embeds, components } (buttons carry CONDUIT's "actions"). */
export function messageToJson(m: MessageDraft, now: Date = new Date()): { content: string | null; embeds: Array<Record<string, unknown>>; components?: Array<Record<string, unknown>> } {
  return { content: m.content || null, embeds: m.embeds.map((e) => embedToJson(e, now)), ...(m.components.length ? { components: componentsToJson(m.components) } : {}) };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Discord's embed JSON → CONDUIT's embed (not yet checked against the limits; the editor shows any problems). */
export function embedFromJson(raw: unknown, notes: string[] = []): DiscordEmbed {
  const j = obj(raw);
  const author = obj(j.author);
  const footer = obj(j.footer);
  const color = typeof j.color === 'number' && Number.isInteger(j.color) && j.color >= 0 && j.color <= 0xffffff ? `#${j.color.toString(16).padStart(6, '0')}` : null;
  if (color === null) notes.push('An embed had no colour; it gets a dark grey one (Discord’s default looks the same).');
  const known = new Set(['title', 'description', 'url', 'color', 'author', 'fields', 'thumbnail', 'image', 'footer', 'timestamp', 'type']);
  const dropped = Object.keys(j).filter((k) => !known.has(k));
  if (dropped.length) notes.push(`Not kept from an embed: ${dropped.join(', ')}.`);
  return {
    ...structuredClone(EMPTY_EMBED),
    authorName: str(author.name),
    authorIconUrl: str(author.icon_url),
    authorUrl: str(author.url),
    title: str(j.title),
    url: str(j.url),
    description: str(j.description),
    color: color ?? '#2b2d31',
    fields: (Array.isArray(j.fields) ? j.fields : []).map((f) => ({ name: str(obj(f).name), value: str(obj(f).value), inline: obj(f).inline === true })),
    thumbnailUrl: str(obj(j.thumbnail).url),
    imageUrl: str(obj(j.image).url),
    footerText: str(footer.text),
    footerIconUrl: str(footer.icon_url),
    timestamp: typeof j.timestamp === 'string' && j.timestamp !== '',
  };
}

/** Discord's message JSON → a draft. Parts CONDUIT doesn't post (buttons, files, webhook name…) are listed in notes. */
export function messageFromJson(raw: unknown, notes: string[] = []): MessageDraft {
  const j = obj(raw);
  const embeds = (Array.isArray(j.embeds) ? j.embeds : []).filter((e) => obj(e).type === undefined || obj(e).type === 'rich');
  if (Array.isArray(j.embeds) && embeds.length < j.embeds.length) notes.push('Link previews (not real embeds) were left out.');
  if (embeds.length > EMBEDS_PER_MESSAGE) notes.push(`Only the first ${EMBEDS_PER_MESSAGE} embeds were kept.`);
  const skipped = ['attachments', 'files', 'poll', 'username', 'avatar_url', 'thread_name', 'flags'].filter((k) => {
    const v = j[k];
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== 0;
  });
  if (skipped.length) notes.push(`Not kept (CONDUIT posts text and embeds only): ${skipped.join(', ')}.`);
  return {
    content: str(j.content),
    embeds: embeds.slice(0, EMBEDS_PER_MESSAGE).map((e) => embedFromJson(e, notes)),
    components: componentsFromJson(j.components, notes),
    externalComponents: false,
  };
}

const LOOKS_LIKE_EMBED = ['title', 'description', 'fields', 'author', 'footer', 'image', 'thumbnail', 'color'];

/** Reads what was pasted: Discord message JSON ({ content, embeds }), one embed, or a list of embeds. */
export function parseMessageJson(text: string): { ok: true; draft: MessageDraft; notes: string[] } | { ok: false; error: string } {
  const notes: string[] = [];
  const input = text.trim();
  if (!input) return { ok: false, error: 'Paste Discord message or embed JSON.' };
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    return { ok: false, error: `That isn’t valid JSON: ${err instanceof Error ? err.message : 'parse error'}.` };
  }
  if (Array.isArray(raw)) return { ok: true, draft: messageFromJson({ embeds: raw }, notes), notes };
  const j = obj(raw);
  if ('embeds' in j || 'content' in j || 'components' in j) return { ok: true, draft: messageFromJson(j, notes), notes };
  if (LOOKS_LIKE_EMBED.some((k) => k in j)) return { ok: true, draft: { content: '', embeds: [embedFromJson(j, notes)], components: [], externalComponents: false }, notes };
  return { ok: false, error: 'This JSON isn’t a Discord message or embed.' };
}

// ── posted messages ──────────────────────────────────────────────────────────

/** A message the Embed Creator can edit later. */
export interface PostedMessageView {
  id: string;
  name: string;
  guildId: string;
  channelId: string;
  messageId: string;
  place: string | null;
  channelName: string | null;
  draft: MessageDraft;
  createdAt: string;
  updatedAt: string;
  link: string;
}

const snowflake = z.string().regex(/^\d{1,25}$/, 'Choose a channel');
/** A message's name is also its embeds' name in the library ("Rules", "Rules (2)"…), which allows 60 characters. */
export const MESSAGE_NAME_MAX = 54;
const name = z.string().trim().min(1, 'Give it a name').max(MESSAGE_NAME_MAX, `At most ${MESSAGE_NAME_MAX} characters`);

/** The library names of a message's embeds: "Rules" for one, "Rules", "Rules (2)"… for several. */
export function libraryNames(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base} (${i + 1})`));
}

/** The Embed Creator saves a message's embeds to the library automatically, under the message's name. */
export const autosaveEmbedsSchema = z.strictObject({
  name,
  /** The name it was saved under before (a rename moves those library entries). */
  previousName: z.string().trim().max(MESSAGE_NAME_MAX).nullable().default(null),
  embeds: z.array(embedSchema).max(EMBEDS_PER_MESSAGE),
});

export const sendMessageSchema = z.strictObject({ name, guildId: snowflake, channelId: snowflake, draft: messageDraftSchema });
export const updateMessageSchema = z.strictObject({ name, draft: messageDraftSchema });
export const loadMessageSchema = z.strictObject({ link: z.string().trim().min(1, 'Paste a message link') });
export const recreateMessageSchema = z.strictObject({ link: z.string().trim().min(1), name, draft: messageDraftSchema, deleteOriginal: z.boolean() });

/** What loading a message from a link found: the bot's own (kept, editable), or someone else's (to recreate as the bot). */
export type LoadMessageResult = { status: 'tracked'; message: PostedMessageView; notes: string[] } | { status: 'recreate'; draft: MessageDraft; notes: string[]; author: string };
