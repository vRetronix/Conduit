import { Router } from 'express';
import type { Services } from '../services';

/**
 * Discord → Loyalty & Rewards. Protected by the local access key (applied in app.ts), like every /api
 * route. Searches and history use POST bodies (the desktop's API allow-list has no query strings). Everything is
 * validated by the service (shared schemas) before it is saved.
 */
export function createLoyaltyRouter(services: Services): Router {
  const { loyalty } = services;
  const router = Router();

  router.get('/loyalty', async (_req, res) => {
    res.json(await loyalty.state());
  });
  router.post('/loyalty/settings', async (req, res) => {
    res.json(await loyalty.saveSettings(req.body));
  });

  // Members: the leaderboard (per server, by XP or points), one member's history, and adjustments with a reason.
  router.post('/loyalty/members/query', async (req, res) => {
    res.json(await loyalty.members(req.body));
  });
  router.post('/loyalty/members/history', (req, res) => {
    res.json(loyalty.history(req.body));
  });
  router.post('/loyalty/members/points', (req, res) => {
    res.json(loyalty.adjustPoints(req.body));
  });
  router.post('/loyalty/members/xp', (req, res) => {
    res.json(loyalty.adjustXp(req.body));
  });

  // Level-up role rewards: the roles the bot can give, and the milestones. Removing one never takes roles away.
  router.get('/loyalty/roles', async (_req, res) => {
    res.json(await loyalty.roleOptions());
  });
  router.post('/loyalty/role-rewards', async (req, res) => {
    res.status(201).json(await loyalty.addRoleReward(req.body));
  });
  router.delete('/loyalty/role-rewards/:id', (req, res) => {
    res.json(loyalty.removeRoleReward(req.params.id));
  });

  // Reward catalog. DELETE archives the reward (its redemption history stays).
  router.post('/loyalty/rewards', (req, res) => {
    res.status(201).json(loyalty.createReward(req.body));
  });
  router.patch('/loyalty/rewards/:id', (req, res) => {
    res.json(loyalty.updateReward(req.params.id, req.body));
  });
  router.delete('/loyalty/rewards/:id', (req, res) => {
    res.json(loyalty.removeReward(req.params.id));
  });

  // Redemptions: fulfil, or reject (points are given back exactly once).
  router.post('/loyalty/redemptions/:id/fulfill', (req, res) => {
    res.json(loyalty.fulfill(req.params.id, req.body));
  });
  router.post('/loyalty/redemptions/:id/reject', (req, res) => {
    res.json(loyalty.reject(req.params.id, req.body));
  });

  return router;
}
