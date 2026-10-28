/** 'footer': pinned to the bottom of the sidebar (always visible), next to the version, instead of in a group. */
export type SectionGroup = 'overview' | 'discord' | 'kick' | 'twitch' | 'youtube' | 'planned' | 'footer';

export interface Section {
  id: string;
  label: string;
  /** Development phase that delivers this section; null when available now. Sections with a phase show "Soon". */
  phase: number | null;
  summary: string;
  /** Where the section sits in the sidebar: Overview (the Dashboard and features on both platforms), then by platform. */
  group: SectionGroup;
}

/** Sidebar groups, in order. Platform groups carry their platform's colour mark. */
export const SECTION_GROUPS: ReadonlyArray<{ id: SectionGroup; label: string; platform?: 'discord' | 'kick' | 'twitch' | 'youtube' }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'discord', label: 'Discord', platform: 'discord' },
  { id: 'kick', label: 'Kick', platform: 'kick' },
  { id: 'twitch', label: 'Twitch', platform: 'twitch' },
  { id: 'youtube', label: 'YouTube', platform: 'youtube' },
  { id: 'planned', label: 'Coming later' },
];

/**
 * Navigation for the whole product. Each feature has exactly one place. Features on both platforms (Commands,
 * Giveaways, Timed Messages) are under Overview; Sticky Messages and Loyalty & Rewards are Discord-only; Discord Logging is part of Discord Moderation.
 */
export const SECTIONS: readonly Section[] = [
  // Platform connections (Discord bot, Kick main and chatbot accounts) are managed only from the Dashboard's Connect
  // Accounts cards: their status, and Manage / Continue Setup, which open each platform's setup wizard.
  { id: 'dashboard', label: 'Dashboard', phase: null, group: 'overview', summary: 'Connect and manage your platform accounts.' },
  { id: 'commands', label: 'Commands', phase: null, group: 'overview', summary: 'Default and custom commands for Discord and Kick, with variables, and the Discord bot’s status.' },
  {
    id: 'giveaways',
    label: 'Giveaways',
    phase: null,
    group: 'overview',
    summary: 'One giveaway runs at a time; Viewers enter with !enter in your Kick chat or the Enter Giveaway button on Discord.',
  },
  {
    id: 'timed-messages',
    label: 'Timed Messages',
    phase: null,
    group: 'overview',
    summary: 'Messages repeated in Kick chat or a Discord channel — every X minutes, after X chat messages, or both.',
  },
  {
    // The id is kept from when this page was "Discord Moderation", so links and remembered pages keep working.
    id: 'discord-moderation',
    label: 'Discord Bot',
    phase: null,
    group: 'discord',
    summary: 'Your Discord bot: Settings, protection and logs.',
  },
  { id: 'sticky-messages', label: 'Sticky Messages', phase: null, group: 'discord', summary: 'Messages kept at the bottom of Discord channels.' },
  {
    id: 'embed-creator',
    label: 'Embed Creator',
    phase: null,
    group: 'discord',
    summary: 'Build Discord messages with embeds (visually or as JSON), send them as your bot and edit them later.',
  },
  {
    id: 'loyalty',
    label: 'Loyalty & Rewards',
    phase: null,
    group: 'discord',
    summary: 'Discord XP, levels and role rewards, plus a separate points balance, rewards and redemptions.',
  },
  { id: 'kick-moderation', label: 'Kick Moderation', phase: null, group: 'kick', summary: 'Automated protection for your Kick chat, and its logs.' },
  { id: 'kick-notifications', label: 'Kick Notifications', phase: null, group: 'kick', summary: 'Discord posts when Kick streamers — yours or anyone’s — go live.' },
  { id: 'kick-clips', label: 'Clips', phase: null, group: 'kick', summary: 'Your channel’s Kick clips: posted in Discord with watch buttons, and saved on this PC.' },
  { id: 'twitch-notifications', label: 'Twitch Notifications', phase: 16, group: 'twitch', summary: 'Discord posts when Twitch streamers go live. Planned: nothing is connected yet.' },
  { id: 'twitch-moderation', label: 'Twitch Moderation', phase: 16, group: 'twitch', summary: 'Moderation for Twitch chat. Planned: nothing is connected and no Twitch permissions are requested yet.' },
  { id: 'youtube-notifications', label: 'YouTube Notifications', phase: 16, group: 'youtube', summary: 'Discord posts for YouTube live streams and uploads. Planned: nothing is connected yet.' },
  { id: 'youtube-moderation', label: 'YouTube Moderation', phase: 16, group: 'youtube', summary: 'Moderation for YouTube live chat. Planned: nothing is connected and no YouTube permissions are requested yet.' },
  { id: 'overlays', label: 'OBS Overlays', phase: 19, group: 'planned', summary: 'Browser-source overlays secured with scoped access tokens.' },
  { id: 'settings', label: 'Settings', phase: null, group: 'footer', summary: 'This copy of CONDUIT: version, system status, appearance, backups, logs and release notes.' },
];
