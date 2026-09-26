import type { Platform } from '../platform/platform';
import { createAvPlayEngine } from './avplayEngine';
import type { EngineEvents, PlayerEngine } from './engine';
import { createHtml5Engine } from './html5Engine';
import { createWebosEngine } from './webosEngine';

/**
 * Tizen: AVPlay (falls back to <video> if webapis is missing, e.g. a Tizen browser). webOS: <video> on LG's media
 * pipeline (webosEngine.ts: native HLS, in-place audio tracks, live retries, release on hide). Browsers: <video> +
 * hls.js where needed.
 */
export function createEngine(platform: Platform, host: HTMLElement, events: EngineEvents, bundleBase: string): PlayerEngine {
  if (platform.name === 'tizen' && window.webapis?.avplay !== undefined) return createAvPlayEngine(host, events);
  if (platform.name === 'webos') return createWebosEngine(host, events, bundleBase);
  return createHtml5Engine(host, events, bundleBase, 'html5');
}
