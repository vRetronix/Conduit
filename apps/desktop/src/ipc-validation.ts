/**
 * Validation of renderer → main IPC payloads. Kept free of Electron imports for unit testing.
 * The renderer is treated as untrusted: everything it sends is checked here before use.
 */
import { z } from 'zod';
import { platformSchema } from '@conduit/shared/app/connections';
import { API_METHODS, type ApiMethod, type ApiRequest } from '@conduit/shared/app/desktop-bridge';

const MAX_BODY_BYTES = 100 * 1024;

/**
 * The only API calls the renderer may make (allow-list, deny by default). The main process attaches the local
 * access key, so anything not listed here stays unreachable from the UI. That includes the dormant account API
 * (/api/setup, /api/auth/*, /api/me/*, /api/profiles*, /api/admin/*).
 */
const ALLOWED: ReadonlyArray<{ method: ApiMethod; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/health$/ },
  // Pop-up alerts (rate limits, accounts going down or coming back).
  { method: 'POST', path: /^\/api\/alerts\/query$/ },
  { method: 'GET', path: /^\/api\/connections$/ },
  // Connect is deliberately absent: it returns an authorization URL, so it goes through the dedicated
  // connections.connect IPC, where the main process validates and opens the URL itself.
  { method: 'POST', path: /^\/api\/connections\/[a-z]{1,20}\/(?:cancel|disconnect)$/ },
  // Discord setup wizard. Install is deliberately absent: it returns a URL, so it goes through the discord.installBot
  // IPC. The application endpoint accepts secrets write-only (no response ever contains them).
  { method: 'GET', path: /^\/api\/discord\/setup$/ },
  { method: 'POST', path: /^\/api\/discord\/(?:application|install\/cancel|installation\/check|bot\/restart|commands\/register|reset)$/ },
  // Kick setup. Connecting accounts goes through the connections.connect IPC (it returns an authorization URL).
  { method: 'GET', path: /^\/api\/kick\/setup$/ },
  // Commands hub: per platform (discord | kick) list/create, and edit/delete one custom command by id (UUID).
  { method: 'GET', path: /^\/api\/commands\/(?:discord|kick)$/ },
  // Commands → Discord: categories, Command Permissions and the bot's presence (Status / Rich Presence Updates).
  { method: 'GET', path: /^\/api\/discord\/(?:commands|presence)$/ },
  { method: 'POST', path: /^\/api\/discord\/(?:command-access|presence)$/ },
  // Discord → Embed Creator: messages sent as the bot and edited later; ids are UUIDs.
  { method: 'GET', path: /^\/api\/discord\/messages$/ },
  { method: 'POST', path: /^\/api\/discord\/messages(?:\/load|\/recreate|\/[0-9a-f-]{36}\/remove)?$/ },
  { method: 'PATCH', path: /^\/api\/discord\/messages\/[0-9a-f-]{36}$/ },
  // Discord Bot → Protection: the state, message checks, and Discord AutoMod rules per server (ids are snowflakes).
  { method: 'GET', path: /^\/api\/discord\/protection$/ },
  { method: 'POST', path: /^\/api\/discord\/protection\/(?:antinuke|quarantine\/[0-9a-f-]{36}\/(?:restore|release))$/ },
  { method: 'POST', path: /^\/api\/discord\/protection\/(?:antiraid|botbait|botbait\/warning|lockdown\/\d{17,20}(?:\/lift|\/preview)?)$/ },
  // AutoMod rule ids are CONDUIT's (UUIDs); server ids are snowflakes.
  { method: 'POST', path: /^\/api\/discord\/protection\/(?:messages|automod\/\d{17,20}(?:\/[0-9a-f-]{36}\/enabled)?)$/ },
  { method: 'PATCH', path: /^\/api\/discord\/protection\/automod\/\d{17,20}\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', path: /^\/api\/discord\/protection\/automod\/\d{17,20}\/[0-9a-f-]{36}$/ },
  { method: 'POST', path: /^\/api\/commands\/(?:discord|kick)$/ },
  { method: 'POST', path: /^\/api\/kick\/default-commands$/ },
  { method: 'PATCH', path: /^\/api\/commands\/(?:discord|kick)\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', path: /^\/api\/commands\/(?:discord|kick)\/[0-9a-f-]{36}$/ },
  { method: 'POST', path: /^\/api\/kick\/(?:application|chatbot|chat\/send|chat\/retry)$/ },
  // Kick → Clips.
  { method: 'GET', path: /^\/api\/kick\/clips$/ },
  { method: 'POST', path: /^\/api\/kick\/clips(?:\/refresh)?$/ },
  { method: 'POST', path: /^\/api\/kick\/clips\/clip_[0-9A-Za-z]{10,40}\/(?:post|save)$/ },
  { method: 'GET', path: /^\/api\/giveaways$/ },
  { method: 'POST', path: /^\/api\/giveaways$/ },
  { method: 'PATCH', path: /^\/api\/giveaways\/[0-9a-f-]{36}$/ },
  // Deleting a completed giveaway.
  { method: 'DELETE', path: /^\/api\/giveaways\/[0-9a-f-]{36}$/ },
  { method: 'POST', path: /^\/api\/giveaways\/[0-9a-f-]{36}\/(?:start|end|cancel|draw|redraw|discord\/retry)$/ },
  { method: 'GET', path: /^\/api\/giveaways\/discord\/channels$/ },
  { method: 'POST', path: /^\/api\/giveaways\/kick-messages$/ },
  { method: 'GET', path: /^\/api\/moderation(?:\/kick|\/discord)?$/ },
  { method: 'POST', path: /^\/api\/moderation\/(?:lookup|actions|automod|raid|user-history)$/ },
  { method: 'GET', path: /^\/api\/(?:timed-messages|notifications|discord\/stickies|discord\/logging|discord\/embeds)$/ },
  { method: 'POST', path: /^\/api\/(?:timed-messages|notifications|notifications\/check|notifications\/test|discord\/stickies|discord\/logging|discord\/embeds|discord\/embeds\/test|discord\/embeds\/autosave)$/ },
  { method: 'POST', path: /^\/api\/timed-messages\/[0-9a-f-]{36}\/duplicate$/ },
  // Discord → Loyalty & Rewards (searches and history are POSTs: no query strings here).
  { method: 'GET', path: /^\/api\/loyalty(?:\/roles)?$/ },
  { method: 'POST', path: /^\/api\/loyalty\/(?:settings|members\/query|members\/history|members\/points|members\/xp|rewards|role-rewards)$/ },
  { method: 'PATCH', path: /^\/api\/loyalty\/rewards\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', path: /^\/api\/loyalty\/(?:rewards|role-rewards)\/[0-9a-f-]{36}$/ },
  { method: 'POST', path: /^\/api\/loyalty\/redemptions\/[0-9a-f-]{36}\/(?:fulfill|reject)$/ },
  // Settings → Appearance & Themes.
  { method: 'GET', path: /^\/api\/appearance$/ },
  { method: 'POST', path: /^\/api\/appearance$/ },
  // Settings → Backup & Restore, Logs.
  { method: 'GET', path: /^\/api\/backups$/ },
  { method: 'POST', path: /^\/api\/(?:backups|backups\/verify|backups\/restore|logs\/query)$/ },
  { method: 'PATCH', path: /^\/api\/backups\/settings$/ },
  { method: 'PATCH', path: /^\/api\/(?:timed-messages|notifications|discord\/stickies|discord\/embeds)\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', path: /^\/api\/(?:timed-messages|notifications|discord\/stickies|discord\/embeds)\/[0-9a-f-]{36}$/ },
];

/** The colour of the window buttons (minimize, maximize, close), from the theme: a #rrggbb colour only. */
export function validateControlsColor(input: unknown): string | null {
  return typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : null;
}

/** The connections.connect IPC payload: which platform, and which of its accounts (streamer or chatbot). */
/** A clip's page on kick.com, exactly (Kick → Clips → View on Kick); anything else is refused. */
export function validateKickClipUrl(input: unknown): string | null {
  return typeof input === 'string' && /^https:\/\/kick\.com\/[A-Za-z0-9_-]{1,25}\/clips\/clip_[0-9A-Za-z]{10,40}$/.test(input) ? input : null;
}

export const connectRequestSchema = z.strictObject({
  platform: platformSchema,
  role: z.enum(['primary', 'bot']).default('primary'),
});

const apiRequestSchema = z.strictObject({
  method: z.enum(API_METHODS),
  path: z.string().max(512),
  body: z.unknown().optional(),
});

/** Returns the request if the renderer may make it, otherwise null. */
export function validateApiRequest(input: unknown): ApiRequest | null {
  const parsed = apiRequestSchema.safeParse(input);
  if (!parsed.success) return null;
  const { method, path, body } = parsed.data;
  if (!ALLOWED.some((rule) => rule.method === method && rule.path.test(path))) return null;
  if (body !== undefined) {
    if (method === 'GET') return null;
    let json: string | undefined;
    try {
      json = JSON.stringify(body);
    } catch {
      return null;
    }
    if (json === undefined || Buffer.byteLength(json) > MAX_BODY_BYTES) return null;
  }
  return { method, path, ...(body !== undefined ? { body } : {}) };
}
