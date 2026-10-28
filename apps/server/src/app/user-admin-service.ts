import crypto from 'node:crypto';
import { sessionsRepo, usersRepo, withTransaction, type Database } from '@conduit/database';
import type { PasswordHasher } from '@conduit/security';
import {
  adminCreateUserRequestSchema,
  adminResetPasswordRequestSchema,
  adminUpdateUserRequestSchema,
  type AdminUser,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { requireSystemPermission, type Principal } from '../authz';
import { conflict, forbidden, notFound } from '../errors';
import type { EventBus } from '../events';
import { parseInput } from '../validation';
import { toAdminUser } from './mappers';

/**
 * Instance-level account administration (system role "admin"). Grants no access to streamer profiles;
 * profile data is only reachable through membership.
 */
export class UserAdminService {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly events: EventBus,
    private readonly now: () => Date,
    /** Lets the auth service clear the account's failed-login lockout after a reset. */
    private readonly onPasswordReset: (username: string) => void = () => {},
  ) {}

  list(principal: Principal): AdminUser[] {
    requireSystemPermission(principal, 'users.manage');
    return usersRepo.list(this.db).map(toAdminUser);
  }

  /** Creates a local account with an initial password the admin passes on to its owner. */
  async create(principal: Principal, input: unknown): Promise<AdminUser> {
    requireSystemPermission(principal, 'users.manage');
    const data = parseInput(adminCreateUserRequestSchema, input);
    if (usersRepo.findByUsername(this.db, data.username)) throw conflict('That username is taken');
    const passwordHash = await this.hasher.hash(data.password);
    const now = this.now();
    return withTransaction(this.db, () => {
      requireSystemPermission(principal, 'users.manage');
      if (usersRepo.findByUsername(this.db, data.username)) throw conflict('That username is taken');
      const id = crypto.randomUUID();
      usersRepo.insert(this.db, { id, username: data.username, displayName: data.displayName, passwordHash, systemRole: 'user', now: now.toISOString() });
      writeAudit(this.db, { action: 'user.created', outcome: 'success', actorUserId: principal.user.id, targetUserId: id }, now);
      return toAdminUser(usersRepo.findById(this.db, id)!);
    });
  }

  /** Enables or disables an account. Disabling signs it out everywhere immediately. */
  setStatus(principal: Principal, userId: string, input: unknown): AdminUser {
    requireSystemPermission(principal, 'users.manage');
    const { status } = parseInput(adminUpdateUserRequestSchema, input);
    if (userId === principal.user.id) throw forbidden('You cannot change the status of your own account');
    const now = this.now();
    const { user, revoked } = withTransaction(this.db, () => {
      const target = usersRepo.findById(this.db, userId);
      if (!target) throw notFound('User');
      let revoked: string[] = [];
      if (target.status !== status) {
        const iso = now.toISOString();
        usersRepo.setStatus(this.db, userId, status, iso);
        if (status === 'disabled') revoked = sessionsRepo.revokeAllForUser(this.db, userId, 'account_disabled', iso);
        writeAudit(
          this.db,
          { action: 'user.status_changed', outcome: 'success', actorUserId: principal.user.id, targetUserId: userId, metadata: { from: target.status, to: status, sessionsRevoked: revoked.length } },
          now,
        );
      }
      return { user: usersRepo.findById(this.db, userId)!, revoked };
    });
    if (revoked.length > 0) this.events.emit('sessions.revoked', { sessionIds: revoked });
    return toAdminUser(user);
  }

  /**
   * Sets a new password for another account (e.g. a forgotten password) and signs it out everywhere.
   * Admins change their own password through the normal change-password flow, which requires the current one.
   */
  async resetPassword(principal: Principal, userId: string, input: unknown): Promise<void> {
    requireSystemPermission(principal, 'users.manage');
    const { password } = parseInput(adminResetPasswordRequestSchema, input);
    if (userId === principal.user.id) throw forbidden('Use "Change password" for your own account');
    const target = usersRepo.findById(this.db, userId);
    if (!target) throw notFound('User');
    const passwordHash = await this.hasher.hash(password);
    const now = this.now();
    const revoked = withTransaction(this.db, () => {
      requireSystemPermission(principal, 'users.manage');
      if (!usersRepo.findById(this.db, userId)) throw notFound('User');
      const iso = now.toISOString();
      usersRepo.setPasswordHash(this.db, userId, passwordHash, iso);
      const ids = sessionsRepo.revokeAllForUser(this.db, userId, 'password_reset', iso);
      writeAudit(
        this.db,
        { action: 'user.password_reset', outcome: 'success', actorUserId: principal.user.id, targetUserId: userId, metadata: { sessionsRevoked: ids.length } },
        now,
      );
      return ids;
    });
    this.onPasswordReset(target.username);
    if (revoked.length > 0) this.events.emit('sessions.revoked', { sessionIds: revoked });
  }

  /** Signs a user out of every session (the caller's current session is kept when targeting themselves). */
  revokeSessions(principal: Principal, userId: string): number {
    requireSystemPermission(principal, 'users.manage');
    const now = this.now();
    const revoked = withTransaction(this.db, () => {
      if (!usersRepo.findById(this.db, userId)) throw notFound('User');
      const keep = userId === principal.user.id ? principal.session.id : null;
      const ids = sessionsRepo.revokeAllForUser(this.db, userId, 'revoked_by_admin', now.toISOString(), keep);
      writeAudit(
        this.db,
        { action: 'user.sessions_revoked', outcome: 'success', actorUserId: principal.user.id, targetUserId: userId, metadata: { count: ids.length } },
        now,
      );
      return ids;
    });
    if (revoked.length > 0) this.events.emit('sessions.revoked', { sessionIds: revoked });
    return revoked.length;
  }
}
