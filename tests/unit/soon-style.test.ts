/** "Soon" labels are styled gray everywhere (sidebar, badges, lists), never with the accent colour. */
import { describe, expect, it } from 'vitest';
import { dashboardCss as css } from '../helpers/dashboard-css';

describe('Soon styling', () => {
  it('uses the muted gray token for every Soon label', () => {
    expect(css).toMatch(/--soon: #6b6a63;/);
    expect(css).toMatch(/\.nav-phase,\s*\.badge-soon \{\s*color: var\(--soon\) !important;/);
  });

  it('Soon navigation items are not interactive', () => {
    expect(css).toMatch(/\.nav-item\.nav-soon \{\s*color: var\(--faint\);\s*cursor: default;/);
  });
});
