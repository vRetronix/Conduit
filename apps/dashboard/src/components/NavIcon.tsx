/** Small line icons for the sidebar (16px, currentColor). Decorative: the label next to each icon names the section. */
const PATHS: Record<string, string> = {
  dashboard: 'M3 3h4v6H3zM9 3h4v3H9zM9 8h4v5H9zM3 11h4v2H3z',
  commands: 'M3 4l3 3-3 3M8 11h5',
  'kick-moderation': 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z M6 8l1.5 1.5L10.5 6.5',
  'discord-moderation': 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z M6 8l1.5 1.5L10.5 6.5',
  'youtube-moderation': 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z M6 8l1.5 1.5L10.5 6.5',
  'twitch-moderation': 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z M6 8l1.5 1.5L10.5 6.5',
  'timed-messages': 'M8 14A5.5 5.5 0 108 3a5.5 5.5 0 000 11zM8 5.5V8.5l2 1.5M6.5 1.5h3',
  'sticky-messages': 'M5 2h6v4l2 3H3l2-3zM8 9v5',
  'embed-creator': 'M3 3h10v10H3zM5.5 3v10M7.5 6h3.5M7.5 8.5h2.5',
  'kick-notifications': 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3',
  'twitch-notifications': 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3',
  'youtube-notifications': 'M4 11V7a4 4 0 018 0v4l1 1.5H3zM6.5 14h3',
  // A clapperboard.
  'kick-clips': 'M2.5 7h11v6.5h-11zM2.5 4.5h11V7h-11zM5.5 4.5L7 7M9 4.5l1.5 2.5',
  giveaways: 'M2.5 6h11v2.5h-11zM3.5 8.5h9V14h-9zM8 6v8M8 6C6.5 6 4.5 5 5.5 3.5S8 4.5 8 6zM8 6c1.5 0 3.5-1 2.5-2.5S8 4.5 8 6z',
  loyalty: 'M8 2l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.3l4-.6z',
  overlays: 'M2.5 3.5h11v8h-11zM6 14h4M8 11.5V14',
  settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
};

export function NavIcon({ id }: { id: string }) {
  const d = PATHS[id] ?? 'M3 3h10v10H3z';
  return (
    <svg className="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
