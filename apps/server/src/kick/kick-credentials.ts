/**
 * The user's own Kick developer app: the Client ID (not secret) in app_settings, the Client Secret in the
 * DPAPI-encrypted vault. Account tokens are stored separately, per connection (see connection-service.ts).
 */
import { SETTING_KEYS, settingsRepo, type Database } from '@conduit/database';
import type { KickClientCredentials } from './kick';
import type { CredentialVault } from '../app/vault';

export const KICK_CLIENT_SECRET_KEY = 'kick:client-secret';

export class KickCredentials {
  constructor(
    private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly now: () => Date,
  ) {}

  /** Which account the chatbot uses: 'primary' (default) or 'separate'. */
  chatbotMode(): 'primary' | 'separate' {
    return settingsRepo.get(this.db, SETTING_KEYS.kickChatbotAccount) === 'separate' ? 'separate' : 'primary';
  }

  clientId(): string | null {
    return settingsRepo.get(this.db, SETTING_KEYS.kickClientId) ?? null;
  }

  async client(): Promise<KickClientCredentials | null> {
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
    if (clientSecret) await this.vault.set(KICK_CLIENT_SECRET_KEY, clientSecret);
    settingsRepo.set(this.db, SETTING_KEYS.kickClientId, clientId, this.now().toISOString());
  }

  async secret(): Promise<string | null> {
    try {
      return await this.vault.get(KICK_CLIENT_SECRET_KEY);
    } catch {
      return null;
    }
  }
}
