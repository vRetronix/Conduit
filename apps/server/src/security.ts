import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { hostnameFromHostHeader, isLoopbackHost, type ApiError } from '@conduit/shared';

const forbidden = (message: string): ApiError => ({ error: { code: 'forbidden', message } });

/**
 * Rejects requests whose Host header is not a loopback name. This blocks DNS-rebinding attacks,
 * where a web page on attacker.example re-points its hostname at 127.0.0.1 to reach this API.
 * (Phase 2 will extend the allowlist with configured remote hostnames once auth exists.)
 */
export function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && isLoopbackHost(hostnameFromHostHeader(host));
}

export function hostGuard(): RequestHandler {
  return (req, res, next) => {
    if (isAllowedHost(req)) return next();
    res.status(403).json(forbidden('Host not allowed'));
  };
}

/**
 * Strict CORS: only the configured dashboard origins may make cross-origin calls.
 * Requests that carry a disallowed Origin are refused outright rather than merely left unreadable.
 * Requests without an Origin header (non-browser tools such as curl) pass through.
 */
export function corsGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (!allowed.has(origin)) {
      res.status(403).json(forbidden('Origin not allowed'));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  };
}
