import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deviceTimeZone, withArtParams } from '../src/api/tally';
import { decodeDvrList, libraryNotice, libraryStateOf, recordingView } from '../src/api/tallyDvr';
import { decodeGame } from '../src/api/tallyModels';
import {
  applyMove,
  collectionMeta,
  countNoun,
  moveIsOffByOne,
  moveLanding,
  movePlan,
  playlistMeta,
  playlistRowMeta,
  rundownNumber,
  typeTitle,
  yearRange,
} from '../src/pages/collection/pagesFormat';
import { itemMenuEntries } from '../src/pages/details/DetailDialogs';
import { gameHeaderText } from '../src/pages/home/HomeHeader';

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
/** The Back to the Future Collection and its films, as the dev server sends them. */
const bttf = load<BaseItemDto>('collection-bttf.json');
const bttfMovies = load<{ Items: BaseItemDto[] }>('collection-bttf-movies.json').Items;
/** A playlist of a film, an episode and two more films on the dev server (Toy Story, Breaking Bad's Pilot, …). */
const playlist = load<{ Items: BaseItemDto[] }>('playlist-items-dev.json').Items;

describe('collection page (TallyCollectionPage collectionMeta)', () => {
  it('reads `3 FILMS · 1985–1990 · [PG] · 4m 30s` from the box set and its films', () => {
    expect(collectionMeta(bttf, bttfMovies)).toEqual([{ text: '3 films' }, { text: '1985–1990' }, { text: 'PG', boxed: true }, { text: '4m 30s' }]);
  });
  it('counts films, shows, episodes or items, and spans years', () => {
    expect(countNoun(['Movie', 'Movie'])).toBe('film');
    expect(countNoun(['Series'])).toBe('show');
    expect(countNoun(['Movie', 'Series'])).toBe('item');
    expect(countNoun([])).toBe('item');
    expect(yearRange([1995, null, 2010, 0])).toBe('1995–2010');
    expect(yearRange([2019, 2019])).toBe('2019');
    expect(yearRange([null])).toBeNull();
    expect(collectionMeta({ ...bttf, ChildCount: 1, OfficialRating: null }, bttfMovies.slice(0, 1))).toEqual([{ text: '1 film' }, { text: '1985' }, { text: '1m 30s' }]);
  });
  it('titles rows by type as Android does', () => {
    expect(['Movie', 'Series', 'Episode', 'Video', 'BoxSet'].map(typeTitle)).toEqual(['Movies', 'Shows', 'Episodes', 'Videos', 'Collections']);
  });
});

describe('playlist page (TallyPlaylistPage)', () => {
  it('numbers rows and describes each item', () => {
    expect([0, 8, 9, 123].map(rundownNumber)).toEqual(['01', '09', '10', '124']);
    expect(playlist.map(playlistRowMeta)).toEqual(['Film · 1995 · 1m 30s', 'Breaking Bad · S1 E1 · 1m', 'Film · 2008 · 1m', 'Film · 2010 · 1m 30s']);
  });
  it('sums the running times in the header: `4 items · 5m`', () => {
    expect(playlistMeta(null, playlist)).toBe('4 items · 5m');
    expect(playlistMeta(null, [])).toBe('0 items');
  });
});

describe("moving a playlist item (Jellyfin 10.10's off-by-one move)", () => {
  /** What the 10.10.6 dev server did for every move of a 5-item playlist ABCDE (from, to → order). */
  const measured: Record<string, string> = {
    '0,1': 'BCADE', '0,2': 'BCDAE', '0,3': 'BCDEA', '0,4': 'BCDEA',
    '1,0': 'ABCDE', '1,2': 'ACDBE', '1,3': 'ACDEB', '1,4': 'ACDEB',
    '2,0': 'ACBDE', '2,1': 'ACBDE', '2,3': 'ABDEC', '2,4': 'ABDEC',
    '3,0': 'ADBCE', '3,1': 'ADBCE', '3,2': 'ABDCE', '3,4': 'ABCED',
    '4,0': 'AEBCD', '4,1': 'AEBCD', '4,2': 'ABECD', '4,3': 'ABCED',
  };
  it('models the measured server exactly', () => {
    for (const [key, order] of Object.entries(measured)) {
      const [from, to] = key.split(',').map(Number) as [number, number];
      expect(applyMove('ABCDE'.split(''), from, to, true).join(''), key).toBe(order);
    }
    expect(moveLanding(5, 2, 0, false)).toBe(0);
  });
  it('plans calls that put the item where the viewer moved it, on 10.10 and on 12', () => {
    for (let n = 2; n <= 7; n++) {
      const start = Array.from({ length: n }, (_, i) => i);
      for (let from = 0; from < n; from++) {
        for (let to = 0; to < n; to++) {
          const wanted = applyMove(start, from, to, false);
          for (const offByOne of [true, false]) {
            let order = start;
            for (const step of movePlan(n, from, to, offByOne)) order = applyMove(order, step.at, step.request, offByOne);
            expect(order, `n=${n} ${from}→${to} offByOne=${String(offByOne)}`).toEqual(wanted);
          }
        }
      }
    }
    // one call wherever it can be one: a move down by one moves the neighbor up instead
    expect(movePlan(5, 2, 3, true)).toEqual([{ at: 3, request: 2 }]);
    expect(movePlan(5, 3, 2, true)).toEqual([{ at: 3, request: 2 }]);
    expect(movePlan(5, 1, 0, true)).toHaveLength(2);
    expect(movePlan(5, 2, 3, false)).toEqual([{ at: 2, request: 3 }]);
  });
  it('compensates only on 10.10 servers', () => {
    expect(moveIsOffByOne('10.10.6')).toBe(true);
    expect(moveIsOffByOne('12.1.0')).toBe(false);
    expect(moveIsOffByOne('10.11.0')).toBe(false);
  });
});

describe('item menu: Remove from continue watching (upstream canRemoveContinueWatching)', () => {
  const film = bttfMovies[0] as BaseItemDto;
  const resumed = (played: boolean, ticks: number): BaseItemDto => ({ ...film, UserData: { ...(film.UserData as NonNullable<BaseItemDto['UserData']>), Played: played, PlaybackPositionTicks: ticks } });
  const labels = (item: BaseItemDto, continueWatching: boolean): string[] =>
    itemMenuEntries({ kind: 'menu', item, returnKey: 'k', continueWatching, goTo: () => undefined }, () => undefined, () => undefined).map((e) => e.label);
  it('is offered on a Continue watching card with a resume point, after Add to playlist and before Mark watched', () => {
    const l = labels(resumed(false, 300_000_000), true);
    expect(l.slice(0, 4)).toEqual(['Go to', 'Resume', 'Play from start', 'Add to playlist']);
    expect(l.indexOf('Remove from continue watching')).toBe(l.indexOf('Add to playlist') + 1);
    expect(l.indexOf('Mark watched')).toBe(l.indexOf('Remove from continue watching') + 1);
  });
  it('is not offered elsewhere, without a resume point, or once watched', () => {
    expect(labels(resumed(false, 300_000_000), false)).not.toContain('Remove from continue watching');
    expect(labels(resumed(false, 0), true)).not.toContain('Remove from continue watching');
    expect(labels(resumed(true, 300_000_000), true)).not.toContain('Remove from continue watching');
  });
  it('offers Remove from playlist before Add to playlist in an editable playlist', () => {
    const l = itemMenuEntries({ kind: 'menu', item: film, returnKey: 'k', onRemoveFromPlaylist: () => undefined }, () => undefined, () => undefined).map((e) => e.label);
    expect(l.indexOf('Remove from playlist')).toBe(l.indexOf('Add to playlist') - 1);
  });
});

describe('Home header for a game (TallyGameHeader)', () => {
  const live = decodeGame({
    id: '401817088', sport: 'baseball', league: 'MLB', state: 'in', detail: 'Top 1st', start: '2026-09-25T20:05Z', lastPlay: 'Pitch 2 : Ball 1',
    away: { abbr: 'BAL', shortName: 'Orioles', score: 0 }, home: { abbr: 'NYY', shortName: 'Yankees', score: 0 }, broadcasts: ['MLB.TV'],
  });
  it('names the league, not the sport: `MLB · Top 1st`', () => {
    const t = gameHeaderText(live, false);
    expect(t).toEqual({ kicker: 'MLB · Top 1st', title: 'Orioles at Yankees', meta: 'BAL 0 · NYY 0', overview: 'Pitch 2 : Ball 1' });
  });
  it('drops the score and the last play while scores are hidden; broadcasts for an upcoming game', () => {
    expect(gameHeaderText(live, true)).toEqual({ kicker: 'MLB · Top 1st', title: 'Orioles at Yankees', meta: 'MLB.TV', overview: '' });
    const pre = { ...live, state: 'pre', lastPlay: null };
    expect(gameHeaderText(pre, false, new Date('2026-09-25T12:00:00Z')).meta).toBe('MLB.TV');
  });
});

describe('plugin art parameters (contracts 1 and 2)', () => {
  it('adds the drawn width and the zone to paths with or without a query', () => {
    expect(withArtParams('/JellyTV/Backdrop/401817088.png', 1400, 'America/New_York')).toBe('/JellyTV/Backdrop/401817088.png?w=1400&tz=America%2FNew_York');
    expect(withArtParams('/JellyTV/Card/ef21.png?v=c&n=Brewers', 383.6, null)).toBe('/JellyTV/Card/ef21.png?v=c&n=Brewers&w=384');
  });
  it("sends the device's zone, not a UTC the runtime falls back to", () => {
    const ny = new Date(2026, 8, 25, 12, 0, 0);
    expect(deviceTimeZone(ny, () => 'America/Chicago')).toBe('America/Chicago');
    expect(deviceTimeZone(ny, () => undefined)).toBeNull();
    const utcOffset = ny.getTimezoneOffset() === 0;
    expect(deviceTimeZone(ny, () => 'UTC')).toBe(utcOffset ? 'UTC' : null);
    expect(deviceTimeZone(ny, () => 'Etc/UTC')).toBe(utcOffset ? 'Etc/UTC' : null);
  });
});

describe('recordings not in a library (contract 3)', () => {
  it('reads libraryState, and an older plugin without it as "adding"', () => {
    expect(libraryStateOf('abc', 'noLibrary')).toBe('ready');
    expect(libraryStateOf(null, 'noLibrary')).toBe('noLibrary');
    expect(libraryStateOf(null, 'adding')).toBe('adding');
    expect(libraryStateOf(null, undefined)).toBe('adding');
    const list = decodeDvrList({
      canManage: true,
      rules: [],
      jobs: [
        { id: 'a', state: 'done', title: 'Otters at Herons', game: { id: '1' }, itemId: 'item1', libraryState: 'ready' },
        { id: 'b', state: 'done', title: 'Otters at Herons', game: { id: '2' }, itemId: null, libraryState: 'noLibrary' },
        { id: 'c', state: 'done', title: 'Otters at Herons', game: { id: '3' }, itemId: null },
      ],
    });
    expect(list.jobs.map((j) => j.libraryState)).toEqual(['ready', 'noLibrary', 'adding']);
    expect(recordingView(decodeGame({ id: '2', state: 'post' }), list)?.libraryState).toBe('noLibrary');
    expect(decodeGame({ id: '9', recording: { state: 'done', jobId: 'x', libraryState: 'noLibrary' } }).recording?.libraryState).toBe('noLibrary');
    expect(decodeGame({ id: '9', recording: { state: 'done', jobId: 'x' } }).recording?.libraryState).toBe('adding');
  });
  it("says why in the contract's words", () => {
    expect(libraryNotice('ready')).toBeNull();
    expect(libraryNotice('adding')).toBe('Still being added to the library. Try again in a minute.');
    expect(libraryNotice('noLibrary')).toBe('This server has no library for recordings yet. Its owner can add one under Settings → Recordings.');
  });
});
