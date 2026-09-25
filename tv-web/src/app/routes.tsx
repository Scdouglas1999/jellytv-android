/**
 * Route name → page. Adding a screen: add its Route variant in router/router.ts, write the page under pages/<name>/,
 * register it here (replacing the placeholder). `chrome`: 'rail' pages sit beside the navigation rail; 'full' pages
 * take the whole screen (players).
 */
import type { FunctionComponent } from 'preact';
import type { Route } from '../router/router';
import type { PageProps } from './page';
import { HomePage } from '../pages/home/HomePage';
import { LibraryPage } from '../pages/library/LibraryPage';
import { PlayerPage } from '../pages/player/PlayerPage';
import { PostPlayPage } from '../pages/postplay/PostPlayPage';
import { LivePage } from '../pages/player/LivePage';
import { PlaceholderPage } from '../pages/placeholder/PlaceholderPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { SportsPage } from '../pages/sports/SportsPage';
import { StartOverPage } from '../pages/sports/StartOverPage';
import { MultiviewPage } from '../pages/multiview/MultiviewPage';
import { ItemPage } from '../pages/details/ItemPage';
import { SeasonPage } from '../pages/details/SeasonPage';
import { CollectionPage } from '../pages/collection/CollectionPage';
import { PlaylistPage } from '../pages/playlist/PlaylistPage';

type Pages = { [N in Route['name']]: { page: FunctionComponent<PageProps<Extract<Route, { name: N }>>>; chrome: 'rail' | 'full' } };

export const PAGES: Pages = {
  home: { page: HomePage, chrome: 'rail' },
  search: { page: PlaceholderPage, chrome: 'rail' },
  library: { page: LibraryPage, chrome: 'rail' },
  item: { page: ItemPage, chrome: 'rail' },
  collection: { page: CollectionPage, chrome: 'rail' },
  playlist: { page: PlaylistPage, chrome: 'rail' },
  season: { page: SeasonPage, chrome: 'rail' },
  sports: { page: SportsPage, chrome: 'rail' },
  settings: { page: SettingsPage, chrome: 'rail' },
  placeholder: { page: PlaceholderPage, chrome: 'rail' },
  player: { page: PlayerPage, chrome: 'full' },
  postplay: { page: PostPlayPage, chrome: 'full' },
  live: { page: LivePage, chrome: 'full' },
  multiview: { page: MultiviewPage, chrome: 'full' },
  startover: { page: StartOverPage, chrome: 'full' },
};

export function chromeOf(route: Route): 'rail' | 'full' {
  return PAGES[route.name].chrome;
}
