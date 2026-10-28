import crypto from 'node:crypto';
import { connectionsRepo, type ConnectionRecord, type ConnectionRole, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  connectionRoleSchema,
  PLATFORM_NAMES,
  PLATFORMS,
  platformSchema,
  type DisconnectResult,
  type FailedAttempt,
  type Platform,
  type PlatformConnectionSummary,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError, notFound } from '../errors';
import { OAuthCallbackServer, type CallbackPage } from './callback-server';
import { AUTHORIZATION_TTL_MS, PendingAuthorizations, type AuthorizationPurpose, type PendingAuthorization } from './oauth';
import type { Adapters } from './registry';
import { OAuthError, type OAuthAdapter, type TokenSet } from './types';
import type { CredentialVault } from './vault';
import { parseInput } from '../validation';

/** Re-check connections (refresh tokens, confirm identity) this often while the app runs. */
const VERIFY_INTERVAL_MS = 6 * 60 * 60_000;
/** Refresh access tokens this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const credentialKey = (connectionId: string) => `connection:${connectionId}`;
const attemptKey = (platform: Platform, role: ConnectionRole) => `${platform}:${role}`;
const purposeFor = (role: ConnectionRole): AuthorizationPurpose => (role === 'bot' ? 'bot-account' : 'account');
const roleFor = (purpose: AuthorizationPurpose): ConnectionRole | null => (purpose === 'account' ? 'primary' : purpose === 'bot-account' ? 'bot' : null);

/** The same platform account can't hold both roles (e.g. the streamer's own account as their separate bot). */
class RoleConflictError extends Error {}

/** Completes a non-account authorization (e.g. adding the Discord bot to a server) whose state was verified. */
export type PurposeCallbackHandler = (pending: PendingAuthorization, params: URLSearchParams) => Promise<CallbackPage>;

export interface ConnectionServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  adapters: Adapters;
  vault: CredentialVault;
  callbackPort: number;
}

/**
 * Platform connections: real OAuth authorization, verified identity, encrypted token storage and honest status.
 * A platform is reported as connected only after its API has confirmed the authorized account.
 */
export class ConnectionService {
  private readonly pending: PendingAuthorizations;
  private readonly attempts = new Map<string, FailedAttempt>();
  private readonly callbacks: OAuthCallbackServer;
  private readonly sweeper: NodeJS.Timeout;
  private verifier: NodeJS.Timeout | null = null;
  private vaultProblem: string | null = null;
  private readonly purposeHandlers = new Map<string, PurposeCallbackHandler>();
  /** In-flight token refreshes per connection: rotating refresh tokens must never be used twice concurrently. */
  private readonly refreshing = new Map<string, Promise<TokenSet>>();
  private readonly afterConnect: Array<(record: ConnectionRecord) => void> = [];
  private readonly beforeDisconnect: Array<(record: ConnectionRecord, accessToken: string | null) => Promise<void>> = [];

  constructor(private readonly o: ConnectionServiceOptions) {
    this.pending = new PendingAuthorizations(() => o.now().getTime());
    this.callbacks = new OAuthCallbackServer({
      port: o.callbackPort,
      logger: o.logger.child({ module: 'oauth-callback' }),
      handler: (platform, params) => this.handleCallback(platform, params),
      afterResponse: () => void this.closeCallbacksIfIdle(),
    });
    this.sweeper = setInterval(() => void this.expirePending(), 30_000);
    this.sweeper.unref();
  }

  /** Port the callback listener uses (for the redirect URI to register with each platform). */
  redirectUri(platform: Platform): string {
    return this.callbacks.redirectUri(platform, this.o.adapters[platform]?.redirectHost);
  }

  /**
   * A usable access token for a platform account role, refreshed first when it is about to expire (or when
   * `forceRefresh`, e.g. after the platform rejected it). Null when the account isn't connected or can no longer be
   * refreshed (then it is marked as needing reconnection). Tokens never leave the backend.
   */
  async accessToken(platform: Platform, role: ConnectionRole, opts: { forceRefresh?: boolean } = {}): Promise<{ token: string; scopes: string[]; record: ConnectionRecord } | null> {
    const record = connectionsRepo.listForRole(this.o.db, platform, role).find((r) => r.status === 'connected');
    const adapter = this.o.adapters[platform];
    if (!record || !adapter) return null;
    let tokens = await this.readTokens(record.id);
    if (!tokens) return null;
    const expiring = tokens.expiresAt !== null && Date.parse(tokens.expiresAt) - REFRESH_MARGIN_MS <= this.o.now().getTime();
    if (opts.forceRefresh || expiring) {
      try {
        tokens = await this.refresh(record, adapter, tokens);
      } catch (err) {
        if (err instanceof OAuthError && (err.kind === 'invalid_grant' || err.kind === 'unauthorized')) {
          await this.markNeedsReauth(record);
          return null;
        }
        throw err;
      }
    }
    return { token: tokens.accessToken, scopes: tokens.scopes, record };
  }

  /** Runs after an account was connected or re-authorized (e.g. to use newly granted scopes). */
  onAfterConnect(hook: (record: ConnectionRecord) => void): void {
    this.afterConnect.push(hook);
  }

  /** Runs before a connection is removed, with its access token if still available (e.g. to unsubscribe events). */
  onBeforeDisconnect(hook: (record: ConnectionRecord, accessToken: string | null) => Promise<void>): void {
    this.beforeDisconnect.push(hook);
  }

  /** The last failed or cancelled attempt to connect this platform account role, if any. */
  lastAttempt(platform: Platform, role: ConnectionRole): FailedAttempt | null {
    return this.attempts.get(attemptKey(platform, role)) ?? null;
  }

  // ── status ────────────────────────────────────────────────────────────────

  async list(): Promise<PlatformConnectionSummary[]> {
    this.vaultProblem = await this.o.vault.unavailableReason();
    await this.expirePending();
    const records = connectionsRepo.list(this.o.db);
    return Promise.all(PLATFORMS.map((platform) => this.summarize(platform, records.filter((r) => r.platform === platform))));
  }

  private async unavailableReason(platform: Platform): Promise<string | null> {
    const adapter = this.o.adapters[platform];
    if (!adapter) return `Connecting ${PLATFORM_NAMES[platform]} is not available yet. Its official authorization flow has not been implemented.`;
    return (await adapter.configurationProblem()) ?? this.vaultProblem;
  }

  /** The card summary describes the streamer's own (primary) account; chatbot accounts are reported separately. */
  private async summarize(platform: Platform, all: ConnectionRecord[]): Promise<PlatformConnectionSummary> {
    const records = all.filter((r) => r.role === 'primary');
    const connected = records.filter((r) => r.status === 'connected');
    const primary = connected[0];
    const unavailable = await this.unavailableReason(platform);
    return {
      platform,
      name: PLATFORM_NAMES[platform],
      status: primary ? 'connected' : 'not_connected',
      account: primary
        ? { id: primary.externalAccountId, name: primary.accountName, handle: primary.accountHandle, avatarDataUrl: primary.avatarDataUrl }
        : null,
      additionalAccounts: Math.max(0, connected.length - 1),
      authorizationAvailable: unavailable === null,
      unavailableReason: unavailable,
      pending: this.pending.isPending(platform),
      lastAttempt: this.lastAttempt(platform, 'primary'),
      problem: primary ? null : problemOf(records),
      lastVerifiedAt: primary?.lastVerifiedAt ?? null,
    };
  }

  // ── authorization ─────────────────────────────────────────────────────────

  /**
   * Starts an authorization and returns the platform URL the desktop opens in the user's browser. `role` 'bot'
   * connects a separate chatbot account (platforms that support it); it requires the streamer's own account first.
   */
  async startAuthorization(rawPlatform: unknown, rawRole: unknown = 'primary'): Promise<{ authorizationUrl: string }> {
    const platform = parseInput(platformSchema, rawPlatform);
    const role = parseInput(connectionRoleSchema, rawRole ?? 'primary');
    const adapter = this.o.adapters[platform];
    if (!adapter) {
      throw new AppError('not_implemented', `Connecting ${PLATFORM_NAMES[platform]} is not available yet. Its official authorization flow has not been implemented.`);
    }
    const configProblem = await adapter.configurationProblem();
    if (configProblem) throw new AppError('not_configured', configProblem);
    const vaultProblem = await this.o.vault.unavailableReason();
    if (vaultProblem) throw new AppError('not_configured', vaultProblem);

    if (role === 'bot') {
      if (!adapter.scopesFor) throw new AppError('bad_request', `${PLATFORM_NAMES[platform]} doesn't use a separate bot account in CONDUIT.`);
      const primary = connectionsRepo.listForRole(this.o.db, platform, 'primary').some((r) => r.status === 'connected');
      if (!primary) throw new AppError('conflict', `Connect your main ${PLATFORM_NAMES[platform]} account first, then add a bot account.`);
    }

    this.attempts.delete(attemptKey(platform, role));
    const started = await this.beginAuthorization(platform, purposeFor(role), adapter.usesPkce);
    this.o.logger.info('authorization started', { platform, role });
    return {
      authorizationUrl: await adapter.authorizationUrl({
        state: started.state,
        redirectUri: started.redirectUri,
        codeChallenge: started.codeChallenge,
        scopes: adapter.scopesFor?.(role) ?? adapter.scopes,
      }),
    };
  }

  /**
   * Opens the loopback callback listener and records a single-use state for `purpose`. Other purposes share the
   * platform's registered redirect URI and the same state protection; their callbacks go to the registered handler.
   */
  async beginAuthorization(platform: Platform, purpose: AuthorizationPurpose, usesPkce = false): Promise<PendingAuthorization & { codeChallenge: string | null }> {
    try {
      await this.callbacks.ensureListening();
    } catch (err) {
      throw new AppError('service_unavailable', err instanceof Error ? err.message : 'Could not open the OAuth callback listener');
    }
    return this.pending.start(platform, this.redirectUri(platform), usesPkce, purpose);
  }

  registerCallbackHandler(platform: Platform, purpose: Exclude<AuthorizationPurpose, 'account' | 'bot-account'>, handler: PurposeCallbackHandler): void {
    this.purposeHandlers.set(`${platform}:${purpose}`, handler);
  }

  isPending(platform: Platform, purpose: AuthorizationPurpose): boolean {
    return this.pending.isPending(platform, purpose);
  }

  /** Forgets a pending authorization for a purpose; returns whether there was one. */
  async cancelPurpose(platform: Platform, purpose: AuthorizationPurpose): Promise<boolean> {
    const removed = this.pending.cancel(platform, purpose);
    await this.closeCallbacksIfIdle();
    return removed;
  }

  /** The user gave up (or wants to start over): forget the pending authorization. */
  async cancel(rawPlatform: unknown, rawRole: unknown = 'primary'): Promise<void> {
    const platform = parseInput(platformSchema, rawPlatform);
    const role = parseInput(connectionRoleSchema, rawRole ?? 'primary');
    if (!this.pending.cancel(platform, purposeFor(role))) throw notFound(`Pending ${PLATFORM_NAMES[platform]} authorization`);
    this.recordAttempt(platform, role, 'cancelled', `You cancelled connecting ${PLATFORM_NAMES[platform]}. Select Connect to try again.`);
    await this.closeCallbacksIfIdle();
  }

  /** Handles the browser's return from the platform. Returns the page shown in the browser tab. */
  async handleCallback(platform: Platform, params: URLSearchParams): Promise<CallbackPage> {
    const name = PLATFORM_NAMES[platform];
    const consumed = this.pending.consume(platform, params.get('state') ?? undefined);
    if (!consumed.ok) {
      // Not an authorization CONDUIT is waiting for (forged, replayed or stale): touch nothing.
      this.o.logger.warn('rejected oauth callback', { platform, reason: consumed.reason });
      if (consumed.reason === 'expired') {
        this.recordAttempt(platform, 'primary', 'failed', `The ${name} authorization took longer than ${AUTHORIZATION_TTL_MS / 60_000} minutes. Select Connect to try again.`);
      }
      return { status: 400, title: 'Link expired', message: `This ${name} sign-in link is not valid, has expired or was already used. Start again from CONDUIT.` };
    }

    const role = roleFor(consumed.pending.purpose);
    if (!role) {
      const handler = this.purposeHandlers.get(`${platform}:${consumed.pending.purpose}`);
      if (!handler) return { status: 400, title: 'Link expired', message: `This ${name} link is not valid. Start again from CONDUIT.` };
      try {
        return await handler(consumed.pending, params);
      } catch (err) {
        this.o.logger.error('callback handler failed', { platform, purpose: consumed.pending.purpose, err });
        return { status: 500, title: 'Something went wrong', message: 'CONDUIT could not finish this step. Return to CONDUIT and try again.' };
      }
    }

    try {
      const error = params.get('error');
      if (error) {
        if (error === 'access_denied') {
          this.recordAttempt(platform, role, 'cancelled', `You cancelled the ${name} authorization. Select Connect to try again.`);
          return { status: 200, title: 'Authorization cancelled', message: `CONDUIT was not connected to ${name}.` };
        }
        const code = /^[a-z_]{1,40}$/.test(error) ? error : 'unknown_error';
        this.recordAttempt(platform, role, 'failed', `${name} reported an error (${code}). Select Connect to try again.`);
        return { status: 400, title: 'Authorization failed', message: `${name} reported an error (${code}).` };
      }
      const code = params.get('code');
      if (!code || code.length > 512) {
        this.recordAttempt(platform, role, 'failed', `${name} returned without an authorization code. Select Connect to try again.`);
        return { status: 400, title: 'Authorization failed', message: `${name} returned without an authorization code.` };
      }

      const account = await this.completeAuthorization(platform, role, consumed.pending.redirectUri, code, consumed.pending.codeVerifier);
      return {
        status: 200,
        title: `${name} connected`,
        message:
          role === 'bot'
            ? `CONDUIT added the ${name} account ${account} as your chatbot account.`
            : `CONDUIT is connected to the ${name} account ${account}.`,
      };
    } catch (err) {
      const message = this.describeFailure(platform, err);
      this.recordAttempt(platform, role, 'failed', message);
      return { status: 400, title: 'Authorization failed', message };
    }
    // The listener is closed by afterResponse once this page has been delivered.
  }

  private async completeAuthorization(platform: Platform, role: ConnectionRole, redirectUri: string, code: string, codeVerifier: string | null): Promise<string> {
    const adapter = this.o.adapters[platform]!;
    const required = adapter.scopesFor?.(role) ?? adapter.scopes;
    let tokens = await adapter.exchangeCode({ code, redirectUri, codeVerifier });
    if (!tokens.scopesUnreported) {
      const missing = required.filter((s) => !tokens.scopes.includes(s));
      if (missing.length > 0) throw new OAuthError('unexpected_response', `${PLATFORM_NAMES[platform]} did not grant the required permission (${missing.join(', ')})`);
    } else {
      // The platform didn't list the granted scopes: record what was requested and approved; the identity call below
      // (and later API calls) prove what actually works.
      const { scopesUnreported: _unreported, ...rest } = tokens;
      tokens = { ...rest, scopes: [...required] };
    }
    const identity = await adapter.fetchIdentity(tokens.accessToken, tokens.scopes);

    const now = this.o.now();
    const iso = now.toISOString();
    const existing = connectionsRepo.find(this.o.db, platform, identity.id);
    if (existing && existing.role !== role) {
      // Never let one flow silently take over the other role's account.
      await adapter.revoke(tokens.refreshToken ?? tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token').catch(() => undefined);
      throw new RoleConflictError(role);
    }
    const id = existing?.id ?? crypto.randomUUID();
    // Credentials first: a connection is only recorded once its tokens are safely stored.
    await this.o.vault.set(credentialKey(id), JSON.stringify(tokens));
    connectionsRepo.upsertVerified(this.o.db, {
      id,
      platform,
      role,
      externalAccountId: identity.id,
      accountName: identity.name,
      accountHandle: identity.handle,
      avatarDataUrl: identity.avatarDataUrl,
      grantedScopes: tokens.scopes,
      now: iso,
    });
    writeAudit(this.o.db, { action: 'connection.created', outcome: 'success', actorUserId: null, metadata: { platform, role, reconnected: Boolean(existing) } }, now);
    this.attempts.delete(attemptKey(platform, role));
    this.o.logger.info('platform connected', { platform, role });
    // A platform has one separate bot account: connecting a different one replaces the previous one.
    if (role === 'bot') {
      for (const old of connectionsRepo.listForRole(this.o.db, platform, 'bot')) if (old.id !== id) await this.removeRecord(old, adapter);
    }
    const connected = connectionsRepo.find(this.o.db, platform, identity.id);
    if (connected) for (const hook of this.afterConnect) hook(connected);
    return identity.name;
  }

  private describeFailure(platform: Platform, err: unknown): string {
    const name = PLATFORM_NAMES[platform];
    if (err instanceof RoleConflictError) {
      return err.message === 'bot'
        ? `That's your main ${name} account. To use it for the chatbot, choose "Use my main account". To add a separate bot, sign in to ${name} as the bot account first (or use a private browser window), then select Add Bot Account.`
        : `That ${name} account is connected as your chatbot account. Disconnect it there first, or sign in to ${name} with your own account.`;
    }
    if (err instanceof OAuthError) {
      this.o.logger.warn('authorization failed', { platform, kind: err.kind });
      switch (err.kind) {
        case 'invalid_grant':
          return `The ${name} authorization code was invalid or had expired. Select Connect to try again.`;
        case 'invalid_client':
          return `${name} rejected your application's credentials. Open ${name} setup, check the ${platform === 'discord' ? 'Application ID' : 'Client ID'} and Client Secret, then try again.`;
        case 'network':
          return `CONDUIT couldn't reach ${name}. Check your internet connection and select Connect to try again.`;
        default:
          return `${name} didn't confirm your account. Select Connect to try again.`;
      }
    }
    this.o.logger.error('authorization failed', { platform, err });
    return `CONDUIT couldn't finish connecting ${name} (its credentials could not be stored securely). Select Connect to try again.`;
  }

  // ── disconnect ────────────────────────────────────────────────────────────

  /**
   * Revokes CONDUIT's access at the platform where possible, deletes local credentials and forgets the connection.
   * Only the given role is affected: disconnecting a chatbot account leaves the streamer's account, and vice versa.
   */
  async disconnect(rawPlatform: unknown, rawRole: unknown = 'primary'): Promise<DisconnectResult> {
    const platform = parseInput(platformSchema, rawPlatform);
    const role = parseInput(connectionRoleSchema, rawRole ?? 'primary');
    const records = connectionsRepo.listForRole(this.o.db, platform, role);
    if (records.length === 0) throw notFound(`${PLATFORM_NAMES[platform]} ${role === 'bot' ? 'bot account' : 'connection'}`);
    const adapter = this.o.adapters[platform];
    let revokedAll = true;
    for (const record of records) revokedAll = (await this.removeRecord(record, adapter)) && revokedAll;
    this.attempts.delete(attemptKey(platform, role));
    const name = PLATFORM_NAMES[platform];
    return {
      revokedAtPlatform: revokedAll,
      message: revokedAll
        ? null
        : `CONDUIT removed its ${name} credentials, but couldn't confirm that ${name} revoked access. You can remove CONDUIT under ${name}'s authorized apps settings.`,
    };
  }

  /** Revokes (best effort) and forgets one connection. Returns whether nothing is left authorized at the platform. */
  private async removeRecord(record: ConnectionRecord, adapter: OAuthAdapter | undefined): Promise<boolean> {
    const platform = record.platform;
    let revoked = false;
    const tokens = await this.readTokens(record.id);
    for (const hook of this.beforeDisconnect) {
      await hook(record, tokens?.accessToken ?? null).catch((err) => this.o.logger.warn('disconnect hook failed', { platform, err }));
    }
    if (adapter && tokens) {
      try {
        // Revoking either token ends the whole authorization (Discord revokes all tokens of the grant).
        if (tokens.refreshToken) await adapter.revoke(tokens.refreshToken, 'refresh_token');
        else await adapter.revoke(tokens.accessToken, 'access_token');
        revoked = true;
      } catch (err) {
        this.o.logger.warn('token revocation failed', { platform, kind: err instanceof OAuthError ? err.kind : 'unknown' });
      }
    }
    await this.o.vault.delete(credentialKey(record.id)).catch((err) => this.o.logger.error('could not delete credential', { platform, err }));
    connectionsRepo.remove(this.o.db, record.id);
    writeAudit(
      this.o.db,
      { action: 'connection.removed', outcome: 'success', actorUserId: null, metadata: { platform, role: record.role, revokedAtPlatform: revoked } },
      this.o.now(),
    );
    // No stored tokens (already expired or revoked) means there is nothing left to revoke.
    return revoked || !tokens;
  }

  // ── verification ──────────────────────────────────────────────────────────

  /** Starts periodic verification (refreshing tokens, detecting revoked authorizations). */
  startBackgroundVerification(): void {
    const run = () => void this.verifyAll().catch((err) => this.o.logger.error('connection verification failed', { err }));
    run();
    this.verifier = setInterval(run, VERIFY_INTERVAL_MS);
    this.verifier.unref();
  }

  /** Checks every connected account with its platform. Network problems leave the status unchanged. */
  async verifyAll(): Promise<void> {
    if (await this.o.vault.unavailableReason()) return;
    for (const record of connectionsRepo.list(this.o.db)) {
      const adapter = this.o.adapters[record.platform];
      if (!adapter || record.status !== 'connected') continue;
      await this.verify(record, adapter);
    }
  }

  private async verify(record: ConnectionRecord, adapter: OAuthAdapter): Promise<void> {
    const name = PLATFORM_NAMES[record.platform];
    const iso = () => this.o.now().toISOString();
    let tokens = await this.readTokens(record.id);
    if (!tokens) {
      connectionsRepo.markStatus(this.o.db, record.id, 'needs_reauth', `CONDUIT no longer has the stored ${name} credentials. Connect again.`, iso());
      return;
    }
    try {
      let refreshed = false;
      if (tokens.expiresAt && Date.parse(tokens.expiresAt) - REFRESH_MARGIN_MS <= this.o.now().getTime()) {
        tokens = await this.refresh(record, adapter, tokens);
        refreshed = true;
      }
      let identity;
      try {
        identity = await adapter.fetchIdentity(tokens.accessToken, tokens.scopes);
      } catch (err) {
        if (!(err instanceof OAuthError && err.kind === 'unauthorized') || refreshed) throw err;
        tokens = await this.refresh(record, adapter, tokens);
        identity = await adapter.fetchIdentity(tokens.accessToken, tokens.scopes);
      }
      connectionsRepo.markVerified(this.o.db, record.id, { accountName: identity.name, accountHandle: identity.handle, avatarDataUrl: identity.avatarDataUrl }, iso());
    } catch (err) {
      if (err instanceof OAuthError && (err.kind === 'invalid_grant' || err.kind === 'unauthorized')) {
        await this.markNeedsReauth(record);
      } else {
        this.o.logger.warn('connection check inconclusive', { platform: record.platform, kind: err instanceof OAuthError ? err.kind : 'unknown' });
      }
    }
  }

  /** Revoked by the user at the platform, or expired beyond refresh: the stored tokens are useless. */
  private async markNeedsReauth(record: ConnectionRecord): Promise<void> {
    await this.o.vault.delete(credentialKey(record.id)).catch(() => {});
    connectionsRepo.markStatus(this.o.db, record.id, 'needs_reauth', null, this.o.now().toISOString());
    writeAudit(
      this.o.db,
      { action: 'connection.expired', outcome: 'success', actorUserId: null, metadata: { platform: record.platform, role: record.role } },
      this.o.now(),
    );
    this.o.logger.warn('connection needs reauthorization', { platform: record.platform, role: record.role });
  }

  /**
   * Refreshes a connection's tokens. Concurrent callers share one refresh: platforms that rotate refresh tokens (Kick)
   * invalidate the old one, so a second, parallel refresh would fail and wrongly look like a revoked authorization.
   */
  private refresh(record: ConnectionRecord, adapter: OAuthAdapter, tokens: TokenSet): Promise<TokenSet> {
    const inFlight = this.refreshing.get(record.id);
    if (inFlight) return inFlight;
    const p = (async () => {
      if (!tokens.refreshToken) throw new OAuthError('invalid_grant', 'No refresh token');
      const next = await adapter.refresh(tokens.refreshToken);
      const { scopesUnreported, ...rest } = next;
      // A refresh grants the same scopes; keep the known list when the platform doesn't repeat it.
      const merged: TokenSet = {
        ...rest,
        refreshToken: next.refreshToken ?? tokens.refreshToken,
        scopes: scopesUnreported || next.scopes.length === 0 ? tokens.scopes : next.scopes,
      };
      await this.o.vault.set(credentialKey(record.id), JSON.stringify(merged));
      return merged;
    })().finally(() => this.refreshing.delete(record.id));
    this.refreshing.set(record.id, p);
    return p;
  }

  private async readTokens(connectionId: string): Promise<TokenSet | null> {
    try {
      const raw = await this.o.vault.get(credentialKey(connectionId));
      return raw ? (JSON.parse(raw) as TokenSet) : null;
    } catch {
      return null;
    }
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  private recordAttempt(platform: Platform, role: ConnectionRole, outcome: FailedAttempt['outcome'], message: string): void {
    this.attempts.set(attemptKey(platform, role), { outcome, message, at: this.o.now().toISOString() });
  }

  private async expirePending(): Promise<void> {
    for (const expired of this.pending.sweep()) {
      const role = roleFor(expired.purpose);
      if (!role) continue;
      this.recordAttempt(
        expired.platform,
        role,
        'failed',
        `The ${PLATFORM_NAMES[expired.platform]} authorization wasn't completed within ${AUTHORIZATION_TTL_MS / 60_000} minutes. Select Connect to try again.`,
      );
    }
    await this.closeCallbacksIfIdle();
  }

  private async closeCallbacksIfIdle(): Promise<void> {
    if (this.pending.size === 0 && this.callbacks.listening) await this.callbacks.close();
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    if (this.verifier) clearInterval(this.verifier);
    await this.callbacks.close();
  }
}

/** Why a platform with records but no working connection is unusable. */
function problemOf(records: ConnectionRecord[]): string | null {
  const failing = records.find((r) => r.status !== 'connected');
  if (!failing) return null;
  if (failing.status === 'needs_reauth') {
    return failing.lastError ?? 'The authorization expired or was revoked. Connect again to restore access.';
  }
  return failing.lastError ?? 'The last check of this connection failed.';
}
