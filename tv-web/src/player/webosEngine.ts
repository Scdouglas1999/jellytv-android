import type { EngineEvents, NativeAudioTrack, PlayerEngine, Source } from './engine';
import { loadHls, type HlsInstance } from './html5Engine';

/** A live stream that fails (the network dropped, the server restarted) is opened again this many times. */
const LIVE_RETRIES = 5;
const LIVE_RETRY_MS = 4000;
/** A live picture that has not moved for this long while it should play is opened again at the edge. */
const LIVE_STALL_MS = 30000;
/** A seek stops this far before the end (a seek onto the last frames can end the file at once). */
const END_MARGIN_MS = 3000;

/** The parts of <video> the engine uses beyond the DOM's typings (Chromium 68 has audioTracks on webOS). */
interface AudioTrackLike {
  id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}
interface AudioTrackListLike {
  length: number;
  [index: number]: AudioTrackLike | undefined;
}

/**
 * LG webOS: an HTML5 <video> on the TV's own media pipeline (LG's "media pipeline" behind the element, the same one
 * the TV's apps use): native HLS for live and converted streams, and MP4/MKV/TS/WebM files straight from the server
 * with HEVC, VP9, AV1 (where the set has it), HDR10/HLG/Dolby Vision and AC-3/E-AC-3 passthrough. hls.js is never
 * loaded on a TV; only a desktop browser pretending to be webOS (the end-to-end tests) falls back to it, because
 * desktop Chromium has no native HLS.
 *
 * What it adds to the browser engine (html5Engine.ts), matching the AVPlay engine's behavior on Samsung:
 *  - audio tracks of a directly played file switch in place through `audioTracks` (no restart), kept across reopens;
 *  - live: a failed stream is opened again (5 tries, 4 s apart), a picture stalled for 30 s is opened again at the
 *    edge, the network coming back reopens it;
 *  - a hidden app (Home, another input) releases the decoder and a shown one opens the stream again where it was
 *    (playing if the viewer was playing; paused stays paused; live goes back to the edge);
 *  - seeks stay 3 s off the end of a file.
 */
export function createWebosEngine(host: HTMLElement, events: EngineEvents, bundleBase: string): PlayerEngine {
  const video = document.createElement('video');
  video.className = 'engine-video';
  video.preload = 'auto';
  host.appendChild(video);

  let source: Source | null = null;
  let hls: HlsInstance | null = null;
  let firstFrameSent = false;
  let lastTimeEvent = 0;
  let wantPlaying = false;
  let destroyed = false;
  let suspended = false;
  let failed = false;
  let liveRetries = 0;
  let retryTimer = 0;
  let stallTimer = 0;
  /** Where to open again after a release (ms). */
  let resumeAt = 0;
  let audioTrack: number | null = null;
  /** Bumped by every open: events of a released stream are ignored. */
  let generation = 0;

  const nativeHls = (): boolean =>
    video.canPlayType('application/vnd.apple.mpegurl') !== '' || video.canPlayType('application/x-mpegURL') !== '';

  const tracks = (): AudioTrackListLike | null => (video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks ?? null;

  /**
   * The chosen track on, the others off. With no choice, a file whose tracks are all off gets its first one: webOS 5
   * plays no sound until a track is enabled (LG FAQ "audio-my-content-not-playing-sound-webos-tv-50").
   */
  const applyAudio = (): void => {
    const list = tracks();
    if (list === null || list.length === 0) return;
    let want = audioTrack;
    if (want === null || want >= list.length) {
      for (let i = 0; i < list.length; i++) if (list[i]?.enabled === true) return;
      want = 0;
    }
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t !== undefined) t.enabled = i === want;
    }
  };

  const armStallWatch = (): void => {
    window.clearTimeout(stallTimer);
    if (source === null || !source.live || !wantPlaying || suspended || destroyed) return;
    stallTimer = window.setTimeout(() => {
      if (source !== null && source.live && wantPlaying && !suspended && !destroyed) {
        liveRetries = 0;
        void open(source, 0, true).catch(() => undefined);
      }
    }, LIVE_STALL_MS);
  };

  const release = (): void => {
    generation++;
    window.clearTimeout(stallTimer);
    if (hls !== null) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // nothing loaded
    }
  };

  /** Opens `src` at `startMs` (ms; ignored for live, which starts near the edge); plays when `play`. */
  const open = async (src: Source, startMs: number, play: boolean): Promise<void> => {
    release();
    const mine = generation;
    failed = false;
    if (src.kind === 'hls' && !nativeHls()) {
      // a desktop browser standing in for a TV (tests): hls.js, as the browser engine does
      const Hls = await loadHls(bundleBase);
      if (mine !== generation) return;
      hls = new Hls({ startPosition: src.live ? -1 : startMs / 1000, liveSyncDurationCount: 5 });
      hls.loadSource(src.url);
      hls.attachMedia(video);
    } else {
      video.src = src.url;
    }
    // the tracks and the duration are known once the metadata is (a server that never answers: give up waiting
    // after 30 s, the element keeps trying and reports what happens)
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => done(), 30000);
      const done = (): void => {
        window.clearTimeout(timer);
        video.removeEventListener('loadedmetadata', done);
        video.removeEventListener('error', done);
        resolve();
      };
      video.addEventListener('loadedmetadata', done);
      video.addEventListener('error', done);
    });
    if (mine !== generation) return;
    // a growing (EVENT) playlist, such as a game's start over, may open at its newest segment: an HLS source that is
    // not live is always put at its start position, 0 included
    if (!src.live && hls === null && (startMs > 0 || src.kind === 'hls')) video.currentTime = startMs / 1000;
    applyAudio();
    if (play) {
      await video.play().catch(() => undefined);
    } else events.state('paused');
    armStallWatch();
  };

  const retryLive = (): void => {
    if (source === null || !source.live || destroyed || suspended || liveRetries >= LIVE_RETRIES) return;
    liveRetries++;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (source !== null && !destroyed && !suspended) void open(source, 0, true).catch(() => retryLive());
    }, LIVE_RETRY_MS);
  };

  const on = (type: string, fn: () => void): void => video.addEventListener(type, fn);
  on('playing', () => {
    liveRetries = 0;
    events.state('playing');
    if (!firstFrameSent) {
      firstFrameSent = true;
      events.firstFrame();
    }
  });
  on('pause', () => {
    if (!suspended && video.getAttribute('src') !== null) events.state('paused');
  });
  on('waiting', () => events.state('buffering'));
  on('ended', () => {
    wantPlaying = false;
    events.state('ended');
  });
  on('timeupdate', () => {
    armStallWatch();
    const now = Date.now();
    if (now - lastTimeEvent >= 250) {
      lastTimeEvent = now;
      events.time(video.currentTime * 1000);
    }
  });
  on('seeked', () => {
    lastTimeEvent = Date.now();
    events.time(video.currentTime * 1000);
  });
  on('error', () => {
    // a released element reports an empty src as an error: not ours
    if (video.getAttribute('src') === null && hls === null) return;
    failed = true;
    if (source?.live === true && liveRetries < LIVE_RETRIES) {
      events.state('buffering');
      retryLive();
      return;
    }
    const code = video.error?.code;
    events.error(code === 4 ? 'This video format is not supported here.' : 'Playback failed.');
    events.state('error');
  });

  const onVisibility = (): void => {
    if (destroyed || source === null) return;
    if (document.hidden) {
      if (suspended) return;
      suspended = true;
      resumeAt = video.currentTime * 1000;
      window.clearTimeout(retryTimer);
      // give the decoder back to the TV; the position is kept
      release();
      return;
    }
    if (!suspended) return;
    suspended = false;
    events.state('buffering');
    void open(source, source.live ? 0 : resumeAt, wantPlaying || source.live).catch(() => undefined);
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onOnline = (): void => {
    if (destroyed || source === null || !failed || suspended) return;
    liveRetries = 0;
    void open(source, source.live ? 0 : video.currentTime * 1000, true).catch(() => undefined);
  };
  window.addEventListener('online', onOnline);

  const engine: PlayerEngine = {
    name: 'webos',
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
      void video.play().catch(() => undefined);
      armStallWatch();
    },
    pause() {
      wantPlaying = false;
      window.clearTimeout(stallTimer);
      video.pause();
    },
    seek(ms: number) {
      let to = Math.max(0, ms);
      const d = video.duration;
      if (source !== null && !source.live && isFinite(d) && d * 1000 > END_MARGIN_MS) to = Math.min(to, d * 1000 - END_MARGIN_MS);
      video.currentTime = to / 1000;
    },
    stop() {
      window.clearTimeout(retryTimer);
      window.clearTimeout(stallTimer);
      video.pause();
    },
    destroy() {
      destroyed = true;
      window.clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      release();
      video.remove();
    },
    currentTime: () => video.currentTime * 1000,
    duration: () => (source?.live === true || !isFinite(video.duration) ? 0 : video.duration * 1000),
    nativeAudioTracks(): NativeAudioTrack[] {
      const list = tracks();
      if (list === null) return [];
      const out: NativeAudioTrack[] = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t === undefined) continue;
        const language = t.language ?? '';
        out.push({ index: i, language, label: t.label !== '' ? t.label : language !== '' ? language.toUpperCase() : `Track ${String(i + 1)}` });
      }
      return out;
    },
    selectNativeAudio(index: number) {
      // kept for a reopen (the app shown again, the network back)
      audioTrack = index;
      applyAudio();
    },
    setScale: (scale) => {
      video.style.objectFit = scale === 'crop' ? 'cover' : scale === 'fill' ? 'fill' : 'contain';
    },
    scales: () => ['fit', 'crop', 'fill'],
    bufferedMs: () => {
      const now = video.currentTime;
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= now + 0.5 && b.end(i) >= now) return b.end(i) * 1000;
      }
      return 0;
    },
  };
  // LG's native HLS plays at 1.0 only (developer site, streaming-protocol-drm: "Playback speed other than 1.0: Not
  // supported"): speed is offered for files played directly, not for streams
  const setSpeed = (rate: number): void => {
    video.playbackRate = rate;
  };
  Object.defineProperty(engine, 'setSpeed', { enumerable: true, get: () => (source?.kind === 'file' ? setSpeed : undefined) });
  return engine;
}
