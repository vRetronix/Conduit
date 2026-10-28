/**
 * Receives OAuth redirects from the user's browser.
 *
 * - A separate listener from the API, bound to 127.0.0.1 only, and open only while an authorization is pending.
 * - Accepts only GET /oauth/<platform>/callback with a loopback Host header; everything else is 404/405.
 * - It cannot require the local access key (the browser makes the request), so it is protected instead by the
 *   single-use, 256-bit `state` of an authorization CONDUIT itself started. Unknown states are rejected before
 *   any code is used.
 * - The query string (which carries the code) is never logged; pages send no-referrer and load nothing external.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@conduit/logger';
import { hostnameFromHostHeader, isLoopbackHost, PLATFORMS, type Platform } from '@conduit/shared';

export interface CallbackPage {
  status: number;
  title: string;
  message: string;
}

export type CallbackHandler = (platform: Platform, params: URLSearchParams) => Promise<CallbackPage>;

const PATH = new RegExp(`^/oauth/(${PLATFORMS.join('|')})/callback$`);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderPage(page: CallbackPage): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(page.title)} · CONDUIT</title>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e6e8ef;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:460px;padding:28px;border:1px solid #2a2f40;border-radius:14px;background:#171a23}h1{font-size:20px;margin:0 0 8px}p{color:#8b91a5;line-height:1.5}</style>
</head><body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p><p>You can close this tab and return to CONDUIT.</p></main></body></html>`;
}

export class OAuthCallbackServer {
  private server: http.Server | null = null;
  /** Companion listener on the IPv6 loopback (::1), when available. */
  private server6: http.Server | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly o: {
      port: number;
      logger: Logger;
      handler: CallbackHandler;
      /** Called once a response has been fully sent (e.g. to close the listener when nothing is pending). */
      afterResponse?: () => void;
    },
  ) {}

  /** The loopback redirect URI for a platform. Kick documents `localhost` for local apps; others use 127.0.0.1. */
  redirectUri(platform: Platform, host: 'localhost' | '127.0.0.1' = '127.0.0.1'): string {
    return `http://${host}:${this.o.port}/oauth/${platform}/callback`;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** The bound port (equals the configured port; exposed for tests). */
  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.o.port;
  }

  ensureListening(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.starting = null;
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `The OAuth callback port ${this.o.port} is in use by another program. Close it, or set CONDUIT_OAUTH_CALLBACK_PORT and register the matching redirect URI.`
              : `Could not open the OAuth callback listener: ${err.message}`,
          ),
        );
      });
      server.listen(this.o.port, '127.0.0.1', () => {
        this.server = server;
        this.starting = null;
        this.o.logger.info('oauth callback listener open', { port: this.port });
        this.listenIpv6Loopback();
        resolve();
      });
    });
    return this.starting;
  }

  /**
   * A browser may resolve `localhost` to the IPv6 loopback (::1) first. Answer there too (still loopback only).
   * Best effort: without IPv6 the browser falls back to 127.0.0.1.
   */
  private listenIpv6Loopback(): void {
    const v6 = http.createServer((req, res) => void this.handle(req, res));
    v6.headersTimeout = 10_000;
    v6.requestTimeout = 15_000;
    v6.once('error', () => undefined);
    v6.listen({ port: this.o.port, host: '::1', ipv6Only: true }, () => {
      if (this.server) this.server6 = v6;
      else v6.close();
    });
  }

  async close(): Promise<void> {
    const v6 = this.server6;
    this.server6 = null;
    if (v6) {
      v6.closeAllConnections();
      await new Promise<void>((resolve) => v6.close(() => resolve()));
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.o.logger.info('oauth callback listener closed');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (page: CallbackPage) => {
      // Only after the page has reached the browser may the listener be closed.
      res.once('finish', () => this.o.afterResponse?.());
      res.writeHead(page.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      });
      res.end(renderPage(page));
    };

    const host = req.headers.host;
    if (typeof host !== 'string' || !isLoopbackHost(hostnameFromHostHeader(host))) {
      return send({ status: 403, title: 'Not allowed', message: 'This address only accepts requests made on this computer.' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = PATH.exec(url.pathname);
    if (!match) return send({ status: 404, title: 'Not found', message: 'This is CONDUIT\'s sign-in return address.' });
    if (req.method !== 'GET') return send({ status: 405, title: 'Not allowed', message: 'Unsupported request.' });

    const platform = match[1] as Platform;
    try {
      send(await this.o.handler(platform, url.searchParams));
    } catch (err) {
      this.o.logger.error('oauth callback failed', { platform, err });
      send({ status: 500, title: 'Something went wrong', message: 'CONDUIT could not finish connecting. Return to CONDUIT and try again.' });
    }
  }
}
