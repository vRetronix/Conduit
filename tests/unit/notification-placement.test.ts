/**
 * Where the theme character stands beside notifications (the dashboard styles), checked against the real proportions of its
 * animation strips (theme/registry.ts): beside the note, never above or over it, inside the window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardCss as css } from '../helpers/dashboard-css';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '../../apps/dashboard/src', p), 'utf8').replace(/\r\n/g, '\n');
const registry = src('theme/registry.ts');

/** The declarations of the rule whose selector is exactly `selector` (not the end of a longer selector list). */
function rule(selector: string): Record<string, string> {
  let at = css.indexOf(`\n${selector} {`);
  while (at > 0 && css[at - 1] === ',') at = css.indexOf(`\n${selector} {`, at + 1);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at));
  return Object.fromEntries([...body.matchAll(/^\s+([a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}
const px = (v: string | undefined) => Number(/^(-?\d+)px$/.exec(v ?? '')?.[1] ?? NaN);

/** frameWidth / frameHeight of a Retronix strip. */
function aspect(kind: 'peek' | 'fall'): number {
  const m = new RegExp(`${kind}: \\{ src: retronix\\w+, alt: '[^']*', sprite: \\{ frames: \\d+, frameWidth: (\\d+), frameHeight: (\\d+)`).exec(registry);
  if (!m) throw new Error(`no ${kind} sprite`);
  return Number(m[1]) / Number(m[2]);
}

describe('notification character placement', () => {
  it('both characters stand beside the note (from its right edge) and share its height: never above it', () => {
    expect(rule('.toast-mascot.peek,\n.toast-mascot.fall')).toEqual({ left: '100%', bottom: '0', height: '100%' });
    expect(rule('.toast-mascot')).toMatchObject({ position: 'absolute', 'z-index': '0', 'pointer-events': 'none' });
    for (const kind of ['peek', 'fall']) expect(Object.keys(rule(`.toast-mascot.${kind}`))).not.toEqual(expect.arrayContaining(['top']));
    expect(rule('.toast-mascot.fall')).not.toHaveProperty('z-index'); // behind the note like the peeking one, never over it
    expect(css).not.toContain(':has(> .toast-mascot.fall)'); // no space reserved above errors (no layout shift)
  });

  it('the peeking character is smaller than before, and both are capped so a tall note doesn’t make them huge', () => {
    expect(px(rule('.toast-mascot.peek')['max-height'])).toBeLessThanOrEqual(90); // was 124 px
    expect(px(rule('.toast-mascot.fall')['max-height'])).toBeLessThanOrEqual(90);
  });

  it('the gutter beside the notes fits the widest character, and the stack stays inside the window', () => {
    const reach = (kind: 'peek' | 'fall') => {
      const r = rule(`.toast-mascot.${kind}`);
      return px(r['max-height']) * aspect(kind) + px(r['margin-left']);
    };
    const stack = rule('.toast-stack:has(.toast-mascot)');
    for (const kind of ['peek', 'fall'] as const) expect(reach(kind)).toBeLessThan(px(stack.right));
    expect(stack.width).toBe(`min(360px, calc(100vw - ${px(stack.right) + 18}px))`);
  });

  it('the falling character comes to rest on a still frame; reduced motion shows a still frame with no movement', () => {
    expect(rule('.toast-mascot.fall').animation).toMatch(/sprite-rest 1ms calc\(var\(--sprite-duration\) \* 2\) forwards/);
    expect(rule('.toast-mascot.peek').animation).toMatch(/steps\(var\(--sprite-frames\), jump-none\) both$/); // played once
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .loading-walker'));
    expect(reduced).toMatch(/\.toast-wrap\.hauled,\s+\.toast-mascot\.peek,\s+\.toast-mascot\.fall \{\s+animation: none;/);
    expect(reduced).toMatch(/\.sprite \{\s+background-position-x: var\(--sprite-still\);/);
  });
});
