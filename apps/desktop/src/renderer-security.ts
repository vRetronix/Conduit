/**
 * Pure helpers for serving and locking down the renderer. Kept free of Electron imports so they
 * can be unit-tested.
 */
import path from 'node:path';
import { APP_HOST, APP_PROTOCOL } from '@conduit/shared/app/net';

/**
 * Maps an app:// request path to a file under `root`, or null if it would escape `root`.
 * Paths without a file extension fall back to index.html (single-page app routing).
 */
export function resolveRendererPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^[/\\]+/, '');
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative === '' || path.extname(relative) === '' ? 'index.html' : relative);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) return null;
  return target;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface CspOptions {
  /** Vite dev server origin; enables the inline script/style and HMR connection allowances Vite needs. */
  devServerOrigin?: string;
}

/**
 * The renderer has no network access of its own (connect-src 'none'): backend calls go through the main
 * process, which holds the session token. Even injected script cannot reach the API or exfiltrate data.
 */
export function buildContentSecurityPolicy({ devServerOrigin }: CspOptions = {}): string {
  const devWs = devServerOrigin?.replace(/^http/, 'ws');
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...(devServerOrigin ? ["'unsafe-inline'"] : [])],
    'style-src': ["'self'", ...(devServerOrigin ? ["'unsafe-inline'"] : [])],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': devServerOrigin && devWs ? [devServerOrigin, devWs] : ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** True if `url` belongs to the CONDUIT renderer (packaged app:// origin or the dev server). */
export function isTrustedRendererUrl(url: string | undefined, devServerOrigin?: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_PROTOCOL}:` && parsed.host === APP_HOST) return true;
  return devServerOrigin !== undefined && parsed.origin === devServerOrigin;
}

/** The only browser permission the dashboard gets: writing text to the clipboard (Copy buttons). Never reading it. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * Permission requests and checks: allowed only for the allow-listed permission, and only when it comes from
 * CONDUIT's own renderer. Everything else (camera, microphone, notifications, clipboard read, …) is denied.
 */
export function isPermissionAllowed(permission: string, requestingUrl: string | undefined, devServerOrigin?: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isTrustedRendererUrl(requestingUrl, devServerOrigin);
}
