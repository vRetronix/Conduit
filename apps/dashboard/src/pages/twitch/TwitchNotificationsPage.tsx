import { StreamNotificationsPage } from '../kick/KickNotificationsPage';

/** Twitch Notifications: announce in Discord when Twitch streamers go live (the same page as Kick's, for Twitch). */
export function TwitchNotificationsPage() {
  return <StreamNotificationsPage platform="twitch" />;
}
