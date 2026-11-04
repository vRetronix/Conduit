/**
 * The user's own Twitch developer app: the Client ID (not secret) in app_settings, the Client Secret in the
 * DPAPI-encrypted vault. Account tokens are stored separately, per connection (see connection-service.ts).
 */
import { SETTING_KEYS, settingsRepo, type Database } from '@conduit/database';
import type { TwitchClientCredentials } from './twitch';
import type { CredentialVault } from '../app/vault';

export const TWITCH_CLIENT_SECRET_KEY = 'twitch:client-secret';

export class TwitchCredentials {
  constructor(
    private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly now: () => Date,
  ) {}

  /** Which account the chatbot uses: 'primary' (default) or 'separate'. */
  chatbotMode(): 'primary' | 'separate' {
    return settingsRepo.get(this.db, SETTING_KEYS.twitchChatbotAccount) === 'separate' ? 'separate' : 'primary';
  }

  clientId(): string | null {
    return settingsRepo.get(this.db, SETTING_KEYS.twitchClientId) ?? null;
  }

  async client(): Promise<TwitchClientCredentials | null> {
    const clientId = this.clientId();
    if (!clientId) return null;
    const clientSecret = await this.secret();
    return clientSecret ? { clientId, clientSecret } : null;
  }

  async hasClientSecret(): Promise<boolean> {
    return (await this.secret()) !== null;
  }

  /** Secret first: the app only counts as configured once its secret is safely stored. */
  async save(clientId: string, clientSecret: string | null): Promise<void> {
    if (clientSecret) await this.vault.set(TWITCH_CLIENT_SECRET_KEY, clientSecret);
    settingsRepo.set(this.db, SETTING_KEYS.twitchClientId, clientId, this.now().toISOString());
  }

  async secret(): Promise<string | null> {
    try {
      return await this.vault.get(TWITCH_CLIENT_SECRET_KEY);
    } catch {
      return null;
    }
  }
}
