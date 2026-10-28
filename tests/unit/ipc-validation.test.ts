import { describe, expect, it } from 'vitest';
import { connectRequestSchema, validateApiRequest, validateControlsColor, validateKickClipUrl } from '../../apps/desktop/src/ipc-validation';

describe('validateApiRequest (renderer → main API proxy allow-list)', () => {
  it.each([
    ['GET', '/api/health'],
    ['GET', '/api/connections'],
    ['POST', '/api/connections/discord/cancel'],
    ['POST', '/api/connections/kick/disconnect'],
    ['GET', '/api/discord/setup'],
    ['POST', '/api/discord/application'],
    ['POST', '/api/discord/install/cancel'],
    ['POST', '/api/discord/installation/check'],
    ['POST', '/api/discord/bot/restart'],
    ['POST', '/api/discord/commands/register'],
    ['POST', '/api/discord/reset'],
    ['GET', '/api/kick/setup'],
    ['POST', '/api/kick/application'],
    ['POST', '/api/kick/chatbot'],
    ['POST', '/api/kick/chat/send'],
    ['POST', '/api/kick/chat/retry'],
    ['GET', '/api/commands/discord'],
    ['GET', '/api/commands/kick'],
    ['POST', '/api/commands/kick'],
    ['PATCH', '/api/commands/discord/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['DELETE', '/api/commands/kick/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['GET', '/api/moderation'],
    ['POST', '/api/moderation/lookup'],
    ['POST', '/api/moderation/actions'],
    ['POST', '/api/moderation/automod'],
    ['GET', '/api/moderation/kick'],
    ['GET', '/api/moderation/discord'],
    ['GET', '/api/timed-messages'],
    ['POST', '/api/timed-messages'],
    ['PATCH', '/api/timed-messages/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['DELETE', '/api/timed-messages/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['POST', '/api/timed-messages/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b/duplicate'],
    ['POST', '/api/alerts/query'],
    ['GET', '/api/appearance'],
    ['POST', '/api/appearance'],
    ['GET', '/api/loyalty'],
    ['POST', '/api/loyalty/settings'],
    ['GET', '/api/loyalty/roles'],
    ['POST', '/api/loyalty/members/query'],
    ['POST', '/api/loyalty/members/history'],
    ['POST', '/api/loyalty/members/points'],
    ['POST', '/api/loyalty/members/xp'],
    ['POST', '/api/loyalty/role-rewards'],
    ['DELETE', '/api/loyalty/role-rewards/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['POST', '/api/loyalty/rewards'],
    ['PATCH', '/api/loyalty/rewards/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['DELETE', '/api/loyalty/rewards/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['POST', '/api/loyalty/redemptions/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b/fulfill'],
    ['POST', '/api/loyalty/redemptions/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b/reject'],
    ['GET', '/api/discord/stickies'],
    ['POST', '/api/discord/stickies'],
    ['PATCH', '/api/discord/stickies/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['DELETE', '/api/discord/stickies/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['GET', '/api/notifications'],
    ['POST', '/api/notifications'],
    ['POST', '/api/notifications/check'],
    ['PATCH', '/api/notifications/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    ['GET', '/api/discord/logging'],
    ['POST', '/api/discord/logging'],
    ['GET', '/api/discord/embeds'],
    ['POST', '/api/discord/embeds/test'],
  ])('allows %s %s', (method, path) => {
    expect(validateApiRequest({ method, path })).toEqual({ method, path });
  });

  it.each([
    // Connect returns an authorization URL, so only the main process may call it (via connections.connect IPC).
    ['POST', '/api/connections/discord/connect'],
    // Same for adding the bot (main process only, via the discord.installBot IPC).
    ['POST', '/api/discord/install'],
    ['GET', '/api/discord/application'],
    ['POST', '/api/discord/setup'],
    ['POST', '/api/discord/bot/restart/x'],
    // Command status is read-only for the renderer: it can only ask the backend to register.
    ['GET', '/api/discord/commands/register'],
    ['POST', '/api/discord/commands'],
    // Kick: connecting returns a URL, so it is main-process only; nothing else is reachable.
    ['POST', '/api/connections/kick/connect'],
    ['GET', '/api/kick/application'],
    ['POST', '/api/kick/setup'],
    ['POST', '/api/moderation'],
    ['GET', '/api/moderation/actions'],
    ['POST', '/api/moderation/actions/x'],
    ['DELETE', '/api/moderation/automod'],
    ['GET', '/api/automations'], // retired
    ['POST', '/api/automations'],
    ['DELETE', '/api/timed-messages/not-an-id'],
    ['GET', '/api/loyalty?platform=kick'],
    ['POST', '/api/loyalty/redemptions/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b/delete'],
    ['DELETE', '/api/loyalty/rewards/not-an-id'],
    ['POST', '/api/loyalty/viewers/adjust'],
    ['POST', '/api/loyalty/members/kick'],
    ['PATCH', '/api/discord/logging'],
    ['DELETE', '/api/notifications/check'],
    ['POST', '/api/discord/stickies/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b/run'],
    ['GET', '/api/moderation/youtube'],
    ['GET', '/api/kick/chat/send'],
    ['POST', '/api/kick/chat'],
    ['POST', '/api/kick/chat/hello'], // the greeting on connect was removed
    ['GET', '/api/kick/commands'], // replaced by /api/commands/kick
    ['GET', '/api/commands/youtube'],
    ['DELETE', '/api/commands/kick'],
    ['PATCH', '/api/commands/kick/../setup'],
    ['DELETE', '/api/commands/kick/not-an-id'],
    ['POST', '/api/commands/kick/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b'],
    // The dormant account API is unreachable from the renderer.
    ['POST', '/api/setup'],
    ['GET', '/api/setup/status'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/auth/session'],
    ['POST', '/api/me/password'],
    ['GET', '/api/profiles'],
    ['GET', '/api/admin/users'],
    // Wrong methods on allowed paths.
    ['DELETE', '/api/connections'],
    ['GET', '/api/connections/kick/connect'],
    ['PATCH', '/api/connections/kick/disconnect'],
    // Path tricks.
    ['GET', '/api/connections/'],
    ['GET', '/api/connections?x=1'],
    ['POST', '/api/connections/../setup/connect'],
    ['POST', '/api/connections/KICK/disconnect'],
    ['POST', '/api/connections/kick/disconnect/extra'],
    ['GET', 'http://evil.example/api/connections'],
    ['GET', '//evil.example/api/connections'],
    ['GET', '/API/connections'],
  ])('blocks %s %s', (method, path) => {
    expect(validateApiRequest({ method, path })).toBeNull();
  });

  it('rejects unknown methods, extra fields, GET bodies and oversized bodies', () => {
    expect(validateApiRequest({ method: 'PUT', path: '/api/connections' })).toBeNull();
    expect(validateApiRequest({ method: 'GET', path: '/api/connections', localKey: 'x' })).toBeNull();
    expect(validateApiRequest({ method: 'GET', path: '/api/connections', body: {} })).toBeNull();
    expect(validateApiRequest({ method: 'POST', path: '/api/connections/kick/disconnect', body: { x: 'a'.repeat(200 * 1024) } })).toBeNull();
    expect(validateApiRequest(null)).toBeNull();
    expect(validateApiRequest('GET /api/connections')).toBeNull();
  });
});

describe('connectRequestSchema (connections.connect IPC)', () => {
  it('accepts a platform and an account role, defaulting to the main account', () => {
    expect(connectRequestSchema.parse({ platform: 'kick', role: 'bot' })).toEqual({ platform: 'kick', role: 'bot' });
    expect(connectRequestSchema.parse({ platform: 'discord' })).toEqual({ platform: 'discord', role: 'primary' });
  });

  it.each([[{ platform: 'kick', role: 'admin' }], [{ platform: 'evil' }], [{ platform: 'kick', role: 'bot', extra: 1 }], ['kick'], [null]])('rejects %j', (input) => {
    expect(connectRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('Settings → Backup & Logs API paths', () => {
  it.each([
    ['GET', '/api/backups'],
    ['POST', '/api/backups'],
    ['POST', '/api/backups/verify'],
    ['POST', '/api/backups/restore'],
    ['PATCH', '/api/backups/settings'],
    ['POST', '/api/logs/query'],
  ])('allows %s %s', (method, path) => {
    expect(validateApiRequest({ method, path, ...(method === 'GET' ? {} : { body: {} }) })).not.toBeNull();
  });

  it.each([
    ['DELETE', '/api/backups'],
    ['GET', '/api/backups/../logs'],
    ['POST', '/api/backups/restore/now'],
    ['GET', '/api/logs/query'],
    ['DELETE', '/api/logs'],
  ])('blocks %s %s', (method, path) => {
    expect(validateApiRequest({ method, path })).toBeNull();
  });
});

describe('Kick → Clips paths and links', () => {
  it.each([
    ['GET', '/api/kick/clips'],
    ['POST', '/api/kick/clips'],
    ['POST', '/api/kick/clips/refresh'],
    ['POST', '/api/kick/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY/post'],
    ['POST', '/api/kick/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY/save'],
  ])('allows %s %s', (method, path) => {
    expect(validateApiRequest({ method, path, ...(method === 'GET' ? {} : { body: {} }) })).not.toBeNull();
  });

  it.each([
    ['POST', '/api/kick/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY/delete'],
    ['POST', '/api/kick/clips/login'],
    ['POST', '/api/kick/clips/../backups/restore'],
    ['GET', '/api/kick/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY/save'],
  ])('blocks %s %s', (method, path) => {
    expect(validateApiRequest({ method, path })).toBeNull();
  });

  it('opens only kick.com clip pages in the browser', () => {
    const ok = 'https://kick.com/retrolive/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY';
    expect(validateKickClipUrl(ok)).toBe(ok);
    for (const bad of [
      'http://kick.com/retrolive/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY',
      'https://kick.com.evil.example/a/clips/clip_01M5PG6ZDTG3Q4Z1FFPWDG50TY',
      'https://kick.com/retrolive',
      'file:///C:/Windows/system32/calc.exe',
      42,
    ])
      expect(validateKickClipUrl(bad)).toBeNull();
  });
});

describe('validateControlsColor (window button colour from the theme)', () => {
  it('accepts a #rrggbb colour only', () => {
    expect(validateControlsColor('#e9eef2')).toBe('#e9eef2');
    expect(validateControlsColor('#E9EEF2')).toBe('#E9EEF2');
    for (const bad of ['e9eef2', '#fff', '#e9eef2ff', 'red', 'rgb(1,2,3)', '#e9eef2; x', '', 42, null, undefined]) expect(validateControlsColor(bad)).toBeNull();
  });
});
