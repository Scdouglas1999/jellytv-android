import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaSegmentDto } from '@jellyfin/sdk/lib/generated-client/models/media-segment-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { app } from '../../app/context';
import type { PageProps } from '../../app/page';
import { setFocus } from '../../focus/focus';
import { isRepeat, useKeyHandler } from '../../platform/keyRouter';
import { usePointerActivity } from '../../platform/pointer';
import type { VideoScale } from '../../player/engine';
import { nativeAudioFor, preparePlayback, reporter, type Prepared } from '../../player/playback';
import { bitrateLabel, qualityOptions, type QualityOption } from '../../player/qualityLadder';
import { back, replace, resetTo, type Route } from '../../router/router';
import { useStore } from '../../util/store';
import { BottomBand, ControlsRow, DpadSeekMinimal, PausedLabel, SeekBar, SleepChip, Times, TopBlock } from './controls';
import { NextUpCard, SkipPrompt } from './nextUp';
import { NoticeDialog, QualityDialog, SidePanel, SleepDialog, type PanelRowModel } from './panels';
import { defaultQuality, loadItem, loadItems, loadQueue, loadSegments, saveDefaultQuality, trickplaySheetUrl } from './playerData';
import * as F from './playerFormat';
import { SubtitleLayer, TuneIn, useEngine } from './playerKit';
import { ChapterRow, QueueRow } from './rows';
import { bindSleepTimer, cancelSleep, sleep, sleepItemEnded, sleepRemaining, startSleep, startSleepUntilEnd } from './sleepTimer';
import './controls.css';

const REPORT_MS = 10_000;

const ORIGINAL: QualityOption = { bitsPerSecond: null, maxWidth: null, maxHeight: null, label: 'Original' };

type Overlay = 'hidden' | 'controller' | 'chapters' | 'queue';
type SettingsPage = 'list' | 'audio' | 'subtitles' | 'speed' | 'scale' | 'delay';
type Panel =
  | { kind: 'settings'; page: SettingsPage; last: SettingsPage | null; from: string }
  | { kind: 'quality' | 'sleep' | 'together' | 'sendTo'; from: string };

/** What the viewer chose for subtitles: off, only forced ones, or a track (drawn by the app, or burned in). */
type SubtitleChoice = { mode: 'off' } | { mode: 'forced' } | { mode: 'track'; index: number };

interface SegmentState {
  segment: MediaSegmentDto;
  /** Dismissed or skipped once: the prompt does not come back for it. */
  interacted: boolean;
}

const SCALE_NAMES: Record<VideoScale, string> = { fit: 'Fit', crop: 'Crop', fill: 'Fill' };

/** Where the picture goes while the next-up card is up: 60% of the screen, top center (upstream's playerSize). */
const SHRUNK = { x: 384, y: 0, w: 1152, h: 648 };

function streamsOf(p: Prepared | null, type: MediaStream['Type']): MediaStream[] {
  return (p?.mediaSource.MediaStreams ?? []).filter((s) => s.Type === type && s.Index != null);
}

function useNow(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/**
 * The library player with the Android TV app's controls (tally/ui/player/controls): the title block and clock, the
 * bottom band (Tally seek bar with trickplay, times, transport and track buttons), the chapter and queue rows under
 * it, the settings side panel and its dialogs, skip intro/credits, next up with its countdown, the post-play page
 * for a finished film, the sleep timer, resume and progress reports. BACK hides the controls first and never leaves
 * the app (the Android TallyPlayerBack fix).
 */
export function PlayerPage(props: PageProps<Extract<Route, { name: 'player' }>>) {
  const host = useRef<HTMLDivElement>(null);
  const player = useEngine(host);
  const now = useNow(1000);

  const [queue, setQueue] = useState<BaseItemDto[]>([]);
  const [index, setIndex] = useState(0);
  const queueRef = useRef<BaseItemDto[]>([]);
  queueRef.current = queue;
  const item = queue[index] ?? null;

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const preparedRef = useRef<Prepared | null>(null);
  preparedRef.current = prepared;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityOption>(ORIGINAL);
  const [subtitle, setSubtitle] = useState<SubtitleChoice>({ mode: 'off' });
  const [delayMs, setDelayMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [scale, setScale] = useState<VideoScale>('fit');
  const settingsRef = useRef({ speed, scale });
  settingsRef.current = { speed, scale };

  // playback starts with the controls down (upstream's ControllerViewState); any key but LEFT/RIGHT brings them up
  const [overlay, setOverlay] = useState<Overlay>('hidden');
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  panelRef.current = panel;
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  const [segments, setSegments] = useState<MediaSegmentDto[]>([]);
  const [segment, setSegment] = useState<SegmentState | null>(null);
  const handledSegments = useRef<Set<string>>(new Set());

  const [nextUp, setNextUp] = useState<BaseItemDto | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(F.AUTO_PLAY_DELAY_S);

  const [seekFocused, setSeekFocused] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const [skip, setSkip] = useState<{ positionMs: number; skippedMs: number } | null>(null);

  const sleepState = useStore(sleep);
  const hideTimer = useRef(0);
  const seekTimer = useRef(0);
  const lingerTimer = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  const repeats = useRef(0);
  const lastInteraction = useRef(Date.now());
  // the last position the engine reported: the engine is already gone when the page's cleanup sends "stopped"
  const lastMs = useRef(props.route.startMs ?? 0);
  if (player.timeMs > 0) lastMs.current = player.timeMs;
  const report = useRef<{ r: ReturnType<typeof reporter>; stopped: boolean } | null>(null);
  const playingRef = useRef(false);
  const shownSubtitle = useRef<number | null>(null);

  const engine = player.engine.current;
  const position = player.timeMs;
  const duration = engine?.duration() ?? 0;
  const controls = overlay !== 'hidden';
  const playing = player.state === 'playing' || player.state === 'buffering' || player.state === 'loading';
  playingRef.current = playing;

  // ---- leaving, reporting ----------------------------------------------------------------------------------------

  const leave = (): void => {
    if (!back()) resetTo({ name: 'home' });
  };

  const endReport = (ms: number): void => {
    const current = report.current;
    if (current !== null && !current.stopped) {
      current.stopped = true;
      current.r.stop(ms);
    }
  };

  // ---- controls visibility -----------------------------------------------------------------------------------------

  /** Keeps the controls up for another 5 s (every key while they are up). */
  const pulse = (): void => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (panelRef.current === null) setOverlay('hidden');
    }, F.CONTROLS_HIDE_MS);
  };

  const showControls = (focus = 'pc-play'): void => {
    pendingFocus.current = focus;
    setSkip(null);
    setOverlay('controller');
    pulse();
  };

  const hideControls = (): void => {
    window.clearTimeout(hideTimer.current);
    setOverlay('hidden');
  };

  // LG's Magic Remote: moving the pointer (or clicking the picture) brings the controls up and keeps them up
  usePointerActivity(() => {
    if (overlay === 'hidden') showControls();
    else pulse();
  }, props.active);

  // focus the button asked for once the controller is on screen (a layout effect: a quick next key lands on it)
  useLayoutEffect(() => {
    if (overlay === 'controller' && panel === null && pendingFocus.current !== null) {
      setFocus(pendingFocus.current);
      pendingFocus.current = null;
    }
  }, [overlay, panel]);

  // ---- starting streams ------------------------------------------------------------------------------------------

  /** (Re)starts `itemId` at `startMs` with the given choices. */
  const start = async (
    itemId: string,
    startMs: number,
    choice: { audio?: number; subtitle?: number; burnIn?: boolean; quality: QualityOption; sameSource: boolean; applyDefault?: boolean },
  ): Promise<Prepared | null> => {
    const e = player.engine.current;
    if (e === null) return null;
    try {
      const request = {
        itemId,
        // a restart names the source it had, so Jellyfin honors the track choice
        mediaSourceId: choice.sameSource ? (preparedRef.current?.mediaSource.Id ?? undefined) : undefined,
        startMs,
        audioIndex: choice.audio,
        subtitleIndex: choice.subtitle,
        burnIn: choice.burnIn,
        quality: choice.quality,
      };
      let p = await preparePlayback(app.platform, request);
      // "Use as my default on this TV": a cap, applied only when the file is over it
      const fallback = choice.applyDefault === true ? defaultQuality() : null;
      if (fallback !== null && fallback.bitsPerSecond !== null && p.sourceBitrate !== null && p.sourceBitrate > fallback.bitsPerSecond) {
        p = await preparePlayback(app.platform, { ...request, mediaSourceId: p.mediaSource.Id ?? undefined, quality: fallback });
        setQuality(fallback);
      }
      setPrepared(p);
      preparedRef.current = p;
      setLoadError(null);
      e.stop();
      await e.load(p.source);
      // a directly played file: the engine picks the chosen audio track itself (AVPlay)
      const native = nativeAudioFor(p, e.nativeAudioTracks());
      if (native !== null) e.selectNativeAudio(native);
      // a new stream starts at normal speed and fit: put the viewer's choices back
      e.setSpeed?.(settingsRef.current.speed);
      e.setScale?.(settingsRef.current.scale);
      return p;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not play this.');
      return null;
    }
  };

  /** Plays `it` from `startMs`: a new stream, new reports, its own segments. */
  const startItem = async (it: BaseItemDto, startMs: number): Promise<void> => {
    if (it.Id == null) return;
    endReport(lastMs.current);
    lastMs.current = startMs;
    setNextUp(null);
    setSegment(null);
    setSegments([]);
    handledSegments.current = new Set();
    targetRef.current = null;
    setTarget(null);
    const itemId = it.Id;
    const p = await start(itemId, startMs, { quality, sameSource: false, applyDefault: true });
    if (p !== null) {
      // the server's default subtitle, if it is a text track the app can draw
      const def = p.subtitles.find((t) => t.index === p.subtitleIndex && t.text);
      setSubtitle(def !== undefined ? { mode: 'track', index: def.index } : { mode: 'off' });
      shownSubtitle.current = def !== undefined ? def.index : -1;
      // reports name the subtitle the viewer sees (the app draws text ones, so the stream was asked for without one):
      // Jellyfin remembers it as the viewer's choice for next time
      report.current = {
        r: reporter(itemId, () => {
          const current = preparedRef.current;
          return current === null ? null : { ...current, subtitleIndex: shownSubtitle.current ?? current.subtitleIndex };
        }),
        stopped: false,
      };
      report.current.r.start(startMs);
    }
    void loadSegments(itemId).then(setSegments);
  };

  const playIndex = (i: number): void => {
    const it = queueRef.current[i];
    if (it === undefined) return;
    hideControls();
    setIndex(i);
    void startItem(it, 0);
  };

  useEffect(() => {
    let alive = true;
    const unbind = bindSleepTimer(() => {
      player.engine.current?.pause();
      leave();
    });
    loadItem(props.route.itemId)
      .then(async (it) => {
        if (!alive) return;
        setQueue([it]);
        setIndex(0);
        // resume: the position asked for, else where the viewer stopped last time
        const startMs = props.route.startMs ?? F.ticksToMs(it.UserData?.PlaybackPositionTicks);
        await startItem(it, startMs);
        // a list chosen elsewhere (Play all, Shuffle) plays as given; an episode plays on through its series
        const ids = props.route.queue;
        const q = ids !== undefined && ids.length > 1 ? await loadItems(ids).catch(() => [it]) : await loadQueue(it).catch(() => [it]);
        if (alive && q.length > 1) setQueue(q[0]?.Id === it.Id ? q : [it].concat(q.filter((x) => x.Id !== it.Id)));
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Could not load this.'));
    const t = window.setInterval(() => {
      const e = player.engine.current;
      if (e !== null && report.current !== null && !report.current.stopped) report.current.r.progress(e.currentTime(), e.currentTime() > 0 && !playingRef.current);
    }, REPORT_MS);
    return () => {
      alive = false;
      unbind();
      window.clearInterval(t);
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(seekTimer.current);
      window.clearTimeout(lingerTimer.current);
      endReport(lastMs.current);
    };
  }, []);

  // paused and resumed are reported at once (the server's session list shows it)
  useEffect(() => {
    const e = player.engine.current;
    if (e === null || report.current === null || report.current.stopped) return;
    if (player.state === 'paused' || player.state === 'playing') report.current.r.progress(e.currentTime(), player.state === 'paused');
  }, [player.state]);

  // ---- the end of an item ---------------------------------------------------------------------------------------

  useEffect(() => {
    if (player.state !== 'ended' || item === null) return;
    endReport(duration > 0 ? duration : lastMs.current);
    if (sleepItemEnded()) return; // "when this ends": pause and leave
    const next = queue[index + 1];
    if (next !== undefined) {
      hideControls();
      setPanel(null);
      setAutoPlay(Date.now() - lastInteraction.current < F.PASS_OUT_MS);
      setSecondsLeft(F.AUTO_PLAY_DELAY_S);
      setNextUp(next);
    } else if (F.kind(item) === 'film' && item.Id != null) {
      replace({ name: 'postplay', itemId: item.Id });
    } else {
      leave();
    }
  }, [player.state]);

  // next up: the countdown, then the next item
  useEffect(() => {
    if (nextUp === null || !autoPlay) return undefined;
    const t = window.setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearInterval(t);
  }, [nextUp, autoPlay]);
  useEffect(() => {
    if (nextUp !== null && autoPlay && secondsLeft <= 0) playIndex(index + 1);
  }, [secondsLeft]);

  // the picture shrinks to the top while the card is up
  useEffect(() => {
    const e = player.engine.current;
    if (nextUp !== null) e?.setDisplayArea?.(SHRUNK.x, SHRUNK.y, SHRUNK.w, SHRUNK.h);
    else e?.setDisplayArea?.(0, 0, 1920, 1080);
  }, [nextUp !== null]);

  // ---- media segments --------------------------------------------------------------------------------------------

  useEffect(() => {
    const seg = F.segmentAt(segments, position);
    if (seg === null || seg.Id == null) {
      if (segment !== null) setSegment(null);
      return;
    }
    if (segment?.segment.Id === seg.Id) return;
    const behavior = F.skipBehavior(seg.Type);
    if (behavior === 'ignore') {
      if (segment !== null) setSegment(null);
      return;
    }
    if (behavior === 'auto' && !handledSegments.current.has(seg.Id)) {
      handledSegments.current.add(seg.Id);
      player.engine.current?.seek(F.ticksToMs(seg.EndTicks) + 1);
    }
    setSegment({ segment: seg, interacted: behavior === 'auto' || handledSegments.current.has(seg.Id) });
  }, [position, segments]);

  const skipSegment = (): void => {
    if (segment === null || segment.segment.Id == null) return;
    handledSegments.current.add(segment.segment.Id);
    const end = F.ticksToMs(segment.segment.EndTicks) + 1;
    setSegment(null);
    player.engine.current?.seek(end);
  };
  const dismissSegment = (): void => {
    if (segment === null || segment.segment.Id == null) return;
    handledSegments.current.add(segment.segment.Id);
    setSegment({ segment: segment.segment, interacted: true });
  };
  const showSegment = segment !== null && !segment.interacted && nextUp === null && !controls && skip === null && panel === null;
  useEffect(() => {
    if (!showSegment) return undefined;
    const t = window.setTimeout(dismissSegment, F.SKIP_PROMPT_MS);
    return () => window.clearTimeout(t);
  }, [showSegment]);

  // ---- transport ---------------------------------------------------------------------------------------------------

  /**
   * Play/pause decides from what was last asked, not only from the engine's reported state: the engine reports a
   * play or pause a moment later, and a second press in that moment must undo the first, not repeat it.
   */
  const playIntent = useRef<boolean | null>(null);
  useEffect(() => {
    if (player.state === 'playing') playIntent.current = true;
    else if (player.state === 'paused') playIntent.current = false;
  }, [player.state]);
  const togglePlay = (): void => {
    const e = player.engine.current;
    if (e === null) return;
    if (playIntent.current ?? player.state === 'playing') {
      playIntent.current = false;
      e.pause();
    } else {
      playIntent.current = true;
      e.play();
    }
  };

  const clampSeek = (ms: number): number => {
    const d = player.engine.current?.duration() ?? 0;
    return Math.max(0, d > 0 ? Math.min(d, ms) : ms);
  };

  /** A seek while the controls are hidden: the picture jumps at once, the minimal seek bar lingers 800 ms. */
  const seekHidden = (delta: number): void => {
    const e = player.engine.current;
    if (e === null) return;
    const to = clampSeek(e.currentTime() + delta);
    e.seek(to);
    setSkip((s) => ({ positionMs: to, skippedMs: s !== null && s.skippedMs * delta > 0 ? s.skippedMs + delta : delta }));
    window.clearTimeout(lingerTimer.current);
    lingerTimer.current = window.setTimeout(() => setSkip(null), F.MINIMAL_LINGER_MS);
  };

  /** LEFT/RIGHT with the controls hidden; a held key speeds up after 8 repeats (upstream's handleHoldSkip). */
  const holdSeek = (direction: 'left' | 'right'): void => {
    let multiplier = 1;
    if (repeats.current > 0) {
      if (repeats.current < F.HOLD_REPEAT_START) return;
      multiplier = F.seekMultiplier(repeats.current - F.HOLD_REPEAT_START, duration);
    }
    seekHidden(direction === 'left' ? -F.SEEK_BACK_MS * multiplier : F.SEEK_FORWARD_MS * multiplier);
  };

  /** LEFT/RIGHT on the focused seek bar: moves the target; the seek happens 750 ms after the last move. */
  const seekBarArrow = (direction: 'left' | 'right'): void => {
    const e = player.engine.current;
    if (e === null) return;
    pulse();
    const multiplier = repeats.current > 0 ? F.seekMultiplier(repeats.current, duration) : 1;
    const base = targetRef.current ?? e.currentTime();
    const to = clampSeek(base + (direction === 'left' ? -F.SEEK_BACK_MS * multiplier : F.SEEK_FORWARD_MS * multiplier));
    targetRef.current = to;
    setTarget(to);
    window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => player.engine.current?.seek(to), F.SEEK_DEBOUNCE_MS);
  };

  const previous = (): void => {
    const e = player.engine.current;
    if (e === null) return;
    if (e.currentTime() < F.PREVIOUS_RESTART_MS && index > 0) playIndex(index - 1);
    else e.seek(0);
  };

  // ---- panels ------------------------------------------------------------------------------------------------------

  const openPanel = (p: Panel): void => {
    window.clearTimeout(hideTimer.current);
    setPanel(p);
  };
  const closePanel = (): void => {
    const from = panelRef.current?.from ?? 'pc-play';
    setPanel(null);
    showControls(from);
  };
  const settingsPage = (page: SettingsPage): void => {
    const p = panelRef.current;
    if (p?.kind === 'settings') setPanel({ ...p, page, last: p.page === 'list' ? page : p.last });
  };

  const restartWith = (choice: { audio?: number; subtitle?: SubtitleChoice; quality?: QualityOption }): void => {
    const p = preparedRef.current;
    const e = player.engine.current;
    if (p === null || e === null || item?.Id == null) return;
    const sub = choice.subtitle ?? subtitle;
    const burn = burnedIndex(sub, p);
    void start(item.Id, e.currentTime(), {
      audio: choice.audio ?? p.audioIndex ?? undefined,
      subtitle: burn ?? -1,
      burnIn: burn !== null,
      quality: choice.quality ?? quality,
      sameSource: true,
    });
  };

  /** The image subtitle the server must burn in for this choice (text ones are drawn by the app), or null. */
  const burnedIndex = (choice: SubtitleChoice, p: Prepared): number | null => {
    const track = subtitleStream(choice, p);
    return track !== null && track.IsTextSubtitleStream !== true ? (track.Index ?? null) : null;
  };

  const subtitleStream = (choice: SubtitleChoice, p: Prepared | null): MediaStream | null => {
    const subs = streamsOf(p, 'Subtitle');
    if (choice.mode === 'track') return subs.find((s) => s.Index === choice.index) ?? null;
    if (choice.mode === 'forced') {
      const audio = streamsOf(p, 'Audio').find((s) => s.Index === p?.audioIndex);
      const forced = subs.filter((s) => s.IsForced === true);
      return forced.find((s) => s.Language === audio?.Language) ?? forced[0] ?? null;
    }
    return null;
  };

  const chooseSubtitle = (choice: SubtitleChoice): void => {
    const p = preparedRef.current;
    const wasBurned = p !== null && p.subtitleIndex !== null && p.subtitleIndex >= 0 && p.subtitles.some((t) => t.index === p.subtitleIndex && !t.text);
    setSubtitle(choice);
    const needsBurn = p !== null && burnedIndex(choice, p) !== null;
    // a picture subtitle is burned in by the server: a new stream; leaving one also needs a clean stream
    if (needsBurn || wasBurned) restartWith({ subtitle: choice });
  };

  // ---- keys --------------------------------------------------------------------------------------------------------

  useKeyHandler((key, event) => {
    lastInteraction.current = Date.now();
    repeats.current = isRepeat(event) ? repeats.current + 1 : 0;
    const e = player.engine.current;
    switch (key) {
      case 'playPause':
        togglePlay();
        return true;
      case 'play':
        playIntent.current = true;
        e?.play();
        return true;
      case 'pause':
        playIntent.current = false;
        e?.pause();
        return true;
      case 'stop':
        leave();
        return true;
      default:
        break;
    }
    if (panelRef.current !== null) return false; // the panel has BACK; arrows and OK move and choose inside it
    if (nextUp !== null) {
      if (key !== 'back') return false; // PLAY NOW / DISMISS
      if (autoPlay && secondsLeft > 0) {
        // the first BACK only stops the countdown
        setAutoPlay(false);
        setSecondsLeft(-1);
      } else if (player.state === 'playing') setNextUp(null);
      else leave();
      return true;
    }
    if (key === 'fastForward' || key === 'rewind') {
      const delta = key === 'rewind' ? -F.SEEK_BACK_MS : F.SEEK_FORWARD_MS;
      if (controls && e !== null) {
        e.seek(clampSeek(e.currentTime() + delta));
        pulse();
      } else seekHidden(delta);
      return true;
    }
    if (key === 'next') {
      if (queue[index + 1] !== undefined) playIndex(index + 1);
      return true;
    }
    if (key === 'previous') {
      previous();
      return true;
    }
    if (controls) {
      if (key === 'back') {
        hideControls();
        return true;
      }
      pulse();
      return false;
    }
    // controls hidden
    if (showSegment) {
      if (key === 'back') {
        dismissSegment();
        return true;
      }
      if (key === 'enter') return false; // the focused SKIP button
    }
    switch (key) {
      case 'back':
        leave();
        return true;
      case 'left':
      case 'right':
        holdSeek(key);
        return true;
      case 'enter':
      case 'up':
      case 'down':
      case 'info':
      case 'menu':
        if (!isRepeat(event)) showControls();
        return true;
      default:
        return false;
    }
  }, props.active);

  // ---- what is shown -----------------------------------------------------------------------------------------------

  const hasNext = queue[index + 1] !== undefined;
  const chapters = item?.Chapters ?? [];
  const trickplay = F.pickTrickplay(item, prepared?.mediaSource.Id ?? null);
  const drawnTrack = subtitleStream(subtitle, prepared);
  shownSubtitle.current = drawnTrack?.Index ?? -1;
  const drawn = drawnTrack !== null && drawnTrack.IsTextSubtitleStream === true ? (prepared?.subtitles.find((t) => t.index === drawnTrack.Index) ?? null) : null;
  // Date.now(), not the once-a-second `now`: a timer just started must read 15:00, not 15:01
  const remainingSleep = sleepRemaining(sleepState, Date.now());

  const settingsRows = (page: SettingsPage): PanelRowModel[] => {
    const p = prepared;
    const audio = streamsOf(p, 'Audio');
    const subs = streamsOf(p, 'Subtitle');
    const close = closePanel;
    switch (page) {
      case 'audio':
        return audio.map((s) => ({
          key: String(s.Index),
          label: F.trackName(s),
          value: F.audioTrack(s),
          current: s.Index === p?.audioIndex,
          onPress: () => {
            close();
            if (p === null || s.Index === p.audioIndex) return;
            // a directly played file switches in place where the engine can (AVPlay); else the server restarts
            // the stream with the track
            const e = player.engine.current;
            const next = { ...p, audioIndex: s.Index ?? null };
            const native = e !== null ? nativeAudioFor(next, e.nativeAudioTracks()) : null;
            if (e !== null && native !== null) {
              e.selectNativeAudio(native);
              setPrepared(next);
              preparedRef.current = next;
            } else restartWith({ audio: s.Index ?? undefined });
          },
        }));
      case 'subtitles':
        return ([
          { key: 'off', label: 'Off', current: subtitle.mode === 'off', onPress: () => (close(), chooseSubtitle({ mode: 'off' })) },
          { key: 'forced', label: 'Only forced subtitles', current: subtitle.mode === 'forced', onPress: () => (close(), chooseSubtitle({ mode: 'forced' })) },
        ] as PanelRowModel[])
          .concat(
            subs.map((s) => ({
              key: String(s.Index),
              label: F.trackName(s),
              value: F.subtitleTrack(s),
              current: subtitle.mode === 'track' && subtitle.index === s.Index,
              onPress: () => (close(), chooseSubtitle({ mode: 'track', index: s.Index as number })),
            })),
          )
          .concat({ key: 'search', label: 'Search and download', onPress: null });
      case 'speed':
        return F.SPEEDS.map((v) => ({
          key: String(v),
          label: F.speedLabel(v),
          current: v === speed,
          onPress: () => {
            settingsPage('list');
            setSpeed(v);
            player.engine.current?.setSpeed?.(v);
          },
        }));
      case 'scale':
        return (engine?.scales?.() ?? ['fit']).map((s) => ({
          key: s,
          label: SCALE_NAMES[s],
          current: s === scale,
          onPress: () => {
            settingsPage('list');
            setScale(s);
            player.engine.current?.setScale?.(s);
          },
        }));
      case 'delay': {
        const rows: PanelRowModel[] = F.DELAY_STEPS_MS.map((step) => ({ key: '+' + String(step), label: F.subtitleDelay(step), onPress: () => setDelayMs((d) => d + step) }));
        rows.push({ key: 'reset', label: 'Reset', onPress: () => setDelayMs(0) });
        return rows.concat(
          F.DELAY_STEPS_MS.slice()
            .reverse()
            .map((step) => ({ key: '-' + String(step), label: F.subtitleDelay(-step), onPress: () => setDelayMs((d) => d - step) })),
        );
      }
      default: {
        const rows: PanelRowModel[] = [];
        const currentAudio = audio.find((s) => s.Index === p?.audioIndex);
        if (audio.length > 0) rows.push({ key: 'audio', label: 'Audio', value: currentAudio !== undefined ? F.audioTrack(currentAudio) : null, onPress: () => settingsPage('audio') });
        const sub = subtitleStream(subtitle, p);
        rows.push({
          key: 'subtitles',
          label: 'Subtitles',
          value: subtitle.mode === 'off' ? 'Off' : subtitle.mode === 'forced' ? 'Forced only' : sub !== null ? F.subtitleTrack(sub) : 'Off',
          onPress: () => settingsPage('subtitles'),
        });
        rows.push({ key: 'speed', label: 'Speed', value: F.speedLabel(speed), onPress: engine?.setSpeed !== undefined ? () => settingsPage('speed') : null });
        if ((engine?.scales?.() ?? []).length > 1) rows.push({ key: 'scale', label: 'Video scale', value: SCALE_NAMES[scale], onPress: () => settingsPage('scale') });
        rows.push({ key: 'delay', label: 'Subtitle delay', value: F.subtitleDelay(delayMs), onPress: () => settingsPage('delay') });
        const tally = (kind: 'quality' | 'sleep' | 'together' | 'sendTo') => () => setPanel({ kind, from: panelRef.current?.from ?? 'pc-settings' });
        rows.push({ key: 'quality', label: 'Quality', value: quality.bitsPerSecond === null ? 'Original' : quality.label, onPress: tally('quality') });
        rows.push({
          key: 'sleep',
          label: 'Sleep timer',
          value: remainingSleep === null ? 'Off' : isFinite(remainingSleep) ? F.sleepClock(remainingSleep) : 'Until the end',
          onPress: tally('sleep'),
        });
        rows.push({ key: 'together', label: 'Watch together', onPress: tally('together') });
        rows.push({ key: 'sendTo', label: 'Send to…', onPress: tally('sendTo') });
        return rows;
      }
    }
  };

  const panelView = (): preact.JSX.Element | null => {
    if (panel === null) return null;
    if (panel.kind === 'settings') {
      const rows = settingsRows(panel.page);
      const focusIndex =
        panel.page === 'list'
          ? Math.max(0, rows.findIndex((r) => r.key === panel.last))
          : panel.page === 'delay'
            ? rows.findIndex((r) => r.key === 'reset')
            : Math.max(0, rows.findIndex((r) => r.current === true));
      const kickers: Record<SettingsPage, string> = { list: 'Settings', audio: 'Audio', subtitles: 'Subtitles', speed: 'Speed', scale: 'Video scale', delay: 'Subtitle delay' };
      return (
        <SidePanel
          pageKey={panel.page}
          kicker={kickers[panel.page]}
          readout={panel.page === 'delay' ? F.subtitleDelay(delayMs) : null}
          rows={rows}
          focusIndex={focusIndex}
          onBack={() => (panel.page === 'list' ? closePanel() : settingsPage('list'))}
        />
      );
    }
    if (panel.kind === 'quality') {
      const p = prepared;
      const method = p === null ? 'LOADING…' : p.delivery === 'direct' ? 'DIRECT PLAY' : p.delivery === 'remux' ? 'DIRECT STREAM' : 'TRANSCODING';
      const rung = quality.bitsPerSecond !== null;
      const nowLine =
        p === null
          ? method
          : [method, F.resolutionLabel(rung ? quality.maxHeight : p.sourceHeight), bitrateLabel(rung ? quality.bitsPerSecond : p.sourceBitrate)]
              .filter((x): x is string => x !== null)
              .join(' · ');
      const options = qualityOptions(p?.sourceHeight ?? null, p?.sourceBitrate ?? null);
      return (
        <QualityDialog
          nowLine={nowLine}
          reasons={p !== null && p.delivery !== 'direct' ? F.transcodeReasons(p.source.url) : ''}
          rows={options.map((o) => ({
            key: String(o.bitsPerSecond ?? 0),
            label: o.bitsPerSecond === null ? 'Original' : o.label,
            current: (o.bitsPerSecond ?? 0) === (quality.bitsPerSecond ?? 0),
            onPress: () => {
              if (saveAsDefault) saveDefaultQuality(o);
              closePanel();
              if ((o.bitsPerSecond ?? 0) === (quality.bitsPerSecond ?? 0)) return;
              setQuality(o);
              restartWith({ quality: o });
            },
          }))}
          saveAsDefault={saveAsDefault}
          onToggleDefault={() => setSaveAsDefault((v) => !v)}
          onBack={closePanel}
        />
      );
    }
    if (panel.kind === 'sleep') {
      const rows: PanelRowModel[] = [];
      if (remainingSleep !== null) {
        rows.push({ key: 'cancel', label: isFinite(remainingSleep) ? `Cancel (${F.sleepClock(remainingSleep)} left)` : 'Cancel', onPress: () => (cancelSleep(), closePanel()) });
      }
      for (const m of F.SLEEP_MINUTES) rows.push({ key: String(m), label: `${m} minutes`, onPress: () => (startSleep(m), closePanel()) });
      rows.push({ key: 'end', label: 'When this ends', onPress: () => (startSleepUntilEnd(), closePanel()) });
      return <SleepDialog rows={rows} onBack={closePanel} />;
    }
    return panel.kind === 'together' ? (
      <NoticeDialog title="Watch together" text="Watch parties are not in Tally for Samsung and LG TVs yet. They come with a later update." onBack={closePanel} />
    ) : (
      <NoticeDialog title="Send to…" text="Sending what you are watching to another screen is not in Tally for Samsung and LG TVs yet." onBack={closePanel} />
    );
  };

  const band = (): preact.JSX.Element | null => {
    if (overlay === 'chapters' && chapters.length > 0 && item?.Id != null) {
      return (
        <ChapterRow
          itemId={item.Id}
          chapters={chapters}
          // the engine's own clock: the reported position lags a seek by up to 250 ms
          positionMs={engine?.currentTime() ?? position}
          onSeek={(ms) => {
            player.engine.current?.seek(ms);
            hideControls();
          }}
          onUp={() => showControls('pc-chapters')}
          onDown={hasNext ? () => setOverlay('queue') : null}
          onFocus={pulse}
        />
      );
    }
    if (overlay === 'queue' && hasNext) {
      return (
        <QueueRow
          queue={queue.slice(index + 1)}
          onPlay={(i) => playIndex(index + 1 + i)}
          onUp={() => (chapters.length > 0 ? setOverlay('chapters') : showControls('pc-queue'))}
          onFocus={pulse}
        />
      );
    }
    return (
      <>
        <SeekBar
          positionMs={position}
          durationMs={duration}
          bufferedMs={engine?.bufferedMs?.() ?? 0}
          targetMs={seekFocused ? target : null}
          chapters={chapters}
          trickplay={trickplay}
          sheetUrl={(sheet) => (item?.Id != null && trickplay !== null ? trickplaySheetUrl(item.Id, trickplay, sheet, prepared?.mediaSource.Id ?? null) : '')}
          focused={seekFocused}
          onArrow={seekBarArrow}
          onFocusChange={(f) => {
            setSeekFocused(f);
            if (!f) {
              targetRef.current = null;
              setTarget(null);
            }
          }}
        />
        {/* the times follow playback, not the target (the preview shows that), as on Android */}
        <Times positionMs={position} durationMs={duration} speed={speed} now={now} />
        <ControlsRow
          playing={player.state === 'playing'}
          hasChapters={chapters.length > 0}
          hasNext={hasNext}
          skipLabel={segment !== null ? F.skipLabel(segment.segment.Type) : null}
          onChapters={() => setOverlay('chapters')}
          onQueue={() => setOverlay('queue')}
          onPrevious={previous}
          onRewind={() => engine?.seek(clampSeek(engine.currentTime() - F.SEEK_BACK_MS))}
          onPlayPause={togglePlay}
          onForward={() => engine?.seek(clampSeek(engine.currentTime() + F.SEEK_FORWARD_MS))}
          onNext={() => playIndex(index + 1)}
          onSkip={skipSegment}
          onSubtitles={() => openPanel({ kind: 'settings', page: 'subtitles', last: 'subtitles', from: 'pc-subtitles' })}
          onAudio={() => openPanel({ kind: 'settings', page: 'audio', last: 'audio', from: 'pc-audio' })}
          onSettings={() => openPanel({ kind: 'settings', page: 'list', last: null, from: 'pc-settings' })}
          onDown={() => {
            if (chapters.length > 0) setOverlay('chapters');
            else if (hasNext) setOverlay('queue');
            else return false;
            return true;
          }}
          onFocus={pulse}
        />
      </>
    );
  };

  const shownControls = controls && panel === null;
  const paused = player.state === 'paused' && !controls && skip === null && panel === null && nextUp === null;

  return (
    <div class={'player pc' + (shownControls ? ' osd-visible' + (overlay !== 'controller' ? ' cards-visible' : '') : '') + (nextUp !== null ? ' nextup' : '')}>
      <div ref={host} class="pc-video" />
      {nextUp !== null ? <div class="pc-frame" /> : null}
      {skip === null ? <SubtitleLayer url={drawn?.vttUrl ?? null} timeMs={position - delayMs} /> : null}
      <TuneIn key={item?.Id ?? ''} label="Loading" title={item?.Name ?? ''} firstFrame={player.firstFrame} error={loadError ?? player.error} />
      {shownControls ? <TopBlock kicker={F.kicker(item)} title={F.title(item)} meta={F.meta(item)} now={now} /> : null}
      {shownControls ? <BottomBand class={overlay === 'controller' ? 'controller' : 'cards'}>{band()}</BottomBand> : null}
      {paused ? <PausedLabel /> : null}
      {skip !== null && !controls ? <DpadSeekMinimal positionMs={skip.positionMs} durationMs={duration} /> : null}
      {showSegment && segment !== null ? <SkipPrompt label={F.skipLabel(segment.segment.Type)} onSkip={skipSegment} /> : null}
      {nextUp !== null ? (
        <NextUpCard
          item={nextUp}
          autoPlay={autoPlay}
          secondsLeft={secondsLeft}
          onPlayNow={() => playIndex(index + 1)}
          onDismiss={() => (player.state === 'playing' ? setNextUp(null) : leave())}
        />
      ) : null}
      {remainingSleep !== null ? <SleepChip remainingMs={remainingSleep} /> : null}
      {panelView()}
    </div>
  );
}
