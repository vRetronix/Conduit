/**
 * Applies and remembers the appearance (the theme).
 *
 * - The saved preference lives in the backend (Settings → Appearance & Themes), like CONDUIT's other settings. A copy
 *   is kept in this window's local storage only so the right theme is drawn immediately at startup (no flash of the
 *   default theme before the backend answers); the backend's value always wins once it arrives.
 * - A preview applies a theme without saving it; Cancel restores the applied one.
 * - Applying only sets CSS custom properties and data attributes on <html>, so every page updates at once without a
 *   restart.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_APPEARANCE, readAppearance, type Appearance } from '@conduit/shared/app/appearance';
import { api } from '../api';
import { bridge } from '../bridge';
import { resolveTheme, THEME_TOKENS } from './registry';

const CACHE_KEY = 'conduit.appearance';

/**
 * Surface opacity, blur and background glow. Every theme is glossy: frosted and translucent over its colour gradient
 * 'off' gives solid values.
 */
export function glassValues(on: boolean): { surfaceAlpha: string; sidebarAlpha: string; blur: string; glow: string } {
  return on ? { surfaceAlpha: '55%', sidebarAlpha: '50%', blur: '28px', glow: '44%' } : { surfaceAlpha: '100%', sidebarAlpha: '100%', blur: '0px', glow: '0%' };
}

/** Sets the theme's tokens, glass values and style on an element (default: <html>). */
export function applyAppearance(a: Appearance, el: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!el) return;
  const theme = resolveTheme(a.themeId);
  for (const token of THEME_TOKENS) el.style.setProperty(`--${token}`, theme.tokens[token]);
  const style = theme.style ?? 'glass';
  // Glass (gloss) is always on, in every style.
  const glass = glassValues(true);
  el.style.setProperty('--surface-alpha', glass.surfaceAlpha);
  el.style.setProperty('--sidebar-alpha', glass.sidebarAlpha);
  el.style.setProperty('--glass-blur', glass.blur);
  el.style.setProperty('--glow-strength', glass.glow);
  el.dataset.theme = theme.id;
  el.dataset.style = style;
  el.dataset.scheme = theme.scheme ?? 'dark';
  // The window buttons (minimize, maximize, close) are drawn over the page in the installed app: match the theme.
  if (typeof document !== 'undefined' && el === document.documentElement) bridge?.window?.setControlsColor(theme.tokens.text).catch(() => undefined);
}

function readCache(): Appearance | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? readAppearance(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCache(a: Appearance): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(a));
  } catch {
    // Storage unavailable: the backend still has the preference; only the first frame may use the default theme.
  }
}

// ── store ─────────────────────────────────────────────────────────────────────

interface AppearanceState {
  /** The saved appearance (what is shown when nothing is being previewed). */
  applied: Appearance;
  /** A theme being tried out, not saved yet. */
  preview: Appearance | null;
}

let state: AppearanceState = { applied: DEFAULT_APPEARANCE, preview: null };
const listeners = new Set<() => void>();

function set(next: AppearanceState): void {
  state = next;
  applyAppearance(state.preview ?? state.applied);
  for (const l of listeners) l();
}

/** At startup, before the first render: the last appearance seen in this window. */
export function applyCachedAppearance(): void {
  const cached = readCache();
  if (cached) set({ applied: cached, preview: null });
  else applyAppearance(DEFAULT_APPEARANCE);
}

/** Loads the saved appearance from the backend (when it is running) and applies it, unless a preview is open. */
export async function loadAppearance(): Promise<void> {
  const saved = readAppearance(await api<Appearance>('GET', '/api/appearance'));
  writeCache(saved);
  set({ ...state, applied: saved });
}

export function previewAppearance(a: Appearance): void {
  set({ ...state, preview: a });
}

export function cancelPreview(): void {
  set({ ...state, preview: null });
}

/** Saves an appearance (the theme) and applies it; ends any preview. */
export async function saveAppearance(a: Appearance): Promise<Appearance> {
  const saved = readAppearance(await api<Appearance>('POST', '/api/appearance', a));
  writeCache(saved);
  set({ applied: saved, preview: null });
  return saved;
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
