import type { Platform } from '@conduit/shared/app/connections';

/**
 * Simplified marks in each platform's brand colour, drawn inline (the CSP allows no remote images). They identify
 * the platform at a glance; they are not the official logo files.
 */
export function PlatformIcon({ platform, size = 40 }: { platform: Platform; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 40 40', role: 'img' as const, 'aria-hidden': true };
  switch (platform) {
    case 'discord':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="10" fill="#5865F2" />
          <path
            d="M28.6 13.4a19 19 0 0 0-4.7-1.4l-.6 1.2a17.6 17.6 0 0 0-5.3 0l-.6-1.2a19 19 0 0 0-4.7 1.4c-3 4.4-3.8 8.7-3.4 13a19 19 0 0 0 5.8 2.9l1.2-2a12.3 12.3 0 0 1-1.9-.9l.5-.4a13.6 13.6 0 0 0 11.7 0l.5.4c-.6.4-1.2.7-1.9.9l1.2 2a19 19 0 0 0 5.8-2.9c.5-5-.8-9.3-3.6-13Z"
            fill="#fff"
          />
          <circle cx="16.2" cy="21.4" r="1.9" fill="#5865F2" />
          <circle cx="23.8" cy="21.4" r="1.9" fill="#5865F2" />
        </svg>
      );
    case 'kick':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="10" fill="#0B0E0F" />
          <path d="M11 10h6v6h2v-2h2v-2h2v-2h6v6h-2v2h-2v2h-2v2h2v2h2v2h2v6h-6v-2h-2v-2h-2v-2h-2v6h-6Z" fill="#53FC18" />
        </svg>
      );
    case 'youtube':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="10" fill="#fff" />
          <rect x="6" y="11" width="28" height="18" rx="5" fill="#FF0000" />
          <path d="M17.5 15.5v9l7.5-4.5Z" fill="#fff" />
        </svg>
      );
    case 'twitch':
      return (
        <svg {...common}>
          <rect width="40" height="40" rx="10" fill="#9146FF" />
          <path d="M13 9.5 11 14v15h5v3h3l3-3h4l5-5V9.5Zm16 13-3 3h-5l-3 3v-3h-4v-14h15Z" fill="#fff" />
          <path d="M23 13.5h2v6h-2Zm-5 0h2v6h-2Z" fill="#fff" />
        </svg>
      );
  }
}
