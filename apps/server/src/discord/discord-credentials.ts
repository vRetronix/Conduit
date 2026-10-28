/**
 * The user's own Discord application: the non-secret Application ID in SQLite, the Client Secret and Bot Token in the
 * DPAPI-encrypted vault under separate keys. User-OAuth credentials (ID + secret) and the bot credential (token) are
 * kept apart so neither is used where the other belongs.
 */
import { discordRepo, type Database } from '@conduit/database';
import type { CredentialVault } from '../app/vault';

export const CLIENT_SECRET_KEY = 'discord:client-secret';
export const BOT_TOKEN_KEY = 'discord:bot-token';

export interface DiscordClientCredentials {
  clientId: string;
  clientSecret: string;
}

export class DiscordCredentials {
  constructor(
    private readonly db: Database,
    private readonly vault: CredentialVault,
  ) {}

  applicationId(): string | null {
    return discordRepo.getApplication(this.db)?.applicationId ?? null;
  }

  /** Credentials for user OAuth (the Application ID doubles as the OAuth2 client_id). Null until configured. */
  async client(): Promise<DiscordClientCredentials | null> {
    const clientId = this.applicationId();
    if (!clientId) return null;
    const clientSecret = await this.read(CLIENT_SECRET_KEY);
    return clientSecret ? { clientId, clientSecret } : null;
  }

  /** The bot token, used only for the bot's own REST and gateway calls. */
  botToken(): Promise<string | null> {
    return this.read(BOT_TOKEN_KEY);
  }

  async hasClientSecret(): Promise<boolean> {
    return (await this.read(CLIENT_SECRET_KEY)) !== null;
  }

  async hasBotToken(): Promise<boolean> {
    return (await this.read(BOT_TOKEN_KEY)) !== null;
  }

  setClientSecret(secret: string): Promise<void> {
    return this.vault.set(CLIENT_SECRET_KEY, secret);
  }

  setBotToken(token: string): Promise<void> {
    return this.vault.set(BOT_TOKEN_KEY, token);
  }

  async deleteSecrets(): Promise<void> {
    await this.vault.delete(CLIENT_SECRET_KEY);
    await this.vault.delete(BOT_TOKEN_KEY);
  }

  private async read(key: string): Promise<string | null> {
    try {
      return await this.vault.get(key);
    } catch {
      return null;
    }
  }
}
