import { describe, expect, it } from 'vitest';
import { discordPortalUrl, validateAuthorizationUrl, validateBotInstallUrl } from '../../apps/desktop/src/oauth-launch';
import { DiscordAdapter } from '../../apps/server/src/discord/discord';
import { PendingAuthorizations } from '../../apps/server/src/app/oauth';

const good =
  'https://discord.com/oauth2/authorize?client_id=123456789012345678&response_type=code&scope=identify&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A47821%2Foauth%2Fdiscord%2Fcallback&prompt=consent';

describe('validateAuthorizationUrl (what the desktop will open in the browser)', () => {
  it('accepts Discord\'s official authorization page redirecting to CONDUIT\'s loopback callback', () => {
    expect(validateAuthorizationUrl('discord', good)).toBe(good);
  });

  it.each([
    ['another site', good.replace('https://discord.com', 'https://evil.example')],
    ['a lookalike host', good.replace('discord.com', 'discord.com.evil.example')],
    ['plain http', good.replace('https://', 'http://')],
    ['another path', good.replace('/oauth2/authorize', '/login')],
    ['credentials in the URL', good.replace('https://', 'https://user:pass@')],
    ['a fragment', `${good}#x`],
    ['a non-loopback redirect', good.replace('127.0.0.1%3A47821', 'evil.example')],
    ['another platform\'s callback', good.replace('%2Fdiscord%2F', '%2Ftwitch%2F')],
    ['a missing state', good.replace('&state=abc', '')],
    ['implicit flow', good.replace('response_type=code', 'response_type=token')],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a non-string', 42],
  ])('rejects %s', (_label, url) => {
    expect(validateAuthorizationUrl('discord', url)).toBeNull();
  });

  it('accepts exactly what the Discord adapter generates (backend and desktop agree)', async () => {
    const adapter = new DiscordAdapter({ credentials: async () => ({ clientId: '123456789012345678', clientSecret: 'x'.repeat(32) }), version: '1' });
    const pending = new PendingAuthorizations().start('discord', 'http://127.0.0.1:47821/oauth/discord/callback', adapter.usesPkce);
    const url = await adapter.authorizationUrl({ state: pending.state, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge });
    expect(validateAuthorizationUrl('discord', url)).not.toBeNull();
  });

  it('opens nothing for platforms without an implemented authorization', () => {
    expect(validateAuthorizationUrl('kick', good)).toBeNull();
    expect(validateAuthorizationUrl('twitch', good)).toBeNull();
  });
});

describe('validateBotInstallUrl (adding the bot to a server)', () => {
  const good = () =>
    new URL(
      'https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot+applications.commands&permissions=1099780320502&integration_type=0&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A47821%2Foauth%2Fdiscord%2Fcallback&state=abc',
    );

  it('accepts the official add-bot URL with exactly the giveaway permissions', () => {
    expect(validateBotInstallUrl(good().toString())).not.toBeNull();
  });

  it.each([
    ['Administrator', (u: URL) => u.searchParams.set('permissions', '8')],
    ['other permissions', (u: URL) => u.searchParams.set('permissions', '2048')],
    ['the giveaway permissions plus Administrator', (u: URL) => u.searchParams.set('permissions', String(19456 + 8))],
    ['no permissions (an old link)', (u: URL) => u.searchParams.set('permissions', '0')],
    ['extra scopes', (u: URL) => u.searchParams.set('scope', 'bot applications.commands identify')],
    ['the bot scope alone (commands could not be registered)', (u: URL) => u.searchParams.set('scope', 'bot')],
    ['a non-numeric client id', (u: URL) => u.searchParams.set('client_id', 'evil')],
    ['a non-loopback redirect', (u: URL) => u.searchParams.set('redirect_uri', 'https://evil.example/oauth/discord/callback')],
    ['another host', (u: URL) => (u.host = 'evil.example')],
    ['no state', (u: URL) => u.searchParams.delete('state')],
  ])('rejects %s', (_label, mutate) => {
    const url = good();
    mutate(url);
    expect(validateBotInstallUrl(url.toString())).toBeNull();
  });
});

describe('discordPortalUrl (Developer Portal pages the renderer may open)', () => {
  it('builds only allow-listed pages, with the backend-provided application id', () => {
    expect(discordPortalUrl('applications', null)).toBe('https://discord.com/developers/applications');
    expect(discordPortalUrl('bot', '123456789012345678')).toBe('https://discord.com/developers/applications/123456789012345678/bot');
    expect(discordPortalUrl('oauth2', null)).toBe('https://discord.com/developers/applications');
  });

  it.each([['https://evil.example'], ['../../evil'], ['settings'], [42], [null]])('rejects %s', (page) => {
    expect(discordPortalUrl(page, '123456789012345678')).toBeNull();
  });

  it('never trusts a malformed application id', () => {
    expect(discordPortalUrl('bot', '1/../../evil')).toBe('https://discord.com/developers/applications');
  });
});

describe('validateAuthorizationUrl for Kick', () => {
  const good = () =>
    new URL(
      'https://id.kick.com/oauth/authorize?client_id=01JKICKCLIENTID0000000000&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A47821%2Foauth%2Fkick%2Fcallback&state=abcdefabcdefabcdef&scope=user%3Aread%20channel%3Aread&code_challenge=' +
        'A'.repeat(43) +
        '&code_challenge_method=S256',
    );

  it("accepts Kick's official authorize page with PKCE and the localhost callback", () => {
    expect(validateAuthorizationUrl('kick', good().toString())).not.toBeNull();
  });

  it.each([
    ['another host', (u: URL) => (u.host = 'kick.com')],
    ['no PKCE challenge', (u: URL) => u.searchParams.delete('code_challenge')],
    ['the plain PKCE method', (u: URL) => u.searchParams.set('code_challenge_method', 'plain')],
    ['a 127.0.0.1 redirect (Kick rewrites it; must be localhost)', (u: URL) => u.searchParams.set('redirect_uri', 'http://127.0.0.1:47821/oauth/kick/callback')],
    ["Discord's callback path", (u: URL) => u.searchParams.set('redirect_uri', 'http://localhost:47821/oauth/discord/callback')],
    ['a remote redirect', (u: URL) => u.searchParams.set('redirect_uri', 'https://evil.example/oauth/kick/callback')],
  ])('rejects %s', (_label, mutate) => {
    const url = good();
    mutate(url);
    expect(validateAuthorizationUrl('kick', url.toString())).toBeNull();
  });
});
