# Tally server plugin

The Jellyfin plugin behind Tally: live channels from your own sources with a guide, live scores matched to the
channels that carry each game, a live-channel page in Jellyfin's web client, and the install page for the Tally TV app.

## Requirements

- Jellyfin **10.10**, **10.11**, or **12.1** and later. There is one build for each line; the installers and
  Jellyfin's plugin catalog pick the right one.
- Admin access to the Jellyfin dashboard.
- Web page sources only: the headless-browser fallback uses Chrome or Edge when the server has one, and otherwise
  sets up its own Chromium the first time a web page source needs it (see [the headless browser](#the-headless-browser)).
  M3U and direct sources need neither.

## Installing

[`install/README.md`](install/README.md) covers the four ways: the Windows installer, Jellyfin's plugin catalog,
Docker Compose and the Linux script. Every one of them ends with Tally's plugin repository in Jellyfin's list, so
new versions arrive through Jellyfin's own plugin updates.

## After installing

Reload the browser tab once after installing. The Jellyfin web client now looks like Tally (its theme, name and
icon), and its side menu has a **Sports** entry; that entry, the **Live TV** card on the home screen and *Live TV* in
the side menu all open Tally in place of Jellyfin's own Live TV page, for every user, not just admins.

> How: the plugin adds a few tags to `web/index.html` *as it is served* (`Services/WebInjection.cs`): the Tally look
> (`Web/web-look.css` and `Web/web-look.js`) and a script that mounts Tally whenever the web client is on its Live TV
> route (`Web/inject.js`). No Jellyfin files are modified. Each is a switch under **Settings → Jellyfin web client**
> (*Tally look for Jellyfin web* and *Replace Jellyfin's Live TV page with Tally*); switch both off (or uninstall) and
> the web client is exactly as shipped. The look follows jellyfin-web 10.10, 10.11 and 12.
>
> This covers everything built on the web client: browsers, Jellyfin Media Player and the Android and iOS mobile
> apps. Native TV apps (Android TV, Roku, …) have their own Live TV screen and are unaffected; they use the native
> channel (see below).
>
> Admins can also open it from the dashboard drawer: **Plugins → Tally**
> (`…/web/index.html#!/configurationpage?name=JellyTV`).

## Configuring sources

In the app → **Settings → Sources → Add source**:

### M3U playlist (+ optional XMLTV EPG)
- **Playlist URL**: an `.m3u`/`.m3u8` playlist URL (IPTV provider, Pluto TV export,
  HDHomeRun/Channels DVR, etc.)
- **EPG URL**: optional XMLTV `.xml`/`.xml.gz` guide feed — powers the Guide grid
  and "up next" labels (matched via `tvg-id`).
- **Headers**: optional `Key`/`Value` pairs sent when fetching the playlist/EPG
  (e.g. `User-Agent`, `Referer`, cookies for providers that need them).

### Direct streams
- Add individual HLS (`.m3u8`) streams by name + URL, with optional group,
  logo, `tvg-id`, and per-stream headers.

### Web page (auto-extract)
- **Page URL**: paste any web page — Tally scans the HTML and inline scripts
  for `.m3u8`/`.mpd` manifests, player configs (`file:`, `hlsUrl`, …),
  base64-encoded URLs, follows iframes and watch/play links (up to 2 levels,
  bounded page count), then validates each candidate is a live playlist.
- **Headless-browser fallback**: if plain HTTP finds nothing, Tally opens the
  page in a headless browser and sniffs network requests — catches streams that
  only appear after JavaScript runs. See [the headless browser](#the-headless-browser)
  for what it installs the first time.
- Extracted streams are auto-named (from the event page's address or the matchup a link to it names; a page's
  title only counts when it names a game on the scoreboard, since titles are mostly the site's own name and
  tagline — a stream with nothing better to go on is left out) and grouped
  into categories (NBA, NFL, soccer leagues, UFC, sports networks, …). Captured
  Referer/Origin headers are replayed through the proxy automatically.
- Streams on web pages are usually ephemeral (rotating tokens) — the source is
  re-scanned on every refresh, so treat the channel list as a snapshot.
- **Limits**: Cloudflare challenges, heavy JS obfuscation, DRM, and login walls
  can defeat extraction. If the scan finds nothing, the source shows an error
  in Settings → Sources — try the headless fallback, or fall back to a Direct
  stream (grab the `.m3u8` from browser devtools → Network → filter `m3u8`).

### The headless browser
Web page sources use a headless browser for the fallback above and, for the few CDNs that only answer real browsers,
to fetch segments. Tally drives it with Microsoft Playwright, which needs a small driver (Node.js plus the
playwright-core package) that differs per platform, so the plugin zips don't carry it. The first time a web page
source needs the browser, Tally sets it up in the background, once, in its data folder
(`plugins/Jellyfin.Plugin.JellyTV/browser/`, next to the settings, so plugin updates keep it):

1. **The driver** for the server's platform (Windows x64, Linux x64 and arm64, macOS), matching the Playwright
   version the plugin is built with: Node.js from nodejs.org and playwright-core from the npm registry, the same two
   files the Microsoft.Playwright package is assembled from, each checked against a pinned hash. About 60 MB
   (40 MB on Windows).
2. **A browser**: an installed Chrome or Edge if there is one (Windows always has Edge). Otherwise Playwright's own
   Chromium headless shell, installed by the driver's installer: about 120 MB more.
3. **On Linux, Chromium's system libraries.** In a container running as root, which is how the official
   `jellyfin/jellyfin` image runs, Tally installs them itself with the driver's `install-deps` (apt; about 80 MB,
   again after the container is recreated from a new image). Elsewhere the source shows the one command to run as
   root, for example in Docker with a non-root user:
   `docker exec -u 0 <container> <data folder>/browser/driver-<version>/.playwright/node/linux-x64/node <data folder>/browser/driver-<version>/.playwright/package/cli.js install-deps chromium-headless-shell`
   (on a Debian or Ubuntu server the same command with `sudo`), then press **Refresh now**.

Settings → Sources shows the state under each web page source: "Preparing the browser (one-time download, ~NN MB)…",
"Browser ready", or what went wrong. Jellyfin's startup never waits for it; the source is scanned again as soon as the
browser is ready, and a failed setup is retried after ten minutes or on **Refresh now**. A server without a web page
source downloads nothing. To pick the locations yourself, set `PLAYWRIGHT_DRIVER_SEARCH_PATH` (a folder holding
`.playwright/`) or `PLAYWRIGHT_BROWSERS_PATH` for Jellyfin's process.

### How streaming works
All playback goes through the plugin's **signed proxy** (`/JellyTV/Proxy`):
- URLs are HMAC-signed with a per-server secret generated at first run —
  the proxy cannot be abused as an open relay.
- Master/variant playlists are rewritten so every nested playlist and segment
  stays signed.
- Configured headers are injected on upstream requests (playlist + segments).
- When a media playlist is served, the next segments are **prefetched** into a
  bounded in-memory cache (~128 MB) — the player's next requests are memory hits
  instead of upstream fetches. Playlists themselves are never cached.

### Several streams per channel (live ladder)
- Entries that carry the same thing become **one channel with several candidate streams**: a web page's several
  links for one game, an M3U's duplicates (same `tvg-id`, or the same name once HD/FHD/4K/60FPS/BACKUP/ALT/Link 2
  are ignored), and channels of one source that the Games board ties to the same game by team names. The channel
  keeps its id; merged entries disappear as separate channels (their old ids still resolve, so favorites follow).
- Each candidate is probed once when it is found (its renditions, playlist freshness, one timed segment download;
  Jellyfin's own ffprobe fills in resolution and frame rate when the playlist does not say; its playlist watched for
  15 seconds to see how steadily new segments show up), and the other candidates of a channel someone is watching are
  re-probed every few minutes.
- Ranking is quality first (50/60 fps above 25/30, then resolution, then bitrate), but a stream only counts when this
  server downloads it at 1.5× its bitrate, its playlist is live, its segments arrive steadily (not in bursts with
  pauses between them), and it has not failed in the last five minutes.
- The channel address (`/JellyTV/Live/{id}.m3u8`) then serves one continuous playlist of the plugin's own. When the
  stream in use struggles (a segment slower than real time or failing twice, two slow segments in a row, no new
  segment for two target durations) the next segments come from the next healthy stream, with their timestamps,
  PIDs and continuity counters rewritten to continue the old stream — players and Jellyfin's remux see no break.
  A stream whose new segments arrive late (twice in a minute more than 1.5 segment durations after the one before),
  however fast they download, is left for another one that is seen arriving steadily: while there is trouble the
  plugin watches the other streams' playlists (playlists only). A stream known to publish in bursts is started further
  back from its live edge when its playlist is long enough, the extra segments held back and published at real-time
  pace, so the channel keeps moving through the pauses. After three stable minutes it steps back up if the better
  stream downloads at 2× its bitrate and arrives steadily. Every switch is logged (`JellyTV ladder:`), each watched
  channel logs one line a minute (segments published, upstream update gaps, playlist and segment fetch times, how far
  the plugin is ahead of the player and how long the player waited at the live edge), and admins can see the rungs,
  probes, cadence, switch history and those numbers at `/JellyTV/Ladder`.
- A channel with one stream and one rendition is proxied exactly as before.

## Jellyfin Live TV integration

Tally registers a Jellyfin **Live TV tuner** automatically (loopback M3U +
XMLTV endpoints served by the plugin). Once registered:

- The built-in **Live TV** home-screen card and native **Guide** show Tally
  channels on every client (web, Android TV, Roku, Swiftfin…).
- Jellyfin's own DVR/record features work on the streams (Tally's own DVR, below, records by the game instead).
- If you don't see the Live TV row on the home screen, enable it under
  *user icon → Display → Home screen sections → Live TV*, and make sure
  Dashboard → Live TV is enabled.

If the tuner fails to appear after install, check `log_*.log` for a Tally
LiveTV registration warning — you can also add it manually:
Dashboard → Live TV → Tuner Devices → `http://127.0.0.1:8096/JellyTV/livetv.m3u`
(type M3U), then a Guide provider (XMLTV) → `http://127.0.0.1:8096/JellyTV/epg.xml`.

## Games board (live scores)

The **Games** tab is the home screen: every live game in the leagues you follow
with score, clock, situation (down & distance, runners/count) and the last
play, sorted by a *heat* score so late, close games rise to the top. Each game
lists the channels carrying it — matched by channel name ("Chiefs vs Bills"),
by the channel's current EPG programme, or by broadcaster ("ESPN HD"; tagged
`NET`, since a network can be showing a different regional game).

Built on the same data: a live score bug in the player and on multiview tiles,
**switch alerts** while you're watching ("RED ZONE — Switch to FS1"),
**Fill multiview with the hottest games**, and a spoiler-free **Hide scores**
mode.

Data comes from ESPN's public scoreboard feed, fetched **by the server** (one
cached request per league, every ~12 s while a game is live and only while
someone has Tally open or a recording is scheduled). The default leagues are **NFL and MLB**; admins can
add others (`basketball/nba`, `hockey/nhl`, `football/college-football`,
`soccer/eng.1`…) or switch the
whole feature off under **Settings → Live scores**; off means the server makes
no third-party requests of its own. Team logos are loaded by the browser from
ESPN's CDN.

## Recording games (DVR)

The server records games itself, in the background, from the channels Tally already matches to each game. Jellyfin's
own Live TV DVR works from guide times and a fixed end; Tally knows when the game really starts and ends (the
scoreboard), which channel carries it (found late, too: web page sources often list a game's stream only near game
time) and follows the live ladder's continuous playlist through source switches.

- **What to record**: one game, or every game of a team (in its league; college teams can be followed across
  sports). Anyone with Jellyfin's *Allow Live TV recording management* permission can record (admins always can);
  recordings are shared by the whole server and remember who asked for them. In the web UI: **Settings →
  Recordings**; for apps: the API below.
- **Start**: when the game goes live, or up to 15 minutes before the listed start once a channel carries it. No
  channel an hour after the listed start: the job fails with "No stream found for this game". Postponed and
  canceled games cancel their job.
- **While recording**: segments of the channel's `/JellyTV/Live/{id}.m3u8` playlist (the same fetch viewers share, so
  a recording does not double the upstream traffic) are written to `<recordings>/.tally-work/<job>/` as they
  arrive. Breaks the ladder does not already hide (a restart, a gap, a new channel) are spliced so the recording stays
  one continuous timeline. `/JellyTV/Recordings/{job}/playlist.m3u8` (signed, EVENT type) plays everything recorded
  so far and keeps growing: start from the first minute and catch up (**Watch from start** in Settings → Recordings).
- **Stop**: final plus the post-roll (5 minutes by default), the maximum length (6 hours), the free-space reserve, or
  cancel (what was recorded is kept).
- **Finish**: Jellyfin's own ffmpeg remuxes the segments (stream copy, no transcode) into
  `<recordings>/<League>/<Away> at <Home> - <yyyy-MM-dd>.mp4`, with an NFO (title "Away at Home", date, league,
  teams, never the score) and poster, backdrop and thumb art drawn from the game, then the plugin adds it to the library
  that covers the recordings folder (it scans just that folder, first adding the library folder itself if Jellyfin
  skipped it for being empty), so the item appears within seconds and the job (and the game on the board) carries its
  `itemId`. A file Jellyfin picks up later (a library created afterwards, a scan) is noted on the job as soon as it is
  added.
  MP4 because Jellyfin web direct-plays it in every browser (no server remux), and the Tally app's players
  direct-play it too; MKV is the fallback for codecs MP4 cannot hold. When the drive has no room for a second copy
  the segments are joined in place into a `.ts` instead. The work folder is deleted once the file is verified.
- **Restart**: a recording resumes after a Jellyfin restart (the time the server was down is missing, joined without
  a jump); if the game ended while it was down, the recording is finished with what it has.
- **Space**: the folder defaults to `Tally Recordings` next to Jellyfin's data folder; pick a drive with room in
  Settings → Recordings (the page shows its free space). A recording starts only if the estimate (the stream's
  measured bitrate × the rest of a typical game: MLB 3 h, NFL and college football 3.5 h, NBA and NHL 2.5 h, soccer
  2 h, others 3 h) leaves the reserve free (10 GB by default), and stops, keeping what it has, if the drive falls
  below the reserve. Space is judged for when the recording would start, not when the job is made: a scheduled job
  that would not fit today stays scheduled with a warning ("May not fit: …"), waits for space in the pre-roll, and
  fails with "Not enough space" only if there is still not enough when the game starts. At most 3 recordings run at
  once (settable).
- **Retention**: per team "keep the last N games", and "delete recordings after N days" (default: keep everything).
  A recording someone is watching is never deleted.
- **Library**: the first time a recording finishes and no library covers the recordings folder, the plugin creates
  the **Sports Recordings** library itself (a Movies library with every internet metadata and image fetcher off, so
  the NFO and art stay) and logs it. It does that once: if the owner removes that library, it is not created again.
  Settings → Recordings says when no library covers the folder and offers **Create a Sports Recordings library**. A
  library made by hand works too. Recordings whose library is removed lose their library item (`noLibrary`) and get it
  back when a library covers the folder again.

Client API v1 (authenticated): `GET /JellyTV/Client/v1/recordings` (rules and jobs, and whether the caller may
record), `POST /JellyTV/Client/v1/recordings` with `{"gameId": "…"}` or `{"teamId": "…", "league": "baseball/mlb"
| "*", "keepLast": 0}`, `DELETE …/recordings/jobs/{id}` (cancel; a recording stops and keeps what it has),
`DELETE …/recordings/jobs/{id}/recording` (delete a finished recording, its file and library item),
`DELETE …/recordings/rules/{id}`, `GET …/recordings/storage[?gameId=…]` (folder, free, used, reserve, estimate).
Every job carries `libraryState`: `ready` (`itemId` is set), `adding` (a library covers the file, Jellyfin has not
added it yet) or `noLibrary` (no library covers the recordings folder); so does the board's `recording`.
Changes without the permission answer 403 with `{"error": "…"}`. On the board each game with a job gains
`recording: {state, jobId, startOverPath?, itemId?, reason?}`, and `/info` lists the `dvr` feature. Admin:
`GET/POST /JellyTV/Recordings/Settings`, `GET /JellyTV/Recordings/Folder?path=`, `POST /JellyTV/Recordings/Library`.

While a recording rule or job exists, the server reads the scoreboard itself (the same cached requests the Games
board makes, plus the next week's boards of the leagues team rules follow, every three hours).

## TVs and native apps

Native TV apps (Swiftfin on Apple TV, Jellyfin for Android TV, Wholphin, Roku…) are compiled apps with no
web view — nothing can make them load the Tally web UI. Tally works *with* them instead:

- **Playback**: the tuner is registered with a tuner count, so Jellyfin serves the stream itself (a remux,
  no re-encode) instead of handing apps a loopback address they cannot reach.
- **Live cards**: every channel gets a rendered 16:9 card (`/JellyTV/Card/{id}.png`) — team logos, names,
  league and kickoff; while the game is on, the live score, clock, top heat tag and an "as of" time, redrawn
  every 2 minutes. Channels are numbered **hottest game first**, and the guide shows real entries
  ("Jets at Packers") instead of "Live". The native channel grid becomes a heat-sorted scoreboard where
  every card is a play button. Cards are minutes old, not seconds. Switch off under
  **Settings → Live scores → Live cards for TV apps**.
- **Sizes and time zones**: cards and game backdrops (`/JellyTV/Backdrop/{gameId}.png`) take `w=<px>`, the width the
  app draws them at: the server snaps it up to 320, 480, 640, 960, 1280 or 1920 (the art's own size when that is not
  smaller) and caches each size. `tz=<IANA zone>` (`America/New_York`) sets the zone of the times drawn on a card;
  without it, or with a zone the server does not know, the server's own zone is used.
- **Play on TV**: in the Tally web UI (phone, tablet, laptop) tap the screen icon in the top bar and pick
  a TV. From then on every *Watch* — games, channels, switch alerts — plays on that TV through its own
  app, using the same remote-control channel as Jellyfin's cast button. The TV shows up while its app is
  open and signed in as the same user. Works with Swiftfin ≥ 1.5, Jellyfin for Android TV and the Tally
  app (which opens the game in its own player, score bug included); stock Wholphin ignores play commands. **Follow the hottest game** in the same dialog flips the
  TV to whichever game is hottest, while Tally stays open on the phone.

The full web UI itself appears on TV platforms whose Jellyfin app loads the server's web client: LG (webOS),
Xbox, and Jellyfin Media Player on a PC. Samsung's app bundles its own copy of the web client and does not.

### The Tally app for Android TV, Google TV and Fire TV

A fork of Wholphin with a native Tally section (games board, score bug, in-player game switcher, 4-up
multiview, Play-on-TV target). Source and releases: `github.com/Scdouglas1999/Tally`. Against a
server without this plugin it behaves exactly like Wholphin.

What a friend does, start to finish (`/JellyTV/Get` walks them through it):

1. Taps the link you sent (**Settings → Tally on a TV** has the link, a QR code and a Share button; add
   `?u=theirname` to pre-fill their user name).
2. On the TV: installs the free *Downloader* app from the TV's store, types one address
   (`<server>/JellyTV/app`, or a Downloader short code if you set one) and presses Install.
3. Opens Tally. It already knows this server and shows a 6-digit code. They type that code into the page on
   their phone and the TV is signed in. Nothing else is typed with a remote.

How the app knows the server: `/JellyTV/app` does not redirect to GitHub. The plugin keeps a copy of the newest
release APK (refreshed with a conditional request every 10 minutes) and writes the address the TV used into the
APK Signing Block as an extra ID-value pair (`Services/ApkStamper.cs`). The v2/v3 signature does not cover that
area, so the APK still verifies and still updates to and from the plain GitHub build; your address is never
published anywhere. If the fetch or the stamp fails, the endpoint falls back to a plain redirect and the app asks
for the address the usual way. Signing in uses Jellyfin's own Quick Connect (it must stay enabled under
Dashboard → General): the page authenticates the friend, authorizes the code, and signs its own session out.

A web page cannot find a TV and push an app onto it: browsers cannot open connections to LAN devices, and a TV
only installs from its store, from an app already on it, or over ADB after developer mode is switched on by hand.
This flow is the shortest one that needs none of those.

Admins: set **Public server address** under *TV app install link* to the address friends use from outside, so the
link and QR code in Settings are right even when you open Settings from inside the house. Optionally create an
AFTVnews Downloader code for `<public address>/JellyTV/app` and enter it; the page then shows the digits instead.

Updates: installed apps check the GitHub releases on launch and open the install screen by themselves; the viewer
presses Download & Update. How releases are built is in [`tally/README.md`](../tally/README.md).

`/JellyTV/Get`, `/JellyTV/app` and `/JellyTV/Get/qr.svg` are anonymous on purpose (they are used before anyone
signs in) and expose nothing but the server's address.

### Samsung and LG TVs (Tally TV)

Samsung (2020+) and LG (webOS 5+, 2020+) TVs run Tally TV, a web app the plugin serves at `/JellyTV/TV/` (see
[`tv-web/`](../tv-web/)); a small shell installed once on the TV loads it from this server, so a plugin update updates
every TV. The installers are *Tally for Samsung* and *Tally for LG* (release assets; guides in
`tv-web/INSTALL-SAMSUNG.md` and `tv-web/INSTALL-LG.md`).

**LG Developer Mode, kept on.** LG TVs install Tally through LG's Developer Mode, whose session runs out (LG then
turns Developer Mode off at the next restart and removes the app, and an expired session cannot be extended). Tally
for LG stamps the TV's session token into the app; once someone signs in, the TV sends it here
(`POST /JellyTV/Client/v1/lg/devmode` with `{"token": "…", "model": "…"}`, authenticated, answered 204; a token is
letters and digits only, 400 otherwise). The plugin keeps it in its data folder (`lg-devmode.json`, one entry per
TV, at most 20), resets the session once a day with LG's `ResetDevModeSession` (then reads the time left with
`CheckDevModeSession`), tries a failed renewal again after an hour, logs each result, and forgets a TV that has
failed for 14 days. Settings → **Tally on a TV** shows "LG Developer Mode kept on for 1 TV · renewed …" (and any
failure). Tokens are never returned by any endpoint; `/JellyTV/Status` carries only the count, the last renewal and
the last error.

## Building

`./build.sh` tests and builds the plugin for each Jellyfin line and writes the zips the installers and the plugin
catalog use:

| Build | Jellyfin | .NET | Zip |
|---|---|---|---|
| `-p:JellyfinLine=10` | 10.10 | 8 | `dist/Tally-server-<version>-jf10.10.zip` |
| `-p:JellyfinLine=11` | 10.11 | 9 | `dist/Tally-server-<version>-jf10.11.zip` |
| `-p:JellyfinLine=12` | 12.1 and later | 10 | `dist/Tally-server-<version>-jf12.zip` |

`./build.sh 12` builds one line. The version comes from `TallyVersion` in `Directory.Build.props` (or `TALLY_VERSION`);
the plugin is versioned with the app, and the fourth part names the Jellyfin line: Tally 2.0.0 ships plugin 2.0.0.10,
2.0.0.11 and 2.0.0.12. Each build having its own version is what lets Jellyfin's updater replace a build with the
right one after Jellyfin itself is upgraded. 10.11 and 12 moved the user-permission
types (the `JF12` symbol), use SkiaSharp 3 and no longer ship `Microsoft.Bcl.AsyncInterfaces`, which Playwright
needs, so those zips carry it. The zips never carry Playwright's `.playwright/` driver folder (the csproj sets
`PlaywrightPlatform=none`, and `ReleaseZipTests` checks every zip build.sh writes); the plugin downloads the one for
its host (`Services/PlaywrightDriver.cs`, whose pins a test compares with the referenced Microsoft.Playwright package
after every upgrade). The web UI authenticates with `Authorization: MediaBrowser Token=…`; Jellyfin 12 rejects
the older `X-Emby-Token` header.

`install/` holds the installers (see [`install/README.md`](install/README.md)); `manifest.json` is the plugin
repository Jellyfin servers update from, maintained by `manifest.py` when a release is published. How a release is
built is in [`tally/README.md`](../tally/README.md).

## Per-user settings

Favorites, default view, switch alerts and Hide scores are stored **per Jellyfin user** (plugin
configuration directory, keyed by user id). The fantasy-sports integration
planned for a later phase will live under Settings → Fantasy Integration.

## Native channel

The plugin registers an `IChannel` named **Tally**. Clients that can't open
the embedded page (Roku, Android TV, Swiftfin, etc.) see it under
**Live TV → Channels** (or Channels, depending on client), grouped by source
group. Streams play directly via the signed proxy URLs.

## Uninstall / reinstall

Uninstall from **Dashboard → Plugins → Tally**, or stop Jellyfin and delete the `plugins/Tally_<version>/` folder
(`plugins/Tally/` for a manual install). Plugin settings stay in
`plugins/configurations/Jellyfin.Plugin.JellyTV.xml`; delete that too for a clean slate (it also removes the
generated proxy secret, so old signed stream addresses stop working). The headless browser for web page sources, if
one was set up, is in `plugins/Jellyfin.Plugin.JellyTV/browser/` (about 400 MB with Chromium); delete that folder too.

## Troubleshooting

| Symptom | Check |
|---|---|
| Plugin "Malfunctioned" | `log_*.log` for load errors; bad meta.json |
| Page loads but is blank | Hard-refresh (Ctrl+F5) to drop cached web assets |
| Channels list empty | Settings → Sources — check per-source error text |
| Web page source: "Chromium needs system libraries" | Run the command it shows (as root), then Refresh now ([the headless browser](#the-headless-browser)) |
| Stream 403s | Upstream rejected the request (or expired signed URL) |
| Guide empty | Source needs an EPG URL + matching `tvg-id` values |
