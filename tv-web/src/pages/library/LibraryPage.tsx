import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { backdropUrl } from '../../api/images';
import { useSettledBackdrop } from '../../kit/settledBackdrop';
import type { PageProps } from '../../app/page';
import { currentFocusKey, setFocus } from '../../focus/focus';
import { useKeyHandler } from '../../platform/keyRouter';
import { push, type LibraryView, type Route } from '../../router/router';
import { DetailDialogs, cardMenu, type Dialog } from '../details/DetailDialogs';
import { openDetails } from '../details/navigate';
import { useOkHold } from '../sports/useOkHold';
import { FolderBody } from './FolderBody';
import { Clock, ControlButton, ControlsGroup, EmptyState, IconControl, LibraryHeader, LibraryTabs, LoadingMark } from './Header';
import { fetchGenres, fetchPage, fetchStudios, genreImages, playAllItems, positionOfLetter, randomItem, recommendedRows, type NameCell, type RecommendedRowSpec } from './libraryData';
import {
  TAB_LABELS,
  collectionSpec,
  countFilters,
  countText,
  directionArrow,
  filteredSpec,
  isFolder,
  isPlayable,
  jumpBarShown,
  jumpLetterFor,
  libraryNoun,
  libraryTabs,
  nameGridTypes,
  pageJump,
  singleSpec,
  sortName,
  tabSpec,
  VIEW_POSTER,
  type FolderSpec,
  type TabKind,
} from './libraryModel';
import { loadDisplay, loadTab, saveDisplay, saveTab, type DisplayInfo } from './libraryStore';
import { NameGrid, nameCardWidth } from './NameGrid';
import { FilterPanel, SortPanel, ViewPanel } from './Panel';
import { Recommended } from './Recommended';
import { useGridData, type GridSource } from './useGridData';
import type { GridHandle } from './VirtualGrid';
import './library.css';

type LibraryRoute = Extract<Route, { name: 'library' }>;

/** What a library route shows: tabs, one grid, or a Recommended row's whole list. */
type Mode =
  | { kind: 'tabbed'; tabs: TabKind[]; kicker: string }
  | { kind: 'single'; spec: FolderSpec; kicker: string }
  | { kind: 'row'; row: RecommendedRowSpec | null; kicker: string };

function modeFor(r: LibraryRoute): Mode {
  const ct = r.collectionType === '' ? null : r.collectionType;
  const view: LibraryView | undefined = r.view;
  if (view !== undefined) {
    switch (view.kind) {
      case 'genre':
      case 'studio':
        // upstream's name for the page: "Action Movies"
        return { kind: 'single', spec: filteredSpec(r.libraryId, ct, { kind: view.kind, id: view.id }), kicker: `${view.name} ${r.title}` };
      case 'folder':
        return { kind: 'single', spec: singleSpec(view.id, view.collectionType === '' ? ct : view.collectionType), kicker: view.name };
      case 'row':
        return { kind: 'row', row: recommendedRows(r.libraryId, ct).find((x) => x.key === view.rowKey) ?? null, kicker: view.title };
      case 'collection':
        return { kind: 'single', spec: collectionSpec(view.id), kicker: view.name };
    }
  }
  const tabs = libraryTabs(ct);
  return tabs.length > 0 ? { kind: 'tabbed', tabs, kicker: r.title } : { kind: 'single', spec: singleSpec(r.libraryId, ct), kicker: r.title };
}

/**
 * Opens an item from a library: a folder as a grid of its own; anything else where the Android app sends it
 * (details/navigate.ts: an episode or a season the rundown, a box set the collection page, a playlist its page, a person
 * the person page).
 */
function openItem(r: LibraryRoute, item: BaseItemDto): void {
  if (item.Id == null) return;
  if (isFolder(item.Type)) {
    push({ ...r, view: { kind: 'folder', id: item.Id, name: item.Name ?? '', collectionType: item.CollectionType ?? r.collectionType } });
  } else {
    openDetails(item, r);
  }
}

/** The focus key part of a jump-bar letter (FolderBody's JumpBar). */
function letterKeyPart(letter: string): string {
  return letter === '#' ? 'num' : letter;
}

function play(item: BaseItemDto | null, queue?: string[]): boolean {
  if (item === null || item.Id == null || !isPlayable(item.Type)) return false;
  push({ name: 'player', itemId: item.Id, startMs: Math.floor((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000), queue });
  return true;
}

/** Play all (the grid's order) or Shuffle: the playable items as one queue (upstream's PlaybackList). */
function playAll(items: BaseItemDto[]): void {
  const playable = items.filter((i) => i.Id != null && isPlayable(i.Type));
  const first = playable[0];
  if (first !== undefined) play(first, playable.map((i) => i.Id as string));
}

type NamesState = { kind: 'loading' } | { kind: 'error'; tab: TabKind; message: string } | { kind: 'ready'; tab: TabKind; cells: NameCell[] };

/**
 * A library in the Tally look (the Android app's TallyLibraryPage / TallyMusicLibrary / TallyFilteredCollection):
 * a fixed header (the library's name as an accent kicker with the count, the tab strip, the sort / filter / view /
 * random / play / shuffle controls at its right end), then the tab's content: Recommended rows, the grid with its
 * A-Z bar, or the genre and studio cards. The sort, filters, view options and the tab are remembered per library.
 */
export function LibraryPage(props: PageProps<LibraryRoute>) {
  const r = props.route;
  const pk = props.pageKey;
  const mode = useMemo(() => modeFor(r), [r]);
  const ct = r.collectionType === '' ? null : r.collectionType;
  const tabs = mode.kind === 'tabbed' ? mode.tabs : [];
  const [selected, setSelected] = useState(() => (tabs.length > 0 ? loadTab(r.libraryId, tabs.length) : 0));
  const tab: TabKind | null = tabs[selected] ?? null;
  const spec: FolderSpec | null = mode.kind === 'single' ? mode.spec : tab !== null ? tabSpec(r.libraryId, tab, ct) : null;

  // --- the grid's remembered sort, filters and view options -----------------------------------------------------
  const [displays, setDisplays] = useState<Record<string, DisplayInfo>>({});
  // read from storage once per grid, not on every render (a D-pad move re-renders the page)
  const display: DisplayInfo | null = useMemo(() => (spec === null ? null : (displays[spec.key] ?? loadDisplay(spec))), [spec?.key, displays]);
  const updateDisplay = (next: DisplayInfo): void => {
    if (spec === null) return;
    saveDisplay(spec, next);
    positions.current.set(spec.key, 0);
    setDisplays((d) => ({ ...d, [spec.key]: next }));
  };

  // --- the grid's items -------------------------------------------------------------------------------------------
  const sortFilter = display === null ? '' : JSON.stringify([display.sort, display.filter]);
  const source = useMemo<GridSource | null>(() => {
    if (mode.kind === 'row') {
      const row = mode.row;
      return row === null ? null : { key: 'row-' + row.key, load: (s, l) => row.load(s, l) };
    }
    if (spec === null || display === null) return null;
    const s = spec;
    const d = display;
    return { key: `${s.key}|${sortFilter}`, load: (start, limit) => fetchPage(s, d.sort, d.filter, start, limit) };
  }, [mode, spec?.key, sortFilter]);
  const data = useGridData(source);
  const total = data.status.kind === 'ready' ? data.status.total : 0;
  const grid = useRef<GridHandle>(null);
  const positions = useRef(new Map<string, number>());
  const gridKey = source?.key ?? '';
  const [focusedIndex, setFocusedIndex] = useState(0);
  useEffect(() => setFocusedIndex(positions.current.get(gridKey) ?? 0), [gridKey]);

  // --- genres and studios -----------------------------------------------------------------------------------------
  const [namesState, setNames] = useState<NamesState>({ kind: 'loading' });
  // a result belongs to its tab: the other tab's reads as loading
  const names: NamesState = namesState.kind !== 'loading' && namesState.tab === tab ? namesState : { kind: 'loading' };
  useEffect(() => {
    if (tab !== 'genres' && tab !== 'studios') return undefined;
    const t: TabKind = tab;
    let live = true;
    setNames({ kind: 'loading' });
    const types = nameGridTypes(ct);
    const width = nameCardWidth();
    const load = tab === 'genres' ? fetchGenres(r.libraryId, types) : fetchStudios(r.libraryId, types, width);
    load
      .then((cells) => {
        if (!live) return;
        setNames({ kind: 'ready', tab: t, cells });
        if (t === 'genres' && cells.length > 0) {
          void genreImages(r.libraryId, types, cells.map((c) => c.id), width).then((urls) => {
            if (live) setNames({ kind: 'ready', tab: t, cells: cells.map((c) => ({ ...c, imageUrl: urls[c.id] ?? null })) });
          });
        }
      })
      .catch((e: unknown) => live && setNames({ kind: 'error', tab: t, message: e instanceof Error ? e.message : '' }));
    return () => {
      live = false;
    };
  }, [tab, r.libraryId]);

  // --- backdrop (Recommended, and grids with "show backdrop") ------------------------------------------------------
  const [recItem, setRecItem] = useState<BaseItemDto | null>(null);
  const focusedItem = data.status.kind === 'ready' ? data.item(focusedIndex) : null;
  const backdropItem = tab === 'recommended' ? recItem : display?.view.showBackdrop === true ? focusedItem : null;
  const backdrop = useSettledBackdrop(backdropItem !== null ? backdropUrl(backdropItem) : null);

  // --- where focus goes when content arrives: on arrival, and after a tab is chosen --------------------------------
  const pending = useRef<string | null>('arrival');
  const tabKey = (i: number): string => `${pk}-tab-${i}`;
  const emptyTarget = (): string => (tabs.length > 0 ? tabKey(selected) : spec !== null && spec.sortOptions.length > 0 ? `${pk}-sort` : `${pk}-empty`);
  const contentReady = (target: string | null): void => {
    const p = pending.current;
    if (p === null) return;
    pending.current = null;
    if (!props.active) return;
    const cur = currentFocusKey();
    const unfocused = cur === '' || cur === pk || cur === 'SN:ROOT' || document.querySelector('[data-focused]') === null;
    // arrival: focus is on the page or where the page put it first (the tab strip, the first control)
    const ok = p === 'arrival' ? unfocused || cur.indexOf(pk + '-tab-') === 0 || cur === `${pk}-sort` : cur === p;
    if (ok) setFocus(target ?? emptyTarget());
  };
  useEffect(() => {
    if (tab === 'recommended') return;
    if (tab === 'genres' || tab === 'studios') {
      if (names.kind === 'ready') contentReady(names.cells.length > 0 ? `${pk}-n-0` : null);
      else if (names.kind === 'error') contentReady(null);
      return;
    }
    if (data.status.kind === 'ready') contentReady(total > 0 ? `${pk}-c-${Math.min(focusedIndex, total - 1)}` : null);
    else if (data.status.kind === 'error') contentReady(null);
  }, [data.status.kind, names.kind, tab, gridKey]);

  const selectTab = (i: number): void => {
    setSelected(i);
    saveTab(r.libraryId, i);
    setRecItem(null);
    pending.current = tabKey(i);
  };

  // --- coming back from an item or the player: progress and watched marks changed ---------------------------------
  const [refreshToken, setRefreshToken] = useState(0);
  const wasActive = useRef(props.active);
  useEffect(() => {
    if (props.active && !wasActive.current) {
      data.refresh();
      setRefreshToken((t) => t + 1);
    }
    wasActive.current = props.active;
  }, [props.active]);

  // --- dialogs ----------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<{ kind: 'sort' | 'filter' | 'view'; opener: string } | null>(null);
  const closeDialog = (): void => {
    // focus goes back to the control that opened the dialog (before the panel's rows go away)
    if (dialog !== null) setFocus(dialog.opener);
    setDialog(null);
  };

  // --- the item menu: HOLD OK or MENU on a card (Android's long press: ContextMenu.ForBaseItem) --------------------
  const [itemDialog, setItemDialog] = useState<Dialog | null>(null);
  /** The Recommended tab's cards by focus key (filled by Recommended as its rows load). */
  const recItems = useRef(new Map<string, BaseItemDto>());
  const cardItem = (key: string): BaseItemDto | null => {
    const grid = `${pk}-c-`;
    if (key.indexOf(grid) === 0) return data.item(Number(key.substring(grid.length)));
    return recItems.current.get(key) ?? null;
  };
  useOkHold(
    () => {
      const key = currentFocusKey();
      const item = cardItem(key);
      if (item === null || item.Id == null) return false;
      setItemDialog(cardMenu(item, key, () => openItem(r, item)));
      return true;
    },
    dialog === null && itemDialog === null,
    props.active,
  );

  // --- remote keys: BACK goes to the top of the grid first, PLAY plays, fast-forward / rewind page ------------------
  const inGrid = (): boolean => {
    const cur = currentFocusKey();
    return cur.indexOf(`${pk}-c-`) === 0 || cur.indexOf(`${pk}-j-`) === 0;
  };
  useKeyHandler(
    (key) => {
      // the user moved first: content arriving later does not take focus
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right' || key === 'enter' || key === 'back') pending.current = null;
      if (dialog !== null || itemDialog !== null) return false;
      const g = grid.current;
      // RIGHT from the grid's last column enters the A-Z bar on the focused card's letter
      const bar = document.querySelector('.page:not(.hidden) .lib-jump') !== null;
      if (key === 'right' && bar && g !== null && display !== null && inGrid() && currentFocusKey().indexOf(`${pk}-c-`) === 0) {
        const i = g.focusedIndex();
        const columns = display.view.type === 'grid' ? Math.max(1, display.view.columns) : 1;
        if (i % columns === columns - 1 || i === total - 1) {
          const item = data.item(i);
          setFocus(`${pk}-j-${letterKeyPart(jumpLetterFor(item?.SortName ?? item?.Name))}`);
          return true;
        }
      }
      if (key === 'back' && inGrid() && g !== null && g.focusedIndex() > 0) {
        g.jumpTo(0);
        return true;
      }
      if (key === 'play' || key === 'playPause') {
        if (inGrid() && g !== null) return play(data.item(g.focusedIndex()));
        if (tab === 'recommended') return play(cardItem(currentFocusKey()));
        return false;
      }
      if ((key === 'fastForward' || key === 'next' || key === 'rewind' || key === 'previous') && inGrid() && g !== null && display !== null) {
        const step = pageJump(total, display.view.type === 'grid' ? display.view.columns : 1);
        g.jumpTo(g.focusedIndex() + (key === 'fastForward' || key === 'next' ? step : -step));
        return true;
      }
      return false;
    },
    props.active,
  );

  // --- header -----------------------------------------------------------------------------------------------------
  let count: string | null = null;
  if (tab === 'genres' || tab === 'studios') {
    if (names.kind === 'ready') count = countText(names.cells.length, tab === 'genres' ? 'genre' : 'studio');
  } else if (data.status.kind === 'ready' && tab !== 'recommended') {
    const noun =
      mode.kind === 'row' || r.view?.kind === 'collection'
        ? libraryNoun(data.item(0)?.Type != null ? [data.item(0)?.Type as string] : undefined, ct)
        : spec !== null && display !== null
          ? (spec.noun ?? libraryNoun(display.filter.includeItemTypes ?? spec.initialFilter.includeItemTypes, spec.collectionType))
          : 'item';
    count = countText(total, noun);
  }

  const notEmpty = data.status.kind === 'ready' && total > 0;
  const controls =
    spec !== null && display !== null ? (
      <ControlsGroup pageKey={pk}>
        {spec.sortOptions.length > 0 ? (
          <ControlButton
            focusKey={`${pk}-sort`}
            label={`Sort · ${sortName(display.sort.sort)}`}
            suffix={directionArrow(display.sort.direction)}
            maxLabel={320}
            onPress={() => setDialog({ kind: 'sort', opener: `${pk}-sort` })}
          />
        ) : null}
        {spec.filterOptions.length > 0 ? (
          <ControlButton
            focusKey={`${pk}-filter`}
            label={countFilters(display.filter, spec.filterOptions) > 0 ? `Filter · ${countFilters(display.filter, spec.filterOptions)}` : 'Filter'}
            onPress={() => setDialog({ kind: 'filter', opener: `${pk}-filter` })}
          />
        ) : null}
        <ControlButton focusKey={`${pk}-view`} label="View" onPress={() => setDialog({ kind: 'view', opener: `${pk}-view` })} />
        <IconControl
          glyph="dice"
          label="Random"
          focusKey={`${pk}-random`}
          enabled={notEmpty}
          captionAtEnd={!spec.playEnabled}
          onPress={() => {
            void randomItem(spec, display.filter).then((item) => item !== null && openItem(r, item));
          }}
        />
        {spec.playEnabled ? (
          <IconControl
            glyph="play"
            label="Play"
            focusKey={`${pk}-play`}
            enabled={notEmpty}
            onPress={() => {
              void playAllItems(spec, display.sort, display.filter, false).then(playAll);
            }}
          />
        ) : null}
        {spec.playEnabled ? (
          <IconControl
            glyph="shuffle"
            label="Shuffle"
            focusKey={`${pk}-shuffle`}
            enabled={notEmpty}
            captionAtEnd
            onPress={() => {
              void playAllItems(spec, display.sort, display.filter, true).then(playAll);
            }}
          />
        ) : null}
      </ControlsGroup>
    ) : null;

  // --- body -------------------------------------------------------------------------------------------------------
  let body: preact.ComponentChildren;
  if (tab === 'recommended') {
    body = (
      <Recommended
        pageKey={pk}
        libraryId={r.libraryId}
        collectionType={ct}
        refreshToken={refreshToken}
        onFocusItem={setRecItem}
        onReady={(key) => contentReady(key)}
        cardItems={recItems.current}
        onOpen={(item) => openItem(r, item)}
        onViewAll={(row) => push({ ...r, view: { kind: 'row', rowKey: row.key, title: row.title } })}
      />
    );
  } else if (tab === 'genres' || tab === 'studios') {
    body =
      names.kind === 'loading' ? (
        <LoadingMark />
      ) : names.kind === 'error' ? (
        <EmptyState focusKey={`${pk}-empty`} title="Couldn't load this" subtitle={names.message !== '' ? names.message : 'Nothing came back from the server'} />
      ) : names.cells.length === 0 ? (
        <EmptyState focusKey={`${pk}-empty`} title="No results" subtitle="There is nothing in here yet." />
      ) : (
        <NameGrid
          pageKey={pk}
          cells={names.cells}
          onOpen={(cell) => push({ ...r, view: { kind: tab === 'genres' ? 'genre' : 'studio', id: cell.id, name: cell.name } })}
        />
      );
  } else if (data.status.kind === 'loading') {
    body = <LoadingMark />;
  } else if (data.status.kind === 'error') {
    body = <EmptyState focusKey={`${pk}-empty`} title="Couldn't load this" subtitle={data.status.message} />;
  } else if (total === 0) {
    const filtered = spec !== null && display !== null && countFilters(display.filter, spec.filterOptions) > 0;
    body = <EmptyState focusKey={`${pk}-empty`} title="No results" subtitle={filtered ? 'Nothing matches these filters.' : 'There is nothing in here yet.'} />;
  } else {
    const view = display?.view ?? VIEW_POSTER;
    body = (
      <FolderBody
        key={`${gridKey}|${JSON.stringify(view)}`}
        pageKey={pk}
        view={view}
        total={total}
        item={data.item}
        ensure={data.ensure}
        jumpBar={spec !== null && spec.jumpBar && display !== null && jumpBarShown(display.sort.sort, total)}
        kicker={mode.kicker}
        focusedIndex={focusedIndex}
        initialIndex={positions.current.get(gridKey) ?? 0}
        handle={grid}
        onFocusIndex={(i) => {
          positions.current.set(gridKey, i);
          setFocusedIndex(i);
        }}
        onOpen={(_, item) => openItem(r, item)}
        onLetter={(letter) => {
          if (spec === null || display === null) return;
          void positionOfLetter(spec, display.sort, display.filter, letter, total).then((i) => {
            if (i >= 0) grid.current?.jumpTo(i);
          });
        }}
      />
    );
  }

  return (
    <div class="lib">
      {backdrop !== null ? (
        <div class="lib-backdrop">
          <img key={backdrop} src={backdrop} alt="" />
        </div>
      ) : null}
      <LibraryHeader
        kicker={mode.kicker}
        count={count}
        tabs={tabs.length > 0 ? <LibraryTabs pageKey={pk} labels={tabs.map((t) => TAB_LABELS[t])} selected={selected} onSelect={selectTab} /> : null}
        controls={controls}
      />
      <Clock />
      <div class="lib-body">
        {body}
      </div>
      {dialog !== null && spec !== null && display !== null ? (
        dialog.kind === 'sort' ? (
          <SortPanel pageKey={pk} options={spec.sortOptions} current={display.sort} onChange={(sort) => updateDisplay({ ...display, sort })} onClose={closeDialog} />
        ) : dialog.kind === 'filter' ? (
          <FilterPanel pageKey={pk} kinds={spec.filterOptions} current={display.filter} parentId={spec.itemId} onChange={(filter) => updateDisplay({ ...display, filter })} onClose={closeDialog} />
        ) : (
          <ViewPanel pageKey={pk} current={display.view} defaults={spec.defaultView} onChange={(view) => updateDisplay({ ...display, view })} onClose={closeDialog} />
        )
      ) : null}
      <DetailDialogs
        dialog={itemDialog}
        setDialog={setItemDialog}
        pageKey={pk}
        onChanged={() => {
          data.refresh();
          setRefreshToken((t) => t + 1);
        }}
      />
    </div>
  );
}

