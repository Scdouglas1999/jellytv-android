/*
 * The Tally Client API v1 contract (server: Jellyfin.Plugin.Tally, Client/BoardModels.cs; the Android app's
 * api/TallyModels.kt is the reference client). Decode leniently: unknown keys are ignored, missing keys take the
 * defaults below. `heat` and `tags` exist in the payload for other clients and are deliberately not modeled.
 * Never decide what the server already decided: which channel to watch is `watch`, full stop.
 */

export interface TallyInfo {
  apiVersion: number;
  pluginBuild: string | null;
  features: string[];
  pollSeconds: number;
  latestEventId: number;
}

export interface TallyTeam {
  id: string;
  abbr: string;
  name: string;
  shortName: string;
  location: string;
  logo: string;
  score: number | null;
  record: string | null;
  possession: boolean;
  winner: boolean;
  periods: number[];
  color: string;
  altColor: string;
}

export interface TallyWatch {
  channelId: string;
  channelName: string;
  liveTvItemId: string | null;
  /** Root-relative, signed, anonymous HLS (the plugin's continuous playlist). */
  hlsPath: string;
  cardPath: string;
  /** "teams" | "epg" | "network" */
  confidence: string;
}

/**
 * A game's recording as the board shows it (the server DVR's most relevant job for the game, feature `dvr`). Never
 * carries a score. States: scheduled | waiting | recording | finishing | done | failed | canceled.
 */
export interface TallyGameRecording {
  state: string;
  jobId: string;
  /** Root-relative, signed HLS of everything recorded so far (a growing EVENT playlist), while recording. */
  startOverPath: string | null;
  /** The Jellyfin library item of the finished recording, once the server has scanned it. */
  itemId: string | null;
  /** Whether it plays from a library yet (plugin contract 3, see tallyDvr.ts libraryStateOf). */
  libraryState: 'ready' | 'adding' | 'noLibrary';
  /** Why it is waiting, why it failed, or why it stopped early. */
  reason: string | null;
}

export interface TallyGame {
  id: string;
  sport: string;
  league: string;
  name: string;
  start: string;
  /** pre | in | post */
  state: string;
  detail: string;
  period: number;
  clock: string;
  home: TallyTeam;
  away: TallyTeam;
  lastPlay: string | null;
  downDistance: string | null;
  redZone: boolean;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  onFirst: boolean;
  onSecond: boolean;
  onThird: boolean;
  broadcasts: string[];
  watch: TallyWatch | null;
  backdropPath: string | null;
  /** The server DVR's job for this game; null when there is none (or the server does not record). */
  recording: TallyGameRecording | null;
}

export interface TallyProgramme {
  title: string;
  start: string;
  end: string;
}

export interface TallyStreamStatus {
  label: string;
  firstChoice: boolean;
  candidates: number;
  live: boolean;
}

export interface TallyChannel {
  id: string;
  name: string;
  group: string;
  logo: string | null;
  liveTvItemId: string | null;
  hlsPath: string;
  cardPath: string;
  gameId: string | null;
  now: TallyProgramme | null;
  next: TallyProgramme | null;
  stream: TallyStreamStatus | null;
}

export interface TallyEvent {
  id: number;
  source: string;
  kind: string;
  gameId: string | null;
  title: string;
  text: string;
  createdAt: string;
  watch: TallyWatch | null;
}

export interface TallyBoard {
  serverTime: string;
  games: TallyGame[];
  channels: TallyChannel[];
  events: TallyEvent[];
  errors: Record<string, string>;
}

/** Per-user settings shared with the web UI and the Android app. Unknown keys must round-trip (see TallyApi.putSettings). */
export interface TallySettings {
  favorites: string[];
  hideScores: boolean;
  lastChannel: string | null;
  onlyWatchable: boolean | null;
  favoriteTeams: string[];
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function decodeInfo(v: unknown): TallyInfo {
  const o = obj(v);
  return {
    apiVersion: num(o.apiVersion),
    pluginBuild: strOrNull(o.pluginBuild),
    features: arr(o.features).filter((f): f is string => typeof f === 'string'),
    pollSeconds: num(o.pollSeconds, 15),
    latestEventId: num(o.latestEventId),
  };
}

function decodeTeam(v: unknown): TallyTeam {
  const o = obj(v);
  return {
    id: str(o.id),
    abbr: str(o.abbr),
    name: str(o.name),
    shortName: str(o.shortName),
    location: str(o.location),
    logo: str(o.logo),
    score: numOrNull(o.score),
    record: strOrNull(o.record),
    possession: bool(o.possession),
    winner: bool(o.winner),
    periods: arr(o.periods).filter((p): p is number => typeof p === 'number'),
    color: str(o.color),
    altColor: str(o.altColor),
  };
}

function decodeWatch(v: unknown): TallyWatch | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    channelId: str(o.channelId),
    channelName: str(o.channelName),
    liveTvItemId: strOrNull(o.liveTvItemId),
    hlsPath: str(o.hlsPath),
    cardPath: str(o.cardPath),
    confidence: str(o.confidence),
  };
}

export function decodeGame(v: unknown): TallyGame {
  const o = obj(v);
  return {
    id: str(o.id),
    sport: str(o.sport),
    league: str(o.league),
    name: str(o.name),
    start: str(o.start),
    state: str(o.state, 'pre'),
    detail: str(o.detail),
    period: num(o.period),
    clock: str(o.clock),
    home: decodeTeam(o.home),
    away: decodeTeam(o.away),
    lastPlay: strOrNull(o.lastPlay),
    downDistance: strOrNull(o.downDistance),
    redZone: bool(o.redZone),
    balls: numOrNull(o.balls),
    strikes: numOrNull(o.strikes),
    outs: numOrNull(o.outs),
    onFirst: bool(o.onFirst),
    onSecond: bool(o.onSecond),
    onThird: bool(o.onThird),
    broadcasts: arr(o.broadcasts).filter((b): b is string => typeof b === 'string'),
    watch: decodeWatch(o.watch),
    backdropPath: strOrNull(o.backdropPath),
    recording: decodeRecording(o.recording),
  };
}

function decodeRecording(v: unknown): TallyGameRecording | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    state: str(o.state),
    jobId: str(o.jobId),
    startOverPath: strOrNull(o.startOverPath),
    itemId: strOrNull(o.itemId),
    libraryState: strOrNull(o.itemId) !== null && o.itemId !== '' ? 'ready' : o.libraryState === 'noLibrary' ? 'noLibrary' : 'adding',
    reason: strOrNull(o.reason),
  };
}

function decodeProgramme(v: unknown): TallyProgramme | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { title: str(o.title), start: str(o.start), end: str(o.end) };
}

export function decodeChannel(v: unknown): TallyChannel {
  const o = obj(v);
  const stream = o.stream === null || o.stream === undefined ? null : obj(o.stream);
  return {
    id: str(o.id),
    name: str(o.name),
    group: str(o.group),
    logo: strOrNull(o.logo),
    liveTvItemId: strOrNull(o.liveTvItemId),
    hlsPath: str(o.hlsPath),
    cardPath: str(o.cardPath),
    gameId: strOrNull(o.gameId),
    now: decodeProgramme(o.now),
    next: decodeProgramme(o.next),
    stream:
      stream === null
        ? null
        : {
            label: str(stream.label),
            firstChoice: bool(stream.firstChoice),
            candidates: num(stream.candidates),
            live: bool(stream.live),
          },
  };
}

export function decodeBoard(v: unknown): TallyBoard {
  const o = obj(v);
  const errors: Record<string, string> = {};
  const rawErrors = obj(o.errors);
  for (const k of Object.keys(rawErrors)) errors[k] = str(rawErrors[k]);
  return {
    serverTime: str(o.serverTime),
    games: arr(o.games).map(decodeGame),
    channels: arr(o.channels).map(decodeChannel),
    events: arr(o.events).map((e) => {
      const x = obj(e);
      return {
        id: num(x.id),
        source: str(x.source),
        kind: str(x.kind),
        gameId: strOrNull(x.gameId),
        title: str(x.title),
        text: str(x.text),
        createdAt: str(x.createdAt),
        watch: decodeWatch(x.watch),
      };
    }),
    errors,
  };
}

export function decodeSettings(v: unknown): TallySettings {
  const o = obj(v);
  return {
    favorites: arr(o.favorites).filter((f): f is string => typeof f === 'string'),
    hideScores: bool(o.hideScores),
    lastChannel: strOrNull(o.lastChannel),
    onlyWatchable: typeof o.onlyWatchable === 'boolean' ? o.onlyWatchable : null,
    favoriteTeams: arr(o.favoriteTeams).filter((f): f is string => typeof f === 'string'),
  };
}

export const isLive = (g: TallyGame): boolean => g.state === 'in';
export const isUpcoming = (g: TallyGame): boolean => g.state === 'pre';
export const isFinal = (g: TallyGame): boolean => g.state === 'post';

/** The settings key under which a team is followed ("NFL:KC"). */
export const teamKey = (g: TallyGame, t: TallyTeam): string => g.league.toUpperCase() + ':' + t.abbr.toUpperCase();

export const isFollowed = (g: TallyGame, teams: ReadonlySet<string>): boolean =>
  teams.has(teamKey(g, g.away)) || teams.has(teamKey(g, g.home));
