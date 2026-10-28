/**
 * Discord embeds: one model for every feature that posts them (Timed Messages, Sticky Messages, Stream Notifications,
 * Discord Logging), validated against Discord's documented limits
 * (https://docs.discord.com/developers/resources/message#embed-object-embed-limits) before anything is sent.
 *
 * Text fields may contain {variables} (each feature lists its own); they are filled in when sending. URL fields accept
 * an http(s) URL or a single {variable} that the feature fills with a URL (e.g. a stream thumbnail).
 */
import { z } from 'zod';

export const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  /** All text in one embed together. */
  total: 6000,
  content: 2000,
} as const;

const VARIABLE_ONLY = /^\{[a-z_]+\}$/;
const urlOrVariable = z
  .string()
  .trim()
  .max(2048, 'At most 2048 characters')
  .refine((s) => s === '' || VARIABLE_ONLY.test(s) || /^https?:\/\/[^\s]+$/i.test(s), 'Use an http(s) link (or a {variable} that gives one)')
  .default('');

const text = (max: number, label: string) => z.string().max(max, `${label}: at most ${max} characters`).default('');

export const embedFieldSchema = z.strictObject({
  name: z.string().trim().min(1, 'Each field needs a name').max(EMBED_LIMITS.fieldName, `Field names: at most ${EMBED_LIMITS.fieldName} characters`),
  value: z.string().trim().min(1, 'Each field needs a value').max(EMBED_LIMITS.fieldValue, `Field values: at most ${EMBED_LIMITS.fieldValue} characters`),
  inline: z.boolean().default(false),
});

export const embedSchema = z
  .strictObject({
    authorName: text(EMBED_LIMITS.author, 'Author'),
    authorIconUrl: urlOrVariable,
    authorUrl: urlOrVariable,
    title: text(EMBED_LIMITS.title, 'Title'),
    url: urlOrVariable,
    description: text(EMBED_LIMITS.description, 'Description'),
    /** #RRGGBB */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #048BA8').default('#048BA8'),
    fields: z.array(embedFieldSchema).max(EMBED_LIMITS.fields, `At most ${EMBED_LIMITS.fields} fields`).default([]),
    thumbnailUrl: urlOrVariable,
    imageUrl: urlOrVariable,
    footerText: text(EMBED_LIMITS.footer, 'Footer'),
    footerIconUrl: urlOrVariable,
    /** Show the time the message is posted. */
    timestamp: z.boolean().default(false),
  })
  .superRefine((e, ctx) => {
    const total = [e.authorName, e.title, e.description, e.footerText, ...e.fields.flatMap((f) => [f.name, f.value])].join('').length;
    if (total > EMBED_LIMITS.total) ctx.addIssue({ code: 'custom', message: `All embed text together is at most ${EMBED_LIMITS.total} characters (now ${total})` });
    const visible = e.title || e.description || e.authorName || e.fields.length || e.imageUrl || e.thumbnailUrl || e.footerText;
    if (!visible) ctx.addIssue({ code: 'custom', message: 'The embed is empty: add a title, description, field or image' });
    if (e.footerIconUrl && !e.footerText) ctx.addIssue({ code: 'custom', path: ['footerIconUrl'], message: 'A footer icon needs footer text' });
    if (e.authorIconUrl && !e.authorName) ctx.addIssue({ code: 'custom', path: ['authorIconUrl'], message: 'An author icon needs an author name' });
  });
export type DiscordEmbed = z.output<typeof embedSchema>;

export const EMPTY_EMBED: DiscordEmbed = {
  authorName: '',
  authorIconUrl: '',
  authorUrl: '',
  title: '',
  url: '',
  description: '',
  color: '#048BA8',
  fields: [],
  thumbnailUrl: '',
  imageUrl: '',
  footerText: '',
  footerIconUrl: '',
  timestamp: false,
};

/** A message body a feature posts: text, an embed, or both (at least one). */
export const discordMessageSchema = z
  .strictObject({
    content: z.string().max(EMBED_LIMITS.content, `Message text: at most ${EMBED_LIMITS.content} characters`).default(''),
    embed: embedSchema.nullable().default(null),
  })
  .refine((m) => m.content.trim() !== '' || m.embed !== null, 'Add message text or an embed');
export type DiscordMessageInput = z.output<typeof discordMessageSchema>;

/** Placeholders used in any text or URL field. */
export function templateVariables(m: { content?: string; embed?: DiscordEmbed | null }): string[] {
  const parts = [m.content ?? ''];
  if (m.embed) {
    const e = m.embed;
    parts.push(e.authorName, e.authorIconUrl, e.authorUrl, e.title, e.url, e.description, e.thumbnailUrl, e.imageUrl, e.footerText, e.footerIconUrl);
    for (const f of e.fields) parts.push(f.name, f.value);
  }
  return [...new Set(parts.flatMap((p) => [...p.matchAll(/\{([a-z_]+)\}/gi)].map((x) => x[1]!.toLowerCase())))];
}

/**
 * Fills {variables} (single pass; unknown ones stay as written). Variable names are lowercase; a differently
 * capitalised one ({Streamer}) still fills, so a casing typo never shows raw braces in a post.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (whole, name: string) => {
    const key = Object.hasOwn(vars, name) ? name : name.toLowerCase();
    return Object.hasOwn(vars, key) ? vars[key]! : whole;
  });
}

/** Rewrites known {Variables} in their canonical lowercase form ({Streamer} → {streamer}); others are untouched. */
export function canonicalVariables(text: string, known: readonly string[]): string {
  return text.replace(/\{([a-z_]+)\}/gi, (whole, name: string) => (known.includes(name.toLowerCase()) ? `{${name.toLowerCase()}}` : whole));
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const urlOrUndefined = (s: string) => (/^https?:\/\/[^\s]+$/i.test(s) ? s : undefined);

/**
 * Discord's embed JSON from the model, with variables filled in. Values are cut to Discord's limits after filling (a
 * long stream title can't make the send fail); empty parts are left out; URL fields that don't end up as http(s)
 * links are dropped rather than sent broken.
 */
export function toDiscordEmbed(e: DiscordEmbed, vars: Record<string, string> = {}, now: Date = new Date()): Record<string, unknown> {
  const f = (s: string) => fillTemplate(s, vars).trim();
  const out: Record<string, unknown> = { color: Number.parseInt(e.color.slice(1), 16) };
  const authorName = cut(f(e.authorName), EMBED_LIMITS.author);
  if (authorName) out.author = { name: authorName, ...(urlOrUndefined(f(e.authorIconUrl)) ? { icon_url: f(e.authorIconUrl) } : {}), ...(urlOrUndefined(f(e.authorUrl)) ? { url: f(e.authorUrl) } : {}) };
  const title = cut(f(e.title), EMBED_LIMITS.title);
  if (title) out.title = title;
  if (urlOrUndefined(f(e.url))) out.url = f(e.url);
  const description = cut(f(e.description), EMBED_LIMITS.description);
  if (description) out.description = description;
  const fields = e.fields
    .map((x) => ({ name: cut(f(x.name), EMBED_LIMITS.fieldName), value: cut(f(x.value), EMBED_LIMITS.fieldValue), inline: x.inline }))
    .filter((x) => x.name && x.value);
  if (fields.length) out.fields = fields;
  if (urlOrUndefined(f(e.thumbnailUrl))) out.thumbnail = { url: f(e.thumbnailUrl) };
  if (urlOrUndefined(f(e.imageUrl))) out.image = { url: f(e.imageUrl) };
  const footer = cut(f(e.footerText), EMBED_LIMITS.footer);
  if (footer) out.footer = { text: footer, ...(urlOrUndefined(f(e.footerIconUrl)) ? { icon_url: f(e.footerIconUrl) } : {}) };
  if (e.timestamp) out.timestamp = now.toISOString();
  return out;
}

/** A saved embed in the library (reusable across features). */
export interface SavedEmbedView {
  id: string;
  name: string;
  embed: DiscordEmbed;
  updatedAt: string;
}

export const saveEmbedSchema = z.strictObject({
  name: z.string().trim().min(1, 'Give it a name').max(60, 'At most 60 characters'),
  embed: embedSchema,
});

/** Send a test message (text and/or embed) to a channel. Variables are shown as written. */
export const testEmbedSchema = z.strictObject({
  guildId: z.string().regex(/^\d{1,25}$/, 'Choose a server'),
  channelId: z.string().regex(/^\d{1,25}$/, 'Choose a channel'),
  message: discordMessageSchema,
});

/** Discord permission bits used by CONDUIT's Discord features. */
export const DISCORD_PERMISSIONS = {
  viewChannel: { bit: 1n << 10n, name: 'View Channel' },
  sendMessages: { bit: 1n << 11n, name: 'Send Messages' },
  embedLinks: { bit: 1n << 14n, name: 'Embed Links' },
  readMessageHistory: { bit: 1n << 16n, name: 'Read Message History' },
  mentionEveryone: { bit: 1n << 17n, name: 'Mention Everyone' },
  viewAuditLog: { bit: 1n << 7n, name: 'View Audit Log' },
  manageMessages: { bit: 1n << 13n, name: 'Manage Messages' },
  manageGuild: { bit: 1n << 5n, name: 'Manage Server' },
  moderateMembers: { bit: 1n << 40n, name: 'Timeout Members' },
  kickMembers: { bit: 1n << 1n, name: 'Kick Members' },
  banMembers: { bit: 1n << 2n, name: 'Ban Members' },
  manageRoles: { bit: 1n << 28n, name: 'Manage Roles' },
} as const;
export type DiscordPermissionKey = keyof typeof DISCORD_PERMISSIONS;

/** Names of the listed permissions missing from a channel's permission bits (a decimal string, as Discord sends). */
export function missingDiscordPermissions(bits: string | undefined, needed: readonly DiscordPermissionKey[]): string[] {
  if (bits === undefined || !/^\d+$/.test(bits)) return needed.map((k) => DISCORD_PERMISSIONS[k].name);
  const b = BigInt(bits);
  return needed.filter((k) => (b & DISCORD_PERMISSIONS[k].bit) !== DISCORD_PERMISSIONS[k].bit).map((k) => DISCORD_PERMISSIONS[k].name);
}
