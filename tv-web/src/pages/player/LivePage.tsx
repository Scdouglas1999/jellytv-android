import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { absolute } from '../../api/tally';
import { DvrState } from '../../api/tallyDvr';
import { isLive, type TallyBoard, type TallyEvent, type TallyGame } from '../../api/tallyModels';
import type { PageProps } from '../../app/page';
import { currentFocusKey, setFocus } from '../../focus/focus';
import { IndicatorSquare } from '../../kit/Bits';
import { Button } from '../../kit/Button';
import { ToastHost } from '../../kit/Toast';
import { RecordingNoticeHost } from '../sports/RecordingNotice';
import { useKeyHandler } from '../../platform/keyRouter';
import { back, replace, type Route } from '../../router/router';
import { boardRows, gameForChannel } from '../../sports/boardOrganizer';
import { KeyHint, matchupTitle } from '../../sports/SportsBits';
import { board, onBoardEvent, tallyUserSettings, useBoardPolling } from '../../state/sportsData';
import { formatTime, tallyUppercase } from '../../util/format';
import { useStore } from '../../util/store';
import { GameActionsDialog } from '../sports/GameActionsDialog';
import { addToMultiviewWithNotice, channelRoute, gameRoute, watchGame } from '../sports/sportsState';
import { useOkHold } from '../sports/useOkHold';
import { BoxScoreOverlay, EventBanner, GameSwitcher, ScoreBug, switcherKey } from './liveOverlays';
import { TuneIn, useEngine } from './playerKit';

const BAR_MS = 5000;
/** The box score closes itself after this long without a key. */
const BOX_SCORE_LINGER_MS = 12_000;
/** An event banner stays this long. */
const BANNER_MS = 8000;
/** The switcher lists at most this many other games. */
const MAX_OTHERS = 12;

/** Other live games on real channels (not this one), in board order: followed teams and favorite channels first. */
function otherGames(current: TallyBoard | null, channelId: string, favorites: ReadonlySet<string>, teams: ReadonlySet<string>): TallyGame[] {
  const games = (current?.games ?? []).filter((g) => isLive(g) && g.watch !== null && g.watch.channelId !== channelId);
  return boardRows(games, favorites, true, teams)
    .reduce<TallyGame[]>((acc, r) => acc.concat(r.games), [])
    .slice(0, MAX_OTHERS);
}

/**
 * With no other game live, the looping channels (no game) are listed instead, as cards named after the channel
 * (CornerView.kt gamelessChannelGames: the same TallyGame with blank teams the Android app builds).
 */
function gamelessChannelGames(current: TallyBoard | null, channelId: string): TallyGame[] {
  if (current === null) return [];
  const blank = { id: '', abbr: '', name: '', shortName: '', location: '', logo: '', score: null, record: null, possession: false, winner: false, periods: [], color: '', altColor: '' };
  return current.channels
    .filter((c) => (c.gameId === null || c.gameId === '') && c.id !== channelId && c.hlsPath !== '')
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
    .map((c) => ({
      id: c.id,
      sport: '',
      league: '',
      name: c.name,
      start: '',
      state: 'pre',
      detail: '',
      period: 0,
      clock: '',
      home: blank,
      away: blank,
      lastPlay: null,
      downDistance: null,
      redZone: false,
      balls: null,
      strikes: null,
      outs: null,
      onFirst: false,
      onSecond: false,
      onThird: false,
      broadcasts: [],
      watch: { channelId: c.id, channelName: c.name, liveTvItemId: c.liveTvItemId, hlsPath: c.hlsPath, cardPath: c.cardPath, confidence: '' },
      backdropPath: null,
      recording: null,
    }));
}

const START_OVER_KEY = 'live-start-over';

/**
 * The live bar's WATCH FROM THE START while the game on screen is being recorded: a TallyButton labeled as Android's
 * (FROM THE START, the fast-backward glyph) at the end of the bar, as the start-over action sits at the end of the
 * Android TV controls row. It has focus while the bar is up; REWIND does the same from anywhere.
 */
function StartOverButton(props: { onPress: () => void }) {
  return (
    <span class="start-over">
      <Button focusKey={START_OVER_KEY} glyph="backwardFast" label="From the start" onPress={props.onPress} />
    </span>
  );
}

/**
 * A live channel from the Tally plugin: its continuous playlist (/JellyTV/Live/{id}.m3u8, signed, anonymous: the
 * same address multiview uses; the live ladder keeps it going when a source struggles), with the Android TV live
 * player's Tally overlays (TallyPlaybackPage.kt): the score bug; UP opens the box score, DOWN the "also on now" game
 * switcher (OK switches, HOLD for the game's actions); banners for scoring plays in other games. CH+/CH- step
 * through the board's channels; REWIND watches a game being recorded from the start.
 */
export function LivePage(props: PageProps<Extract<Route, { name: 'live' }>>) {
  const host = useRef<HTMLDivElement>(null);
  const player = useEngine(host);
  const current = useStore(board);
  const settings = useStore(tallyUserSettings);
  useBoardPolling(props.active);
  const hideScores = settings?.hideScores === true;
  const favorites = useMemo(() => new Set(settings?.favorites ?? []), [settings]);
  const teams = useMemo(() => new Set((settings?.favoriteTeams ?? []).map((t) => t.toUpperCase())), [settings]);

  const [bar, setBar] = useState(true);
  const barTimer = useRef(0);
  const [boxScore, setBoxScore] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [actionsGameId, setActionsGameId] = useState<string | null>(null);
  const [banner, setBanner] = useState<TallyEvent | null>(null);
  const [bannerOn, setBannerOn] = useState(false);

  const showBar = (): void => {
    setBar(true);
    window.clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => setBar(false), BAR_MS);
  };

  useEffect(() => {
    const engine = player.engine.current;
    if (engine === null) return;
    engine.stop();
    void engine.load({ url: absolute(props.route.hlsPath), kind: 'hls', live: true, startMs: 0 }).catch(() => undefined);
    showBar();
    return () => window.clearTimeout(barTimer.current);
  }, [props.route.hlsPath]);

  const games = current?.games ?? [];
  const byRoute = games.find((g) => g.id === props.route.gameId) ?? null;
  const game = gameForChannel(props.route.channelId, games) ?? (byRoute !== null && isLive(byRoute) ? byRoute : null);
  const others = otherGames(current, props.route.channelId, favorites, teams);
  const switcherGames = others.length > 0 ? others : gamelessChannelGames(current, props.route.channelId);
  const channels = current?.channels ?? [];
  const channelName = channels.find((c) => c.id === props.route.channelId)?.name ?? '';
  const recording = game?.recording ?? null;
  const startOver = recording !== null && recording.state === DvrState.RECORDING && recording.startOverPath !== null && recording.startOverPath !== '' ? recording.startOverPath : null;


  useEffect(() => {
    if (!boxScore) return undefined;
    const t = window.setTimeout(() => setBoxScore(false), BOX_SCORE_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [boxScore]);

  // if every other picture leaves the air while the switcher is up, close it
  useEffect(() => {
    if (switcher && switcherGames.length === 0) closeSwitcher();
  }, [switcher, switcherGames.length]);

  // scoring plays in other games (not this one, never while scores are hidden)
  const gameIdRef = useRef<string | null>(null);
  gameIdRef.current = game?.id ?? null;
  const hideRef = useRef(hideScores);
  hideRef.current = hideScores;
  useEffect(() => {
    if (!props.active) return undefined;
    return onBoardEvent((event) => {
      if (event.watch === null || event.gameId === gameIdRef.current || hideRef.current) return;
      setBanner(event);
      setBannerOn(true);
    });
  }, [props.active]);
  useEffect(() => {
    if (!bannerOn) return undefined;
    const t = window.setTimeout(() => setBannerOn(false), BANNER_MS);
    return () => window.clearTimeout(t);
  }, [bannerOn, banner?.id]);
  useEffect(() => {
    if (hideScores) setBannerOn(false);
  }, [hideScores]);

  const openSwitcher = (): void => {
    setSwitcher(true);
    setBar(false);
    window.setTimeout(() => {
      const first = switcherGames[0];
      if (first !== undefined) setFocus(switcherKey(first));
    }, 0);
  };
  function closeSwitcher(): void {
    setSwitcher(false);
    setFocus(props.pageKey);
  }

  /** WATCH FROM THE START (Android's StartOverAction): the recording so far takes the live player's place. */
  function watchFromTheStart(): void {
    if (startOver === null || game === null) return;
    replace({ name: 'startover', path: startOver, title: matchupTitle(game) });
  }

  const switchTo = (g: TallyGame): void => {
    setSwitcher(false);
    setActionsGameId(null);
    watchGame(g, true);
  };

  const step = (delta: number): void => {
    if (channels.length === 0) return;
    const i = channels.findIndex((c) => c.id === props.route.channelId);
    const next = channels[(i + delta + channels.length) % channels.length];
    const route = next !== undefined ? channelRoute(next) : null;
    if (route !== null) replace(route);
  };

  // HOLD OK on a switcher card: the game's actions (only while the switcher is up: elsewhere OK is the page's, to
  // bring the bar and press its button)
  useOkHold(
    () => {
      const key = currentFocusKey();
      if (!switcher || key.indexOf('lsw-') !== 0) return false;
      const g = switcherGames.find((x) => switcherKey(x) === key);
      if (g === undefined) return false;
      setActionsGameId(g.id);
      return true;
    },
    actionsGameId === null && switcher,
    props.active,
  );

  useKeyHandler((key) => {
    if (actionsGameId !== null) return false; // the menu's own handler (registered later) runs first
    if (boxScore) {
      // any key closes the box score; UP and BACK stop there, everything else also reaches the player
      setBoxScore(false);
      if (key === 'up' || key === 'back') return true;
    }
    if (switcher) {
      if (key === 'back' || key === 'up') {
        closeSwitcher();
        return true;
      }
      return false; // arrows and OK move through the cards
    }
    // the bar's FROM THE START button has focus while the bar is up: OK presses it (the focus system delivers it)
    if (key === 'enter' && bar && startOver !== null && currentFocusKey() === START_OVER_KEY) {
      showBar();
      return false;
    }
    switch (key) {
      case 'back':
        if (bar) {
          setBar(false);
          return true;
        }
        back();
        return true;
      case 'stop':
        back();
        return true;
      case 'up':
        if (game !== null) {
          setBoxScore(true);
          setBar(false);
        } else showBar();
        return true;
      case 'down':
        if (switcherGames.length > 0) openSwitcher();
        else showBar();
        return true;
      case 'channelUp':
        step(-1);
        return true;
      case 'channelDown':
        step(1);
        return true;
      case 'rewind':
        if (startOver !== null && game !== null) {
          watchFromTheStart();
          return true;
        }
        showBar();
        return true;
      default:
        showBar();
        return true;
    }
  }, props.active);

  const barUp = bar && !switcher && !boxScore;
  // the bar's one control takes focus while the bar is up; focus goes back to the page when it hides
  useEffect(() => {
    if (!props.active) return;
    if (barUp && startOver !== null) setFocus(START_OVER_KEY);
    else if (currentFocusKey() === START_OVER_KEY) setFocus(props.pageKey);
  }, [barUp, startOver !== null, props.active]);

  const actionsGame = actionsGameId !== null ? (switcherGames.find((g) => g.id === actionsGameId) ?? null) : null;
  const actionsIsGame = actionsGame !== null && others.length > 0;

  return (
    <div class="player live">
      <div ref={host} />
      <TuneIn key={props.route.channelId} title={props.route.title} firstFrame={player.firstFrame} error={player.error} />
      <ScoreBug game={game} hideScores={hideScores} visible={!boxScore} />
      {boxScore && game !== null ? <BoxScoreOverlay game={game} hideScores={hideScores} /> : null}
      {banner !== null ? <EventBanner event={banner} visible={bannerOn} onGone={() => setBanner((b) => (bannerOn ? b : null))} /> : null}
      {barUp ? (
        <>
          <div class="live-top">
            <div class="kicker mono-label">LIVE</div>
            <div class="title ellipsis">{props.route.title}</div>
            <div class="clock">{formatTime(new Date())}</div>
          </div>
          <div class="live-bar">
            <div class="row1">
              <span class="live-tag mono-label">
                <IndicatorSquare tone="accent" />
                LIVE
              </span>
              <span class="channel mono-label ellipsis">{tallyUppercase(channelName)}</span>
            </div>
            <div class="hints">
              {switcherGames.length > 0 ? <KeyHint keyName="DOWN" label="Games" /> : null}
              {game !== null ? <KeyHint keyName="UP" label="Box score" /> : null}
              <KeyHint keyName="CH +/−" label="Change channel" />
              <KeyHint keyName="BACK" label="Leave" />
              {startOver !== null ? <StartOverButton onPress={watchFromTheStart} /> : null}
            </div>
          </div>
        </>
      ) : null}
      {switcher ? <GameSwitcher games={switcherGames} hideScores={hideScores} favorites={favorites} teams={teams} onSwitch={switchTo} /> : null}
      {actionsGame !== null ? (
        <GameActionsDialog
          game={actionsIsGame ? actionsGame : null}
          channelName={actionsGame.watch?.channelName ?? actionsGame.name}
          actions={{
            watch: gameRoute(actionsGame) !== null ? () => switchTo(actionsGame) : undefined,
            addToMultiview: actionsGame.watch !== null ? () => addToMultiviewWithNotice(actionsGame.watch?.channelId ?? '') : undefined,
            follow: actionsIsGame,
          }}
          hideScores={hideScores}
          favoriteTeams={teams}
          onDismiss={() => {
            const id = actionsGameId;
            setActionsGameId(null);
            const g = switcherGames.find((x) => x.id === id);
            if (g !== undefined && switcher) setFocus(switcherKey(g));
          }}
        />
      ) : null}
      <ToastHost />
      <RecordingNoticeHost active={props.active} pageKey={props.pageKey} />
    </div>
  );
}
