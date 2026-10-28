/**
 * Kick setup: the user's own Kick app (Client ID + Client Secret), the streamer's account (primary role), an
 * optional separate chatbot account (bot role), and which of the two the chatbot uses.
 *
 * Connection state is authoritative from platform_connections (written only after Kick confirmed the identity) and
 * ConnectionService (pending and failed attempts). Nothing here claims a chat capability: no chat feature exists yet
 * and chat:write is not requested in this phase.
 */
import {
  connectionsRepo,
  SETTING_KEYS,
  settingsRepo,
  type ConnectionRecord,
  type ConnectionRole,
  type Database,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  saveKickApplicationSchema,
  setKickChatbotSchema,
  type KickAccountState,
  type KickChatbotMode,
  type KickSetupState,
} from '@conduit/shared';
import { AppError } from '../errors';
import { kickScopes, type KickAdapter } from './kick';
import type { KickCredentials } from './kick-credentials';
import { OAuthError } from '../app/types';
import type { CredentialVault } from '../app/vault';
import { parseInput } from '../validation';
import type { ConnectionService } from '../app/connection-service';
import type { KickChatService } from './kick-chat-service';

export interface KickSetupServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  vault: CredentialVault;
  credentials: KickCredentials;
  adapter: KickAdapter;
  connections: ConnectionService;
  chat: KickChatService;
}

export class KickSetupService {
  constructor(private readonly o: KickSetupServiceOptions) {}

  async state(): Promise<KickSetupState> {
    const clientId = this.o.credentials.clientId();
    const clientSecretStored = await this.o.credentials.hasClientSecret();
    const primary = this.account('primary');
    const bot = this.account('bot');
    const mode = this.mode();
    const account = mode === 'primary' ? (primary.status === 'connected' ? 'primary' : null) : bot.status === 'connected' ? 'bot' : null;

    const chat = this.o.chat.state();
    let note: string;
    if (mode === 'separate' && bot.status === 'not_connected') note = 'Add a bot account to use a separate Kick account for the chatbot.';
    else if (account === null) note = mode === 'primary' ? 'Connect your Kick account first.' : 'Reconnect the bot account to use it.';
    else if (!chat.send.ready) note = chat.send.problem ?? 'The chatbot account can’t send messages yet.';
    else note = `Messages are sent as ${chat.send.accountName} to ${chat.send.channel}'s chat.`;

    return {
      application: { configured: Boolean(clientId) && clientSecretStored, clientId, clientSecretStored },
      primary,
      bot,
      chatbot: { mode, account, ready: chat.send.ready, note },
      redirectUri: this.o.connections.redirectUri('kick'),
      scopes: { primary: kickScopes('primary', mode), bot: kickScopes('bot', mode) },
      chat,
    };
  }

  private mode(): KickChatbotMode {
    return settingsRepo.get(this.o.db, SETTING_KEYS.kickChatbotAccount) === 'separate' ? 'separate' : 'primary';
  }

  private account(role: ConnectionRole): KickAccountState {
    const records = connectionsRepo.listForRole(this.o.db, 'kick', role);
    const r: ConnectionRecord | undefined = records.find((x) => x.status === 'connected') ?? records[0];
    const pending = this.o.connections.isPending('kick', role === 'bot' ? 'bot-account' : 'account');
    const attempt = this.o.connections.lastAttempt('kick', role);
    const status = !r ? 'not_connected' : r.status === 'connected' ? 'connected' : 'needs_reauth';
    let problem: string | null = null;
    if (status === 'needs_reauth')
      problem = r?.lastError ?? 'Kick no longer accepts this authorization (expired or revoked). Select Reconnect.';
    else if (status === 'not_connected' && attempt && !pending) problem = attempt.message;
    return {
      status,
      userId: r?.externalAccountId ?? null,
      name: r?.accountName ?? null,
      handle: r?.accountHandle ?? null,
      avatarDataUrl: r?.avatarDataUrl ?? null,
      scopes: r ? parseScopes(r.grantedScopes) : [],
      pending,
      problem,
      lastVerifiedAt: r?.lastVerifiedAt ?? null,
    };
  }

  /** Saves the Kick app details after Kick accepted them (client credentials grant). Nothing is saved otherwise. */
  async saveApplication(raw: unknown): Promise<KickSetupState> {
    const input = parseInput(saveKickApplicationSchema, raw);
    const vaultProblem = await this.o.vault.unavailableReason();
    if (vaultProblem) throw new AppError('not_configured', vaultProblem);

    const sameClient = this.o.credentials.clientId() === input.clientId;
    const secret = input.clientSecret ?? (sameClient ? await this.o.credentials.secret() : null);
    if (!secret) {
      throw new AppError('validation_error', 'Some details are missing', {
        issues: [{ path: 'clientSecret', message: 'Enter the Client Secret shown for your app in Kick’s developer settings.' }],
      });
    }
    try {
      await this.o.adapter.verifyClientCredentials(input.clientId, secret);
    } catch (err) {
      if (err instanceof OAuthError && err.kind === 'network') {
        throw new AppError(
          'service_unavailable',
          "CONDUIT couldn't reach Kick to check these details. Check your internet connection and try again. Nothing was saved.",
        );
      }
      this.o.logger.warn('kick app validation failed', { kind: err instanceof OAuthError ? err.kind : 'unknown' });
      throw new AppError('validation_error', 'Kick did not accept these details', {
        issues: [
          {
            path: input.clientSecret ? 'clientSecret' : 'clientId',
            message: 'Kick rejected this Client ID and Client Secret. Copy both again from your app in Kick’s developer settings.',
          },
        ],
      });
    }
    try {
      await this.o.credentials.save(input.clientId, input.clientSecret ?? null);
    } catch (err) {
      this.o.logger.error('could not store kick app secret', { err });
      throw new AppError(
        'service_unavailable',
        "CONDUIT couldn't store your Kick Client Secret securely, so nothing was saved. Try again.",
      );
    }
    this.o.logger.info('kick app saved', { replaced: !sameClient });
    return this.state();
  }

  /** Which account the chatbot uses. Choosing 'separate' doesn't require the bot account to exist yet. */
  async setChatbot(raw: unknown): Promise<KickSetupState> {
    const { mode } = parseInput(setKickChatbotSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.kickChatbotAccount, mode, this.o.now().toISOString());
    return this.state();
  }
}

function parseScopes(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
