# Tally for Android TV — engineering rules

This repository is a fork of **Wholphin** (GPL-2.0). It is Wholphin, unchanged, plus one native section
called **Tally**: a live-sports front end backed by the `Jellyfin.Plugin.JellyTV` server plugin.
The plugin's source is in [`server/`](server/). This file is the short set of rules every change to the app must
obey.

## The one rule

Upstream ships often and this fork is rebased onto every release. **Every line you change in an upstream
file is a future merge conflict.** Therefore:

1. All Tally code lives under `app/src/main/java/io/github/scdouglas1999/tally/`
   (tests: `app/src/test/java/io/github/scdouglas1999/tally/`, fixtures
   `app/src/test/resources/tally/`, strings `app/src/main/res/values/strings_tally.xml`,
   fonts `app/src/main/res/font/ibm_plex_*`).
2. Upstream files may be edited ONLY at the seams listed below, only by the task that owns that seam, and
   every edited region is wrapped in `// TALLY: begin` … `// TALLY: end`.
   Exception: never put marker comments inside an import list (ktlint cannot sort around them). Prefer a
   fully-qualified type in the seam over a new import; where an import is unavoidable, add it unmarked in its
   sorted position. Seams only ever ADD lines; if a seam needs logic, the logic lives in the tally package.
3. Never reformat, reorder imports in, or "tidy" an upstream file. Never touch `strings.xml`
   (Weblate rewrites it) — new strings go in `strings_tally.xml`.
4. Never add a Room entity/migration (the DB is versioned upstream). Persist with `KeyValueService`.
5. Never add a Gradle dependency without being told to. Everything needed is already there:
   OkHttp, kotlinx.serialization, Coil 3, Hilt, Compose for TV (`androidx.tv.material3`), Media3.

### Seams (the complete list)

| Seam | File | What |
|---|---|---|
| W1 | `ui/nav/Destination.kt` | new `Destination` subclasses |
| W2 | `ui/nav/DestinationContent.kt` | their `when` branches |
| W3 | `ui/nav/NavDrawer.kt` | `NavDrawerItem.Sports` + the three `when` branches |
| W4 | `services/NavDrawerService.kt` | add the item to `builtins` |
| W5 | `services/ServerEventListener.kt` | handle server-pushed `PlayMessage` |
| W6 | `app/build.gradle.kts`, `res/values/strings.xml` (`app_name`, `app_name_long` ONLY), launcher art | identity |
| W7 | `MainActivity.kt` | inject `TallyUpdatePrompt`, call it after upstream's update check |
| W8 | `preferences/AppPreference.kt` (`UpdateUrl.defaultValue` ONLY) | self-update from this fork's releases |
| W9 | `ui/setup/InstallUpdatePage.kt` | initial focus on "Download & Update" |
| W10 | `ui/setup/SwitchServerViewModel.kt` (`init`) | no servers yet: add the one stamped into the APK (`TallyStampedServer`) |
| W11 | `ui/setup/SwitchUserContent.kt` | no users yet: open the Quick Connect dialog straight away |
| W12 | `services/PlayerFactory.kt` | live buffering cushion + load control (`TallyLivePlayback`) |
| W13 | `ui/playback/PlaybackViewModel.kt` (`onPlayerError`) | re-sync instead of failing when behind the live window |
| W14 | `proto/WholphinDataStore.proto` (`AppThemeColors.TALLY = 8`, additive) | the Tally theme as a first-class Wholphin theme |
| W15 | `ui/theme/Theme.kt` | map TALLY → `TallyThemeColors`; IBM Plex typography when it is active |
| W16 | `preferences/AppPreference.kt` (`ThemeColors` default + display array), `ui/preferences/SwitchPreference.kt` | TALLY is the default theme |
| W17 | `ui/main/HomePage.kt` | `TallyHomeRow` as a fixed band above the library rows; `TallyHomeHeader` while a game card has focus; `TallyHomeFocus` hand-off in the initial-focus step |
| W18 | `MainContent.kt` | `TallyScreensaver` before upstream's screensaver |
| W19 | `MainActivity.kt` (same region as W7) | `TallyFirstRun`: one-time theme switch for stores written by earlier builds |
| W20 | `ui/playback/PlaybackDialog.kt` (`PlaybackDialogType` + SETTINGS list) | "Sleep timer" and "Send to another screen" entries → `TallyPlayerMenu` |
| W21 | `ui/playback/PlaybackViewModel.kt` (item set) | publishes the now-playing item id for Send |
| W22 | `MainContent.kt` | `TallyGlobalOverlays` (sleep chip, menu dialogs) above every screen |
| W23 | `ui/main/HomePage.kt` | `HouseholdRow` item after the Tally row |
| W24 | `ui/nav/Destination.kt`, `ui/nav/DestinationContent.kt` | `TallySurprise`, `TallyPostPlay` and their pages ("Your <year>" was removed 2026-09-23) |
| W25 | `ui/nav/NavDrawer.kt`, `services/NavDrawerService.kt` | drawer entry "Surprise me" |
| W26 | `services/PlaylistCreator.kt` (movie branch) | append the next film of the movie's collection (`CollectionNext`) so upstream's Up Next works for movies |
| W27 | `ui/playback/PlaybackViewModel.kt` (`STATE_ENDED`, nothing next) | a finished movie opens the post-play page (`TallyPostPlay`) instead of going back |
| W28 | `services/ServerEventListener.kt` | advertise `TallyRemoteCommands.SUPPORTED`; start/stop `TallyRemoteCommands.listen` with the socket |
| W29 | `ui/playback/PlaybackViewModel.kt` (`init`) | bind the player to `TallyRemoteBus` for remote audio/subtitle track switching |
| W30 | `ui/playback/PlaybackDialog.kt` (W20 region), `ui/main/HomePage.kt` (W23 region) | "Watch together" menu entry (`TALLY_TOGETHER`); `TogetherRow` after the household row |
| W31 | `ui/nav/DestinationContent.kt` (top of `DestinationContent`) | `TallyRoutes.Content`: Tally-owned screens (TALLY theme only), see `tally/UI.md` |
| W32 | `ui/theme/Theme.kt` (W15 region) | square theme shapes for TALLY (`TallyShapes`, `TallyMaterialShapes`) |
| W33 | `ui/playback/PlaybackViewModel.kt` (`init` W29 region; `changeStreams` bitrate), `PlaybackDialog.kt` (W20 region) | in-player Quality: `TallyQuality` override before the global max bitrate, restart at the current position, no video stream copy while a quality is chosen (`transcodingUrl`); "Quality" menu entry |
| W34 | `ui/nav/ApplicationContent.kt` (NavDrawer call) | `TallyNavDrawer` replaces upstream's drawer while the TALLY theme is selected |
| W35 | `services/hilt/AppModule.kt` (`clientInfo`) | `TallyClientName`: JellyTV-era installs keep reporting "JellyTV" to the server, because their tokens are bound to that name |
| W37 | `ui/playback/PlaybackPage.kt` (overlay, pause indicator, D-pad seek incl. the minimal seek bar, skip segment, next-up calls), `ui/playback/PlaybackDialog.kt` (top of the dialog) | Tally player controls (`ui/player/controls/`): the overlay and pause indicator calls sit in the `else` of a Tally `if` (re-indented upstream lines), the others return early |
| W38 | `ui/preferences/{Switch,Choice,Click,Slider,MultiChoice}Preference.kt`, `StringInputDialog.kt`, `LocaleChoiceDialog.kt`, `ui/components/Dialogs.kt`, `ui/components/ContextMenu.kt`, `PreferencesContent.kt` (page title re-indented into the `else` of a Tally `if`) | Tally settings rows, dialogs and context menu (`ui/settings/`); `PreferencesPage` hands the whole page to `TallySettingsPage` (full width); subtitle / user profile / home settings pages, nav-drawer pins, language filter, Quick Connect and Seerr dialogs hand over too |
| W39 | `ui/setup/SwitchServerContent.kt`, `SwitchUserContent.kt`, `InstallUpdatePage.kt`, `PinEntry.kt` | Tally sign-in, pickers, PIN and update screens (`ui/setup/`) |
| W40 | `ui/setup/SwitchUserViewModel.kt` (`initiateQuickConnect`, before navigating) | `TallyQuickConnectHold.holdForCatch()`: the approved lamp is seen before home appears (Tally step on screen only) |
| W41 | `app/build.gradle.kts`, `services/AppUpgradeHandler.kt`, `services/UpdateChecker.kt` | Tally's own version line from 2.0.0 (`tally-v*` tags → versionName/versionCode); Wholphin's upgrade steps keep the upstream base (`BuildConfig.TALLY_UPSTREAM_VERSION`); release notes come from Tally's releases |
| W42 | `MainActivity.kt` (`onCreate`, after `instance = this`) | `TallyPhoneWindow.setUp`: on a phone only, edge to edge with light bar icons, keyboard insets to the app (adjust resize), portrait below 600dp smallest width |
| W43 | `ui/nav/ApplicationContent.kt` (W34 region, before the Tally drawer) | `PhoneShell` (page + bottom bar, `ui/phone/`) replaces the drawer on a phone |
| W44 | `ui/theme/Theme.kt` (top of `WholphinTheme`) | provides `LocalTallyFormFactor` to every screen; in the app window on a phone the theme in effect is TALLY whatever the preference (`tallyThemeInEffect`, `TallyPhoneWindow`) |
| W45 | `ui/preferences/PreferencesContent.kt` (preference loop) | `hiddenOnPhone`: the Application theme row is not shown on a phone |
| W46 | `services/ScreensaverService.kt` (`init`, `start`) | on a phone the in-app screensaver, the live-scores screensaver and idle dimming stay off, and the screen sleeps as the OS says |
| W47 | `services/MusicService.kt` (`start`, `stop`), `AndroidManifest.xml` (FOREGROUND_SERVICE / FOREGROUND_SERVICE_MEDIA_PLAYBACK, the service entry) | on a phone the music session runs in `TallyMusicPlaybackService` (Media3 `MediaSessionService`, `playback/`): background playback, media notification, lock-screen controls. Nothing on a TV |
| W48 | `ui/preferences/subtitle/SubtitleStylePage.kt` (before the page's `Row`) | on a phone `PhoneSubtitleStylePage` (`ui/settings/phone/`): top bar, the live preview pinned under it, upstream's list below |
| W49 | `ui/main/settings/HomeSettingsPage.kt` (settings pane modifier; home preview in the `if` of a Tally check, re-indented) | on a phone the row list takes the whole width and the home preview is left out |
| W50 | `ui/preferences/user/UserProfilePreferencesPage.kt` (top of `UserProfilePreferencesPage`) | on a phone upstream's list takes the whole screen (`phoneFullPage`) |
| W51 | `ui/playback/PlaybackPage.kt` (top of `PlaybackPage`; after `controllerViewState` in `PlaybackPageContent`) | `PhonePlayerWindow`: on a phone the player is landscape and full screen (bars hidden) while shown; `TallyPlayerBack`: in the Tally look on a TV BACK hides visible controls first, and BACK in a player that is the only page goes Home instead of leaving the app (`ui/player/controls/`) |
| W52 | `ui/detail/PlaylistList.kt` (top of `PlaylistDialog`) | on a phone the add-to-playlist dialog is `PhonePlaylistSheet` (`media/kit/phone/`), for every caller |
| W53 | `ui/preferences/PreferencesContent.kt` (version dialog, `DataLoadingState.Error` branch) | in the Tally look, release notes that cannot be fetched (no `tally-v` release: 404) show a calm "No release notes for this version" (`TallyReleaseNotesMissing`, `ui/settings/`) instead of upstream's red error |
| W54 | `services/HomeSettingsService.kt` (RecentlyReleased request) | on servers before 10.11, leave out the aired-episode-order sort key (10.10 answers it with HTTP 500, so the row failed) |
| W55 | `services/UpdateChecker.kt` (`getDownloadUrl`) | Tally's asset names first (`Tally-<abi>.apk`, `Tally.apk`), Wholphin's as the fallback |
| W56 | `MainActivity.kt` (update toast), `WholphinApplication.kt` (crash dialog), `ui/main/settings/HomeRowPresets.kt` (preset names) | Tally's name instead of "Wholphin" in text people see (`strings_tally_branding.xml`) |
| W57 | `ui/playback/PlaybackViewModel.kt` (`init` item and cinema-mode intros, `createPlayer` backend, `play` media source, `changeStreams` playback info) | downloads: a completed download plays from the device, online too, in ExoPlayer (`TallyDownloadPlayback`, `downloads/`); offline the stored item and no intros. Not used when direct play is off (forced transcode, a chosen Quality, the fallback after an error). Downloads are a phone feature: on a TV this and W58-W61 answer exactly as Wholphin does |
| W58 | `services/PlayerFactory.kt` (video and audio players) | the players' data source reads downloads first (`tallydl://` URIs, downloaded subtitle files), then what upstream used |
| W59 | `services/MusicService.kt` (`convert`) | a downloaded track plays from the device |
| W60 | `MainActivity.kt` (`onCreate` after W42; `appStart`: before the upgrade step and in its `catch`) | `TallyOfflineStart`: starts downloads; no network or the server unreachable with completed downloads → offline mode on the downloads page instead of the server list |
| W61 | `data/ServerRepository.kt` (after `closeSession`) | `tallyRestoreOffline`: the saved session without asking the server (offline start); `tallyRefreshUserDto`: the signed-in user's details once the server answers again (upstream's `updateUserDto` only replaces details it already has, so after an offline start they stayed unknown) |
| W62 | `ui/nav/Destination.kt`, `ui/nav/DestinationContent.kt` (the TALLY blocks at the end) | `Destination.TallyDownloads` and its page |
| W63 | `AndroidManifest.xml` | downloads: FOREGROUND_SERVICE_DATA_SYNC, `TallyDownloadService` (Media3 download service), Media3's `PlatformSchedulerService` |
| W64 | `ui/preferences/PreferencesContent.kt` (before `prefList`; top of the list's `LazyColumn`; in each row's `item` before `when (pref)`) | Tally's settings layout on the main screen (`TallyExtraSettings`, `ui/settings/`): About at the very bottom with Support Tally; on a phone a Downloads section after Next up. The rows are marker preferences drawn by Tally |
| W65 | `ui/setup/InstallUpdatePage.kt` (top of `ReleaseNotes`) | release notes are cut at `<!-- tally-support -->` (`TallySupport`, `support/`): the Patreon line of `tally/release.sh` shows on GitHub, never in the app |
| W66 | `services/IntentService.kt` (`parseIntent`, before the item id) | `wholphin://downloads` opens the Downloads page (the download notifications' link, `DownloadsLink`) |
| W67 | `ui/nav/Destination.kt`, `ui/nav/DestinationContent.kt` (a second TALLY block after W62's) | `Destination.TallyStartOver` and its page: WATCH FROM THE START of a game the server is recording (`dvr/ui/StartOverPage.kt`, its own ExoPlayer on the job's start-over playlist) |
| W68 | `services/hilt/AppModule.kt` (`okHttpClient`, the base client every other client is built from) | `TallyServerRoute.interceptor` (`lan/`): each request to a known server goes to its active address, a home-network address (LocalAddress, discovery) when one answers, else the saved one; a request whose address stops answering is retried at the next address that answers with the same server id. API, websocket, images, downloads and the Tally API all follow. Not a seam of its own but the same feature: the video player's Media3 HTTP source (W58's `readLocalCopies`, now on a TV too) and the multiview/corner players open streams through `RoutedDataSource`, and W13's `TallyLivePlayback.recover` asks `RouteRecovery` first (a stream the server dropped when the old path died is requested again at the player's position; a live channel at its live edge, after its old playback is stopped, W69) |
| W69 | `ui/playback/PlaybackViewModel.kt` (`changeStreams`: before the playback info request; after `setMediaItem`), `util/TrackActivityPlaybackListener.kt` (`tallyReportsInFlight`, after `release`) | `LiveStreamStop` (`playback/`): an in-player change that opens a live stream again (Quality, audio track, subtitle burn-in, `RouteRecovery`'s restart) first stops the old playback: the player lets go of the old stream, its stop report is sent and answered (canceled after 10 s), then the stream is requested. Upstream's order (stop reported after the new stream opened) closed the new stream whenever the server had already closed the old one, since a channel's live stream id is the same every time. A channel then starts at its live edge, not at the old stream's position |
| W72 | `services/SetupNavigationManager.kt` (`navigateTo`), `ui/setup/SwitchUserViewModel.kt` (`init`, before `switchServerOrUser`) | `TallySetupReturn` (`ui/setup/`): the user and server lists opened from the app remember the session the app showed; while they do the saved session is kept (the next launch opens home, not the server list), and BACK on them goes back (server list → that server's user list → the app) instead of leaving the app. Lists shown at startup behave as upstream |
| W73 | `ui/playback/PlaybackViewModel.kt` (`createPlayer` after the media session; `release` before the session is released), `AndroidManifest.xml` (the service entry) | on a phone the video player's media session is served by `TallyVideoPlaybackService` (`playback/`) while the player is on screen: media notification and lock-screen controls with the item's picture (a download's stored artwork, so offline too). Nothing on a TV |
| (database) | `downloads/db/TallyDownloadsDatabase.kt`, `app/schemas/io.github.scdouglas1999.tally.downloads.db.TallyDownloadsDatabase/` | Tally's own Room database (`tally_downloads.db`) for download records and offline progress. Rule 4 still holds: upstream's `AppDatabase` gets nothing; this one is versioned by Tally |
| (resource) | `res/values-v31/themes_tally.xml` (new file) | redefines `Theme.Wholphin` for Android 12+ with a plain ground splash (no icon) so the launch lamp is not preceded by a lit icon. It shadows upstream's `res/values/themes.xml` on v31+: if upstream changes that style, copy the change here |

## Releases and self-update

Upstream's updater is kept and pointed at this fork (W8). It reads the GitHub release **name** as the version
(`vX.Y.Z`, from the `tally-vX.Y.Z` tag, W41). From 2.0.2 it downloads `Tally-<abi>.apk` (else `Tally.apk`) and falls
back to upstream's `Wholphin-release-<abi>.apk`; releases still carry the Wholphin-named copies for installs from
before 2.0.2, whose updater knows only those names. `Tally.apk` (universal) is the permanent install link
`https://github.com/Scdouglas1999/Tally/releases/latest/download/Tally.apk`.
Release git tags are `tally-*` (earlier `jtv-*`): they must NOT match `v*`/`p*`, which `app/build.gradle.kts` uses
for the upstream base version.
`tally/release.sh` builds and signs; `tally/release.sh --publish` also creates the GitHub release.

## Conventions (match the surrounding code)

- Kotlin, 4-space indent, trailing commas, ktlint 1.8 style as in the rest of the repo.
- DI: constructor injection. `@Singleton class Foo @Inject constructor(...)`; view models are
  `@HiltViewModel class X @Inject constructor(...) : ViewModel()`; no new Hilt modules.
  Qualifiers already exist: `@AuthOkHttpClient OkHttpClient` (adds the user's Authorization header),
  `@IoDispatcher`, `@DefaultCoroutineScope`. Use-site targets are written `@param:AuthOkHttpClient`.
- The server base URL is `ApiClient.baseUrl` (inject `org.jellyfin.sdk.api.client.ApiClient`). It can be null
  when signed out.
- Logging: `Timber`. No `println`, no `Log`.
- Coroutines: never block; IO on the injected IO dispatcher.
- Compose: **Compose for TV** (`androidx.tv.material3.*`) for focusable surfaces, exactly as upstream pages do.
  Every interactive element must be reachable and operable with a D-pad. No touch-only affordances.
- No emoji in UI. No hard-coded user-visible strings: use `strings_tally.xml`.

## The server contract

`api/TallyModels.kt` is the contract and is **read-only for you** — if you think it is wrong, stop
and say so instead of editing it. Decode with the provided `TallyJson`. Endpoints (all relative to
`ApiClient.baseUrl`, all need the auth header, all JSON):

| Call | Returns |
|---|---|
| `GET /JellyTV/Client/v1/info` | `TallyInfo`. **HTTP 404 = the server has no Tally plugin → the Tally section must not appear at all.** 401 = signed out. |
| `GET /JellyTV/Client/v1/board?since={lastEventId}` | `TallyBoard`. Omit `since` on the first call (returns no events); afterwards pass the highest event id seen. |
| `GET /JellyTV/Client/v1/channels/{id}` | `TallyChannel`, fresh. |
| `GET` / `PUT /JellyTV/Client/v1/settings` | free-form JSON object shared with the web UI. Read-modify-write: unknown keys MUST be preserved. Known keys: `favorites: [channelId]`, `hideScores: bool`, `lastChannel: string`. |

`hlsPath` and `cardPath` are root-relative: prefix with `ApiClient.baseUrl`. Images load through the app's
existing Coil loader (already authenticated) — a plain `AsyncImage(model = url)` works.
A realistic payload is in `app/src/test/resources/tally/board-sample.json`.

**There is no "heat" in this app.** Ignore `heat`/`tags` if you see them in JSON. Board order is:
favorites first, then by league, live before upcoming before final, then by start time.

## Design system (same as the Tally web UI; TV-sized)

Flat, near-black, hairline rules, square corners (radius 0 everywhere), one accent. No gradients as
decoration, no blur, no glow, no drop shadows, no rounded cards.

| Token | Value | Use |
|---|---|---|
| `ground` | `#0E0F0E` | screen background |
| `groundRaised` | `#1B1C1A` | focused card ground |
| `screen` | `#050505` | video / monitor faces |
| `labelBar` | `#000000` | channel label bars |
| `rule` | `#2A2C2A` | structural hairlines (1dp) |
| `ruleStrong` | `#3A3D38` | control / card borders (1dp), idle indicator squares |
| `text` | `#E3E5DE` | primary text |
| `textSecondary` | `#A9ADA3` | secondary text |
| `muted` | `#8B9084` | captions, labels |
| `accent` | `#FFB000` | focus frame, "now", active tab. Text on accent is `#0E0F0E` |
| `live` | `#FF3B30` | LIVE only (and failure). Small red text uses `#FF6A61` |

Type: **IBM Plex Sans** (`R.font.ibm_plex_sans_regular/medium/semibold/bold`) for reading; **IBM Plex Mono**
(`R.font.ibm_plex_mono_regular/medium/semibold`) for clocks, scores, league/channel labels and anything
instrument-like. Mono labels are UPPERCASE with 1.5–2.5sp letter spacing. Minimum text size 14sp; body 18sp+.

Focus: exactly one element is focused. Focused = 3dp `accent` border + `groundRaised` ground; NO scale
animation, no glow. Unfocused = 1dp `ruleStrong` border. Safe margins: 48dp left/right, 27dp top/bottom.
Motion: focus/color changes ≤120ms, nothing bounces.

Reference mockups (1920×1080): Games = top bar, a large "focused game" panel (teams, big mono scores, clock,
situation, last play, channel label bar, key hints), then horizontally scrolling rows of game cards, one row
per league+state ("NFL / LIVE"). Card = league + clock strip, two team lines (logo, short name, mono score),
black label bar with an indicator square + channel name.

## Definition of done for any task

- Only files you were told to create/edit are touched (`git status` shows nothing else).
- It compiles: `./gradlew :app:compileDefaultDebugKotlin` — **do not run Gradle unless your task says you may**;
  builds are run centrally because several tasks share this machine.
- Unit tests you add pass under `./gradlew :app:testDefaultDebugUnitTest --tests "io.github.scdouglas1999.tally*"` (same caveat).
- You end by printing a short report: files created/changed, anything you were unsure about, anything you
  deliberately left as TODO. Never claim something works that you did not run.
