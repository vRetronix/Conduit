import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { safeEqual } from '@conduit/security';
import { AppError } from '../errors';

/**
 * Local access key: the backend's gate now that the desktop has no CONDUIT sign-in.
 *
 * The desktop main process generates a random key per launch and passes it only to the backend process it starts.
 * Every /api request (except the health probe) and every WebSocket upgrade must carry it. Other programs and web
 * pages cannot obtain it: it is never sent to the renderer, written to disk or logged. Together with the loopback
 * binding and the Host/Origin checks, this keeps the API usable only by the desktop app that launched it.
 */
export const LOCAL_KEY_HEADER = 'x-conduit-local-key';

export function hasLocalKey(req: IncomingMessage, expected: string): boolean {
  const value = req.headers[LOCAL_KEY_HEADER];
  return typeof value === 'string' && safeEqual(value, expected);
}

export function requireLocalKey(expected: string): RequestHandler {
  return (req, _res, next) => {
    if (hasLocalKey(req, expected)) return next();
    next(new AppError('unauthorized', 'Local access key required'));
  };
}
