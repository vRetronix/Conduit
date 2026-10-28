import { Router } from 'express';
import { AppError } from '../errors';
import type { Services } from '../services';

/** An Embed Creator message id (CONDUIT's own, a UUID). */
function messageId(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new AppError('bad_request', 'Invalid id');
  return value;
}

/**
 * Timed Messages, Sticky Messages, Stream Notifications, Discord Logging and the embed library. Protected by the local
 * access key (applied in app.ts), like every /api route. Everything is validated by the services (shared schemas)
 * before it's saved or sent.
 */
export function createFeatureRouter(services: Services): Router {
  const { timedMessages, stickies, notifications, logging, embeds, alerts, clips } = services;
  const router = Router();

  // ── Pop-up alerts (POST: the desktop allow-list has no query strings) ──
  router.post('/alerts/query', (req, res) => {
    res.json(alerts.query(req.body));
  });

  // ── Timed Messages ──
  router.get('/timed-messages', async (_req, res) => {
    res.json(await timedMessages.state());
  });
  router.post('/timed-messages', (req, res) => {
    res.status(201).json(timedMessages.create(req.body));
  });
  router.patch('/timed-messages/:id', (req, res) => {
    res.json(timedMessages.update(req.params.id, req.body));
  });
  router.post('/timed-messages/:id/duplicate', (req, res) => {
    res.status(201).json(timedMessages.duplicate(req.params.id));
  });
  router.delete('/timed-messages/:id', (req, res) => {
    res.json(timedMessages.delete(req.params.id));
  });

  // ── Kick Clips ──
  router.get('/kick/clips', async (_req, res) => {
    res.json(await clips.state());
  });
  router.post('/kick/clips', async (req, res) => {
    res.json(await clips.saveSettings(req.body));
  });
  router.post('/kick/clips/refresh', async (_req, res) => {
    res.json(await clips.refresh());
  });
  router.post('/kick/clips/:id/post', async (req, res) => {
    res.json(await clips.post(req.params.id));
  });
  router.post('/kick/clips/:id/save', async (req, res) => {
    res.json(await clips.save(req.params.id));
  });

  // ── Discord Sticky Messages ──
  router.get('/discord/stickies', async (_req, res) => {
    res.json(await stickies.state());
  });
  router.post('/discord/stickies', async (req, res) => {
    res.status(201).json(await stickies.create(req.body));
  });
  router.patch('/discord/stickies/:id', async (req, res) => {
    res.json(await stickies.update(req.params.id, req.body));
  });
  router.delete('/discord/stickies/:id', async (req, res) => {
    res.json(await stickies.delete(req.params.id));
  });

  // ── Stream Notifications ──
  router.get('/notifications', async (_req, res) => {
    res.json(await notifications.state());
  });
  router.post('/notifications', async (req, res) => {
    res.status(201).json(await notifications.create(req.body));
  });
  // Checks every streamer now (also done every minute).
  router.post('/notifications/check', async (_req, res) => {
    await notifications.check();
    res.json(await notifications.state());
  });
  // Posts a test of a notification (not saved) with the streamer's real current data.
  router.post('/notifications/test', async (req, res) => {
    res.json(await notifications.test(req.body));
  });
  router.patch('/notifications/:id', async (req, res) => {
    res.json(await notifications.update(req.params.id, req.body));
  });
  router.delete('/notifications/:id', async (req, res) => {
    res.json(await notifications.delete(req.params.id));
  });

  // ── Discord Logging ──
  router.get('/discord/logging', async (_req, res) => {
    res.json(await logging.state());
  });
  router.post('/discord/logging', async (req, res) => {
    res.json(await logging.save(req.body));
  });

  // ── Embed library ──
  // ── Discord → Embed Creator ──
  router.get('/discord/messages', async (_req, res) => {
    res.json(await services.embedCreator.list());
  });
  router.post('/discord/messages', async (req, res) => {
    res.status(201).json(await services.embedCreator.send(req.body));
  });
  router.post('/discord/messages/load', async (req, res) => {
    res.json(await services.embedCreator.load(req.body));
  });
  router.post('/discord/messages/recreate', async (req, res) => {
    res.status(201).json(await services.embedCreator.recreate(req.body));
  });
  router.patch('/discord/messages/:id', async (req, res) => {
    res.json(await services.embedCreator.update(messageId(req.params.id), req.body));
  });
  router.post('/discord/messages/:id/remove', async (req, res) => {
    await services.embedCreator.remove(messageId(req.params.id), (req.body as { fromDiscord?: unknown } | undefined)?.fromDiscord === true);
    res.status(204).end();
  });

  router.post('/discord/embeds/autosave', (req, res) => {
    res.json(embeds.autosave(req.body));
  });
  router.get('/discord/embeds', (_req, res) => {
    res.json(embeds.list());
  });
  router.post('/discord/embeds', (req, res) => {
    res.status(201).json(embeds.save(req.body));
  });
  router.post('/discord/embeds/test', async (req, res) => {
    res.json(await embeds.test(req.body));
  });
  router.patch('/discord/embeds/:id', (req, res) => {
    res.json(embeds.save(req.body, req.params.id));
  });
  router.delete('/discord/embeds/:id', (req, res) => {
    res.json(embeds.delete(req.params.id));
  });

  return router;
}
