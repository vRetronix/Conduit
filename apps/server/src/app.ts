import express, { type ErrorRequestHandler } from 'express';
import { getSchemaVersion, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { HashingBusyError } from '@conduit/security';
import type { ApiError, HealthResponse, ServerConfig } from '@conduit/shared';
import { AppError } from './errors';
import { createConnectionRouter } from './http/connection-routes';
import { createGiveawayRouter } from './http/giveaway-routes';
import { createModerationRouter } from './http/moderation-routes';
import { createFeatureRouter } from './http/feature-routes';
import { createLoyaltyRouter } from './http/loyalty-routes';
import { createMaintenanceRouter } from './http/maintenance-routes';
import { requireLocalKey } from './http/local-access';
import { createApiRouter } from './http/routes';
import { corsGuard, hostGuard, securityHeaders } from './security';
import type { Services } from './services';

export interface AppContext {
  config: ServerConfig;
  db: Database;
  logger: Logger;
  version: string;
  startedAt: Date;
  services: Services;
  /** Required on every /api request except health, and on WebSocket upgrades (see http/local-access.ts). */
  localKey: string;
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(hostGuard());
  app.use(securityHeaders());
  app.use(corsGuard(ctx.config.allowedOrigins));
  app.use(express.json({ limit: '100kb' }));

  // Operational liveness probe: unauthenticated by design, and reveals nothing about accounts.
  app.get('/api/health', (_req, res) => {
    let database: HealthResponse['database'];
    try {
      // Cheap liveness probe; the full integrity check runs at startup (see main.ts).
      ctx.db.prepare('SELECT 1').get();
      database = { ok: true, schemaVersion: getSchemaVersion(ctx.db) };
    } catch (err) {
      ctx.logger.error('health check database probe failed', { err });
      database = { ok: false, schemaVersion: 0 };
    }
    const body: HealthResponse = {
      status: database.ok ? 'ok' : 'degraded',
      version: ctx.version,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
      database,
    };
    res.status(database.ok ? 200 : 503).json(body);
  });

  // Everything else under /api requires the local access key held only by the desktop app that launched us.
  app.use('/api', requireLocalKey(ctx.localKey));
  app.use('/api', createConnectionRouter(ctx.services));
  app.use('/api', createGiveawayRouter(ctx.services));
  app.use('/api', createModerationRouter(ctx.services));
  app.use('/api', createFeatureRouter(ctx.services));
  app.use('/api', createLoyaltyRouter(ctx.services));
  app.use('/api', createMaintenanceRouter(ctx.services));
  // Account API (dormant on the desktop since Phase 2.3): additionally requires a CONDUIT session.
  app.use('/api', createApiRouter(ctx.services));

  app.use((_req, res) => {
    const body: ApiError = { error: { code: 'not_found', message: 'Not found' } };
    res.status(404).json(body);
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.options.retryAfterSeconds) res.setHeader('Retry-After', String(err.options.retryAfterSeconds));
      res.status(err.status).json({ error: err.toBody() } satisfies ApiError);
      return;
    }
    if (err instanceof HashingBusyError) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: { code: 'service_unavailable', message: 'Server is busy, try again shortly' } } satisfies ApiError);
      return;
    }
    // body-parser errors (malformed JSON, oversized body) carry a 4xx status.
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) {
      ctx.logger.error('unhandled request error', { err, method: req.method, path: req.path });
      res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } } satisfies ApiError);
      return;
    }
    const message = err?.type === 'entity.parse.failed' ? 'Malformed JSON body' : err?.type === 'entity.too.large' ? 'Request body too large' : 'Bad request';
    res.status(status).json({ error: { code: 'bad_request', message } } satisfies ApiError);
  };
  app.use(onError);

  return app;
}
