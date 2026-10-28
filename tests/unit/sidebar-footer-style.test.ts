/** The sidebar footer (Settings, the version, the credit) never scrolls out of view, and nothing scrolls under it. */
import { describe, expect, it } from 'vitest';
import { dashboardCss as css } from '../helpers/dashboard-css';

const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

describe('sidebar footer', () => {
  it('only the navigation scrolls; the footer sits outside it, so nothing can show through a gap under it', () => {
    expect(rule('.sidebar')).toMatch(/overflow: hidden;/);
    expect(rule('.sidebar')).not.toMatch(/overflow-y: auto/);
    const nav = rule('.sidebar nav');
    expect(nav).toMatch(/overflow-y: auto;/);
    expect(nav).toMatch(/min-height: 0;/);
    expect(nav).toMatch(/flex: 1 1 auto;/);
    const footer = rule('.sidebar-footer');
    expect(footer).toMatch(/flex: none;/);
    expect(footer).not.toMatch(/position: sticky/);
  });

  it('shows Settings slightly larger than the other sidebar items', () => {
    expect(rule('.sidebar-footer .nav-item')).toMatch(/font-size: 15px;/);
  });
});
