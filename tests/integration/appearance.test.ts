/** Settings → Appearance & Themes: the saved preference (the theme). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, type Appearance } from '@conduit/shared';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const get = async () => (await h.call<Appearance>('GET', '/api/appearance')).body;
const save = (body: unknown) => h.call<Appearance & { error?: { issues?: Array<{ path: string }> } }>('POST', '/api/appearance', { body });
const stored = (value: string) => h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('appearance', ?, 'x')").run(value);

describe('appearance preference', () => {
  it('starts at CONDUIT Default; a saved theme survives a restart; reset restores the default', async () => {
    expect(await get()).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toEqual({ themeId: 'conduit' });
    expect((await save({ themeId: 'snixsnacks' })).status).toBe(200);
    await h.restart();
    expect(await get()).toEqual({ themeId: 'snixsnacks' });
    expect((await save(DEFAULT_APPEARANCE)).body).toEqual(DEFAULT_APPEARANCE);
  });

  it('validates input; only the appearance key is written (credentials and other settings untouched)', async () => {
    h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('loyalty.settings', ?, 'x')").run(JSON.stringify({ enabled: true }));
    expect((await save({ themeId: '<script>' })).status).toBe(400);
    expect((await save({ themeId: 'midnight', glass: true })).status).toBe(400); // no glass option any more
    expect((await save({ themeId: 'midnight', density: 'compact' })).status).toBe(400); // no density option any more
    await save({ themeId: 'midnight' });
    const rows = h.db.prepare("SELECT key, value FROM app_settings WHERE key IN ('appearance', 'loyalty.settings') ORDER BY key").all();
    expect(rows).toEqual([
      { key: 'appearance', value: JSON.stringify({ themeId: 'midnight' }) },
      { key: 'loyalty.settings', value: JSON.stringify({ enabled: true }) },
    ]);
  });

  it('a preference saved by earlier versions (with glass and density) keeps its theme', async () => {
    stored(JSON.stringify({ themeId: 'retronix', glass: false, density: 'compact' }));
    expect(await get()).toEqual({ themeId: 'retronix' });
  });

  it('a stored value that no longer fits (e.g. edited by hand) is read as the default, never an error', async () => {
    stored('not json');
    expect(await get()).toEqual(DEFAULT_APPEARANCE);
  });
});
