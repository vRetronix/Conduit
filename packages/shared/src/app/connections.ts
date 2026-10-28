/**
 * Platform connections: the streamer's own platform accounts authorized for use by CONDUIT.
 *
 * Deliberately separate concepts:
 * - A platform connection (this module): an official authorization of the streamer's account on a platform.
 * - A bot identity (future "Bot Accounts"): the account CONDUIT speaks as in chat. Not implied by a connection.
 * - A Discord bot installation in a server: a separate grant. A Discord user connection never implies it.
 * - Permissions (chat, moderation, …): only what the platform actually granted, verified per capability.
 */
import { z } from 'zod';

export const PLATFORMS = ['discord', 'kick', 'youtube', 'twitch'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const platformSchema = z.enum(PLATFORMS);

export const PLATFORM_NAMES: Record<Platform, string> = {
  discord: 'Discord',
  kick: 'Kick',
  youtube: 'YouTube',
  twitch: 'Twitch',
};

/** Only two states are ever shown to the user. Problems are reported separately, never as "connected". */
export type ConnectionStatus = 'connected' | 'not_connected';

export interface ConnectedAccount {
  /** The platform's stable account id. */
  id: string;
  /** Display name (e.g. Discord global name, falling back to the username). */
  name: string;
  /** Unique handle when it differs from the display name (e.g. Discord username). */
  handle: string | null;
  /** Small avatar as a data: URL, fetched by the backend (the renderer loads no remote images). */
  avatarDataUrl: string | null;
}

/** Outcome of the most recent authorization attempt that did not succeed (cleared on success or a new attempt). */
export interface FailedAttempt {
  outcome: 'cancelled' | 'failed';
  message: string;
  at: string;
}

export interface PlatformConnectionSummary {
  platform: Platform;
  name: string;
  status: ConnectionStatus;
  /** The authorized account, only when the connection is verified. */
  account: ConnectedAccount | null;
  /** Further connected accounts on the same platform, if any. */
  additionalAccounts: number;
  /** Whether CONDUIT can start an authorization for this platform right now. */
  authorizationAvailable: boolean;
  /** When authorization is unavailable: why, and what to do about it. */
  unavailableReason: string | null;
  /** An authorization was started and CONDUIT is waiting for the browser to return. */
  pending: boolean;
  lastAttempt: FailedAttempt | null;
  /** Why the platform is not usable, e.g. an expired authorization. Null when there is nothing to report. */
  problem: string | null;
  lastVerifiedAt: string | null;
}

export interface DisconnectResult {
  /** Whether the platform confirmed revocation of CONDUIT's access. Local credentials are removed either way. */
  revokedAtPlatform: boolean;
  message: string | null;
}
