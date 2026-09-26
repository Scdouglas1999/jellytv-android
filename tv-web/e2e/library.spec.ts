import { expect, test, type Page } from '@playwright/test';
import { APP, AUTH_STATE, holdOk, shot, stopKey, videoTime } from './env';

test.use({ storageState: AUTH_STATE });

/** Opens a library from the rail: LEFT into the drawer, DOWN to the entry, OK. */
async function openFromRail(page: Page, label: string): Promise<void> {
  await page.goto(APP);
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('.home [data-focused]')).toHaveCount(1, { timeout: 30_000 });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.rail.open')).toBeVisible();
  for (let i = 0; i < 14; i++) {
    const current = (await page.locator('.rail .spot[data-focused] .label').textContent()) ?? '';
    if (current === label) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.locator('.rail .spot[data-focused] .label')).toHaveText(label);
  await page.keyboard.press('Enter');
  await expect(page.locator('.lib')).toBeVisible();
  // the page settles: its content is in and has focus (or the tab strip, when there is nothing)
  await expect(page.locator('.page:not(.hidden) .lib-loading')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.page:not(.hidden) .lib [data-focused]')).toHaveCount(1);
}

/** The focused element of the visible library page. */
const focused = (page: Page) => page.locator('.page:not(.hidden) .lib [data-focused]').first();
const lib = (page: Page) => page.locator('.page:not(.hidden) .lib');

async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

/** Waits until the pictures on screen have loaded (for the screenshots). */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll<HTMLImageElement>('.page:not(.hidden) .lib img')).every((i) => i.complete),
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(150);
}

/** Moves DOWN/UP in the open panel until the focused row's label matches, then OK. */
async function pick(page: Page, label: RegExp): Promise<void> {
  const row = page.locator('.lib-panel-row[data-focused] .label');
  await expect(row).toBeVisible();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 14; i++) {
    if (label.test((await row.textContent()) ?? '')) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error('no panel row matches ' + String(label));
}

test('Movies: Recommended, the Library grid, the A-Z bar, BACK to the top', async ({ page }, info) => {
  await openFromRail(page, 'Movies');
  await expect(page.locator('.lib-kicker .name')).toHaveText('MOVIES');
  await expect(page.locator('.lib-tab')).toHaveText(['RECOMMENDED', 'LIBRARY', 'COLLECTIONS', 'GENRES']);
  await expect(page.locator('.lib-tab.current')).toHaveText('RECOMMENDED');
  // Recommended: rows with counts, the header band describes the focused card
  await expect(page.locator('.lib-rec .media-row .row-header .title').first()).toBeVisible({ timeout: 30_000 });
  await expect(focused(page)).toHaveClass(/card/);
  await expect(page.locator('.lib-details .home-header .kicker')).not.toHaveText('');
  const rowTitles = await page.locator('.lib-rec .row-header .title').allTextContents();
  expect(rowTitles).toContain('RECENTLY ADDED');
  // a film already watched has no end time in the header (Android's homeMeta); one not watched yet has it
  const header = page.locator('.lib-details .home-header .meta');
  const tag = focused(page).locator('.tag');
  const seen = (await tag.count()) > 0 && (await tag.textContent()) === 'SEEN';
  if (seen) await expect(header).not.toContainText('ENDS');
  else await expect(header).toContainText('ENDS');
  await settle(page);
  await shot(page, info, 'library-recommended');

  // the Library tab: UP to the strip, RIGHT, OK; focus moves into the grid
  await press(page, 'ArrowUp');
  await expect(focused(page)).toHaveText('RECOMMENDED');
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.lib-tab.current')).toHaveText('LIBRARY');
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ FILMS/);
  await expect(page.locator('.lib .vgrid .card[data-focused]')).toBeVisible();
  await expect(page.locator('.lib-control').first()).toHaveText(/SORT · NAME/);
  await expect(page.locator('.lib-jump')).toBeVisible();
  await settle(page);
  await shot(page, info, 'library-grid');

  // the A-Z bar: RIGHT past the last column lands on the focused card's letter
  await press(page, 'ArrowRight', 5);
  const lastTitle = (await page.locator('.lib .vgrid .card[data-focused] .title').textContent()) ?? '';
  await press(page, 'ArrowRight');
  await expect(page.locator('.lib-letter[data-focused] .ch')).toHaveText(lastTitle.replace(/^The /, '').charAt(0).toUpperCase());
  await shot(page, info, 'library-jumpbar');
  // OK on a letter jumps to its first item (the server counts the names before it)
  for (let i = 0; i < 26; i++) {
    if (((await page.locator('.lib-letter[data-focused] .ch').textContent()) ?? '') === 'F') break;
    await press(page, 'ArrowDown');
  }
  await press(page, 'Enter');
  await expect(page.locator('.lib .vgrid .card[data-focused] .title')).toHaveText(/^F|^The F/);
  await expect(page.locator('.lib-letter .indicator').locator('xpath=../..')).toHaveText(/F/);
  await settle(page);
  await shot(page, info, 'library-letter-jump');
  // LEFT goes back into the grid, to that card; BACK goes to the top first
  await press(page, 'ArrowRight');
  await press(page, 'ArrowLeft');
  await press(page, 'Escape');
  await expect(page.locator('.lib .vgrid .card[data-focused] .title')).toHaveText('Arrival');
  await expect(page.locator('.lib')).toBeVisible();
  // BACK at the top leaves the page
  await press(page, 'Escape');
  await expect(page.locator('.home')).toBeVisible();
});

test('Movies: sort, filter and view dialogs', async ({ page }, info) => {
  await openFromRail(page, 'Movies');
  // straight to the Library tab
  await expect(page.locator('.lib-tab.current')).toBeVisible();
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'LIBRARY'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.lib .vgrid .card[data-focused]')).toBeVisible();
  const films = (await page.locator('.lib-kicker .count').textContent()) ?? '';

  // SORT: UP from the grid, RIGHT to the controls
  await press(page, 'ArrowUp');
  for (let i = 0; i < 6 && !/SORT/.test((await focused(page).textContent()) ?? ''); i++) await press(page, 'ArrowRight');
  await expect(focused(page)).toHaveText(/SORT · NAME/);
  await press(page, 'Enter');
  await expect(page.locator('.lib-panel .kicker')).toHaveText('SORT BY');
  await expect(page.locator('.lib-panel-row[data-focused] .label')).toHaveText('Name');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('↑');
  await shot(page, info, 'library-sort');
  await pick(page, /^Date Released$/);
  await expect(page.locator('.lib-panel')).toHaveCount(0);
  await expect(focused(page)).toHaveText(/SORT · DATE RELEASED/);
  await expect(page.locator('.lib .vgrid .card').first()).toBeVisible();
  await expect(page.locator('.lib-jump')).toHaveCount(0); // the A-Z bar only while sorted by name
  await settle(page);
  await shot(page, info, 'library-sorted');
  // choosing the current sort again reverses it
  await press(page, 'Enter');
  await pick(page, /^Date Released$/);
  await expect(focused(page)).toHaveText(/DATE RELEASED\s*↓/);
  await press(page, 'Enter');
  await pick(page, /^Name$/);
  await press(page, 'Enter');
  await pick(page, /^Name$/);
  await expect(focused(page)).toHaveText(/SORT · NAME\s*↑/);

  // FILTER: two levels; values toggle ON/OFF and apply at once
  await press(page, 'ArrowRight');
  await expect(focused(page)).toHaveText('FILTER');
  await press(page, 'Enter');
  await expect(page.locator('.lib-panel .kicker')).toHaveText('FILTER');
  await expect(page.locator('.lib-panel-row .label')).toHaveText(['Played', 'Favorites', 'Genres', 'Community Rating', 'Parental Rating', 'Video', 'Year', 'Decade']);
  await shot(page, info, 'library-filter');
  await pick(page, /^Genres$/);
  await expect(page.locator('.lib-panel .kicker')).toHaveText('FILTER · GENRES');
  await expect(page.locator('.lib-panel-row').first()).toBeVisible();
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('OFF');
  await press(page, 'Enter');
  await expect(page.locator('.lib-panel-row .value.accent').first()).toHaveText('ON');
  await shot(page, info, 'library-filter-genres');
  await press(page, 'Escape'); // back to the filter list
  await expect(page.locator('.lib-panel .kicker')).toHaveText('FILTER');
  await expect(page.locator('.lib-panel-row[data-focused] .label')).toHaveText('Genres');
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('1');
  await press(page, 'Escape'); // close
  await expect(page.locator('.lib-panel')).toHaveCount(0);
  await expect(focused(page)).toHaveText('FILTER · 1');
  await expect(page.locator('.lib-kicker .count')).not.toHaveText(films);
  await settle(page);
  await shot(page, info, 'library-filtered');
  await press(page, 'Enter');
  await pick(page, /^Clear all filters$/);
  await expect(focused(page)).toHaveText('FILTER');
  await expect(page.locator('.lib-kicker .count')).toHaveText(films);

  // VIEW: every option of the layout; columns change the grid, "show details" adds the header band
  await press(page, 'ArrowRight');
  await expect(focused(page)).toHaveText('VIEW');
  await press(page, 'Enter');
  await expect(page.locator('.lib-panel .kicker')).toHaveText('VIEW');
  await expect(page.locator('.lib-panel-row').first().locator('.value')).toHaveText('GRID');
  await shot(page, info, 'library-view');
  await pick(page, /^Columns$/);
  await expect(page.locator('.lib-panel .kicker')).toHaveText('VIEW · COLUMNS');
  await pick(page, /^8$/);
  await expect(page.locator('.lib-panel .kicker')).toHaveText('VIEW');
  await pick(page, /^Show details$/);
  await expect(page.locator('.lib-panel-row[data-focused] .value')).toHaveText('ON');
  await press(page, 'Escape');
  await expect(focused(page)).toHaveText('VIEW');
  await press(page, 'ArrowDown');
  await expect(page.locator('.lib .vgrid .card[data-focused]')).toBeVisible();
  await expect(page.locator('.lib-folder .home-header .kicker')).toHaveText('MOVIES');
  const width = await page.locator('.lib .vgrid .card').first().evaluate((el) => (el as HTMLElement).offsetWidth);
  expect(width).toBeLessThan(200); // 8 across
  await settle(page);
  await shot(page, info, 'library-view-details');
  // the A-Z bar is taller than the room under the band: it scrolls with the focused letter
  await press(page, 'ArrowRight', 8);
  await expect(page.locator('.lib-letter[data-focused]')).toBeVisible();
  await press(page, 'ArrowDown', 26);
  await expect(page.locator('.lib-letter[data-focused] .ch')).toHaveText('Z');
  const z = await page.locator('.lib-letter[data-focused]').boundingBox();
  expect(z !== null && z.y + z.height <= 1080).toBe(true);
  await shot(page, info, 'library-view-details-bar');
  await press(page, 'ArrowLeft');
  // Reset brings the defaults back
  await press(page, 'ArrowUp');
  for (let i = 0; i < 6 && ((await focused(page).textContent()) ?? '') !== 'VIEW'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await pick(page, /^Reset$/);
  await press(page, 'Escape');
  await expect(page.locator('.lib-folder .home-header')).toHaveCount(0);
});

test('Movies: Genres tab and a genre page; Collections tab', async ({ page }, info) => {
  await openFromRail(page, 'Movies');
  await expect(page.locator('.lib-tab.current')).toBeVisible();
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'GENRES'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ GENRES/);
  await expect(page.locator('.lib-name-card[data-focused] .title')).toHaveText('Action');
  await settle(page);
  await shot(page, info, 'library-genres');
  await press(page, 'Enter');
  await expect(lib(page).locator('.lib-kicker .name')).toHaveText('ACTION MOVIES');
  await expect(lib(page).locator('.lib-kicker .count')).toHaveText(/ · \d+ FILMS/);
  await expect(lib(page).locator('.vgrid .card[data-focused]')).toBeVisible();
  await expect(lib(page).locator('.lib-control')).toHaveText([/SORT · NAME/, 'FILTER', 'VIEW']);
  // the rail keeps its light on Movies
  await expect(page.locator('.rail .entry.selected .label')).toHaveText('Movies');
  await settle(page);
  await shot(page, info, 'library-genre-page');
  // PLAY on a focused film plays it; STOP comes back to the same card (no playback reports: server state untouched)
  await page.route('**/Sessions/Playing**', (route) => route.fulfill({ status: 204 }));
  const title = (await lib(page).locator('.vgrid .card[data-focused] .title').textContent()) ?? '';
  await press(page, 'MediaPlayPause');
  await expect(page.locator('.player')).toBeVisible();
  // the player opens on that film: once it plays, UP shows the controls with its title
  await expect.poll(() => page.evaluate(() => (document.querySelector('.player video') as HTMLVideoElement | null)?.currentTime ?? 0), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await press(page, 'ArrowUp');
  await expect(page.locator('.player .pc-top .title')).toHaveText(title);
  // the remote's STOP (Playwright has no MediaStop key)
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'MediaStop', bubbles: true })));
  await expect(lib(page).locator('.vgrid .card[data-focused] .title')).toHaveText(title);
  await press(page, 'Escape');
  await expect(lib(page).locator('.lib-name-card[data-focused] .title')).toHaveText('Action');

  // Collections tab: box sets, no A-Z bar, no play controls
  await press(page, 'ArrowUp');
  await press(page, 'ArrowLeft');
  await expect(focused(page)).toHaveText('COLLECTIONS');
  await press(page, 'Enter');
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ COLLECTIONS?/);
  await expect(page.locator('.lib-jump')).toHaveCount(0);
  await expect(page.locator('.lib-icon')).toHaveCount(1); // random only
  await settle(page);
  await shot(page, info, 'library-collections');
});

test('Shows: Recommended rows with VIEW ALL, Studios tab and a studio page', async ({ page }, info) => {
  await openFromRail(page, 'Shows');
  await expect(page.locator('.lib-tab')).toHaveText(['RECOMMENDED', 'LIBRARY', 'GENRES', 'STUDIOS']);
  // go to the Recommended tab whatever tab was remembered
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'RECOMMENDED'; i++) await press(page, 'ArrowLeft');
  if (((await page.locator('.lib-tab.current').textContent()) ?? '') !== 'RECOMMENDED') await press(page, 'Enter');
  else await press(page, 'ArrowDown');
  await expect(page.locator('.lib-rec .row-header .title').first()).toBeVisible({ timeout: 30_000 });
  await settle(page);
  await shot(page, info, 'shows-recommended');
  // DOWN through the rows: the focused row comes to the top of the list, its card always on screen
  const rowCount = await page.locator('.lib-rec .media-row').count();
  for (let i = 0; i < rowCount - 1; i++) {
    const before = await focused(page).evaluate((el) => el.closest('.media-row')?.querySelector('.row-header .title')?.textContent ?? '');
    await press(page, 'ArrowDown');
    await expect
      .poll(() => focused(page).evaluate((el) => el.closest('.media-row')?.querySelector('.row-header .title')?.textContent ?? ''))
      .not.toBe(before);
    const box = await focused(page).boundingBox();
    expect(box !== null && box.y >= 519 && box.y + box.height <= 1080).toBe(true);
  }
  await press(page, 'ArrowUp', rowCount);
  // a full row (25 cards) ends in VIEW ALL, which opens the whole list
  const titles = await page.locator('.lib-rec .row-header .title').allTextContents();
  const full = titles.indexOf('RECENTLY ADDED');
  test.skip(full < 0, 'no Recently added row');
  for (let i = 0; i < 6; i++) {
    const t = await focused(page).evaluate((el) => el.closest('.media-row')?.querySelector('.row-header .title')?.textContent ?? '');
    if (t === 'RECENTLY ADDED') break;
    await press(page, 'ArrowDown');
  }
  if ((await page.locator('.lib-rec .media-row:has(.lib-view-all)').count()) > 0) {
    for (let i = 0; i < 26 && (await page.locator('.lib-view-all[data-focused]').count()) === 0; i++) await press(page, 'ArrowRight');
    await expect(page.locator('.lib-view-all[data-focused]')).toBeVisible();
    await shot(page, info, 'shows-view-all-card');
    await press(page, 'Enter');
    await expect(lib(page).locator('.lib-kicker .name')).toHaveText('RECENTLY ADDED');
    await expect(lib(page).locator('.lib-kicker .count')).toHaveText(/ · \d+ EPISODES/);
    await expect(lib(page).locator('.vgrid .card[data-focused]')).toBeVisible();
    await settle(page);
    await shot(page, info, 'shows-view-all');
    await press(page, 'Escape');
    await expect(page.locator('.lib-view-all[data-focused]')).toBeVisible();
  }
  // Studios
  await press(page, 'ArrowUp', 6);
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'STUDIOS'; i++) await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(lib(page).locator('.lib-kicker .count')).toHaveText(/ · \d+ STUDIOS?/);
  await expect(lib(page).locator('.lib-name-card[data-focused]')).toBeVisible();
  await settle(page);
  await shot(page, info, 'shows-studios');
  await press(page, 'Enter');
  await expect(lib(page).locator('.lib-kicker .count')).toHaveText(/ · \d+ SHOWS?/);
  await settle(page);
  await shot(page, info, 'shows-studio-page');
});

test('Collections and Music libraries from the rail', async ({ page }, info) => {
  await openFromRail(page, 'Collections');
  await expect(page.locator('.lib-kicker .name')).toHaveText('COLLECTIONS');
  await expect(page.locator('.lib-tab')).toHaveCount(0);
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ COLLECTIONS?/);
  await expect(page.locator('.lib .vgrid .card[data-focused]')).toBeVisible();
  await settle(page);
  await shot(page, info, 'collections-library');

  await openFromRail(page, 'Music');
  await expect(page.locator('.lib-tab')).toHaveText(['RECOMMENDED', 'ALBUMS', 'ARTISTS', 'GENRES', 'SONGS']);
  await press(page, 'ArrowUp');
  for (let i = 0; i < 5 && ((await focused(page).textContent()) ?? '') !== 'ALBUMS'; i++) await press(page, 'ArrowRight');
  for (let i = 0; i < 5 && ((await focused(page).textContent()) ?? '') !== 'ALBUMS'; i++) await press(page, 'ArrowLeft');
  await press(page, 'Enter');
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ ALBUMS?/);
  await settle(page);
  await shot(page, info, 'music-albums');
  await press(page, 'ArrowUp');
  await press(page, 'ArrowRight');
  await press(page, 'Enter');
  await expect(page.locator('.lib-kicker .count')).toHaveText(/ · \d+ ARTISTS?/);
  await settle(page);
  await shot(page, info, 'music-artists');
});

test('Library cards: HOLD OK / MENU open the item menu; a box set opens its collection page, an episode its rundown; Play all queues the grid', async ({ page }, info) => {
  await page.route('**/Sessions/Playing**', (route) => route.fulfill({ status: 204 }));
  await openFromRail(page, 'Movies');
  // the Library tab's grid
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'LIBRARY'; i++) await press(page, (await page.locator('.lib-tab.current').textContent()) === 'RECOMMENDED' ? 'ArrowRight' : 'ArrowLeft');
  await press(page, 'Enter');
  const card = lib(page).locator('.vgrid .card[data-focused]');
  await expect(card).toBeVisible();
  const first = (await card.locator('.title').textContent()) ?? '';

  // HOLD OK: the item menu on the card (Go to first); BACK closes it on the same card
  await holdOk(page);
  const panel = page.locator('.panel-window');
  await expect(panel).toBeVisible();
  await expect(page.locator('.panel-row[data-focused] .headline')).toHaveText('Go to');
  expect(await panel.locator('.panel-row .headline').allTextContents()).toEqual(expect.arrayContaining(['Go to', 'Add to playlist']));
  await settle(page);
  await shot(page, info, 'library-item-menu');
  await press(page, 'Escape');
  await expect(panel).toHaveCount(0);
  await expect(card.locator('.title')).toHaveText(first);
  // MENU opens it too; Go to opens the film's page, BACK returns to the card
  await press(page, 'ContextMenu');
  await expect(panel).toBeVisible();
  await press(page, 'Enter');
  await expect(page.locator('.page:not(.hidden) .detail-page .dh-kicker')).toHaveText('FILM');
  await press(page, 'Escape');
  await expect(card.locator('.title')).toHaveText(first);

  // Play all: the grid's films in its order, one queue (the second is next)
  const second = (await lib(page).locator('.vgrid .card').nth(1).locator('.title').textContent()) ?? '';
  const caption = page.locator('.page:not(.hidden) .lib-caption');
  const captionText = async (): Promise<string> => ((await caption.count()) > 0 ? ((await caption.textContent()) ?? '') : '');
  await press(page, 'ArrowUp');
  for (let i = 0; i < 10 && (await captionText()) !== 'PLAY'; i++) await press(page, 'ArrowRight');
  await expect(caption).toHaveText('PLAY');
  await shot(page, info, 'library-play-all');
  await press(page, 'Enter');
  await expect(page.locator('.player')).toBeVisible();
  await expect.poll(() => videoTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
  await press(page, 'ArrowUp');
  await expect(page.locator('.player .pc-top .title')).toHaveText(first);
  const row = page.locator('.pc-cards .row-header .title');
  for (let i = 0; i < 3 && ((await row.count()) === 0 || (await row.textContent()) !== 'QUEUE'); i++) {
    await press(page, 'ArrowDown');
    await page.waitForTimeout(150);
  }
  await expect(page.locator('.pc-cards .row-header .title')).toHaveText('QUEUE');
  await expect(page.locator('.pc-card[data-focused] .title')).toHaveText(second);
  await page.waitForTimeout(400);
  await shot(page, info, 'library-play-all-queue');
  await stopKey(page);
  await expect(lib(page)).toBeVisible();

  // Collections tab: a box set opens its collection page (Android's TallyCollectionPage), the rail keeps its light on
  // Movies
  await expect(caption).toHaveText('PLAY');
  // LEFT along the controls into the tab strip (it takes focus on the current tab), then RIGHT to COLLECTIONS
  const focusedTab = page.locator('.page:not(.hidden) .lib-tab[data-focused]');
  for (let i = 0; i < 8 && (await focusedTab.count()) === 0; i++) await press(page, 'ArrowLeft');
  await expect(focusedTab).toHaveText('LIBRARY');
  await press(page, 'ArrowRight');
  await expect(focusedTab).toHaveText('COLLECTIONS');
  await press(page, 'Enter');
  await expect(card).toBeVisible();
  const boxSet = (await card.locator('.title').textContent()) ?? '';
  await press(page, 'Enter');
  const collection = page.locator('.page:not(.hidden) .collection-page');
  await expect(collection.locator('.dh-title')).toHaveText(boxSet);
  await expect(collection.locator('.dh-meta')).toHaveText(/^\d+ FILMS?·/);
  await expect(collection.locator('.media-row .card').first()).toBeVisible();
  await expect(page.locator('.rail .entry.selected .label')).toHaveText('Movies');
  await settle(page);
  await shot(page, info, 'library-box-set');
  await press(page, 'Escape');
  await expect(card.locator('.title')).toHaveText(boxSet);
});

test('Shows: an episode card opens its season rundown on that episode', async ({ page }, info) => {
  await openFromRail(page, 'Shows');
  await press(page, 'ArrowUp');
  for (let i = 0; i < 4 && ((await focused(page).textContent()) ?? '') !== 'RECOMMENDED'; i++) await press(page, 'ArrowLeft');
  if (((await page.locator('.lib-tab.current').textContent()) ?? '') !== 'RECOMMENDED') await press(page, 'Enter');
  else await press(page, 'ArrowDown');
  await expect(page.locator('.lib-rec .row-header .title').first()).toBeVisible({ timeout: 30_000 });
  // the Recently added row lists episodes
  for (let i = 0; i < 6; i++) {
    const t = await focused(page).evaluate((el) => el.closest('.media-row')?.querySelector('.row-header .title')?.textContent ?? '');
    if (t === 'RECENTLY ADDED') break;
    await press(page, 'ArrowDown');
  }
  const kicker = lib(page).locator('.lib-details .home-header .kicker');
  await expect(kicker).toHaveText('RECENTLY ADDED');
  const header = lib(page).locator('.lib-details .home-header');
  const episodeTitle = (await header.locator('.meta').textContent()) ?? '';
  expect(episodeTitle).toMatch(/^S\d+ E\d+/);
  await press(page, 'Enter');
  await expect(page.locator('.page:not(.hidden) .rundown .episode-row[data-focused]')).toBeVisible({ timeout: 20_000 });
  // the rundown opens on that episode: its number
  const number = /^S\d+ E(\d+)/.exec(episodeTitle)?.[1] ?? '';
  await expect(page.locator('.page:not(.hidden) .rundown .episode-row[data-focused] .number')).toHaveText('E' + number.padStart(2, '0'));
  await page.waitForTimeout(500);
  await shot(page, info, 'library-episode-to-rundown');
  await press(page, 'Escape');
  await expect(kicker).toHaveText('RECENTLY ADDED');
});
