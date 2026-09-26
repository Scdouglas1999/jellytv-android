/**
 * The 2.2 gaps (tvweb-gaps): the collection and playlist pages, Remove from continue watching, the live player's
 * FROM THE START button and the score bug's show/fade rule, the league in Home's game header, the recording notice (plugin
 * contract 3) and the plugin art parameters (contracts 1 and 2). Against the dev server; server state is put back.
 */
import { expect, test, type Page } from '@playwright/test';
import { APP, AUTH_STATE, SERVER, adminToken, api, holdOk, shot, stopKey, videoTime } from './env';

test.use({ storageState: AUTH_STATE });

const ADMIN = { Authorization: `MediaBrowser Token="${adminToken()}"` };
const call = (method: string, path: string, body?: unknown) =>
  fetch(SERVER + path, { method, headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

interface Item {
  Id: string;
  Name: string;
  Type: string;
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number; PlayCount?: number; LastPlayedDate?: string | null };
}
interface BoardGame {
  id: string;
  state: string;
  league: string;
  sport: string;
  home: { shortName: string; abbr: string };
  away: { shortName: string; abbr: string };
  watch?: { channelId: string; hlsPath: string; channelName: string } | null;
  recording?: unknown;
}

const debugPush = (page: Page, route: unknown) => page.evaluate((r) => (window as unknown as { TallyDebug: { push: (r: unknown) => void } }).TallyDebug.push(r), route);
const visible = (page: Page, css: string) => page.locator(`.page:not(.hidden) ${css}`);

async function home(page: Page): Promise<void> {
  await page.goto(APP);
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.home [data-focused]')).toHaveCount(1, { timeout: 30_000 });
}

/** Opens a library from the drawer by its label. */
async function openLibrary(page: Page, label: string): Promise<void> {
  await home(page);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.rail.open')).toBeVisible();
  for (let i = 0; i < 14; i++) {
    if (((await page.locator('.rail .spot[data-focused] .label').textContent()) ?? '') === label) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.locator('.rail .spot[data-focused] .label')).toHaveText(label);
  await page.keyboard.press('Enter');
  await expect(visible(page, '.lib')).toBeVisible();
  await expect(visible(page, '.lib .card[data-focused]')).toBeVisible({ timeout: 30_000 });
}

async function userId(): Promise<string> {
  const users = await api<Array<{ Name: string; Id: string }>>('/Users');
  return users.find((u) => u.Name === 'admin')?.Id ?? '';
}

test('Collection: a box set opens its page (header, actions, a row per type); HOLD OK the item menu; SORT; BACK', async ({ page }, info) => {
  await openLibrary(page, 'Collections');
  const card = visible(page, '.lib .card[data-focused]');
  const name = (await card.locator('.title').textContent()) ?? '';
  await page.keyboard.press('Enter');
  const col = visible(page, '.collection-page');
  await expect(col.locator('.dh-kicker')).toHaveText('COLLECTION');
  await expect(col.locator('.dh-title')).toHaveText(name);
  // PLAY has focus; the meta line counts the films, spans their years, the rating box, the running time
  await expect(col.locator('.btn.primary[data-focused] span:not(.glyph)')).toHaveText('PLAY');
  await expect(col.locator('.dh-meta')).toHaveText(/^\d+ FILMS?·\d{4}(–\d{4})?·.*·\d+[hms]/);
  expect(await col.locator('.pages-strip .btn span:not(.glyph):not(.btn-trailing), .pages-strip .lib-control .label').allTextContents()).toEqual([
    'PLAY', 'SHUFFLE', expect.stringMatching(/^(UN)?WATCHED$/), expect.stringMatching(/^FAVORITED?$/), 'VIEW', 'MORE', 'SORT · DEFAULT', 'FILTER',
  ]);
  await expect(col.locator('.media-row .row-header .title')).toHaveText(['MOVIES']);
  // the rail keeps its light on the library it came from
  await expect(page.locator('.rail .entry.selected .label')).toHaveText('Collections');
  await page.waitForTimeout(400);
  await shot(page, info, 'gaps-collection');

  // DOWN: the first film; its backdrop comes once focus rests
  await page.keyboard.press('ArrowDown');
  const film = col.locator('.media-row .card[data-focused]');
  await expect(film).toBeVisible();
  const filmTitle = (await film.locator('.title').textContent()) ?? '';
  await expect(col.locator('.detail-backdrop img')).toBeVisible({ timeout: 5000 });
  await shot(page, info, 'gaps-collection-row');
  // HOLD OK: the film's item menu, Go to first; BACK returns to the card
  await holdOk(page);
  await expect(page.locator('.panel-window')).toBeVisible();
  await expect(page.locator('.panel-row[data-focused] .headline')).toHaveText('Go to');
  await page.waitForTimeout(300);
  await shot(page, info, 'gaps-collection-menu');
  await page.keyboard.press('Escape');
  await expect(page.locator('.panel-window')).toHaveCount(0);
  await expect(film.locator('.title')).toHaveText(filmTitle);
  // OK opens the film
  await page.keyboard.press('Enter');
  await expect(visible(page, '.detail-page .dh-kicker')).toHaveText('FILM');
  await page.keyboard.press('Escape');
  await expect(film.locator('.title')).toHaveText(filmTitle);

  // UP to the actions, RIGHT to SORT (the strip scrolls), OK: the sort panel on DEFAULT
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 9 && !((await col.locator('.lib-control[data-focused]').count()) > 0); i++) await page.keyboard.press('ArrowRight');
  await expect(col.locator('.lib-control[data-focused] .label')).toHaveText('SORT · DEFAULT');
  await shot(page, info, 'gaps-collection-strip');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib-panel-row[data-focused] .label')).toHaveText('Default');
  await page.keyboard.press('Escape');
  await expect(col.locator('.lib-control[data-focused] .label')).toHaveText('SORT · DEFAULT');

  // VIEW: "Separate types" off shows upstream's mixed grid; on again, the rows
  const focusedButton = col.locator('.btn[data-focused] span:not(.glyph)');
  for (let i = 0; i < 4 && ((await focusedButton.count()) === 0 || (await focusedButton.textContent()) !== 'VIEW'); i++) await page.keyboard.press('ArrowLeft');
  await expect(focusedButton).toHaveText('VIEW');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib-panel-row[data-focused] .label')).toHaveText('Separate types');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('ON');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('OFF');
  await page.keyboard.press('Escape');
  await expect(col.locator('.pages-grid .card')).toHaveCount(3);
  await expect(col.locator('.media-row')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(col.locator('.pages-grid .card[data-focused]')).toBeVisible();
  await shot(page, info, 'gaps-collection-grid');
  // UP: back to the strip on VIEW (the control focused last), and the rows again
  await page.keyboard.press('ArrowUp');
  await expect(focusedButton).toHaveText('VIEW');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('OFF');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('ON');
  await page.keyboard.press('Escape');
  await expect(col.locator('.media-row .row-header .title')).toHaveText(['MOVIES']);

  // BACK: the library, on the same card
  await page.keyboard.press('Escape');
  await expect(card.locator('.title')).toHaveText(name);
});

test('Playlist: header, numbered rows, move down, HOLD OK with Remove from playlist, PLAY from a row', async ({ page }, info) => {
  await page.route('**/Sessions/Playing**', (route) => route.fulfill({ status: 204 }));
  const uid = await userId();
  // the Android reference's playlist: Toy Story, Breaking Bad's Pilot, Big Buck Bunny, Inception
  const films = await api<{ Items: Item[] }>(`/Items?userId=${uid}&recursive=true&includeItemTypes=Movie`);
  const byName = (n: string): string => films.Items.find((i) => i.Name === n)?.Id ?? '';
  const pilots = await api<{ Items: Array<Item & { SeriesName?: string }> }>(`/Items?userId=${uid}&recursive=true&includeItemTypes=Episode&searchTerm=Pilot&fields=SeriesName`);
  const pilot = pilots.Items.find((i) => i.SeriesName === 'Breaking Bad')?.Id ?? '';
  const ids = [byName('Toy Story'), pilot, byName('Big Buck Bunny'), byName('Inception')];
  const created = (await (await call('POST', '/Playlists', { Name: 'Movie night', Ids: ids, UserId: uid, MediaType: 'Video' })).json()) as { Id: string };
  const order = async (): Promise<string[]> => (await api<{ Items: Item[] }>(`/Items?userId=${uid}&parentId=${created.Id}`)).Items.map((i) => i.Name);
  try {
    await openLibrary(page, 'Playlists');
    const target = visible(page, '.lib .card').filter({ hasText: 'Movie night' });
    for (let i = 0; i < 8 && ((await visible(page, '.lib .card[data-focused] .title').textContent()) ?? '') !== 'Movie night'; i++) await page.keyboard.press('ArrowRight');
    await expect(target).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Enter');
    const pl = visible(page, '.playlist-page');
    await expect(pl.locator('.pl-kicker')).toHaveText('PLAYLIST');
    await expect(pl.locator('.pl-title')).toHaveText('Movie night');
    await expect(pl.locator('.pl-meta')).toHaveText('4 ITEMS · 5m');
    await expect(pl.locator('.pl-row')).toHaveCount(4);
    await expect(pl.locator('.pl-number')).toHaveText(['01', '02', '03', '04']);
    await expect(pl.locator('.pl-texts .meta')).toHaveText(['FILM · 1995 · 1m 30s', 'BREAKING BAD · S1 E1 · 1m', 'FILM · 2008 · 1m', 'FILM · 2010 · 1m 30s']);
    // as upstream: the list has focus (its first row); the admin owns it: move buttons, the first row's up disabled
    await expect(pl.locator('.pl-row').nth(0).locator('.pl-surface')).toHaveAttribute('data-focused', 'true');
    await expect(pl.locator('.pl-row').nth(0).locator('.pl-icon.disabled')).toHaveCount(1);
    await expect(pl.locator('.pl-row').nth(3).locator('.pl-icon.disabled')).toHaveCount(1);
    await expect(pl.locator('.detail-backdrop img')).toBeVisible({ timeout: 5000 });
    await shot(page, info, 'gaps-playlist');

    // RIGHT: move down (up is skipped); the move bar; OK moves Toy Story below Pilot (10.10's move corrected)
    await page.keyboard.press('ArrowRight');
    await expect(pl.locator('.pl-icon[data-focused]')).toHaveCount(1);
    await expect(pl.locator('.pl-caption')).toHaveText('MOVE DOWN');
    await expect(pl.locator('.pl-row.moving')).toHaveCount(1);
    await shot(page, info, 'gaps-playlist-move');
    await page.keyboard.press('Enter');
    await expect(pl.locator('.pl-texts .title')).toHaveText(['Pilot', 'Toy Story', 'Big Buck Bunny', 'Inception']);
    await expect.poll(order, { timeout: 10_000 }).toEqual(['Pilot', 'Toy Story', 'Big Buck Bunny', 'Inception']);
    // focus followed it: the second row's move down
    await expect(pl.locator('.pl-row').nth(1).locator('.pl-icon[data-focused]')).toHaveCount(1);
    // and back up (to the top: two calls on 10.10)
    await page.keyboard.press('ArrowLeft');
    await expect(pl.locator('.pl-caption')).toHaveText('MOVE UP');
    await page.keyboard.press('Enter');
    await expect.poll(order, { timeout: 10_000 }).toEqual(['Toy Story', 'Pilot', 'Big Buck Bunny', 'Inception']);
    await expect(pl.locator('.pl-texts .title')).toHaveText(['Toy Story', 'Pilot', 'Big Buck Bunny', 'Inception']);

    // focus followed it to the top row (whose MOVE UP is off: its MOVE DOWN); LEFT to the row, DOWN twice
    await expect(pl.locator('.pl-row').nth(0).locator('.pl-icon[data-focused]')).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(pl.locator('.pl-row').nth(0).locator('.pl-surface')).toHaveAttribute('data-focused', 'true');
    // HOLD OK on the third row: its item menu with Remove from playlist
    for (let i = 0; i < 3 && (await pl.locator('.pl-row').nth(2).locator('.pl-surface[data-focused]').count()) === 0; i++) await page.keyboard.press('ArrowDown');
    await expect(pl.locator('.pl-row').nth(2).locator('.pl-surface')).toHaveAttribute('data-focused', 'true');
    await holdOk(page);
    const menu = page.locator('.panel-window');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.panel-kicker')).toHaveText('BIG BUCK BUNNY');
    const entries = await menu.locator('.panel-row .headline').allTextContents();
    expect(entries.slice(0, 4)).toEqual(['Go to', 'Play', 'Remove from playlist', 'Add to playlist']);
    await page.waitForTimeout(300);
    await shot(page, info, 'gaps-playlist-menu');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.panel-row[data-focused] .headline')).toHaveText('Remove from playlist');
    await page.keyboard.press('Enter');
    await expect(pl.locator('.pl-row')).toHaveCount(3);
    await expect.poll(order, { timeout: 10_000 }).toEqual(['Toy Story', 'Pilot', 'Inception']);
    await expect(pl.locator('.pl-meta')).toHaveText('3 ITEMS · 4m');
    // focus stays at that place: now Inception
    await expect(pl.locator('.pl-row').nth(2).locator('.pl-surface')).toHaveAttribute('data-focused', 'true');

    // PLAY on the second row: the playlist from there (Pilot, then Inception)
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('MediaPlayPause');
    await expect(page.locator('.player')).toBeVisible();
    await expect.poll(() => videoTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.player .pc-top')).toContainText('Pilot');
    await stopKey(page);
    await expect(pl).toBeVisible();
  } finally {
    await call('DELETE', `/Items/${created.Id}`);
  }
});

test('Home: Remove from continue watching clears the resume point; the row updates at once', async ({ page }, info) => {
  const uid = await userId();
  const films = await api<{ Items: Item[] }>(`/Items?userId=${uid}&recursive=true&includeItemTypes=Movie&fields=UserData`);
  const film = films.Items.find((i) => i.Name === 'Inception') as Item;
  const before = film.UserData ?? {};
  // a resume point 30 s in (Continue watching lists unwatched items with one)
  const set = (data: unknown) => call('POST', `/UserItems/${film.Id}/UserData?userId=${uid}`, data);
  expect((await set({ Played: false, PlaybackPositionTicks: 300_000_000 })).ok).toBe(true);
  try {
    await home(page);
    // down to the Continue watching row
    const header = page.locator('.home-header .kicker');
    for (let i = 0; i < 6 && ((await header.textContent()) ?? '') !== 'CONTINUE WATCHING'; i++) await page.keyboard.press('ArrowDown');
    await expect(header).toHaveText('CONTINUE WATCHING');
    const row = page.locator('.home .media-row').filter({ has: page.locator('.row-header .title', { hasText: /^CONTINUE WATCHING$/ }) });
    for (let i = 0; i < 16 && ((await page.locator('.home .card[data-focused] .bar .title').textContent()) ?? '') !== 'Inception'; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.home .card[data-focused] .bar .title')).toHaveText('Inception');
    const count = await row.locator('.card').count();
    await holdOk(page);
    const panel = page.locator('.panel-window');
    await expect(panel).toBeVisible();
    const entries = await panel.locator('.panel-row .headline').allTextContents();
    expect(entries.slice(0, 5)).toEqual(['Go to', 'Resume', 'Play from start', 'Add to playlist', 'Remove from continue watching']);
    await page.waitForTimeout(300);
    await shot(page, info, 'gaps-home-cw-menu');
    for (let i = 0; i < 6 && ((await page.locator('.panel-row[data-focused] .headline').textContent()) ?? '') !== 'Remove from continue watching'; i++) await page.keyboard.press('ArrowDown');
    const request = page.waitForRequest((r) => r.url().includes(`/UserPlayedItems/${film.Id}`) && r.method() === 'DELETE');
    await page.keyboard.press('Enter');
    await request;
    // the card leaves the row at once (the row goes when it was the only card), focus stays on Home
    if (count > 1) await expect(row.locator('.card')).toHaveCount(count - 1);
    else await expect(row).toHaveCount(0);
    await expect(page.locator('.home [data-focused]')).toHaveCount(1);
    await expect(page.locator('.home .card[data-focused] .bar .title, .home .game-card[data-focused]')).toHaveCount(1);
    await expect.poll(async () => (await api<Item>(`/Users/${uid}/Items/${film.Id}`)).UserData?.PlaybackPositionTicks ?? -1).toBe(0);
    await page.waitForTimeout(300);
    await shot(page, info, 'gaps-home-cw-removed');
  } finally {
    await set({ Played: before.Played ?? false, PlaybackPositionTicks: before.PlaybackPositionTicks ?? 0, PlayCount: before.PlayCount ?? 0, LastPlayedDate: before.LastPlayedDate ?? null });
  }
});

test("Home: a game's header names its league (MLB · TOP 1ST), as Android's TallyGameHeader", async ({ page }, info) => {
  const board = await api<{ games: BoardGame[] }>('/JellyTV/Client/v1/board');
  test.skip(board.games.length === 0, 'no games on the board');
  await home(page);
  const card = page.locator('.home .game-card[data-focused]');
  test.skip((await card.count()) === 0, 'no game card on Home');
  const id = (await card.getAttribute('data-game')) ?? '';
  const game = board.games.find((g) => g.id === id) as BoardGame;
  const kicker = (await page.locator('.home-header .kicker').textContent()) ?? '';
  expect(kicker.startsWith(game.league.toUpperCase() + ' · ')).toBe(true);
  expect(kicker.startsWith(game.sport.toUpperCase())).toBe(false);
  await shot(page, info, 'gaps-home-game-header');
});

/** Runs the score simulator (tally/dev/score-sim.py in its container), when the run has it (TALLY_SIM=1). */
async function sim(args: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  execSync(`docker exec tally-score-sim python /sim.py ${args}`, { stdio: 'ignore' });
}

/** A live game on a channel, and the board with that game recording (the dev server cannot record: too little space). */
async function liveGame(): Promise<BoardGame | null> {
  const board = await api<{ games: BoardGame[] }>('/JellyTV/Client/v1/board');
  return board.games.find((g) => g.state === 'in' && g.watch != null && g.watch.hlsPath !== '') ?? null;
}

test("Live: the score bug follows Android's rule (open, score change, key; 8 s; not under the box score), over the controls; FROM THE START in the bar", async ({ page }, info) => {
  const game = await liveGame();
  test.skip(game === null, 'needs a live game on a channel (a real one, or tally/dev/score-sim.py)');
  if (game === null || game.watch == null) return;
  const watch = game.watch;
  // the board as the plugin sends it while this game records (DvrController's board recording: state, job, start over)
  await page.route('**/JellyTV/Client/v1/board**', async (route) => {
    try {
      const response = await route.fetch();
      const json = (await response.json()) as { games: BoardGame[] };
      for (const g of json.games) if (g.id === game.id) g.recording = { state: 'recording', jobId: 'e2e', startOverPath: watch.hlsPath, itemId: null };
      await route.fulfill({ response, json });
    } catch {
      // the page went away while the poll was in flight
    }
  });
  await home(page);
  await debugPush(page, { name: 'live', channelId: watch.channelId, hlsPath: watch.hlsPath, title: `${game.away.shortName} at ${game.home.shortName}`, gameId: game.id });
  await expect.poll(() => videoTime(page), { timeout: 45_000 }).toBeGreaterThan(1);
  const bug = page.locator('.player.live .score-bug');
  await expect(bug).toBeVisible();
  // a key brings the bar: FROM THE START at its end, with focus; the bug draws over the bar's scrim
  const button = page.locator('.live-bar .start-over .btn');
  await page.keyboard.press('ArrowLeft');
  await expect(button.locator('span:not(.glyph)')).toHaveText('FROM THE START');
  await expect(button).toHaveAttribute('data-focused', 'true');
  const onTop = await bug.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(onTop).toBe(true);
  await page.waitForTimeout(500);
  await shot(page, info, 'gaps-live-bar-start-over');
  // Android's rule (TallyPlaybackPage.kt): no key for longer than BUG_LINGER_MS (8 s): the bug fades out, the bar is gone
  const faded = async (): Promise<boolean> => (await bug.getAttribute('class'))?.indexOf('faded') !== -1;
  await expect.poll(faded, { timeout: 12_000 }).toBe(true);
  await expect(page.locator('.live-bar')).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(await bug.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await shot(page, info, 'gaps-live-bug-faded');
  // a key brings it back (and the bar); 8 s after the last key it fades again
  await page.keyboard.press('ArrowLeft');
  await expect(bug).not.toHaveClass(/faded/);
  const keyAt = Date.now();
  await expect.poll(faded, { timeout: 12_000 }).toBe(true);
  const lingered = Date.now() - keyAt;
  expect(lingered).toBeGreaterThan(7_500);
  expect(lingered).toBeLessThan(10_500);
  if (process.env.TALLY_SIM === '1') {
    // a run in this game with the controls hidden: the bug comes back by itself, the score rolls, and fades 8 s later
    await expect(page.locator('.live-bar')).toHaveCount(0);
    const before = (await bug.locator('.line1').textContent()) ?? '';
    await sim(`bump ${game.away.abbr}`);
    await expect.poll(faded, { timeout: 60_000 }).toBe(false);
    const shownAt = Date.now();
    await expect(page.locator('.live-bar')).toHaveCount(0);
    await expect(bug.locator('.line1')).not.toHaveText(before);
    await page.waitForTimeout(900); // past the fade-in and the digit roll
    await shot(page, info, 'gaps-live-bug-score-change');
    await expect.poll(faded, { timeout: 12_000 }).toBe(true);
    expect(Date.now() - shownAt).toBeGreaterThan(7_000);
  }
  await page.keyboard.press('ArrowLeft');
  await expect(bug).not.toHaveClass(/faded/);
  // UP: the box score covers the bug; the next key closes it and the bug is back
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.box-score')).toBeVisible();
  await expect(bug).toHaveClass(/faded/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.box-score')).toHaveCount(0);
  await expect(bug).not.toHaveClass(/faded/);
  // OK brings the bar (focus on the button), OK again watches from the start
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(visible(page, '.startover')).toBeVisible();
  await expect(page.locator('.startover .so-top .kicker')).toHaveText('REC · FROM THE START');
  await expect.poll(() => page.evaluate(() => (document.querySelector('.startover video') as HTMLVideoElement | null)?.currentTime ?? 0), { timeout: 45_000 }).toBeGreaterThan(0.5);
  await shot(page, info, 'gaps-live-start-over');
  // REWIND still does it from the live player
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(visible(page, '.home')).toBeVisible();
  await debugPush(page, { name: 'live', channelId: watch.channelId, hlsPath: watch.hlsPath, title: `${game.away.shortName} at ${game.home.shortName}`, gameId: game.id });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaRewind', bubbles: true })));
  await expect(visible(page, '.startover')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Recordings: a recording that is not in a library yet says why (contract 3), in the Tally panel', async ({ page }, info) => {
  const info0 = await api<{ features: string[] }>('/JellyTV/Client/v1/info');
  test.skip(info0.features.indexOf('dvr') < 0, 'the server does not record');
  // the recordings list as the plugin sends it (RecordingsController), with two finished recordings that have no
  // library item: one whose server has no library for recordings, one from an older plugin (no libraryState)
  const job = (id: string, extra: Record<string, unknown>) => ({
    id, ruleId: 'r', state: 'done', title: 'Riverton Otters at Lakeside Herons', createdAt: '2026-09-24T17:40:30Z', startedAt: '2026-09-24T17:40:31Z', endedAt: '2026-09-24T20:40:31Z',
    seconds: 10800, fileBytes: 5_000_000_000, itemId: null,
    game: { id: '900001' + id, league: 'MLB', leaguePath: 'baseball/mlb', start: '2026-09-24T14:49:00+00:00', away: { id: '900446', abbr: 'ROT', name: 'Riverton Otters', shortName: 'Otters' }, home: { id: '900447', abbr: 'LKH', name: 'Lakeside Herons', shortName: 'Herons' } },
    ...extra,
  });
  await page.route('**/JellyTV/Client/v1/recordings', (route) =>
    route.fulfill({ json: { canManage: true, rules: [], jobs: [job('a', { libraryState: 'noLibrary' }), job('b', {})] } }),
  );
  await home(page);
  await debugPush(page, { name: 'sports' });
  await expect(visible(page, '.sports-page')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 6 && ((await page.locator('.sports-tab[data-focused] .label').textContent()) ?? '') !== 'RECORDINGS'; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.sports-tab[data-focused] .label')).toHaveText('RECORDINGS');
  await page.keyboard.press('Enter');
  const card = visible(page, '.recordings-tab .card[data-focused]');
  await expect(card).toBeVisible();
  await page.keyboard.press('Enter');
  const panel = page.locator('.panel-window');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.panel-kicker')).toHaveText('OTTERS AT HERONS');
  await expect(panel.locator('.panel-body')).toHaveText('This server has no library for recordings yet. Its owner can add one under Settings → Recordings.');
  await page.waitForTimeout(300);
  await shot(page, info, 'gaps-recording-no-library');
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(card).toBeVisible();
  // the older plugin's recording: still being added
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.panel-body')).toHaveText('Still being added to the library. Try again in a minute.');
  await shot(page, info, 'gaps-recording-adding');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('Plugin art: game backdrops and channel cards ask for their drawn width and the device zone', async ({ page }) => {
  const board = await api<{ games: Array<BoardGame & { backdropPath: string | null }>; channels: Array<{ cardPath: string }> }>('/JellyTV/Client/v1/board');
  test.skip(board.channels.length === 0, 'no channels');
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const cards = page.waitForRequest((r) => r.url().includes('/JellyTV/Card/'));
  // listening before Home opens: the backdrop can be asked for while Home is still settling (a busy machine)
  const backdrops = page.waitForRequest((r) => r.url().includes('/JellyTV/Backdrop/'), { timeout: 40_000 });
  backdrops.catch(() => undefined);
  await home(page);
  if ((await page.locator('.home .game-card[data-focused]').count()) > 0) {
    const backdrop = await backdrops;
    const u = new URL(backdrop.url());
    expect(u.searchParams.get('w')).toBe('1400');
    expect(u.searchParams.get('tz')).toBe(zone);
  }
  await debugPush(page, { name: 'sports' });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const u = new URL((await cards).url());
  expect(u.searchParams.get('w')).toBe('384');
  expect(u.searchParams.get('tz')).toBe(zone);
  expect(u.searchParams.get('v')).not.toBeNull(); // the card's own query is kept
});
