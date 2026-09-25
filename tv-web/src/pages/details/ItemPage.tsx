/**
 * The `item` route: loads the item, then shows the page for its kind (Android TallyRoutes: MediaItem by type):
 * films and videos, series, episodes, people, seasons (the rundown). Coming back to the page (after playing
 * something) loads the item again, so resume points and watched marks are current.
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useArrivalFocus, type PageProps } from '../../app/page';
import { useFocusable } from '../../focus/focus';
import type { Route } from '../../router/router';
import { tallyUppercase } from '../../util/format';
import { CollectionView } from '../collection/CollectionPage';
import { PersonPage } from '../person/PersonPage';
import { PlaylistView } from '../playlist/PlaylistPage';
import { PageMessage } from './common';
import { loadItem } from './detailsData';
import { EpisodePage } from './EpisodePage';
import { FilmPage } from './FilmPage';
import { SeasonView } from './SeasonPage';
import { SeriesPage } from './SeriesPage';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; item: BaseItemDto };

const FILM_TYPES = ['Movie', 'Video', 'MusicVideo', 'Trailer'];

/** Where focus lands when the page opens: the primary button (the favorite button on a person's page). */
function arrivalKey(pageKey: string, item: BaseItemDto | null): string | null {
  if (item === null) return null;
  if (item.Type === 'Person') return `${pageKey}-favorite`;
  if (item.Type === 'Series' || item.Type === 'Episode' || FILM_TYPES.indexOf(item.Type ?? '') >= 0) return `${pageKey}-play`;
  // the collection and playlist pages put focus where their items say (they load them)
  if (item.Type === 'BoxSet' || item.Type === 'Playlist') return null;
  return `${pageKey}-later`;
}

/** A kind of item a later build opens (music): said plainly. */
function Later(props: { item: BaseItemDto; pageKey: string }) {
  const f = useFocusable<HTMLDivElement>({ focusKey: `${props.pageKey}-later` });
  return (
    <div class="detail-later">
      <div class="mono-label kicker">{tallyUppercase(props.item.Name ?? '')}</div>
      <div ref={f.ref} class="note">
        This kind of item opens in a later build.
      </div>
    </div>
  );
}

export function ItemPage(props: PageProps<Extract<Route, { name: 'item' }>>) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const itemId = props.route.itemId;
  const load = (): void => {
    loadItem(itemId)
      .then((item) => setState({ kind: 'ready', item }))
      .catch((e: unknown) => {
        // a failed refresh keeps what is on screen
        setState((s) => (s.kind === 'ready' ? s : { kind: 'error', message: e instanceof Error ? e.message : 'Nothing came back from the server' }));
      });
  };
  useEffect(load, [itemId]);
  // back on the page (after playback, or a person's page): the item may have changed
  const wasActive = useRef(props.active);
  useEffect(() => {
    if (props.active && !wasActive.current) load();
    wasActive.current = props.active;
  }, [props.active]);

  const item = state.kind === 'ready' ? state.item : null;
  const isSeason = item?.Type === 'Season';
  useArrivalFocus(props, isSeason ? null : arrivalKey(props.pageKey, item), item !== null && !isSeason);

  if (state.kind === 'loading') return <PageMessage title="Loading…" />;
  if (state.kind === 'error') return <PageMessage title="Couldn't load this" body={state.message} failure />;
  const it = state.item;
  if (it.Type === 'Series') return <SeriesPage item={it} pageKey={props.pageKey} active={props.active} refresh={load} />;
  if (it.Type === 'Episode') return <EpisodePage item={it} pageKey={props.pageKey} active={props.active} refresh={load} />;
  if (it.Type === 'Person') return <PersonPage item={it} pageKey={props.pageKey} active={props.active} refresh={load} />;
  if (it.Type === 'BoxSet' && it.Id != null) return <CollectionView page={props} collectionId={it.Id} />;
  if (it.Type === 'Playlist' && it.Id != null) return <PlaylistView page={props} playlistId={it.Id} />;
  if (it.Type === 'Season' && it.SeriesId != null) return <SeasonView page={props} seriesId={it.SeriesId} seasonId={it.Id ?? undefined} />;
  if (FILM_TYPES.indexOf(it.Type ?? '') >= 0) return <FilmPage item={it} pageKey={props.pageKey} active={props.active} refresh={load} />;
  return <Later item={it} pageKey={props.pageKey} />;
}
