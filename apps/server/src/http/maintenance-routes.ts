import { Router } from 'express';
import type { Services } from '../services';

/**
 * Settings → Appearance & Themes, Backup & Restore, and Logs. Protected by the local access key (applied in app.ts), like every /api route.
 * Backups are named by file name only (never a path), and only files in the configured backup folder are used.
 */
export function createMaintenanceRouter(services: Services): Router {
  const { backups, logs, appearance } = services;
  const router = Router();

  router.get('/appearance', (_req, res) => {
    res.json(appearance.get());
  });
  router.post('/appearance', (req, res) => {
    res.json(appearance.save(req.body));
  });

  router.get('/backups', (_req, res) => {
    res.json(backups.state());
  });
  router.patch('/backups/settings', (req, res) => {
    res.json(backups.updateSettings(req.body));
  });
  router.post('/backups', (_req, res) => {
    res.status(201).json(backups.backupNow());
  });
  router.post('/backups/verify', (req, res) => {
    res.json(backups.verify(req.body));
  });
  router.post('/backups/restore', (req, res) => {
    res.status(202).json(backups.restore(req.body));
  });

  // A query in the body (POST), so filters don't have to be squeezed into a URL.
  router.post('/logs/query', (req, res) => {
    res.json(logs.query(req.body));
  });

  return router;
}
