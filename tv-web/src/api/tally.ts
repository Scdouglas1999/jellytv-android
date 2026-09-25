/**
 * The Tally plugin's Client API (/JellyTV/Client/v1, server/README.md). Same session and Authorization header as
 * every Jellyfin call. HTTP 404 on /info means the server has no Tally plugin: the Tally sections must not appear.
 */
import axios, { type AxiosError } from 'axios';
import { currentApi } from './jellyfin';
import { decodeBoard, decodeInfo, decodeSettings, type TallyBoard, type TallyInfo, type TallySettings } from './tallyModels';

export class TallyNotInstalled extends Error {
  constructor() {
    super('The Tally server plugin is not installed');
  }
}

function status(e: unknown): number | undefined {
  return (e as AxiosError).response?.status;
}

async function get(path: string): Promise<unknown> {
  const api = currentApi();
  try {
    const response = await axios.get(api.basePath + path, {
      headers: { Authorization: api.authorizationHeader },
      timeout: 20000,
    });
    return response.data;
  } catch (e) {
    if (status(e) === 404) throw new TallyNotInstalled();
    throw e;
  }
}

/** Root-relative plugin paths (hlsPath, cardPath, backdropPath) made absolute. */
export function absolute(path: string): string {
  return currentApi().basePath + path;
}

/**
 * The device's time zone for the plugin's art (contract 2: times drawn in a card or backdrop use it), or null to let
 * the server use its own: when the runtime does not say, or says UTC while the clock is not at UTC (an old TV's
 * Intl without zone data reports UTC whatever the set is configured for).
 */
export function deviceTimeZone(now: Date = new Date(), resolved: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  let zone: string | undefined;
  try {
    zone = resolved();
  } catch {
    return null;
  }
  if (zone === undefined || zone === null || zone === '') return null;
  const utc = /^(Etc\/)?(UTC|UCT|GMT|Zulu|Universal)(\+0|-0|0)?$/i.test(zone);
  if (utc && now.getTimezoneOffset() !== 0) return null;
  return zone;
}

/**
 * A plugin art path (a game's `backdropPath`, a card's `cardPath`, which may already carry a query) made absolute,
 * asking for the width it is drawn at (contract 1: device pixels on the 1080p canvas; the server snaps it to its
 * sizes) and the device's zone (contract 2). Older plugins ignore both parameters.
 */
export function artUrl(path: string, drawnWidth: number, zone: string | null = deviceTimeZone()): string {
  return withArtParams(absolute(path), drawnWidth, zone);
}

/** `url` (which may already carry a query) with the art's `w=` and, when known, `tz=`. */
export function withArtParams(url: string, drawnWidth: number, zone: string | null): string {
  const params = ['w=' + String(Math.max(1, Math.round(drawnWidth)))];
  if (zone !== null) params.push('tz=' + encodeURIComponent(zone));
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
}

export async function tallyInfo(): Promise<TallyInfo> {
  return decodeInfo(await get('/JellyTV/Client/v1/info'));
}

/** Omit `since` on the first call (no events); afterwards pass the highest event id seen. */
export async function tallyBoard(since?: number): Promise<TallyBoard> {
  return decodeBoard(await get('/JellyTV/Client/v1/board' + (since === undefined ? '' : '?since=' + String(since))));
}

/** The raw settings document (kept whole: unknown keys belong to other clients and must survive a write). */
export async function tallySettingsRaw(): Promise<Record<string, unknown>> {
  const data = await get('/JellyTV/Client/v1/settings');
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

export async function tallySettings(): Promise<TallySettings> {
  return decodeSettings(await tallySettingsRaw());
}

/** Read-modify-write: `change` gets the whole document, returns it with its own keys changed. */
export async function updateTallySettings(change: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const api = currentApi();
  const doc = change(await tallySettingsRaw());
  await axios.put(api.basePath + '/JellyTV/Client/v1/settings', doc, {
    headers: { Authorization: api.authorizationHeader, 'Content-Type': 'application/json' },
  });
}
