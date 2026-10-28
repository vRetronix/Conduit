import { Router } from 'express';
import type { Services } from '../services';

/**
 * /api/giveaways — giveaway management for the desktop dashboard. Protected by the local access key (applied in
 * app.ts), like every /api route: only the desktop app that launched the backend can manage giveaways. Chat users can
 * only enter, through !enter (Kick) and 🎉 reactions on the announcement (Discord).
 */
export function createGiveawayRouter(services: Services): Router {
  const { giveaways } = services;
  const router = Router();

  router.get('/giveaways', async (_req, res) => {
    res.json(await giveaways.state());
  });

  // Start Giveaway: validates everything, then the giveaway is running (there are no drafts).
  router.post('/giveaways', async (req, res) => {
    res.status(201).json(await giveaways.createAndStart(req.body));
  });

  router.patch('/giveaways/:id', (req, res) => {
    res.json(giveaways.update(req.params.id, req.body));
  });

  // Text channels the bot could announce in, with the permissions it lacks in each.
  // The Kick chat messages: checked, then saved; nothing is sent when saving.
  router.post('/giveaways/kick-messages', async (req, res) => {
    res.json(await giveaways.setKickMessages(req.body));
  });

  router.get('/giveaways/discord/channels', async (_req, res) => {
    res.json(await giveaways.discordChannels());
  });

  // Starts a draft left by an earlier version.
  router.post('/giveaways/:id/start', async (req, res) => {
    res.json(await giveaways.startAndAnnounce(req.params.id));
  });

  // Posts the Discord announcement if it isn't up (or was deleted), otherwise updates it.
  router.post('/giveaways/:id/discord/retry', async (req, res) => {
    res.json(await giveaways.retryDiscord(req.params.id));
  });

  router.post('/giveaways/:id/end', (req, res) => {
    res.json(giveaways.end(req.params.id));
  });

  // A completed giveaway is deleted with everything that belongs to it (its Discord post stays).
  router.delete('/giveaways/:id', (req, res) => {
    res.json(giveaways.deleteCompleted(req.params.id));
  });

  // Cancel deletes the giveaway and everything that belongs to it.
  router.post('/giveaways/:id/cancel', async (req, res) => {
    res.json(await giveaways.cancel(req.params.id));
  });

  router.post('/giveaways/:id/draw', (req, res) => {
    res.json(giveaways.draw(req.params.id));
  });

  router.post('/giveaways/:id/redraw', (req, res) => {
    res.json(giveaways.redraw(req.params.id, req.body));
  });

  return router;
}
