import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, ConfigError, hostnameFromHostHeader, isLoopbackHost, loadServerConfig } from '@conduit/shared';

const defaults = { dataDir: 'C:/data' };

describe('loadServerConfig', () => {
  it('applies safe defaults', () => {
    const cfg = loadServerConfig({}, defaults);
    expect(cfg).toEqual({
      host: '127.0.0.1',
      port: 47820,
      dataDir: 'C:/data',
      logLevel: 'info',
      logToConsole: true,
      allowedOrigins: [APP_ORIGIN],
      sessionTtlHours: 336,
      sessionIdleHours: 168,
      argon2MemoryKiB: 19_456,
      argon2Passes: 2,
      argon2Parallelism: 1,
      oauthCallbackPort: 47821,
      kickWebhookPort: 47822,
    });
    expect(cfg.setupToken).toBeUndefined();
  });

  it('refuses Argon2 parameters below the OWASP floor', () => {
    expect(() => loadServerConfig({ CONDUIT_ARGON2_MEMORY_KIB: '4096' }, defaults)).toThrow(/CONDUIT_ARGON2_MEMORY_KIB/);
    expect(() => loadServerConfig({ CONDUIT_ARGON2_PASSES: '1' }, defaults)).toThrow(/CONDUIT_ARGON2_PASSES/);
    expect(loadServerConfig({ CONDUIT_ARGON2_MEMORY_KIB: '65536' }, defaults).argon2MemoryKiB).toBe(65_536);
  });

  it('requires the idle timeout not to exceed the session lifetime', () => {
    expect(() => loadServerConfig({ CONDUIT_SESSION_TTL_HOURS: '24', CONDUIT_SESSION_IDLE_HOURS: '48' }, defaults)).toThrow(
      /CONDUIT_SESSION_IDLE_HOURS/,
    );
  });

  it('rejects a short setup token', () => {
    expect(() => loadServerConfig({ CONDUIT_SETUP_TOKEN: 'short' }, defaults)).toThrow(/CONDUIT_SETUP_TOKEN/);
  });

  it('reads and coerces environment variables', () => {
    const cfg = loadServerConfig(
      {
        CONDUIT_HOST: '::1',
        CONDUIT_PORT: '5000',
        CONDUIT_LOG_LEVEL: 'debug',
        CONDUIT_LOG_CONSOLE: 'false',
        CONDUIT_ALLOWED_ORIGINS: 'app://conduit, http://127.0.0.1:5173',
        CONDUIT_DATA_DIR: 'D:/sb',
      },
      defaults,
    );
    expect(cfg.port).toBe(5000);
    expect(cfg.logToConsole).toBe(false);
    expect(cfg.allowedOrigins).toEqual(['app://conduit', 'http://127.0.0.1:5173']);
    expect(cfg.dataDir).toBe('D:/sb');
  });

  it.each(['0.0.0.0', '192.168.1.20', 'example.com', '::'])('refuses non-loopback bind address %s before auth exists', (host) => {
    expect(() => loadServerConfig({ CONDUIT_HOST: host }, defaults)).toThrow(ConfigError);
  });

  it('names the offending environment variable', () => {
    expect(() => loadServerConfig({ CONDUIT_PORT: 'abc' }, defaults)).toThrow(/CONDUIT_PORT/);
  });

  it('rejects malformed origins', () => {
    expect(() => loadServerConfig({ CONDUIT_ALLOWED_ORIGINS: 'http://evil.example/path' }, defaults)).toThrow(
      /CONDUIT_ALLOWED_ORIGINS/,
    );
  });
});

describe('host helpers', () => {
  it('recognises loopback hosts only', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.5.0.9')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.nip.io')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });

  it('strips ports from Host headers', () => {
    expect(hostnameFromHostHeader('127.0.0.1:47820')).toBe('127.0.0.1');
    expect(hostnameFromHostHeader('[::1]:47820')).toBe('[::1]');
    expect(hostnameFromHostHeader('localhost')).toBe('localhost');
  });
});
