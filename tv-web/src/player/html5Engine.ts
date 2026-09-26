import type { EngineEvents, EngineName, PlayerEngine, Source } from './engine';

declare const __HLS_FILE__: string;

export interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
  destroy(): void;
  on(event: string, cb: (event: string, data: { fatal?: boolean; type?: string; details?: string }) => void): void;
  startLoad(position?: number): void;
  recoverMediaError(): void;
}

interface HlsStatic {
  new (config: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: { ERROR: string };
  ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string };
}

let hlsLoading: Promise<HlsStatic> | null = null;

/**
 * hls.js (Apache-2.0) is not part of the app bundle: it is a separate file next to it, loaded only by browsers
 * without native HLS (TVs never load it). See ARCHITECTURE.md, licenses.
 */
export function loadHls(base: string): Promise<HlsStatic> {
  const w = window as unknown as { Hls?: HlsStatic };
  if (w.Hls !== undefined) return Promise.resolve(w.Hls);
  if (hlsLoading !== null) return hlsLoading;
  hlsLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = base + __HLS_FILE__;
    script.onload = () => (w.Hls !== undefined ? resolve(w.Hls) : reject(new Error('hls.js did not load')));
    script.onerror = () => reject(new Error('hls.js did not load'));
    document.head.appendChild(script);
  });
  return hlsLoading;
}

/** Live: stay ~15 s (five 3-second segments) behind the edge, like the Android app's TallyLivePlayback. */
const LIVE_SYNC_SEGMENTS = 5;

/**
 * HTML5 <video>. Also the webOS engine (`name` 'webos'): LG's <video> plays HLS natively on its own pipeline.
 */
export function createHtml5Engine(host: HTMLElement, events: EngineEvents, bundleBase: string, name: EngineName = 'html5'): PlayerEngine {
  const video = document.createElement('video');
  video.className = 'engine-video';
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  host.appendChild(video);
  let hls: HlsInstance | null = null;
  let firstFrameSent = false;
  let lastTimeEvent = 0;

  const on = (type: string, fn: () => void): void => video.addEventListener(type, fn);
  on('playing', () => {
    events.state('playing');
    if (!firstFrameSent) {
      firstFrameSent = true;
      events.firstFrame();
    }
  });
  on('pause', () => events.state('paused'));
  on('waiting', () => events.state('buffering'));
  on('ended', () => events.state('ended'));
  on('timeupdate', () => {
    const now = Date.now();
    if (now - lastTimeEvent >= 250) {
      lastTimeEvent = now;
      events.time(video.currentTime * 1000);
    }
  });
  // a seek reports its new position at once (timeupdate is throttled above)
  on('seeked', () => {
    lastTimeEvent = Date.now();
    events.time(video.currentTime * 1000);
  });
  on('error', () => {
    const code = video.error?.code;
    events.error(code === 4 ? 'This video format is not supported here.' : 'Playback failed.');
    events.state('error');
  });

  const nativeHls = (): boolean => video.canPlayType('application/vnd.apple.mpegurl') !== '' || video.canPlayType('application/x-mpegURL') !== '';

  return {
    name,
    async load(source: Source) {
      events.state('loading');
      firstFrameSent = false;
      // a reload (audio, subtitle burn-in or quality change) replaces the previous stream entirely
      if (hls !== null) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      if (source.kind === 'hls' && name === 'html5' && !nativeHls()) {
        const Hls = await loadHls(bundleBase);
        if (!Hls.isSupported()) throw new Error('This browser cannot play HLS.');
        hls = new Hls({
          startPosition: source.live ? -1 : source.startMs / 1000,
          liveSyncDurationCount: LIVE_SYNC_SEGMENTS,
          maxBufferLength: 30,
          backBufferLength: 20,
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal !== true || hls === null) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else {
            events.error('Playback failed (' + String(data.details) + ').');
            events.state('error');
          }
        });
        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else {
        video.src = source.url;
        if (!source.live && source.startMs > 0) {
          video.addEventListener('loadedmetadata', () => (video.currentTime = source.startMs / 1000), { once: true });
        }
      }
      await video.play().catch(() => {
        // autoplay policy in a desktop browser without a key press yet: the first OK starts it
      });
    },
    play: () => void video.play().catch(() => undefined),
    pause: () => video.pause(),
    seek: (ms) => {
      video.currentTime = Math.max(0, ms / 1000);
    },
    stop: () => {
      video.pause();
    },
    destroy() {
      if (hls !== null) hls.destroy();
      hls = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
    currentTime: () => video.currentTime * 1000,
    duration: () => (isFinite(video.duration) ? video.duration * 1000 : 0),
    nativeAudioTracks: () => [],
    selectNativeAudio: () => undefined,
    setSpeed: (rate) => {
      video.playbackRate = rate;
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
}
