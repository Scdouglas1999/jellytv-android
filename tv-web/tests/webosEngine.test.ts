import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebosEngine } from '../src/player/webosEngine';

/**
 * The webOS engine against a fake <video> that behaves as LG's element does (native HLS: canPlayType says yes;
 * audioTracks; events). The real media pipeline needs a TV (ARCHITECTURE.md, Testing).
 */
class FakeVideo extends EventTarget {
  className = '';
  preload = '';
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  currentTime = 0;
  duration = NaN;
  paused = true;
  playbackRate = 1;
  error: { code: number } | null = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  audioTracks: Array<{ id: string; kind: string; label: string; language: string; enabled: boolean }> = [];
  log: string[] = [];
  removed = false;
  canPlayType(type: string): string {
    return type.indexOf('mpegurl') >= 0 || type.indexOf('mpegURL') >= 0 ? 'maybe' : '';
  }
  set src(v: string) {
    this.attrs.src = v;
    this.log.push('src ' + v);
  }
  get src(): string {
    return this.attrs.src ?? '';
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
    this.log.push('remove ' + k);
  }
  load(): void {
    this.log.push('load');
  }
  play(): Promise<void> {
    this.log.push('play');
    this.paused = false;
    this.fire('playing');
    return Promise.resolve();
  }
  pause(): void {
    this.log.push('pause');
    this.paused = true;
  }
  remove(): void {
    this.removed = true;
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

let video: FakeVideo;
const timers: Array<{ fn: () => void; ms: number }> = [];
const docListeners: Record<string, Array<() => void>> = {};
const winListeners: Record<string, Array<() => void>> = {};
const doc = {
  hidden: false,
  createElement: () => video,
  addEventListener: (t: string, fn: () => void) => (docListeners[t] ??= []).push(fn),
  removeEventListener: (t: string, fn: () => void) => {
    docListeners[t] = (docListeners[t] ?? []).filter((f) => f !== fn);
  },
};
const host = { appendChild: () => undefined } as unknown as HTMLElement;

beforeEach(() => {
  video = new FakeVideo();
  timers.length = 0;
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  for (const k of Object.keys(winListeners)) delete winListeners[k];
  doc.hidden = false;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    addEventListener: (t: string, fn: () => void) => (winListeners[t] ??= []).push(fn),
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

interface Seen {
  states: string[];
  errors: string[];
  first: number;
}
function events(): Seen & { state(s: string): void; time(): void; firstFrame(): void; error(m: string): void } {
  const seen = { states: [] as string[], errors: [] as string[], first: 0 };
  return {
    ...seen,
    get states() {
      return seen.states;
    },
    get errors() {
      return seen.errors;
    },
    get first() {
      return seen.first;
    },
    state: (s: string) => seen.states.push(s),
    time: () => undefined,
    firstFrame: () => void seen.first++,
    error: (m: string) => seen.errors.push(m),
  };
}

/** load() waits for the metadata: deliver it as the element would. */
async function loaded<T>(p: Promise<T>, setup?: () => void): Promise<T> {
  await Promise.resolve();
  setup?.();
  video.fire('loadedmetadata');
  return p;
}

describe('webOS engine', () => {
  it('plays HLS natively (never hls.js on a TV), a file from its resume point, and reports the first frame', async () => {
    const e = events();
    const engine = createWebosEngine(host, e, 'http://s/JellyTV/TV/');
    await loaded(engine.load({ url: 'http://s/master.m3u8', kind: 'hls', live: false, startMs: 0 }));
    expect(video.log).toContain('src http://s/master.m3u8');
    expect(e.first).toBe(1);
    await loaded(engine.load({ url: 'http://s/film.mkv', kind: 'file', live: false, startMs: 42_000 }));
    expect(video.currentTime).toBe(42);
    expect(e.states).toContain('playing');
  });

  it('puts a growing playlist (a game\'s start over) at its first minute: a non-live HLS source starts at 0', async () => {
    const engine = createWebosEngine(host, events(), '');
    // LG's element opens an EVENT playlist at its newest segment
    await loaded(engine.load({ url: 'http://s/JellyTV/Recordings/j/playlist.m3u8', kind: 'hls', live: false, startMs: 0 }), () => {
      video.currentTime = 300;
    });
    expect(video.currentTime).toBe(0);
  });

  it('switches a file’s audio in place through audioTracks and keeps the choice across a reopen', async () => {
    const engine = createWebosEngine(host, events(), '');
    await loaded(engine.load({ url: 'http://s/film.mkv', kind: 'file', live: false, startMs: 0 }), () => {
      video.audioTracks = [
        { id: '1', kind: 'main', label: '', language: 'eng', enabled: false },
        { id: '2', kind: 'translation', label: 'Español', language: 'spa', enabled: false },
      ];
    });
    // webOS 5 plays no sound until a track is on: the first is switched on
    expect(video.audioTracks.map((t) => t.enabled)).toEqual([true, false]);
    expect(engine.nativeAudioTracks()).toEqual([
      { index: 0, language: 'eng', label: 'ENG' },
      { index: 1, language: 'spa', label: 'Español' },
    ]);
    engine.selectNativeAudio(1);
    expect(video.audioTracks.map((t) => t.enabled)).toEqual([false, true]);
    // the app hidden and shown again: the stream is opened again with the same track
    doc.hidden = true;
    docListeners.visibilitychange?.forEach((f) => f());
    video.audioTracks.forEach((t) => (t.enabled = false));
    doc.hidden = false;
    docListeners.visibilitychange?.forEach((f) => f());
    video.fire('loadedmetadata');
    await Promise.resolve();
    expect(video.audioTracks.map((t) => t.enabled)).toEqual([false, true]);
  });

  it('releases the decoder when hidden and opens the stream again where it was, paused staying paused', async () => {
    const engine = createWebosEngine(host, events(), '');
    await loaded(engine.load({ url: 'http://s/film.mkv', kind: 'file', live: false, startMs: 0 }));
    video.currentTime = 61;
    engine.pause();
    doc.hidden = true;
    docListeners.visibilitychange?.forEach((f) => f());
    expect(video.getAttribute('src')).toBeNull();
    video.log = [];
    doc.hidden = false;
    docListeners.visibilitychange?.forEach((f) => f());
    video.fire('loadedmetadata');
    await new Promise((r) => setTimeout(r, 0));
    expect(video.log).toContain('src http://s/film.mkv');
    expect(video.currentTime).toBe(61);
    expect(video.log).not.toContain('play');
  });

  it('goes back to the live edge on return, and retries a failed live stream 5 times, 4 s apart', async () => {
    const e = events();
    const engine = createWebosEngine(host, e, '');
    await loaded(engine.load({ url: 'http://s/JellyTV/Live/x.m3u8', kind: 'hls', live: true, startMs: 0 }));
    video.currentTime = 500;
    doc.hidden = true;
    docListeners.visibilitychange?.forEach((f) => f());
    doc.hidden = false;
    video.currentTime = 0;
    docListeners.visibilitychange?.forEach((f) => f());
    video.fire('loadedmetadata');
    await new Promise((r) => setTimeout(r, 0));
    // live: the same playlist from its edge (no seek back to where it was), playing
    expect(video.log.filter((l) => l.startsWith('src'))).toEqual(['src http://s/JellyTV/Live/x.m3u8', 'src http://s/JellyTV/Live/x.m3u8']);
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    video.error = { code: 2 };
    video.fire('error');
    expect(e.states[e.states.length - 1]).toBe('buffering');
    const retry = timers.find((t) => t.ms === 4000);
    expect(retry).toBeDefined();
    for (let i = 0; i < 5; i++) video.fire('error');
    expect(timers.filter((t) => t.ms === 4000).length).toBe(5);
    expect(e.errors).toEqual(['Playback failed.']);
  });

  it('offers speed for files only (LG’s HLS plays at 1.0) and keeps seeks 3 s off the end', async () => {
    const engine = createWebosEngine(host, events(), '');
    await loaded(engine.load({ url: 'http://s/master.m3u8', kind: 'hls', live: false, startMs: 0 }));
    expect(engine.setSpeed).toBeUndefined();
    await loaded(engine.load({ url: 'http://s/film.mp4', kind: 'file', live: false, startMs: 0 }));
    expect(engine.setSpeed).toBeDefined();
    engine.setSpeed?.(1.5);
    expect(video.playbackRate).toBe(1.5);
    video.duration = 90;
    engine.seek(89_500);
    expect(video.currentTime).toBe(87);
  });

  it('removes its element and listeners on destroy', async () => {
    const engine = createWebosEngine(host, events(), '');
    engine.destroy();
    expect(video.removed).toBe(true);
    expect(docListeners.visibilitychange ?? []).toHaveLength(0);
  });
});
