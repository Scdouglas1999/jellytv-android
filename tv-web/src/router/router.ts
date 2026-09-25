/**
 * Navigation: a stack of routes. Pages below the top stay mounted (hidden), so BACK is instant and returns to the
 * same focus and scroll. Routes are plain data (no URLs: a TV has no address bar), declared in `Route` below; each
 * route name maps to a page in app/routes.tsx.
 */
import { createStore } from '../util/store';

/**
 * `libraryId` on the collection and playlist routes: the library they were opened from (the rail keeps its light).
 *
 * What a library route shows besides the library itself (pages/library): a genre or a studio of it, a folder inside
 * it, a box set, or every item of one of its Recommended rows ("view all"). `libraryId` stays the library's, so the rail keeps
 * its light on the library.
 */
export type LibraryView =
  | { kind: 'genre' | 'studio'; id: string; name: string }
  | { kind: 'folder'; id: string; name: string; collectionType: string }
  /** A box set's items (Android's collection page; a grid until tv-web has that page). */
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'row'; rowKey: string; title: string };

export type Route =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'library'; libraryId: string; title: string; collectionType: string; view?: LibraryView }
  | { name: 'item'; itemId: string }
  /** A box set (Android's TallyCollectionPage): header, actions, a row of its items per type. */
  | { name: 'collection'; itemId: string; libraryId?: string }
  /** A playlist (Android's TallyPlaylistPage): header, actions, the numbered list of its items. */
  | { name: 'playlist'; itemId: string; libraryId?: string }
  /** `queue`: the items to play in order, `itemId` first (a library's Play all / Shuffle); else the item's own queue. */
  | { name: 'player'; itemId: string; startMs?: number; queue?: string[] }
  | { name: 'postplay'; itemId: string }
  | { name: 'live'; channelId: string; hlsPath: string; title: string; gameId?: string }
  | { name: 'sports' }
  | { name: 'multiview' }
  | { name: 'startover'; path: string; title: string }
  | { name: 'settings' }
  /** A series' season rundown (season tabs over the numbered episode list), on `seasonId`, focusing `episodeId`. */
  | { name: 'season'; seriesId: string; seasonId?: string; episodeId?: string }
  | { name: 'placeholder'; title: string; note: string };

export interface Entry {
  id: number;
  route: Route;
}

let nextId = 1;

export const stack = createStore<Entry[]>([{ id: nextId++, route: { name: 'home' } }]);

export function push(route: Route): void {
  stack.update((s) => s.concat({ id: nextId++, route }));
}

export function replace(route: Route): void {
  stack.update((s) => s.slice(0, -1).concat({ id: nextId++, route }));
}

/** Clears the stack down to `route` (a drawer destination starts a new stack on top of Home). */
export function resetTo(route: Route): void {
  const home: Entry = stack.get()[0] ?? { id: nextId++, route: { name: 'home' } };
  stack.set(route.name === 'home' ? [home] : [home, { id: nextId++, route }]);
}

/** False when there was nothing to go back to. */
export function back(): boolean {
  const s = stack.get();
  if (s.length <= 1) return false;
  stack.set(s.slice(0, -1));
  return true;
}

export function top(): Route {
  const s = stack.get();
  return (s[s.length - 1] as Entry).route;
}
