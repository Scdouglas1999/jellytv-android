/**
 * The playlist page (media/playlist/TallyPlaylistPage.kt): a header (kicker PLAYLIST, the name, `4 ITEMS · 5m`, then
 * PLAY, SHUFFLE, MORE, SORT and FILTER) over the numbered list of its items: number, 16:9 still (progress, WATCHED
 * tick), title and mono meta, and at the right the move up / move down buttons (when this user may edit the playlist
 * and it shows in its own order, unfiltered) and MORE. OK on a row plays the playlist from it, HOLD OK / MENU (or
 * MORE) opens its item menu with Remove from playlist; PLAY plays from it. The backdrop follows the focused row.
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { useEffect, useRef, useState } from 'preact/hooks';
import { backdropUrl, itemImage } from '../../api/images';
import { useArrivalFocus, type PageProps } from '../../app/page';
import { currentFocusKey, focusExists, setFocus, useFocusable } from '../../focus/focus';
import { GlyphIcon } from '../../kit/Bits';
import { Button } from '../../kit/Button';
import type { GlyphName } from '../../kit/glyphs';
import { usePageScroll } from '../../kit/ScrollPage';
import { useSettledBackdrop } from '../../kit/settledBackdrop';
import { showToast, ToastHost } from '../../kit/Toast';
import { useKeyHandler } from '../../platform/keyRouter';
import { push, type Route } from '../../router/router';
import { resumePercent, tallyUppercase } from '../../util/format';
import { applyMove, playlistMeta, playlistRowMeta, rundownNumber } from '../collection/pagesFormat';
import { ActionStrip, PagesEmpty, StripControl, useStripFocus } from '../collection/shared';
import { Backdrop, Clock, DetailScroll, PageMessage, TopScrim, useHeaderReveal } from '../details/common';
import { DetailDialogs, type Dialog } from '../details/DetailDialogs';
import { loadItem } from '../details/detailsData';
import { isPlayable, openDetails } from '../details/navigate';
import { countFilters, directionArrow, sortName } from '../library/libraryModel';
import { FilterPanel, SortPanel } from '../library/Panel';
import { useOkHold } from '../sports/useOkHold';
import {
  PLAYLIST_FILTERS,
  PLAYLIST_SORTS,
  canEditPlaylist,
  loadPlaylistDisplay,
  loadPlaylistItems,
  moveInPlaylist,
  removeFromPlaylist,
  savePlaylistDisplay,
  type PlaylistDisplay,
} from './playlistData';
import './playlist.css';

/** The row's still (160x90dp) at the size it is drawn. */
const STILL_W = 256;
const STILL_H = 144;
/** Upstream's Playlist.MAX_SIZE: a play queue holds at most this many. */
const QUEUE_MAX = 100;

type Items = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; items: BaseItemDto[] };

function stillUrl(item: BaseItemDto): string | null {
  if (item.Id == null) return null;
  const thumb = item.ImageTags?.Thumb;
  if (thumb != null) return itemImage(item.Id, ImageType.Thumb, thumb, STILL_W, STILL_H);
  const primary = item.ImageTags?.Primary;
  return primary != null ? itemImage(item.Id, ImageType.Primary, primary, STILL_W, STILL_H) : null;
}

/** TallyIconButton: 40dp square, hairline border, the glyph; focused, its label hangs under it. Disabled: skipped. */
function IconButton(props: { focusKey: string; glyph: GlyphName; label: string; enabled?: boolean; onPress: () => void; onFocus?: () => void; onBlur?: () => void }) {
  const enabled = props.enabled !== false;
  const f = useFocusable<HTMLDivElement>({ focusKey: props.focusKey, focusable: enabled, onEnter: props.onPress, onFocus: props.onFocus, onBlur: props.onBlur, trackFocus: true });
  return (
    <div class="pl-icon-slot">
      <div ref={f.ref} class={'pl-icon' + (enabled ? '' : ' disabled')} onClick={enabled ? props.onPress : undefined}>
        <GlyphIcon name={props.glyph} />
      </div>
      {f.focused ? <div class="pl-caption mono-label">{tallyUppercase(props.label)}</div> : null}
    </div>
  );
}

/** One line of the rundown (PlaylistRow): a move-mode accent bar at its left while a move button has focus. */
function PlaylistRow(props: {
  pk: string;
  index: number;
  item: BaseItemDto;
  canMove: boolean;
  last: boolean;
  onPlay: () => void;
  onMore: () => void;
  onMove: (up: boolean) => void;
  onFocusItem: (item: BaseItemDto) => void;
}) {
  const { pk, index, item } = props;
  const page = usePageScroll();
  const row = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);
  const f = useFocusable<HTMLDivElement>({
    focusKey: `${pk}-row-${index}`,
    onEnter: props.onPlay,
    onFocus: () => {
      if (row.current !== null) page.reveal(row.current, 'nearest');
      props.onFocusItem(item);
    },
  });
  const [failed, setFailed] = useState<string | null>(null);
  const url = stillUrl(item);
  const played = item.UserData?.Played === true;
  const percent = resumePercent(item.UserData?.PlaybackPositionTicks ?? 0, item.RunTimeTicks ?? 0);
  const meta = playlistRowMeta(item);
  const buttonFocus = (isMove: boolean) => (): void => {
    setMoving(isMove);
    if (row.current !== null) page.reveal(row.current, 'nearest');
    props.onFocusItem(item);
  };
  return (
    <div ref={row} class={'pl-row' + (moving ? ' moving' : '')}>
      <div ref={f.ref} class="pl-surface" onClick={props.onPlay}>
        <div class="pl-number">{rundownNumber(index)}</div>
        <div class="pl-still">
          {url !== null && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : null}
          {!played && percent > 0 && percent < 100 ? (
            <div class="progress">
              <div style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          {played ? (
            <span class="watched">
              <GlyphIcon name="check" />
              <span>WATCHED</span>
            </span>
          ) : null}
        </div>
        <div class="pl-texts">
          <div class="title ellipsis">{item.Name ?? ''}</div>
          {meta !== '' ? <div class="meta ellipsis">{tallyUppercase(meta)}</div> : null}
        </div>
      </div>
      <div class="pl-buttons">
        {props.canMove ? (
          <>
            <IconButton focusKey={`${pk}-up-${index}`} glyph="arrowUp" label="Move up" enabled={index > 0} onPress={() => props.onMove(true)} onFocus={buttonFocus(true)} onBlur={() => setMoving(false)} />
            <IconButton focusKey={`${pk}-down-${index}`} glyph="arrowDown" label="Move down" enabled={!props.last} onPress={() => props.onMove(false)} onFocus={buttonFocus(true)} onBlur={() => setMoving(false)} />
          </>
        ) : null}
        <IconButton focusKey={`${pk}-more-${index}`} glyph="ellipsisVertical" label="More" onPress={props.onMore} onFocus={buttonFocus(false)} />
      </div>
    </div>
  );
}

function StripButton(props: Parameters<typeof Button>[0]) {
  const onFocus = useStripFocus();
  return <Button {...props} onFocus={onFocus} />;
}

function PlaylistContent(props: { page: PageProps; playlist: BaseItemDto; refresh: () => void }) {
  const { page, playlist } = props;
  const pk = page.pageKey;
  const id = playlist.Id ?? '';
  const k = (name: string): string => `${pk}-${name}`;
  const toTop = useHeaderReveal();
  const [display, setDisplay] = useState<PlaylistDisplay>(() => loadPlaylistDisplay(id));
  const [items, setItems] = useState<Items>({ kind: 'loading' });
  const [canEdit, setCanEdit] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'sort' | 'filter'; opener: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [focused, setFocused] = useState<BaseItemDto | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    void canEditPlaylist(id).then(setCanEdit);
  }, [id]);
  useEffect(() => {
    let live = true;
    loadPlaylistItems(id, display)
      .then((list) => live && setItems({ kind: 'ready', items: list }))
      .catch((e: unknown) => live && setItems((s) => (s.kind === 'ready' ? s : { kind: 'error', message: e instanceof Error ? e.message : '' })));
    return () => {
      live = false;
    };
  }, [id, JSON.stringify(display), token]);
  const reload = (): void => setToken((t) => t + 1);
  const wasActive = useRef(page.active);
  useEffect(() => {
    if (page.active && !wasActive.current) {
      reload();
      props.refresh();
    }
    wasActive.current = page.active;
  }, [page.active]);

  const list = items.kind === 'ready' ? items.items : [];
  // as upstream: once the items are in, the list takes focus (its first row), or PLAY when there is nothing in it
  useArrivalFocus(page, list.length > 0 ? k('row-0') : k('play'), items.kind !== 'loading');

  const filters = countFilters(display.filter, PLAYLIST_FILTERS);
  const canMove = canEdit && display.sort.sort === ItemSortBy.Default && filters === 0;

  // --- playing: the playlist from a row (upstream's PlaybackList with startIndex), or all of it shuffled -----------
  const play = (index: number, shuffle: boolean): void => {
    const playable = list.filter((i) => i.Id != null && isPlayable(i));
    let queue: BaseItemDto[];
    if (shuffle) {
      queue = playable.slice();
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = queue[i] as BaseItemDto;
        queue[i] = queue[j] as BaseItemDto;
        queue[j] = t;
      }
    } else {
      queue = list.slice(index).filter((i) => i.Id != null && isPlayable(i));
    }
    const first = queue[0];
    if (first?.Id == null) {
      showToast(list.length > 0 ? "These items can't be played here yet." : 'This playlist is empty.');
      return;
    }
    push({ name: 'player', itemId: first.Id, startMs: 0, queue: queue.slice(0, QUEUE_MAX).map((i) => i.Id as string) });
  };

  // --- item menus: HOLD OK / MENU on a row, or its MORE --------------------------------------------------------------
  const menuFor = (index: number, returnKey: string): Dialog | null => {
    const item = list[index];
    if (item === undefined) return null;
    return {
      kind: 'menu',
      item,
      goTo: () => openDetails(item),
      returnKey,
      onRemoveFromPlaylist: canEdit ? () => remove(index, item) : undefined,
    };
  };
  const remove = (index: number, item: BaseItemDto): void => {
    if (item.Id == null) return;
    const left = list.filter((_, i) => i !== index);
    setItems({ kind: 'ready', items: left });
    window.setTimeout(() => setFocus(left.length > 0 ? k(`row-${Math.min(index, left.length - 1)}`) : k('play')), 0);
    removeFromPlaylist(id, item.Id)
      .catch(() => showToast("Couldn't remove it from the playlist."))
      .finally(() => {
        reload();
        props.refresh();
      });
  };
  const move = (index: number, up: boolean): void => {
    const to = index + (up ? -1 : 1);
    if (to < 0 || to >= list.length) return;
    // the list shows the new order at once; focus follows the item (the same button on its new row)
    setItems({ kind: 'ready', items: applyMove(list, index, to, false) });
    const same = k(`${up ? 'up' : 'down'}-${to}`);
    const other = k(`${up ? 'down' : 'up'}-${to}`);
    const lands = (up && to > 0) || (!up && to < list.length - 1) ? same : other;
    window.setTimeout(() => setFocus(focusExists(lands) ? lands : k(`row-${to}`)), 0);
    moveInPlaylist(id, list, index, to)
      .catch(() => showToast("Couldn't move it."))
      .finally(reload);
  };

  const rowIndex = (key: string): number => {
    const m = /-(row|up|down|more)-(\d+)$/.exec(key);
    return m !== null && key.indexOf(pk + '-') === 0 ? Number(m[2]) : -1;
  };
  const blocked = panel !== null || dialog !== null;
  useOkHold(
    () => {
      const key = currentFocusKey();
      if (key.indexOf(k('row-')) !== 0) return false;
      const d = menuFor(rowIndex(key), key);
      if (d === null) return false;
      setDialog(d);
      return true;
    },
    !blocked,
    page.active,
  );
  useKeyHandler((key) => {
    if (blocked || (key !== 'play' && key !== 'playPause')) return false;
    const i = rowIndex(currentFocusKey());
    if (i < 0) return false;
    play(i, false);
    return true;
  }, page.active);

  const backdrop = useSettledBackdrop(focused !== null ? backdropUrl(focused) : null);
  const onHeader = (): void => {
    setFocused(null);
    toTop();
  };
  const closePanel = (): void => {
    if (panel !== null) setFocus(panel.opener);
    setPanel(null);
  };

  return (
    <>
      <Backdrop url={backdrop} />
      <div class="pages-scrim" />
      <ScrollHost>
        <div class="pl-header">
          <div class="pl-kicker mono-label">PLAYLIST</div>
          <div class="pl-title clamp-2">{playlist.Name ?? ''}</div>
          <div class="pl-meta mono-label">{tallyUppercase(playlistMeta(playlist, list))}</div>
          <div class="pl-actions">
            <ActionStrip focusKey={k('actions')} primaryKey={k('play')} onFocusControl={onHeader}>
              <StripButton focusKey={k('play')} primary glyph="play" label="Play" onPress={() => play(0, false)} />
              <StripButton focusKey={k('shuffle')} glyph="shuffle" label="Shuffle" onPress={() => play(0, true)} />
              <StripButton focusKey={k('more')} glyph="ellipsis" label="More" onPress={() => setDialog({ kind: 'menu', item: playlist, returnKey: k('more') })} />
              <StripControl focusKey={k('sort')} label={`Sort · ${sortName(display.sort.sort)}`} suffix={directionArrow(display.sort.direction)} onPress={() => setPanel({ kind: 'sort', opener: k('sort') })} />
              <StripControl focusKey={k('filter')} label={filters > 0 ? `Filter · ${filters}` : 'Filter'} onPress={() => setPanel({ kind: 'filter', opener: k('filter') })} />
            </ActionStrip>
          </div>
        </div>
        <div class="pl-rows">
          {items.kind === 'loading' ? (
            <div class="pl-loading mono-label">LOADING…</div>
          ) : items.kind === 'error' ? (
            <PagesEmpty title="Couldn't load this" subtitle={items.message !== '' ? items.message : 'Nothing came back from the server'} />
          ) : list.length === 0 ? (
            <PagesEmpty title="This playlist is empty" subtitle="No items match the current filter" />
          ) : (
            list.map((item, i) => (
              <PlaylistRow
                key={String(i)}
                pk={pk}
                index={i}
                item={item}
                canMove={canMove}
                last={i === list.length - 1}
                onPlay={() => play(i, false)}
                onMore={() => {
                  const d = menuFor(i, k(`more-${i}`));
                  if (d !== null) setDialog(d);
                }}
                onMove={(up) => move(i, up)}
                onFocusItem={setFocused}
              />
            ))
          )}
        </div>
      </ScrollHost>
      {panel?.kind === 'sort' ? (
        <SortPanel pageKey={pk} options={PLAYLIST_SORTS} current={display.sort} onChange={(sort) => changeDisplay({ ...display, sort })} onClose={closePanel} />
      ) : panel?.kind === 'filter' ? (
        <FilterPanel pageKey={pk} kinds={PLAYLIST_FILTERS} current={display.filter} parentId={id} onChange={(filter) => changeDisplay({ ...display, filter })} onClose={closePanel} />
      ) : null}
      <DetailDialogs
        dialog={dialog}
        setDialog={setDialog}
        pageKey={pk}
        onChanged={() => {
          reload();
          props.refresh();
        }}
      />
      <ToastHost />
    </>
  );

  function changeDisplay(next: PlaylistDisplay): void {
    savePlaylistDisplay(id, next);
    setDisplay(next);
  }
}

function ScrollHost(props: { children: preact.ComponentChildren }) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <>
      <DetailScroll onScrolled={setScrolled}>{props.children}</DetailScroll>
      <TopScrim visible={scrolled} />
    </>
  );
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; item: BaseItemDto };

/** A playlist's page for `playlistId`, inside `page` (the `playlist` route, or the `item` route for a playlist). */
export function PlaylistView(props: { page: PageProps; playlistId: string; initial?: BaseItemDto }) {
  const [state, setState] = useState<State>(props.initial !== undefined ? { kind: 'ready', item: props.initial } : { kind: 'loading' });
  const load = (): void => {
    loadItem(props.playlistId)
      .then((item) => setState({ kind: 'ready', item }))
      .catch((e: unknown) => setState((s) => (s.kind === 'ready' ? s : { kind: 'error', message: e instanceof Error ? e.message : 'Nothing came back from the server' })));
  };
  useEffect(() => {
    if (props.initial === undefined) load();
  }, [props.playlistId]);
  return (
    <div class="detail-page playlist-page">
      {state.kind === 'loading' ? (
        <PageMessage title="Loading…" />
      ) : state.kind === 'error' ? (
        <PageMessage title="Couldn't load this" body={state.message} failure />
      ) : (
        <PlaylistContent page={props.page} playlist={state.item} refresh={load} />
      )}
      <Clock />
    </div>
  );
}

export function PlaylistPage(props: PageProps<Extract<Route, { name: 'playlist' }>>) {
  return <PlaylistView page={props} playlistId={props.route.itemId} />;
}
