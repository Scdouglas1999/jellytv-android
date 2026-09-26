# Tally TV (web): architecture

One TypeScript app for Samsung (Tizen), LG (webOS) and desktop browsers, with Tally's own screens (not
jellyfin-web), talking to Jellyfin and to the Tally plugin's Client API. Target: **2020+ TVs, Tizen 5.5+ (Chromium 69)
and webOS 5+ (Chromium 68)**. Samsung comes first (a friend's 2020+ Samsung needs it now); webOS is built from the same
code afterwards.

Status of this document: decisions made in tvweb-0 (September 24, 2026), with what was measured and what still
needs a real TV marked as such.

## 1. The decisions in one table

| Area | Decision | Why, in one line |
|---|---|---|
| Delivery | A small **installed shell** per platform loads the app **bundle from the Tally plugin** (`/JellyTV/TV/`) | One install; every plugin update updates every TV |
| UI | **Preact 10** + **TypeScript** (strict) | 4 KB runtime, React's model, fast enough on TV SoCs; DOM text and hairlines are the design |
| Focus | **Norigin spatial navigation core 4** (framework-free) + a 150-line Preact binding | Proven on TVs; geometry-based D-pad focus with focus groups, boundaries, saved focus |
| Build | **Vite 8** (Rolldown), one **classic IIFE script** + one stylesheet, syntax lowered to **chrome68**, core-js for built-ins | Module scripts need CORS on a `file://` TV page; Chromium 68 is the floor |
| Jellyfin | **@jellyfin/sdk 1.0** (MPL-2.0) over axios | Official, typed, Jellyfin 10.10 to 12 |
| Playback | `PlayerEngine` interface, three engines: **AVPlay** (Tizen), **webOS <video>**, **HTML5 + hls.js** (browsers) | Each platform's native pipeline where it has one |
| Design | Tally tokens on a **1920x1080 canvas**, IBM Plex from the app's `res/font`, focus = the amber frame | Same look as the Android app, measured against its screenshots |
| Tests | Vitest (logic), Playwright in Chromium 1920x1080 against the dev server (flows, also with webOS forced), Tizen emulator (AVPlay, shell) | Logic and flows run anywhere; platform parts need the emulator or a TV |

## 2. Delivery: installed shell + server-served bundle

```
 TV (installed once, ~75 KB)                     Jellyfin + Tally plugin (updated with the plugin)
 ┌──────────────────────────────┐   GET          ┌─────────────────────────────────────────────┐
 │ index.html  (local, file://) │── manifest ───▶│ /JellyTV/TV/manifest.json  (no-cache)        │
 │   webapis.js  (Tizen only)   │                │   { js: app.<hash>.js, css: app.<hash>.css,  │
 │   config.js   (stamped addr) │◀── app.*.js ───│     minShell: 1, version, revision }         │
 │   shell.js    (ES5)          │◀── app.*.css ──│ /JellyTV/TV/app.<hash>.js   (immutable, 1 y) │
 │ window.TallyShell ───────────┼─▶ bundle runs  │ /JellyTV/TV/assets/*.ttf    (immutable)      │
 └──────────────────────────────┘   in this page │ /JellyTV/TV/hls-1.7.3.min.js (browsers only) │
                                                 └─────────────────────────────────────────────┘
```

- **The shell** (`shell/`: `index.html`, `shell.js`, `shell.css`, two woff2 fonts, the platform manifest) is what gets
  installed. It remembers the server address (localStorage), or uses the one the installer stamped into
  `config.js`, or asks for one. It checks `/System/Info/Public`, fetches `/JellyTV/TV/manifest.json`, then adds the
  bundle's `<link>` and `<script>` to its own page and sets `window.TallyShell`. Errors get Tally-styled screens:
  server not answering (Try again / Change server), no TV app on the server ("install or update the Tally plugin"),
  a server that needs a newer shell ("reinstall"). BACK on those screens leaves the app.
- **The bundle runs inside the local page**, so on Tizen it keeps `tizen` and `webapis` (AVPlay, remote keys).
  Samsung documents that hosted apps (a remote *page*) lose the Tizen APIs, and allows external scripts in a packaged
  app; a remote *script* in the local page is the same page. To verify on the Tizen emulator/TV (section 12).
- **Contract** (`src/shell-contract/shell.ts`): `shellVersion`, `platform`, `serverUrl`, `bundleBase`,
  `changeServer(url|null)`, `reload()`, `exit()`, `started()`. Only additive changes; the bundle's manifest carries
  `minShell` and an old shell refuses a bundle that needs more (shows "reinstall").
- **Caching**: `manifest.json` and `index.html` are `no-cache`; everything else has a content hash (or the hls.js
  version) in its name and is `public, max-age=31536000, immutable`. A plugin update changes the manifest, the TV
  fetches the new files once.
- **Plugin side**: `server/build.sh` builds tv-web (`npm ci && npm test && npm run build`) and embeds
  `dist/bundle/` in the plugin DLL (`TvWeb/**` → `TallyTvWeb/<path>` resources); `Api/TvAppController.cs` serves them
  anonymously (the shell needs them before sign-in; they hold only code) with an explicit
  `Access-Control-Allow-Origin: *` (fonts are fetched cross-origin from the TV's `file://` page).
  `TALLY_SKIP_TV_WEB=1` builds a plugin without the TV app (never for a release). Verified on a throwaway Jellyfin
  10.10.6 container: manifest `no-cache`, bundle `immutable`, traversal 404, `/JellyTV/TV` redirects to the browser
  version, and the shell loaded the bundle from it and reached Quick Connect.
- **The same bundle in a browser**: `/JellyTV/TV/index.html` on any Tally server is a working desktop version
  (it defaults to the server that served it).
- **Offline**: nothing to do without the server (no downloads on TVs), so the shell shows the error screen with
  Try again. A cached copy of the bundle is not kept.
- **Security**: the bundle travels like every other request of the app (http on a LAN, https when the server has
  it). Someone who can tamper with that traffic can also read the Jellyfin token; nothing new. The endpoint is
  read-only static files.

## 3. UI stack

**Preact + TypeScript, DOM rendering, Norigin core for focus.**

- Considered **Lightning.js** (WebGL canvas, very fast on weak SoCs): rejected. Tally's design is text, hairlines,
  mono type and posters; in Lightning every one of those becomes custom texture work, text wrapping and fonts are
  harder, and the plugin's web UI (the same design) is DOM already. DOM on a 2020 Tizen/webOS set is fine when the
  app avoids the expensive things (below).
- Considered **React**: same model, 10x the runtime. **Solid/Svelte**: fine, but Preact keeps the React idioms most
  workers know and costs 4 KB.
- **Norigin spatial navigation core** (MIT, the engine behind their React package) instead of writing one: focus
  groups (`FocusGroup`), boundaries (pages, dialogs), saved last focus per group, preferred child. The binding is
  `src/focus/focus.tsx`. Keys do not go to Norigin directly: `platform/keyRouter.ts` owns every key.

Performance rules (the reason a DOM app is quick on a TV):
- Focus changes do **not** re-render: Norigin's adapter sets `data-focused` on the element and CSS draws the amber
  frame from it. Components re-render on focus only when they draw something new (the Home header).
- Scroll containers move with `scrollLeft`/`scrollTop` (never transforms: the focus system measures through scroll
  offsets), instantly, without smooth scrolling.
- No blur, glow, shadows (the design forbids them anyway), no animated layout. The lamp is the only animation and
  writes one element's styles from `requestAnimationFrame`.
- Images are requested at the size they are drawn (`fillWidth/fillHeight` at the 1080p canvas): backdrops 1400x788
  (their box), team logos through ESPN's image combiner at the mark's size (the board's logos are 500 px PNGs, one
  NFL logo is 4096 px: 64 MB decoded for a 51 px mark). The plugin's own game art (`/JellyTV/Backdrop/…`,
  `/JellyTV/Card/…`) is asked for with `w=<drawn width>` and `tz=<the TV's zone>` (`api/tally.ts artUrl`, 2.2
  contracts 1-2: Home's game backdrop 1400, a channel card 384, a multiview tile's card 960); older plugins ignore
  both. The zone is left out when the runtime does not know it or says UTC while the clock is not at UTC.
- A backdrop that follows focus (Home, library) changes only once focus rests on a card (`useSettledBackdrop`:
  the old picture goes at once, the new one after 600 ms, as Android's BackdropService), so moving along a row does
  not fetch and decode a large picture per card.
- Focus keys follow the item, not its place (`home-game-<id>`, `home-<row>-<item id>`): a row that reorders (the
  board's sort, followed teams arriving after the board, Continue Watching after playback) keeps focus on the card.
  With keys by index, Home sometimes came up with no focus at all (the reordered row removed the focused key).
- Hidden pages stay mounted (`display: none`) instead of re-rendering on BACK.

## 4. Build and the Chromium 68 floor

- `vite build` → `dist/bundle/`: `app.<hash>.js` (IIFE, 390 KB, 103 KB gzipped), `app.<hash>.css` (21 KB), fonts
  (IBM Plex 7 files + Font Awesome Solid, 1.7 MB, straight from `app/src/main/res/font/`), `hls-<ver>.min.js`,
  license files, `manifest.json`, `index.html` (the browser version). Vite plugin `tally-bundle` in `vite.config.ts`.
- **Syntax**: lowered to `chrome68`. **Built-ins** newer than 68: `src/polyfills.ts` (core-js: `globalThis`,
  `Array#flat/flatMap/at/findLast`, `Object.fromEntries/hasOwn`, `Promise.allSettled/any`, `String#matchAll/
  replaceAll/at`, `queueMicrotask`). `Array.prototype.sort` is stable only from 70: sort through `stableSort`.
- **Guards** (`npm run lint`, `npm run build`):
  - `eslint-plugin-compat` with `chrome >= 68` flags web APIs and built-ins the TVs lack (polyfilled ones allowed);
  - `scripts/check-legacy.mjs` parses every built script as ES2019 (anything newer was not lowered) and fails on CSS
    Chromium 68 ignores: flexbox `gap`, `aspect-ratio`, `inset`, `clamp()/min()/max()`, `:is/:where`,
    `:focus-visible`. Space flex children with margins.
- **Why one classic script**: module scripts (`type="module"`) are fetched in CORS mode; from a TV app's `file://`
  page that is fragile. `index.html` is rewritten to a `defer` classic script without `crossorigin`.

## 5. Jellyfin access

- **SDK**: `@jellyfin/sdk` 1.0.0 (API 13, minimum server 10.10.0). Every endpoint the app uses was exercised against
  the 10.10.6 dev server: `/Users/AuthenticateByName`, `/QuickConnect/Initiate|Connect`,
  `/Users/AuthenticateWithQuickConnect`, `/UserViews`, `/UserItems/Resume`, `/Shows/NextUp`, `/Items/Latest`,
  `/Items/{id}`, `/Items/{id}/PlaybackInfo`, `/Sessions/Playing*`, images. Requests carry the SDK's
  `Authorization: MediaBrowser Client="Tally TV", Device=…, DeviceId=…, Version=…, Token=…` (Jellyfin 12 rejects
  the old `X-Emby-Token`).
- **Server address**: the shell's (stamped or typed); in a browser the SDK's discovery (`http/https`, `8096/8920`
  candidates, best by `/System/Info/Public`).
- **Sign-in**: Quick Connect first (the 6-digit code, split `831 550`, the kicker lamp sputtering, catching on
  approval and held 600 ms before Home, as on Android), or name + password. Quick Connect off → the password step.
- **Storage**: `localStorage` (a TV app's storage survives restarts; per app origin). `tally.session.v1` = server
  id/name/version/address, user id/name/image tag, token. `tally.deviceId` = a random id per install (Jellyfin binds
  tokens to it). The shell keeps `tally.shell.server`.
- **Tally plugin API**: `src/api/tally.ts` + `tallyModels.ts` (a lenient TypeScript port of `TallyModels.kt`: `heat`
  and `tags` are not modeled; unknown keys ignored; the settings document is read-modify-write whole). 404 on
  `/info` = no plugin: the Tally sections do not appear. One board poll for the app (`state/sportsData.ts`, every
  `pollSeconds`, only while a screen that shows games is open).

## 6. Playback

`src/player/`: `engine.ts` (interface), `avplayEngine.ts`, `webosEngine.ts`, `html5Engine.ts` (browsers and
multiview tiles), `createEngine.ts`, `deviceProfile.ts`, `playback.ts` (PlaybackInfo, stream URL, reporting),
`qualityLadder.ts`, `subtitles.ts`.

| | Tizen: AVPlay | webOS: <video> | Browser: <video> + hls.js |
|---|---|---|---|
| Surface | hardware plane under the page (`<object type="application/avplayer">`, page transparent) | element in the page | element in the page |
| HLS | native | native | hls.js (loaded only here), native where the browser has it |
| Files played directly | MP4, MKV, TS/M2TS, MOV, AVI, WebM, MPEG, FLV, ASF/WMV | per container, LG's tables (below): MP4/MOV, MKV, TS, AVI, MPEG-PS | MP4, WebM (MKV is converted) |
| Video | H.264, HEVC (Main/Main10), VP9, MPEG-2/4, VC-1; AV1 where probed | H.264, HEVC, MPEG-2/4, VP8; VP9 and AV1 on UHD sets | what `MediaSource.isTypeSupported` says |
| Audio | AAC, MP3, AC-3, E-AC-3, FLAC, Opus, Vorbis, PCM; DTS only if probed | AAC, MP3, AC-3, E-AC-3, MP2, PCM, FLAC (2 ch); Opus from webOS 24; DTS only on 23+ and only if probed | AAC, MP3, Opus, FLAC, Vorbis (+AC-3 where probed) |
| Server conversion | HLS TS, HEVC or H.264 + AAC/AC-3/E-AC-3, 6 channels | same (never fMP4) | HLS TS, H.264 + AAC, 2 channels |
| State | **verified on the Tizen 10 emulator** (tvweb-tizen: films direct and converted, tracks, rungs, live, start over; real 2020-2022 firmware not yet) | **verified in Chromium with webOS forced** (tvweb-webos: a film direct from its MKV, audio switched in place, release on hide, screensaver requests); **on LG's webOS 5 emulator** (QEMU): a film direct from its MKV, `audioTracks` switched in place, release on hide and reopen at the place; HLS (live, converted) not there: the emulator plays no MPEG-TS or HLS at all (section 12) | **verified** in Chromium |

- **Device profiles** (`deviceProfile.ts`): tables for what each native pipeline plays from files (web engines
  under-report: `canPlayType` knows nothing of MKV or AC-3 in AVPlay), merged with probes; conservative for 2020 sets.
  Checked on the Tizen 10 emulator with AVPlay (tvweb-tizen): the dev films (MKV, H.264 + AAC, two audio tracks) and
  Big Buck Bunny (MKV, 1080p H.264 + AC-3 5.1) direct play; a rung (720p · 3 Mbps) plays the server's HLS (H.264, AC-3
  5.1 copied). Generated clips: MP4, TS, MKV and WebM containers, HEVC 8 and 10-bit, VP9, MPEG-2, AAC, MP2, AC-3,
  E-AC-3 5.1, FLAC and Opus all play; **AV1 is refused** (prepareAsync InvalidAccessError) although the web engine's
  MSE says yes, so on Tizen AV1 is left to the server whatever the probe says; DTS plays without sound (the probe says
  no, so it is converted). The emulator decodes in software: real sets decide 4K/HDR, the tables stay as they are.
  DTS: Samsung dropped it 2018-2022, LG 2020-2022 (and again in 2025), so only when probed. UHD panels
  (`productinfo.isUdPanelSupported`; on LG the TV's configs) allow 3840x2160 and HDR10/HLG. Anything not listed is
  converted by the server, never refused. Exact per-model tables are refined on real TVs.
- **webOS device profile per generation** (`webosDirect`, `webosCapabilities` in deviceProfile.ts; tvweb-webos,
  September 25, 2026). The version comes from `webOSSystem.deviceInfo.sdkVersion` (the TV counts 7 for webOS 22:
  + 15 from 7 on) or else the web engine (Chromium 68 = webOS 5, 79 = 6, 87 = 22, 94 = 23, 108 = 24, 120 = 25,
  132 = 26); not `platformVersion`, which is the firmware's number (the 6.0 simulator says "02.00.94", LG's webOS 5
  emulator "02.00.30" with no sdkVersion in deviceInfo: there the web engine, Chrome 68, gives 5); UHD, HDR10 and Dolby Vision from `com.webos.service.config/getConfigs`
  (`tv.hw.panelResolution` UD/8K, `tv.model.supportHDR`, `tv.config.supportDolbyHDRContents`, as webOSTV.js 1.2.11
  reads them), else `com.webos.service.tv.systemproperty/getSystemInfo` UHD.

  | | webOS 5 (2020) | 6 (2021) | 22 | 23 | 24 | 25 |
  |---|---|---|---|---|---|---|
  | MP4/M4V/MOV | H.264, HEVC, MPEG-4, AV1 (UHD) + AAC, MP3, AC-3, E-AC-3 | same | same | + DTS if probed | + DTS if probed | + DTS if probed |
  | MKV | H.264, HEVC, MPEG-2, MPEG-4, VP8, VP9 + AV1 (UHD) + AAC, MP3, AC-3, E-AC-3, MP2, PCM, FLAC ≤ 2 ch | same | same | + DTS if probed | + Opus, DTS if probed | + Opus, DTS if probed |
  | TS/M2TS | H.264, HEVC, MPEG-2 + AAC, MP3, AC-3, E-AC-3, MP2, PCM | same | same | + DTS if probed | + DTS if probed | + DTS if probed |
  | AVI / MPEG-PS | H.264, MPEG-4 + MP3, AC-3, MP2, PCM / MPEG-1, MPEG-2 + MP2, MP3 | same | same | same | same | same |
  | WebM | only where the engine says it plays VP9 (LG does not list it) | same | same | same | same | same |
  | Converted | VC-1/WMV, TrueHD, DTS, Vorbis in video, H.264 High 10, everything else | same | same | TrueHD, DTS where not probed | same | same |
  | Levels | H.264 5.1 / HEVC 5.1 on UHD sets, 4.2 / 4.1 on Full HD sets | same | same | same | same | same |
  | HDR | HDR10/HDR10+/HLG and Dolby Vision base layers where the TV reports HDR (UHD otherwise); Dolby Vision itself where it reports it, in MP4/TS | same | same | same | same | + MKV |
  | Server conversion | HLS in MPEG-TS, HEVC or H.264 + AAC/AC-3/E-AC-3, 6 ch (never fMP4) | same | same | same (native HLS downmixes to stereo on 23/24: LG's bug) | same | same |

  Sources: LG's AV format pages per version (webostv.developer.lge.com/develop/specifications/video-audio-50, -60,
  -220, -230, -240, -250: codecs per container, VP9/AV1 in the Ultra HD rows only, Opus in MKV from 24, DTS "on
  specific models" from 23); LG's streaming page (…/specifications/streaming-protocol-drm: HLS v7, "Playback speed
  other than 1.0: Not supported", so speed is offered for files only); LG's web engine page
  (…/specifications/web-api-and-web-engine); jellyfin-web `src/scripts/browserDeviceProfile.js` and `browser.js`
  (GPL-2.0, read at 6d2b5922: no DTS on webOS 5-22, FLAC ≤ 2 channels, H.264 level 5.1, AV1 from webOS 5, TS with
  HEVC, Dolby Vision containers mp4/ts and mkv from 25, the DV fallback range types); reviews for DTS by model year
  (HDTVTest and FlatpanelsHD, March 2025: absent 2020-2022, back 2023-2024, gone 2025); LG forum t/23069 (native HLS
  stereo downmix on 23/24, fixed in webOS 25 firmware). A newer webOS installed on an older set keeps the older
  set's hardware (LG updates 2022+ sets to webOS 25): the DTS and panel rules therefore ask the TV, not the version.
  WebM, TrueHD and HDR appear on none of LG's format pages; those rows are jellyfin-web's or conservative.
- **Subtitles**: text subtitles (SRT, ASS/SSA, embedded or external) are requested as WebVTT
  (`/Videos/{id}/{source}/Subtitles/{index}/0/Stream.vtt`) and **drawn by the app** (`SubtitleLayer`): the same
  look on every engine, and AVPlay has no `<track>`. Picture subtitles (PGS, DVD, DVB) are **burned in** by the
  server (the menu marks them). Verified: Spanish external and English embedded tracks on the dev films.
- **Audio tracks**: a choice restarts the stream at the current position with `AudioStreamIndex` (works on every
  engine; the server remuxes or converts), except on a **direct-played file on webOS**, where `video.audioTracks`
  switches in place (and on webOS 5 a file plays no sound until a track is enabled: LG FAQ
  audio-my-content-not-playing-sound-webos-tv-50, so the first is switched on), and on a **direct-played file on AVPlay**, which plays the file's first
  audio track whatever PlaybackInfo said (measured: Spanish chosen, English heard, the session said DirectPlay): there
  the engine picks the track itself (`nativeAudioFor` maps the stream to AVPlay's track by order, `setSelectTrack`),
  at start (Jellyfin's default or remembered language) and in place when the viewer switches (no restart). Jellyfin 10.10 ignores `AudioStreamIndex`
  unless the request also names the `MediaSourceId` (measured), so restarts always send it. Verified in Chromium: the
  server's new transcoding URL carries the chosen track and playback continues from 11.7 s at 12.4 s.
- **Quality**: the Android ladder exactly (Original, 4K 120/80/60/40, 1080p 30/20/15/10/8, 720p 5/3, 480p 2,
  360p 1 Mbps); a rung sets `MaxStreamingBitrate`, disables direct play/stream and video copy, and adds
  `MaxWidth`/`MaxHeight` (16:9 box) to the transcoding URL, because live channels report ~0 video bitrate and a
  bitrate cap alone left them at full size (measured on Android).
- **Live**: the plugin's continuous playlist (`/JellyTV/Live/{id}.m3u8?s=…`, signed, anonymous), the same address
  multiview uses; the live ladder keeps it going across source switches. hls.js holds ~15 s (5 segments) behind the
  edge like Android's `TallyLivePlayback`; AVPlay gets a 6 s start buffer. On the emulator: channels, CH+/CH-, the
  score bug, box score, switcher and start over play on AVPlay; a server that goes silent for 25 or 55 s stalls the
  picture and AVPlay carries on by itself when it answers again (no error is raised); a live stream that does fail is
  opened again (5 tries, 4 s apart).
- **AVPlay engine rules** (`avplayEngine.ts`, all measured on the emulator): a new stream is close → open →
  setDisplayRect → prepareAsync → seekTo → play; seeks run one at a time (a second seekTo while one runs throws) and
  the latest target wins; a seek past the file's last keyframe fails (`PLAYER_ERROR_SEEK_FAILED`) *and stalls the
  player* until another seek, so seeks stay 3 s off the end and a refused seek is tried 5 s earlier, then where
  playback was; both seek callbacks can fire for one seek (the first counts); a seek that never answers is released
  after 8 s. The Home button pauses the player, and `suspend()`/`restore(url, ms, true)` left it IDLE at 0 (play()
  then throws INVALID_STATE), so a hidden app closes the player and a shown app opens the stream again at its place,
  playing if the viewer was playing (paused stays paused; live goes back to the edge). Fallback (not built): the channel's
  Jellyfin Live TV item through PlaybackInfo when a TV cannot decode the source (e.g. 1080p60 HEVC on an old set).
  Verified in Chromium: playlist requests, playback, score bug, CH+/CH- switching.
- **webOS engine rules** (`webosEngine.ts`, tvweb-webos): a `<video>` on LG's media pipeline, native HLS (never
  hls.js on a TV: jellyfin-web's htmlMediaHelper does the same, "the native players on these devices support seeking
  live streams"), `preload="auto"`; `load()` resolves on the metadata, so the tracks are known before the audio
  choice is applied; a live stream that fails is opened again (5 tries, 4 s apart), a live picture that has not
  moved for 30 s while it should play is opened again at the edge, `online` reopens a failed stream; a hidden app
  releases the decoder (src removed) and a shown one opens the stream again at its place (paused stays paused, live
  goes to the edge), as the AVPlay engine does; seeks stay 3 s off the end of a file; speed only for files (LG's HLS
  plays at 1.0). A desktop browser forced to webOS (the end-to-end tests) has no native HLS: there the engine loads
  hls.js, a TV never does.
- **Live overlays** (`pages/player/LivePage.tsx`, `liveOverlays.tsx`; tvweb-sports), as on the Android TV live player
  (TallyPlaybackPage.kt): the **score bug** (back on open, on every score/period/situation change, while the
  switcher is up and for 8 s after a key or a Magic Remote pointer move, which also brings the bar, then it fades; hidden under the box score; drawn above the bars, as Android
  draws it over its controls; its digits roll), **UP** = the box score (line score, situation, last
  play; closes on the next key or after 12 s), **DOWN** = the "also on now" switcher (other live games on channels
  in board order, or the looping channels when none is live; OK switches in place, HOLD opens the game's actions),
  **event banners** for scoring plays in *other* games (the board poll's `since` events, 8 s, a lower third; never
  while scores are hidden), CH+/CH- step through the channels, WATCH FROM THE START while the game is being recorded: the bar's
  FROM THE START button (Android's StartOverAction at the end of the controls row; it has focus while the bar is up)
  and the REWIND key.
  banner).
- **Reporting**: `/Sessions/Playing` on start, `/Progress` every 10 s, `/Stopped` on leave: resume points and
  Continue Watching stay right (verified in Chromium: start, progress and stopped reports with the real position, all
  answered 204; the dev films are 90 s, under Jellyfin's 5-minute minimum for a resume point).
- **Trickplay** (done, tvweb-player): the item's `Trickplay` info (width, tile size, interval) and
  `/Videos/{id}/Trickplay/{width}/{index}.jpg` tiles, drawn as a background-position crop above the seek bar.
- **Queue**: an episode plays on through its series (upstream's PlaylistCreator); a library's Play all / Shuffle
  passes its list in the route (`player.queue`, at most 100 ids, the grid's order or a random one).
- **Multiview** (`pages/multiview/`, tvweb-sports): the Android page (TallyMultiviewPage.kt) as it is: up to four
  tiles (equal grid / focus layout with the large tile at 68%, the same slot math and D-pad map, unit-tested), the
  swap-in rail, audio follows focus, OK toggles the layout, HOLD opens the tile's actions. Every tile is its own
  `<video>` engine (`createHtml5Engine`: hls.js in browsers, the TV's native HLS in `<video>` on Tizen/webOS), never
  AVPlay: AVPlay is one instance drawn on a full-screen plane, and a tile needs a positioned picture. Decoders are the
  limit, so it degrades instead of disappearing: `multiviewDecoders()` (multiviewLayout.ts) says how many tiles may
  play at once, the audio (focused) tile first (`playingTiles`); the others show the plugin's live **card**
  (`/JellyTV/Card/{id}.png`) until focus reaches them, when the picture moves there (a channel change on the one
  decoder). Tiles stop when the page is covered (full screen from a tile) and restart on return.
  - Browser: **4** (software decoders; verified in Chromium: four tiles playing, one unmuted).
  - TVs, measured on the Tizen 10 emulator: **one video decoder for everything** (AVPlay and `<video>` together).
    A tile's `<video>` plays the channel's HLS natively; a second `<video>` never starts (no error, readyState 0), a
    fourth stole the decoder from the first (`MEDIA_ERR_DECODE`); two `webapis.avplaystore.getPlayer()` players both
    report PLAYING but only the second draws and advances. A new `<video>` started right after another released the
    decoder can wait forever, so tiles on TVs start 500 ms after taking over, and a tile whose picture has not moved
    for 12 s is started again (`useTilePlayer`).
  - Documented for real sets: Samsung's AVPlay guide says AVPlayStore runs **two players at once** and its
    `IN_APP_MULTIVIEW` property exists from Tizen 7.0; Samsung's own Multi View (a TV feature, not for apps) shows two
    videos on 2021+ Q60A and up, four on Q800A/Q900A. No per-model list exists for apps.
  - LG webOS: **one**, on every generation. LG's FAQ (webostv.developer.lge.com/faq/can-i-use-two-video-tags-at-
    the-same-time): "Simultaneous use of two <video> tags, or <video> and <audio> tags is not officially supported on
    webOS TV ... only one media content ... can be played at a time"; LG staff repeat it 2023-2026 (forum t/2947,
    t/10522, t/22722, t/28170), and developers report the first video going black or paused when a second plays.
    So webOS never tries two: one tile plays (the focused, audio one) and the others show live cards, the picture
    moving with focus (`multiviewDecoders('webos')` = 1; verified in Chromium with webOS forced: one `<video>` in the
    page at any time).
  - So `multiviewDecoders()` gives Samsung 2021+ sets (Tizen 6.0+) **two** tiles, others one, and a set that cannot
    (a tile that never moves, or a decode error, while two play) drops to one and remembers it for its model
    (`tally.multiview.decoders.<model>`): once per TV, about 20 s of stalled tiles, then one tile plays and the others
    show live cards, as before. Verified: the emulator falls back and then plays one tile, following focus. Whether
    2021+ sets play two `<video>` at once is for a real set to show; an AVPlayStore tile engine (the video plane
    placed with setDisplayRect) is the next step if they do not.
- **Screensaver / lifecycle on webOS**: LG shows no screensaver while a video plays full screen (developer guide
  "screensaver"), but multiview tiles, a paused picture and overlays are not that, and webOS 6+ has no setting. While
  a player is open the app registers with `luna://com.webos.service.tvpower/power/registerScreenSaverRequest`
  (subscribed) and answers each request (state "Active") with `responseScreenSaverRequest` `ack: false`; outside
  players `ack: true` (undocumented by LG: mariotaku, webosbrew/apps-repo#60; Kodi's OSScreenSaverWebOS.cpp and
  Moonfin do the same). Luna calls go through `PalmServiceBridge` directly (`platform/webos.ts`, as webOSTV.js
  1.2.11 and Enact's LS2Request do; LG's library is not loaded). `webOSRelaunch` (launching Tally while it runs)
  brings it forward with `webOSSystem.activate()` (in the shell, so it works before the bundle loads).
- **Screensaver / lifecycle**: Tizen `appcommon.setScreenSaver(OFF)` while a player is open; a hidden app closes
  AVPlay and reopens the stream on return (above). Verified on the emulator: Home during a film, then Tally again
  from the Apps list (`was_execute`: "resumed", the same page) plays on from where it was. A server that does not
  answer at launch gets the shell's CAN'T CONNECT screen, TRY AGAIN works once it answers.

## 7. Design: tokens, type, components

- **Canvas**: every screen is designed at 1920x1080 CSS px (`#tally-stage`), scaled to the window (`platform/
  stage.ts`); a TV app gets a 1920x1080 viewport, so scale is 1 there. Android sizes convert as **1 Tally dp =
  1.6 px** (Android lays Tally out on a 1200x675 canvas) and **1 rail dp = 2 px** (the rail is unscaled upstream).
  Hairline 2 px and focus frame 4 px, as measured on Android captures at 1080p.
- **Tokens**: `src/styles/tokens.css` (ground, groundRaised, screen, labelBar, rule, ruleStrong, text,
  textSecondary, muted, accent, onAccent, live, liveText, lamp off), margins, card sizes, motion.
- **Type**: IBM Plex Sans / Mono and Font Awesome Solid from `app/src/main/res/font/` (one source of truth; Vite
  copies them). Labels are uppercased in code with `tallyUppercase()` (units keep their case: `14.8 Mbps`, `1080p`,
  `2h 35m`), never with CSS.
- **Focus** = 4 px amber inside the element (pseudo-element border), `groundRaised` fill where the Android component
  has it; nothing moves or scales. Scroll containers pad their content by focus + 1 dp so frames are never clipped.
- **Motion**: color/focus changes instant or ≤120 ms; the lamp (the Android `TallyLampTimeline`, same numbers,
  unit-tested) for launch-like moments: sign-in kicker, tune-in; `prefers-reduced-motion` skips it.
- **Kit** (`src/kit/`, mirrors `tally/media/kit/` and `tally/ui/components/`): `Button` (TallyButton), `Field`,
  `MediaRow` (+ `useRowReveal`), `ScrollPage`, `ItemCard` (PosterCard/LandscapeCard with SEEN / N NEW tags,
  favorite square, progress, kicker), `Bits` (`IndicatorSquare`, `RowHeader`, `LabelBar`, `GlyphIcon`), `Lamp`;
  sports: `GameCard`, `TeamMark`. Next to add (with their screens): DetailHeader, EpisodeRow, PersonCard, Tabs, Chip,
  SearchField, TrackRow, dialogs.

## 8. Navigation, keys, lifecycle

- **Routes** (`router/router.ts`) are data, not URLs: `home`, `search`, `library`, `item`, `player`, `live`,
  `sports`, `settings`, `placeholder`. A stack; pages below the top stay mounted and hidden; the uncovered page gets
  its last focus back. Drawer destinations reset the stack to Home + destination (as Android).
- **Pages** (`app/routes.tsx`) are registered with a chrome: `rail` (beside the navigation rail) or `full`
  (players). Each page is a focus group with boundaries (LEFT from a rail page reaches the rail).
- **Rail / drawer** (`app/Rail.tsx`): collapsed 64 dp rail with the tally light on the current page, opening to the
  224 dp drawer while it has focus (page pushed right under a scrim), order as on Android: Search, Home; Movies and
  TV libraries, Sports; LIBRARIES; Surprise me, Favorites; Settings pinned last. Live TV hidden while Sports exists.
- **Keys** (`platform/keys.ts`, `keyRouter.ts`): one listener maps each platform's codes to app keys (Tizen: BACK
  10009, media and color keys registered through `tizen.tvinputdevice` with the codes the TV reports; webOS: BACK
  461 with `disableBackHistoryAPI`, CH± 33/34; browsers: Escape/Backspace, media keys). Measured on the emulator's
  remote: arrows 37-40, OK 13 and BACK 10009 with key-ups; PLAY/PAUSE 10252, CH+ 427, CH- 428 delivered once
  registered; `getSupportedKeys()` lists the media keys (412-417, 19, 10232/10233), colors 403-406, INFO 457, TOOLS
  10135 (registered as the item menu, like MENU on other remotes; MENU 10133 stays the TV's settings) and EXIT 10182
  (left to the TV, which closes the app). A **held key** arrives as key-up/key-down pairs ~40 ms apart with
  `repeat` false (the first key-up ~660 ms after the press): `isRepeat()` treats a key-down within 100 ms of the same
  key's key-up, or while it is still down, as a repeat (held seeks accelerate, HOLD OK does not fire twice). Order: a text field being
  edited, then `useKeyHandler` handlers newest first (dialogs, players, a page's own BACK), then arrows/OK to the
  focus system and BACK to the router.
- **webOS keys** (LG's Magic Remote guide, webostv.developer.lge.com/develop/guides/magic-remote): arrows 37-40, OK
  13, BACK 461 (appinfo.json `disableBackHistoryAPI`), colors 403-406, PLAY 415, PAUSE 19, STOP 413, REWIND 412,
  FAST FORWARD 417 (the conventional remote; the Magic Remote has none of the media keys), CH+/CH- 33/34 (Enact
  Sandstone's keymap; LG's table says channel keys are not for apps, so they may not arrive on every set), numbers
  48-57, INFO 457 (not in LG's docs; kept, harmless). Escape and Backspace are not BACK on webOS.
- **Magic Remote pointer** (`platform/pointer.ts`, webOS only): LG's guideline and RemoteControl sample: the remote
  is either in pointer mode or in 5-way mode, and apps must support both. Moving the pointer onto something
  focusable focuses it (the amber frame follows the pointer; `focus.tsx` maps each registered element to its focus
  key, groups excluded, so hovering a row's gap does not jump); the frame stays where it is when the pointer leaves.
  A click is OK on what is under the pointer, delivered as the remote's OK key (so dialogs, players and HOLD see the
  same thing); an OK key within 400 ms before the click is the same press (some sets send both) and the click is
  dropped. Focus scrolls rows and pages as on Android TV, which can move the item just focused away from under the
  pointer: a click where it was when it was focused still means it. The wheel steps focus one row up or down per
  notch (at most every 180 ms). `cursorStateChange` (`detail.visibility`) and arrow keys set `html.pointer-mode`.
  Verified in Chromium with webOS forced (hover, click, the double press, wheel, cursor events) and on LG's webOS 5
  emulator with its own pointer (VNC's absolute pointer is the Magic Remote there): `cursorStateChange` from webOS,
  hover focus, the wheel stepping rows, a click opening a card and the player's buttons (the emulator sends the
  click alone, no key 13). Found there and fixed: the player's controls hid under a pointer about to click them,
  and a click on the picture did nothing (moving or clicking the pointer is activity now, `usePointerActivity`:
  the controls come up and stay up); a click on something not yet focused sent OK before Norigin had moved the
  focus (its `setFocus` lands a microtask later), so a click on AUDIO under controls that had just come up paused
  the film (OK goes once the focus is there, `setFocusThen`). On a TV: not yet.
- **BACK**: dialog/overlay → page → previous page → on Home the drawer opens → BACK in the open drawer leaves the app
  (Tizen `application.exit()`; webOS `webOSSystem.platformBack()`, which on webOS 6+ asks "exit?" and on webOS 5
  goes Home, as LG's back-button guide describes; `window.close()` only where it is missing). Samsung's guideline
  (BACK at the top level exits) is met; LG's QA checklist asks for Home on BACK at the entry page on webOS 23-25,
  which platformBack gives.
- **Text fields** do not take DOM focus while the D-pad passes (the TV keyboard would pop up): OK starts editing,
  OK/Done submits, UP/DOWN leave, BACK stops editing. Tizen IME Done/Cancel (65376/65385) handled in the shell.
- **Lifecycle**: `visibilitychange` (both platforms): AVPlay and the webOS engine release the decoder and reopen;
  the board poll stops with its screens. webOS relaunch (`webOSRelaunch`): the shell calls
  `webOSSystem.activate()`. Tizen deep links: later (Play-on-TV arrives through Jellyfin's websocket instead, see
  parity).
- **HOLD OK** (the Android TV long press: a game's actions, a channel into multiview, a card's item menu on Home and
  in the libraries; `pages/sports/useOkHold.ts`):
  on screens that have holds, OK is delivered on key-up; held for 500 ms it is a hold. The remote's auto-repeat while
  the key is down is swallowed (a key-down within 700 ms of the last counts as a repeat: Tizen does not flag repeats
  reliably), and after a hold fired every OK event is swallowed until OK has been quiet for 300 ms (the emulator's
  up/down repeat pairs otherwise read as new presses and picked the first row of the menu the hold had opened);
  menus also ignore OK for their first 400 ms, as on Android. MENU/INFO/TOOLS open the same actions. Verified on the
  emulator: OK's key-up arrives, a short OK acts at once, a 1.2 s hold opens the game menu and nothing else.

## 9. Code layout and parallel work

```
tv-web/
  shell/              the installed shell (ES5, never transpiled) + tizen/config.xml, webos/appinfo.json, icons
  src/main.tsx        boot: polyfills, shell, platform, SDK, focus, keys, stage, <App/>
  src/shell-contract/ the shell ↔ bundle contract
  src/platform/       keys, key router, platform adapters, Tizen API types, the stage
  src/focus/          Norigin binding
  src/router/         route stack
  src/app/            App frame, rail/drawer, page registry, arrival focus
  src/api/            Jellyfin session (SDK), images, Tally plugin client and models
  src/state/          app-wide stores (libraries, plugin availability, board poll)
  src/kit/            shared components and their CSS
  src/sports/         game card, team mark, home row selection
  src/player/         engines, device profile, PlaybackInfo, subtitles, quality
  src/pages/<screen>/ one folder per screen (page component + its CSS + its data module)
  tests/              Vitest (pure logic, real captured fixtures)
  e2e/                Playwright flows against a real server
  scripts/            legacy check, packaging, certificates, installer, icons
```

How several workers build screens at once:
- **One worker, one `pages/<screen>/` folder** (page, CSS, data module). Registering the page is a one-line change
  in `app/routes.tsx` (+ its `Route` variant in `router/router.ts`), replacing a `PlaceholderPage`.
- **Kit changes are additive** (new components, new optional props with defaults); a worker who needs a kit change
  that alters existing behavior asks for it.
- **API access in modules**, not in components: a screen's `…Data.ts` calls the SDK / `api/tally.ts`; models are
  never invented (use the SDK's types, `tallyModels.ts`, and fixtures captured from the dev server).
- **Every screen**: `PageProps`, `useArrivalFocus` for its first focus, `useBack`/`useKeyHandler` for its own keys,
  focus keys prefixed by the screen name, labels through `tallyUppercase`, no CSS the legacy check rejects.
- **Definition of done** per screen: `npm run lint && npm test && npm run build` clean, an e2e flow with screenshots
  opened and judged at 1920x1080, compared with the Android screen's captures.

## 10. Samsung 1 (the first release for Samsung TVs)

Scope, in this order; everything else follows through server updates (no reinstall):

1. **Sign-in**: server address (stamped by the installer, or typed) and Quick Connect; password as the fallback.
   *Done in tvweb-0* (Quick Connect with the lamp, password with errors; verified in Chromium).
2. **Home**: games row (live / today) and the library rows (Continue Watching, Next Up, Recently added per library),
   the header describing the focused card, the backdrop. *Done* (the games row is the Sports card with its game menu
   on HOLD OK; the item menu on HOLD OK / MENU on any card; PLAY plays the focused item. Watch-live channels row,
   household and watch-party
   rows: later).
3. **Libraries**: grid with tabs (Recommended, Library, Collections, Genres), sort/filter, the alphabet jump.
   *Done in tvweb-library* (`pages/library/`: Movies, TV, music and other libraries, genre/studio pages, folders,
   Recommended rows with Suggestions and VIEW ALL, the sort/filter/view dialogs, a windowed grid paged from the
   server; verified in Chromium against the dev server).
4. **Film, series (season tabs + episode list), season, episode pages**: DetailHeader, action row (Resume/Play, From
   the start, Watched, Favorite, More), cast row, extras. *Done in tvweb-details* (`pages/details/`, `pages/person/`):
   the `item` route opens films/videos, series, episodes and people by type, `season` is the rundown (season tabs,
   numbered episodes with NEXT UP / progress / WATCHED, guest stars, season extras); rows: cast & crew (person page),
   chapters, extras, the collection's next film (TMDb collection order, as Android's CollectionNext), more like this,
   more from the season. Item menu (MORE, or MENU / INFO on a card), trailer list, full overview, series-watched
   confirmation and Add to playlist are Tally panels (`kit/Panel`). New kit: DetailHeader, EpisodeRow, FrameCard /
   PersonCard, Panel. Home and library cards open these pages (`pages/details/navigate.ts`, Android's
   `destination()`; a box set opens the collection page, a playlist the playlist page: `pages/collection/`,
   `pages/playlist/`, tvweb-gaps).
5. **Player**: Tally controls (seek bar with trickplay, transport, chapters, next up, skip intro), subtitles, audio,
   quality. *Done in tvweb-player* (`pages/player/`, `pages/postplay/`): the Android TV controls, chapters and queue
   rows, the settings panel (audio, subtitles, speed, scale, subtitle delay, quality, sleep timer), media segments,
   next up with its countdown, the post-play page.
6. **Sports**: Games board (focused game panel + rows per league/state), Channels grid, and the **live player** with
   the score bug, event banners and the game switcher. *Done in tvweb-sports*: the Sports section (GAMES, CHANNELS,
   MULTIVIEW, RECORDINGS when the server records, SETTINGS), the game actions menu (watch, multiview, follow, hide
   scores, record, record every game of a team), multiview, the Recordings tab and watch-from-the-start, the live
   overlays (verified in Chromium against the dev server with the score simulator).
7. **Tizen verification**: AVPlay engine, remote keys, screensaver, suspend/resume, device profile. *Done on the
   Tizen 10 emulator in tvweb-tizen* (sections 6, 8, 12); a real 2020-2022 set is still to confirm the same (the
   emulator is the only Tizen here).

Proposed parallel tasks after tvweb-0: `tvweb-details` (4), `tvweb-library` (3), `tvweb-player` (5),
`tvweb-sports` (6), `tvweb-tizen` (7, needs a TV or the emulator with a Samsung certificate), `tvweb-installer`
(section 11).

## 11. Packaging and install

### Samsung (Tizen)
- **Package**: `scripts/package-tizen.sh [--server URL] [--profile NAME]` → `dist/Tally.wgt` (≈75 KB). `config.xml`:
  package `TallyTVapp`, app `TallyTVapp.Tally`, `required_version` 5.5, profile `tv-samsung`, privileges `internet`,
  `tv.inputdevice`, `productinfo` (all public level), `<access origin="*" subdomains="true"/>`, `hwkey-event=
  "enable"`. **No** `<tizen:content-security-policy>` or `<tizen:allow-navigation>`: either one turns on the runtime's
  CSP mode, whose default (`script-src 'self'`) blocks the server's bundle. AVPlay needs no privilege (since 2015)
  but needs `$WEBAPIS/webapis/webapis.js` in the page (the package script adds it). Icon: `shell/icons/icon-512.png`
  drawn from the Android launcher art (`scripts/make-icons.py`).
- **Certificates** (research of September 24, 2026; sources in the tvweb-0 report):

  | TV | Tizen | Signing that installs in Developer Mode |
  |---|---|---|
  | 2020 | 5.5 | Tizen author certificate + Tizen's default distributor (no Samsung account) |
  | 2021 | 6.0 | same |
  | 2022 | 6.5 | same |
  | 2023 (original firmware) | 7.0 | unclear: treat as Samsung certificate needed |
  | 2023 upgraded, 2024, 2025 | 8.0, 9.0 | **Samsung certificate**: Samsung account, distributor certificate listing the TV's DUID (valid ~1 year) |

  The Tizen author certificate chains to "Tizen Developers CA", which **expires 2027-01-01**. What that means,
  from Tizen's open validator (platform/core/security/cert-svc, identical on the tizen_5.5 and tizen_6.5 branches;
  Samsung's TV firmware is closed, so this is the reference behavior, not a measurement on a TV):
  `BaseValidator::preStep()` checks only the *signing* certificate's dates against the clock; when it is outside
  them (expired or not yet valid) and its root is not in the strict test stores, the whole chain is checked at the
  **middle of the signing certificate's validity** instead (xmlsec `certsVerificationTime`). That is why TVs still
  take Tizen's public distributor signer, which expired in 2012. Consequences: an author certificate that **ends
  when the CA ends** (as Tizen Studio makes them: notAfter hard-coded to 2027-01-01) keeps installing after 2027 (it
  is then expired, the chain is checked at its midpoint, where the CA was valid); one that ends later would fail
  from 2027 on (still in its dates, so the chain is checked now, against an expired CA). Tizen Studio itself
  cannot make new author certificates after 2027 (it checks their validity); Tally for Samsung makes them for the
  CA's last year then. Updates compare only the author's **public key** (app-installers `IsSameAuthor`), so the key
  must be kept, a re-issued certificate for the same key updates fine. The emulator cannot confirm any of this: it
  refuses the Tizen chain outright (section 12). `scripts/tizen-certificate.sh` creates the development author
  certificate in `~/.tally/tizen` (with its password) and the `tally` security profile; Tally for Samsung keeps its
  own per computer (below).
- **Developer Mode** (the owner or friend does this on the TV once): Apps panel → App Settings (or the Apps screen) →
  type **12345** → Developer mode **On** → Host PC IP = the installing PC → restart the TV fully (hold power; unplug
  with Instant On). It stays on; major firmware upgrades have reset it (and removed sideloaded apps).
- **Development installer** (`scripts/install-tizen.sh <tv-ip> --server <jellyfin>`, needs Tizen Studio):
  `sdb connect`, reads the Tizen version and DUID, picks the signing (the `tally` profile on Tizen < 7, else asks
  for a Samsung profile), packages with the server stamped in, `tizen install`, `tizen run`.
- **Tally for Samsung** (`installer/`, for everyone else; the steps for people are in
  [INSTALL-SAMSUNG.md](INSTALL-SAMSUNG.md)): one self-contained program per desktop OS, published by
  `tally/release.sh` as `Tally-Samsung-Installer-windows.exe`, `-linux`, `-macos-arm64`, `-macos-x64`
  (`installer/build.sh`). No Tizen Studio, Java, Docker or Samsung binaries.
  - **Stack**: .NET 10, self-contained single file, trimmed (12-15 MB), a console flow (four numbered steps, plain
    sentences, every error says what to do). The server setup is already C#/.NET and cross-built from Linux the same
    way; a console instead of a window keeps one UI for Windows, macOS and Linux in this pass (WinForms is Windows
    only; a window can sit on the same `InstallerFlow` later).
  - **Find the TV**: shows this PC's address (what Developer Mode's Host PC IP must be), then asks every address of
    the PC's home networks (/24) at once for Samsung's TV information (`http://<ip>:8001/api/v2/`: name, model code
    with the year, and on TVs that report them `developerMode`/`developerIP`) and whether the sdb port 26101 takes a
    connection; or the IP is typed. Connection failures are explained with that information ("Developer Mode is on,
    but for another computer (192.168.1.33; this PC is 192.168.1.20)") and the Developer Mode steps.
  - **sdb, reimplemented** (`Sdb/`): the device protocol straight to the TV's sdbd, no sdb server: CNXN (the same
    version, payload size and banner Tizen Studio's sdb 4.2 sends), OPEN/OKAY/WRTE/CLSE streams with flow control,
    `capability:` (2-byte length + key:value lines), `shell:0 getduid` (or `0 getduidgadget` / `duid-gadget` on older
    sdbd, as Samsung's tools choose), `sync:` push (SEND `path,33261`, DATA ≤ 64 KiB, DONE, OKAY/FAIL, QUIT),
    `shell:0 vd_appinstall TallyTVapp.Tally <sdk_toolpath>/tmp/Tally.wgt` (its progress lines are shown and parsed:
    completed, or `install failed[118, -12], reason: …` sorted into certificate not trusted / author mismatch /
    another TV's DUID / not yet valid / expired / Tizen too old), `shell:0 was_execute TallyTVapp.Tally`,
    `shell:0 vd_appuninstall` (only after asking, on "author certificate not match"). Recorded against the emulator
    through a logging proxy between Tizen Studio's sdb and sdbd (`installer/tests/fixtures/sdb-trace-emulator.txt`);
    the TV's sdbd accepts only these fixed "0 …" commands. Samsung's sdb binaries are not redistributable (Tizen SDK
    license, §3.1); the sdb 3.x source is Apache-2.0 but was not needed.
  - **Signing, reimplemented** (`Signing/WidgetSigner.cs`): author-signature.xml and signature1.xml exactly as
    `tizen package` writes them: Exclusive C14N over SignedInfo, RSA-SHA512, SHA-512 digests, references sorted
    ordinally with Tizen Studio's URI escaping, the `#prop` object (C14N 1.1) with profile/role/identifier, KeyInfo =
    signer + CA, base64 at 76 columns. Byte-for-byte equal to three golden packages from `tizen package`
    (`installer/tests/fixtures/golden/`: the shell, odd file names, every punctuation character).
  - **Certificates** (kept in the app-data folder, `%APPDATA%\Tally\Samsung` / `~/.config/Tally/Samsung`, reused for
    every update; losing them means uninstalling Tally from the TV before the next install):
    - Tizen's public signing material (the Tizen Developers CA with its key, the public distributor) is **not in the
      program**: it is downloaded on first use from download.tizen.org (Tizen Studio's
      `certificate-generator_0.1.4_ubuntu-64.zip`, the same files in the Windows and macOS packages), checked against a
      pinned SHA-256 (`TizenSdkDownload`), and kept in the app-data folder; offline, the program says so and what to
      do. Only the Samsung (2023+) path works without it.
    - Tizen 5.5-6.5 (2020-2022): an author certificate made on first use exactly as Tizen Studio's generator makes one
      (issued by the Tizen Developers CA with its public key from Tizen's Apache-2.0 certificate-generator: SHA-512,
      CA:FALSE critical, digitalSignature, codeSigning, notAfter = the CA's end; differences: 2048-bit key, random
      serial, start one day back) + Tizen's public distributor ("Tizen Public Distributor Signer", Tizen Studio's
      default, which its own wizard says is for Tizen ≤ 7; the 2022 "Tizen Studio Public Signer" is for 8+ and not in
      the Apache sources).
    - Tizen 7+ (2023 on): the Samsung certificate flow of Tizen Studio's Samsung Certificate Extension 2.0.75, as
      Apps2Samsung (MIT) and Samsung's tizen-agent-skills (Apache-2.0, read as a specification) implement it: the
      browser opens `account.samsung.com/accounts/…/signInGate?clientId=v285zxnl3h&tokenType=TOKEN&redirect_uri=
      http://localhost:4794/signin/callback` (the only registered redirect, so port 4794 is fixed; the program listens
      on IPv4 and IPv6 loopback), Samsung's page POSTs `code` = JSON (access_token, userId, inputEmailID); then
      multipart POSTs to `https://svdca.samsungqbe.com/apis/v3/authors` (access_token, user_id, platform=VD,
      csr=author.csr) and `apis/v1/distributors` + `apis/v3/distributors` (… privilege_level=Public,
      developer_type=Individual, csr=distributor.csr with subjectAltName `URN:tizen:packageid=` +
      `URN:tizen:deviceid=<DUID>` per TV). Answers are PEM; the chain is completed with Samsung's CA certificates
      (bundled, issuer matched by signature). The author key is kept across renewals; the distributor certificate
      lists every TV this PC has installed on. **Untested against Samsung** (no account): unit-tested against the
      published request/response formats only.
    - A Tally.wgt someone else signed for this TV (`--wgt`, dragging it onto the program, or choice 2 when the TV
      needs a Samsung certificate): checked before copying (Tally's app id, signed, its distributor certificate lists
      this TV's DUID). The owner makes one for another person's TV with `--make-wgt <DUID> --server <address>`.
  - **Server**: the typed address is tried as the shell would use it (https first, then http with :8096), must
    answer `/System/Info/Public` as Jellyfin, and `/JellyTV/TV/manifest.json` tells whether the plugin carries the TV
    app (a warning if not). It is stamped into `config.js` of the package made on the user's PC; the program and the
    release contain no server address.
  - Every run writes `Tally-Samsung-Installer.log` in the temp folder.
- **LG**: *Tally for LG*, built from the same source tree (below).
- **Store**: Samsung Seller Office distribution is possible later; its review of an app that loads its code from a
  server is an open question (Samsung's hosted-app rules allow external scripts with registration).

### LG (webOS)
- **Package**: an `.ipk` of the shell (`shell/` + `shell/webos/appinfo.json`: id `io.github.scdouglas1999.tally`,
  `disableBackHistoryAPI: true` (BACK arrives as key 461), resolution 1920x1080, icons 80/130 px, `bgColor`, no
  webOSTV.js). `scripts/package-webos.sh [--server URL]` makes one with LG's `ares-package` (`@webos-tools/cli`
  3.2.6 in `~/tools/webos-cli`, development only); Tally for LG writes its own (below).
- **Developer Mode** (the person does this on the TV once): a free LG developer account; LG's **Developer Mode** app
  from the LG Content Store; sign in; Dev Mode Status on (the TV restarts); Key Server on. The app shows the TV's IP,
  a 6-character passphrase and the session's time left.
- **The session**: apps installed this way stay while Developer Mode's session lasts; when it runs out LG turns
  Developer Mode off at the next restart and removes them, and an expired session cannot be extended (LG,
  develop/getting-started/developer-mode-app). The app's EXTEND button resets it. Community tools do the same from
  outside with the TV's session token, `/var/luna/preferences/devmode_enabled` (letters and digits), readable as the
  `prisoner` user: `GET https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=<token>` →
  `{"result":"success","errorCode":"200","errorMsg":"GNL"}`, and `CheckDevModeSession.dev` for the time left
  (`errorMsg` "H:MM:SS"); failure `{"result":"fail","errorCode":"ERR_005","errorMsg":"Check user session"}` (webosbrew
  dev-manager-desktop `src-tauri/src/plugins/devmode.rs` and `renew-script.sh.ts`, webosbrew dev-utils
  `scripts/devmode-reset.sh`, gabe565/webos-dev-mode's client and fixtures). Older Developer Mode apps gave 50 hours,
  current ones show up to 1000; Tally renews daily either way. **Tally keeps it on**: Tally for LG reads the token
  and stamps it into the shell's `config.js` (`devModeToken`, exposed as `TallyShell.devModeToken`); once someone is
  signed in, the app sends it to the plugin (`POST /JellyTV/Client/v1/lg/devmode`, `platform/lgDevMode.ts`, on every
  start with a session), and the plugin's `LgDevModeService` resets the session every day, logs the result, shows
  "LG Developer Mode kept on for 1 TV · renewed <time>" on its settings page, retries a failure after an hour and
  forgets a TV failing for 14 days (server/README.md).
- **Tally for LG** (`installer/lg/`, for everyone; the steps for people are in [INSTALL-LG.md](INSTALL-LG.md)): one
  self-contained program per desktop OS, `Tally-LG-Installer-windows.exe`, `-linux`, `-macos-arm64`, `-macos-x64`
  (`installer/build.sh lg`, released next to the Samsung ones). It shares `installer/common/` with Tally for Samsung:
  the console (`Ui`), the Jellyfin server step (`ServerStep`, `JellyfinServer`), the home-network scan
  (`NetworkScan`), `config.js` (`ShellConfig`), the sign-in hand-off text (`Handoff`) and the program frame
  (`ConsoleHost`: log file, Ctrl+C, "Press Enter to close"); the Samsung program's behavior and its 82 tests are
  unchanged. No LG tools, Node.js or Java.
  - **Find the TV**: every address of this PC's /24 is asked whether Developer Mode's SSH (9922), Key Server (9991)
    and webOS's second-screen port (3000) take a connection; names from SSDP
    (`urn:lge-com:service:webos-second-screen:1`) where the TV answers. Statuses: ready / Key Server off / Developer
    Mode off; or the IP is typed (the Developer Mode app shows it).
  - **Key**: `GET http://<tv>:9991/webos_rsa` (as LG's CLI `lib/base/novacom.js`), an OpenSSL traditional encrypted
    PEM (`Proc-Type: 4,ENCRYPTED`, `DEK-Info: AES-128-CBC`; the TV makes it with `ssh-keygen -t rsa -N <passphrase>`),
    unlocked with the passphrase the person types (6 characters, upper-cased as the app shows them): EVP_BytesToKey
    (MD5) + AES/3DES-CBC, checked by parsing the PKCS#1 key, so a wrong passphrase is said as such before any SSH
    (`Webos/DevModeKey.cs`). An OpenSSH-format key is handed to SSH.NET with the passphrase. The key and passphrase
    are kept per TV in `%APPDATA%\Tally\LG` / `~/.config/Tally/LG` (user-only), so an update needs neither the Key
    Server nor the passphrase; a refused kept key (Developer Mode set up anew) fetches the new one.
  - **SSH/SFTP**: SSH.NET 2026.0.0 (MIT, pinned), port 9922, user `prisoner`; the TV's host key is legacy `ssh-rsa`
    (SHA-1) and changes with every Developer Mode setup, so it is accepted and logged as LG's CLI does.
  - **Install**, as ares-install does it (lib/install.js, files/conf/command-service.json): `test -d
    /media/developer/temp || mkdir -p`, SFTP the ipk there (a shell `cat >` when SFTP is missing, as novacom.js
    falls back), compare the MD5 of its last 200 bytes on both sides, `/usr/bin/luna-send-pub -i
    luna://com.webos.appInstallService/dev/install '{"id":…,"ipkUrl":…,"subscribe":true}'` followed until
    `details.state` is "installed" or "…failed" (reason shown in plain words: space, busy, package), `rm -f` the
    ipk; `luna://com.webos.applicationManager/dev/closeByAppId` first (an update under a running app) and
    `…/launch` after. TV information: `luna://com.webos.service.tv.systemproperty/getSystemInfo` (model, SDK version:
    5.x, 6.x, then 7.x = webOS 22 …); webOS below 5 is refused. The session token is read over SFTP
    (`cat` fallback) and stamped into the package.
  - **The ipk** (`Ipk/IpkWriter.cs`), as ares-package 3.2.6 writes it (lib/package.js): an `ar` archive
    (`!<arch>`, `debian-binary` "2.0\n", `control.tar.gz`, `data.tar.gz`; 60-byte headers with uid/gid 0, mode 100644,
    odd members padded), `control` with ares's fields (Installed-Size in bytes), `data.tar.gz` with
    `usr/palm/applications/<id>/…` and `usr/palm/packages/<id>/packageinfo.json`, ustar headers as node-tar writes
    them (octal fields "000644 \0", directories 0777 before their files, atime/ctime in the prefix area), gzip with
    node's header (mtime 0, OS 3). Compared with a package ares-package made of the same shell
    (`installer/lg/tests/fixtures/golden/`): identical members, header layouts, entry names, types, modes, sizes and
    bytes; only times, the packer's user name and the deflate stream differ. No signing (Developer Mode installs
    unsigned packages).
  - Every run writes `Tally-LG-Installer.log` in the temp folder; `--package` writes only the ipk; for LG's
    emulator: `--tv 127.0.0.1 --ssh-port 6622 --user developer --key <webos_emul>`. Run that way against LG's webOS
    5 emulator (section 12): the TV information (webOS 5, WEBOS5.0), no session token (said so), the server check,
    the copy, LG's own `appInstallService` installing the ipk this program wrote, `launch`; a second run (the
    update) closed the running Tally, installed over it and launched it again, still signed in.
- **Store**: LG Seller Lounge / Content Store review; same open question about server-loaded code.

## 12. Testing

- **Unit** (`npm test`, Vitest): lamp timeline (Android numbers), quality ladder, key maps, formats, home-row
  selection on real boards (the Android fixture and one captured from the dev server), device profiles, subtitles,
  scroll math, drawer order, and the AVPlay engine against a recording fake of `webapis.avplay` (call order,
  suspend/restore, tracks), and for Sports: the board rows (the Android BoardOrganizer cases), line score labels and
  column fitting, the score roll's offsets and restarts, the followed-team countdown, DVR models and words (the
  Android DvrModelsTest payload), multiview slots, D-pad map and decoder allotment; the player's formats, the Home
  header's meta line; the collection and playlist pages' meta lines and Jellyfin 10.10's playlist move (every
  from/to pair measured on the dev server, and the plan that corrects it), the item menu's Remove from continue
  watching, the plugin art parameters and the recordings' library state; webOS: the version from deviceInfo and the
  web engine, Luna calls through a fake PalmServiceBridge, the panel configs, the screensaver requests, the
  Developer Mode hand-off, the per-generation device profiles, and the webOS engine against a fake `<video>`
  (native HLS, resume point, audio tracks and webOS 5's first track, release on hide, live retries, speed for files
  only). 177 tests.
- **Lint** (`npm run lint`): ESLint (typescript-eslint + compat for Chromium 68), `tsc --noEmit` strict, CSS legacy
  check. **Build** adds the ES2019 parse of the bundle.
- **End-to-end** (`npm run e2e`, Playwright 1.63, Chromium at 1920x1080, the production bundle through
  `vite preview` on `TALLY_PREVIEW_PORT`, never a preview already running there, the dev server at
  `127.0.0.1:18200`; the board's games change through the day, so the Sports flows find the games they need on it): Quick Connect sign-in (approved with the admin token),
  password error, Home (games row, library rows, header, drawer open/close; the game menu and the item menu on HOLD OK
  / MENU, PLAY on a card), library cards (item menu, a box set's items, an episode to its rundown, Play all's queue),
  film playback with a subtitle and an
  audio switch, live channel from the continuous playlist with the score bug; Sports (`e2e/sports.spec.ts`): the
  board and its tabs, HOLD menus, channels, the multiview queue, settings, recordings, four-tile multiview, the live
  overlays, a team recording rule end to end, the start-over page; the 2.2 gaps (`e2e/gaps.spec.ts`): the collection
  page (rows, item menu, sort, the mixed grid), the playlist page (move down and back up, Remove from playlist, PLAY
  from a row), Remove from continue watching, the league in Home's game header, the score bug's show/fade rule (a key, a
  simulated score change) and FROM THE START, the recording notice and the plugin art parameters. Live states come from the score simulator
  (`tally/dev/score-sim.py`, run with `TALLY_SIM=1`; its parts are skipped without it). Screenshots in
  `test-results/shots/`.
- **Tizen emulator**: Tizen Studio 6.1 CLI + TV Extension 10.0 in `~/tools/tizen-studio` (installed without root on
  this Arch host: a `dpkg` shim answers the package manager's Ubuntu prerequisite check; all emulator libraries
  resolve). Only the **Tizen 10.0 (2026) TV image** is published now (Chromium M130), not 5.5/6.x: it verifies the
  shell, AVPlay and keys, not the Chromium 68 floor (that is what the legacy checks are for). VM `tally-tv`
  (1080p, 1 GB) boots headless on Xvfb (`scripts/tizen-emulator.sh`; GL must stay on, the TV image's tuner device
  needs it) to Smart Hub, reports `platform_version:10.0` over sdb, and **refuses Tally signed with the plain Tizen
  certificate**: `install failed[118, -12], reason: Check certificate error : :Invalid certificate chain with
  certificate in signature.` (the same error Tizen 8+ TVs give). Since TV Extension 7.0.1 the emulator installs only
  Samsung-certificate-signed apps, so running Tally in it (and verifying AVPlay and `webapis` from the server-loaded
  script) needs the owner's Samsung account (open question). Run only with ≥ 7 GB free on this host. It also
  refuses the same package with Tizen Studio's 2022 public distributor ("Tizen Studio Public Signer") and with its
  partner and platform distributors (tried September 24, 2026): only a Samsung chain installs. The emulator reaches
  the host at `10.0.2.2` (QEMU user networking) and the host's LAN address; its sdbd is `127.0.0.1:26101` and takes
  one client at a time (stop Tizen Studio's `sdb` server before another client connects).
  **A 2020-2022 TV, simulated** (tvweb-installer, September 24, 2026): the refusal is the TV image's trust list,
  `/usr/share/ca-certificates/fingerprint/fingerprint_list.xml`, whose `tizen-public` distributor domain lists only
  Samsung's roots, not Tizen's "Tizen Public Distributor Root CA" (the Tizen Developers roots for authors are
  there). On a *copy* of the image (`qemu-img` from Tizen Studio to raw, `debugfs` to add that root's SHA-1
  `04:C5:A6:1D:…:44:AE` to `tizen-public`; the shared `tally-tv` VM untouched), Tally for Samsung's Linux build
  installed Tally signed on this PC ("install completed"), started it, and the shell loaded the bundle and showed
  Quick Connect against the dev server; the update path (same author) and another computer's author ("Author
  certificate not match", uninstall, install) behaved as on a TV. So the signatures, the author chain, the
  install and launch commands and the server-loaded bundle all work on a real Tizen web runtime (10.0); what
  2020-2022 firmware trusts is taken from Tizen's upstream list, not measured.
  **Running Tally in it** (tvweb-tizen, September 24, 2026): the copy (`workbench/.tvweb-installer-emu`) starts with
  `emulator.sh --conf vms/tally-tv-installer/vm_launch.conf` on its own Xvfb (2300x1200; the window's right-click
  menu Scale 1x makes the TV picture 1920x1080 at +92+92 for `import -crop`). Tally is installed with Tally for
  Samsung (`--tv 127.0.0.1 --tizen`, `--bundle http://<this PC>:<port>/` to load a development bundle). The web
  inspector: `sdb shell 0 debug TallyTVapp.Tally` (with the app closed first: `0 was_kill`) prints a port,
  `sdb forward tcp:9333 tcp:<port>` exposes Chrome DevTools Protocol (Chrome 130) for reading state and
  `TallyDebug.push/focus`; keys go through the emulator window (`xdotool key`: arrows, Return, Escape = BACK 10009)
  and its remote skin (PLAY/PAUSE, CH±, Home). Screenshots from X show the video plane with the page over it.
- **Performance** (tvweb-tizen, `e2e/perf.spec.ts` with `TALLY_PERF=1`; Chromium at 1920x1080 with the CPU slowed 4x,
  standing in for a 2020 TV SoC, and the Tizen emulator for the runtime):
  - start: launch to Home ready for the remote (first focus) 0.3-0.5 s in Chromium 4x (the bundle from the server),
    0.8-1.7 s on the emulator (`performance.mark('tally-first-focus')`, read over the inspector);
  - remote keys (Event Timing, key-down to the next paint, a press every 150 ms then held): Home p95 40 ms (was 72),
    library grid 32 ms, film page 40 ms, Sports board 40 ms (was 144); no frame over 50 ms (the library had one of
    350 ms). The fixes: backdrops that wait for focus to rest, pictures at their drawn size, logos from ESPN's
    combiner (section 3);
  - pictures: every picture on those screens within 1.5x of its drawn size, except Jellyfin's chapter images (it
    returns 640x360 for 371x209; small);
  - an hour on the emulator (browsing Home, a library, a film page, 20 s of AVPlay playback and the Sports board,
    over and over; heap and DOM after a forced collection each cycle): before the fix below the page kept 6 DOM
    nodes per film played (AVPlay kept every listener's closures), ~420 nodes and +1.7 MB of heap in the hour;
    after it, 92 cycles in 60 minutes: DOM flat (442-447 nodes, 402 once the games row shrank), heap 5.1 MB at
    cycle 10 (caches filled), 5.8 MB at the end (+0.7 MB in 50 minutes, flattening). Chromium, 20 cycles: heap 4.8 → 6.0 MB in the first 10 cycles (caches filling), then flat.
- **Tally for Samsung** (`installer/`, `dotnet test installer/tests`, xUnit): the signer against three golden
  packages from `tizen package` (byte for byte), the author certificate against Tizen Studio's (fields, the 2027
  rule), the sdb client against a fake sdbd that answers as the emulator's did (handshake, capability, DUID, push
  across payload and sync-chunk boundaries, install/launch/uninstall, hang-up, silence, nothing listening) and the
  install answers (the emulator's real ones and the documented others), the TV scan (Samsung's `/api/v2/` answer, a
  fake TV among silent addresses), the server check, the Samsung sign-in callback (served over HTTP) and certificate
  requests (field names, CSR subjectAltName, error answers, CA matching) against a fake service, and the whole flow
  (a 2021 TV, the update path with the same author, replacing a Tally from another computer, a TV that refuses this
  PC, a 2024 TV with a file for another TV, a file for this TV, no TV app on the server).
- **webOS in Chromium** (`e2e/webos.spec.ts`, tvweb-webos): the production bundle with the webOS platform forced
  before any script runs: `webOSSystem` (deviceInfo of a 2020 OLED, `activate`, `platformBack`) and a
  `PalmServiceBridge` that answers the panel configs and the screensaver requests and records every Luna call; LG's
  key codes dispatched as the TV sends them; the mouse as the Magic Remote; `--enable-blink-features=
  AudioVideoTracks` for LG's `audioTracks`. Five flows: the platform, BACK 461 (and Escape not being BACK), the
  drawer and platformBack, the device profile sent to the server (UHD webOS 5: AV1 in MKV, no DTS) and the
  Developer Mode hand-off (token, model, the session's authorization); a film played straight from its MKV on the
  webOS engine, Spanish audio switched in the element (no new PlaybackInfo, the same file), hide/show releasing and
  reopening at the position with the track kept, PAUSE/PLAY keys, the screensaver requests answered ack false then
  true; the pointer (hover focus, `cursorStateChange`, arrows ending pointer mode, the wheel stepping rows, a click
  opening a card, OK key + click counted once); multiview with one `<video>` at a time and live cards; the
  installed shell (tv-web/shell with the config.js Tally for LG stamps) loading the bundle, `webOSRelaunch` →
  `activate`, BACK → platformBack.
- **Tally for LG** (`dotnet test installer/lg/tests`, xUnit, 41 tests): the ipk writer against ares-package's own
  package of the shell (members, headers, entries, modes, bytes; valid ustar checksums; gzip header; CRC-32), key
  unlocking (keys made as the TV makes them: `ssh-keygen -m PEM` AES-128-CBC, 3DES, OpenSSH format; wrong
  passphrases; EVP_BytesToKey against OpenSSL's values), the key server fetch, the luna commands and replies (the
  install subscription as a real TV sends it, failures, split lines), the install sequence (commands in order, a cut
  copy caught by the MD5, space errors), the TV scan (loopback addresses), and the whole flow against a fake TV (a
  2020 TV, a wrong passphrase, Key Server off, Developer Mode off, the kept key and a key that changed, webOS 4
  refused, the emulator's key without a session token, `--package`). End to end over real SSH:
  `installer/lg/tests/fake-webos-tv.py` (paramiko 3.x) is a TV-like endpoint: Key Server, SSH on its own port with
  only `ssh-rsa` (as a TV), `prisoner` with the served key, SFTP into a root folder with the TV's paths, and
  `luna-send-pub` answering as a TV, **unpacking the ipk with Python's ar/tar readers** and checking packageinfo and
  appinfo; Tally-LG-Installer-linux installed, updated with the kept key, and launched through it (transcript in the
  tvweb-webos report). Found this way: SSH.NET signs the user key with `ssh-rsa`, which modern servers refuse and
  the TV requires.
- **Plugin** (`server/Tally.Tests/LgDevModeTests.cs`): LG's answers, the daily renewal and its schedule, failures
  retried after an hour and forgotten after 14 days, one entry per TV, tokens validated, at most 20, kept across
  restarts, against a fake LG server.
- **webOS runtimes**: LG's **webOS TV Emulator** exists only for webOS 1.2-6.0 ("From webOS TV 22, Emulator will not
  be provided"), as a VirtualBox VM (a 1.3-1.5 GB zip: a monolithic sparse VMDK, Yocto qemux86, IDE, e1000, VMSVGA;
  SSH 6622 → 22 as `developer`); this host has no VirtualBox and no root. The **webOS TV Simulator** (Electron,
  Chromium 79 for 6.0; 22-26 builds too) runs without root. **Run in LG's webOS 6.0 Simulator 1.4.1**
  (tvweb-webos, September 25, 2026; `scripts/webos-simulator.sh`, driven over its DevTools port): the shell as Tally
  for LG installs it loaded the bundle from a server, Quick Connect signed in, Home drew (the simulator zooms the
  1920x1080 page into a 1280x720 window), LG's `webOSSystem.deviceInfo` and `PalmServiceBridge` were the simulator's own, the
  panel came from its `getConfigs` (FHD, no HDR: the Full HD profile), the arrow keys, BACK 461 (the drawer, then
  `platformBack` bringing LG's "Do you want to exit the app?"), the Magic Remote's hover, wheel and click, and a
  film played straight from its MKV with the app's subtitles. The screensaver service is not in the simulator
  ("Service does not exist: com.webos.service.tvpower"; the app carries on). It found two bugs, both fixed:
  deviceInfo's `platformVersion` is the firmware's number ("02.00.94"), so the version now comes from `sdkVersion`
  or the web engine; a click opened a page twice (the kit's `onClick` for desktop mice acted as well as the
  pointer's OK), so the pointer's click now stops there. It is not LG's media pipeline (Electron's own decoders) and
  has no `audioTracks`.
  **Run in LG's webOS TV Emulator 5.0 under QEMU** (tvweb-webos, September 26, 2026; `scripts/webos-emulator.sh`:
  the VirtualBox VM's own disk behind a qcow2 overlay, KVM, 1 GB, VNC display, no root, boots in under a minute):
  webOS 5.0.0 (`getSystemInfo`: WEBOS5.0, sdkVersion 5.0.0, firmware 02.00.30), the real web engine of 2020 sets,
  **Chrome/68.0.3440.106**, so the Chromium 68 floor held on the engine itself (the Tizen emulator is Chrome 130).
  Tally for LG installed and launched Tally (section 11); the shell loaded the bundle from a Jellyfin server, Quick
  Connect signed in, Home, film pages and the player drew as in Chromium. deviceInfo there has no sdkVersion and
  `platformVersion` "02.00.30", so the version came from the web engine (5); `getConfigs` says panel UD, supportHDR
  "" (so UHD without HDR: AV1 in the profile sent to the server). LG's remote through the launcher's port (19001):
  arrows, OK, BACK 461 (the drawer, then `platformBack`, which on webOS 5 brings LG's launcher over the app), PAUSE
  19 / PLAY 415 / STOP 413, colors 403-406, CH+ 33 / CH- 34, numbers 48-57 (INFO sends nothing). `webOSRelaunch`
  (launching Tally while it runs) called `activate()`. On LG's media pipeline: a film direct from its MKV
  (`Static=true`, H.264 + 2 AAC tracks), `audioTracks` with both tracks and the Spanish one switched in place (no
  new PlaybackInfo, same file, playing on), the end of the film reported (post-play); another app in front: the
  page hidden, the decoder released (src removed); Tally again: reopened at its place (22.6 s), playing, Spanish
  kept. Not verifiable there: the emulator's pipeline plays MP4 and MKV but refuses MPEG-TS files and every HLS
  (TS or fMP4, `MEDIA_ERR_SRC_NOT_SUPPORTED`), so live channels, converted streams and quality rungs (HLS in TS
  from the server) stay "tuning in" there; `com.webos.service.tvpower` (the screensaver) does not exist there
  either; no Developer Mode session token (the emulator has no Developer Mode app): with a test token written into
  the installed config.js, the app handed it to this branch's plugin once signed in ("keeping LG Developer Mode on
  for LG webOS.TV", the settings line's 1 TV) and the plugin's renewal failed as it should in a container whose
  developer.lge.com pointed at loopback (nothing reached LG). One `<video>` decoder is assumed, not measured there
  (HLS tiles cannot play).

## 13. Feature parity with the Android TV app

Status: **done** (in tvweb-0), **planned** (same feature, later task), **adapted** (different on a TV web app, and
how), **not possible** (and why).

| Android TV feature | TV web |
|---|---|
| Tally look everywhere (tokens, Plex, amber focus, square, no glow) | done (kit + tokens) |
| Launch lamp | adapted: the shell's static lit lamp; the bundle's lamp on sign-in and tune-in |
| Server picker, discovery | adapted: address typed or stamped by the installer; UDP discovery is not available to web apps |
| User picker, PIN | planned |
| Quick Connect sign-in (lamp catches on approval) | done |
| Username/password sign-in | done |
| Self-update from GitHub releases | adapted: the bundle updates with the plugin; the shell rarely changes |
| Navigation rail and drawer (Search, Home, libraries, Sports, Surprise me, Favorites, Settings) | done (destinations beyond Home/Settings are placeholders) |
| Home: games row, header, library rows, backdrop, clock | done |
| Home: Watch live channels row, household row, watch party row, row customization (Settings → Home) | planned |
| Film / series / season / episode pages | done (tvweb-details); adapted: remote (YouTube) trailers open only in a browser (TVs: local trailers), extras of one kind are listed one by one (no grid page), no VERSION / audio / subtitle choice before playing (chosen in the player), no Delete (Android's media-management setting is off by default) |
| Library grid, tabs, filter/sort, alphabet, genres, recommended | done (play all / shuffle queue the grid's first 100; the item menu on HOLD OK / MENU) |
| Search (text) | planned; voice: adapted (the TV's own voice/IME input into the field) |
| Collections, person, favorites, playlists | person done (tvweb-details); collection page (header, PLAY / SHUFFLE / WATCHED / FAVORITE / VIEW / MORE / SORT / FILTER, a row per type or the mixed grid) and playlist page (numbered list, move up/down with Jellyfin 10.10's off-by-one move corrected, Remove from playlist) done (tvweb-gaps; adapted: no Delete, music playlists do not play yet); favorites planned |
| Item menu: Remove from continue watching (Home's Continue watching row) | done (tvweb-gaps: upstream's Mark unwatched, the card leaves the row at once) |
| Recordings not in a library (plugin contract 3) | done (tvweb-gaps: the notice in a Tally panel wherever a recording plays) |
| Music: albums, artists, now playing, lyrics | planned; background music: not possible (web apps stop when hidden) |
| Player: transport, seek bar, chapters, queue, next up, skip intro/credits (media segments) | done (tvweb-player) |
| Player: subtitles (text + burned-in), audio tracks | done |
| Player: quality ladder with MaxWidth/MaxHeight | done |
| Player: trickplay | done |
| Player: subtitle style settings | planned |
| Sleep timer | done (in the player's settings) |
| Post-play page, CollectionNext | done (post-play: tvweb-player; the collection's next film: on the film page) |
| Surprise me | planned |
| Sports: Games board, focused game panel (line score, situation, broadcasts), league/state rows incl. POSTPONED, hidden scores, followed teams, score roll | done |
| Sports: Channels grid | done |
| Sports: game actions menu (HOLD OK): watch, multiview, follow, hide scores, record | done |
| Live player: plugin continuous playlist, score bug | done |
| Live player: tune-in lamp | done |
| Live player: event banners, game switcher, box score overlay | done |
| Corner view (picture in picture) | adapted: needs a second decoder (Tizen avplaystore where the set has it), else the live card image; never a second video on LG (one media element at a time) |
| Multiview 4-up | done in browsers; adapted on TVs: two playing tiles on Samsung 2021+ (one where the set shows it cannot, remembered per model), one on LG (every generation) and elsewhere; the other tiles show live cards (section 6) |
| Remote: D-pad, BACK, media, color, channel keys | done on Samsung (measured on the emulator) and LG (LG's key codes; in Chromium with webOS forced) |
| LG Magic Remote pointer (hover, click, wheel) | done (webOS: pointer mode and 5-way mode, section 8) |
| Follow teams, hide scores, "My channels only" (shared settings) | done |
| Favorite channels | planned (the board reads them; no screen sets them on Android TV either) |
| DVR: record a game, record every team game (keep last N), Recordings tab, watch from the start, stop/cancel/delete | done (recording itself unverified on the dev server: it keeps 10 GB free and has less) |
| Watch parties (SyncPlay) | planned (Jellyfin SyncPlay over the SDK's websocket) |
| Household row, Send to another screen | planned (Jellyfin sessions API) |
| Play-on-TV target (phone pushes Play) | planned (Jellyfin websocket `Play` messages: same channel as Android) |
| Remote track switching from a phone | planned (websocket general commands) |
| Live-scores screensaver | adapted: in-app idle screensaver while the app is open; the TV's own screensaver outside |
| Downloads and offline playback | not possible: TV web apps have no storage for video files |
| Phone and tablet layouts | not applicable |
| Wholphin themes (Purple etc.) | not applicable: the Tally look only |
| Settings (app preferences, subtitle style, home rows) | planned (first cut: sign out, change server, reload, versions) |

## 14. Licenses

Shipped in the bundle: Preact (MIT), Norigin spatial navigation core (MIT, with lodash-es MIT), @jellyfin/sdk
(MPL-2.0, compatible with GPL-2.0 through its secondary-license clause), axios (MIT, with its MIT dependencies),
core-js (MIT). Fonts: IBM Plex and Font Awesome 6 Free Solid, both SIL OFL 1.1 (license files shipped next to them).
**hls.js (Apache-2.0)** is not linked into the bundle: it is a separate file that only desktop browsers load, never
the TVs (the plugin already serves it to browsers the same way). Apache-2.0 is not compatible with GPL-2.0-only, so
keeping it separate matters; the owner may prefer to state the bundle as GPL-2.0-or-later instead (open question).
Build/test only (not shipped): Vite, Rolldown, TypeScript, ESLint and plugins, Vitest, Playwright, acorn, the Tizen
Studio CLI and the webOS CLI.

Tally for LG (`installer/lg/`) ships the .NET runtime (MIT), the shell with its fonts (OFL), SSH.NET 2026.0.0 (MIT),
BouncyCastle.Cryptography 2.7.0 (MIT, SSH.NET's dependency) and Microsoft.Extensions.Logging.Abstractions (MIT); no
LG software (LG's CLI, Apache-2.0, was read as the specification; `--licenses` prints the notice). Tests only: test
keys made on the development machine, an ares-package output of the shell, paramiko (LGPL-2.1, the fake TV's
Python dependency, not in the repository).

Tally for Samsung (`installer/`) ships the .NET runtime (MIT), the shell and Samsung's public TV developer CA
certificates (published by Samsung under Apache-2.0). Tizen's public Developers CA certificate and key and public
distributor (Apache-2.0, git.tizen.org `sdk/tools/certificate-generator`) are **not shipped**: the program downloads
Tizen's `certificate-generator_0.1.4` package from download.tizen.org on first use (as Samsung's own
`@tizentv/tools` does), pinned by SHA-256. `installer/src/certificates/NOTICE.txt` has the details, with the
Apache-2.0 text, and the program prints them with `--licenses`. Tests only: xUnit, System.Security.Cryptography.Xml
(an independent canonicalizer), and a copy of Tizen's files as test fixtures (`installer/tests/fixtures/tizen-sdk/`,
with its notice) for the byte-for-byte signing tests.

## 15. Open questions for the owner

- **Samsung account** for Tizen 7+ TVs and for the Tizen emulator (Samsung certificates are issued per account and
  list the TV's DUID; valid about a year). Which TV does the friend have (model year / Tizen version)?
- **Author certificate custody**: `~/.tally/tizen` on this machine holds the key every future install must use; where
  should the owner keep a copy?
- **2027-01-01** Tizen Developers CA expiry: by Tizen's open validator, author certificates that end with the CA
  (Tizen Studio's and Tally for Samsung's) keep installing afterwards (section 11); Samsung's TV firmware is closed,
  so a 2020-2022 TV has to confirm it after that date. The fallback is a Samsung certificate (`--samsung`), which
  those TVs also take.
- **Tally for Samsung**: the Samsung sign-in and certificate requests are untested (no account); the first 2023+ TV
  install is their first real run. Code signing for the Windows/macOS programs (SmartScreen and Gatekeeper warn about
  unsigned downloads; INSTALL-SAMSUNG.md explains the clicks) is not set up.
- **Stores** (Samsung Seller Office, LG Content Store): pursue, or sideload only? Both review apps that load code
  from a server.
- **hls.js licensing** for the browser version (separate file today), or GPL-2.0-or-later for tv-web.
- **LG**: installs through Developer Mode, whose session the plugin now renews daily (it needs the server running and
  someone signed in on the TV once); acceptable for friends, or aim for the LG Content Store? LG's webOS 5 emulator
  ran Tally (Chrome 68, the install, keys, pointer, direct play, audio tracks, lifecycle; section 12); the first
  real LG TV is the first run of: native HLS on LG's pipeline (live channels and the live edge, converted streams,
  quality rungs: the emulator plays no HLS), 4K/HDR/Dolby Vision direct play, the Magic Remote itself (does OK send
  key 13 as well as the click), the screensaver requests (no such service in the emulator), the Developer Mode
  session token file and the renewal call (community-documented, not LG-documented), and Tally for LG's SSH to a
  real TV's `prisoner` account with a Key Server key.
- **The friend's TV** is the first real Samsung: what the emulator could not show is how many multiview tiles it
  plays (two are tried on 2021+ sets, section 6), 4K/HDR direct play, and that 2020-2022 firmware behaves as the
  Tizen 10 emulator did (AVPlay rules, keys). Its web inspector works the same way (Developer Mode, `sdb connect`).
