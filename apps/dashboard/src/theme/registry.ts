/**
 * The theme registry: every theme CONDUIT can show, as values for the semantic design tokens in styles/base.css. Components
 * use only those tokens (var(--surface), var(--accent), …), so adding a theme means adding one entry to THEMES — no
 * component changes. Unknown or invalid themes fall back to CONDUIT Default.
 */
import { DEFAULT_THEME_ID } from '@conduit/shared/app/appearance';
import retronixFall from '../assets/themes/retronix/fall-sprite.png';
import retronixPeek from '../assets/themes/retronix/peek-sprite.png';
import retronixPose from '../assets/themes/retronix/pose.png';
import retronixWalk from '../assets/themes/retronix/walk-sprite.png';
import snixsnacksVendingMachine from '../assets/themes/snixsnacks/vending-machine.png';

/** The semantic tokens a theme defines (CSS custom properties without the leading "--"). */
export const THEME_TOKENS = [
  /** The app background (behind the panels), the sidebar, and three surface steps (panels, raised, highest). */
  'bg',
  'sidebar',
  'surface',
  'surface-2',
  'surface-3',
  /** Hairline borders and stronger borders (inputs, dialogs). */
  'border',
  'border-strong',
  /** Primary, secondary (muted) and tertiary (faint, disabled) text. */
  'text',
  'muted',
  'faint',
  /** The primary accent (buttons, links, selection), a secondary accent (highlights), and text drawn on the accent. */
  'accent',
  'accent-2',
  'on-accent',
  /** Keyboard focus rings. */
  'focus',
  /** Status colours. */
  'ok',
  'warn',
  'bad',
  /** The two soft light sources behind the glass, and the shadow colour. */
  'glow-1',
  'glow-2',
  'shadow',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface ThemeArt {
  src: string;
  alt: string;
  /**
   * Set when the image is an animation: its frames side by side in one strip (each frameWidth × frameHeight), played
   * left to right over durationMs. 'still' is the frame shown when motion is reduced.
   */
  sprite?: { frames: number; frameWidth: number; frameHeight: number; durationMs: number; still: number };
}

export interface ThemeDefinition {
  /** Stable id, stored in the preferences (never rename an existing one). */
  id: string;
  name: string;
  description: string;
  tokens: Record<ThemeToken, string>;
  /** A starter palette waiting for confirmed brand colours (shown as such in Settings). */
  placeholder?: boolean;
  /** Light themes (dark text on a light background) tell the browser so (form controls, scrollbars). Default: dark. */
  scheme?: 'dark' | 'light';
  /** A drawing style on top of the colours: 'glass' (default: frosted panels) or 'neon' (glass with glowing neon edges). */
  style?: 'glass' | 'neon';
  /**
   * Optional artwork, bundled with the app and used exactly as drawn: the character who peeks out beside notifications
   * (and tumbles in with errors), the loading walker and the Settings preview. peek, fall and walk are animations
   * (sprite strips).
   */
  art?: { peek?: ThemeArt; fall?: ThemeArt; walk?: ThemeArt; preview?: ThemeArt };
}

const STATUS = { ok: '#4cc38a', warn: '#e9b562', bad: '#ec6a6a' };

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'CONDUIT Default',
    description: 'Graphite with ice-blue accents.',
    tokens: {
      bg: '#111315',
      sidebar: '#14171a',
      surface: '#1a1e22',
      'surface-2': '#22272c',
      'surface-3': '#2c3238',
      border: '#282e34',
      'border-strong': '#3a424a',
      text: '#e9eef2',
      muted: '#9ba7b2',
      faint: '#6e7a85',
      accent: '#5cc8f0',
      'accent-2': '#a9dcf2',
      'on-accent': '#04202b',
      focus: '#86d8f6',
      ...STATUS,
      'glow-1': '#3aa7d6',
      'glow-2': '#7c95a8',
      shadow: '#000000',
    },
  },
  {
    id: 'midnight',
    name: 'Theme Name 1',
    description: 'Midnight blue glass with violet accents.',
    tokens: {
      bg: '#0b1020',
      sidebar: '#0d1326',
      surface: '#141b33',
      'surface-2': '#1b2342',
      'surface-3': '#252e55',
      border: '#232b4d',
      'border-strong': '#343f6b',
      text: '#e8eaf7',
      muted: '#a3a9cc',
      faint: '#727aa3',
      accent: '#6d5ce8',
      'accent-2': '#5b9cff',
      'on-accent': '#ffffff',
      focus: '#9a8cff',
      ok: '#4cc38a',
      warn: '#e9b562',
      bad: '#f06b7e',
      'glow-1': '#5a46e0',
      'glow-2': '#2f6bff',
      shadow: '#02040c',
    },
  },
  {
    id: 'retronix',
    name: 'Retronix Theme',
    description: 'Black Olive, Blue Munsell and Sunset Gold glass, with the Retronix character.',
    tokens: {
      bg: '#161513',
      sidebar: '#353531',
      surface: '#24231f',
      'surface-2': '#2e2d29',
      'surface-3': '#3a3934',
      border: '#45443d',
      'border-strong': '#5a584f',
      text: '#f4ead2',
      muted: '#c9bea3',
      faint: '#9a907a',
      accent: '#048ba8',
      'accent-2': '#eec684',
      'on-accent': '#ffffff',
      focus: '#eec684',
      ok: '#5fcf8f',
      warn: '#eec684',
      bad: '#f07a6a',
      'glow-1': '#eec684',
      'glow-2': '#048ba8',
      shadow: '#000000',
    },
    art: {
      // Strips made from the character's green-screen motion clips (Peeking, Falling, Walking), 12 frames a second.
      peek: { src: retronixPeek, alt: 'The Retronix character peeking out', sprite: { frames: 40, frameWidth: 113, frameHeight: 200, durationMs: 3333, still: 10 } },
      fall: { src: retronixFall, alt: 'The Retronix character tumbling', sprite: { frames: 24, frameWidth: 172, frameHeight: 136, durationMs: 2000, still: 0 } },
      walk: { src: retronixWalk, alt: 'The Retronix character walking', sprite: { frames: 16, frameWidth: 78, frameHeight: 108, durationMs: 811, still: 0 } },
      preview: { src: retronixPose, alt: 'The Retronix character' },
    },
  },
  {
    id: 'snixsnacks',
    name: 'SnixSnacks Theme',
    description: 'Neon glass like the SnixSnacks vending machine: purple, blue, cyan and magenta on charcoal.',
    style: 'neon',
    tokens: {
      bg: '#080b1f',
      sidebar: '#0d1029',
      surface: '#1b1d2b',
      'surface-2': '#242738',
      'surface-3': '#2f3347',
      border: '#2a2d45',
      'border-strong': '#3d4163',
      text: '#f2f4ff',
      muted: '#aab0d6',
      faint: '#7a80ab',
      accent: '#8a00ff',
      'accent-2': '#00cfff',
      'on-accent': '#ffffff',
      focus: '#00cfff',
      ok: '#3ddc97',
      warn: '#ffc857',
      bad: '#ff5c8a',
      'glow-1': '#0047ff',
      'glow-2': '#ff00ff',
      shadow: '#000000',
    },
    art: {
      preview: { src: snixsnacksVendingMachine, alt: 'The SnixSnacks vending machine' },
    },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Why a theme definition can't be used (missing or invalid tokens), or null when it is complete. */
export function themeProblem(t: ThemeDefinition): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(t.id)) return `invalid id "${t.id}"`;
  if (!t.name.trim()) return `${t.id}: no name`;
  for (const token of THEME_TOKENS) {
    const v = t.tokens[token];
    if (typeof v !== 'string' || !HEX.test(v)) return `${t.id}: token ${token} must be a #rrggbb colour`;
  }
  return null;
}

export const DEFAULT_THEME: ThemeDefinition = THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;

/** The theme with this id if it exists and is valid, otherwise CONDUIT Default. */
export function resolveTheme(id: string | null | undefined): ThemeDefinition {
  const t = THEMES.find((x) => x.id === id);
  return t && themeProblem(t) === null ? t : DEFAULT_THEME;
}
