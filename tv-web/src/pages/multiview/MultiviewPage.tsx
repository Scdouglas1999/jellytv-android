import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { absolute, artUrl } from '../../api/tally';
import { isLive, type TallyGame, type TallyTeam } from '../../api/tallyModels';
import { app } from '../../app/context';
import { useArrivalFocus, type PageProps } from '../../app/page';
import { currentFocusKey, focusExists, setFocus, useFocusable } from '../../focus/focus';
import { LabelBar, RowHeader } from '../../kit/Bits';
import { offsetWithin, reveal } from '../../kit/scroll';
import { ToastHost } from '../../kit/Toast';
import { RecordingNoticeHost } from '../sports/RecordingNotice';
import { useKeyHandler } from '../../platform/keyRouter';
import type { EngineEvents, PlayerEngine } from '../../player/engine';
import { createHtml5Engine } from '../../player/html5Engine';
import { back, push, type Route } from '../../router/router';
import { boardRows, gameForChannel } from '../../sports/boardOrganizer';
import { EmptyState } from '../../sports/SportsBits';
import { board, tallyUserSettings, useBoardPolling } from '../../state/sportsData';
import { gameStatusLabel, tallyUppercase } from '../../util/format';
import { readJson, writeJson } from '../../util/storage';
import { useStore } from '../../util/store';
import { GameActionsDialog } from '../sports/GameActionsDialog';
import { MULTIVIEW_MAX, addToMultiview, channelRoute, multiviewQueue, removeFromMultiview, replaceInMultiview } from '../sports/sportsState';
import { useOkHold } from '../sports/useOkHold';
import { defaultLayout, multiviewDecoders, playingTiles, tileFocusMap, tileSlots, type FocusTarget, type MultiviewLayout } from './multiviewLayout';
import './multiview.css';

/** One video slot: a queued channel joined with the board (MultiviewTile). */
interface Tile {
  channelId: string;
  name: string;
  hlsUrl: string | null;
  cardUrl: string | null;
  game: TallyGame | null;
}

/** One row of the swap-in rail: a channel, with the live game it is showing when there is one. */
interface BenchEntry {
  channelId: string;
  name: string;
  game: TallyGame | null;
}

const LAYOUT_KEY = 'tally.multiview.layout';
const MAX_BENCH = 12;
const RETRY_MS = 3000;
const MAX_RETRIES = 5;

/** The stage (1920 − margins − the 24dp gap − the 320dp rail, inside the 3dp focus room) at 1080p. */
const STAGE_W = 1920 - 2 * 77 - 38 - 512 - 2 * 5;
const STAGE_H_WITH_HINT = 1080 - 2 * 43 - 19 - 32 - 2 * 5;

const tileKey = (i: number): string => 'mv-tile-' + String(i);
const railKey = (i: number): string => 'mv-rail-' + String(i);

/** "IND 7 · KC 0 · 8:25 1ST": only for a live game when scores are shown. */
function tileScoreLine(game: TallyGame | null, hideScores: boolean): string | null {
  if (game === null || !isLive(game) || hideScores) return null;
  const away = `${game.away.abbr} ${game.away.score === null ? '–' : String(game.away.score)}`;
  const home = `${game.home.abbr} ${game.home.score === null ? '–' : String(game.home.score)}`;
  const detail = game.detail.replace(' - ', ' ');
  return [away, home, detail].filter((x) => x !== '').join(' · ');
}

interface TilePlayback {
  buffering: boolean;
  error: string | null;
}

/**
 * The picture of one tile: its own <video> engine while it has a decoder (`playing`), retried a few times when the
 * stream fails; muted unless it holds the audio. Without a decoder the channel's live card stands in.
 */
/** The number of tiles this TV model could play at once, per model ("tally.multiview.decoders.<model>"). */
const DECODERS_KEY = 'tally.multiview.decoders.';

/** Wait before a tile takes the TV's decoder over from another tile (see useTilePlayer). */
const TV_HANDOVER_MS = 500;
/** A tile whose picture has not moved this long is started again. */
const STALL_MS = 12_000;

function useTilePlayer(
  host: { current: HTMLDivElement | null },
  url: string | null,
  playing: boolean,
  audio: boolean,
  onDecoderTrouble: () => void,
): TilePlayback {
  const trouble = useRef(onDecoderTrouble);
  trouble.current = onDecoderTrouble;
  const [state, setState] = useState<TilePlayback>({ buffering: true, error: null });
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const mute = (): void => {
    const video = host.current?.querySelector('video');
    if (video !== null && video !== undefined) {
      video.muted = !audioRef.current;
      video.volume = 1;
    }
  };
  useEffect(() => {
    setState({ buffering: true, error: null });
    const el = host.current;
    if (!playing || url === null || el === null) return undefined;
    let engine: PlayerEngine | null = null;
    let retries = 0;
    let timer = 0;
    let alive = true;
    let lastProgress = Date.now();
    const failed = (): void => {
      if (!alive) return;
      lastProgress = Date.now();
      if (retries >= MAX_RETRIES) {
        setState({ buffering: false, error: 'Stream unavailable' });
        return;
      }
      retries++;
      window.clearTimeout(timer);
      // give the decoder back now; the next try starts after the pause (a TV hands it over slowly)
      engine?.destroy();
      engine = null;
      timer = window.setTimeout(start, RETRY_MS);
    };
    const events: EngineEvents = {
      state: (s) => {
        if (!alive) return;
        if (s === 'playing') {
          retries = 0;
          setState({ buffering: false, error: null });
        } else if (s === 'buffering' || s === 'loading') {
          setState({ buffering: true, error: null });
        }
      },
      time: () => {
        lastProgress = Date.now();
      },
      firstFrame: () => undefined,
      error: () => {
        // MEDIA_ERR_DECODE: the decoder was taken away (seen on the emulator with a second tile)
        if (el.querySelector('video')?.error?.code === 3) trouble.current();
        failed();
      },
    };
    function start(): void {
      if (!alive || url === null || el === null) return;
      engine?.destroy();
      lastProgress = Date.now();
      engine = createHtml5Engine(el, events, app.shell.bundleBase, 'html5');
      mute();
      void engine.load({ url, kind: 'hls', live: true, startMs: 0 }).catch(failed);
    }
    // A TV's decoder is handed from the tile that had it to this one: the Tizen runtime does not always release it at
    // once, and a <video> started too early waits forever without an error (measured on the emulator). Start a moment
    // later on TVs, and count a picture that has not moved for STALL_MS as a failure (it is started again).
    timer = window.setTimeout(start, app.platform.name === 'browser' ? 0 : TV_HANDOVER_MS);
    const watchdog = window.setInterval(() => {
      if (alive && Date.now() - lastProgress > STALL_MS) {
        // a picture that never moves while other tiles play: the TV has fewer decoders than tiles playing
        trouble.current();
        failed();
      }
    }, 2000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(watchdog);
      engine?.destroy();
    };
  }, [playing, url]);
  useEffect(mute, [audio]);
  return state;
}

function TileView(props: {
  index: number;
  tile: Tile;
  slot: { x: number; y: number; width: number };
  audio: boolean;
  playing: boolean;
  hideScores: boolean;
  onFocus: (index: number) => void;
  onOk: (index: number) => void;
  onArrow: (direction: string) => boolean;
  onDecoderTrouble: () => void;
}) {
  const { tile } = props;
  const picture = useRef<HTMLDivElement>(null);
  const [cardFailed, setCardFailed] = useState(false);
  const playback = useTilePlayer(picture, tile.hlsUrl, props.playing, props.audio, props.onDecoderTrouble);
  const f = useFocusable<HTMLDivElement>({
    focusKey: tileKey(props.index),
    onEnter: () => props.onOk(props.index),
    onFocus: () => props.onFocus(props.index),
    onArrow: props.onArrow,
  });
  const status = !props.playing ? null : playback.error !== null ? playback.error : tile.hlsUrl === null || playback.buffering ? 'Buffering…' : null;
  const trailing = tileScoreLine(tile.game, props.hideScores);
  return (
    <div
      ref={f.ref}
      class="mv-tile"
      style={{ left: `${props.slot.x}px`, top: `${props.slot.y}px`, width: `${props.slot.width}px` }}
      onClick={() => props.onOk(props.index)}
    >
      <div class="picture" style={{ height: `${(props.slot.width * 9) / 16}px` }}>
        {!props.playing && tile.cardUrl !== null && !cardFailed ? <img class="card-still" src={tile.cardUrl} alt="" onError={() => setCardFailed(true)} /> : null}
        <div ref={picture} class="video-host" />
        {status !== null ? <div class={'status mono-label' + (playback.error !== null ? ' failed' : '')}>{tallyUppercase(status)}</div> : null}
      </div>
      <LabelBar text={tile.name !== '' ? tile.name : 'Unknown channel'} live={tile.game !== null && isLive(tile.game)}>
        {trailing !== null ? <span class="trailing mono-label">{tallyUppercase(trailing)}</span> : null}
      </LabelBar>
      <span class={'audio-tag mono-label' + (props.audio ? ' on' : '')}>{props.audio ? 'AUDIO' : 'MUTED'}</span>
    </div>
  );
}

function SwapTeamLine(props: { team: TallyTeam; hideScores: boolean }) {
  return (
    <div class="team">
      <span class="name ellipsis">{props.team.shortName !== '' ? props.team.shortName : props.team.abbr}</span>
      <span class="score">{props.hideScores || props.team.score === null ? '–' : String(props.team.score)}</span>
    </div>
  );
}

/** A compact game row of the swap-in rail: league + clock, then two team lines (or CHANNEL and the name). */
function SwapInRow(props: { index: number; entry: BenchEntry; hideScores: boolean; onPress: () => void; onFocusRow: (el: HTMLElement) => void; onArrow: (d: string) => boolean }) {
  const { entry } = props;
  const f = useFocusable<HTMLDivElement>({
    focusKey: railKey(props.index),
    onEnter: props.onPress,
    onFocus: () => {
      if (f.ref.current !== null) props.onFocusRow(f.ref.current);
    },
    onArrow: props.onArrow,
  });
  const game = entry.game;
  return (
    <div ref={f.ref} class="swap-row" onClick={props.onPress}>
      {game === null ? (
        <>
          <div class="mono-label muted">CHANNEL</div>
          <div class="channel-name clamp-2">{entry.name}</div>
        </>
      ) : (
        <>
          <div class="strip">
            <span class="mono-label muted">{game.league.toUpperCase()}</span>
            <span class="mono-label status">{gameStatusLabel(game)}</span>
          </div>
          <SwapTeamLine team={game.away} hideScores={props.hideScores} />
          <SwapTeamLine team={game.home} hideScores={props.hideScores} />
        </>
      )}
    </div>
  );
}

/** The width a tile's live card is asked for: an equal-grid tile's (half the screen). */
const TILE_CARD_W = 960;

/**
 * Multiview (TallyMultiviewPage.kt): up to four live channels, a swap-in rail, audio that follows the focused tile.
 * OK promotes a tile into the large slot, or returns the large tile to equal tiles; HOLD opens the tile's actions
 * (watch full screen, follow its teams, hide scores, remove). As many tiles play video as the TV has decoders for
 * (a browser: all four); the others show the channel's live card until they get the audio.
 */
export function MultiviewPage(props: PageProps<Extract<Route, { name: 'multiview' }>>) {
  const current = useStore(board);
  const settings = useStore(tallyUserSettings);
  const queue = useStore(multiviewQueue);
  useBoardPolling(props.active);
  const hideScores = settings?.hideScores === true;
  const teams = useMemo(() => new Set((settings?.favoriteTeams ?? []).map((t) => t.toUpperCase())), [settings]);
  const favorites = useMemo(() => new Set(settings?.favorites ?? []), [settings]);

  const tiles: Tile[] = queue.map((id) => {
    const channel = current?.channels.find((c) => c.id === id) ?? null;
    const game = current !== null ? gameForChannel(id, current.games) : null;
    return {
      channelId: id,
      name: channel?.name ?? game?.watch?.channelName ?? '',
      hlsUrl: channel !== null && channel.hlsPath !== '' ? absolute(channel.hlsPath) : null,
      cardUrl: channel !== null && channel.cardPath !== '' ? artUrl(channel.cardPath, TILE_CARD_W) : null,
      game,
    };
  });

  // live games first (board order), then every other channel, so the rail is useful outside game time too
  const bench: BenchEntry[] = useMemo(() => {
    const games = current?.games ?? [];
    const live: BenchEntry[] = [];
    for (const row of boardRows(games, favorites, true, teams)) {
      for (const g of row.games) {
        if (!isLive(g) || g.watch === null || g.watch.channelId === '') continue;
        if (live.some((e) => e.channelId === g.watch?.channelId)) continue;
        live.push({ channelId: g.watch.channelId, name: g.watch.channelName, game: g });
      }
    }
    const others = (current?.channels ?? []).filter((c) => !live.some((e) => e.channelId === c.id)).map((c) => ({ channelId: c.id, name: c.name, game: null }));
    return live.concat(others).filter((e) => queue.indexOf(e.channelId) < 0).slice(0, MAX_BENCH);
  }, [current, favorites, teams, queue]);

  const [audioIndex, setAudioIndex] = useState(0);
  const [layoutChoice, setLayoutChoice] = useState<MultiviewLayout | null>(() => {
    const saved = readJson<string>(LAYOUT_KEY);
    return saved === 'equal' || saved === 'focus' ? saved : null;
  });
  const [bigIndex, setBigIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const lastTile = useRef(0);
  const [actionsChannel, setActionsChannel] = useState<string | null>(null);
  const railScroller = useRef<HTMLDivElement>(null);

  const layout = layoutChoice ?? defaultLayout(tiles.length);
  const big = tiles.length === 0 ? 0 : Math.min(bigIndex, tiles.length - 1);
  const audio = tiles.length === 0 ? 0 : Math.min(audioIndex, tiles.length - 1);
  const slots = tileSlots(tiles.length, layout, big, STAGE_W, STAGE_H_WITH_HINT);
  // decoders: what this TV model showed before, else the platform's guess; a set that cannot play the tiles it
  // was given drops to one (remembered for the model, so it happens once)
  const decoderKey = DECODERS_KEY + app.platform.model();
  const [decoders, setDecoders] = useState(() => multiviewDecoders(app.platform.name, readJson<number>(decoderKey), app.platform.tizenVersion()));
  const playing = playingTiles(tiles.length, audio, props.active ? decoders : 0);
  const playingCount = playing.filter((p) => p).length;
  const onDecoderTrouble = (): void => {
    if (playingCount < 2 || decoders <= 1) return;
    writeJson(decoderKey, 1);
    setDecoders(1);
  };

  // keep the TV awake while tiles play
  const anyPlaying = playing.some((p) => p);
  useEffect(() => {
    app.platform.keepAwake(anyPlaying);
    return () => app.platform.keepAwake(false);
  }, [anyPlaying]);

  const chooseLayout = (next: MultiviewLayout): void => {
    setLayoutChoice(next);
    writeJson(LAYOUT_KEY, next);
  };

  /** OK on a tile: in focus, the large tile returns to equal tiles; any other tile becomes the large one. */
  const onTileOk = (index: number): void => {
    if (layout === 'focus' && index === big) chooseLayout('equal');
    else {
      setBigIndex(index);
      chooseLayout('focus');
    }
  };

  const removeTile = (index: number): void => {
    const id = queue[index];
    if (id === undefined) return;
    const newLast = Math.max(0, queue.length - 2);
    const shift = (v: number): number => Math.min(index < v ? v - 1 : v, newLast);
    setBigIndex(shift(big));
    setAudioIndex(shift(audio));
    removeFromMultiview(id);
  };

  /** Put `entry` on screen: replaces the audio tile when the queue is full, otherwise appends. */
  const swapIn = (entry: BenchEntry): void => {
    if (queue.length >= MULTIVIEW_MAX) replaceInMultiview(audio, entry.channelId);
    else addToMultiview(entry.channelId);
  };

  const move = (target: FocusTarget): boolean => {
    if (target === 'free') return true;
    if (target === 'block') return false;
    if (target === 'rail') {
      if (bench.length > 0) setFocus(railKey(0));
      return false;
    }
    setFocus(tileKey(target.tile));
    return false;
  };

  // first focus: the large tile in focus layout, else the first; the rail when nothing is queued
  const arrival = tiles.length > 0 ? tileKey(layout === 'focus' ? big : 0) : bench.length > 0 ? railKey(0) : 'mv-empty';
  useArrivalFocus(props, arrival, current !== null || tiles.length > 0);

  // a tile went away: focus the audio tile (or the rail when none is left)
  const previousCount = useRef(tiles.length);
  useEffect(() => {
    if (previousCount.current > tiles.length) {
      if (tiles.length > 0) setFocus(tileKey(audio));
      else if (bench.length > 0) setFocus(railKey(0));
    }
    previousCount.current = tiles.length;
  }, [tiles.length]);

  useOkHold(
    () => {
      const key = currentFocusKey();
      if (key.indexOf('mv-tile-') !== 0) return false;
      const tile = tiles[Number(key.substring(8))];
      if (tile === undefined) return false;
      setActionsChannel(tile.channelId);
      return true;
    },
    actionsChannel === null,
    props.active,
  );

  useKeyHandler((key) => {
    if (key !== 'back' || actionsChannel !== null) return false;
    back();
    return true;
  }, props.active);

  const onRailRow = (el: HTMLElement): void => {
    setFocusedIndex(null);
    const s = railScroller.current;
    if (s === null) return;
    const top = offsetWithin(el, s).top + s.scrollTop;
    s.scrollTop = reveal(s.scrollTop, s.clientHeight, top, el.offsetHeight, 8, 8, s.scrollHeight - s.clientHeight);
  };

  const actionsIndex = tiles.findIndex((t) => t.channelId === actionsChannel);
  const actionsTile = tiles[actionsIndex] ?? null;
  const bigFocused = layout === 'focus' && focusedIndex !== null && focusedIndex === big;
  const closeActions = (): void => {
    setActionsChannel(null);
    const k = tileKey(actionsIndex);
    if (focusExists(k)) setFocus(k);
  };

  return (
    <div class="multiview-page">
      <div class={'mv-main' + (tiles.length > 0 ? ' with-hint' : '')}>
        <div class="mv-stage-box">
          {tiles.length === 0 ? (
            <EmptyState focusKey="mv-empty" class="mv-empty" title="Nothing in multiview yet" subtitle="Swap in a live game from the list" />
          ) : (
            <div class="mv-stage">
              {tiles.map((tile, i) => {
                  const slot = slots[i];
                  if (slot === undefined) return null;
                  const map = tileFocusMap(i, tiles.length, layout, big, bench.length > 0);
                  return (
                    <TileView
                      key={i}
                      index={i}
                      tile={tile}
                      slot={slot}
                      audio={i === audio}
                      playing={playing[i] === true}
                      onDecoderTrouble={onDecoderTrouble}
                      hideScores={hideScores}
                      onFocus={(index) => {
                        setAudioIndex(index);
                        setFocusedIndex(index);
                        lastTile.current = index;
                      }}
                      onOk={onTileOk}
                      onArrow={(d) => move(d === 'left' ? map.left : d === 'right' ? map.right : d === 'up' ? map.up : map.down)}
                    />
                  );
                })}
            </div>
          )}
        </div>
        <div class="mv-rail">
          <RowHeader title="Swap in" count={bench.length} />
          <div ref={railScroller} class="mv-rail-list">
            {bench.map((entry, i) => (
              <SwapInRow
                key={entry.channelId}
                index={i}
                entry={entry}
                hideScores={hideScores}
                onPress={() => swapIn(entry)}
                onFocusRow={onRailRow}
                onArrow={(d) => {
                  if (d === 'left') {
                    if (tiles.length > 0) setFocus(tileKey(Math.min(lastTile.current, tiles.length - 1)));
                    return false;
                  }
                  if (d === 'right') return false;
                  if (d === 'up' && i === 0) return false;
                  if (d === 'down' && i === bench.length - 1) return false;
                  return true;
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {tiles.length > 0 ? <div class="mv-hint">{bigFocused ? 'OK  Equal tiles · HOLD  More' : 'OK  Focus tile · HOLD  More'}</div> : null}
      {actionsTile !== null ? (
        <GameActionsDialog
          game={actionsTile.game}
          channelName={actionsTile.name !== '' ? actionsTile.name : 'Unknown channel'}
          actions={{
            watch: (() => {
              const channel = current?.channels.find((c) => c.id === actionsTile.channelId);
              const route = channel !== undefined ? channelRoute(channel) : null;
              return route !== null ? () => push(route) : undefined;
            })(),
            watchLabel: 'Watch full screen',
            removeFromMultiview: () => removeTile(actionsIndex),
            follow: actionsTile.game !== null,
          }}
          hideScores={hideScores}
          favoriteTeams={teams}
          onDismiss={closeActions}
        />
      ) : null}
      <ToastHost />
      <RecordingNoticeHost active={props.active} pageKey={props.pageKey} />
    </div>
  );
}
