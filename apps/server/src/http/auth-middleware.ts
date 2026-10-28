import type { IncomingMessage } from 'node:http';
import type { Request, RequestHandler } from 'express';
import type { Principal } from '../authz';
import { AppError, unauthorized } from '../errors';
import type { AuthService } from '../app/auth-service';

const principals = new WeakMap<Request, Principal>();

/** Extracts a bearer token from the Authorization header. Tokens are never accepted from URLs or bodies. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  return match?.[1];
}

/** Rejects the request with 401 unless it carries a valid session for an active account. */
export function requireAuth(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const principal = auth.authenticate(bearerToken(req));
    if (!principal) return next(unauthorized());
    principals.set(req, principal);
    next();
  };
}

/**
 * Blocks everything for an account that must change its password. Routes registered before this middleware are
 * the only ones such an account can use (deny by default).
 */
export function requireCurrentPassword(): RequestHandler {
  return (req, _res, next) => {
    if (principalOf(req).user.mustChangePassword) {
      return next(new AppError('password_change_required', 'You must change your password before continuing'));
    }
    next();
  };
}

/** The authenticated caller. Throws if requireAuth did not run, so a misplaced route fails closed. */
export function principalOf(req: Request): Principal {
  const principal = principals.get(req);
  if (!principal) throw unauthorized();
  return principal;
}

/** A short, printable client label from the User-Agent header, stored with the session. */
export function clientName(req: Request): string | null {
  const ua = req.get('user-agent');
  if (!ua) return null;
  const clean = ua.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 100);
  return clean || null;
}
