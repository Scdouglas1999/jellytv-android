import type { AvPlayApi, AvPlayListener } from '../platform/tizen-types';
import '../platform/tizen-types';
import type { EngineEvents, NativeAudioTrack, PlayerEngine, Source } from './engine';

type DisplayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX' | 'PLAYER_DISPLAY_MODE_FULL_SCREEN';

/** A live stream that fails (the network dropped, the server restarted) is opened again this many times. */
const LIVE_RETRIES = 5;
const LIVE_RETRY_MS = 4000;
/** AVPlay fails a seek past the last keyframe (PLAYER_ERROR_SEEK_FAILED at the very end): stop this far before it. */
const END_MARGIN_MS = 3000;
const SEEK_WATCHDOG_MS = 8000;
const SEEK_RETRIES = 2;
const SEEK_RETRY_STEP_MS = 5000;

/**
 * Samsung AVPlay (developer.samsung.com AVPlay API). The decoder draws on a hardware plane behind the web page:
 * an <object type="application/avplayer"> marks where, and everything above it in the page must be transparent
 * (this engine sets `native-video` on <html> and <body>; player.css clears their backgrounds). Plays HLS (live and
 * VOD), and MP4/MKV/TS files directly, with HEVC, AV1 (2020+ sets), HDR10 and Dolby/DTS passthrough as the TV allows.
 *
 * What the Tizen emulator (Tizen 10, September 2026) showed, and this engine is built on:
 *  - a new stream needs close() → open() → setDisplayRect → prepareAsync → (seekTo) → play();
 *  - a seek while another is running throws: seeks are chained, the latest target wins;
 *  - hiding the app (the Home button) pauses the player, and suspend()/restore(url, ms, true) left it IDLE at 0
 *    (play() then throws INVALID_STATE): so a hidden app closes the player (the decoder goes back to the TV) and a
 *    shown app opens the same stream again at the same place, playing if it was playing;
 *  - a direct-played file plays its first audio track: `selectNativeAudio` picks another (setSelectTrack works).
 */
/**
 * AVPlay's listener is set once and forwards to the engine in use. On the Tizen emulator every setListener() +
 * playback kept the old listener's closures alive (3 DOM nodes per film, 6 per player visit, never collected: an hour
 * of watching grew the page by ~400 nodes); one listener for the life of the app does not grow.
 */
let active: AvPlayListener | null = null;
let listeningOn: AvPlayApi | null = null;
function listen(avplay: AvPlayApi, listener: AvPlayListener): void {
  active = listener;
  if (listeningOn === avplay) return;
  listeningOn = avplay;
  avplay.setListener({
    onbufferingstart: () => active?.onbufferingstart?.(),
    onbufferingprogress: (p: number) => active?.onbufferingprogress?.(p),
    onbufferingcomplete: () => active?.onbufferingcomplete?.(),
    oncurrentplaytime: (ms: number) => active?.oncurrentplaytime?.(ms),
    onstreamcompleted: () => active?.onstreamcompleted?.(),
    onevent: (type: string, data: string) => active?.onevent?.(type, data),
    onerror: (type: string) => active?.onerror?.(type),
    onsubtitlechange: (duration: number, text: string, type: number, attributes: unknown) => active?.onsubtitlechange?.(duration, text, type, attributes),
    ondrmevent: (type: string, data: unknown) => active?.ondrmevent?.(type, data),
  });
}

export function createAvPlayEngine(host: HTMLElement, events: EngineEvents): PlayerEngine {
  const avplay: AvPlayApi | undefined = window.webapis?.avplay;
  if (avplay === undefined) throw new Error('AVPlay is not available (webapis.js missing?)');
  const object = document.createElement('object');
  object.setAttribute('type', 'application/avplayer');
  object.className = 'engine-avplay';
  host.appendChild(object);
  document.documentElement.classList.add('native-video');
  document.body.classList.add('native-video');

  let source: Source | null = null;
  let position = 0;
  let firstFrameSent = false;
  let destroyed = false;
  /** What the viewer wants: playing or paused (the TV pauses by itself when the app is hidden). */
  let wantPlaying = false;
  /** The player is open with `source` and prepared (seeks and play are allowed). */
  let prepared = false;
  /** Bumped by every open: callbacks of an older stream are ignored. */
  let generation = 0;
  let suspended = false;
  let failed = false;
  let liveRetries = 0;
  let retryTimer = 0;
  let seeking = false;
  let seekWatchdog = 0;
  let pendingSeek: number | null = null;
  let rect = { x: 0, y: 0, w: 1920, h: 1080 };
  let method: DisplayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX';
  let audioTrack: number | null = null;

  const state = (): string => {
    try {
      return avplay.getState();
    } catch {
      return 'NONE';
    }
  };

  const reportState = (): void => {
    const s = state();
    if (s === 'PLAYING') events.state('playing');
    else if (s === 'PAUSED') events.state('paused');
  };

  const close = (): void => {
    prepared = false;
    seeking = false;
    pendingSeek = null;
    try {
      if (state() !== 'NONE') {
        avplay.stop();
        avplay.close();
      }
    } catch {
      // closing an idle player throws on some firmware
    }
  };

  /**
   * One seek at a time. A seek AVPlay refuses (PLAYER_ERROR_SEEK_FAILED: past the file's last keyframe) leaves the
   * player stalled on the emulator until another seek lands, so a refused seek is tried again a little earlier, and
   * as a last resort where playback was.
   */
  const runSeek = (ms: number, from = position, attempt = 0): void => {
    if (!prepared) return;
    seeking = true;
    const mine = generation;
    let answered = false;
    const finish = (ok: boolean): void => {
      // AVPlay has been seen calling both callbacks for one seek: the first answer counts
      if (answered || mine !== generation) return;
      answered = true;
      window.clearTimeout(seekWatchdog);
      seeking = false;
      const next = pendingSeek;
      pendingSeek = null;
      if (next !== null && next !== ms) runSeek(next, from);
      else if (!ok && attempt < SEEK_RETRIES) {
        const retry = attempt + 1 < SEEK_RETRIES ? Math.max(0, ms - SEEK_RETRY_STEP_MS) : from;
        position = retry;
        events.time(retry);
        runSeek(retry, from, attempt + 1);
      } else reportState();
    };
    // a seek that never answers must not freeze the position
    window.clearTimeout(seekWatchdog);
    seekWatchdog = window.setTimeout(() => finish(true), SEEK_WATCHDOG_MS);
    try {
      avplay.seekTo(ms, () => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  };

  /** Opens `src` at `startMs`; plays when `play` (else stays paused on the position). */
  const open = (src: Source, startMs: number, play: boolean): Promise<void> => {
    close();
    const mine = ++generation;
    failed = false;
    position = startMs;
    return new Promise<void>((resolve, reject) => {
      const fail = (e: unknown): void => {
        if (mine !== generation) return;
        failed = true;
        events.error('The TV could not open this stream.');
        events.state('error');
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      try {
        avplay.open(src.url);
        avplay.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
        avplay.setDisplayMethod(method);
        if (src.live) {
          // start a few segments behind the live edge rather than on it (fewer stalls when a segment is late)
          try {
            avplay.setBufferingParam?.('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 6);
          } catch {
            // older firmware: defaults
          }
        }
        avplay.prepareAsync(() => {
          if (mine !== generation) return;
          prepared = true;
          if (audioTrack !== null) {
            try {
              avplay.setSelectTrack('AUDIO', audioTrack);
            } catch {
              // the file has no such track (a new item): its default plays
            }
          }
          const begin = (): void => {
            if (mine !== generation) return;
            if (play) avplay.play();
            reportState();
            if (!play) events.state('paused');
            resolve();
          };
          // a growing (EVENT) playlist, such as a game's start over, opens at its newest segment unless told where:
          // an HLS source that is not live is always put at its start position, 0 included
          if (!src.live && (startMs > 0 || src.kind === 'hls')) {
            try {
              avplay.seekTo(startMs, begin, begin);
            } catch {
              begin();
            }
          } else begin();
        }, fail);
      } catch (e) {
        fail(e);
      }
    });
  };

  const retryLive = (): void => {
    if (source === null || !source.live || destroyed || suspended || liveRetries >= LIVE_RETRIES) return;
    liveRetries++;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (source !== null && !destroyed && !suspended) void open(source, 0, true).catch(() => retryLive());
    }, LIVE_RETRY_MS);
  };

  const listener: AvPlayListener = {
    onbufferingstart: () => events.state('buffering'),
    onbufferingcomplete: () => reportState(),
    oncurrentplaytime: (ms: number) => {
      // a seek in flight owns the position until it lands
      if (!seeking) position = ms;
      events.time(position);
      if (state() === 'PLAYING') {
        liveRetries = 0;
        if (!firstFrameSent) {
          firstFrameSent = true;
          events.firstFrame();
        }
      }
    },
    onstreamcompleted: () => {
      wantPlaying = false;
      events.state('ended');
    },
    onerror: (type: string) => {
      failed = true;
      if (source?.live === true && liveRetries < LIVE_RETRIES) {
        events.state('buffering');
        retryLive();
        return;
      }
      events.error('Playback failed (' + type + ').');
      events.state('error');
    },
  };
  listen(avplay, listener);

  const onVisibility = (): void => {
    if (destroyed || source === null) return;
    if (document.hidden) {
      if (suspended) return;
      suspended = true;
      window.clearTimeout(retryTimer);
      // give the decoder back to the TV; the position is kept
      close();
      return;
    }
    if (!suspended) return;
    suspended = false;
    events.state('buffering');
    void open(source, source.live ? 0 : position, wantPlaying || source.live).catch(() => undefined);
  };
  document.addEventListener('visibilitychange', onVisibility);

  // the network came back after a failure: open the stream again where it was
  const onOnline = (): void => {
    if (destroyed || source === null || !failed || suspended) return;
    liveRetries = 0;
    void open(source, source.live ? 0 : position, true).catch(() => undefined);
  };
  window.addEventListener('online', onOnline);

  return {
    name: 'avplay',
    load(src: Source) {
      source = src;
      firstFrameSent = false;
      liveRetries = 0;
      wantPlaying = true;
      audioTrack = null;
      window.clearTimeout(retryTimer);
      events.state('loading');
      return open(src, src.startMs, true);
    },
    play() {
      wantPlaying = true;
      try {
        avplay.play();
        events.state('playing');
      } catch {
        // not prepared yet: load()/restore plays when ready
      }
    },
    pause() {
      wantPlaying = false;
      try {
        avplay.pause();
        events.state('paused');
      } catch {
        // not playing yet
      }
    },
    seek(ms: number) {
      const lastPlayed = position;
      let to = Math.max(0, Math.floor(ms));
      if (source !== null && !source.live && prepared) {
        let d: number;
        try {
          d = avplay.getDuration();
        } catch {
          d = 0;
        }
        if (d > END_MARGIN_MS) to = Math.min(to, d - END_MARGIN_MS);
      }
      position = to;
      events.time(to);
      if (!prepared) return; // a load in progress starts from its own position
      if (seeking) pendingSeek = to;
      else runSeek(to, lastPlayed);
    },
    stop() {
      window.clearTimeout(retryTimer);
      try {
        avplay.stop();
      } catch {
        // already stopped
      }
    },
    destroy() {
      destroyed = true;
      if (active === listener) active = null;
      generation++;
      window.clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      close();
      object.remove();
      document.documentElement.classList.remove('native-video');
      document.body.classList.remove('native-video');
    },
    currentTime: () => position,
    duration: () => {
      try {
        return source?.live === true || !prepared ? 0 : avplay.getDuration();
      } catch {
        return 0;
      }
    },
    nativeAudioTracks(): NativeAudioTrack[] {
      try {
        return avplay
          .getTotalTrackInfo()
          .filter((t) => t.type === 'AUDIO')
          .map((t) => {
            let language = '';
            try {
              language = String((JSON.parse(t.extra_info) as { language?: string }).language ?? '');
            } catch {
              // extra_info is not always JSON
            }
            return { index: t.index, language, label: language !== '' ? language.toUpperCase() : `Track ${t.index}` };
          });
      } catch {
        return [];
      }
    },
    selectNativeAudio(index: number) {
      // kept for a reopen (the app shown again, the network back)
      audioTrack = index;
      try {
        avplay.setSelectTrack('AUDIO', index);
      } catch {
        // not while the player is closed; the next open picks it
      }
    },
    // no setSpeed: AVPlay's speeds are trick play (silent), not a watching speed
    setScale(scale) {
      method = scale === 'fill' ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : 'PLAYER_DISPLAY_MODE_LETTER_BOX';
      try {
        avplay.setDisplayMethod(method);
      } catch {
        // not before open(): the next open uses it
      }
    },
    // AVPlay has no crop mode
    scales: () => ['fit', 'fill'],
    setDisplayArea(x, y, width, height) {
      rect = { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) };
      try {
        avplay.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
      } catch {
        // before open(): the next open uses it
      }
    },
  };
}
