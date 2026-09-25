import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { backdropUrl } from '../../api/images';
import { artUrl } from '../../api/tally';
import type { TallyGame } from '../../api/tallyModels';
import { isFollowed, isLive } from '../../api/tallyModels';
import { useArrivalFocus, type PageProps } from '../../app/page';
import { currentFocusKey, focusExists, setFocus } from '../../focus/focus';
import { ItemCard } from '../../kit/ItemCard';
import { MediaRow } from '../../kit/MediaRow';
import { useSettledBackdrop } from '../../kit/settledBackdrop';
import { ScrollPage } from '../../kit/ScrollPage';
import { ToastHost } from '../../kit/Toast';
import { RecordingNoticeHost } from '../sports/RecordingNotice';
import { useKeyHandler } from '../../platform/keyRouter';
import type { Route } from '../../router/router';
import { DetailDialogs, cardMenu, type Dialog } from '../details/DetailDialogs';
import { isPlayable, openDetails, playItem } from '../details/navigate';
import { GameActionsDialog } from '../sports/GameActionsDialog';
import { addToMultiviewWithNotice, gameRoute, watchGame } from '../sports/sportsState';
import { useOkHold } from '../sports/useOkHold';
import { GameCard } from '../../sports/GameCard';
import { selectHomeGames } from '../../sports/homeRow';
import { libraries, tally } from '../../state/nav';
import { board, tallyUserSettings, useBoardPolling } from '../../state/sportsData';
import { formatTime } from '../../util/format';
import { useStore } from '../../util/store';
import { HomeHeader, type HomeFocus } from './HomeHeader';
import { homeRows, type RowState } from './homeData';
import './home.css';

/** The backdrop's box (home.css .home-backdrop): the width a game's backdrop art is asked for. */
const HOME_BACKDROP_W = 1400;

/** Card height used for LOADING… rows so nothing jumps when cards arrive (poster + label bar + focus room). */
const POSTER_ROW_HEIGHT = 317 + 64 + 14;

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  return <div class="home-clock">{formatTime(now)}</div>;
}

const gameKey = (game: TallyGame): string => 'home-game-' + game.id;
const itemKey = (row: string, item: BaseItemDto): string => `home-${row}-${item.Id ?? ''}`;

/** What a card on Home is, by focus key: the item menu, the game menu and the PLAY key look it up. */
type HomeCard = { kind: 'item'; item: BaseItemDto; row: string } | { kind: 'game'; game: TallyGame };

export function HomePage(props: PageProps<Extract<Route, { name: 'home' }>>) {
  const views = useStore(libraries);
  const plugin = useStore(tally);
  const currentBoard = useStore(board);
  const settings = useStore(tallyUserSettings);
  useBoardPolling(props.active);

  const specs = useMemo(() => (views === null ? [] : homeRows(views)), [views]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [focus, setFocusInfo] = useState<HomeFocus>(null);

  const load = (): void => {
    for (const spec of specs) {
      spec
        .load()
        .then((items) => setRows((r) => ({ ...r, [spec.key]: { kind: 'items', items } })))
        .catch(() => setRows((r) => ({ ...r, [spec.key]: { kind: 'error', message: 'Could not load this row.' } })));
    }
  };
  useEffect(load, [specs]);
  // back on Home (after playing something): progress and Next Up changed
  const [wasActive, setWasActive] = useState(props.active);
  useEffect(() => {
    if (props.active && !wasActive) load();
    setWasActive(props.active);
  }, [props.active]);

  const favorites = useMemo(() => new Set(settings?.favorites ?? []), [settings]);
  const teams = useMemo(() => new Set((settings?.favoriteTeams ?? []).map((t) => t.toUpperCase())), [settings]);
  const games = plugin.kind === 'available' ? selectHomeGames(currentBoard, favorites, teams, Date.now()) : [];
  const hideScores = settings?.hideScores === true;

  // the page settles (games known or no plugin, and the first library row loaded) before initial focus
  const gamesSettled = plugin.kind === 'absent' || plugin.kind === 'error' || (plugin.kind === 'available' && currentBoard !== null);
  const visibleRows = specs.filter((s) => {
    const r = rows[s.key];
    return r === undefined || r.kind !== 'items' || r.items.length > 0;
  });
  const firstRow = visibleRows[0];
  const firstRowReady = firstRow !== undefined && rows[firstRow.key]?.kind === 'items';
  // focus keys follow the game or item, not its place: a row that reorders (the board's sort, followed teams arriving
  // after the board, Continue Watching after playback) keeps focus on the same card instead of dropping it
  const firstRowState = firstRow !== undefined ? rows[firstRow.key] : undefined;
  const firstItem = firstRowState?.kind === 'items' ? firstRowState.items[0] : undefined;
  const target =
    games[0] !== undefined ? gameKey(games[0]) : firstRow !== undefined && firstItem !== undefined ? itemKey(firstRow.key, firstItem) : null;
  useArrivalFocus(props, target, gamesSettled && (games.length > 0 || firstRowReady));

  // --- the cards' menus (HOLD OK or MENU, as Android's long press) and the PLAY key ------------------------------
  const cards = useRef(new Map<string, HomeCard>());
  cards.current.clear();
  games.forEach((game) => cards.current.set(gameKey(game), { kind: 'game', game }));
  for (const spec of visibleRows) {
    const r = rows[spec.key];
    if (r?.kind === 'items') r.items.forEach((item) => cards.current.set(itemKey(spec.key, item), { kind: 'item', item, row: spec.key }));
  }
  const [dialog, setDialog] = useState<Dialog | null>(null);

  /**
   * A card leaves its row at once (Remove from continue watching; the rows reload from the server right after):
   * focus moves to the next card of the row, or the one before it, or the next row's first card.
   */
  const dropCard = (rowKey: string, item: BaseItemDto): void => {
    const state = rows[rowKey];
    if (state?.kind !== 'items') return;
    const index = state.items.findIndex((i) => i.Id === item.Id);
    const left = state.items.filter((i) => i.Id !== item.Id);
    const neighbor = left[Math.min(index, left.length - 1)];
    let next: string | null = neighbor !== undefined ? itemKey(rowKey, neighbor) : null;
    if (next === null) {
      const at = visibleRows.findIndex((s) => s.key === rowKey);
      const others = visibleRows.slice(at + 1).concat(visibleRows.slice(0, Math.max(0, at)).reverse());
      for (const spec of others) {
        const r = rows[spec.key];
        const first = r?.kind === 'items' ? r.items[0] : undefined;
        if (first !== undefined) {
          next = itemKey(spec.key, first);
          break;
        }
      }
      if (next === null && games[0] !== undefined) next = gameKey(games[0]);
    }
    setRows((r) => ({ ...r, [rowKey]: { kind: 'items', items: left } }));
    // after the menu has put focus back on the card that is leaving
    const target = next;
    window.setTimeout(() => setFocus(target ?? props.pageKey), 0);
  };
  const [gameMenu, setGameMenu] = useState<{ gameId: string; returnKey: string } | null>(null);
  const menuOpen = dialog !== null || gameMenu !== null;
  useOkHold(
    () => {
      const key = currentFocusKey();
      const card = cards.current.get(key);
      if (card === undefined) return false;
      if (card.kind === 'game') setGameMenu({ gameId: card.game.id, returnKey: key });
      else {
        const spec = specs.find((s) => s.key === card.row);
        const item = card.item;
        setDialog({
          ...cardMenu(item, key),
          continueWatching: spec?.continueWatching === true,
          onRemovedFromContinueWatching: () => dropCard(card.row, item),
        });
      }
      return true;
    },
    !menuOpen,
    props.active,
  );
  useKeyHandler((key) => {
    if ((key !== 'play' && key !== 'playPause') || menuOpen) return false;
    const card = cards.current.get(currentFocusKey());
    if (card?.kind !== 'item' || !isPlayable(card.item)) return false;
    playItem(card.item);
    return true;
  }, props.active);
  const menuGame = gameMenu !== null ? (games.find((g) => g.id === gameMenu.gameId) ?? null) : null;
  const closeGameMenu = (): void => {
    const back = gameMenu?.returnKey;
    setGameMenu(null);
    if (back !== undefined && focusExists(back)) setFocus(back);
  };
  // the game left the row while its menu was open
  useEffect(() => {
    if (gameMenu !== null && menuGame === null) closeGameMenu();
  }, [gameMenu !== null && menuGame === null]);

  const wanted = focus?.kind === 'item' ? backdropUrl(focus.item) : focus?.kind === 'game' && focus.game.backdropPath !== null ? artUrl(focus.game.backdropPath, HOME_BACKDROP_W) : null;
  const backdrop = useSettledBackdrop(wanted);

  return (
    <div class="home">
      {backdrop !== null ? (
        <div class="home-backdrop">
          <img key={backdrop} src={backdrop} alt="" />
        </div>
      ) : null}
      <HomeHeader focus={focus} />
      <Clock />
      <div class="home-rows">
        <ScrollPage>
          {games.length > 0 ? (
            <MediaRow title={games.some(isLive) ? 'Live now' : "Today's games"} count={games.length} focusKey="home-games">
              {games.map((g) => (
                <GameCard
                  key={g.id}
                  focusKey={gameKey(g)}
                  game={g}
                  hideScores={hideScores}
                  favorite={(g.watch !== null && favorites.has(g.watch.channelId)) || isFollowed(g, teams)}
                  followed={isFollowed(g, teams)}
                  sportsExtras={true}
                  onWatch={(game) => watchGame(game)}
                  onFocus={(game) => setFocusInfo({ kind: 'game', game, hideScores })}
                />
              ))}
            </MediaRow>
          ) : null}
          {visibleRows.map((spec) => {
            const state = rows[spec.key] ?? { kind: 'loading' };
            return (
              <MediaRow
                key={spec.key}
                focusKey={'home-row-' + spec.key}
                title={spec.title}
                count={state.kind === 'items' ? state.items.length : null}
                message={state.kind === 'loading' ? 'LOADING…' : state.kind === 'error' ? state.message : null}
                height={POSTER_ROW_HEIGHT}
              >
                {state.kind === 'items'
                  ? state.items.map((item) => (
                      <ItemCard
                        key={item.Id}
                        focusKey={itemKey(spec.key, item)}
                        item={item}
                        shape={spec.shape}
                        watchingRow={spec.watching}
                        onPress={() => openDetails(item)}
                        onFocus={(it) => setFocusInfo({ kind: 'item', item: it, rowTitle: spec.title })}
                      />
                    ))
                  : null}
              </MediaRow>
            );
          })}
        </ScrollPage>
      </div>
      {menuGame !== null ? (
        <GameActionsDialog
          game={menuGame}
          actions={{
            watch: gameRoute(menuGame) !== null ? () => watchGame(menuGame) : undefined,
            addToMultiview: menuGame.watch !== null && menuGame.watch.channelId !== '' ? () => addToMultiviewWithNotice(menuGame.watch?.channelId ?? '') : undefined,
            follow: true,
          }}
          hideScores={hideScores}
          favoriteTeams={teams}
          onDismiss={closeGameMenu}
        />
      ) : null}
      <DetailDialogs dialog={dialog} setDialog={setDialog} pageKey={props.pageKey} onChanged={load} />
      <ToastHost />
      <RecordingNoticeHost active={props.active} pageKey={props.pageKey} />
    </div>
  );
}
