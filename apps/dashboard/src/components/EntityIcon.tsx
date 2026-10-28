import { useState } from 'react';

/**
 * An account, bot or server picture: the real image from Discord (a data: URL supplied by the backend) when there is
 * one, otherwise — or if it fails to load — the initials of the real name. Never a stand-in image.
 */
export function EntityIcon({
  src,
  name,
  shape = 'circle',
  size = 28,
}: {
  src?: string | null;
  name: string;
  shape?: 'circle' | 'rounded';
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const className = `account-avatar entity-icon${shape === 'rounded' ? ' entity-icon-rounded' : ''}`;
  const style = { width: size, height: size };
  if (src && !failed)
    return <img className={className} src={src} alt="" width={size} height={size} style={style} onError={() => setFailed(true)} />;
  return (
    <span className={`${className} account-avatar-initial`} style={{ ...style, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {initials(name, shape === 'rounded')}
    </span>
  );
}

/** "R" for a user or bot; Discord-style "RS" (first letters of the first words) for a server. */
export function initials(name: string, server: boolean): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = server ? words.slice(0, 2).map((w) => [...w][0]) : [[...words[0]!][0]];
  return letters.join('').toUpperCase();
}
