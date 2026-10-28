import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from '../../apps/server/src/discord/discord';
import { OAuthError } from '../../apps/server/src/app/types';
import { CLIENT_ID, CLIENT_SECRET, FakeDiscord, PNG_BYTES } from '../helpers/fake-discord';

const REDIRECT = 'http://127.0.0.1:47821/oauth/discord/callback';
const creds = (clientSecret = CLIENT_SECRET) => async () => ({ clientId: CLIENT_ID, clientSecret });
const make = (discord = new FakeDiscord(), overrides: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}) =>
  new DiscordAdapter({ credentials: creds(), version: '9.9.9', fetch: discord.fetch, now: () => new Date('2026-01-01T00:00:00Z'), ...overrides });

describe('DiscordAdapter', () => {
  it('points to the setup wizard (not configuration files) until the application is configured', async () => {
    const problem = await new DiscordAdapter({ credentials: async () => null, version: '1' }).configurationProblem();
    expect(problem).toMatch(/Select Connect to start the setup/);
    expect(problem).not.toMatch(/CONDUIT_|.env/);
    expect(await make().configurationProblem()).toBeNull();
    await expect(new DiscordAdapter({ credentials: async () => null, version: '1' }).authorizationUrl({ state: 's', redirectUri: REDIRECT })).rejects.toMatchObject({
      kind: 'invalid_client',
    });
  });

  it('reads the credentials at use time, so replacing them takes effect without a restart', async () => {
    let id = CLIENT_ID;
    const adapter = new DiscordAdapter({ credentials: async () => ({ clientId: id, clientSecret: CLIENT_SECRET }), version: '1' });
    expect(new URL(await adapter.authorizationUrl({ state: 's', redirectUri: REDIRECT })).searchParams.get('client_id')).toBe(CLIENT_ID);
    id = '999999999999999999';
    expect(new URL(await adapter.authorizationUrl({ state: 's', redirectUri: REDIRECT })).searchParams.get('client_id')).toBe(id);
  });

  it('builds the documented authorization URL with the identify scope only', async () => {
    const url = new URL(await make().authorizationUrl({ state: 'state-123', redirectUri: REDIRECT, codeChallenge: null }));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'identify',
      state: 'state-123',
      redirect_uri: REDIRECT,
      prompt: 'consent',
    });
    expect(url.search).not.toContain('client_secret');
  });

  it('exchanges a code with form encoding and HTTP Basic client authentication', async () => {
    const discord = new FakeDiscord();
    const code = discord.issueCode(REDIRECT);
    const tokens = await make(discord).exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: null });
    const req = discord.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers['user-agent']).toMatch(/^DiscordBot \(https:\/\/github\.com\/vRetronix\/CONDUIT, 9\.9\.9\)/);
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    expect(tokens).toMatchObject({ tokenType: 'Bearer', scopes: ['identify'], expiresAt: '2026-01-08T00:00:00.000Z' });
    expect(tokens.refreshToken).toMatch(/^refresh-token/);
  });

  it('maps an invalid, expired or reused code to invalid_grant', async () => {
    const discord = new FakeDiscord();
    const adapter = make(discord);
    await expect(adapter.exchangeCode({ code: 'bogus', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const code = discord.issueCode(REDIRECT);
    await adapter.exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: null });
    await expect(adapter.exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const other = discord.issueCode('http://127.0.0.1:1/elsewhere');
    await expect(adapter.exchangeCode({ code: other, redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
  });

  it('maps wrong client credentials to invalid_client and outages to network', async () => {
    const discord = new FakeDiscord();
    const code = discord.issueCode(REDIRECT);
    await expect(make(discord, { credentials: creds('wrong-secret-wrong-secret') }).exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_client' });
    discord.offline = true;
    await expect(make(discord).exchangeCode({ code, redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'network' });
  });

  it('confirms the identity: display name, handle and avatar as a data URL', async () => {
    const discord = new FakeDiscord();
    const adapter = make(discord);
    const tokens = await adapter.exchangeCode({ code: discord.issueCode(REDIRECT), redirectUri: REDIRECT, codeVerifier: null });
    const identity = await adapter.fetchIdentity(tokens.accessToken);
    expect(identity).toEqual({
      id: discord.user.id,
      name: 'Retro Live',
      handle: 'retro_live',
      avatarDataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    });
    expect(discord.requests.find((r) => r.url.endsWith('/users/@me'))!.headers.authorization).toBe(`Bearer ${tokens.accessToken}`);
  });

  it('falls back to the username and tolerates a missing or broken avatar', async () => {
    const discord = new FakeDiscord();
    discord.user = { ...discord.user, global_name: null, avatar: null };
    const adapter = make(discord);
    const tokens = await adapter.exchangeCode({ code: discord.issueCode(REDIRECT), redirectUri: REDIRECT, codeVerifier: null });
    expect(await adapter.fetchIdentity(tokens.accessToken)).toMatchObject({ name: 'retro_live', avatarDataUrl: null });
    discord.user = { ...discord.user, avatar: 'ffffffffffffffffffffffffffffffff' }; // CDN 404s for this hash
    expect((await adapter.fetchIdentity(tokens.accessToken)).avatarDataUrl).toBeNull();
  });

  it('reports rejected access tokens as unauthorized, and malformed users as unexpected', async () => {
    const discord = new FakeDiscord();
    await expect(make(discord).fetchIdentity('not-a-valid-token')).rejects.toMatchObject({ kind: 'unauthorized' });
    const adapter = new DiscordAdapter({
      credentials: creds(),
      version: '1',
      fetch: async () => new Response(JSON.stringify({ id: '../../etc', username: 1 }), { status: 200 }),
    });
    await expect(adapter.fetchIdentity('x')).rejects.toBeInstanceOf(OAuthError);
  });

  it('refreshes tokens, and rejects revoked refresh tokens', async () => {
    const discord = new FakeDiscord();
    const adapter = make(discord);
    const first = await adapter.exchangeCode({ code: discord.issueCode(REDIRECT), redirectUri: REDIRECT, codeVerifier: null });
    const second = await adapter.refresh(first.refreshToken!);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(Object.fromEntries(new URLSearchParams(discord.requests.at(-1)!.body))).toEqual({ grant_type: 'refresh_token', refresh_token: first.refreshToken });
    await expect(adapter.refresh(first.refreshToken!)).rejects.toMatchObject({ kind: 'invalid_grant' });
  });

  it('revokes with the documented request', async () => {
    const discord = new FakeDiscord();
    await make(discord).revoke('refresh-xyz', 'refresh_token');
    const req = discord.requests.at(-1)!;
    expect(req.url).toBe('https://discord.com/api/oauth2/token/revoke');
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ token: 'refresh-xyz', token_type_hint: 'refresh_token' });
    expect(discord.revoked).toBe(1);
  });
});
