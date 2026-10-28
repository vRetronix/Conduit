import crypto from 'node:crypto';
import {
  auditRepo,
  SETTING_KEYS,
  sessionsRepo,
  settingsRepo,
  usersRepo,
  withTransaction,
  type Database,
  type SessionRecord,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { FailureLimiter, generateToken, hashToken, isWellFormedToken, safeEqual, type PasswordHasher } from '@conduit/security';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  setupRequestSchema,
  type AuthResponse,
  type CurrentSessionResponse,
  type SessionInfo,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import type { Principal } from '../authz';
import { AppError, conflict, forbidden, notFound } from '../errors';
import type { EventBus } from '../events';
import { parseInput } from '../validation';
import { toCurrentUser, toSessionInfo } from './mappers';
import { insertProfile } from './profile-service';

export interface AuthServiceOptions {
  db: Database;
  hasher: PasswordHasher;
  events: EventBus;
  logger: Logger;
  now: () => Date;
  sessionTtlMs: number;
  sessionIdleMs: number;
  /** One-time secret required by first-run setup. */
  setupToken: string;
}

/** last_seen_at is written at most this often per session, keeping authenticated reads cheap. */
const TOUCH_INTERVAL_MS = 5 * 60_000;
/** Revoked/expired sessions are kept this long (for "recent sessions" context), then deleted. */
const STALE_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

const INVALID_CREDENTIALS = 'Invalid username or password';

/** Failed logins per username (whether or not it exists). */
const USER_LIMIT = { maxFailures: 5, windowMs: 15 * 60_000 };
/** Failed logins and setup-token attempts across all usernames. */
const GLOBAL_LIMIT = { maxFailures: 20, windowMs: 60_000 };

export class AuthService {
  readonly userLimiter: FailureLimiter;
  readonly globalLimiter: FailureLimiter;

  constructor(private readonly o: AuthServiceOptions) {
    const now = () => o.now().getTime();
    this.userLimiter = new FailureLimiter({ maxFailures: USER_LIMIT.maxFailures, windowMs: USER_LIMIT.windowMs, now });
    this.globalLimiter = new FailureLimiter({ maxFailures: GLOBAL_LIMIT.maxFailures, windowMs: GLOBAL_LIMIT.windowMs, now });
  }

  /**
   * Rebuilds the failed-login windows from the audit log, so restarting the backend (or crashing it) does not
   * reset lockouts. Per-account failures that predate the account's last successful login or password
   * change/reset/recovery are ignored, matching the in-memory behaviour. Failures for unknown usernames are not
   * attributable (their usernames are deliberately not stored) and count only toward the global window.
   */
  restoreFailureWindows(): void {
    const nowMs = this.o.now().getTime();
    const since = new Date(nowMs - Math.max(USER_LIMIT.windowMs, GLOBAL_LIMIT.windowMs)).toISOString();
    for (const row of auditRepo.recentLoginFailures(this.o.db, since)) {
      const at = Date.parse(row.occurredAt);
      this.globalLimiter.recordFailure('global', at);
      if (row.username && !row.clearedAfter) {
        this.userLimiter.recordFailure(`user:${row.username}`, at);
      }
    }
  }

  /** Clears an account's failed-login count (after an administrator sets a new password). */
  clearLoginFailures(username: string): void {
    this.userLimiter.reset(`user:${username}`);
  }

  // ── first-run setup ───────────────────────────────────────────────────────

  /** Authoritative first-run state: no setup record and no users. */
  isSetupRequired(): boolean {
    return settingsRepo.get(this.o.db, SETTING_KEYS.setupCompletedAt) === undefined && usersRepo.count(this.o.db) === 0;
  }

  async setup(input: unknown, providedSetupToken: string | undefined, clientName: string | null): Promise<AuthResponse> {
    if (!this.isSetupRequired()) throw conflict('Setup has already been completed.');
    this.enforceLimit(this.globalLimiter, 'global');
    if (!providedSetupToken || !safeEqual(providedSetupToken, this.o.setupToken)) {
      this.globalLimiter.recordFailure('global');
      throw forbidden('Invalid setup token');
    }
    const data = parseInput(setupRequestSchema, input);
    const passwordHash = await this.o.hasher.hash(data.password);
    const now = this.o.now();
    const iso = now.toISOString();

    try {
      return withTransaction(this.o.db, () => {
        // Re-checked inside the write transaction: concurrent setup requests serialize here, and the
        // app_settings primary key rejects a second setup even across processes.
        if (!this.isSetupRequired()) throw conflict('Setup has already been completed.');
        settingsRepo.insert(this.o.db, SETTING_KEYS.setupCompletedAt, iso, iso);

        const userId = crypto.randomUUID();
        usersRepo.insert(this.o.db, {
          id: userId,
          username: data.username,
          displayName: data.displayName,
          passwordHash,
          systemRole: 'admin',
          now: iso,
        });
        usersRepo.recordLogin(this.o.db, userId, iso);
        const profile = insertProfile(this.o.db, { ownerUserId: userId, displayName: data.profileDisplayName }, iso);
        const { token, session } = this.createSession(userId, clientName, now);

        writeAudit(this.o.db, { action: 'setup.completed', outcome: 'success', actorUserId: userId, targetUserId: userId }, now);
        writeAudit(this.o.db, { action: 'profile.created', outcome: 'success', actorUserId: userId, profileId: profile.id }, now);
        writeAudit(
          this.o.db,
          { action: 'auth.login', outcome: 'success', actorUserId: userId, sessionId: session.id, metadata: { via: 'setup' } },
          now,
        );

        const user = usersRepo.findById(this.o.db, userId)!;
        return { token, user: toCurrentUser(user), session: toSessionInfo(session, session.id) };
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isConstraintError(err)) throw conflict('Setup has already been completed.');
      throw err;
    }
  }

  // ── login / logout ────────────────────────────────────────────────────────

  async login(input: unknown, clientName: string | null): Promise<AuthResponse> {
    const { username, password } = parseInput(loginRequestSchema, input);
    const userKey = `user:${username}`;
    this.enforceLimit(this.globalLimiter, 'global');
    this.enforceLimit(this.userLimiter, userKey);

    const user = usersRepo.findByUsername(this.o.db, username);
    // Unknown usernames are verified against a dummy hash so both cases take the same time.
    const passwordOk = await this.o.hasher.verify(user?.passwordHash ?? (await this.o.hasher.dummyHash()), password);
    const now = this.o.now();

    if (!user || !passwordOk) {
      this.userLimiter.recordFailure(userKey);
      this.globalLimiter.recordFailure('global');
      // Unknown usernames are not recorded: people sometimes type a password into the username field.
      writeAudit(
        this.o.db,
        {
          action: 'auth.login',
          outcome: 'failure',
          targetUserId: user?.id ?? null,
          metadata: { reason: user ? 'invalid_password' : 'unknown_user' },
        },
        now,
      );
      throw new AppError('unauthorized', INVALID_CREDENTIALS);
    }

    if (user.status !== 'active') {
      // Only revealed after a correct password, so it does not help an attacker enumerate accounts.
      writeAudit(this.o.db, { action: 'auth.login', outcome: 'denied', targetUserId: user.id, metadata: { reason: 'account_disabled' } }, now);
      throw forbidden('This account is disabled.');
    }

    this.userLimiter.reset(userKey);
    // Upgrade hashes created with weaker parameters while the plaintext is available.
    const upgradedHash = this.o.hasher.needsRehash(user.passwordHash) ? await this.o.hasher.hash(password) : null;

    return withTransaction(this.o.db, () => {
      const iso = now.toISOString();
      if (upgradedHash) usersRepo.setPasswordHash(this.o.db, user.id, upgradedHash, iso);
      usersRepo.recordLogin(this.o.db, user.id, iso);
      const { token, session } = this.createSession(user.id, clientName, now);
      writeAudit(this.o.db, { action: 'auth.login', outcome: 'success', actorUserId: user.id, sessionId: session.id }, now);
      return { token, user: toCurrentUser(usersRepo.findById(this.o.db, user.id)!), session: toSessionInfo(session, session.id) };
    });
  }

  logout(principal: Principal): void {
    const now = this.o.now();
    withTransaction(this.o.db, () => {
      sessionsRepo.revoke(this.o.db, principal.session.id, 'logout', now.toISOString());
      writeAudit(this.o.db, { action: 'auth.logout', outcome: 'success', actorUserId: principal.user.id, sessionId: principal.session.id }, now);
    });
    this.o.events.emit('sessions.revoked', { sessionIds: [principal.session.id] });
  }

  // ── session validation ────────────────────────────────────────────────────

  /** Resolves a bearer token to its caller, or null if the token is unknown, revoked, expired or idle, or the account is disabled. */
  authenticate(token: string | undefined): Principal | null {
    if (!isWellFormedToken(token)) return null;
    const session = sessionsRepo.findByTokenHash(this.o.db, hashToken(token));
    return session ? this.validate(session) : null;
  }

  /** Re-checks a known session (used by long-lived WebSocket connections). */
  revalidate(sessionId: string): Principal | null {
    const session = sessionsRepo.findById(this.o.db, sessionId);
    return session ? this.validate(session) : null;
  }

  private validate(session: SessionRecord): Principal | null {
    const now = this.o.now();
    const nowMs = now.getTime();
    if (session.revokedAt !== null) return null;
    if (nowMs >= Date.parse(session.expiresAt)) return null;
    const lastSeenMs = Date.parse(session.lastSeenAt);
    if (nowMs - lastSeenMs >= this.o.sessionIdleMs) return null;
    const user = usersRepo.findById(this.o.db, session.userId);
    if (!user || user.status !== 'active') return null;
    if (nowMs - lastSeenMs >= TOUCH_INTERVAL_MS) {
      sessionsRepo.touch(this.o.db, session.id, now.toISOString());
      session = { ...session, lastSeenAt: now.toISOString() };
    }
    return { user, session };
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  current(principal: Principal): CurrentSessionResponse {
    return { user: toCurrentUser(principal.user), session: toSessionInfo(principal.session, principal.session.id) };
  }

  listSessions(principal: Principal): SessionInfo[] {
    return sessionsRepo
      .listActiveForUser(this.o.db, principal.user.id, this.o.now().toISOString())
      .map((s) => toSessionInfo(s, principal.session.id));
  }

  /** Revokes one of the caller's own sessions. Other users' sessions look like missing ones. */
  revokeOwnSession(principal: Principal, sessionId: string): void {
    const now = this.o.now();
    withTransaction(this.o.db, () => {
      const session = sessionsRepo.findById(this.o.db, sessionId);
      if (!session || session.userId !== principal.user.id || session.revokedAt !== null) throw notFound('Session');
      sessionsRepo.revoke(this.o.db, sessionId, 'revoked_by_user', now.toISOString());
      writeAudit(this.o.db, { action: 'session.revoked', outcome: 'success', actorUserId: principal.user.id, sessionId }, now);
    });
    this.o.events.emit('sessions.revoked', { sessionIds: [sessionId] });
  }

  /** Changes the caller's password and signs out all of their other sessions. */
  async changePassword(principal: Principal, input: unknown): Promise<void> {
    const data = parseInput(changePasswordRequestSchema, input);
    const key = `password:${principal.user.id}`;
    this.enforceLimit(this.userLimiter, key);
    const now = this.o.now();
    if (!(await this.o.hasher.verify(principal.user.passwordHash, data.currentPassword))) {
      this.userLimiter.recordFailure(key);
      writeAudit(this.o.db, { action: 'password.changed', outcome: 'failure', actorUserId: principal.user.id, metadata: { reason: 'invalid_password' } }, now);
      throw forbidden('Current password is incorrect');
    }
    this.userLimiter.reset(key);
    if (data.newPassword.normalize('NFC') === data.currentPassword.normalize('NFC')) {
      throw new AppError('validation_error', 'Some fields are invalid', {
        issues: [{ path: 'newPassword', message: 'Choose a password different from the current one' }],
      });
    }
    const forced = principal.user.mustChangePassword;
    const newHash = await this.o.hasher.hash(data.newPassword);
    const revoked = withTransaction(this.o.db, () => {
      const iso = now.toISOString();
      // A successful change is the only thing that clears a pending forced change.
      usersRepo.setPasswordHash(this.o.db, principal.user.id, newHash, iso, false);
      const ids = sessionsRepo.revokeAllForUser(this.o.db, principal.user.id, 'password_changed', iso, principal.session.id);
      writeAudit(
        this.o.db,
        {
          action: 'password.changed',
          outcome: 'success',
          actorUserId: principal.user.id,
          metadata: { otherSessionsRevoked: ids.length, ...(forced ? { forced: true } : {}) },
        },
        now,
      );
      return ids;
    });
    if (revoked.length > 0) this.o.events.emit('sessions.revoked', { sessionIds: revoked });
  }

  /** Deletes long-dead sessions. Returns the number removed. */
  cleanupSessions(): number {
    const cutoff = new Date(this.o.now().getTime() - STALE_SESSION_RETENTION_MS).toISOString();
    return sessionsRepo.deleteStale(this.o.db, cutoff);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Must run inside the caller's transaction. */
  private createSession(userId: string, clientName: string | null, now: Date): { token: string; session: SessionRecord } {
    const token = generateToken();
    const id = crypto.randomUUID();
    const iso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.o.sessionTtlMs).toISOString();
    sessionsRepo.insert(this.o.db, { id, tokenHash: hashToken(token), userId, clientName, now: iso, expiresAt });
    return { token, session: sessionsRepo.findById(this.o.db, id)! };
  }

  private enforceLimit(limiter: FailureLimiter, key: string): void {
    const check = limiter.check(key);
    if (!check.allowed) {
      const retryAfterSeconds = Math.ceil(check.retryAfterMs / 1000);
      throw new AppError('rate_limited', 'Too many failed attempts. Try again later.', { retryAfterSeconds });
    }
  }
}

function isConstraintError(err: unknown): boolean {
  return err instanceof Error && /constraint/i.test(err.message);
}
