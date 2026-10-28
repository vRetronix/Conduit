# CONDUIT

**The Link Between Everything.** A desktop app for running your Discord and Kick from one place.

- **Commands, giveaways and timed messages** for Discord and Kick chat
- **Moderation** and protection for both
- **Kick go-live notifications** and **clips** posted to Discord
- **Discord extras:** sticky messages, embeds, levels and rewards

CONDUIT runs on your PC (Windows 10/11) and starts empty: you connect your own accounts and set everything up
yourself. Your tokens are encrypted and stay on your PC.

## Install

1. Download **CONDUIT Setup 1.0.0.exe** and run it.
2. If Windows shows "Windows protected your PC", select **More info → Run anyway**.
3. Open CONDUIT and select **Connect** on Discord or Kick to start.

Step-by-step setup: [docs/SETUP.md](docs/SETUP.md). What's in this version: [CHANGELOG.md](CHANGELOG.md).

## Building from source

Requires Node.js 24.7 or newer.

```powershell
npm run setup   # install
npm run dev     # run in development
npm run dist    # build the installer
```
