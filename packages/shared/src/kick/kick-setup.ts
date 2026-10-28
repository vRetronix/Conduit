/**
 * Kick connection contracts. Each user brings their own Kick developer app (Client ID + Client Secret; there is no
 * shared CONDUIT app). The streamer's own account is the primary account (their channel). The chatbot can use that
 * account, or an optional separate Kick account authorized for that role. Secrets and tokens are never part of these
 * shapes.
 */
import { z } from 'zod';

export const CONNECTION_ROLES = ['primary', 'bot'] as const;
export type ConnectionRoleName = (typeof CONNECTION_ROLES)[number];
export const connectionRoleSchema = z.enum(CONNECTION_ROLES);

/** Kick Client IDs are opaque strings (letters and digits); be strict about shape but not length specifics. */
export const saveKickApplicationSchema = z.strictObject({
  clientId: z
    .string()
    .trim()
    .min(8, 'This looks too short for a Kick Client ID')
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'A Client ID contains only letters, numbers, dashes and underscores'),
  clientSecret: z
    .string()
    .trim()
    .min(16, 'This looks too short for a Kick Client Secret')
    .max(256)
    .regex(/^\S+$/, 'A Client Secret contains no spaces')
    .optional(),
});
export type SaveKickApplicationRequest = z.input<typeof saveKickApplicationSchema>;

export const KICK_CHATBOT_MODES = ['primary', 'separate'] as const;
export type KickChatbotMode = (typeof KICK_CHATBOT_MODES)[number];
export const setKickChatbotSchema = z.strictObject({ mode: z.enum(KICK_CHATBOT_MODES) });

export interface KickAccountState {
  /** Verified by Kick for a connected account; null before the first connection. */
  status: 'connected' | 'not_connected' | 'needs_reauth';
  userId: string | null;
  name: string | null;
  /** The channel slug (kick.com/<slug>) when known. */
  handle: string | null;
  avatarDataUrl: string | null;
  /** Kick scopes this authorization actually has. */
  scopes: string[];
  /** Waiting for the user to approve in their browser. */
  pending: boolean;
  /** Why it isn't usable (expired, revoked, last attempt failed), with what to do. */
  problem: string | null;
  lastVerifiedAt: string | null;
}

/** A chat message Kick delivered (chat.message.sent v1), reduced to what the UI shows. Kept in memory only. */
export interface KickChatMessageView {
  messageId: string;
  content: string;
  senderUserId: string;
  senderUsername: string;
  /** Hex colour from the sender's chat identity, when Kick sent one. */
  senderColor: string | null;
  badges: string[];
  createdAt: string | null;
  receivedAt: string;
}

export type KickChatReceiveStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'permission_required';

export interface KickChatState {
  receive: {
    /**
     * connected: Kick confirmed the chat.message.sent subscription for the channel and the local webhook receiver is
     * open. Whether Kick can reach it through your tunnel is shown by `delivery`.
     */
    status: KickChatReceiveStatus;
    /** 'confirmed' once a correctly signed message from Kick has arrived; until then the tunnel is unproven. */
    delivery: 'unconfirmed' | 'confirmed';
    problem: string | null;
    /** Where your tunnel must forward to (this PC only), and the path to append to the tunnel's public URL. */
    localTarget: string;
    webhookPath: string;
    lastEventAt: string | null;
    messagesReceived: number;
    /** Signed deliveries that failed verification since start (forged, stale or malformed). */
    rejected: number;
    nextRetryAt: string | null;
  };
  send: {
    /** The account messages are sent as (the chatbot selection), or null if it isn't connected. */
    account: 'primary' | 'bot' | null;
    accountName: string | null;
    /** The channel messages go to: always the main account's channel. */
    channel: string | null;
    ready: boolean;
    /** Kick scope the sending account still needs (re-authorize to grant it). */
    missingScope: string | null;
    problem: string | null;
  };
  /** The most recent messages received this session (newest last). Not stored on disk. */
  recent: KickChatMessageView[];
}

/** Kick counts up to 500 characters (grapheme clusters) and at most 2048 UTF-8 bytes. */
export const KICK_CHAT_MAX_CHARS = 500;
export const KICK_CHAT_MAX_BYTES = 2048;
export const sendKickChatSchema = z.strictObject({
  content: z
    .string()
    .trim()
    .min(1, 'Type a message first')
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Messages are a single line of text')
    .refine((s) => [...new Intl.Segmenter().segment(s)].length <= KICK_CHAT_MAX_CHARS, `Kick allows up to ${KICK_CHAT_MAX_CHARS} characters`)
    .refine((s) => new TextEncoder().encode(s).length <= KICK_CHAT_MAX_BYTES, 'This message is too long for Kick'),
});

export interface KickSendResult {
  sent: true;
  messageId: string | null;
  as: string;
  channel: string;
}

export interface KickSetupState {
  application: {
    configured: boolean;
    clientId: string | null;
    clientSecretStored: boolean;
  };
  /** The streamer's own account: their channel. */
  primary: KickAccountState;
  /** Optional separate account for chatbot duties. */
  bot: KickAccountState;
  chatbot: {
    /** The user's choice. */
    mode: KickChatbotMode;
    /** Which connected account currently fills the chatbot role, if any. */
    account: 'primary' | 'bot' | null;
    /** Whether that account can send chat messages now (connected and granted chat:write). */
    ready: boolean;
    note: string;
  };
  /** The redirect URI to register in the Kick app settings (exactly). */
  redirectUri: string;
  /** Scopes CONDUIT requests, per role (they depend on which account the chatbot uses). */
  scopes: Record<ConnectionRoleName, string[]>;
  chat: KickChatState;
}
