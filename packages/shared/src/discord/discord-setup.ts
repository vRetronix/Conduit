/**
 * Discord setup wizard contracts. Each user brings their own Discord application (there is no shared CONDUIT
 * application or bot). Secrets (Client Secret, Bot Token) go one way only: from the setup form to the backend's
 * encrypted vault. They are never returned in any of these shapes.
 */
import { z } from 'zod';

/** Discord snowflake ids are 17–20 digits today; allow some headroom. */
const snowflake = z.string().trim().regex(/^\d{15,25}$/, 'Paste the numeric Application ID (15–25 digits)');

const clientSecret = z
  .string()
  .trim()
  .min(16, 'This looks too short for a Client Secret')
  .max(256)
  .regex(/^\S+$/, 'A Client Secret contains no spaces');

const botToken = z
  .string()
  .trim()
  .min(50, 'This looks too short for a bot token')
  .max(256)
  .regex(/^[A-Za-z0-9_\-.]+$/, 'A bot token contains only letters, numbers, dots, dashes and underscores')
  .refine((t) => t.split('.').length === 3, 'A bot token has three parts separated by dots');

/**
 * Save or replace the application configuration. Secrets may be omitted when replacing only some values for the
 * same Application ID; the stored ones are kept.
 */
export const saveDiscordApplicationSchema = z.strictObject({
  applicationId: snowflake,
  clientSecret: clientSecret.optional(),
  botToken: botToken.optional(),
});
export type SaveDiscordApplicationRequest = z.input<typeof saveDiscordApplicationSchema>;

export type DiscordSetupStep = 'application' | 'account' | 'install' | 'bot' | 'done';

export type DiscordBotStatus = 'not_configured' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
export type DiscordInstallStatus = 'installed' | 'not_installed' | 'unable_to_verify' | 'unknown';

export interface DiscordSetupState {
  /** First step that is not complete; where Connect / Continue setup resumes. */
  nextStep: DiscordSetupStep;
  application: {
    configured: boolean;
    applicationId: string | null;
    applicationName: string | null;
    clientSecretStored: boolean;
    botTokenStored: boolean;
    validatedAt: string | null;
    /** The bot user Discord confirmed for the stored token when it was last validated (non-secret). */
    botUserId: string | null;
    botUsername: string | null;
  };
  account: {
    connected: boolean;
    name: string | null;
    handle: string | null;
    avatarDataUrl: string | null;
    pending: boolean;
    problem: string | null;
  };
  bot: {
    status: DiscordBotStatus;
    /** The bot user Discord confirmed for the stored token. */
    username: string | null;
    /** The bot's real Discord avatar (fetched by the backend), or null when it has none or it couldn't be loaded. */
    avatarDataUrl?: string | null;
    userId: string | null;
    problem: string | null;
    /** Whether Reconnect can help (false e.g. for a rejected token, which needs a new token). */
    retryable: boolean;
    since: string | null;
  };
  installation: {
    status: DiscordInstallStatus;
    /** Servers the bot is verifiably in (from Discord's gateway or API), never from a browser redirect. */
    guilds: Array<{ id: string; name: string; /** The server's real icon, or null when none/unavailable. */ iconDataUrl?: string | null }>;
    checkedAt: string | null;
    /** Verified via the live bot connection, or the last REST check. */
    source: 'gateway' | 'api' | null;
    pending: boolean;
    problem: string | null;
  };
  /** Slash command registration: separate from the bot connection (a bot can be online without its commands). */
  commands: DiscordCommandsState;
  /** The redirect URI to register on the application's OAuth2 page (exactly). */
  redirectUri: string;
  /** Permissions integer requested when adding the bot. Deliberately minimal (never Administrator). */
  installPermissions: string;
  /** Gateway intents CONDUIT uses, and whether any is privileged (needs a Developer Portal toggle). */
  intents: Array<{ name: string; privileged: boolean }>;
}

/**
 * - registered: Discord confirmed the current commands in every server the bot is in;
 * - partial: confirmed in some servers, failed in others;
 * - failed: not confirmed anywhere, with a reason;
 * - registering: a registration is in progress;
 * - not_registered: nothing attempted yet (e.g. the bot isn't in a server).
 */
export type DiscordCommandsStatus = 'not_registered' | 'registering' | 'registered' | 'partial' | 'failed';

export interface DiscordCommandsState {
  status: DiscordCommandsStatus;
  /** Server-scoped registration (appears immediately, unlike global commands). */
  scope: 'guild';
  /** Command names CONDUIT provides, e.g. ['ping']. */
  names: string[];
  /** The commands defined locally in CONDUIT's command registry (not a claim that Discord has them). */
  definitions: Array<{
    name: string;
    description: string;
    requiresPermissions: boolean;
    /** 'default': built into CONDUIT (not editable or removable); 'user': created by the user in CONDUIT. */
    origin: 'default' | 'user';
  }>;
  /** The application and bot the commands are registered for. */
  applicationId: string | null;
  botUsername: string | null;
  guilds: Array<{
    id: string;
    name: string;
    status: 'registered' | 'failed' | 'pending';
    registeredAt: string | null;
    lastAttemptAt: string | null;
    error: string | null;
  }>;
  lastAttemptAt: string | null;
  /** What went wrong and what to do; null when nothing to report. */
  problem: string | null;
  /** Whether Register commands can be tried now. */
  canRegister: boolean;
  /** When CONDUIT will retry by itself (rate limits, outages), if scheduled. */
  nextRetryAt: string | null;
}

/** Developer Portal pages the desktop may open (allow-list; the renderer chooses only from these). */
export const DISCORD_PORTAL_PAGES = ['applications', 'oauth2', 'bot', 'installation'] as const;
export type DiscordPortalPage = (typeof DISCORD_PORTAL_PAGES)[number];

// ── bot permissions ─────────────────────────────────────────────────────────

/**
 * Channel permissions the bot needs to announce giveaways: see the channel and post (and later edit) its embed with the
 * entry buttons. Button clicks are interactions and need no permission. Never Administrator.
 */
export const GIVEAWAY_CHANNEL_PERMISSIONS = [
  { name: 'View Channel', bit: 1n << 10n },
  { name: 'Send Messages', bit: 1n << 11n },
  { name: 'Embed Links', bit: 1n << 14n },
] as const;

// The add-bot permissions live in a zod-free module (the Dashboard shows them at startup).
export { BOT_INSTALL_PERMISSIONS, DISCORD_INSTALL_PERMISSIONS } from './discord-permissions';
