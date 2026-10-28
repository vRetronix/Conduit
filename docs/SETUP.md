# Setup Guide

## Requirements

- Windows 10 or 11
- Node.js **24.7+** (needed for the built-in `node:sqlite` API) and npm 11
- Git (optional)

End users installing the packaged app need none of these. The installer bundles Electron, which ships its own Node.js runtime.

## First-time setup

```powershell
npm run setup
```

This runs `npm install` and then `install-electron`. Electron 44 no longer downloads its binary during
`npm install`, so the second step is required. It verifies the download against Electron's published checksums.

npm 11 may print `allow-scripts` warnings for `esbuild` and `electron-winstaller`. Neither install script is
needed: esbuild's platform binary comes from an optional dependency, and electron-winstaller is unused because
CONDUIT builds NSIS installers, not Squirrel.

## Running

| Mode | Command | Data directory |
| --- | --- | --- |
| Development | `npm run dev` | `.devdata/` in the repository |
| Built app | `npm run build` then `npm start` | `%APPDATA%\CONDUIT` |
| Standalone server | `npm run build` then `npm run server` | `%APPDATA%\CONDUIT` |
| Installed app | Start menu → CONDUIT | `%APPDATA%\CONDUIT` |

`npm run dev` starts the Vite dev server on `http://127.0.0.1:5173`, watches the main, preload and server bundles,
and relaunches Electron when they change (renderer changes hot-reload instead). Closing the app window ends the
dev session. During a relaunch, Electron is terminated rather than shut down gracefully. SQLite's WAL journal makes
this safe, but you won't see "stopped" log lines for those restarts.

Inside the data directory:

- `conduit.db` (plus `-wal`/`-shm`): the SQLite database.
- `session.bin`: your desktop session, encrypted with Windows DPAPI. Deleting it signs you out.
- `server.lock`: present while the backend is running; the recovery tool uses it to refuse to run concurrently.
- `logs/desktop.log` and `logs/server.log`: JSON-lines logs, rotated at 5 MiB, 5 files kept

Existing databases are migrated automatically at startup. Upgrading from Phase 1 adds the account tables and keeps
existing data.

Electron also keeps its own browser cache (folders such as `Cache` and `GPUCache`) and the key that protects stored
credentials (`Local State`) in `%APPDATA%\CONDUIT`, even when `CONDUIT_DATA_DIR` points elsewhere. Don't delete that
folder: connections would need to be reauthorized.

## First run

Open CONDUIT. It goes **straight to the dashboard**: there is no CONDUIT username, password or account setup.

The dashboard ("Connect and manage your platform accounts.") shows one card each for **Discord, Kick, YouTube and Twitch**. These
cards are the only place to manage connections.
- **Not Connected** / **Connecting** (yellow) / **Connected** comes from the local backend, never from the UI itself.
- **Discord:** **Connect** starts a guided setup (see [Connecting Discord](#connecting-discord)).
- **Kick:** **Connect Kick** opens a short setup (see [Connecting Kick](#connecting-kick)).
- **YouTube and Twitch are not implemented yet.** Their cards say so, and **Connect** explains it.
- CONDUIT never asks for platform passwords. **Connect** opens the platform's own authorization page in your
  browser.
- The Discord card shows four separate statuses — **Account**, **Application**, **Bot** and **Server** — each
  checked with Discord on its own.

**System status** (the backend process, API health including the database schema version, and the app version) is in
**Settings**.

## Connecting Discord

Select **Connect** on the Discord card. A setup window walks you through three steps — **Developer Portal**, **Your
Account**, **Add & Start the Bot** — and remembers where you stopped,
even across restarts (**Continue Setup** resumes at the right step). Nothing is typed into files: there is no
`.env.local` to edit.

CONDUIT has **no shared bot**. You use your own free Discord application and bot, which takes about five minutes.

### Step 1 — Developer Portal

This comes first because signing in with Discord (step 2) uses your application's credentials: Discord requires an
application's ID and secret to complete a sign-in.

1. Select **Open Developer Portal** in the setup window (it opens
   [discord.com/developers/applications](https://discord.com/developers/applications)). Select **New Application**, or
   pick an existing one.
2. On **General Information**, copy the **Application ID** into CONDUIT. (Discord uses the same number as the OAuth2
   **Client ID**, so there is no separate Client ID field.)
3. On **OAuth2**:
   - under **Redirects**, select **Add Redirect**, paste the address shown in the setup window (use its **Copy**
     button) and save. It must match exactly:

     ```text
     http://127.0.0.1:47821/oauth/discord/callback
     ```
   - select **Reset Secret** and copy the **Client Secret** into CONDUIT.
4. On **Bot**, select **Reset Token** and copy the **bot token** into CONDUIT. Under *Privileged Gateway Intents*, turn
   on **Presence Intent**, **Server Members Intent** and **Message Content Intent** (all three are required) and save.
   Each field in the window is tagged with the Developer Portal page its value comes from.
5. Select **Verify and save**. CONDUIT checks each value with Discord:
   - the Application ID and Client Secret, with Discord's client credentials grant;
   - the bot token, by asking Discord which bot and application it belongs to (it must be the same application).

   If something is wrong, the message appears under the exact field, with what to do. Nothing is saved until every
   check passes. The secret and token are then encrypted with Windows (DPAPI) and never shown again; leave a field
   blank later to keep the saved value.

### Step 2 — Your Account

Select **Connect Discord account**. Discord's page opens in your browser and asks only for `identify` (username and
avatar; no email, no servers). Approve it, and CONDUIT shows your name and avatar. Use **Cancel** or **Try again**
if needed. Signing in does not prove the bot works; that is checked separately.

### Step 3 — Add & Start the Bot

This step shows the result at the top — **User Account**, **Bot (Application)** and **Server**, each from what Discord
confirmed (or the reason it isn't done yet) — and then its two parts.

**a. Add the bot to your server.** Select **Add bot to server**, pick your server on Discord's page and select **Authorize**. You need the *Manage
Server* permission there.
- The bot asks for the permissions CONDUIT's features use (permission integer `1099780320502`) and **never
  Administrator**. Giveaway buttons are interactions and need no further permission. **Manage Server** is for anti-raid
  lockdowns (the server's verification level), **Kick Members** for Automated Protection and **Manage Channels** for /slowmode. A bot added
  earlier gets the newer ones when you select **Add bot to server** again.
- **Gateway intents:** **Guilds**, **Guild Messages** and **Guild Moderation**, plus the privileged **Server Members**,
  **Message Content** and **Presence** intents, which are **required**: turn them on under Bot → Privileged Gateway
  Intents. CONDUIT uses each one as soon as it's on in the portal (the bot reconnects by itself) and never asks Discord
  for one that's off there; if Discord refuses anyway, the bot stays online without them and the affected logs say so.
- **Bots added with no permissions** (before giveaway announcements) need these three in the giveaway channel: select
  **Add bot to server** again (Discord updates the bot's role), or give the bot's role them there (Edit Channel →
  Permissions). Many servers already allow them through @everyone. A bot added with more permissions (an earlier
  version asked for Add Reactions and Read Message History too) keeps working; you can remove those two.
- On your application's **Installation** page, *Guild Install* must be enabled (the default).
- CONDUIT shows **Installed** only once Discord confirms the bot is in a server: from the bot's live connection, or
  by asking Discord (**Check again**). Opening the page or returning from it is not taken as proof.

**b. Start the bot.** CONDUIT runs your bot while the app is open and shows **Connected as** the bot's name. If the
connection drops it reconnects automatically. If Discord rejects the token, the window says to reset it (under
**Manage**); for other problems, select **Reconnect**. When all three are verified the summary says **Discord is set
up.**

The Discord card on the dashboard shows **Connected** only while the bot's live connection to Discord is up
(a yellow **Connecting** tag while it starts or reconnects); saved credentials alone show **Not Connected**.

### Slash commands (`/ping` and moderation)

Once the bot is online in a server, CONDUIT registers its slash commands there by itself: **`/ping`**, which answers
*Pong! I'm connected and ready!* (the bot answers in the first person), and the moderation commands
`/timeout`, `/untimeout`, `/ban` and `/unban` (see [Moderation](#moderation)). The Discord card's **Commands** row shows the status
separately from the bot (a bot can be online while its commands aren't registered). The setup window's **Slash
commands** section lists each server, the last attempt and any error.

- Commands are registered per server, so they appear within seconds; there is no hour-long wait for global commands.
- CONDUIT doesn't re-register on every start. It asks Discord whether `/ping` is still there and registers only if
  it isn't.
- If Discord says *Missing Access*, add the bot to that server again with **Add bot to server** (it now also asks for
  the *applications.commands* permission), then select **Retry Commands**.
- Rate limits and Discord outages are retried automatically a few times; the status says when.


- **Manage** (formerly *Reconfigure*) reopens step 1 to replace the Application ID, secret or token. Choosing a *different* application
  signs out the old account and forgets its servers.
- **Reconnect** restarts the bot. **Disconnect** signs your Discord account out (Discord revokes CONDUIT's access).
- **Remove Discord setup…** (in step 1) signs out, stops the bot and deletes the stored secret and token. Your
  application, and the bot's membership of servers, are not changed on Discord; remove the bot from a server in
  Discord if you want.

**If something goes wrong:**
- *Discord shows "Invalid OAuth2 redirect_uri":* the redirect on the OAuth2 page doesn't match the address in step 1
  exactly.
- *"The OAuth callback port 47821 is in use":* another program holds the port. Close it, or set
  `CONDUIT_OAUTH_CALLBACK_PORT` and register the matching redirect.
- *An authorization not finished within 10 minutes* times out; start it again.

**Where things are stored:**
- The Client Secret, bot token and Discord account tokens are encrypted with Windows DPAPI (Electron
  `safeStorage`) in `credentials\*.bin` in the data folder, as separate entries, readable only by your Windows
  account. If DPAPI is unavailable, CONDUIT refuses to save them.
- The database holds only non-secret data: the Application ID and name, the bot's name and id, the servers Discord
  confirmed, and your account's id, name, handle and small avatar.

## Connecting Kick

Kick also works with **your own** Kick app; there is no shared CONDUIT app. Select **Connect Kick** on the Kick card.
The setup window uses the same step-by-step layout as Discord's, with Kick's own four steps — **Kick App**, **Your
Account**, **Chatbot**, **Live Chat** — and opens at the first one that isn't done. The Kick card shows **Connected**
when your main account's authorization is valid, **Connecting** (yellow) while you approve in the browser or while live
chat is still connecting, **Needs Reconnect** when Kick rejected it, and **Not Connected** otherwise. Chat status is shown in the Live Chat step and on Kick Moderation (not on the card).

### 1. Kick App (once)

1. Turn on two-factor authentication for your Kick account; Kick requires it for developer tools.
2. Select **Open Kick developer settings** (it opens [kick.com/settings/developer](https://kick.com/settings/developer)),
   and create an app.
3. Set the app's redirect URL to exactly what the setup window shows (use **Copy**). Use `localhost`, not `127.0.0.1`:

   ```text
   http://localhost:47821/oauth/kick/callback
   ```
4. Copy the app's **Client ID** and **Client Secret** into CONDUIT and select **Verify and save**. CONDUIT checks
   them with Kick before saving. The secret is stored encrypted (DPAPI) and never shown again.

### 2. Your Account

Select **Connect Kick account**. Kick's page opens in your browser and asks only to read your profile and channel
(`user:read`, `channel:read`). After you approve it, the card shows your name and avatar.

### 3. Chatbot

- **Use my main account** (default): nothing else to do.
- **Use a separate bot account**: select **Add Bot Account**. Kick signs in whoever is logged in to kick.com in your
  browser, so log in as the bot account first (or use a private window). The bot account only grants `user:read`.

You can add, reconnect, replace or disconnect the bot account later in **Manage**. This doesn't affect your main
account, and the reverse is also true.

### 4. Live Chat

CONDUIT can receive your channel's chat and post messages as the chatbot account. Open **Manage** on the Kick card
and see **4. Live Chat**, which also summarises Main Account, Chatbot and Live Chat.

**Permissions.** Accounts connected before this feature need one more approval each:
- **Main account:** select **Reauthorize main account**. Kick then also grants `events:subscribe` (send your chat to
  CONDUIT), plus `chat:write` if the main account is the chatbot.
- **Bot account:** log in to kick.com as the bot account (or use a private window), then select **Reauthorize bot
  account**. This grants `chat:write` (post chat messages).

Your other account isn't affected.

**Receiving needs a tunnel.** Kick delivers chat only to a public web address (a webhook). CONDUIT runs a small
receiver on this PC at `http://127.0.0.1:47822`. It accepts only messages signed by Kick and has no access to
anything else. You expose that one address with a tunnel:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   (or ngrok) and run:

   ```text
   cloudflared tunnel --url http://127.0.0.1:47822
   ```

   It prints a public address such as `https://something.trycloudflare.com`. Keep it running.
2. In Kick → Account Settings → Developer → your app → **Edit**, turn **Enable Webhooks** on and set the URL to that
   address plus `/kick/webhook` (for example `https://something.trycloudflare.com/kick/webhook`). A free quick
   tunnel gets a new address each time it starts; update the URL in Kick when it changes.
3. Send a message in your Kick chat. It appears under **4. Live chat**.

**What the status means:**
- **Connected:** Kick confirmed CONDUIT's chat subscription. Until the first message arrives, it also says it's
  waiting to confirm your tunnel.
- **Permission required:** reauthorize the main account.
- **Reconnecting / Error:** Kick couldn't be reached or refused; use **Retry**.

**Sending.** **Send a test message** posts exactly what you type, only when you select **Send to live chat**, as the
account shown (the bot account or your main account) to your channel. CONDUIT says "sent" only after Kick confirms
it. Kick may refuse if the account is banned or timed out, or if your chat is restricted (followers-, subscribers- or
verified-only). Per Kick's API, a separate bot account posts as an ordinary chat user (Kick's "bot" message type always
posts to the token owner's own channel).

Chat messages are kept in memory only (the last 25) and are not saved.

### 5. Kick commands

Kick commands are managed on the **Commands** page; see [Commands](#commands).

## Commands

**Commands** in the sidebar holds every command, with a tab for **Discord** and one for **Kick**.

Each platform has two tabs, like browser tabs: **Default Commands** and **Custom Commands** (each with a count).

**Default Commands** is a table of **on / off | Command | Access | Message**: the switch turns a command on or off
straight away; **Message** is what it answers, with its {variables} marked, and an example of using it underneath
(hover over a command for what it does). A command that is on but can't answer right now says why under its message.
- **Discord:** `/ping`, the moderation commands (`/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/slowmode`, `/lock`,
  `/unlock`), the settings command `/sticky` (Admin), and the Loyalty & Rewards commands (`/points`,
  `/rewards`, `/redeem`, `/level`, `/leaderboard`, and `/loyalty` for admins). A command switched off is removed from
  Discord. **Edit access** (top right) shows a menu for each command's **Access**; **Done** closes it.
- **Kick:** `!enter` (giveaway entry, always on) and the Kick default commands below. A command switched off is ignored
  in chat; your own custom command with the same trigger answers instead of the default.

**Kick default commands**

| Command | Who | Does |
| --- | --- | --- |
| `!ping` | Moderators and you | Checks the chatbot is connected: it answers "Pong! I'm connected and ready!" |
| `!commands` | Everyone | Lists the commands everyone can use |
| `!uptime` | Everyone | How long you've been live (or that you're offline) |
| `!title`, `!title new title` | Moderators and you | Shows your stream title, or changes it |
| `!followage [@name]` | Everyone | How long they (or the person asking) have followed you; uses Kick's website data |
| `!so @name` | Moderators | Shout-out with their link and category |
| `!timeout @name [minutes] [reason]` | Moderators | Times them out (default 10 minutes, up to 7 days) |
| `!ban @name [reason]`, `!unban @name` | Moderators | Bans, or lifts a ban or timeout |
| `!addcom !name reply`, `!editcom !name reply`, `!delcom !name` | Moderators | Adds, changes or deletes a custom command |
| `!setcategory name` | Moderators | Changes your stream category |

- Everyone's commands share a 10-second cooldown so chat can't be flooded; moderators and you skip it.
- Moderator commands act with your main Kick account: `!timeout`, `!ban` and `!unban` need *moderation:ban* and are
  recorded in Kick Moderation's history as "*moderator* via !timeout"; changing the title and `!setcategory` need
  *channel:write*. If you connected Kick before these existed, select **Reauthorize main account** (Dashboard → Kick →
  Manage) once; until then the chatbot says so.

The **Custom Commands** tab holds yours (Command | Access | Description | Status). Below the tabs, **Recent runs** is
the log of what each command did.

- **Custom Commands:** **New command**; on each row an **on / off toggle** (green on, red off), **Edit** and **Delete**
  (asks to confirm).
  - The **Description** column shows a Discord command's description, or a Kick command's reply.
  - **Recent runs** (below the table) is the log: *Replied (confirmed)*, *Reply failed*, *Reply not confirmed* or
    *Blocked*, for this session. Saving a command doesn't mean it has run.

**Access (Discord default commands)** is one of three groups, from the member's Discord permissions (computed by
Discord for each use, never from role names):

| Access | Who | Includes |
| --- | --- | --- |
| **Admin** | members with Administrator (the server owner always has it) | Moderator and Anyone commands |
| **Moderator** | members with Manage Messages, Timeout Members, Kick Members, Ban Members or Administrator | Anyone commands |
| **Anyone** | everyone who can use commands in the server | |

- Defaults are what CONDUIT always did: `/ping` and the Loyalty commands are Anyone, the moderation commands
  Moderator, all enabled. Nothing saved means the defaults, so existing setups behave exactly as before.
- Moderation commands can't be set below Moderator, and always keep their Discord permission (shown under the menu,
  e.g. *+ Ban Members*). CONDUIT still refuses actions on members whose highest role is at or above the
  moderator's, and Discord refuses actions on members at or above the bot's role.
- CONDUIT checks Access on every use, so running a command directly (or one a server admin made visible in Discord's
  **Server Settings → Integrations**) is refused the same way, with a private note such as *Not allowed: admin only.*
- Admin-only commands are also hidden from other members in Discord's command list. Discord can't hide a command from
  "anyone without one of several permissions", so Moderator commands stay listed for everyone and CONDUIT refuses
  members outside the group.
- **Disabled** commands are removed from Discord; if someone runs one anyway, they're told it isn't available.
- Custom commands have their own permission, set in their editor (Anyone, Moderator or Admin on Discord).

**Status Updates and Rich Presence Updates** (sidebar → Discord → **Discord Bot** → **Settings**) set your **bot's** presence. Both edit
the same presence:
- **Status:** Online, Idle, Do Not Disturb or Invisible, and an optional custom status line (up to 128 characters).
- **Activity:** Playing, Streaming (with a Twitch or YouTube link), Listening to, Watching or Competing in, with its
  text.
- Discord shows one line under a bot's name, so while an activity is on it replaces the custom status line.
- Bots can't show the Rich Presence extras games use (images, buttons, timestamps, details lines, party sizes), so
  they aren't offered. This is the bot's presence only: a bot can't change your own status or anyone's Rich Presence,
  and CONDUIT never uses a user account to do it.
- Saving sends it to Discord straight away when the bot is connected; the bot's status is on the Dashboard's Discord
  card. Discord doesn't confirm presence updates, so *Sent* means the bot's connection accepted it.
- It is sent again whenever the bot reconnects. Until you save one, CONDUIT sends nothing and Discord shows the bot
  as Online with no activity.
- Discord allows only a few presence changes a minute; CONDUIT refuses more than 5 a minute with a message.

**How custom commands are triggered:**
- **Kick:** someone starts a chat message with the trigger, for example `!hello` or `!so CoolStreamer`. Case
  doesn't matter, and only the first word counts. The chatbot account replies. It never answers its own messages.
- **Discord:** custom commands are slash commands, registered in your server next to `/ping`. People type `/`,
  pick the command, and the bot replies. Each needs a short description, which Discord requires. A command whose reply
  uses `{args}` or `{message}` gets an optional **text** box. Disabled or deleted commands are removed from Discord.
  The *Registered with Discord* badge shows when Discord has the latest set.

**Variables** are filled in with real values when the command is used. Click one in the editor's **Variables**
panel (grouped, showing only the ones that work on that platform) to insert it. Write `{name}`, `{name:argument}`, and
add `|text` for a fallback when there's no value: `{touser|everyone}`, `{title|no title}`.

| Group | Variables |
| --- | --- |
| User and input | `{user}`, `{touser}` (the first word after the command without `@`, else the user), `{userid}`, `{args}` (Kick: words after the trigger; Discord: the **text** box), `{1}`…`{9}` (one word), `{message}`, `{channel}`, `{platform}`, `{commands}` |
| Your Kick stream | `{streamer}`, `{title}`, `{category}`, `{viewers}`, `{uptime}` ("offline" when you aren't live), `{url}`: from Kick's official API, refreshed every 30 seconds |
| Random and maths | `{random}` (1–100) or `{random:1-6}`, `{pick:heads;tails}`, `{randomuser}` (someone else who chatted recently), `{math:2*(3+4)}` (+ - * / % ^ and brackets only) |
| Counters | `{count}` (times this command was used), `{counter:deaths}`, `{counter:deaths+1}`, `{counter:deaths-1}`, `{counter:deaths=0}`: kept in CONDUIT's database, shared by Kick and Discord |
| Time | `{time}`, `{date}` (your PC's time, or a zone: `{time:America/New_York}`), `{countdown:2026-12-25}`, `{countup:2025-01-01}` |
| Kick only | `{roles}` (the user's badges), `{submonths}` (from their subscriber badge) |
| Discord only | `{mention}` (a clickable mention that never pings), `{server}`, `{membercount}`, and Loyalty: `{points}`, `{level}`, `{xp}`, `{rank}` |

- If nothing follows the command, `{args}` is empty.
- Values are inserted as plain text, exactly once, so a value containing `{user}` isn't replaced again.
- Replies are shortened with "…" to fit the platform: 500 characters on Kick, 2000 on Discord.
- Kick replies are one line. Discord replies can span several lines and use **Discord markdown**: `**bold**`,
  `*italic*`, `__underline__`, `~~strikethrough~~`, `||spoiler||`, `` `code` ``, `[links](https://…)`, and on their
  own lines `#`/`##`/`###` headings, `-#` small text, `>` quotes, `-` or `1.` lists and ```` ``` ```` code blocks. The
  editor's preview shows it the way Discord does (as do the previews for timed, sticky and other Discord messages).
  Values typed by people (such as `{args}`) stay on one line, so they can't add headings or quotes of their own.
- On Kick, a reply that would start with `!` or `/` (for example because `{args}` began with one) isn't sent.
- Anything else in braces, such as `{name}`, is rejected when you save, and so is a variable from the other platform
  (e.g. `{mention}` in a Kick command). An older command that already contains one keeps working, posts it as
  written, and is flagged on the page.

**Permissions** (who may use a command), set in the editor:

| Level | Kick | Discord |
| --- | --- | --- |
| Anyone | anyone in chat | anyone who can use commands |
| Subscribers | Kick's subscriber badge, moderators, you | not available (Discord has no subscribers) |
| Moderators | Kick's moderator badge, and you | Moderator: Manage Messages, Timeout Members, Kick Members, Ban Members or Administrator |
| Broadcaster only / Admin | only you, the channel owner | Admin: Administrator (the server owner always has it) |

Roles come from the platform itself: Kick's signed chat event (your user ID, and the badges Kick sends) or Discord's
computed member permissions. Never from names. Other Kick badges (VIP, OG, founder) grant nothing, and a message
without role data counts as an ordinary viewer.

**Cooldowns:**
- **None**, **Per user** (each person waits) or **Global** (everyone waits after anyone uses it), from 1 to 86,400
  seconds.
- Blocked uses get no reply in Kick chat. Discord shows the person a private note, because Discord requires every
  command to be answered.
- An attempt that was refused (no permission) or a reply that failed to post doesn't start the cooldown.
- Cooldowns are kept in memory and **reset when CONDUIT restarts**.
- Existing commands default to Anyone and no cooldown.
- The **Access** column shows each command's settings, and blocked attempts show as *Blocked* in Recent runs.

Examples: `Hello {user}, welcome to {channel}!` · `!so` → `Go follow {args} at kick.com/{args}` ·
`/say` → `{user} says: {args}`.

## Giveaways

Open **Giveaways** in the sidebar. It has two browser-style tabs:
- **Giveaways:** **New giveaway** (top right), the **Current giveaway** (running, or entries closed and waiting for the
  draw) and **Completed** giveaways, one line each (prize, when, entries, winners), 5 to a page. Select one to open its
  winners, completion time and draw history.
- **Kick Messages:** the chat messages described below.

### Start a giveaway

Select **New giveaway**, fill it in and select **Start Giveaway**. There are no drafts: CONDUIT checks everything first
and, if all is well, the giveaway starts right away and is announced. If anything fails, nothing is started and the
error says what to fix.

- **Prize**, optional **description**, **winners** (1–50) and an optional **duration** (1 minute to 7 days; empty =
  until you end entries).
- **Entry on** Kick, Discord or both. Kick needs your main Kick account connected; Discord needs a **Discord
  announcement channel** (the last one is preselected; channels where the bot lacks a permission are disabled and say
  which one). Start checks the bot's access to that channel.
- **Kick bonus tickets (optional):** a **Channel Points reward** (name, cost in points, bonus tickets per redemption)
  and an **active-subscriber multiplier** (2×–5×). See *Tickets* below.

Only one giveaway runs at a time. While it runs you can still change the prize, description and number of winners
(**Edit**).

### How viewers enter

- **Kick:** type `!enter` in your Kick chat. Each new entrant is announced in chat: "{username} has entered the
  giveaway!" (repeats aren't announced; during a burst at most 10 announcements wait in line, but everyone is entered).
  After entries close, `!enter` gets a short "Giveaway entries are closed." (at most once a minute). Needs Kick chat
  connected (Kick → Manage → 4. Live chat).
- **Discord:** click **🎉 Enter Giveaway** on the giveaway's embed. Entering is one-way: there is no leave option. The
  answer is private to the person clicking ("You've entered the giveaway! 🎉", "You're already entered in this
  giveaway!", "This giveaway is closed. Entries are no longer accepted."). Nothing is posted publicly or sent by DM.
  The embed explains the Discord button only; Kick viewers learn about `!enter` from the Kick chat announcement.

Each Kick or Discord account enters once, identified by its platform user ID (never by name). The same person on Kick
and Discord counts as two entrants (accounts aren't linked). Your own accounts and the Kick chatbot can't enter.

### Kick chat messages

The messages the chatbot posts in Kick chat during a giveaway are editable on the Giveaways page, on the **Kick
Messages** tab, before anything is sent: **Giveaway started**, **Viewer entered**, **Entries closed**, **Winners drawn**,
**Winner redrawn** and **Entry after closing** (the reply to a late `!enter`). Edit the text and select **Save
messages**; nothing is posted when you save. Exactly the saved text is posted later, with its `{variables}` filled in.
Each message lists its own variables and shows an example:

- Giveaway started: `{prize}`, `{how_to_enter}`, `{winner_count}`, `{winners_note}` ("2 winners.", empty with one
  winner), `{reward}`, `{reward_note}` (the Channel Points sentence, empty without a reward), `{duration}`,
  `{closes_note}` ("Entries close in 10 minutes.", empty without a time limit). Empty variables leave no extra spaces.
- Viewer entered: `{user}`, `{prize}`. Entries closed: `{prize}`. Winners drawn: `{prize}`, `{winners}`,
  `{winner_label}` ("Winner"/"Winners"). Winner redrawn: `{prize}`, `{winner}`. Entry after closing: no variables.

A message must be one line, at most 500 characters, use only its own variables, and can't start with `!` or `/`.
There are no ticket, entry-count or odds variables: those stay private. **Reset to default** restores the original
text. A message that is empty once its variables are filled in isn't posted (the giveaway shows why).

### Tickets

Every entrant has **1 ticket**. Optional extras, Kick only:

- **Channel Points bonus tickets.** When the giveaway starts, CONDUIT creates a dedicated reward on your Kick channel
  (with Kick's official rewards API). A viewer types `!enter`, then redeems the reward; each accepted redemption adds
  the configured bonus tickets. CONDUIT accepts or rejects each redemption through Kick's API:
  - accepted: the redeemer has an eligible Kick entry, the giveaway is running and the redemption was made before the
    end time;
  - rejected: no entry yet ("type !enter first"), not eligible, or after entries closed.
  Each redemption counts once (by Kick's redemption ID), however often Kick delivers it. Redemptions are picked up by
  webhook and, as a fallback, by asking Kick for pending ones every 30 seconds. When entries close the reward is paused
  and still-pending redemptions are rejected; after the draw (or a cancel) the reward is deleted from Kick. Tickets are
  frozen when entries close. CONDUIT never touches anyone's point balance: Kick charges the points when a viewer
  redeems. Kick documents only accept and reject (no refund call); whether a rejection returns the points is Kick's
  behaviour.
  - **Required:** your main Kick account must have granted **channel:rewards:write**. Accounts connected before this
    feature need **Reauthorize main account** once (Dashboard → Kick → Manage). Until then the option is unavailable
    and says why.
- **Active-subscriber multiplier.** Kick's API has no way to look up whether a viewer is subscribed right now. The
  reliable signal is the **subscriber badge** Kick puts on the signed chat event, so CONDUIT checks it on the viewer's
  `!enter` message: subscribed at that moment = verified. Status is evaluated **once, at entry**, and used for the draw
  (the evidence — that message's ID and time — is stored). Other badges (OG, VIP, founder, gifter) don't count;
  Discord entrants never get it.
- **Rule:** tickets = (1 + bonus tickets) × (verified subscriber ? multiplier : 1). Example: 2 bonus tickets and 2× →
  (1 + 2) × 2 = **6** tickets. Giveaways from before this keep 1 entry = 1 ticket.

Ticket counts, totals, odds and entrant lists are **private**: only this dashboard shows them (entries, tickets,
verified subscribers, redemptions accepted/rejected, and each draw's pool). No Kick message or Discord embed ever
includes them; winner announcements show the winner's name and the prize only.

### Ending, drawing and cancelling

- **End entries**, or let the duration run out. The backend closes entries at the end time, also after a restart
  (entries and redemptions after the end time are always refused).
- **Draw winners** picks distinct winners at random, each with a chance proportional to their tickets
  (`crypto.randomInt`). It needs at least as many eligible entrants as winners; otherwise it says so (lower the number of
  winners with Edit). A giveaway is drawn once; the ticket calculation of the whole pool is stored with the draw.
- **Redraw** (next to a winner) replaces that winner with a new pick, proportional to tickets, among entrants who were
  never drawn in this giveaway. The replaced winner stays in the **Draw history**, with the optional reason.
- **Cancel** deletes a running giveaway with its entries, draws, winners and redemptions, and removes its Kick reward;
  the Discord embed says it was cancelled (buttons disabled). Completed giveaways can't be cancelled. Giveaways that
  were cancelled before cancelling deleted them are kept in the database but not shown.
- **Delete giveaway** (on a completed one, after confirming) deletes it with its entries, winners and draw history.
  Its Discord post with the winners stays.

### Announcements

- **Kick:** the chatbot posts when a giveaway starts (and names the reward, if any), each new entrant, when entries
  close on time, and the winners (and redraws). The latest announcement's result is shown on the giveaway; if Kick
  refuses it, the results are still saved.
- **Discord:** a clean embed (prize, description, number of winners, closing time, how to enter) with the Enter Giveaway button,
  posted when the giveaway starts. When entries close the button is disabled; after the draw it shows the winners
  (Discord winners as mentions, which don't ping; Kick winners by name). If posting or updating fails, the giveaway
  card shows the reason and a **Retry** or **Repost announcement** button. After a restart the same embed is updated
  and its buttons keep working (each click is checked against the giveaway, message, channel, server and bot stored
  in the database).

## Moderation

**Kick Moderation** (sidebar → Kick) and **Discord Bot** (sidebar → Discord: tabs **Settings**, **Protection**, **Logs**); YouTube and Twitch Moderation are
marked *Soon* (planned, not connected, no permissions requested). Neither working page has manual buttons:
actions happen through **automated protection** (Kick) and CONDUIT's **moderation commands in Discord**. The pages
configure protection and show what happened.

### Kick Moderation

- **Automated Protection** — off by default (the On/Off switch at the top). Laid out like Discord Bot → Protection:
  a row per check with what it does, its status (*Off*, *Log only*, *Deletes the message*, *Times out for N min*), an
  on/off switch that saves straight away, and **Configure**, which opens its settings below the row (one at a time,
  each with its own **Save**). The rows are **Blocked words and phrases**, **Links**, **Spam checks** (one row for
  the six checks below from caps to flooding, whose panel is a table with each one's switch, setting and action),
  **Raid mode** and **Ignored users**. When switched on, each new message is checked, in this order:
  - **Blocked words and phrases** — one per line, with `*` wildcards like Discord's AutoMod (`cat` the whole word,
    `cat*`, `*cat`, `*cat*`), up to 10 regular expressions, and **allowed words** that never count. Capital letters
    and fancy fonts don't matter;
  - **Links** — any link (with http(s)://, www., or a site like example.com) except to the **allowed sites** you list
    (and their subdomains; `kick.com` to start with);
  - **Excessive caps** — at least P% capital letters in a message of at least L letters;
  - **Emote spam** — more than N emotes (Kick emotes and emoji) in one message;
  - **Symbol spam** — at least P% symbols in a message of 10+ characters, or stacked accent marks (Zalgo text);
  - **Long messages** — more than N characters (an emote counts as one);
  - **Repeated messages** (the same message N times within S seconds);
  - **Message flooding** (more than N messages within S seconds).

  The newer checks (links to long messages) start switched off.
- **Raid mode** — when N people chat for the first time within S seconds, CONDUIT is stricter with first-time
  chatters for M minutes: their messages with a link (other than to an allowed site), or that any check matches
  (even one set to Log only), are deleted or they're timed out. The chatbot can say so in chat when it starts.
  **Start raid mode now** / **End raid mode** do it by hand. CONDUIT remembers who has chatted before (Kick user id
  and name only, no messages), and raid mode only starts once it knows your regulars: after 2 hours and 25 different
  chatters (*Learning your regulars*). Kick doesn't let apps change its chat modes (slow mode, followers- or
  subscribers-only), so raid mode doesn't.

  Actions: **Log only** (the default: recorded in Logs, nothing happens on Kick), **Delete the message**, or **Timeout
  the user** (minutes). **Ignored users** (Kick usernames) and, optionally, moderators are never checked; you, the
  chatbot account and CONDUIT's own messages never are. Each message is checked once (Kick may deliver an event more
  than once), and the same rule logs or times out the same user at most once every 30 seconds. Saving warns when it
  lets CONDUIT act on Kick automatically.
- **Logs** — what protection detected and did: time, rule, user, action and result. *Detected only* means a log-only
  rule matched (nothing was done on Kick); *Done* means Kick confirmed the action; *Failed* shows Kick's reason. Bans
  and timeouts done on **Kick itself** (by you, your moderators or other bots) are listed too, as *On Kick by …*, from
  Kick's `moderation.banned` events (CONDUIT's own aren't listed twice; Kick sends no event for unbans). Select a
  **name** to see everything recorded for that person, then **← Everyone** to go back.

Deleting and timing out use your main account's `moderation:chat_message:manage` and `moderation:ban`. If you
connected Kick before moderation was added, select **Reauthorize main account** (Dashboard → Kick → Manage) once;
until then those actions can't be chosen and say why.

### Discord Bot

**Discord Bot** (sidebar → Discord) has three tabs: **Settings** (the bot's Status Updates and Rich Presence
Updates), **Protection** (Automated Protection) and **Logs** (Discord Logging at the top, then the Moderation log). The last tab you opened is remembered.

- **Protection** is one list with a row per feature: what it does, its status (*Off*, *Alert only*, *Enforcing*…),
  an on/off switch and **Configure** (**Manage** for AutoMod), which opens that feature's settings below its row, one
  at a time. A lockdown in effect and quarantined members show above the list. Every feature is CONDUIT's own and
  works while CONDUIT is running:
  - **AutoMod** — your own rules, checked by CONDUIT's bot (Discord's built-in AutoMod isn't used or changed; rules
    made there stay in Server Settings → Safety Setup → AutoMod). Up to 25 rules per server; add, edit, switch on/off
    and delete them:
    - **Custom words** — new messages with words or phrases from your list: `cat` matches the word *cat*, `cat*`
      words starting with it, `*cat` words ending with it, `*cat*` anywhere; plus up to 10 regular expressions and
      **allowed words** that never count. Capital letters and fancy fonts don't matter. Needs the **Message Content**
      intent.
    - **Mention spam** — a message that @mentions more members and roles than allowed (works without the message
      text).
    - **Member names** — usernames when members join, and nicknames when they change them.

    Each rule can **log only**, **delete the message**, **delete and time out** (member names: **time out** or
    **kick**), and post an **alert** to a channel with who, where, what matched, what was done and the message. Every
    matching message is deleted; a member is timed out, kicked and reported once per rule per 30 seconds. Moderators
    (optional), exempt roles and exempt channels are skipped; the server owner is never punished. The first rule that
    matches acts, and a message AutoMod acted on isn't also handled by Message checks. The bot needs **Manage
    Messages** to delete, **Timeout Members** or **Kick Members** to punish. Edited messages aren't checked.
  - **Message checks** — CONDUIT's own checks on the messages the bot sees,
    acting through the bot. They work only while CONDUIT is running. **Off by default**, and every check starts on
    **Log only**:
    - **Repeated messages** — the same message *N* times within *S* seconds (default 3 in 30 s);
    - **Message flooding** — more than *N* messages within *S* seconds (default 8 in 10 s);
    - **Excessive caps** — at least *P*% capital letters in a message of at least *L* letters (default 80%, 12);
    - **Invite links** — a Discord invite (discord.gg/…, discord.com/invite/…).

    Each check's action is **Log only**, **Delete the message** (needs Manage Messages) or **Delete and time out**
    (also needs Timeout Members; 1 minute – 28 days). A member gets one response per check per 30 seconds, not one per
    message. Moderators (Manage Messages, Timeout, Kick or Ban Members, Administrator) are skipped unless you untick
    that, and you can exempt roles and channels. Message text is checked in memory and never stored; caps and invite
    checks need the Message Content intent.
  - **Anti-nuke** — reads the server's audit log and counts what each
    person does: channels deleted or created, roles deleted or created, dangerous permissions given to a role
    (Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban or Kick Members, Mention
    Everyone), members banned, kicked or pruned, bots added and webhooks created. Each rule trips at *N or more within
    S seconds*; the **Lenient**, **Balanced** (default) and **Strict** presets set them all at once.
    - **Off by default**; switched on it starts in **Alert only (dry run)**: trips are recorded and posted to the
      alert channel, and nothing is done to anyone.
    - In **Enforce** mode the person is stopped with the chosen response: **Quarantine** (their roles are removed —
      except managed roles and roles not below the bot's — and saved), **Time out**, **Kick** or **Ban**. Optionally,
      bots added by someone who trips *Bots added* are removed too.
    - Never acted on: CONDUIT's own bot, the server owner, **trusted people** (user IDs) and members with a **trusted
      role**. The page warns when you enforce with nobody trusted, or have no alert channel.
    - **Quarantine** lists the members stopped that way: **Restore** gives back the roles CONDUIT removed (keeping
      any they have now); **Release** closes the entry without giving them back.
    - The bot needs **View Audit Log**, plus **Manage Roles** (its role above theirs) to quarantine, or Timeout, Kick
      or Ban Members for those responses. The alert channel must be in the same server; alerts carry no CONDUIT
      branding. Works only while CONDUIT is running.
  - **Anti-raid** — watches members joining. The **Lenient**, **Balanced**
    (default) and **Strict** presets set the join threshold and the join-gate checks.
    - **Join bursts:** *N or more joins within S seconds* (default 10 in 10 s) is a raid. **Off by default**;
      switched on it starts in **Alert only (dry run)**. In **Enforce** mode a raid starts a **lockdown**.
    - **Lockdown:** raises the server's verification level (to Medium, High or Highest; never lowers it) and/or stops
      @everyone sending messages, creating threads and reacting in the channels you choose. What was there before is
      saved and put back when it lifts: automatically after the set minutes without new joins (or only by hand), or
      with **Lift lockdown**. Raise one by hand with **Lock down now** (it stays until you lift it); **Preview** shows
      what it would do and what the bot is missing. If Discord refuses part of a lift (the bot lost Manage Roles, for
      example), what couldn't be put back stays listed, with the problem, and **Lift lockdown** tries it again.
    - **Join gate** (in the Anti-raid panel): flags new accounts younger than a minimum age and/or without a profile
      picture. Flagged members are reported (**Alert only**), **kicked**, or **held** — buttons with the **Verify**
      action (Embed Creator) won't let them in. Verify is also paused during a lockdown.
    - The bot needs **Manage Server** (verification level), **Manage Roles** (locking channels) and **Kick Members**
      (join gate kicks). Alerts go to a channel in the same server, with no CONDUIT branding.
  - **Bot bait** — trap channels real members are told not to post in (e.g. a new *#do-not-post*); anyone who posts
    there anyway is treated as a spam account. Bots, moderators (unless you untick it) and exempt roles are never
    acted on. **Off by default**, and **Alert only** until you choose an action: **Delete the message**, **Delete and
    time out**, **Delete and kick**, **Softban** (ban and unban straight away, deleting their recent messages; they
    can rejoin) or **Ban** (optionally deleting their last hour to 7 days of messages). Each post is removed, but a
    member is punished once per 30 seconds. **Warning message** posts a "Do not post in this channel" notice in a bait
    channel (no CONDUIT branding). Bait posts aren't also counted by the message checks. The bot needs View Channel
    and Manage Messages in the bait channels, plus Timeout, Kick or Ban Members for those actions.
  - Everything CONDUIT protection notices or does appears in **Logs → Moderation log** as *Protection: check name*,
    *Anti-nuke: rule*, *Anti-raid: …*, *Join gate* or *Bot bait*, with the result (*Done*, *Failed* with Discord's reason, or
    *Detected only*).
- **Logs → Moderation log** — everything in your server, newest first:
  - CONDUIT's moderation commands with Discord's answer: time, command and who ran it, user, action, reason and result
    (*Done* or *Failed* with the reason);
  - what CONDUIT protection noticed or did (*Protection: …*);
  - from Discord's audit log: bans, unbans, kicks and timeouts done with **Discord's own buttons** (*In Discord by …*)
    or **by other bots** (*By … (bot)*), and **AutoMod**'s actions (*AutoMod: rule name* — message blocked, flagged
    or member timed out). The bot needs **View Audit Log** to see these. Each audit entry is recorded once, and
    CONDUIT's own actions aren't listed twice;
  - everything **Discord Logging** posts — members (joins, leaves, nicknames, roles), messages (deleted, edited,
    bulk-deleted) and server changes — with its category (*Messages log*…) and whether it was posted.

  It also says which permission the bot still needs in each server.

### Discord moderation commands

| Command | Does | Member needs | Bot needs |
| --- | --- | --- | --- |
| `/timeout user minutes [reason]` | Times the member out (1 minute – 28 days) | Timeout Members | Timeout Members |
| `/untimeout user [reason]` | Removes a timeout | Timeout Members | Timeout Members |
| `/kick user [reason]` | Removes the member from the server (they can rejoin with an invite) | Kick Members | Kick Members |
| `/ban user [reason] [delete_days]` | Bans; optionally deletes their messages from the last 0–7 days | Ban Members | Ban Members |
| `/unban user [reason]` | Lifts a ban (paste the user's ID) | Ban Members | Ban Members |
| `/slowmode duration [channel] [reason]` | Sets slowmode (Off to 6 hours) | Manage Channels | Manage Channels |
| `/lock [channel] [reason]` | Stops @everyone posting there and posts "🔒 This channel is locked." | Manage Channels | Manage Roles |
| `/unlock [channel] [reason]` | Undoes /lock and posts "🔓 This channel is unlocked." | Manage Channels | Manage Roles |

**Settings commands (Admin):**
- `/sticky set <#channel> <message>` (`\n` starts a new line), `/sticky remove <#channel>`, `/sticky list`.
- `/loyalty add-xp | remove-xp | add-points | remove-points <user> <amount> [reason]`, `/loyalty reset-user <user>`, and
  `/loyalty reset-leaderboard` (asks for a Confirm click; points aren't changed). Registered while Loyalty & Rewards
  is on.

- Discord shows these commands only to members with the permission, and CONDUIT checks it again on every use.
- Like Discord's own tools, a member can't act on themselves, on the server owner, or on anyone whose highest role is
  the same as or above theirs (the server owner can act on anyone).
- The add-bot link asks for the permissions these commands need (Timeout, Kick and Ban Members, Manage Channels, Manage
  Roles). If any were unticked when the bot was added, give them to the bot's role (Server Settings → Roles), and keep
  the bot's role above the roles of members it should moderate.
- The bot answers in the first person — *"I've timed out Fan for 10 minutes."*, *"I couldn't ban Fan because Discord
  denied the request: …"*, *"I can't do that because I don't have the "Ban Members" permission here."* — and says it did
  something only after Discord confirmed it. The Discord Bot → Logs moderation log keeps the operator wording.
- The answer is private to the member who ran the command and comes only after Discord answered. The reason appears in
  the server's audit log.

Kick's log lists what CONDUIT did and the bans and timeouts done on Kick itself (Kick reports those; it doesn't
report unbans). On Discord, moderation done outside CONDUIT is read from the server's audit log (see Logs above). In
both logs, select a name for that person's history.

## Navigation

The sidebar is organised by platform: **Overview** (Dashboard, Commands, Giveaways, Timed Messages),
**Discord** (Discord Bot, with its Settings, Protection and Logs tabs; Sticky Messages; Loyalty & Rewards), **Kick** (Kick
Moderation, Kick Notifications, Clips), **Twitch** and **YouTube** (Notifications and Moderation, *Soon*) and **Coming later**.
Pinned to the bottom of the sidebar (always visible): **Settings** and the version. Settings shows About CONDUIT
(version, release channel, build), **Backup & Restore**, **Logs** and the release notes (see [Settings](#settings)).
*Soon* items are gray and can't be opened. Accounts are managed on the **Dashboard**: each connection card shows its
status and has **Manage** / **Continue Setup** (Discord setup; Kick setup, whose Chatbot step shows the Kick Bot
Account).

## Appearance & Themes

**Settings → Appearance & Themes** changes how CONDUIT looks; nothing else. Pick a theme — **CONDUIT Default** (graphite
with ice-blue accents), **Theme Name 1** (midnight and violet), **Retronix Theme** or **SnixSnacks Theme** — with
**Preview** (shown across the whole app, not saved) and **Apply** (saved); **Cancel** goes back to the applied one, and
leaving Settings cancels an unsaved preview. Panels are glossy frosted glass in every theme. **Reset to defaults** goes back to CONDUIT Default. **Show a test notification** / **Test an error** show how
notifications look in the theme. The choice is saved with CONDUIT's settings and restored at startup.

The **SnixSnacks Theme** is neon glass like the SnixSnacks vending machine (purple, blue, cyan and magenta on charcoal):
panels edged with a purple-to-cyan glow and glowing purple buttons.

The **Retronix Theme** is glass like the other themes, in Black Olive, Blue Munsell and Sunset Gold on a page lit
gold and teal, with the Retronix character, animated from his own motion clips: walking while a page loads (large,
in the middle of the page), and beside the newest notification, peeking out from behind its edge or tumbling down
beside an error and coming to rest. He stays beside the note, sized to it, and never covers its text or buttons.

Developers add a theme by adding one entry with its colour tokens (and optionally artwork) to
`apps/dashboard/src/theme/registry.ts`.

## Account status and pop-up alerts

The status of your accounts (Discord bot, Kick accounts, Kick chat) is shown only on the **Dashboard** panels. Feature
pages don't repeat it; they only show problems with their own items (for example a channel where the bot is missing a
permission). When something changes while CONDUIT runs, a **pop-up alert** appears in the bottom-right corner on any
page: Discord or Kick rate limiting requests, the Discord bot or Kick chat disconnecting or connecting again, or a
Loyalty role reward or level-up announcement that couldn't be posted. Information bubbles close after a few seconds,
warnings after ten, errors stay until closed. The same alert isn't repeated within a minute.

## Timed Messages

**Overview → Timed Messages**: a message repeated in your **Kick chat** (as the chatbot, one line of text — Kick chat
has no embeds) or a **Discord channel** (text and/or an embed). Each one can post:

- **every X minutes** (5–1440): the clock starts when it's switched on (nothing is posted at that moment) and restarts
  after each post;
- **after X chat messages** (5–1000) in that same chat or channel, from people — bots, the chatbot and CONDUIT's own
  posts never count, so a timed message can't keep itself going. Counts are saved, so they carry on after CONDUIT
  restarts (15 of 20 before a restart means 5 more after it); switching it on or off or changing its settings starts
  the count again. Discord counts need the bot to be connected;
- **both**: *Wait for both* (X minutes have passed **and** there were X messages — quiet chats aren't spammed) or
  *Whichever comes first*. Each post restarts both counts, so overlapping triggers never send twice; and a timed
  message never posts more than once a minute.

Each one shows its schedule, destination, on/off, message count and latest result. **Duplicate** copies one (switched
off). A failed post (e.g. a missing permission) is shown and tried again after 5 minutes, keeping its count. Off means
never sent.

## Loyalty & Rewards

**Discord → Loyalty & Rewards** is **Discord only** and has two separate systems: **XP and levels** (earned by
chatting, never spent) and **points** (a balance members spend on rewards you deliver yourself). XP is never turned into
points or the other way round. It starts **off**; switch it on under **Overview**. Switching it off keeps every level,
balance and all history.

- **XP:** each message earns a random amount between a minimum and maximum (default 15–25), at most once per cooldown
  (default 60 s) per member. Bots, webhooks and system messages never earn; each Discord message counts once, even if it
  is delivered twice. Repeating the same message earns nothing — this can only be recognised while the bot receives
  message text (the required Message Content intent is on in the Developer Portal).
  XP is kept per server, including when a member leaves and comes back.
- **Levels:** going from level L to the next takes 5 × L² + 50 × L + 100 XP (100, 155, 220, …); the level always follows
  from the total XP, also after an adjustment.
- **Level-up announcements** (optional): in the channel where it happened or one channel you choose, with your text
  and/or an embed (the shared embed editor, with a preview), both using `{user}` (shown as a mention without notifying
  anyone), `{username}` and `{level}`. Each level is announced once, even
  after a restart; adjustments are never announced. A failed post keeps the XP and shows on **Overview**.
- **Role rewards:** a role given at a level. The bot needs **Manage Roles** and its highest role must be above the role;
  roles it can't give can't be chosen, and a refusal (e.g. the hierarchy changed) is shown with the reason and tried
  again at the member's next level-up. Removing a role reward never takes the role away.
- **Points:** one balance per Discord account. Optionally messages also earn points, with their own amount, cooldown and
  daily limit (UTC days); administrators can **Add** / **Remove** points (and XP) under **Members** with a required reason
  (history and audit log). A balance can't go below 0.
- **Rewards and redemptions:** name (what members type in `/redeem`), cost, optional description and limited quantity,
  available on/off; removing one keeps its redemptions. The points are taken when a member redeems; **Mark fulfilled**,
  or **Reject** to give the points (and the quantity) back.
- **Discord commands** (private replies): `/points`, `/rewards`, `/redeem`, and `/level [user]` (level, progress to
  the next one, rank, XP and points) and `/leaderboard` (the top 10) while XP is on. A custom command with the same name is used instead.

Kick chat takes no part (no points, XP or `!` commands). Points history from Kick saved by version 0.5.0, if any, is kept
as it was and shown as older Kick history. Giveaway tickets and Kick Channel Points are separate.

## Discord embeds

Timed Messages, Sticky Messages and Kick Notifications share an embed editor: author and icon, title and link,
description, fields (inline or not, up to 25), thumbnail, image, footer and icon, color, timestamp, with a preview that
looks like Discord. Discord's limits (256-character title, 4096 description, 6000 in total…) are checked as you type
and again before sending. No author is needed — the bot is the message's author. The library: **Save to library**,
load a saved embed (a copy: later library edits don't change messages already configured), **Update** it, **Save as
new** (duplicate) or **Delete from library**. **Send test** posts the message to the chosen channel. The preview shows images as
placeholders because CONDUIT never loads images from the internet; Discord shows the real ones.

Every embed editor has a **Visual | JSON** switch. JSON shows the embed as Discord's message JSON, so you can paste one
in (a whole message, a single embed or a list of embeds) and copy yours out. Every valid change applies straight away;
anything CONDUIT doesn't post (buttons, files, a webhook's name or avatar) is listed and left out.

## Embed Creator

**Embed Creator** (sidebar → Discord) builds a whole message — text and up to 10 embeds, one tab each — visually or as
JSON, and sends it as your bot (**Send as the bot**; the bot needs View Channel, Send Messages and Embed Links there).
Mentions in it never ping. Messages you send are listed under **Embeds** so you can edit them later (**Edit** → **Save
changes in Discord**), send a copy, copy their link, remove them from the list, or delete them in Discord too.

A message's **Name** is also its embeds' name in the embed library, and they're **saved there automatically** a moment
after each change: one embed as *Name*, more as *Name*, *Name (2)*, *Name (3)*… (names are at most 54 characters).
Renaming the message renames those entries, and removing an embed removes its entry; only valid embeds are saved. A
saved embed with the same name is updated, so give each message its own name. Saved embeds can be used by the other
features.

**Buttons & Menus** add Discord's message components: up to 5 rows, each with up to 5 buttons (**+ Buttons**) or one
select menu (**+ Select Menu**, up to 25 options).

- **Buttons** are Blue, Grey, Green or Red, or **Link** buttons that open a website; each has a label and/or an emoji
  (a server emoji as `<:name:id>`) and can be disabled.
- **What they do:** a button, or each option of a menu, runs up to 5 actions in order:
  - **Add a role**, **Remove a role**, **Toggle a role**;
  - **Verify** — the join gate's checks (Anti-raid), then a role. Held accounts are refused, and it's paused during
    a lockdown, so a *Verify* button in a #verify channel gives access to the rest of the server;
  - **Reply privately** — a message only they see.
- **Answering clicks:** CONDUIT's bot answers every click privately (with your reply, or what changed) while CONDUIT is
  running. It needs **Manage Roles**, with its role above the roles it gives; roles it can't give are greyed out.
- **Safety:** what a button does is kept in CONDUIT and only works on the message it was sent with.

## Discord Sticky Messages

**Discord → Sticky Messages** keeps a message at the bottom of a channel (one sticky per channel). Discord can't pin a
message to the bottom, so when people post, the bot posts a new copy and deletes the previous one — **each repost is a
new Discord message**.

- Repost after N messages from people (default every message), at most once every N seconds (default 15): a burst
  causes one repost. Bots (including itself) never trigger it. Nothing is reposted while the sticky is still the newest
  message.
- After a restart, or when the bot reconnects, each sticky checks the channel's newest message and reposts only if it
  isn't the sticky — never a second copy. If someone deletes it, it's posted again after the cooldown.
- Switching one off or deleting it removes the posted copy.
- The bot needs **View Channel, Send Messages, Read Message History** (and **Embed Links** for embeds) in the channel;
  channels where it lacks one can't be chosen. No privileged intent is needed: the bot only notices that someone posted.

## Discord Logging

**Discord Bot → Logs → Discord Logging** posts detailed embeds (Carl-bot-style) for four categories, each to a channel you choose
(several categories can share one), each with its own on/off and event types:

| Category | Events | Needs |
| --- | --- | --- |
| Moderation | bans, unbans, kicks, timeouts and their removal — who did it, reason, until when; AutoMod's actions (message blocked, flagged, member timed out — with the rule and channel); CONDUIT's /ban, /timeout… with the member who ran them | **View Audit Log** for the bot in the server |
| Members | joins (account age), leaves (roles), nickname and role changes | privileged **Server Members** intent |
| Messages | deleted, edited (before/after, jump link), bulk-deleted | text needs the privileged **Message Content** intent; without it logs show who and where |
| Server & roles | channels and roles created, deleted or changed (what changed) | — |

Only completed actions are logged as done (Discord writes audit-log entries only for them; CONDUIT records commands
only after Discord confirmed). *Failed CONDUIT commands* can be turned on; they're labelled *failed (nothing was done)*.
Each event is logged once. Bots' messages and the log channels themselves aren't logged. **Save** is at the bottom of
the panel. Everything Discord Logging posts is also listed in the **Moderation log** below it (moderation events are
already there).

**Privileged intents (required):** Member logs and message text need the *Server Members* and *Message Content* intents,
which CONDUIT requires (with *Presence*): turn them on on the Bot page of your application in the Discord Developer
Portal. There's nothing to switch on in CONDUIT — it starts using them as soon as they're on in the portal. If one is
off, the category that needs it says which to turn on.

## Kick Notifications

**Kick → Kick Notifications** posts in Discord when a Kick streamer goes live — your channel or anyone's.

- **Add streamer:** a Kick channel name or kick.com link (CONDUIT checks it exists) and the Discord channel.
- **The post** (by default, the Retronix layout): *@Role Live now! {streamer} is streaming on Kick!* above an embed
  with the **stream title** as the linked heading, **Category** and **Viewers** side by side, the streamer's profile
  picture small at the top right, the **stream thumbnail as the large image** under everything (Discord's embed image,
  full width), and *kick.com/{streamer}* with the time in the footer. Under the embed: real Discord **link buttons** — by default *Watch {streamer} on Kick!*
  linking to the channel; up to 2, each with a label (≤ 80) and an http(s) link or `{url}`. All of it is editable
  (variables `{streamer}`, `{title}`, `{category}`, `{url}`, `{viewers}`, `{thumbnail}`, `{avatar}` — all from Kick).
  Kick's public API doesn't provide follower counts, so there is no followers field. Kick makes a stream's first
  thumbnail a few minutes after it starts, so the post usually goes out without the image and CONDUIT **edits it to
  add the stream thumbnail** as soon as Kick has one (checked every minute), then keeps it current at most every 10
  minutes while live. Edits never ping the role again. Until then the image is simply left out (no placeholder).
- **Layout:** a notification with a custom layout shows **Use default layout…**. It previews the default post and, after
  you confirm, replaces only the announcement text, embed and buttons in the editor (server, channel, role, delete
  setting, on/off and live tracking stay); nothing is saved until **Save**. Variables are lowercase (`{streamer}`); a
  differently capitalised one such as `{Streamer}` still fills in and is corrected when you save.
- **Role:** optional; without one there's no mention at all. It must be mentionable, or the bot needs Mention Everyone.
- **Preview** shows sample data (labelled as such), with an example picture as the stream thumbnail. **Send test** posts the notification now — marked as a test, with
  the streamer's real current Kick data (no stream image while they're offline), the role shown but not pinged — and
  saves nothing.
- **Delete the post when the stream ends** (optional).
- **How live status is read:** every minute while CONDUIT runs, from Kick's public channel information
  (`GET /public/v1/channels`, up to 50 streamers per request) using your own Kick app (app access token: it acts as the
  app, not as any account, and reads only public information — no rights over other channels). **Check now** checks
  immediately. Kick's webhooks only cover your own channel, so this is what works for other streamers.
- **One post per stream:** each live session (Kick's stream start time) is announced once — repeated checks and
  restarts don't post again. A streamer who is already live when added is announced from their next stream. If the post
  fails, it's retried on the next checks (up to 5 times).
- **When the stream ends:** that session's post is deleted (if chosen) or left. Already deleted counts as done.
- If Kick can't be reached, nothing changes (no post, no deletion) until it can.
- **Twitch Notifications** and **YouTube Notifications** are marked *Soon*.

## Kick Clips

**Kick → Clips** lists the clips of your channel (the main Kick account), made by anyone on kick.com (for example with
Kick's own `/clip` in chat), newest first.
Kick's official API has no clips yet, so the list comes from Kick's website (public data, no login); if Kick changes or
blocks it, the page says so and the clips already listed stay. The list is read when the page is open (at most once a
minute) and with **Refresh**.

- **Post to Discord:** choose a channel under **Clip settings** first. The post is an embed with the clip's title (linking
  to it), who clipped it, the category, the length and the thumbnail, and two buttons: **Watch stream** (your channel)
  while you're live, or **Watch VOD** (the stream the clip was cut from) when you're offline, and **View clip on Kick**.
  Nobody is pinged.
- **Post new clips by themselves:** checks every 2 minutes and posts each new clip once, so a clip made with Kick's
  `/clip` is in Discord within a few minutes. Only clips made after you switch it on are posted, never older ones.
- **Save:** saves the clip as a `.ts` video file (Kick's own format; VLC and most players open it) in
  `Videos\CONDUIT Clips`, or a folder you choose. **Open folder** shows it.
- **Open on Kick** opens the clip's page in your browser.

## Settings

**Settings** is pinned to the bottom of the sidebar.

### Backup & Restore

A backup is a checked copy of CONDUIT's database: everything you've set up (commands, giveaways, notifications,
moderation, settings) and the history. Your Discord and Kick sign-ins are **not** in it: they stay encrypted on this PC
(Windows DPAPI) and keep working after a restore. Kick also replaces its tokens regularly, so old ones wouldn't work
anyway. Caches and logs aren't backed up.

- **Back up now** makes a backup at once. **Back up automatically once a day** (on by default) makes one per day; if
  CONDUIT was closed when one was due, it's made once, about a minute after the next start. The time of the last one is
  stored in the database, so restarts never make extra ones.
- **Where:** `backups` inside the data folder (`%APPDATA%\CONDUIT\backups`; `.devdata\backups` in development), or a
  folder you choose (**Choose folder…** / **Use default folder**). **Open backup folder** shows it in Explorer.
- **Automatic backups to keep** (default 14): older automatic backups are removed, oldest first. Manual and
  before-restore backups are never removed automatically, the newest checked backup always stays, and nothing outside
  the backup folder (or not named like a CONDUIT backup) is ever touched.
- **How a backup is made:** SQLite's `VACUUM INTO` writes a consistent copy of the live database, including recent
  changes still in its write-ahead log. The copy is integrity-checked and gets a SHA-256 checksum in a `.json` file
  beside it before it takes its final name. **Check** re-tests a backup: unchanged since it was made, integrity, and not
  from a newer CONDUIT.
- **Restore…** (checked backups only) asks for confirmation, then: checks the backup, makes a checked
  **before-restore** backup of the current state, and restarts CONDUIT's background service. The swap happens on that
  start, before the database is opened. The replaced database is also kept beside it as
  `conduit.db.before-restore-<time>`. If anything fails, the previous database is put back, and the result is shown
  under Backup & Restore and in the logs. Discord and Kick reconnect by themselves.

### Logs

What CONDUIT recorded while running (the background service's `logs/server.log` and the desktop app's
`logs/desktop.log`, plus their rotated copies), newest first: filter by **Errors / Warnings / Info / Debug**, part of
CONDUIT, **Subsystem** (e.g. kick-chat, discord-bot, backups), date range and text; **Refresh**; **Open log folder**. Known
problems show what to do. Tokens, passwords, keys, OAuth codes and similar secrets are removed before anything is
shown. Only the most recent part of each file is read, so large logs stay fast.

## The Kick Bot Account

**Dashboard → Kick → Manage → Chatbot** shows the **Kick Bot Account** — the separate Kick account the chatbot can post
as: its name, Kick user ID, the permissions Kick granted it and when Kick last verified it, whether the chatbot posts as
it, and the main account it is separate from. Add, reconnect, replace or disconnect it there. Moderation and Channel
Points always use the main account. If the chatbot uses the main account, it says **Not configured**. No tokens or
secrets are ever shown. The Discord bot is managed from **Dashboard → Discord → Manage**.

## Retired: Automations (Phase 11)

The general workflow builder was replaced by the dedicated Timed Messages and Stream Notifications. Its database tables
(`automations`, `automation_runs`) and any saved rows are kept untouched; nothing runs them any more.

## Accounts (dormant)

CONDUIT user accounts, streamer-profile membership and the account administration screens were part of Phase 2.
They are **not used** by the desktop app since Phase 2.3. The tables and server code are kept for future remote or
multi-streamer support. The recovery and rate-limit sections
below apply only to that dormant account system.

## Administrator password recovery (dormant account system)

This replaces a locked-out **administrator's** password with a generated temporary password. It works only on the
PC that hosts CONDUIT, and only while CONDUIT is closed. There is no network endpoint for it.

**Prerequisites**
- You are signed in to Windows as the user who runs CONDUIT. The tool reads and writes that user's data folder.
- CONDUIT is **closed**: every window, so the backend has stopped.
- You know the administrator's **username**.

**Installed app.** Open PowerShell and run (adjust the path if you installed elsewhere):

```powershell
& "$env:LOCALAPPDATA\Programs\CONDUIT\CONDUIT.exe" --recover-admin --username <admin-username> --confirm | Out-Host
```

A dialog shows the result and the temporary password. The same text is printed to the console; `| Out-Host` makes
PowerShell wait for and show it.

**Development or standalone-server installs:**

```powershell
npm run build
npm run recover-admin -- --username <admin-username> --confirm
# optional: --data-dir <folder> to target a specific data folder (defaults to the same folder CONDUIT uses)
```

**What it does**, in one database transaction:
1. Sets a new, randomly generated temporary password (25 characters, about 125 bits), stored only as an Argon2id hash.
2. Signs the administrator out of **every** session.
3. Writes an audit record (`user.password_recovered`, method `local_recovery_tool`).

It also clears the account's failed-login lockout.

**What it refuses to do**
- Run without `--confirm`, or accept a password on the command line (which would end up in shell history).
- Reset a non-administrator. Administrators reset those from User Accounts.
- Reset a disabled account.
- Run while CONDUIT is open.
- Touch a database that fails its integrity check, or one whose schema version doesn't match this CONDUIT build.

**After recovery**
1. Start CONDUIT. It shows "Your session ended". Sign in with the temporary password.
2. CONDUIT shows **"Choose a new password"** instead of the app. Enter the temporary password and a new password
   of your own; it must be different. Until you do, nothing else is available, not even through the API. You can
   only change the password or sign out.
3. After saving, the normal app opens. To verify, **User Accounts → Active sessions** should show only this session.

**Risks and notes**
- Anyone who can run programs as your Windows user can perform this recovery. That person could also read the
  database directly, so the tool grants no new power. Protect your Windows account.
- The temporary password appears **only** on screen. It is never written to a log or the audit trail. Don't save it.
- "CONDUIT appears to be running" right after a crash means a leftover `server.lock`. If you are certain CONDUIT is
  closed, delete `server.lock` from the data folder and retry.

## Sign-in rate limits (dormant account system)

After 5 failed sign-ins for one username within 15 minutes, that username is blocked until the oldest failure is
15 minutes old. More than 20 failures across all usernames within a minute blocks all sign-ins for up to a minute.
A successful sign-in, a password change, an administrator password reset or an offline recovery clears that
account's count. Since Phase 2.1, these limits **survive a restart**: they are rebuilt from the audit log.

## Sessions (dormant account system)

Signing in keeps you signed in across app restarts for up to **14 days**, or until **7 days** without use. Use
**Sign out** in the top bar, or **User Accounts → Active sessions → Revoke**, to end a session immediately.

## Building the installer

```powershell
npm run dist      # → apps/desktop/release/CONDUIT Setup 1.0.0.exe
npm run pack:dir  # → apps/desktop/release/win-unpacked/CONDUIT.exe (quick check, no installer)
```

The installer is a per-user NSIS installer. By default it installs to `%LOCALAPPDATA%\Programs\CONDUIT`, and you can
choose another folder. It creates Start-menu and desktop shortcuts named **CONDUIT** and an Add/Remove Programs entry
("CONDUIT 1.0.0", Retronix). It runs silently with `"CONDUIT Setup 1.0.0.exe" /S` (optionally
`/D=<folder>` as the last argument), and `"Uninstall CONDUIT.exe" /S` removes it. Uninstalling never deletes
your data folder.

The packaged executable has Electron's `RunAsNode`, `NODE_OPTIONS` and `--inspect` fuses disabled, and only loads its
integrity-checked `app.asar`.

The installer is not code-signed yet, so Windows SmartScreen will warn on first run. A code-signing
certificate is a **cost item** (typically paid annually) and is optional for private distribution between
two streamers.

## Troubleshooting

- **"Backend failed" / restarting:** check `logs/server.log`. A common cause is another program using
  port 47820; set `CONDUIT_PORT`.
- **`ELECTRON_RUN_AS_NODE`:** tools launched from VS Code's extension host can inherit `ELECTRON_RUN_AS_NODE=1`, which
  makes Electron behave as plain Node.js. This is handled everywhere CONDUIT is launched:
  - `npm run dev` and `npm start` remove it from the Electron child process only, leaving your shell's environment
    unchanged;
  - the packaged `CONDUIT.exe` ignores it, because its RunAsNode fuse is disabled.

  It only matters if you run the raw development Electron binary yourself, for example
  `node_modules\electron\dist\electron.exe apps/desktop`.
- **`Electron failed to install correctly`:** run `npm run install-electron -w @conduit/desktop`.

- **Locked out after failed sign-ins (`Too many failed attempts`):** wait up to 15 minutes (restarting does not help).
  An administrator can clear another user's lockout by setting a new password for them. A locked-out administrator
  can use the offline recovery procedure.

## Testing

```powershell
npm test             # all unit and integration tests (isolated in-memory databases; never touches your data)
npm run test:watch   # re-run on change
npm run verify       # typecheck + tests + production build
```

Integration tests start a real server on an ephemeral loopback port. They use deliberately cheap Argon2 parameters
for speed; production configuration cannot go below the OWASP minimum.

## Remote access (second streamer's own PC)

**Intentionally not available.** The server binds to loopback only, and configuration validation rejects other
addresses, even though authentication now exists. Remote access needs its own threat model first (TLS, remote abuse
controls, origin handling, cross-device revocation).
