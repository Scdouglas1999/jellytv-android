# Installing the Tally server plugin

The plugin runs inside [Jellyfin](https://jellyfin.org) 10.10, 10.11, or 12.1 and later. There are four ways to install it; pick
the one that matches how you run Jellyfin. All four end the same way: the plugin is in Jellyfin's plugins folder,
and Tally's plugin repository is in Jellyfin's list, so new versions of Tally arrive through Jellyfin's own plugin
updates (Dashboard → Plugins).

None of these ship Jellyfin itself. When Jellyfin has to be installed first, it comes from Jellyfin's own servers
(repo.jellyfin.org, or the official `jellyfin/jellyfin` image on Docker Hub).

The files below are attached to every [Tally release](https://github.com/Scdouglas1999/Tally/releases/latest).

## Windows: Tally-Server-Setup.exe

Download `Tally-Server-Setup.exe` from the release and run it. Windows asks for administrator rights; the setup
needs them to stop and start Jellyfin and to write to its data folder. Press **Install**.

- **If Jellyfin is already installed**, the setup finds it (the Jellyfin service, the tray app or a running
  `jellyfin.exe`), stops it, adds `plugins\Tally_<version>` to its data folder (normally
  `C:\ProgramData\Jellyfin\Server`), gives the account Jellyfin runs as access to that folder, and starts it again
  the way it was running. A previous Tally, if there is one, is replaced; its settings are kept. Nothing else is
  changed: not your libraries, users, settings or other plugins. If something fails after Jellyfin was stopped, the
  setup starts it again before reporting the error.
- **If there is no Jellyfin**, the setup downloads the newest official Jellyfin for Windows from repo.jellyfin.org,
  installs it with Jellyfin's installer (as the Jellyfin Server service, data in `C:\ProgramData\Jellyfin\Server`),
  then adds Tally. Jellyfin 12 needs an up-to-date Windows 10 or 11: on a Windows 10 that had not been updated since
  2021 it would not start at all, with or without Tally.

At the end it lists what it did and opens Jellyfin in your browser: the setup wizard on a new server, Tally's page on
one that is already set up. Windows SmartScreen may warn about an unrecognized app the first time; choose
**More info → Run anyway**.

For scripts: `Tally-Server-Setup.exe /quiet` does the same without a window (exit code 0 when done), `/nobrowser`
skips the browser. Every run writes `%TEMP%\Tally-Server-Setup.log`.

A portable Jellyfin (the zip, not the installer) is only found while it is running, so start it before the setup.

## Any server: Jellyfin's plugin catalog

If you can reach Jellyfin's dashboard, you can install Tally from it:

1. **Dashboard → Plugins → Manage Repositories** (on Jellyfin 10.10: **Dashboard → Catalog**, then the gear icon
   next to the title) and add a repository:
   - Name: `Tally`
   - URL: `https://raw.githubusercontent.com/Scdouglas1999/Tally/main/server/manifest.json`
2. Find **Tally** in the catalog (under Live TV) and install it.
3. Restart Jellyfin when the dashboard asks.

Jellyfin picks the build for its own version. Updates then show up like any other plugin's.

## Docker: docker-compose.yml

Put `docker-compose.yml` from the release in an empty folder and run `docker compose up -d`. It starts the official
`jellyfin/jellyfin` image (12.1 unless you set `JELLYFIN_VERSION`, for example `JELLYFIN_VERSION=10.10.7`), with
its config in `./config` and cache in `./cache`. Add your media folders to the `volumes:` list in the file first,
and set your time zone: `TZ` in the file (or in your shell, or an `.env` file next to it) is `America/New_York` unless
you change it. Containers otherwise run in UTC, and Jellyfin's guide and the channel cards it shows would be hours
off (the Tally apps ask for their own zone). The command in the file's comment writes this computer's zone to `.env`.

Before Jellyfin starts, a small one-time service (`tally-plugin`, Alpine Linux) downloads the plugin zip for that
Jellyfin version from the release and unpacks it into `./config/plugins/`. If Tally is already there it leaves it
alone, since Jellyfin keeps it up to date. If you change `JELLYFIN_VERSION` to another line (10.10 to 12, say), it
swaps in the matching build on the next `docker compose up`.

Already running Jellyfin in Docker? Copy the `tally-plugin` service into your own compose file, point its volume at
your Jellyfin config folder, and add the `depends_on` block to your Jellyfin service.

## Debian and Ubuntu: install-linux.sh

```sh
curl -fsSL https://github.com/Scdouglas1999/Tally/releases/latest/download/install-linux.sh | sudo bash
```

If Jellyfin is not installed, the script runs Jellyfin's own install script (`https://repo.jellyfin.org/install-debuntu.sh`),
which adds Jellyfin's apt repository and installs the official packages. Then it stops Jellyfin, puts the Tally build
for the installed Jellyfin version into `/var/lib/jellyfin/plugins/`, starts Jellyfin and prints the address to open.
It needs systemd, and it installs `curl` and `unzip` if they are missing. It leaves the system's time zone alone
(Jellyfin, and Tally's times, follow it) but detects it and prints it at the end, with how to change it when it is UTC.
Running it again only replaces a Tally that is older or built for another Jellyfin version.

On other Linux systems, use the catalog or unpack the zip for your Jellyfin version into a `Tally_<version>` folder
in Jellyfin's `plugins` folder, owned by the user Jellyfin runs as, and restart Jellyfin.

## Web page sources: a one-time download

Nothing here installs a browser. If you add a **web page** source (not needed for M3U playlists or direct streams),
the plugin sets up what its headless browser needs the first time that source needs it: Playwright's driver for the
server's platform (about 60 MB, 40 MB on Windows) and, when the server has no Chrome or Edge, Playwright's Chromium
(about 120 MB). It goes into the plugin's data folder and survives plugin updates; Settings → Sources shows the
progress. On Linux, Chromium also needs system libraries: in the Docker Compose setup above (the official image runs
as root) the plugin installs them by itself; on a Debian or Ubuntu server, or in a container that runs Jellyfin as
another user, the source shows the one command to run as root. Details: the server README's
[headless browser](../README.md#the-headless-browser) section.

## Which build

| Jellyfin | Plugin zip | Plugin version (Tally 2.0.0) |
|---|---|---|
| 10.10.x | `Tally-server-<version>-jf10.10.zip` | 2.0.0.10 |
| 10.11.x | `Tally-server-<version>-jf10.11.zip` | 2.0.0.11 |
| 12.1 and later | `Tally-server-<version>-jf12.zip` | 2.0.0.12 |

The installers and the catalog choose for you. A build for one line does not load on another: Jellyfin shows it as
"Not supported". The last part of the plugin version names the line, which is how Jellyfin tells the builds apart. Jellyfin 12.0 has no build; update it to 12.1 first (Jellyfin's catalog on 12.0 still lists the
10.x builds, which will not load there). **After upgrading Jellyfin to a new line** (10.10 to 12, for example), Jellyfin's plugin updates replace the
build by themselves (2.0.0.10 becomes 2.0.0.12) and ask for one more restart. Running the Windows setup or the Linux
script again, or `docker compose up -d`, does the same at once. Your Tally settings are kept either way.

## Removing it

Dashboard → Plugins → Tally → Uninstall, then restart Jellyfin. Tally's settings stay in
`plugins/configurations/Jellyfin.Plugin.JellyTV.xml`; delete that file too for a clean slate. To stop updates, remove
the Tally entry from Jellyfin's plugin repositories; the plugin adds it only once and does not put it back.
