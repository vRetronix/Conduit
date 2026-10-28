import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { profilesRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { clientMessageSchema, hasProfilePermission, WS_CLOSE, type ServerMessage } from '@conduit/shared';
import type { EventBus } from './events';
import { bearerToken } from './http/auth-middleware';
import { hasLocalKey } from './http/local-access';
import { isAllowedHost } from './security';
import type { AuthService } from './app/auth-service';

export const WS_PATH = '/ws';
const HEARTBEAT_MS = 30_000;
const MAX_INVALID_MESSAGES = 5;

export interface Realtime {
  clientCount(): number;
  close(): Promise<void>;
}

interface Connection {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  subscriptions: Set<string>;
  invalidMessages: number;
  alive: boolean;
}

function reject(socket: Duplex, status: 401 | 403 | 404, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Authenticated realtime endpoint.
 * - Upgrade requires a valid session (Authorization: Bearer) plus the loopback Host check. When an Origin
 *   header is present (any browser), it must be allow-listed; browsers cannot attach Authorization headers to
 *   WebSockets, so web pages cannot connect.
 * - Identity comes only from the session. Every profile subscription is authorized against current membership.
 * - Sessions are re-validated on every heartbeat and torn down immediately on revocation events; membership
 *   changes drop subscriptions that are no longer authorized.
 */
export function attachRealtime(
  server: Server,
  opts: {
    allowedOrigins: readonly string[];
    logger: Logger;
    version: string;
    auth: AuthService;
    db: Database;
    events: EventBus;
    localKey: string;
  },
): Realtime {
  const allowed = new Set(opts.allowedOrigins);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const connections = new Map<WebSocket, Connection>();

  const send = (conn: Connection, message: ServerMessage) => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  };

  const canRead = (conn: Connection, profileId: string) =>
    hasProfilePermission(profilesRepo.roleOf(opts.db, profileId, conn.userId), 'profile.read');

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== WS_PATH) return reject(socket, 404, 'Not Found');
    const origin = req.headers.origin;
    if (!isAllowedHost(req) || (origin !== undefined && !allowed.has(origin))) {
      opts.logger.warn('rejected websocket upgrade', { origin, host: req.headers.host });
      return reject(socket, 403, 'Forbidden');
    }
    if (!hasLocalKey(req, opts.localKey)) return reject(socket, 401, 'Unauthorized');
    const principal = opts.auth.authenticate(bearerToken(req));
    if (!principal) return reject(socket, 401, 'Unauthorized');
    // Realtime data is ordinary protected functionality: unavailable until a forced password change is done.
    if (principal.user.mustChangePassword) return reject(socket, 403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Connection = {
        ws,
        userId: principal.user.id,
        sessionId: principal.session.id,
        subscriptions: new Set(),
        invalidMessages: 0,
        alive: true,
      };
      connections.set(ws, conn);
      onConnection(conn);
    });
  };
  server.on('upgrade', onUpgrade);

  function onConnection(conn: Connection): void {
    opts.logger.debug('websocket client connected', { userId: conn.userId, clients: connections.size });
    conn.ws.on('pong', () => (conn.alive = true));
    conn.ws.on('error', (err) => opts.logger.debug('websocket client error', { err }));
    conn.ws.on('close', () => connections.delete(conn.ws));
    conn.ws.on('message', (data, isBinary) => onMessage(conn, isBinary ? null : String(data)));
    send(conn, { type: 'hello', version: opts.version, serverTime: new Date().toISOString(), userId: conn.userId });
  }

  function onMessage(conn: Connection, raw: string | null): void {
    // A message is only acted on if the session is still valid right now.
    const current = opts.auth.revalidate(conn.sessionId);
    if (!current || current.user.mustChangePassword) return conn.ws.close(WS_CLOSE.sessionInvalid, 'Session no longer valid');

    let json: unknown;
    try {
      json = raw === null ? undefined : JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      send(conn, { type: 'error', code: 'bad_request', message: 'Malformed or unsupported message' });
      if (++conn.invalidMessages >= MAX_INVALID_MESSAGES) conn.ws.close(WS_CLOSE.policyViolation, 'Too many invalid messages');
      return;
    }

    const msg = parsed.data;
    if (msg.type === 'subscribe') {
      if (!canRead(conn, msg.profileId)) {
        // Same answer for "no such profile" and "not a member".
        send(conn, { type: 'error', code: 'not_found', message: 'Profile not found' });
        return;
      }
      conn.subscriptions.add(msg.profileId);
      send(conn, { type: 'subscribed', profileId: msg.profileId });
    } else {
      conn.subscriptions.delete(msg.profileId);
      send(conn, { type: 'unsubscribed', profileId: msg.profileId, reason: 'requested' });
    }
  }

  const closeInvalid = (conn: Connection) => conn.ws.close(WS_CLOSE.sessionInvalid, 'Session no longer valid');

  const offRevoked = opts.events.on('sessions.revoked', ({ sessionIds }) => {
    const ids = new Set(sessionIds);
    for (const conn of connections.values()) if (ids.has(conn.sessionId)) closeInvalid(conn);
  });

  const offMembership = opts.events.on('membership.changed', ({ profileId, userIds }) => {
    const affected = new Set(userIds);
    for (const conn of connections.values()) {
      if (!conn.subscriptions.has(profileId)) continue;
      if (affected.has(conn.userId) && !canRead(conn, profileId)) {
        conn.subscriptions.delete(profileId);
        send(conn, { type: 'unsubscribed', profileId, reason: 'access_revoked' });
        continue;
      }
      send(conn, { type: 'members.changed', profileId });
    }
  });

  const offProfile = opts.events.on('profile.updated', ({ profileId }) => {
    for (const conn of connections.values()) if (conn.subscriptions.has(profileId)) send(conn, { type: 'profile.updated', profileId });
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!opts.auth.revalidate(conn.sessionId)) {
        closeInvalid(conn);
        continue;
      }
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    clientCount: () => connections.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        offRevoked();
        offMembership();
        offProfile();
        server.off('upgrade', onUpgrade);
        for (const ws of wss.clients) ws.close(WS_CLOSE.goingAway, 'Server shutting down');
        wss.close(() => resolve());
      }),
  };
}
