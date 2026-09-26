# Installing Tally

Tally is a Jellyfin app. It connects to a Jellyfin server that you or a friend runs.

- **Someone else runs the server?** You only need the guide for your device below. Ask them for the server's address
  and your Jellyfin account first.
- **You run the server?** Start with [the server plugin](#the-server-plugin). Tally works without it, but the Sports
  section needs it, and so do Samsung and LG TVs.

| Your device | What it takes | Time | Quick start |
|---|---|---|---|
| **Android TV, Google TV, Fire TV, Nvidia Shield** | The free Downloader app on the TV | 5 min | [Android TV and Fire TV](#android-tv-and-fire-tv) |
| **Android phone or tablet** (Android 6 or newer) | A download in the phone's browser | 2 min | [Phones and tablets](#phones-and-tablets) |
| **Samsung TV** (2020 or newer) | A computer on the same network, and Developer Mode on the TV. The server needs the Tally plugin. | 15 min | [Samsung TVs](#samsung-tvs) |
| **LG TV** (2020 or newer, webOS 5+) | A computer on the same network, LG's Developer Mode app and a free LG developer account. The server needs the Tally plugin 2.2 or newer. | 20 min | [LG TVs](#lg-tvs) |
| **Your Jellyfin server** | Windows setup, Docker, a Linux script or Jellyfin's plugin catalog | 5 min | [The server plugin](#the-server-plugin) |
| **A web browser** | Nothing: the server plugin gives Jellyfin's web client the Tally look | | [Other devices](#other-devices) |

Tally isn't in an app store yet, so each guide shows where to get it. You only do this once per device: after that,
Tally updates itself.

## Android TV and Fire TV

For Android TV, Google TV (including the Chromecast with Google TV), Fire TV and the Nvidia Shield.

**If the server's owner sent you a link,** open it on your phone and follow it instead. It's the same steps, and the
Tally it gives you already knows the server's address.

1. **Get Downloader on the TV.** Open the TV's app store, search for **Downloader** (orange icon, by AFTVnews) and
   install it. It's only used to install Tally.
2. **Open Downloader** and choose **Allow** if it asks about files.
3. **Type this address** in Downloader's box and press **Go**:

   ```
   https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk
   ```

4. **Press Install.** The first time, the TV says it isn't allowed to install unknown apps: choose **Settings**,
   switch **Downloader** on, press **Back**, then **Install** again.
5. **Open Tally** and sign in to your Jellyfin server. With Quick Connect, the TV shows a 6-digit code: in Jellyfin
   on your phone, open your profile, then **Quick Connect**, and type it, so nobody types a password with the remote.

You can delete Downloader afterward. When a new version is out, Tally shows an update screen by itself: press
**Download & Update**. Tally installs next to the official Jellyfin app and Wholphin, and doesn't replace either.

## Phones and tablets

1. On the phone, open this link in the browser:
   [Tally.apk](https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk)
2. Open the downloaded file. If Android asks, let the browser install apps, then press **Install**.
3. Open Tally and sign in to your Jellyfin server.

It's the same app as on the TV, laid out for a touch screen.

## Samsung TVs

For Samsung smart TVs from 2020 or newer, with no streaming box. It's the full Tally, with sports, multiview and the
player, built as a TV web app.

**Before you start:**

- The Jellyfin server needs the Tally plugin, 2.1 or newer. Ask its owner. The TV app comes from the plugin, so plugin
  updates also update the TV.
- A Windows, Mac or Linux computer on the same network as the TV.
- **2023 and newer TVs** also need a free Samsung account, once.

**Steps:**

1. **Get Tally for Samsung** for your computer from the
   [latest release](https://github.com/Scdouglas1999/Tally/releases/latest): `Tally-Samsung-Installer-windows.exe`,
   `-macos-arm64`, `-macos-x64` or `-linux`. Open it. It shows **This PC's address**: write it down.
2. **Turn on Developer Mode on the TV.** Open **Apps**, type **1 2 3 4 5** with the remote, switch **Developer mode**
   on, type the computer's address as **Host PC IP**, and press **OK**. Then restart the TV fully by holding the power
   button for 5 seconds.
3. **Back in the installer,** pick your TV, type the server's address and press **Enter**. It installs Tally and
   starts it.
4. **Sign in on the TV with a code.** Tally shows a 6-digit code. In Jellyfin on your phone, open your profile, then
   **Quick Connect**, and type it.

**Stuck?** [The full Samsung guide](tv-web/INSTALL-SAMSUNG.md) covers every screen, including Mac and Windows
security prompts, remotes without number buttons, and what each installer message means.

## LG TVs

For LG smart TVs from 2020 or newer (webOS 5 and up). It's the same full Tally as on Samsung, and the Magic Remote's
pointer works as well as its arrow keys. Multiview plays the tile you're on and shows live cards for the others,
because LG TVs play one video at a time.

**Before you start:**

- The Jellyfin server needs the Tally plugin, 2.2 or newer. The TV app comes from the plugin, so plugin updates also
  update the TV.
- A Windows, Mac or Linux computer on the same network as the TV.
- A free LG developer account, which you create at [webostv.developer.lge.com](https://webostv.developer.lge.com).

**Steps:**

1. **Get Tally for LG** for your computer from the
   [latest release](https://github.com/Scdouglas1999/Tally/releases/latest): `Tally-LG-Installer-windows.exe`,
   `-macos-arm64`, `-macos-x64` or `-linux`. Don't open it yet.
2. **Turn on Developer Mode on the TV.** Install **Developer Mode** from the TV's app store, open it and sign in with
   your LG developer account. Switch **Dev Mode Status** on and let the TV restart. Then open Developer Mode again
   and switch **Key Server** on. Leave that screen up: it shows a **passphrase**.
3. **Open the installer,** pick your TV, type the passphrase from the TV, then the server's address. It installs
   Tally and starts it.
4. **Sign in on the TV with a code.** Tally shows a 6-digit code. In Jellyfin on your phone, open your profile, then
   **Quick Connect**, and type it.

LG's Developer Mode normally runs out after about 50 hours and removes the app. Once someone has signed in to Tally on
the TV, the Jellyfin server renews Developer Mode every day, so Tally stays.

**Stuck?** [The full LG guide](tv-web/INSTALL-LG.md) covers every screen and what each installer message means.

## The server plugin

The plugin runs inside Jellyfin 10.10, 10.11 or 12.1 and later. It adds the Sports section, live channels, the
DVR, Tally for Samsung and LG TVs, and an install page for your friends. Pick the way that matches how you run
Jellyfin:

- **Windows:** download `Tally-Server-Setup.exe` from the
  [latest release](https://github.com/Scdouglas1999/Tally/releases/latest) and run it. It adds Tally to your
  Jellyfin, or installs the official Jellyfin first if the computer has none.
- **Docker:** put the release's `docker-compose.yml` in an empty folder, add your media folders and time zone to it,
  and run `docker compose up -d`.
- **Debian or Ubuntu:**

  ```sh
  curl -fsSL https://github.com/Scdouglas1999/Tally/releases/latest/download/install-linux.sh | sudo bash
  ```

- **Any other server:** in Jellyfin, go to **Dashboard → Plugins → Manage Repositories** (on 10.10:
  **Dashboard → Catalog**, then the gear icon), and add
  `https://raw.githubusercontent.com/Scdouglas1999/Tally/main/server/manifest.json`. Install **Tally** from the
  catalog, then restart Jellyfin.

Every method keeps the plugin updated through Jellyfin's own plugin updates.

**Then invite people.** In Jellyfin, open the Tally page (**Sports** in the menu, or **Dashboard → Tally**), then
**Settings → Tally on a TV**: it has a link, a QR code and a Share button. A friend who opens the link gets the Android TV steps above with your server filled in, and signs in
from their phone, so nobody types a password with a remote. If friends reach your server from outside your home,
set **Public server address** under **TV app install link** first.

**More detail:** [server/install/README.md](server/install/README.md) explains what each method does, which build
fits which Jellyfin version, and how to remove the plugin.

## Other devices

- **A web browser:** there's nothing to install. With the plugin, Jellyfin's web client gets the Tally look and a
  Sports page. The server's owner can turn this off in Tally's settings.
- **Xbox, and Jellyfin Media Player on a computer:** their Jellyfin apps load the server's web client, so they get
  the same Tally look.
- **iPhone, iPad, Apple TV and Roku:** there's no Tally app yet. The official Jellyfin apps work with the server
  as usual.
