# Tally TV (web)

Tally for Samsung (Tizen 5.5+) and LG (webOS 5+) TVs, and desktop browsers: one TypeScript app with Tally's own
screens, talking to Jellyfin and the Tally plugin. The TV apps are small installed shells that load this app from
the Tally plugin on the viewer's server, so a plugin update updates every TV. Design and decisions:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Node.js 20+ and npm (developed with Node 26 / npm 12).
- For the TV packages: the Tizen Studio CLI (Samsung) and/or the webOS CLI (LG), see [Tools](#tools).
- A Jellyfin 10.10+ server with the Tally plugin (for Sports and for the TV shells, which load the app from it).

## Build and check

```sh
npm ci
npm test            # unit tests (Vitest)
npm run lint        # ESLint (+ Chromium 68 compat), strict TypeScript, the CSS legacy check
npm run build       # dist/bundle/: app.<hash>.js/.css, fonts, hls.js, manifest.json, index.html (+ ES2019 check)
```

`server/build.sh` runs the same build and embeds `dist/bundle/` in the plugin (served at `/JellyTV/TV/`).

## Run in a browser

```sh
npm run dev                                   # http://localhost:5173/?server=http://127.0.0.1:18200
npm run build && npm run preview              # the production bundle at http://127.0.0.1:4173/?server=…
```

`?server=` sets the Jellyfin address (remembered). A Tally server also serves the app itself at
`http://<server>/JellyTV/TV/index.html`. Arrow keys, Enter, Escape (BACK) and PageUp/PageDown (channel ±) stand in for
the remote; holding Enter is HOLD OK (a game's actions, a channel into multiview), as is the ContextMenu key. `window.TallyDebug.push({ name: 'player', itemId: '…' })` opens any route from the console.

## End-to-end tests

```sh
npm run build
npm run e2e         # Playwright, Chromium at 1920x1080, against TALLY_SERVER (default http://127.0.0.1:18200)
```

The tests sign in through Quick Connect and approve the code with an admin token (`TALLY_TOKEN_FILE`, default
`~/Documents/Tally/devmedia/.tools/dev-server.token`). `CHROMIUM` picks the browser (default `/usr/bin/chromium`),
`TALLY_PREVIEW_PORT` the port of the `vite preview` the tests start (default 4173; a server already on that port is
never reused, so a worktree never tests another one's bundle: give each worktree its own port). Screenshots land in
`test-results/shots/`, the report in `playwright-report/`.

Performance on a TV-class budget (Chromium with the CPU slowed 4x: startup, key-to-paint latency and long frames on
Home, a library grid, a film page and the Sports board, picture sizes, and a long browsing + playback session with
the heap and DOM measured after each cycle) runs only when asked:

```sh
TALLY_PERF=1 TALLY_PERF_CYCLES=90 npx playwright test e2e/perf.spec.ts   # results in test-results/perf/*.json
```

Sports needs live games. The score simulator makes them on the dev server (`tally/dev/score-sim.py`):

```sh
TALLY_DEV_TOKEN=~/Documents/Tally/devmedia/.tools/dev-server.token ../tally/dev/score-sim-docker.sh
docker exec tally-score-sim python /sim.py state 401817062 in      # a captured game goes live (its id on the board)
docker exec tally-score-sim python /sim.py add --id 900001 --away "TOR:Toronto:Blue Jays" \
  --home "BAL:Baltimore:Orioles" --start -30 --state in               # a fictional game on the Toronto channel
TALLY_SIM=1 npm run e2e                                              # bumps scores through the simulator
TALLY_DEV_TOKEN=… python3 ../tally/dev/score-sim.py point "" && docker rm -f tally-score-sim   # back to ESPN
```

## Package

```sh
scripts/tizen-certificate.sh                       # once: author certificate + "tally" signing profile (~/.tally/tizen)
scripts/package-tizen.sh [--server http://192.168.1.10:8096]   # dist/Tally.wgt
scripts/package-webos.sh [--server http://192.168.1.10:8096]   # dist/io.github.scdouglas1999.tally_<ver>_all.ipk
```

`--server` stamps the Jellyfin address into the package, so the TV opens straight to Quick Connect. Without it the
TV asks for the address on first start. For development, `--bundle http://<this-pc>:4173/` makes the shell load the
bundle from `npm run preview` instead of the server's plugin (an emulator reaches this PC at `10.0.2.2`).
**Back up `~/.tally/tizen`**: every later install on a TV must be signed with the same author certificate.

## Install on a TV

### Samsung (2020 and newer)

**For people installing Tally on their own TV: [INSTALL-SAMSUNG.md](INSTALL-SAMSUNG.md).** It uses *Tally for
Samsung* (`Tally-Samsung-Installer-windows.exe`, `-macos-arm64`, `-macos-x64`, `-linux` on the release page), one
program that finds the TV, signs Tally on the user's computer (a Tizen certificate for 2020-2022 TVs, a Samsung
certificate for 2023 and newer) and installs it, without Tizen Studio. Its source and tests are in
[`installer/`](installer/) (`installer/build.sh` builds all four; `dotnet test installer/tests` runs its tests;
ARCHITECTURE.md §11 describes it). For development it also takes `--bundle http://<this-pc>:4173/` (the shell then
loads the bundle from `npm run preview`) and `--data-dir <folder>` (a separate set of certificates).

From a development machine with Tizen Studio, the script does the same:

1. On the TV: open **Apps**, go to **App Settings** (or stay on the Apps screen), type **1 2 3 4 5** with the remote,
   switch **Developer mode** on, enter this PC's IP address as **Host PC IP**, then restart the TV fully (hold the
   power button; unplug it if Instant On is on).
2. On the PC (same network): `scripts/install-tizen.sh <tv-ip> --server http://<jellyfin-address>:8096`
3. The TV opens Tally showing a 6-digit code; approve it on a phone (Jellyfin → Quick Connect).

2020-2022 TVs (Tizen 5.5-6.5) accept the plain Tizen certificate the script creates. 2023 and newer TVs (Tizen 7+)
need a Samsung certificate that lists the TV's DUID (the script prints it and stops): create it once in Tizen Studio's
Certificate Manager with a Samsung account, then run the script again with `--profile <that profile>`. Details in
ARCHITECTURE.md, Packaging.

### LG (webOS 5 and newer)

**For people installing Tally on their own TV: [INSTALL-LG.md](INSTALL-LG.md).** It uses *Tally for LG*
(`Tally-LG-Installer-windows.exe`, `-macos-arm64`, `-macos-x64`, `-linux` on the release page), which finds the TV,
unlocks the key of its Developer Mode with the passphrase the Developer Mode app shows, writes the package itself
and installs it over SSH, without LG's tools, and stamps the Developer Mode session into Tally so the server keeps
it on. Its source and tests are in [`installer/lg/`](installer/lg/) (`installer/build.sh lg` builds all four;
`dotnet test installer/lg/tests` runs its tests; ARCHITECTURE.md §11 describes it). For development it takes
`--bundle http://<this-pc>:4173/`, `--passphrase`, `--package` and, for LG's emulator, `--tv 127.0.0.1 --ssh-port
6622 --user developer --key <webos_emul>`. `installer/lg/tests/fake-webos-tv.py` is a TV-like endpoint for trying it
without a TV.

From a development machine with LG's CLI:

1. On the TV: install **Developer Mode** from the LG Content Store, sign in with an LG developer account, switch
   **Dev Mode Status** and **Key Server** on.
2. On the PC: `ares-setup-device` (add the TV's IP, passphrase from the Developer Mode app), then
   `ares-install -d <tv> dist/io.github.scdouglas1999.tally_<ver>_all.ipk` and `ares-launch -d <tv> io.github.scdouglas1999.tally`.
3. A package from `scripts/package-webos.sh` carries no Developer Mode session: extend it in the Developer Mode app
   before it runs out (Tally for LG's packages are kept on by the server).

## Tools

Installed without root under `~/tools/` on the development machine:

- **Tizen Studio 6.1 CLI** (`~/tools/tizen-studio`, from `download.tizen.org/sdk/Installer/tizen-studio_6.1/`,
  `web-cli_…_ubuntu-64.bin --accept-license ~/tools/tizen-studio`), then
  `package-manager/package-manager-cli.bin install --accept-license TV-SAMSUNG-Public,TV-SAMSUNG-Public-Emulator,
  TV-SAMSUNG-Public-WebAppDevelopment,cert-add-on,Certificate-Manager,Emulator`. On a non-Ubuntu host put a `dpkg`
  shim on `PATH` that reports the Ubuntu prerequisites as installed (`~/tools/shims/dpkg`), and skip its KVM `sudo`
  step when `/dev/kvm` is already usable.
- **Tizen TV emulator**: `scripts/tizen-emulator.sh start|shot <png>|stop` runs the VM `tally-tv` (1080p, 1 GB RAM,
  Tizen 10.0 TV image) on a private Xvfb display; it needs ≥ 7 GB free. Samsung documents that it installs only
  Samsung-certificate-signed apps; a patched copy that takes the Tizen certificate, and how to inspect and drive
  Tally in it (web inspector over `sdb shell 0 debug`, keys through the window), is in ARCHITECTURE.md, Testing.
- **webOS CLI**: `npm install --prefix ~/tools/webos-cli @webos-tools/cli@3.2.6` (commands in
  `~/tools/webos-cli/node_modules/.bin`).
- **webOS TV Simulator**: LG's Linux AppImage (`webOS_TV_6.0_Simulator_1.4.1`, Electron with Chromium 79, from
  webostv.developer.lge.com/develop/tools/simulator-installation; no login, a license click-through), extracted
  with `--appimage-extract` under `~/tools/webos-simulator/`; run as `<AppRun> <app folder> '{}'` on an Xvfb
  display.

## Dependencies

Shipped: preact 10.29.8 (MIT), @noriginmedia/norigin-spatial-navigation-core 4.1.1 (MIT), @jellyfin/sdk 1.0.0
(MPL-2.0), axios 1.20.0 (MIT), core-js 3.50.0 (MIT); hls.js 1.7.3 (Apache-2.0) as a separate file for desktop
browsers only. Build and test: vite 8.3.1, typescript 6.0.3, vitest 5.0.1, eslint 10.11.0, typescript-eslint 8.70.1,
eslint-plugin-compat 7.0.2, @playwright/test 1.63.0, acorn 8.15.0 (all MIT or Apache-2.0, not shipped). Versions are
pinned in `package.json`.
