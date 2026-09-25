import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { APP, AUTH_STATE, SERVER, api, shot } from './env';
import { restoreTracks, restoreUserData, trackDefaults, userData } from './restore';

/**
 * Tally on LG webOS, in desktop Chromium with the webOS platform forced: `webOSSystem` (deviceInfo of a 2020 OLED,
 * activate, platformBack) and a `PalmServiceBridge` that answers the TV services the app calls (the panel's configs,
 * the screensaver requests) and records every call. Remote keys arrive with LG's key codes (BACK 461, CH± 33/34,
 * colors 403-406, PLAY 415, PAUSE 19); the Magic Remote is the mouse (move, click, wheel) plus `cursorStateChange`.
 * `--enable-blink-features=AudioVideoTracks` gives Chromium the `audioTracks` LG's element has. What only a TV can
 * show (LG's media pipeline, HDR, the real Luna services) is in ARCHITECTURE.md §12.
 */
test.use({
  storageState: AUTH_STATE,
  launchOptions: {
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    // the shell test serves the shell page from a route (no address space: Chromium's Local Network Access would
    // block its requests to the dev server on loopback)
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-blink-features=AudioVideoTracks', '--disable-features=LocalNetworkAccessChecks'],
  },
});

const PORT = process.env.TALLY_PREVIEW_PORT ?? '4173';
const TOKEN = '4a2f9c8e71d3b6055e0c1a9f8d7b6e5c';

interface LunaCall {
  uri: string;
  params: Record<string, unknown>;
}
interface WebosFake {
  luna: LunaCall[];
  activated: number;
  back: number;
  screenSaver: ((m: unknown) => void) | null;
}

/** webOS as the page sees it on a TV, before any script runs. `shell`: also a TallyShell with the stamped token. */
async function asWebos(page: Page, shell: boolean): Promise<void> {
  await page.addInitScript(
    ({ token, server, base, withShell }) => {
      const w = window as unknown as Record<string, unknown>;
      const fake: WebosFake = { luna: [], activated: 0, back: 0, screenSaver: null };
      w.__webos = fake;
      w.webOSSystem = {
        deviceInfo: JSON.stringify({ modelName: 'OLED55CX9LA', platformVersion: '5.2.0', platformVersionMajor: 5, screenWidth: 1920, screenHeight: 1080 }),
        launchParams: '{}',
        activate: () => void fake.activated++,
        platformBack: () => void fake.back++,
      };
      function Bridge(this: { onservicecallback: ((m: string) => void) | null }) {
        this.onservicecallback = null;
      }
      Bridge.prototype.call = function (this: { onservicecallback: ((m: string) => void) | null }, uri: string, params: string) {
        const p = JSON.parse(params) as Record<string, unknown>;
        fake.luna.push({ uri, params: p });
        const reply = (m: unknown): void => this.onservicecallback?.(JSON.stringify(m));
        if (uri.endsWith('/getConfigs')) {
          setTimeout(() => reply({ returnValue: true, configs: { 'tv.hw.panelResolution': 'UD', 'tv.model.supportHDR': true, 'tv.config.supportDolbyHDRContents': false } }));
        } else if (uri.endsWith('/registerScreenSaverRequest')) {
          fake.screenSaver = reply;
          setTimeout(() => reply({ returnValue: true, subscribed: true }));
        } else setTimeout(() => reply({ returnValue: true }));
      };
      Bridge.prototype.cancel = () => undefined;
      w.PalmServiceBridge = Bridge;
      if (withShell) {
        w.TallyShell = {
          shellVersion: 1,
          platform: 'webos',
          serverUrl: server,
          bundleBase: base,
          devModeToken: token,
          changeServer: () => undefined,
          reload: () => location.reload(),
          exit: () => {
            const s = w.webOSSystem as { platformBack(): void };
            s.platformBack();
          },
          started: () => undefined,
        };
      }
    },
    { token: TOKEN, server: SERVER, base: `http://127.0.0.1:${PORT}/`, withShell: shell },
  );
}

const fake = (page: Page): Promise<WebosFake> => page.evaluate(() => (window as unknown as { __webos: WebosFake }).__webos);

/** A key of LG's remote, as webOS delivers it (keyCode set; `key` as LG's browser names it). */
async function lgKey(page: Page, code: number, key = ''): Promise<void> {
  await page.evaluate(
    ([c, k]) => {
      for (const type of ['keydown', 'keyup']) {
        const e = new KeyboardEvent(type, { key: k as string, bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => c });
        window.dispatchEvent(e);
      }
    },
    [code, key] as const,
  );
}
const BACK = 461;

const debug = (page: Page, route: unknown) =>
  page.evaluate((r) => (window as unknown as { TallyDebug: { push: (r: unknown) => void } }).TallyDebug.push(r), route);

const videoTime = (page: Page): Promise<number> => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);

interface Item {
  Id: string;
  Name: string;
  MediaSources?: Array<{ Container?: string; MediaStreams: Array<{ Type: string; Language?: string }> }>;
}

async function twoTrackFilm(): Promise<Item | undefined> {
  const me = await api<{ Id: string }>('/Users/Me');
  const films = await api<{ Items: Item[] }>(`/Items?userId=${me.Id}&recursive=true&includeItemTypes=Movie&fields=MediaSources&limit=200`);
  return films.Items.find((f) => (f.MediaSources?.[0]?.MediaStreams ?? []).filter((s) => s.Type === 'Audio').length >= 2);
}

test('webOS: the platform, LG remote keys, the device profile for a UHD webOS 5 set, the Developer Mode hand-off', async ({ page }, info) => {
  await asWebos(page, true);
  const handoff: Array<{ body: unknown; auth: string }> = [];
  await page.route('**/JellyTV/Client/v1/lg/devmode', async (route) => {
    handoff.push({ body: route.request().postDataJSON() as unknown, auth: route.request().headers().authorization ?? '' });
    await route.fulfill({ status: 204 });
  });
  const profiles: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.url().includes('/PlaybackInfo') && r.method() === 'POST') profiles.push((r.postDataJSON() as { DeviceProfile: Record<string, unknown> }).DeviceProfile);
  });
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  // the session exists: the TV hands its Developer Mode token to the plugin, with the session's authorization
  await expect.poll(() => handoff.length).toBe(1);
  expect(handoff[0]?.body).toEqual({ token: TOKEN, model: 'OLED55CX9LA' });
  expect(handoff[0]?.auth).toContain('Token=');
  expect(handoff[0]?.auth).toContain('OLED55CX9LA');
  // the panel was asked for (UHD, HDR) through the TV's config service
  expect((await fake(page)).luna.map((c) => c.uri)).toContain('luna://com.webos.service.config/getConfigs');
  await shot(page, info, 'webos-home');

  // Settings names the platform; BACK (461) returns to Home, as on the TV
  await debug(page, { name: 'settings' });
  await expect(page.locator('.page:not(.hidden) .settings-page')).toContainText('webos');
  await lgKey(page, BACK, 'GoBack');
  await expect(page.locator('.page:not(.hidden) .home')).toBeVisible();
  // Escape is not the TV's BACK: nothing happens
  await debug(page, { name: 'settings' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.page:not(.hidden) .settings-page')).toBeVisible();
  await lgKey(page, BACK);
  await expect(page.locator('.page:not(.hidden) .home')).toBeVisible();

  // BACK on Home opens the drawer; BACK in the open drawer leaves through LG's platformBack (once Home has its
  // focus back: a person's next press comes long after the page change)
  await expect(page.locator('.page:not(.hidden) .home [data-focused]')).toBeVisible();
  await page.waitForTimeout(400);
  await lgKey(page, BACK);
  await expect(page.locator('.rail.open')).toBeVisible();
  await lgKey(page, BACK);
  await expect.poll(async () => (await fake(page)).back).toBe(1);

  // the device profile a film is asked with: LG's per-container tables for a UHD webOS 5 set
  const film = await twoTrackFilm();
  test.skip(film === undefined, 'no film with two audio tracks on this server');
  if (film === undefined) return;
  await debug(page, { name: 'player', itemId: film.Id, startMs: 0 });
  await expect.poll(() => profiles.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const profile = profiles[0] as { Name: string; DirectPlayProfiles: Array<{ Container: string; VideoCodec?: string; AudioCodec?: string }> };
  expect(profile.Name).toBe('Tally TV (webos)');
  const mkv = profile.DirectPlayProfiles.find((d) => d.Container === 'mkv');
  expect(mkv?.VideoCodec).toContain('av1');
  expect(mkv?.AudioCodec).not.toContain('dts');
  expect(profile.DirectPlayProfiles.find((d) => d.Container.includes('mp4'))?.VideoCodec).toBe('h264,hevc,mpeg4,av1');
  await lgKey(page, 413); // STOP
});

test('webOS: a film plays straight from the file on the <video> engine, audio switches in place, hide/show resumes, no screensaver', async ({ page }, info) => {
  test.setTimeout(180_000);
  const film = await twoTrackFilm();
  test.skip(film === undefined, 'no film with two audio tracks on this server');
  if (film === undefined) return;
  await asWebos(page, false);
  const me = await api<{ Id: string }>('/Users/Me');
  const before = await userData(me.Id, film.Id);
  const tracksBefore = await trackDefaults(me.Id, film.Id);
  try {
    await filmOnWebos(page, info, film);
  } finally {
    await page.close();
    await restoreTracks(film.Id, tracksBefore);
    await restoreUserData(me.Id, film.Id, before);
  }
});

async function filmOnWebos(page: Page, info: import('@playwright/test').TestInfo, film: Item): Promise<void> {
  const playbackInfo: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/PlaybackInfo')) playbackInfo.push(r.url());
  });
  await page.goto(APP);
  await expect(page.locator('.home')).toBeVisible();
  await debug(page, { name: 'player', itemId: film.Id, startMs: 0 });
  await expect.poll(() => videoTime(page), { timeout: 45_000 }).toBeGreaterThan(1.5);
  // direct play: the file itself (MKV, H.264 + AAC), not a stream the server made
  const src = await page.evaluate(() => document.querySelector('video')?.getAttribute('src') ?? '');
  expect(src).toContain(`/Videos/${film.Id}/stream`);
  expect(src.toLowerCase()).toContain('static=true');
  expect(await page.evaluate(() => !!(document.querySelector('video') as unknown as { audioTracks?: unknown }).audioTracks)).toBe(true);
  expect(await page.evaluate(() => (document.querySelector('video') as unknown as { audioTracks: { length: number } }).audioTracks.length)).toBe(2);
  await shot(page, info, 'webos-film');

  // the screensaver is held off while the film plays: the TV's request is answered with ack false
  await expect.poll(async () => (await fake(page)).luna.some((c) => c.uri.endsWith('/registerScreenSaverRequest'))).toBe(true);
  await page.evaluate(() => (window as unknown as { __webos: WebosFake }).__webos.screenSaver?.({ returnValue: true, timestamp: '1790370000', state: 'Active' }));
  await expect
    .poll(async () => (await fake(page)).luna.filter((c) => c.uri.endsWith('/responseScreenSaverRequest')).map((c) => c.params.ack))
    .toEqual([false]);

  // audio: the Spanish track, switched in the element (no new PlaybackInfo, the same file keeps playing)
  const asked = playbackInfo.length;
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.pc-row')).toBeVisible();
  const caption = () => page.evaluate(() => document.querySelector('.pc-btn[data-focused] + .pc-cap')?.textContent ?? '');
  for (let i = 0; i < 12 && (await caption()) !== 'AUDIO'; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 12 && (await caption()) !== 'AUDIO'; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pc-sidepanel .kicker')).toHaveText('AUDIO');
  const row = page.locator('.pc-prow[data-focused] .label');
  for (let i = 0; i < 10 && !/Español/.test((await row.textContent()) ?? ''); i++) await page.keyboard.press('ArrowDown');
  await shot(page, info, 'webos-audio-panel');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => Array.from((document.querySelector('video') as unknown as { audioTracks: ArrayLike<{ enabled: boolean }> }).audioTracks).map((t) => t.enabled)))
    .toEqual([false, true]);
  expect(playbackInfo.length).toBe(asked);
  expect(await page.evaluate(() => document.querySelector('video')?.getAttribute('src') ?? '')).toBe(src);

  // the Home button (the page hidden): the decoder goes back to the TV; shown again, the film goes on where it was
  const at = await videoTime(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => document.querySelector('video')?.getAttribute('src'))).toBeNull();
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => videoTime(page), { timeout: 20_000 }).toBeGreaterThan(at + 0.5);
  expect(await videoTime(page)).toBeLessThan(at + 15);
  // the chosen track survives the reopen
  await expect
    .poll(() => page.evaluate(() => Array.from((document.querySelector('video') as unknown as { audioTracks: ArrayLike<{ enabled: boolean }> }).audioTracks).map((t) => t.enabled)))
    .toEqual([false, true]);

  // PAUSE (19) and PLAY (415) from the remote
  await lgKey(page, 19);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.paused)).toBe(true);
  await lgKey(page, 415);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.paused)).toBe(false);

  // leaving the player lets the screensaver come again
  await lgKey(page, 413); // STOP
  await expect(page.locator('.page:not(.hidden) .home')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __webos: WebosFake }).__webos.screenSaver?.({ returnValue: true, timestamp: '1790370300', state: 'Active' }));
  await expect
    .poll(async () => (await fake(page)).luna.filter((c) => c.uri.endsWith('/responseScreenSaverRequest')).map((c) => c.params.ack))
    .toEqual([false, true]);
}

test('webOS: the Magic Remote pointer: hover focuses, click is OK, the wheel steps rows, cursorStateChange and arrows', async ({ page }, info) => {
  await asWebos(page, false);
  await page.goto(APP);
  await expect(page.locator('.home')).toBeVisible();
  await page.waitForTimeout(1500);
  const home = page.locator('.page:not(.hidden) .home');
  const games = home.locator('.game-card');
  const cards = home.locator('.media-row .card');
  test.skip((await games.count()) < 2 || (await cards.count()) < 1, 'Home needs two games and a library row');
  const center = async (l: import('@playwright/test').Locator): Promise<{ x: number; y: number }> => {
    const b = await l.boundingBox();
    if (b === null) throw new Error('not on screen');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // the pointer over the second game: it takes the focus frame
  const game = games.nth(1);
  let at = await center(game);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await expect(game).toHaveAttribute('data-focused', /.*/);
  await expect(page.locator('html')).toHaveClass(/pointer-mode/);
  await shot(page, info, 'webos-pointer-hover');

  // the TV hides the pointer (an arrow key, 5-way mode): the frame stays where the pointer left it
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('cursorStateChange', { detail: { visibility: false } })));
  await expect(page.locator('html')).not.toHaveClass(/pointer-mode/);
  await expect(game).toHaveAttribute('data-focused', /.*/);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('cursorStateChange', { detail: { visibility: true } })));
  await expect(page.locator('html')).toHaveClass(/pointer-mode/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('html')).not.toHaveClass(/pointer-mode/);
  await expect(games.nth(0)).toHaveAttribute('data-focused', /.*/);

  // the wheel: one notch down reaches the library row, one up comes back to the games
  await page.mouse.wheel(0, 120);
  await expect.poll(() => home.locator('.media-row .card[data-focused]').count()).toBe(1);
  await page.waitForTimeout(250);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => home.locator('.game-card[data-focused]').count()).toBe(1);

  // a click on a library card is OK on it: its page opens
  const card = cards.nth(0);
  await card.scrollIntoViewIfNeeded();
  at = await center(card);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await expect(card).toHaveAttribute('data-focused', /.*/);
  const stack = () => page.evaluate(() => (window as unknown as { TallyDebug: { stack: { get(): unknown[] } } }).TallyDebug.stack.get().length);
  const depth = await stack();
  await page.mouse.click(at.x, at.y);
  await expect.poll(stack).toBe(depth + 1);
  await page.waitForTimeout(800);
  await shot(page, info, 'webos-pointer-click');
  await lgKey(page, BACK);
  await expect(page.locator('.page:not(.hidden) .home')).toBeVisible();
  // webOS sends OK's key too on some models: a click right after the key is the same press (one page, not two)
  at = await center(card);
  await page.mouse.move(at.x + 2, at.y, { steps: 2 });
  await lgKey(page, 13, 'Enter');
  await page.mouse.click(at.x + 2, at.y);
  await page.waitForTimeout(600);
  expect(await stack()).toBe(depth + 1);
  await lgKey(page, BACK);
});

test('webOS: multiview plays one tile (one decoder on LG), the others show live cards', async ({ page }, info) => {
  test.setTimeout(150_000);
  const board = await api<{ channels: Array<{ id: string }> }>('/JellyTV/Client/v1/board');
  test.skip(board.channels.length < 2, 'needs two channels');
  await asWebos(page, false);
  await page.goto(APP);
  await expect(page.locator('.home')).toBeVisible();
  await debug(page, { name: 'sports' });
  await expect(page.locator('.page:not(.hidden) .sports-page')).toBeVisible();
  await expect(page.locator('.game-card[data-focused]')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel-card[data-focused]')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.keyboard.down('Enter');
    await page.waitForTimeout(700);
    await page.keyboard.up('Enter');
    await expect(page.locator('.page:not(.hidden) .toast')).toHaveText('Added to multiview');
    await page.keyboard.press('ArrowRight');
  }
  await debug(page, { name: 'multiview' });
  await expect(page.locator('.multiview-page .mv-tile')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('.mv-tile video')).filter((v) => (v as HTMLVideoElement).currentTime > 1).length), { timeout: 60_000 }).toBe(1);
  // never a second <video> at once (LG: one media element plays at a time; a second blacks out the first)
  expect(await page.evaluate(() => document.querySelectorAll('.mv-tile video').length)).toBe(1);
  await expect(page.locator('.mv-tile .card-still')).toHaveCount(1);
  await shot(page, info, 'webos-multiview');
  // focus moves: the picture moves with it
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => document.querySelector('.mv-tile[data-focused] video') !== null), { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('.mv-tile video').length)).toBe(1);
  await lgKey(page, BACK);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.mv-tile video').length)).toBe(0);
});

test('webOS: the installed shell loads the bundle from the server, relaunch brings it forward, BACK leaves through platformBack', async ({ page }, info) => {
  await asWebos(page, false);
  // the shell as Tally for LG installs it (tv-web/shell with the config.js it stamps), under /lg-shell/ on this
  // checkout's preview, which also stands in for the plugin's /JellyTV/TV/ (the bundle); signed in already
  const files: Record<string, { body: Buffer | string; type: string }> = {
    'index.html': { body: readFileSync('shell/index.html', 'utf8').replace(/<!-- PLATFORM:.*-->/, ''), type: 'text/html' },
    'shell.js': { body: readFileSync('shell/shell.js'), type: 'application/javascript' },
    'shell.css': { body: readFileSync('shell/shell.css'), type: 'text/css' },
    'fonts/plex-sans.woff2': { body: readFileSync('shell/fonts/plex-sans.woff2'), type: 'font/woff2' },
    'fonts/plex-mono-500.woff2': { body: readFileSync('shell/fonts/plex-mono-500.woff2'), type: 'font/woff2' },
    'config.js': {
      body: 'window.TALLY_SHELL_CONFIG = ' + JSON.stringify({ platform: 'webos', server: SERVER, bundle: `http://127.0.0.1:${PORT}/`, devModeToken: TOKEN }, null, 2) + ';\n',
      type: 'application/javascript',
    },
  };
  await page.route(`http://127.0.0.1:${PORT}/lg-shell/**`, async (route) => {
    const f = files[new URL(route.request().url()).pathname.slice('/lg-shell/'.length)];
    await (f === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: f.body, contentType: f.type }));
  });
  await page.route('**/JellyTV/Client/v1/lg/devmode', (route) => route.fulfill({ status: 204 }));
  await page.goto(`http://127.0.0.1:${PORT}/lg-shell/index.html`);
  // the shell found the server, loaded the bundle, and handed over: Home
  await expect(page.locator('.home')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#shell')).toHaveClass(/gone/);
  const shellSays = await page.evaluate(() => {
    const s = (window as unknown as { TallyShell: { platform: string; devModeToken: string; shellVersion: number } }).TallyShell;
    return [s.platform, s.devModeToken, s.shellVersion];
  });
  expect(shellSays).toEqual(['webos', TOKEN, 1]);
  await shot(page, info, 'webos-shell-home');
  // launching Tally from the launcher while it runs: webOSRelaunch, the shell brings it forward
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: {} })));
  await expect.poll(async () => (await fake(page)).activated).toBe(1);
  // BACK on Home opens the drawer, BACK in the drawer leaves through the shell's exit: LG's platformBack
  await expect(page.locator('.page:not(.hidden) .home [data-focused]')).toBeVisible();
  await page.waitForTimeout(400);
  await lgKey(page, BACK);
  await expect(page.locator('.rail.open')).toBeVisible();
  await lgKey(page, BACK);
  await expect.poll(async () => (await fake(page)).back).toBe(1);
});
