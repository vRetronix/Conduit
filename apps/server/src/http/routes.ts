import { Router, type Request } from 'express';
import { idSchema, type SetupStatusResponse } from '@conduit/shared';
import type { Services } from '../services';
import { parseInput } from '../validation';
import { clientName, principalOf, requireAuth, requireCurrentPassword } from './auth-middleware';

const id = (req: Request, name: string): string => parseInput(idSchema, req.params[name]);

/**
 * /api routes. Only the routes registered before `requireAuth` are public; everything after it —
 * including any route added later — requires a valid session (deny by default). Likewise only the three routes
 * before `requireCurrentPassword` are usable by an account with a pending forced password change.
 */
export function createApiRouter(services: Services): Router {
  const { auth, profiles, users } = services;
  const router = Router();

  // ── public ────────────────────────────────────────────────────────────────
  router.get('/setup/status', (_req, res) => {
    const body: SetupStatusResponse = { setupRequired: auth.isSetupRequired() };
    res.json(body);
  });

  router.post('/setup', async (req, res) => {
    const result = await auth.setup(req.body, req.get('x-setup-token'), clientName(req));
    res.status(201).json(result);
  });

  router.post('/auth/login', async (req, res) => {
    res.json(await auth.login(req.body, clientName(req)));
  });

  // ── authenticated, including accounts that must change their password ─────
  router.use(requireAuth(auth));

  router.get('/auth/session', (req, res) => {
    res.json(auth.current(principalOf(req)));
  });

  router.post('/auth/logout', (req, res) => {
    auth.logout(principalOf(req));
    res.status(204).end();
  });

  router.post('/me/password', async (req, res) => {
    await auth.changePassword(principalOf(req), req.body);
    res.status(204).end();
  });

  // ── everything else also requires that no password change is pending ──────
  router.use(requireCurrentPassword());

  router.get('/auth/sessions', (req, res) => {
    res.json(auth.listSessions(principalOf(req)));
  });

  router.delete('/auth/sessions/:sessionId', (req, res) => {
    auth.revokeOwnSession(principalOf(req), id(req, 'sessionId'));
    res.status(204).end();
  });

  router.get('/profiles', (req, res) => {
    res.json(profiles.list(principalOf(req)));
  });

  router.post('/profiles', (req, res) => {
    res.status(201).json(profiles.create(principalOf(req), req.body));
  });

  router.get('/profiles/:profileId', (req, res) => {
    res.json(profiles.get(principalOf(req), id(req, 'profileId')));
  });

  router.patch('/profiles/:profileId', (req, res) => {
    res.json(profiles.update(principalOf(req), id(req, 'profileId'), req.body));
  });

  router.get('/profiles/:profileId/members', (req, res) => {
    res.json(profiles.listMembers(principalOf(req), id(req, 'profileId')));
  });

  router.post('/profiles/:profileId/members', (req, res) => {
    res.status(201).json(profiles.addMember(principalOf(req), id(req, 'profileId'), req.body));
  });

  router.patch('/profiles/:profileId/members/:userId', (req, res) => {
    res.json(profiles.changeRole(principalOf(req), id(req, 'profileId'), id(req, 'userId'), req.body));
  });

  router.delete('/profiles/:profileId/members/:userId', (req, res) => {
    profiles.removeMember(principalOf(req), id(req, 'profileId'), id(req, 'userId'));
    res.status(204).end();
  });

  router.post('/profiles/:profileId/transfer-ownership', (req, res) => {
    res.json(profiles.transferOwnership(principalOf(req), id(req, 'profileId'), req.body));
  });

  router.get('/admin/users', (req, res) => {
    res.json(users.list(principalOf(req)));
  });

  router.post('/admin/users', async (req, res) => {
    res.status(201).json(await users.create(principalOf(req), req.body));
  });

  router.patch('/admin/users/:userId', (req, res) => {
    res.json(users.setStatus(principalOf(req), id(req, 'userId'), req.body));
  });

  router.post('/admin/users/:userId/password', async (req, res) => {
    await users.resetPassword(principalOf(req), id(req, 'userId'), req.body);
    res.status(204).end();
  });

  router.post('/admin/users/:userId/revoke-sessions', (req, res) => {
    res.json({ revoked: users.revokeSessions(principalOf(req), id(req, 'userId')) });
  });

  return router;
}
