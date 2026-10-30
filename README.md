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

## Cloudflared setup

Some platforms send events to CONDUIT through a **webhook**, which needs a public `https://` address. CONDUIT runs on
your PC, so `cloudflared` (Cloudflare Tunnel, free) gives it one. The tunnel exposes only CONDUIT's webhook receiver
on `127.0.0.1:47822`, and you don't need to open ports on your router or firewall.

### 1. Install cloudflared

In PowerShell:

```powershell
winget install --id Cloudflare.cloudflared
```

Or download it from
[Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
Close and reopen PowerShell, then check it works:

```powershell
cloudflared --version
```

### 2. Start a tunnel

**Quick tunnel** (free, no account): run this and keep the window open while you use CONDUIT.

```powershell
cloudflared tunnel --url http://127.0.0.1:47822
```

It prints a public address such as `https://something.trycloudflare.com`. A quick tunnel gets a **new address every
time it starts**, so you'll need to paste the new one wherever you use it.

**Permanent tunnel** (free, needs a Cloudflare account and a domain that uses Cloudflare for its DNS): it keeps the
same address every time.

```powershell
cloudflared tunnel login                                     # sign in and pick your domain
cloudflared tunnel create conduit                            # create the tunnel (once)
cloudflared tunnel route dns conduit conduit.yourdomain.com  # give it a permanent address (once)
cloudflared tunnel run --url http://127.0.0.1:47822 conduit  # start it (each time)
```

Your address is then `https://conduit.yourdomain.com`.

### 3. Use the address

Add the webhook path to your tunnel address and paste it into the platform's webhook setting:

| Platform | Webhook URL                         | Where to paste it                                                                        |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Kick     | `https://<your-address>/kick/webhook` | [kick.com/settings/developer](https://kick.com/settings/developer) → your app → **Edit** → **Enable Webhooks** |

### Troubleshooting

- Keep both CONDUIT and the cloudflared window running.
- With a quick tunnel, update the webhook URL whenever cloudflared restarts.
- `cloudflared` isn't recognized: close and reopen PowerShell after installing, or restart your PC.

More detail: [docs/SETUP.md](docs/SETUP.md).

## Development

```powershell
npm run setup    # once
npm run dev      # run CONDUIT with live reload
npm run verify   # type checks, tests and build
```
