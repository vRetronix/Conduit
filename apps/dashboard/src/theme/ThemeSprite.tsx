import type { CSSProperties } from 'react';
import type { ThemeArt } from './registry';

/**
 * A theme's character art: a still image, or, when the art is a sprite strip, its animation (the strip as a background,
 * stepped frame by frame in CSS: see .sprite in styles/themes.css). Decorative only, so hidden from screen readers. The size
 * comes from the class (its height; the width follows the frame's proportions).
 */
export function ThemeSprite({ art, className }: { art: ThemeArt; className: string }) {
  const s = art.sprite;
  if (!s) return <img className={className} src={art.src} alt="" aria-hidden="true" draggable={false} />;
  const style = {
    backgroundImage: `url("${art.src}")`,
    aspectRatio: `${s.frameWidth} / ${s.frameHeight}`,
    '--sprite-frames': s.frames,
    '--sprite-duration': `${s.durationMs}ms`,
    '--sprite-still': `${(s.still / Math.max(1, s.frames - 1)) * 100}%`,
  } as CSSProperties;
  return <span className={`sprite ${className}`} style={style} aria-hidden="true" />;
}
