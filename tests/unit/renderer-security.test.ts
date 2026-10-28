import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  isPermissionAllowed,
  isTrustedRendererUrl,
  resolveRendererPath,
} from '../../apps/desktop/src/renderer-security';

const root = path.resolve('/app/renderer');

describe('resolveRendererPath', () => {
  it('serves files inside the renderer root', () => {
    expect(resolveRendererPath(root, '/assets/index-abc.js')).toBe(path.join(root, 'assets', 'index-abc.js'));
    expect(resolveRendererPath(root, '/index.html')).toBe(path.join(root, 'index.html'));
  });

  it('falls back to index.html for routes', () => {
    expect(resolveRendererPath(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveRendererPath(root, '/settings/logs')).toBe(path.join(root, 'index.html'));
  });

  it.each(['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5c..%5csecret.txt', '/a%00.js', '/%E0%A4%A'])(
    'blocks traversal and malformed path %s',
    (p) => {
      const resolved = resolveRendererPath(root, p);
      if (resolved !== null) expect(resolved.startsWith(root + path.sep)).toBe(true);
      if (p.includes('secret')) expect(resolved).toBeNull();
    },
  );
});

describe('buildContentSecurityPolicy', () => {
  it('is strict in production: no inline code and no network access from the renderer', () => {
    const csp = buildContentSecurityPolicy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe');
    expect(csp).not.toContain('127.0.0.1');
  });

  it('allows only the dev server (for HMR) in development', () => {
    const csp = buildContentSecurityPolicy({ devServerOrigin: 'http://127.0.0.1:5173' });
    expect(csp).toContain('connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173');
    expect(csp).not.toContain('47820');
  });
});

describe('isTrustedRendererUrl', () => {
  it('trusts only the app origin and configured dev server', () => {
    expect(isTrustedRendererUrl('app://conduit/index.html')).toBe(true);
    expect(isTrustedRendererUrl('app://other/index.html')).toBe(false);
    expect(isTrustedRendererUrl('https://evil.example/')).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/')).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:5173')).toBe(true);
    expect(isTrustedRendererUrl(undefined)).toBe(false);
    expect(isTrustedRendererUrl('not a url')).toBe(false);
  });
});

describe('isPermissionAllowed (Electron permission handlers)', () => {
  const dev = 'http://localhost:5173';

  it("allows only clipboard writes, only from CONDUIT's own page", () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', 'app://conduit/index.html')).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', 'app://conduit')).toBe(true); // permission checks pass an origin
    expect(isPermissionAllowed('clipboard-sanitized-write', `${dev}/`, dev)).toBe(true);
  });

  it.each(['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'fullscreen', 'midi'])('denies %s', (permission) => {
    expect(isPermissionAllowed(permission, 'app://conduit/index.html', dev)).toBe(false);
  });

  it.each([['https://evil.example/'], ['http://localhost:5173/'], ['app://other/'], [undefined]])('denies clipboard writes from %s', (url) => {
    expect(isPermissionAllowed('clipboard-sanitized-write', url)).toBe(false);
  });
});
