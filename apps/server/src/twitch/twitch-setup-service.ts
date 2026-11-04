/**
 * Twitch setup: the user's own Twitch app (Client ID + Client Secret), the streamer's account (primary role), an
 * optional separate chatbot account (bot role), and which of the two the chatbot uses.
 *
 * Connection state is authoritative from platform_connections (written only after Twitch confirmed the identity) and
 * ConnectionService (pending and failed attempts). Chat status comes from TwitchChatService.
 */
import { connectionsRepo, SETTING_KEYS, settingsRepo, type ConnectionRecord, type ConnectionRole, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import { saveTwitchApplicationSchema, setTwitchChatbotSchema, type TwitchAccountState, type TwitchSetupState } from '@conduit/shared';
import { AppError } from '../errors';
import { twitchScopes, type TwitchAdapter } from './twitch';
import type { TwitchCredentials } from './twitch-credentials';
import type { TwitchChatService } from './twitch-chat-service';
import { OAuthError } from '../app/types';
import type { CredentialVault } from '../app/vault';
import { parseInput } from '../validation';
import type { ConnectionService } from '../app/connection-service';

export interface TwitchSetupServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  vault: CredentialVault;
  credentials: TwitchCredentials;
  adapter: TwitchAdapter;
  connections: ConnectionService;
  chat: TwitchChatService;
}

export class TwitchSetupService {
  constructor(private readonly o: TwitchSetupServiceOptions) {}

  async state(): Promise<TwitchSetupState> {
    const clientId = this.o.credentials.clientId();
    const clientSecretStored = await this.o.credentials.hasClientSecret();
    const primary = this.account('primary');
    const bot = this.account('bot');
    const mode = this.o.credentials.chatbotMode();
    const account = mode === 'primary' ? (primary.status === 'connected' ? 'primary' : null) : bot.status === 'connected' ? 'bot' : null;

    const chat = this.o.chat.state();
    let note: string;
    if (mode === 'separate' && bot.status === 'not_connected') note = 'Add a bot account to use a separate Twitch account for the chatbot.';
    else if (account === null) note = mode === 'primary' ? 'Connect your Twitch account first.' : 'Reconnect the bot account to use it.';
    else if (!chat.send.ready) note = chat.send.problem ?? 'The chatbot account can’t send messages yet.';
    else note = `Messages are sent as ${chat.send.accountName} to ${chat.send.channel}'s chat.`;

    return {
      application: { configured: Boolean(clientId) && clientSecretStored, clientId, clientSecretStored },
      primary,
      bot,
      chatbot: { mode, account, ready: chat.send.ready, note },
      redirectUri: this.o.connections.redirectUri('twitch'),
      scopes: { primary: twitchScopes('primary', mode), bot: twitchScopes('bot', mode) },
      chat,
    };
  }

  private account(role: ConnectionRole): TwitchAccountState {
    const records = connectionsRepo.listForRole(this.o.db, 'twitch', role);
    const r: ConnectionRecord | undefined = records.find((x) => x.status === 'connected') ?? records[0];
    const pending = this.o.connections.isPending('twitch', role === 'bot' ? 'bot-account' : 'account');
    const attempt = this.o.connections.lastAttempt('twitch', role);
    const status = !r ? 'not_connected' : r.status === 'connected' ? 'connected' : 'needs_reauth';
    let problem: string | null = null;
    if (status === 'needs_reauth') problem = r?.lastError ?? 'Twitch no longer accepts this authorization (expired or revoked). Select Reconnect.';
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

  /** Saves the Twitch app details after Twitch accepted them (client credentials grant). Nothing is saved otherwise. */
  async saveApplication(raw: unknown): Promise<TwitchSetupState> {
    const input = parseInput(saveTwitchApplicationSchema, raw);
    const vaultProblem = await this.o.vault.unavailableReason();
    if (vaultProblem) throw new AppError('not_configured', vaultProblem);

    const sameClient = this.o.credentials.clientId() === input.clientId;
    const secret = input.clientSecret ?? (sameClient ? await this.o.credentials.secret() : null);
    if (!secret) {
      throw new AppError('validation_error', 'Some details are missing', {
        issues: [{ path: 'clientSecret', message: 'Enter the Client Secret of your app in the Twitch Developer Console.' }],
      });
    }
    try {
      await this.o.adapter.verifyClientCredentials(input.clientId, secret);
    } catch (err) {
      if (err instanceof OAuthError && err.kind === 'network') {
        throw new AppError(
          'service_unavailable',
          "CONDUIT couldn't reach Twitch to check these details. Check your internet connection and try again. Nothing was saved.",
        );
      }
      this.o.logger.warn('twitch app validation failed', { kind: err instanceof OAuthError ? err.kind : 'unknown' });
      throw new AppError('validation_error', 'Twitch did not accept these details', {
        issues: [
          {
            path: input.clientSecret ? 'clientSecret' : 'clientId',
            message: 'Twitch rejected this Client ID and Client Secret. Copy both again from your app in the Twitch Developer Console.',
          },
        ],
      });
    }
    try {
      await this.o.credentials.save(input.clientId, input.clientSecret ?? null);
    } catch (err) {
      this.o.logger.error('could not store twitch app secret', { err });
      throw new AppError('service_unavailable', "CONDUIT couldn't store your Twitch Client Secret securely, so nothing was saved. Try again.");
    }
    this.o.logger.info('twitch app saved', { replaced: !sameClient });
    return this.state();
  }

  /** Which account the chatbot uses. Choosing 'separate' doesn't require the bot account to exist yet. */
  async setChatbot(raw: unknown): Promise<TwitchSetupState> {
    const { mode } = parseInput(setTwitchChatbotSchema, raw);
    settingsRepo.set(this.o.db, SETTING_KEYS.twitchChatbotAccount, mode, this.o.now().toISOString());
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
