/**
 * Appearance preference (Settings → Appearance & Themes): the theme. Stored by the backend with CONDUIT's other
 * settings (so it survives restarts, updates and backups). The theme definitions themselves live in the dashboard's
 * theme registry; an unknown theme id falls back to CONDUIT Default.
 *
 * This module has no dependencies (the dashboard applies the appearance before its first frame, so it must stay
 * small); the backend validates input with appearanceSchema (appearance-schema.ts), which matches these rules.
 */

export const DEFAULT_THEME_ID = 'conduit';
export const THEME_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

export interface Appearance {
  /** A theme id from the registry (a missing or removed theme falls back to CONDUIT Default). */
  themeId: string;
}

export const DEFAULT_APPEARANCE: Appearance = { themeId: DEFAULT_THEME_ID };

/** Settings that earlier versions saved and that no longer exist (the glass effect, interface density): ignored. */
const RETIRED_KEYS = ['glass', 'density'];

/** Reads a stored or received value; anything that doesn't fit gives the defaults (never an error). */
export function readAppearance(raw: unknown): Appearance {
  if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE;
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).some((k) => k !== 'themeId' && !RETIRED_KEYS.includes(k));
  const themeId = r.themeId ?? DEFAULT_APPEARANCE.themeId;
  return !extra && typeof themeId === 'string' && THEME_ID_PATTERN.test(themeId) ? { themeId } : DEFAULT_APPEARANCE;
}
