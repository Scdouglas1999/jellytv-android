/**
 * The collection (box set) page (media/collection/TallyCollectionPage.kt): the DetailHeader (kicker COLLECTION, the
 * name, `3 FILMS · 1985–1990 · [PG] · 4m 30s`, genres, tagline, overview) with PLAY, SHUFFLE, WATCHED, FAVORITE,
 * VIEW, MORE, SORT and FILTER, then one row of cards per type (MOVIES 3, SHOWS…), or one mixed grid when the view
 * options say so. OK opens a card, HOLD OK / MENU its item menu, PLAY plays it. The backdrop follows the focused card
 * (the collection's own while the header has focus).
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { useEffect, useRef, useState } from 'preact/hooks';
import { backdropUrl, logoUrl } from '../../api/images';
import { useArrivalFocus, type PageProps } from '../../app/page';
import { currentFocusKey, FocusGroup, setFocus, useFocusable } from '../../focus/focus';
import { IndicatorSquare } from '../../kit/Bits';
import { Button } from '../../kit/Button';
import { DetailHeader } from '../../kit/DetailHeader';
import { ItemCard } from '../../kit/ItemCard';
import { MediaRow } from '../../kit/MediaRow';
import { useSettledBackdrop } from '../../kit/settledBackdrop';
import { useKeyHandler } from '../../platform/keyRouter';
import { push, type Route } from '../../router/router';
import { Backdrop, Clock, DetailScroll, PageMessage, TopScrim, useHeaderReveal } from '../details/common';
import { DetailDialogs, cardMenu, type Dialog } from '../details/DetailDialogs';
import { loadItem, setFavorite, setPlayed } from '../details/detailsData';
import { isPlayable, openDetails, playItem } from '../details/navigate';
import { DEFAULT_FILTERS, countFilters, directionArrow, sortName } from '../library/libraryModel';
import { FilterPanel, LibraryPanel, SortPanel } from '../library/Panel';
import { useOkHold } from '../sports/useOkHold';
import {
  COLLECTION_SORTS,
  collectionQueue,
  loadCollectionDisplay,
  loadCollectionView,
  loadMixed,
  loadTypeRows,
  saveCollectionDisplay,
  saveCollectionView,
  type CollectionDisplay,
  type RowLoad,
} from './collectionData';
import { COLLECTION_TYPES, collectionMeta, typeTitle } from './pagesFormat';
import { ActionStrip, PagesEmpty, RowNote, StripControl, useStripFocus } from './shared';

/** Items the header's count, years and running time are read from (the first ones of each row). */
const META_SAMPLE = 100;
/** Card shapes by type (PagesItemCard): episodes landscape, the rest posters. */
const shapeOf = (type: string | null | undefined): 'poster' | 'landscape' => (type === 'Episode' ? 'landscape' : 'poster');

type Panel = 'sort' | 'filter' | 'view';

/** A TallyButton in the header's strip (scrolls the strip to it, and the page to its top). */
function StripButton(props: Parameters<typeof Button>[0]) {
  const onFocus = useStripFocus();
  return <Button {...props} onFocus={onFocus} />;
}

function CollectionContent(props: {
  page: PageProps;
  collection: BaseItemDto;
  refresh: () => void;
}) {
  const { page, collection } = props;
  const pk = page.pageKey;
  const id = collection.Id ?? '';
  const k = (name: string): string => `${pk}-${name}`;
  const toTop = useHeaderReveal();

  const [display, setDisplay] = useState<CollectionDisplay>(() => loadCollectionDisplay(id));
  const [separate, setSeparate] = useState(() => loadCollectionView().separateTypes);
  const [rows, setRows] = useState<Record<string, RowLoad>>({});
  const [mixed, setMixed] = useState<RowLoad>({ kind: 'loading' });
  const [token, setToken] = useState(0);
  const [panel, setPanel] = useState<{ kind: Panel; opener: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [focusedItem, setFocusedItem] = useState<BaseItemDto | null>(null);

  // the items, again whenever the sort, the filters or the layout change (and back from a film: watched marks)
  useEffect(() => {
    let live = true;
    if (separate) {
      setRows({});
      loadTypeRows(id, display, (type, row) => {
        if (live) setRows((r) => ({ ...r, [type]: row }));
      });
    } else {
      setMixed({ kind: 'loading' });
      loadMixed(id, display)
        .then((items) => live && setMixed({ kind: 'items', items }))
        .catch((e: unknown) => live && setMixed({ kind: 'error', message: e instanceof Error ? e.message : '' }));
    }
    return () => {
      live = false;
    };
  }, [id, JSON.stringify(display), separate, token]);
  const wasActive = useRef(page.active);
  useEffect(() => {
    if (page.active && !wasActive.current) {
      setToken((t) => t + 1);
      props.refresh();
    }
    wasActive.current = page.active;
  }, [page.active]);

  const changeDisplay = (next: CollectionDisplay): void => {
    saveCollectionDisplay(id, next);
    setDisplay(next);
  };

  // --- what is on the page -------------------------------------------------------------------------------------
  const typeRows = COLLECTION_TYPES.map((type) => ({ type, row: rows[type] ?? ({ kind: 'loading' } as RowLoad) }));
  const allLoaded = separate ? typeRows.every((r) => r.row.kind !== 'loading') : mixed.kind !== 'loading';
  const shownRows = typeRows.filter((r) => r.row.kind === 'error' || (r.row.kind === 'items' && r.row.items.length > 0));
  // rows still loading take no room until one has items (a type the box set does not have never shows)
  const empty = separate ? allLoaded && shownRows.length === 0 : mixed.kind === 'items' && mixed.items.length === 0;
  const sample = separate
    ? shownRows.reduce<BaseItemDto[]>((acc, r) => (r.row.kind === 'items' ? acc.concat(r.row.items.slice(0, META_SAMPLE)) : acc), [])
    : mixed.kind === 'items'
      ? mixed.items.slice(0, META_SAMPLE)
      : [];

  // cards by focus key: HOLD OK / MENU open the item menu, PLAY plays
  const cards = useRef(new Map<string, BaseItemDto>());
  cards.current.clear();
  const cardKey = (type: string, i: number): string => k(`r-${type}-${i}`);
  if (separate) shownRows.forEach((r) => r.row.kind === 'items' && r.row.items.forEach((item, i) => cards.current.set(cardKey(r.type, i), item)));
  else if (mixed.kind === 'items') mixed.items.forEach((item, i) => cards.current.set(k(`g-${i}`), item));

  const blocked = panel !== null || dialog !== null;
  useOkHold(
    () => {
      const key = currentFocusKey();
      const item = cards.current.get(key);
      if (item === undefined) return false;
      setDialog(cardMenu(item, key));
      return true;
    },
    !blocked,
    page.active,
  );
  useKeyHandler((key) => {
    if (blocked || (key !== 'play' && key !== 'playPause')) return false;
    const item = cards.current.get(currentFocusKey());
    if (item === undefined || !isPlayable(item)) return false;
    playItem(item);
    return true;
  }, page.active);

  // --- actions -------------------------------------------------------------------------------------------------
  const playAll = (shuffle: boolean): void => {
    void collectionQueue(id, display, shuffle).then((items) => {
      const ids = items.map((i) => i.Id).filter((x): x is string => x != null);
      const first = items[0];
      if (first?.Id == null) return;
      push({ name: 'player', itemId: first.Id, startMs: shuffle ? 0 : Math.floor((first.UserData?.PlaybackPositionTicks ?? 0) / 10_000), queue: ids });
    });
  };
  const toggle = (action: Promise<void>): void => {
    action.then(props.refresh).catch(() => undefined);
  };
  const played = collection.UserData?.Played === true;
  const favorite = collection.UserData?.IsFavorite === true;
  const filters = countFilters(display.filter, DEFAULT_FILTERS);
  const closePanel = (): void => {
    if (panel !== null) setFocus(panel.opener);
    setPanel(null);
  };

  const wanted = focusedItem !== null ? backdropUrl(focusedItem) : backdropUrl(collection);
  const backdrop = useSettledBackdrop(wanted);
  const onHeader = (): void => {
    setFocusedItem(null);
    toTop();
  };

  return (
    <>
      <Backdrop url={backdrop} />
      <div class="pages-scrim" />
      <DetailScrollHost>
        <DetailHeader
          kicker="Collection"
          title={collection.Name ?? ''}
          logoUrl={logoUrl(collection)}
          meta={collectionMeta(collection, sample)}
          genres={collection.Genres ?? []}
          tagline={collection.Taglines?.[0] ?? null}
          overview={collection.Overview}
          overviewKey={k('overview')}
          onOverview={() => setDialog({ kind: 'overview', title: collection.Name ?? '', text: collection.Overview ?? '', returnKey: k('overview') })}
          onOverviewFocus={onHeader}
        >
          <ActionStrip focusKey={k('actions')} primaryKey={k('play')} onFocusControl={onHeader}>
            <StripButton focusKey={k('play')} primary glyph="play" label="Play" onPress={() => playAll(false)} />
            <StripButton focusKey={k('shuffle')} glyph="shuffle" label="Shuffle" onPress={() => playAll(true)} />
            <StripButton focusKey={k('watched')} glyph={played ? 'eye' : 'eyeSlash'} label={played ? 'Watched' : 'Unwatched'} onPress={() => toggle(setPlayed(id, !played))} />
            <StripButton
              focusKey={k('favorite')}
              glyph="heart"
              label={favorite ? 'Favorited' : 'Favorite'}
              trailing={favorite ? <IndicatorSquare tone="accent" /> : undefined}
              onPress={() => toggle(setFavorite(id, !favorite))}
            />
            <StripButton focusKey={k('view')} glyph="sliders" label="View" onPress={() => setPanel({ kind: 'view', opener: k('view') })} />
            <StripButton focusKey={k('more')} glyph="ellipsis" label="More" onPress={() => setDialog({ kind: 'menu', item: collection, returnKey: k('more') })} />
            <StripControl focusKey={k('sort')} label={`Sort · ${sortName(display.sort.sort)}`} suffix={directionArrow(display.sort.direction)} onPress={() => setPanel({ kind: 'sort', opener: k('sort') })} />
            <StripControl focusKey={k('filter')} label={filters > 0 ? `Filter · ${filters}` : 'Filter'} onPress={() => setPanel({ kind: 'filter', opener: k('filter') })} />
          </ActionStrip>
        </DetailHeader>
        <div class="detail-rows pages-rows">
          {empty ? (
            <PagesEmpty title="Nothing in this collection" subtitle="No items match the current filter" />
          ) : separate ? (
            shownRows.map(({ type, row }) =>
              row.kind === 'error' ? (
                <RowNote key={type} title={typeTitle(type)} message={row.message !== '' ? row.message : "Couldn't load this"} failure={true} />
              ) : row.kind === 'items' ? (
                <MediaRow key={type} title={typeTitle(type)} count={row.items.length} focusKey={k(`row-${type}`)}>
                  {row.items.map((item, i) => (
                    <ItemCard key={item.Id} focusKey={cardKey(type, i)} item={item} shape={shapeOf(item.Type)} onPress={() => openDetails(item)} onFocus={setFocusedItem} />
                  ))}
                </MediaRow>
              ) : null,
            )
          ) : mixed.kind === 'error' ? (
            <RowNote title="Items" message={mixed.message !== '' ? mixed.message : "Couldn't load this"} failure={true} />
          ) : mixed.kind === 'items' ? (
            <MixedGrid pageKey={pk} items={mixed.items} onFocusItem={setFocusedItem} />
          ) : null}
        </div>
      </DetailScrollHost>
      {panel?.kind === 'sort' ? (
        <SortPanel pageKey={pk} options={COLLECTION_SORTS} current={display.sort} onChange={(sort) => changeDisplay({ ...display, sort })} onClose={closePanel} />
      ) : panel?.kind === 'filter' ? (
        <FilterPanel pageKey={pk} kinds={DEFAULT_FILTERS} current={display.filter} parentId={id} onChange={(filter) => changeDisplay({ ...display, filter })} onClose={closePanel} />
      ) : panel?.kind === 'view' ? (
        <LibraryPanel
          pageKey={pk}
          kicker="View options"
          rows={[
            {
              label: 'Separate types',
              value: separate ? 'On' : 'Off',
              valueAccent: separate,
              onPress: () => {
                saveCollectionView({ separateTypes: !separate });
                setSeparate(!separate);
              },
            },
          ]}
          initialIndex={0}
          onBack={closePanel}
          backLabel="Close"
        />
      ) : null}
      <DetailDialogs
        dialog={dialog}
        setDialog={setDialog}
        pageKey={pk}
        onChanged={() => {
          props.refresh();
          setToken((t) => t + 1);
        }}
      />
    </>
  );
}

/** The page's scroll area with the top scrim that appears once it has scrolled. */
function DetailScrollHost(props: { children: preact.ComponentChildren }) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <>
      <DetailScroll onScrolled={setScrolled}>{props.children}</DetailScroll>
      <TopScrim visible={scrolled} />
    </>
  );
}

/** Upstream's mixed grid ("separate types" off): rows of poster cards inside the page. */
function MixedGrid(props: { pageKey: string; items: BaseItemDto[]; onFocusItem: (item: BaseItemDto) => void }) {
  const f = useFocusable<HTMLDivElement>({ focusKey: props.pageKey + '-grid', saveLastFocusedChild: true });
  return (
    <div ref={f.ref} class="pages-grid">
      <FocusGroup focusKey={props.pageKey + '-grid'}>
        {props.items.map((item, i) => (
          <ItemCard key={item.Id} focusKey={`${props.pageKey}-g-${i}`} item={item} shape="poster" onPress={() => openDetails(item)} onFocus={props.onFocusItem} />
        ))}
      </FocusGroup>
    </div>
  );
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; item: BaseItemDto };

/**
 * A box set's page for `collectionId`, inside `page` (the `collection` route, or the `item` route when an item turns
 * out to be a box set). PLAY has focus when it opens (Android's LaunchedEffect on playFocus).
 */
export function CollectionView(props: { page: PageProps; collectionId: string; initial?: BaseItemDto }) {
  const [state, setState] = useState<State>(props.initial !== undefined ? { kind: 'ready', item: props.initial } : { kind: 'loading' });
  const load = (): void => {
    loadItem(props.collectionId)
      .then((item) => setState({ kind: 'ready', item }))
      .catch((e: unknown) => setState((s) => (s.kind === 'ready' ? s : { kind: 'error', message: e instanceof Error ? e.message : 'Nothing came back from the server' })));
  };
  useEffect(() => {
    if (props.initial === undefined) load();
  }, [props.collectionId]);
  const ready = state.kind === 'ready';
  useArrivalFocus(props.page, `${props.page.pageKey}-play`, ready);
  return (
    <div class="detail-page collection-page">
      {state.kind === 'loading' ? (
        <PageMessage title="Loading…" />
      ) : state.kind === 'error' ? (
        <PageMessage title="Couldn't load this" body={state.message} failure />
      ) : (
        <CollectionContent page={props.page} collection={state.item} refresh={load} />
      )}
      <Clock />
    </div>
  );
}

export function CollectionPage(props: PageProps<Extract<Route, { name: 'collection' }>>) {
  return <CollectionView page={props} collectionId={props.route.itemId} />;
}
