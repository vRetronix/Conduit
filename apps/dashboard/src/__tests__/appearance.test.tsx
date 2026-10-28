// Appearance & Themes: the theme registry, applying an appearance, and the Settings section (react-dom/server, no browser).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE, readAppearance } from '@conduit/shared/app/appearance';
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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g2, b2] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g2! + 0.0722 * b2!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** A stand-in for <html>: records the CSS custom properties and data attributes that were set. */
function fakeRoot() {
  const props = new Map<string, string>();
  return { props, el: { style: { setProperty: (k: string, v: string) => props.set(k, v) }, dataset: {} as Record<string, string> } as unknown as HTMLElement };
}

describe('theme registry', () => {
  it('has the four themes, each complete and valid, with unique ids; CONDUIT Default first', async () => {
    const { THEMES, themeProblem, DEFAULT_THEME } = await import('../theme/registry');
    expect(THEMES.map((t) => t.name)).toEqual(['CONDUIT Default', 'Theme Name 1', 'Retronix Theme', 'SnixSnacks Theme']);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) expect(themeProblem(t)).toBeNull();
    // CONDUIT Default uses what were Theme Name 2's colours (graphite and ice blue).
    expect(DEFAULT_THEME).toMatchObject({ id: 'conduit', tokens: { bg: '#111315', accent: '#5cc8f0', 'on-accent': '#04202b' } });
    expect(THEMES.filter((t) => t.placeholder)).toEqual([]);
    const snix = THEMES.find((t) => t.id === 'snixsnacks')!;
    expect(snix).toMatchObject({ style: 'neon', tokens: { bg: '#080b1f', surface: '#1b1d2b', accent: '#8a00ff', 'accent-2': '#00cfff', 'glow-1': '#0047ff', 'glow-2': '#ff00ff' } });
    expect(snix.art?.preview?.src).toMatch(/vending-machine.*\.png/);
    const retronix = THEMES.find((t) => t.id === 'retronix')!;
    expect(retronix.style ?? 'glass').toBe('glass'); // no rubberhose paper style: glass like the others
    expect(retronix).toMatchObject({ tokens: { sidebar: '#353531', accent: '#048ba8', 'accent-2': '#eec684' } });
    // The character art, used as drawn (bundled image files); his motion is animated from strips of his own clips.
    expect(Object.keys(retronix.art ?? {}).sort()).toEqual(['fall', 'peek', 'preview', 'walk']);
    for (const a of Object.values(retronix.art ?? {})) expect(a.src).toMatch(/.png/);
    for (const k of ['peek', 'fall', 'walk'] as const) {
      const s = retronix.art?.[k]?.sprite;
      expect(s && s.frames > 1 && s.durationMs > 0 && s.still >= 0 && s.still < s.frames).toBe(true);
    }
  });

  it('unknown, removed or invalid themes fall back to CONDUIT Default', async () => {
    const { resolveTheme, themeProblem, THEMES } = await import('../theme/registry');
    expect(resolveTheme('no-such-theme').id).toBe('conduit');
    expect(resolveTheme(null).id).toBe('conduit');
    expect(resolveTheme('midnight').id).toBe('midnight');
    expect(resolveTheme('graphite').id).toBe('conduit'); // Theme Name 2 became CONDUIT Default's colours
    const broken = { ...THEMES[1]!, tokens: { ...THEMES[1]!.tokens, accent: 'red' } };
    expect(themeProblem(broken)).toMatch(/accent must be a #rrggbb colour/);
  });

  it('every theme keeps text readable (WCAG contrast)', async () => {
    const { THEMES } = await import('../theme/registry');
    for (const t of THEMES) {
      const k = t.tokens;
      expect(contrast(k.text, k.surface), `${t.id} text`).toBeGreaterThanOrEqual(7);
      expect(contrast(k.text, k.bg), `${t.id} text on background`).toBeGreaterThanOrEqual(7);
      expect(contrast(k.muted, k.surface), `${t.id} muted`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(k.faint, k.surface), `${t.id} faint`).toBeGreaterThanOrEqual(3);
      for (const s of ['ok', 'warn', 'bad'] as const) expect(contrast(k[s], k.surface), `${t.id} ${s}`).toBeGreaterThanOrEqual(4.5);
      // Button text: AA, except on the brand's Blue Munsell (CONDUIT Default, Retronix), kept as established (3.99:1).
      expect(contrast(k['on-accent'], k.accent), `${t.id} button text`).toBeGreaterThanOrEqual(k.accent === '#048ba8' ? 3.9 : 4.5);
    }
  });
});

describe('applying an appearance', () => {
  it('sets every theme token and always-on glass on <html>', async () => {
    const { applyAppearance } = await import('../theme/appearance');
    const { THEME_TOKENS, THEMES } = await import('../theme/registry');
    const { props, el } = fakeRoot();
    applyAppearance({ themeId: 'midnight' }, el);
    for (const token of THEME_TOKENS) expect(props.get(`--${token}`)).toBe(THEMES.find((t) => t.id === 'midnight')!.tokens[token]);
    expect([props.get('--surface-alpha'), props.get('--glass-blur'), props.get('--glow-strength')]).toEqual(['55%', '28px', '44%']);
    expect(el.dataset).toMatchObject({ theme: 'midnight', style: 'glass' });
    expect(el.dataset).not.toHaveProperty('density');
  });

  it('an unknown theme applies CONDUIT Default; SnixSnacks uses the neon style', async () => {
    const { applyAppearance } = await import('../theme/appearance');
    const { props, el } = fakeRoot();
    applyAppearance({ themeId: 'gone' }, el);
    expect(props.get('--accent')).toBe('#5cc8f0');
    expect(el.dataset).toMatchObject({ theme: 'conduit' });
    applyAppearance({ themeId: 'snixsnacks' }, el);
    expect(el.dataset).toMatchObject({ theme: 'snixsnacks', style: 'neon' });
    expect(props.get('--glass-blur')).toBe('28px');
  });

  it('Retronix is glass like the other themes, with no paper tokens', async () => {
    const { applyAppearance } = await import('../theme/appearance');
    const { props, el } = fakeRoot();
    applyAppearance({ themeId: 'retronix' }, el);
    expect(el.dataset).toMatchObject({ theme: 'retronix', style: 'glass', scheme: 'dark' });
    expect([props.get('--surface-alpha'), props.get('--glass-blur'), props.get('--accent'), props.get('--paper')]).toEqual(['55%', '28px', '#048ba8', undefined]);
  });

  it('stored values: earlier glass/density settings are ignored; anything else that no longer fits gives the defaults', () => {
    expect(readAppearance({ themeId: 'midnight', glass: false, density: 'compact' })).toEqual({ themeId: 'midnight' });
    expect(readAppearance({ themeId: 'midnight', glass: 50 })).toEqual({ themeId: 'midnight' });
    expect(readAppearance({ themeId: 'Not Valid!' })).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance({ themeId: 'midnight', other: true })).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('Settings → Appearance & Themes', () => {
  it('lists the themes with previews and actions, a test notification, and reset (confirm first); no glass or density options', async () => {
    const { AppearanceSection } = await import('../pages/app/AppearanceSection');
    const html = renderToStaticMarkup(<AppearanceSection />);
    const t = text(html);
    expect(t).toContain('Appearance & Themes');
    for (const name of ['CONDUIT Default', 'Theme Name 1', 'Retronix Theme', 'SnixSnacks Theme']) expect(t).toContain(name);
    expect(t).not.toContain('Theme Name 2');
    expect((html.match(/class="theme-mini-art"/g) ?? []).length).toBe(2); // the Retronix character and the SnixSnacks vending machine
    expect(t).toMatch(/CONDUIT Default .* Applied/);
    expect((t.match(/Preview Apply/g) ?? []).length).toBe(4);
    for (const gone of ['Glass', 'Interface density', 'Compact', 'Spacious']) expect(t).not.toContain(gone);
    expect(t).toContain('Show a test notification');
    expect(t).toContain('Test an error');
    expect(t).toContain('Reset to defaults…');
    expect(html).not.toContain('type="range"');
    for (const gone of ['Panel title', 'Sample input', 'Primary', 'Secondary', 'Failed']) expect(t).not.toContain(gone); // no sample panel
  });
});

describe('theme character art', () => {
  it('a sprite strip renders as a stepped animation; a still image as an image', async () => {
    const { ThemeSprite } = await import('../theme/ThemeSprite');
    const strip = renderToStaticMarkup(
      <ThemeSprite art={{ src: '/w.png', alt: '', sprite: { frames: 16, frameWidth: 78, frameHeight: 108, durationMs: 811, still: 5 } }} className="loading-walker" />,
    );
    expect(strip).toContain('class="sprite loading-walker"');
    expect(strip).toContain('aria-hidden="true"');
    for (const part of ['background-image:url(&quot;/w.png&quot;)', 'aspect-ratio:78 / 108', '--sprite-frames:16', '--sprite-duration:811ms', '--sprite-still:33.33'])
      expect(strip).toContain(part);
    const still = renderToStaticMarkup(<ThemeSprite art={{ src: '/p.png', alt: 'x' }} className="toast-mascot peek" />);
    expect(still).toContain('<img class="toast-mascot peek" src="/p.png" alt="" aria-hidden="true"');
  });
});

describe('page loading state', () => {
  it('shows the indicator with what is loading underneath, announced as a status', async () => {
    const { Loading } = await import('../components/forms');
    const html = renderToStaticMarkup(<Loading label="Loading giveaways…" />);
    expect(html).toMatch(/^<div class="loading muted" role="status">.*<span class="loading-label">Loading giveaways…<\/span><\/div>$/);
    expect(html.indexOf('loading-label')).toBeGreaterThan(html.search(/spinner|loading-walker/));
  });
});
