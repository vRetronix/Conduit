/** Discord permissions CONDUIT asks for when the bot is added to a server. No dependencies (safe for the startup bundle). */

/**
 * The permissions requested when adding the bot: everything CONDUIT's features use, and nothing else. Never
 * Administrator. Discord pre-ticks these on its add-bot page; the server owner can still untick any.
 */
export const BOT_INSTALL_PERMISSIONS = [
  { name: 'View Channels', bit: 1n << 10n, for: 'every feature' },
  { name: 'Send Messages', bit: 1n << 11n, for: 'every feature that posts' },
  { name: 'Embed Links', bit: 1n << 14n, for: 'embeds' },
  { name: 'Attach Files', bit: 1n << 15n, for: 'images in posts' },
  { name: 'Add Reactions', bit: 1n << 6n, for: 'reactions' },
  { name: 'Read Message History', bit: 1n << 16n, for: 'Sticky Messages' },
  { name: 'Mention Everyone', bit: 1n << 17n, for: 'pinging roles that aren’t mentionable (notifications)' },
  { name: 'Manage Messages', bit: 1n << 13n, for: 'deleting messages (moderation)' },
  { name: 'View Audit Log', bit: 1n << 7n, for: 'Discord Logging (bans, kicks, timeouts)' },
  { name: 'Timeout Members', bit: 1n << 40n, for: '/timeout, /untimeout' },
  { name: 'Ban Members', bit: 1n << 2n, for: '/ban, /unban' },
  { name: 'Kick Members', bit: 1n << 1n, for: 'Automated Protection (kick responses)' },
  { name: 'Manage Roles', bit: 1n << 28n, for: 'Loyalty level roles' },
  { name: 'Manage Server', bit: 1n << 5n, for: 'Anti-raid lockdowns: the server’s verification level (Automated Protection)' },
  { name: 'Manage Channels', bit: 1n << 4n, for: '/slowmode' },
] as const;

/** The permissions integer of the add-bot link (the sum of the above: 1099780320502). */
export const DISCORD_INSTALL_PERMISSIONS = BOT_INSTALL_PERMISSIONS.reduce((sum, p) => sum | p.bit, 0n).toString();
