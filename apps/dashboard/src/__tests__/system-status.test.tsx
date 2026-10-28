// System status lives in Settings, not on the Dashboard (rendered without a browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConduitBridge } from '@conduit/shared/app/desktop-bridge';

const never = () => new Promise<never>(() => {});
const stubBridge: ConduitBridge = {
  getAppInfo: never,
  getBackendStatus: never,
  onBackendStatus: () => () => {},
  api: { request: never },
  connections: { connect: never },
  kick: { openDeveloperSettings: () => new Promise(() => {}) },
  discord: { installBot: never, openPortal: never },
};

const g = globalThis as { window?: unknown };
beforeEach(() => {
  vi.resetModules();
  g.window = { conduit: stubBridge };
});
afterEach(() => {
  delete g.window;
});

const sections = (html: string) => [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1]);

describe('System status', () => {
  it('is in Settings, after About CONDUIT', async () => {
    const { default: SettingsPage } = await import('../pages/app/SettingsPage');
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(sections(html).slice(0, 2)).toEqual(['About CONDUIT', 'System status']);
    expect(html).toContain('Backend process');
  });

  it('is no longer on the Dashboard', async () => {
    const { DashboardPage } = await import('../pages/app/DashboardPage');
    const html = renderToStaticMarkup(<DashboardPage />);
    expect(html).not.toContain('System status');
  });
});
