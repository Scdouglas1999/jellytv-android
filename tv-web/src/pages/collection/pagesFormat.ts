/**
 * Pure formatting and planning for the collection and playlist pages (the Android app's media/pages/PagesFormat.kt,
 * the meta lines of TallyCollectionPage.kt and TallyPlaylistPage.kt, and the playlist's move buttons). Unit-tested in
 * tests/pages.test.ts.
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { DetailMetaPart } from '../../kit/DetailHeader';
import { episodeCode } from '../../kit/ItemCard';
import { formatRuntime } from '../../util/format';

/** Parts joined with ` · `, blanks dropped. */
export function joinMeta(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => p != null && p.trim() !== '').join(' · ');
}

/** `1995–2010`; one year alone when first and last are the same; null when there is none. */
export function yearRange(years: ReadonlyArray<number | null | undefined>): string | null {
  const known = years.filter((y): y is number => y != null && y > 0);
  if (known.length === 0) return null;
  const first = Math.min(...known);
  const last = Math.max(...known);
  return first === last ? String(first) : `${first}–${last}`;
}

/** Sum of the positive run times, in ticks. */
export function totalRuntimeTicks(ticks: ReadonlyArray<number | null | undefined>): number {
  return ticks.reduce<number>((sum, t) => (t != null && t > 0 ? sum + t : sum), 0);
}

/** What a collection's count is of: films when all are films, shows when all are series, episodes, else items. */
export type CountNoun = 'film' | 'show' | 'episode' | 'item';

export function countNoun(types: ReadonlyArray<string | null | undefined>): CountNoun {
  const distinct: string[] = [];
  for (const t of types) if (t != null && distinct.indexOf(t) < 0) distinct.push(t);
  if (distinct.length !== 1) return 'item';
  switch (distinct[0]) {
    case 'Movie':
      return 'film';
    case 'Series':
      return 'show';
    case 'Episode':
      return 'episode';
    default:
      return 'item';
  }
}

/** `3 films`, `1 item`. */
export function countLabel(count: number, noun: CountNoun): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The collection header's meta line (collectionMeta): `3 FILMS · 1985–1990 · [PG] · 4m 30s`: the count (the box
 * set's own child count, else the sample's), the span of release years, the rating in its box, the total running
 * time, all read from `sample` (the first page of each row).
 */
export function collectionMeta(collection: BaseItemDto, sample: readonly BaseItemDto[]): DetailMetaPart[] {
  const parts: DetailMetaPart[] = [];
  const count = collection.ChildCount ?? sample.length;
  if (count > 0) parts.push({ text: countLabel(count, countNoun(sample.map((i) => i.Type))) });
  const years = yearRange(sample.map((i) => i.ProductionYear));
  if (years !== null) parts.push({ text: years });
  const rating = collection.OfficialRating;
  if (rating != null && rating.trim() !== '') parts.push({ text: rating, boxed: true });
  const runtime = totalRuntimeTicks(sample.map((i) => i.RunTimeTicks));
  if (runtime > 0) parts.push({ text: formatRuntime(runtime) });
  return parts;
}

/** The item types a collection lists, one row each, in upstream's order (CollectionViewModel.typesInCollection). */
export const COLLECTION_TYPES = ['Movie', 'Series', 'Episode', 'Video', 'BoxSet', 'MusicArtist', 'MusicAlbum', 'MusicVideo'] as const;

/** A row's title for a type (typeTitle): `MOVIES`, `SHOWS`, `EPISODES`, `VIDEOS`, `COLLECTIONS`… */
export function typeTitle(type: string): string {
  switch (type) {
    case 'Movie':
      return 'Movies';
    case 'Series':
      return 'Shows';
    case 'Episode':
      return 'Episodes';
    case 'Video':
      return 'Videos';
    case 'BoxSet':
      return 'Collections';
    case 'Playlist':
      return 'Playlists';
    case 'MusicArtist':
      return 'Artists';
    case 'MusicAlbum':
      return 'Albums';
    case 'MusicVideo':
      return 'Music videos';
    default:
      return type;
  }
}

/** Rundown number for a zero-based index: `01`, `12`, `124`. */
export function rundownNumber(index: number): string {
  const n = index + 1;
  return n < 10 ? '0' + String(n) : String(n);
}

/** A playlist row's meta line (rowMeta): `FILM · 1995 · 1m 30s` / `BREAKING BAD · S1 E1 · 1m` / `SONG · 2019 · 3m 12s`. */
export function playlistRowMeta(item: BaseItemDto): string {
  const runtime = (item.RunTimeTicks ?? 0) > 0 ? formatRuntime(item.RunTimeTicks ?? 0) : null;
  if (item.Type === 'Episode') return joinMeta(item.SeriesName, episodeCode(item), runtime);
  const kind =
    item.Type === 'Movie'
      ? 'Film'
      : item.Type === 'Video' || item.Type === 'MusicVideo'
        ? 'Video'
        : item.Type === 'Audio'
          ? 'Song'
          : item.Type === 'Series'
            ? 'Series'
            : null;
  return joinMeta(kind, item.ProductionYear != null ? String(item.ProductionYear) : null, runtime);
}

/** Up to this many items the playlist header sums their running times; a longer playlist shows the server's total. */
export const PLAYLIST_META_SAMPLE = 200;

/** The playlist header's meta line (PlaylistHeader): `4 items · 5m`. */
export function playlistMeta(playlist: BaseItemDto | null, items: readonly BaseItemDto[]): string {
  const sum = items.length > 0 && items.length <= PLAYLIST_META_SAMPLE ? totalRuntimeTicks(items.map((i) => i.RunTimeTicks)) : (playlist?.RunTimeTicks ?? 0);
  return joinMeta(countLabel(items.length, 'item'), sum > 0 ? formatRuntime(sum) : null);
}

// ---------------------------------------------------------------------------------------------------------------
// Moving a playlist item (upstream's move up / move down)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Jellyfin 10.10's `POST /Playlists/{id}/Items/{itemId}/Move/{newIndex}` puts the item one place off (measured on
 * the 10.10.6 dev server, every from/to pair of a 5-item playlist): a move down lands one further (at most at the end),
 * a move to the top lands second. 12.x places it where asked. Returns true for the servers that need compensating.
 */
export function moveIsOffByOne(serverVersion: string): boolean {
  return /^10\.10\./.test(serverVersion);
}

/** Where an item asked to move from `at` to `request` lands (n items) on a correct server or on 10.10. */
export function moveLanding(n: number, at: number, request: number, offByOne: boolean): number {
  const target = Math.max(0, Math.min(n - 1, request));
  if (!offByOne || target === at) return target;
  return target > at ? Math.min(target + 1, n - 1) : Math.max(target, 1);
}

/** `list` after the server moved the item at `at` with `request` (see moveLanding). */
export function applyMove<T>(list: readonly T[], at: number, request: number, offByOne: boolean): T[] {
  const landing = moveLanding(list.length, at, request, offByOne);
  const out = list.slice();
  const [item] = out.splice(at, 1);
  if (item === undefined) return out;
  out.splice(landing, 0, item);
  return out;
}

/** One server call of a move: move the item that is at `at` (at the time of the call), asking for `request`. */
export interface MoveStep {
  at: number;
  request: number;
}

/**
 * The calls that put the item at `from` at `to` (n items). One call where the server gets it right; on 10.10 the
 * request is corrected, a move down by one moves the neighbor up instead, and the top two places (which 10.10 cannot
 * swap in one call) take two or three calls.
 */
export function movePlan(n: number, from: number, to: number, offByOne: boolean): MoveStep[] {
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return [];
  if (!offByOne) return [{ at: from, request: to }];
  if (to > from) {
    if (to >= from + 2) return [{ at: from, request: to - 1 }];
    if (from >= 1) return [{ at: to, request: from }];
    // the first item one place down
    return n === 2 ? [{ at: 0, request: 1 }] : [{ at: 0, request: 1 }, { at: 2, request: 1 }];
  }
  if (to >= 1) return [{ at: from, request: to }];
  // to the top: it lands second, then the first two change places
  const steps: MoveStep[] = from >= 2 ? [{ at: from, request: 0 }] : [];
  return steps.concat(movePlan(n, 0, 1, offByOne));
}
