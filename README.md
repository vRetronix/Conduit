# CONDUIT

**The Link Between Everything.** A desktop app for running your Discord and Kick from one place.

- **Commands, giveaways and timed messages** for Discord and Kick chat
- **Moderation** and protection for both
- **Kick go-live notifications** and **clips** posted to Discord
- **Discord extras:** sticky messages, embeds, levels and rewards

CONDUIT runs on your PC (Windows 10/11) and starts empty: you connect your own accounts and set everything up
yourself. Your tokens are encrypted and stay on your PC.

## Install

There's no ready-made download yet, so you build the installer yourself. It takes a few minutes.

1. Install [Node.js](https://nodejs.org/) 24.7 or newer.
2. Get the code: select **Code → Download ZIP** above and unzip it, or use Git:
   ```powershell
   git clone https://github.com/vRetronix/Conduit.git
   ```
3. Open PowerShell in the CONDUIT folder and build the installer:
   ```powershell
   npm run setup
   npm run dist
   ```
4. Run **apps\desktop\release\CONDUIT Setup X.Y.Z.exe**. If Windows shows "Windows protected your PC", select
   **More info → Run anyway**.
5. Open CONDUIT and select **Connect** on Discord or Kick to start.

Step-by-step setup: [docs/SETUP.md](docs/SETUP.md). What's changed: [CHANGELOG.md](CHANGELOG.md).

## Development

```powershell
npm run setup    # once
npm run dev      # run CONDUIT with live reload
npm run verify   # type checks, tests and build
```
