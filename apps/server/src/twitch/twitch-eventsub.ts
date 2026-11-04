/**
 * One Twitch EventSub WebSocket session (https://dev.twitch.tv/docs/eventsub/handling-websocket-events/). Twitch
 * delivers events to it; CONDUIT never sends anything over the socket (Twitch closes it with 4001 if a client does).
 *
 * - session_welcome: the session id. Subscriptions must be created for it within 10 seconds (else close 4003).
 * - session_keepalive / notification: proof the connection is alive. If nothing arrives for keepalive_timeout_seconds
 *   (plus a margin), the connection is treated as dead and closed.
 * - session_reconnect: Twitch moves the session. A second socket opens on the given URL; once it welcomes, the old one
 *   is closed. Subscriptions carry over, so nothing is subscribed again.
 * - revocation: Twitch ended a subscription (e.g. the authorization was revoked).
 *
 * Notifications are de-duplicated by message id (Twitch may deliver one twice) and older than 10 minutes are dropped.
 */
import WebSocket from 'ws';
import type { Logger } from '@conduit/logger';

export const TWITCH_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const WELCOME_TIMEOUT_MS = 15_000;
const KEEPALIVE_MARGIN_MS = 10_000;
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const REMEMBERED_IDS = 1000;
const MAX_FRAME_BYTES = 256 * 1024;

export interface EventSubNotification {
  messageId: string;
  type: string;
  version: string;
  event: unknown;
}

export interface EventSubSessionOptions {
  logger: Logger;
  now: () => Date;
  /** Twitch's WebSocket URL (tests use a local one). */
  url?: string;
  onNotification: (n: EventSubNotification) => void;
  onRevocation: (type: string, status: string) => void;
  /** The session ended without close() being called. `code` is the WebSocket close code (Twitch's 4000–4007), if any. */
  onLost: (reason: { code: number | null; detail: string }) => void;
}

/** Thrown by open() when no welcome arrives. */
export class EventSubConnectError extends Error {}

export class TwitchEventSubSession {
  private socket: WebSocket | null = null;
  private keepaliveMs = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private closed = false;
  private sessionId: string | null = null;

  constructor(private readonly o: EventSubSessionOptions) {}

  get id(): string | null {
    return this.sessionId;
  }

  /** Connects and waits for Twitch's welcome. Resolves with the session id. */
  async open(): Promise<string> {
    const { socket, sessionId } = await this.connect(this.o.url ?? TWITCH_EVENTSUB_URL);
    this.adopt(socket, sessionId);
    return sessionId;
  }

  close(): void {
    this.closed = true;
    this.clearWatchdog();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.removeAllListeners('close');
      s.on('error', () => undefined);
      s.close(1000);
    }
  }

  /** Opens a socket and resolves once it has been welcomed (messages before the welcome are protocol errors). */
  private connect(url: string): Promise<{ socket: WebSocket; sessionId: string }> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: WELCOME_TIMEOUT_MS });
      } catch (err) {
        reject(new EventSubConnectError(err instanceof Error ? err.message : 'Could not open the connection'));
        return;
      }
      const timer = setTimeout(() => fail('Twitch didn’t start the chat session in time.'), WELCOME_TIMEOUT_MS);
      timer.unref();
      const fail = (detail: string) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.terminate();
        reject(new EventSubConnectError(detail));
      };
      socket.once('error', () => fail('Twitch couldn’t be reached.'));
      socket.once('close', (code) => fail(`Twitch closed the chat connection (${code}).`));
      socket.once('message', (raw) => {
        const msg = parse(raw);
        const session = msg?.payload?.session as { id?: unknown; keepalive_timeout_seconds?: unknown } | undefined;
        if (msg?.metadata?.message_type !== 'session_welcome' || typeof session?.id !== 'string' || !session.id) {
          return fail('Twitch sent an unexpected first message.');
        }
        clearTimeout(timer);
        socket.removeAllListeners();
        const keepalive = Number(session.keepalive_timeout_seconds);
        this.keepaliveMs = Number.isFinite(keepalive) && keepalive > 0 ? keepalive * 1000 : 10_000;
        resolve({ socket, sessionId: session.id });
      });
    });
  }

  /** Makes `socket` the live one (closing a previous socket after a reconnect). */
  private adopt(socket: WebSocket, sessionId: string): void {
    if (this.closed) {
      socket.on('error', () => undefined);
      socket.close(1000);
      return;
    }
    const previous = this.socket;
    this.socket = socket;
    this.sessionId = sessionId;
    if (previous) {
      previous.removeAllListeners();
      previous.on('error', () => undefined);
      previous.close(1000);
    }
    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      this.alive();
      this.handle(raw);
    });
    socket.on('error', (err) => this.o.logger.warn('twitch eventsub socket error', { detail: err.message }));
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.lost(code, `Twitch closed the chat connection (${code}).`);
    });
    this.alive();
  }

  private handle(raw: WebSocket.RawData): void {
    const msg = parse(raw);
    const meta = msg?.metadata;
    if (!meta || typeof meta.message_type !== 'string') return;
    switch (meta.message_type) {
      case 'session_keepalive':
        return;
      case 'session_reconnect': {
        const url = (msg.payload?.session as { reconnect_url?: unknown } | undefined)?.reconnect_url;
        if (typeof url !== 'string' || !this.allowedReconnect(url)) return;
        this.o.logger.info('twitch eventsub reconnect requested');
        void this.connect(url)
          .then(({ socket, sessionId }) => this.adopt(socket, sessionId))
          .catch((err) => this.lost(null, err instanceof Error ? err.message : 'The chat connection couldn’t move.'));
        return;
      }
      case 'notification': {
        const id = typeof meta.message_id === 'string' ? meta.message_id : null;
        const at = typeof meta.message_timestamp === 'string' ? Date.parse(meta.message_timestamp) : NaN;
        if (!id || this.seen.has(id)) return;
        if (Number.isFinite(at) && this.o.now().getTime() - at > MAX_MESSAGE_AGE_MS) return;
        this.seen.add(id);
        if (this.seen.size > REMEMBERED_IDS) this.seen.delete(this.seen.values().next().value!);
        const sub = msg.payload?.subscription as { type?: unknown; version?: unknown } | undefined;
        if (typeof sub?.type !== 'string') return;
        this.o.onNotification({ messageId: id, type: sub.type, version: typeof sub.version === 'string' ? sub.version : '', event: msg.payload?.event });
        return;
      }
      case 'revocation': {
        const sub = msg.payload?.subscription as { type?: unknown; status?: unknown } | undefined;
        this.o.onRevocation(typeof sub?.type === 'string' ? sub.type : 'unknown', typeof sub?.status === 'string' ? sub.status : 'unknown');
        return;
      }
      default:
        return;
    }
  }

  /** Reconnect URLs must be Twitch's own (wss on twitch.tv), or the configured server's (tests). */
  private allowedReconnect(raw: string): boolean {
    try {
      const u = new URL(raw);
      if (u.protocol === 'wss:' && (u.hostname === 'twitch.tv' || u.hostname.endsWith('.twitch.tv'))) return true;
      return this.o.url !== undefined && u.origin === new URL(this.o.url).origin;
    } catch {
      return false;
    }
  }

  private alive(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.o.logger.warn('twitch eventsub keepalive missed');
      this.lost(null, 'Twitch stopped sending keepalives.');
    }, this.keepaliveMs + KEEPALIVE_MARGIN_MS);
    this.watchdog.unref();
  }

  private lost(code: number | null, detail: string): void {
    if (this.closed) return;
    this.close();
    this.o.onLost({ code, detail });
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

interface EventSubMessage {
  metadata?: { message_id?: unknown; message_type?: unknown; message_timestamp?: unknown };
  payload?: { session?: unknown; subscription?: unknown; event?: unknown };
}

function parse(raw: WebSocket.RawData): EventSubMessage | null {
  try {
    const v = JSON.parse(raw.toString()) as unknown;
    return v && typeof v === 'object' ? (v as EventSubMessage) : null;
  } catch {
    return null;
  }
}
