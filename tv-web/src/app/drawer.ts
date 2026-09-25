import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { GlyphName } from '../kit/glyphs';
import type { Route } from '../router/router';

export interface DrawerItem {
  key: string;
  label: string;
  glyph: GlyphName;
  route: Route;
}

export interface DrawerModel {
  top: DrawerItem[];
  primary: DrawerItem[];
  libraries: DrawerItem[];
  sections: DrawerItem[];
  settings: DrawerItem;
}

function libraryGlyph(type: string | null | undefined): GlyphName {
  switch (type) {
    case 'movies':
      return 'film';
    case 'tvshows':
      return 'tv';
    case 'music':
      return 'music';
    case 'boxsets':
      return 'folderOpen';
    case 'playlists':
      return 'listUl';
    case 'homevideos':
      return 'video';
    default:
      return 'film';
  }
}

/**
 * The drawer's entries in the Android app's order (TallyNavDrawer): Search, Home; Movies and TV libraries, then
 * Sports; LIBRARIES (the rest; Live TV hidden while Sports is there); the app sections; Settings pinned last.
 */
export function drawerModel(views: readonly BaseItemDto[], sports: boolean): DrawerModel {
  const lib = (v: BaseItemDto): DrawerItem => ({
    key: 'lib-' + (v.Id ?? ''),
    label: v.Name ?? '',
    glyph: libraryGlyph(v.CollectionType),
    route: { name: 'library', libraryId: v.Id ?? '', title: v.Name ?? '', collectionType: v.CollectionType ?? '' },
  });
  const visible = views.filter((v) => !(sports && v.CollectionType === 'livetv'));
  const movies = visible.filter((v) => v.CollectionType === 'movies').map(lib);
  const shows = visible.filter((v) => v.CollectionType === 'tvshows').map(lib);
  const others = visible.filter((v) => v.CollectionType !== 'movies' && v.CollectionType !== 'tvshows').map(lib);
  const primary = movies.concat(shows);
  if (sports) primary.push({ key: 'sports', label: 'Sports', glyph: 'trophy', route: { name: 'sports' } });
  return {
    top: [
      { key: 'search', label: 'Search', glyph: 'search', route: { name: 'search' } },
      { key: 'home', label: 'Home', glyph: 'house', route: { name: 'home' } },
    ],
    primary,
    libraries: others,
    sections: [
      { key: 'surprise', label: 'Surprise me', glyph: 'dice', route: { name: 'placeholder', title: 'Surprise me', note: 'Surprise me comes in a later build.' } },
      { key: 'favorites', label: 'Favorites', glyph: 'heart', route: { name: 'placeholder', title: 'Favorites', note: 'Favorites come in a later build.' } },
    ],
    settings: { key: 'settings', label: 'Settings', glyph: 'gear', route: { name: 'settings' } },
  };
}

/** The drawer key of the page a route belongs to (the rail's tally light). */
export function drawerKeyFor(route: Route): string | null {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'search':
      return 'search';
    case 'sports':
    case 'live':
      return 'sports';
    case 'settings':
      return 'settings';
    case 'library':
      return 'lib-' + route.libraryId;
    case 'collection':
    case 'playlist':
      return route.libraryId !== undefined ? 'lib-' + route.libraryId : null;
    case 'placeholder':
      return route.title === 'Surprise me' ? 'surprise' : route.title === 'Favorites' ? 'favorites' : null;
    default:
      return null;
  }
}
