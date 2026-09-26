<p align="center"><img src="tally/readme/header.png" alt="Tally" width="100%"/></p>

<p align="center">
  <a href="https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk"><img src="tally/readme/button-download.svg" alt="Download for Android" height="44"/></a>
  <a href="#install"><img src="tally/readme/button-install.svg" alt="How to install" height="44"/></a>
  <a href="https://github.com/Scdouglas1999/Tally/releases/latest"><img src="tally/readme/button-releases.svg" alt="What's new" height="44"/></a>
  <a href="https://www.patreon.com/SeanDouglas"><img src="tally/readme/button-patreon.svg" alt="Support on Patreon" height="44"/></a>
</p>

<p align="center"><img src="tally/readme/tour.webp" alt="Moving through Tally: the home screen with today's games, then a film's page" width="100%"/></p>

## Why it looks like this

Tally is a Jellyfin app for Android TV and Android phones. It plays your films, shows and music, and tonight's games
if your server has live TV.

A tally light is the small lamp on top of a studio camera. When it's lit, that camera is on air. Tally borrows the
whole feel of a control room: a dark screen, square edges, clear type, and a single amber light for whatever has
your attention, the thing you've selected or the game that's live right now. Everything else stays out of the way.

When the app starts, its light sputters for a moment and catches once your server answers.

The type is IBM Plex, set large enough to read from across the room. On a TV, focus is always a solid frame around
the thing you've selected, so you never have to hunt for it.

## Your library

<p align="center">
  <img src="tally/readme/library.jpg" alt="The Movies library" width="49%"/>
  <img src="tally/readme/film.jpg" alt="A film's page" width="49%"/>
  <img src="tally/readme/series.jpg" alt="A season as a numbered episode list" width="49%"/>
  <img src="tally/readme/album.jpg" alt="An album page" width="49%"/>
</p>

Home opens on what you were in the middle of, then what's new in each library, and every library has its own page to sort, filter and jump through by letter. A film's page has the title art, the
cast, and the format, audio and subtitle tracks, so you know what you're about to play before you press it. A season
reads like a rundown sheet: numbered episodes, the one you're up to marked, and how far you got through it.

Music gets proper album and artist pages. The now-playing screen follows along with synced lyrics when your files
have them.

In the player you get preview thumbnails while you skip, and a panel that slides in from the side for audio,
subtitles, playback speed, picture quality and the sleep timer. If a stream is struggling, pick a lower quality
right there: 4K down to 360p, in small steps, and it works on live channels too.

## Live sports

<p align="center"><img src="tally/readme/score.webp" alt="The Sports section: a live game's score rolls from 3 to 4 as the Gulls score" width="100%"/></p>

With the Tally server plugin, Tally knows what's being played today and which of your channels carries each game.
Today's games show up on the home screen and get a section of their own, with the score, the inning or quarter and
the clock. When a team scores, the numbers roll over like an old stadium scoreboard.

- **Watch from any game card.** Tally opens the channel the game is on.
- **A score bug in the player**, a box score one press away, and a list of whatever else is on right now.
- **Multiview.** Up to four games at once. The sound follows the one you've selected.
- **A game in the corner.** Keep one game small in the corner while you watch something else full screen.
- **Your teams first.** Follow a team and its games move to the front. Catching up on a game later? Turn scores off.
- **A scores screensaver**, for when the TV is on and nobody's watching.

<p align="center">
  <img src="tally/readme/live.jpg" alt="A live game with the score bug" width="49%"/>
  <img src="tally/readme/multiview.jpg" alt="Multiview with several games" width="49%"/>
</p>

The games come from a public scoreboard feed. The video comes from your own live TV sources (M3U playlists, XMLTV
guides, HLS streams), added in the plugin's settings. Tally doesn't provide any channels.

When your sources have more than one stream of the same game, the plugin keeps them all and plays the best one:
the highest frame rate and resolution that your server can download fast enough. If that stream starts to
stall, the next part of the game comes from the next stream in line, and the picture keeps going without a
reload. After a few steady minutes it goes back to the better stream, if that one has recovered.

The plugin also watches how steadily each stream arrives. If one comes in stop-and-go bursts, Tally moves to a
steadier copy of the game. If there's no steadier copy, it starts a little further behind live so the pauses don't
reach your screen.

**Record a game.** Press and hold a game and choose Record, or record every game of a team you follow. The server
records in the background, stops when the game is over, not when the listing ends, and checks there's room
first. You can start watching from the beginning while the game is still going. A recorded game never shows you the
score before you've watched it.

## Watching together

<p align="center">
  <img src="tally/readme/together.jpg" alt="Starting a watch party" width="49%"/>
  <img src="tally/readme/surprise.jpg" alt="Surprise me picking tonight's film" width="49%"/>
</p>

Start a watch party from the home screen and friends on the same server can join from their own TVs or phones.
Play, pause and skip happen for everyone at once. It runs on Jellyfin's SyncPlay, so nothing extra is needed on the
server.

If you're watching in the same house, Tally shows what's playing on the other TVs, and you can send what you're
watching to another one and pick it up there.

And for the nights nobody can decide, **Surprise me** picks a film or a show from your library. Narrow it to
something under two hours, kid-friendly or unwatched, or a genre, and shuffle until something sticks.

## On your phone

<p align="center"><img src="tally/readme/phone.webp" alt="Tally on a phone: the home screen, a film's page, a game's sheet, and now playing with synced lyrics" width="100%"/></p>
<p align="center"><img src="tally/readme/phone-live.webp" alt="The Sports list on a phone, and a live game in the landscape player with the score bug" width="100%"/></p>

The same app runs on Android phones. On a TV nothing changes; on a phone, every page is laid out for one hand:

- **A bar along the bottom** for Home, Movies, Shows, Sports and More.
- **Touch.** Tap to open or play. Press and hold anything for the menu that a long press of OK opens on the TV.
  Menus and dialogs slide up from the bottom of the screen.
- **Portrait pages, a landscape player.** Browsing stays upright; the player turns sideways and fills the screen,
  with the score bug on live games.
- **Music in the background.** Leave the app or lock the phone and the album keeps playing, with controls in the
  notification and on the lock screen.

Sports, multiview and watch parties work on the phone too, from the same server.

**Downloads.** Download a film, an episode, a season or an album to the phone, at its original quality or a smaller
size, and watch it with no connection. With no server in reach, Tally opens straight to your downloads, and
what you watch offline is marked as watched once you're back.

## Everything else

Under the new look, Tally is built on [Wholphin](https://github.com/damontecres/Wholphin), so it plays nearly
anything Jellyfin can serve. It direct plays when your TV or phone can handle the file and transcodes when it
can't. You also get subtitle styling, ExoPlayer or MPV playback, profiles with PINs, a customizable home screen and
[Seerr](https://github.com/seerr-team/seerr) requests.

When a film in a collection ends, Tally offers the next one. Otherwise it suggests something like it. And when a
new version of Tally comes out, the app offers to update itself the next time you open it.

If you normally reach your server over the internet and the internet goes down, Tally switches to the server's
home-network address and keeps playing. It switches back when the internet returns.

## Install

Tally runs on Android TV, Google TV, Fire TV and the Nvidia Shield, and on Android phones (Android 6 or newer). One
download covers all of them. It isn't in an app store yet.

**On a TV,** you install it with **Downloader**, a free app most TVs have in their store:

1. Install **Downloader** on your TV and open it.
2. Type in this address and let it download:
   `https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk`
3. Install it when Downloader asks, then open Tally and sign in to your Jellyfin server. You can delete Downloader
   afterward.

**On a phone,** open [the same address](https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk)
in the phone's browser, open the downloaded file, and let the browser install apps when Android asks.

Tally installs next to the official Jellyfin app and Wholphin, and doesn't replace either.

**If you run the server,** the Tally plugin gives your friends an easier way in. It adds an install page to your
Jellyfin server with a short Downloader code, and the app it hands out already knows your server's address. Friends
then sign in from their phone with Quick Connect, so nobody has to type a password with a remote.

### Samsung TVs

Tally also runs on Samsung smart TVs from 2020 on, with no streaming box. It's the same Tally, with sports,
multiview and the player, rebuilt as a TV web app. The TV app comes from your server's Tally plugin, so the server
needs the plugin (2.1 or newer), and plugin updates update the TV.

Installing it takes a computer on the same network: turn on the TV's Developer Mode, then run
**Tally for Samsung** (`Tally-Samsung-Installer-windows.exe`, or the Linux and macOS versions, from the
[latest release](https://github.com/Scdouglas1999/Tally/releases/latest)). It finds the TV, signs Tally for it and
installs it. [tv-web/INSTALL-SAMSUNG.md](tv-web/INSTALL-SAMSUNG.md) walks through every step. On 2023 and newer
Samsung TVs, the installer asks you to sign in with a free Samsung account once.

### LG TVs

LG smart TVs from 2020 on (webOS 5 and newer) get the same Tally: sports, the player, multiview (the focused tile
plays and the others show live cards, since LG TVs play one video at a time), and the Magic Remote's pointer as well
as its arrow keys. Like on Samsung, the TV app comes from your server's Tally plugin, so plugin updates update the TV.

Installing it takes a computer on the same network and LG's free **Developer Mode** app on the TV, which needs a free
LG developer account. Then run **Tally for LG** (`Tally-LG-Installer-windows.exe`, or the Linux and macOS versions,
from the [latest release](https://github.com/Scdouglas1999/Tally/releases/latest)). It finds the TV, asks for the
passphrase the Developer Mode app shows, and installs Tally. [tv-web/INSTALL-LG.md](tv-web/INSTALL-LG.md) walks
through every step. LG removes apps installed this way when Developer Mode's session runs out; once someone has
signed in on the TV, the server's Tally plugin renews that session every day, so Tally stays.

## The server plugin

Tally is a complete Jellyfin app on its own. The server plugin adds the parts that need the server's help:

- live scores and the game-to-channel matching behind the Sports section
- live TV channels from your sources, with a guide, for Jellyfin and every app that uses it
- several streams per game, with the switch to a working one when a stream struggles
- the install page and the short Downloader code
- **Play on TV**: start something on your TV from Jellyfin in your phone's browser
- recording games in the background (the DVR)
- the Tally TV app for Samsung and LG TVs, and keeping LG's Developer Mode on for it
- the Tally look for Jellyfin in a web browser, with a Sports page (you can turn it off in the plugin's settings)

It works with Jellyfin 10.10, 10.11 and 12.1. Its source is in [`server/`](server/), in this repository, under the
same license as the app. Without the plugin, Tally hides the Sports section and works like any other Jellyfin app.

There are four ways to install it, all described in [server/install/README.md](server/install/README.md):

- **Windows:** run `Tally-Server-Setup.exe` from the [latest release](https://github.com/Scdouglas1999/Tally/releases/latest).
  It adds the plugin to your Jellyfin, or installs the official Jellyfin first if the computer has none.
- **Jellyfin's plugin catalog:** add `https://raw.githubusercontent.com/Scdouglas1999/Tally/main/server/manifest.json`
  under Dashboard → Plugins → Manage Repositories, then install Tally from the catalog.
- **Docker:** `docker compose up -d` with the release's `docker-compose.yml` runs the official Jellyfin image with the
  plugin in place.
- **Debian and Ubuntu:** `curl -fsSL https://github.com/Scdouglas1999/Tally/releases/latest/download/install-linux.sh | sudo bash`

Whichever you use, new versions of the plugin then come through Jellyfin's own plugin updates. None of these include
Jellyfin itself; when it is needed, it comes from Jellyfin's own servers.

## Building it yourself

```sh
./gradlew :app:assembleDefaultDebug
```

The server plugin builds with the .NET SDK: `server/build.sh` (see [server/README.md](server/README.md)).

The app's own code is in `app/src/main/java/io/github/scdouglas1999/tally/`. The rest of the app is Wholphin's, and
Tally changes it only at marked places so it can keep taking Wholphin's updates. [TALLY.md](TALLY.md) explains how that works,
[tally/UI.md](tally/UI.md) describes the design, and [CONTRIBUTING.md](CONTRIBUTING.md) covers bug reports and pull
requests.

## Support Tally

Tally is free, and it will stay free. If it's become part of your evenings and you're able to chip in, you can
support its development on [Patreon](https://www.patreon.com/SeanDouglas). It pays for the time that goes into it.
Either way, thanks for using it.

## Credits

Tally started as a fork of **[Wholphin](https://github.com/damontecres/Wholphin)** by
[damontecres](https://github.com/damontecres), and it wouldn't exist without it. The player, the library, settings
and most of what happens between pressing play and a picture appearing are Wholphin's work, along with its
contributors and translators. If you like Tally, give Wholphin a star too.

Thanks also to [Jellyfin](https://jellyfin.org), the free media server Tally talks to, and to IBM for the Plex
typefaces.

The teams and scores in these screenshots are made up. The video under them is real game footage from Wikimedia
Commons, cropped and looped:

- [Boys Varsity Baseball v. U-32, May 19, 2026](https://commons.wikimedia.org/wiki/File:Boys_Varsity_Baseball_v._U-32_-_MAY_19,_2026.webm)
  by Hardwick Community Television (HCTV), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [Matthew Dipasupil Summer 2014 Baseball Video](https://commons.wikimedia.org/wiki/File:Matthew_Dipasupil_Summer_2014_Baseball_Video.webm)
  by Keen Eye Sports, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- [Milton Touchdown Pass to Davis](https://commons.wikimedia.org/wiki/File:Milton_Touchdown_Pass_to_Davis.webm)
  by [elisfkc](https://www.flickr.com/photos/127662106@N04/), [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/);
  the two screenshots that show it (`multiview.jpg`, `phone-live.webp`) are shared under the same license.

The film behind the watch-party dialog is *Big Buck Bunny*, © Blender Foundation, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Other film and album artwork in the screenshots belongs to
its owners.

## License

Tally is free software under the [GNU General Public License, version 2](LICENSE), the same license as Wholphin.
[NOTICE.md](NOTICE.md) sets out what Tally changed and when, and the third-party material it includes. The
screenshots in `tally/readme/` show footage and artwork that aren't Tally's; [Credits](#credits) lists the footage and
its licenses.

Tally isn't affiliated with or endorsed by the Wholphin project, Jellyfin, or any league, team or data provider.
Jellyfin is a trademark of the Jellyfin project. League and team names and logos belong to their owners.
