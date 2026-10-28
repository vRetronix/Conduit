# Changelog

All notable changes to CONDUIT are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and CONDUIT uses [Semantic Versioning](https://semver.org/):
MAJOR.MINOR.PATCH.

Work that has not been released yet is under **[Unreleased]**, grouped by the batch of work it came in (newest
first). It becomes the next version when a release is prepared.

## [Unreleased]

## [1.0.2] - 2026-10-27

### Changed
- **Giveaways:** the **Kick Messages** tab is now called **Messages**.
- **Menu bar:** the File, Edit, View and Window menu bar is gone, also when running CONDUIT from source.
- **Discord Logs → Moderation log:** shorter, easier description at the top.

## [1.0.1] - 2026-10-27

### Changed
- **Build:** the app's name, app id and data folder now come from one place (`scripts/edition.mjs`). Nothing changes
  for you: it is still "CONDUIT" and keeps its data in `%APPDATA%\CONDUIT`.
- **Setup guide:** the installer's name is shown as `CONDUIT Setup X.Y.Z.exe` (the version you build).

## [1.0.0] - 2026-10-25

The first release of CONDUIT: one desktop app for running your Discord and Kick from one place. It starts empty;
you connect your own accounts and set everything up yourself. See [docs/SETUP.md](docs/SETUP.md).

### Added
- **Connect Accounts** on the Dashboard, through each platform's own sign-in:
  - **Discord:** a guided setup for your own Discord application and bot (credentials checked with Discord, adding the
    bot to your server and starting it).
  - **Kick:** your own Kick app, your Kick account, and the chatbot (your main account or a separate bot account), plus
    live chat through a webhook tunnel.
  - Tokens and secrets are encrypted with Windows (DPAPI) and never reach the dashboard; the backend is local-only.
- **Commands** for Discord and Kick: default commands (moderation, `/slowmode`, `/lock`, `/unlock`, `!uptime`,
  `!so`, `!title`, `!setcategory`…) and your own custom commands, with variables, permissions and cooldowns.
- **Giveaways:** one at a time; viewers enter with `!enter` in Kick chat or the Enter Giveaway button on Discord, with
  tickets, a draw, and announcements.
- **Timed Messages** in Kick chat or a Discord channel: every X minutes, after X chat messages, or both.
- **Moderation:**
  - **Kick:** automated protection (blocked words and phrases, links, spam checks, raid mode, ignored users), logs
    including bans made on Kick itself, and each person's history.
  - **Discord Bot:** CONDUIT's own AutoMod rules and message checks, anti-nuke and quarantine, anti-raid with
    lockdowns and a join gate, bot bait, moderation commands, and Discord Logging.
- **Discord:** Sticky Messages, Embed Creator (embeds, buttons and select menus, sent and edited as your bot), and
  Loyalty & Rewards (XP, levels, role rewards and a points balance).
- **Kick Notifications:** Discord posts when Kick streamers go live, with the stream thumbnail and Watch buttons, and
  optionally deleted when the stream ends.
- **Clips:** your Kick clips (made with Kick's `/clip`) posted in Discord with watch buttons, and saved on this PC.
- **Settings:** appearance and themes, system status, backup and restore, logs, and release notes.
