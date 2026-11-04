/** 'footer': pinned to the bottom of the sidebar, outside the groups. */
export type SectionGroup = 'overview' | 'discord' | 'kick' | 'twitch' | 'youtube' | 'planned' | 'footer';

export interface Section {
  id: string;
  label: string;
  group: SectionGroup;
  /** Not built yet: shown with a gray "Soon" and not clickable. */
  soon?: true;
}

/**
 * Sidebar groups, in order. A group without a label has no heading (its items stand alone); platform groups carry
 * their platform's colour mark; a Soon group is only its heading, with a gray "Soon".
 */
export const SECTION_GROUPS: ReadonlyArray<{ id: SectionGroup; label?: string; platform?: 'discord' | 'kick' | 'twitch' | 'youtube'; soon?: true }> = [
  { id: 'overview' },
  { id: 'discord', label: 'Discord', platform: 'discord' },
  { id: 'kick', label: 'Kick', platform: 'kick' },
  { id: 'twitch', label: 'Twitch', platform: 'twitch' },
  { id: 'youtube', label: 'YouTube', platform: 'youtube', soon: true },
  { id: 'planned' },
];

/** Every page, in sidebar order. Each feature has exactly one place: features on several platforms are under Overview. */
export const SECTIONS: readonly Section[] = [
  { id: 'dashboard', label: 'Dashboard', group: 'overview' },
  { id: 'commands', label: 'Commands', group: 'overview' },
  { id: 'giveaways', label: 'Giveaways', group: 'overview' },
  { id: 'timed-messages', label: 'Timed Messages', group: 'overview' },
  // The id is kept from when this page was "Discord Moderation", so remembered pages keep working.
  { id: 'discord-moderation', label: 'Discord Bot', group: 'discord' },
  { id: 'sticky-messages', label: 'Sticky Messages', group: 'discord' },
  { id: 'embed-creator', label: 'Embed Creator', group: 'discord' },
  { id: 'loyalty', label: 'Loyalty & Rewards', group: 'discord' },
  { id: 'kick-moderation', label: 'Kick Moderation', group: 'kick' },
  { id: 'kick-notifications', label: 'Kick Notifications', group: 'kick' },
  { id: 'kick-clips', label: 'Clips', group: 'kick' },
  { id: 'twitch-notifications', label: 'Twitch Notifications', group: 'twitch' },
  { id: 'twitch-moderation', label: 'Twitch Moderation', group: 'twitch', soon: true },
  { id: 'overlays', label: 'OBS Overlays', group: 'planned', soon: true },
  { id: 'settings', label: 'Settings', group: 'footer' },
];
