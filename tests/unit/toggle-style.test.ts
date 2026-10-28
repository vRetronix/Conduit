/** On / off toggles (e.g. custom commands): frosted glass, green when on and red when off. */
import { describe, expect, it } from 'vitest';
import { dashboardCss as css } from '../helpers/dashboard-css';

describe('On / off toggles', () => {
  it('are frosted glass tinted red when off and green when on', () => {
    expect(css).toMatch(/\.switch-onoff input \{\s*--tone: var\(--bad\);[^}]*color-mix\(in srgb, var\(--tone\) \d+%, transparent\);[^}]*backdrop-filter: blur\(/);
    expect(css).toMatch(/\.switch-onoff input:checked \{\s*--tone: var\(--ok\);/);
  });

  it('the knob slides across, without animation when motion is reduced', () => {
    expect(css).toMatch(/\.switch-onoff input:checked::after \{\s*transform: translateX\(18px\);/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.switch-onoff input::after \{\s*transition: none;/);
  });
});
