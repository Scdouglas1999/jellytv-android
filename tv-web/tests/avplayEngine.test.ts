import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAvPlayEngine } from '../src/player/avplayEngine';
import type { AvPlayListener } from '../src/platform/tizen-types';

/**
 * The AVPlay engine against a recording fake of webapis.avplay (the call order Samsung's AVPlay guide requires:
 * open → setDisplayRect → prepareAsync → seek → play; suspend/restore on visibility; stop/close on destroy).
 * The real thing needs a TV or the emulator (ARCHITECTURE.md, Testing).
 */
class FakeElement {
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  className = '';
  classes = new Set<string>();
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) };
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    return c;
  }
  remove(): void {
    this.attrs.removed = 'yes';
  }
}

let calls: string[];
const online: Array<() => void> = [];
const timers: Array<() => void> = [];
let holdSeeks = false;
let refuseAfter = Infinity;
const heldSeeks: Array<() => void> = [];
let listener: AvPlayListener;
let state: string;
const visibility: Array<() => void> = [];
const doc = {
  hidden: false,
  documentElement: new FakeElement(),
  body: new FakeElement(),
  createElement: () => new FakeElement(),
  addEventListener: (_t: string, fn: () => void) => visibility.push(fn),
  removeEventListener: () => undefined,
};

beforeEach(() => {
  calls = [];
  state = 'NONE';
  visibility.length = 0;
  const avplay = {
    open: (url: string) => {
      calls.push('open ' + url);
      state = 'IDLE';
    },
    close: () => {
      calls.push('close');
      state = 'NONE';
    },
    setDisplayRect: (...a: number[]) => calls.push('rect ' + a.join(',')),
    setDisplayMethod: (m: string) => calls.push('method ' + m),
    setBufferingParam: () => calls.push('buffering'),
    prepareAsync: (ok: () => void) => {
      calls.push('prepare');
      state = 'READY';
      ok();
    },
    seekTo: (ms: number, ok?: () => void, fail?: (e: unknown) => void) => {
      calls.push('seek ' + String(ms));
      if (ms > refuseAfter) fail?.({ name: 'InvalidValuesError', message: 'PLAYER_ERROR_SEEK_FAILED' });
      else if (holdSeeks) heldSeeks.push(() => ok?.());
      else ok?.();
    },
    play: () => {
      calls.push('play');
      state = 'PLAYING';
    },
    pause: () => {
      calls.push('pause');
      state = 'PAUSED';
    },
    stop: () => {
      calls.push('stop');
      state = 'IDLE';
    },
    suspend: () => calls.push('suspend'),
    restore: (url: string, ms?: number) => calls.push(`restore ${url} ${String(ms)}`),
    getState: () => state,
    getDuration: () => 90_000,
    setListener: (l: AvPlayListener) => {
      listener = l;
      calls.push('listener');
    },
    getTotalTrackInfo: () => [
      { index: 0, type: 'VIDEO', extra_info: '{}' },
      { index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' },
      { index: 2, type: 'AUDIO', extra_info: '{"language":"spa"}' },
    ],
    setSelectTrack: (t: string, i: number) => calls.push(`track ${t} ${i}`),
  };
  online.length = 0;
  timers.length = 0;
  holdSeeks = false;
  refuseAfter = Infinity;
  heldSeeks.length = 0;
  (globalThis as Record<string, unknown>).window = {
    webapis: { avplay },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => undefined,
    addEventListener: (_t: string, fn: () => void) => online.push(fn),
    removeEventListener: () => undefined,
  };
  (globalThis as Record<string, unknown>).document = doc;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

const noEvents = { state: () => undefined, time: () => undefined, firstFrame: () => undefined, error: () => undefined };

describe('AVPlay engine', () => {
  it('opens, sizes the video plane, prepares, seeks to the resume point, plays', async () => {
    const host = new FakeElement();
    const engine = createAvPlayEngine(host as unknown as HTMLElement, noEvents);
    expect(host.children[0]?.attrs.type).toBe('application/avplayer');
    expect(doc.body.classes.has('native-video')).toBe(true);
    await engine.load({ url: 'http://s/v.m3u8', kind: 'hls', live: false, startMs: 42_000 });
    expect(calls).toEqual(['listener', 'open http://s/v.m3u8', 'rect 0,0,1920,1080', 'method PLAYER_DISPLAY_MODE_LETTER_BOX', 'prepare', 'seek 42000', 'play']);
  });

  it('puts a growing playlist (a game\'s start over) at its first minute: a non-live HLS source seeks to 0 too', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'http://s/JellyTV/Recordings/j/playlist.m3u8', kind: 'hls', live: false, startMs: 0 });
    expect(calls.slice(-3)).toEqual(['prepare', 'seek 0', 'play']);
    calls.length = 0;
    await engine.load({ url: 'http://s/film.mkv', kind: 'file', live: false, startMs: 0 });
    expect(calls.some((c) => c.startsWith('seek'))).toBe(false);
  });

  it('never seeks a live stream and asks for a start buffer', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'http://s/live.m3u8', kind: 'hls', live: true, startMs: 0 });
    expect(calls).toContain('buffering');
    expect(calls.some((c) => c.startsWith('seek'))).toBe(false);
  });

  it('reports the first frame once the clock runs while playing, and the position', async () => {
    let first = 0;
    let at = 0;
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, { ...noEvents, firstFrame: () => first++, time: (ms) => (at = ms) });
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(1200);
    listener.oncurrentplaytime?.(1700);
    expect(first).toBe(1);
    expect(at).toBe(1700);
    expect(engine.currentTime()).toBe(1700);
  });

  it('closes the player when the app is hidden and opens it again at the position, playing', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(5000);
    calls.length = 0;
    doc.hidden = true;
    visibility.forEach((f) => f());
    expect(calls).toEqual(['stop', 'close']);
    calls.length = 0;
    doc.hidden = false;
    visibility.forEach((f) => f());
    await Promise.resolve();
    expect(calls).toEqual(['open u', 'rect 0,0,1920,1080', 'method PLAYER_DISPLAY_MODE_LETTER_BOX', 'prepare', 'seek 5000', 'play']);
  });

  it('a paused film comes back paused; a live channel comes back at the edge', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(7000);
    engine.pause();
    doc.hidden = true;
    visibility.forEach((f) => f());
    doc.hidden = false;
    calls.length = 0;
    visibility.forEach((f) => f());
    expect(calls).toContain('seek 7000');
    expect(calls).not.toContain('play');

    await engine.load({ url: 'live', kind: 'hls', live: true, startMs: 0 });
    doc.hidden = true;
    visibility.forEach((f) => f());
    doc.hidden = false;
    calls.length = 0;
    visibility.forEach((f) => f());
    expect(calls.some((c) => c.startsWith('seek'))).toBe(false);
    expect(calls).toContain('play');
  });

  it('chains seeks: one at a time, the latest target wins, the position follows at once', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    holdSeeks = true;
    calls.length = 0;
    engine.seek(10_000);
    engine.seek(20_000);
    engine.seek(30_000);
    expect(engine.currentTime()).toBe(30_000);
    expect(calls).toEqual(['seek 10000']);
    // the clock of the old position does not move the position back while a seek runs
    listener.oncurrentplaytime?.(1000);
    expect(engine.currentTime()).toBe(30_000);
    heldSeeks.shift()?.();
    expect(calls).toEqual(['seek 10000', 'seek 30000']);
  });

  it('keeps seeks off the very end and tries a refused seek again earlier, then where it was', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(20_000);
    calls.length = 0;
    engine.seek(90_000);
    expect(calls).toEqual(['seek 87000']);
    // the file's last keyframe is at 80 s: 87 and 82 are refused, 77 lands
    refuseAfter = 80_000;
    listener.oncurrentplaytime?.(20_000);
    calls.length = 0;
    engine.seek(87_000);
    expect(calls).toEqual(['seek 87000', 'seek 82000', 'seek 20000']);
    expect(engine.currentTime()).toBe(20_000);
    refuseAfter = 84_000;
    calls.length = 0;
    engine.seek(87_000);
    expect(calls).toEqual(['seek 87000', 'seek 82000']);
    expect(engine.currentTime()).toBe(82_000);
  });

  it('opens a failing live channel again, a few times', async () => {
    const states: string[] = [];
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, { ...noEvents, state: (s) => states.push(s) });
    await engine.load({ url: 'live', kind: 'hls', live: true, startMs: 0 });
    calls.length = 0;
    listener.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
    expect(states[states.length - 1]).toBe('buffering');
    timers.shift()?.();
    expect(calls).toContain('open live');
  });

  it('a film that failed opens again at its place when the network comes back', async () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    await engine.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(9000);
    listener.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
    calls.length = 0;
    online.forEach((f) => f());
    expect(calls).toContain('open u');
    expect(calls).toContain('seek 9000');
  });

  it('sets AVPlay’s listener once and forwards to the engine in use (old listeners stayed alive on Tizen)', async () => {
    let first = 0;
    let second = 0;
    const a = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, { ...noEvents, time: () => first++ });
    a.destroy();
    const b = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, { ...noEvents, time: () => second++ });
    await b.load({ url: 'u', kind: 'file', live: false, startMs: 0 });
    listener.oncurrentplaytime?.(1000);
    expect(calls.filter((c) => c === 'listener')).toHaveLength(1);
    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('lists and switches the file’s own audio tracks, and cleans up', () => {
    const engine = createAvPlayEngine(new FakeElement() as unknown as HTMLElement, noEvents);
    expect(engine.nativeAudioTracks().map((t) => t.label)).toEqual(['ENG', 'SPA']);
    engine.selectNativeAudio(2);
    engine.destroy();
    expect(calls.slice(-1)).toEqual(['track AUDIO 2']);
    expect(doc.body.classes.has('native-video')).toBe(false);
  });
});
