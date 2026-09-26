/*
 * The server DVR's client API (`/JellyTV/Client/v1/recordings…`, plugin feature `dvr`). A port of the Android app's
 * dvr/DvrModels.kt and dvr/TallyDvrApi.kt (the reference client): decoded leniently (unknown keys ignored, missing
 * keys take the defaults below). Nothing here ever carries a score.
 */
import axios, { type AxiosError } from 'axios';
import { currentApi } from './jellyfin';
import type { TallyGame, TallyTeam } from './tallyModels';

/** `GET /recordings`: every rule and job on the server, and whether this user may change them. */
export interface DvrList {
  /** The Jellyfin "manage recordings" permission (admins always have it). Without it every action is absent. */
  canManage: boolean;
  reason: string | null;
  rules: DvrRule[];
  /** Recording, finishing, waiting, scheduled first; then the finished ones, newest first. */
  jobs: DvrJob[];
}

export interface DvrRule {
  id: string;
  /** game | team */
  kind: string;
  title: string;
  /** Game rules: the game's league; team rules: the league it is limited to, empty = any league. */
  leaguePath: string;
  gameId: string | null;
  teamId: string | null;
  teamName: string | null;
  /** Team rules: keep the last N recorded games, 0 = all. */
  keepLast: number;
  createdByName: string;
}

export interface DvrTeam {
  id: string;
  abbr: string;
  name: string;
  shortName: string;
  logo: string;
}

export interface DvrJobGame {
  id: string;
  league: string;
  leaguePath: string;
  /** ISO-8601 */
  start: string;
  away: DvrTeam;
  home: DvrTeam;
}

export interface DvrJob {
  id: string;
  ruleId: string;
  state: string;
  reason: string | null;
  /** canceled | disk | maxLength | postponed | restart, when a recording stopped before the game's end. */
  stopReason: string | null;
  /** "Away at Home" */
  title: string;
  game: DvrJobGame;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  channelName: string | null;
  /** Bytes recorded so far. */
  bytes: number;
  /** Seconds recorded so far (the length of a finished recording). */
  seconds: number;
  fileBytes: number;
  itemId: string | null;
  /** Whether the recording can be played from a library yet (contract 3; resolved by `libraryStateOf`). */
  libraryState: LibraryState;
  /** Root-relative, signed start-over playlist, while recording. */
  startOverPath: string | null;
}

/**
 * Where a recording's library item stands (plugin contract 3): `ready` = it has an `itemId`; `adding` = a library
 * covers the recordings folder but Jellyfin has not picked the file up yet; `noLibrary` = no library covers the
 * folder. An older plugin sends no field: without an `itemId` that reads as `adding`.
 */
export type LibraryState = 'ready' | 'adding' | 'noLibrary';

export function libraryStateOf(itemId: string | null, raw: unknown): LibraryState {
  if (itemId !== null && itemId !== '') return 'ready';
  return raw === 'noLibrary' ? 'noLibrary' : 'adding';
}

/** What the app says instead of playing a recording that has no library item (contract 3's wording). */
export function libraryNotice(state: LibraryState): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'adding':
      return 'Still being added to the library. Try again in a minute.';
    case 'noLibrary':
      return 'This server has no library for recordings yet. Its owner can add one under Settings → Recordings.';
  }
}

/** `GET /recordings/storage[?gameId=]`. */
export interface DvrStorage {
  freeBytes: number | null;
  totalBytes: number | null;
  usedBytes: number;
  reserveBytes: number;
  estimate: DvrEstimate | null;
}

export interface DvrEstimate {
  gameId: string;
  bytes: number;
  fits: boolean;
  /** Why it won't fit ("Not enough space: needs ~9 GB, 4 GB free"), from the server. */
  message: string | null;
}

/** The job states, as the server names them. */
export const DvrState = {
  SCHEDULED: 'scheduled',
  WAITING: 'waiting',
  RECORDING: 'recording',
  FINISHING: 'finishing',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;

export const isPendingState = (state: string): boolean => state === DvrState.SCHEDULED || state === DvrState.WAITING;
export const isFinalState = (state: string): boolean => state === DvrState.DONE || state === DvrState.FAILED || state === DvrState.CANCELED;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function decodeTeam(v: unknown): DvrTeam {
  const o = obj(v);
  return { id: str(o.id), abbr: str(o.abbr), name: str(o.name), shortName: str(o.shortName), logo: str(o.logo) };
}

function decodeRule(v: unknown): DvrRule {
  const o = obj(v);
  return {
    id: str(o.id),
    kind: str(o.kind),
    title: str(o.title),
    leaguePath: str(o.leaguePath),
    gameId: strOrNull(o.gameId),
    teamId: strOrNull(o.teamId),
    teamName: strOrNull(o.teamName),
    keepLast: num(o.keepLast),
    createdByName: str(o.createdByName),
  };
}

function decodeJob(v: unknown): DvrJob {
  const o = obj(v);
  const g = obj(o.game);
  return {
    id: str(o.id),
    ruleId: str(o.ruleId),
    state: str(o.state),
    reason: strOrNull(o.reason),
    stopReason: strOrNull(o.stopReason),
    title: str(o.title),
    game: {
      id: str(g.id),
      league: str(g.league),
      leaguePath: str(g.leaguePath),
      start: str(g.start),
      away: decodeTeam(g.away),
      home: decodeTeam(g.home),
    },
    createdAt: strOrNull(o.createdAt),
    startedAt: strOrNull(o.startedAt),
    endedAt: strOrNull(o.endedAt),
    channelName: strOrNull(o.channelName),
    bytes: num(o.bytes),
    seconds: num(o.seconds),
    fileBytes: num(o.fileBytes),
    itemId: strOrNull(o.itemId),
    libraryState: libraryStateOf(strOrNull(o.itemId), o.libraryState),
    startOverPath: strOrNull(o.startOverPath),
  };
}

export function decodeDvrList(v: unknown): DvrList {
  const o = obj(v);
  return {
    canManage: o.canManage === true,
    reason: strOrNull(o.reason),
    rules: arr(o.rules).map(decodeRule),
    jobs: arr(o.jobs).map(decodeJob),
  };
}

export function decodeDvrStorage(v: unknown): DvrStorage {
  const o = obj(v);
  const e = o.estimate === null || o.estimate === undefined ? null : obj(o.estimate);
  return {
    freeBytes: numOrNull(o.freeBytes),
    totalBytes: numOrNull(o.totalBytes),
    usedBytes: num(o.usedBytes),
    reserveBytes: num(o.reserveBytes),
    estimate:
      e === null
        ? null
        : { gameId: str(e.gameId), bytes: num(e.bytes), fits: e.fits !== false, message: strOrNull(e.message) },
  };
}

/** What the app shows for one game's recording: the list's job when it has one (it knows the start), else the board's. */
export interface GameRecordingView {
  state: string;
  jobId: string;
  startedAt: string | null;
  startOverPath: string | null;
  itemId: string | null;
  libraryState: LibraryState;
  reason: string | null;
  seconds: number;
}

/** A game can be recorded (again) when it has no job, or only one that ended without recording it. */
export const allowsNewRecording = (v: GameRecordingView): boolean => v.state === DvrState.FAILED || v.state === DvrState.CANCELED;

/** The most relevant job of `gameId`: one still running first, then a finished recording, then the newest. */
export function jobForGame(jobs: readonly DvrJob[], gameId: string): DvrJob | null {
  const mine = jobs.filter((j) => j.game.id === gameId);
  if (mine.length === 0) return null;
  const rank = (j: DvrJob): number => (isFinalState(j.state) ? 1 : 0) * 2 + (j.state === DvrState.DONE ? 0 : 1);
  let best = mine[0] as DvrJob;
  for (const j of mine.slice(1)) {
    const a = rank(j);
    const b = rank(best);
    if (a < b || (a === b && (j.createdAt ?? '') > (best.createdAt ?? ''))) best = j;
  }
  return best;
}

/** `game`'s recording from the list when it has the game's job, else from the board. */
export function recordingView(game: TallyGame, list: DvrList | null): GameRecordingView | null {
  const job = list === null ? null : jobForGame(list.jobs, game.id);
  if (job !== null) {
    return {
      state: job.state,
      jobId: job.id,
      startedAt: job.startedAt,
      startOverPath: job.startOverPath ?? (job.state === DvrState.RECORDING ? (game.recording?.startOverPath ?? null) : null),
      itemId: job.itemId,
      libraryState: job.libraryState,
      reason: job.reason,
      seconds: job.seconds,
    };
  }
  const board = game.recording;
  if (board === null) return null;
  return { state: board.state, jobId: board.jobId, startedAt: null, startOverPath: board.startOverPath, itemId: board.itemId, libraryState: board.libraryState, reason: board.reason, seconds: 0 };
}

/** A finished game that has (or is making) a recording keeps its score and result out of sight (no spoilers). */
export function spoilerGuarded(game: TallyGame): boolean {
  const s = game.recording?.state;
  return game.state === 'post' && (s === DvrState.DONE || s === DvrState.FINISHING || s === DvrState.RECORDING);
}

/**
 * The team rule that records `team`'s games in `game`'s league. Rules name the league by its path ("baseball/mlb"),
 * the board by its label ("MLB"): a job of the same league tells which path that is; without one, the sport the path
 * starts with has to do (team ids are only unique within a league).
 */
export function teamRuleFor(list: DvrList, game: TallyGame, team: TallyTeam): DvrRule | null {
  if (team.id === '') return null;
  const known = list.jobs.find((j) => j.game.league.toLowerCase() === game.league.toLowerCase() && j.game.leaguePath !== '');
  const knownPath = known !== undefined ? known.game.leaguePath.toLowerCase() : null;
  return (
    list.rules.find((rule) => {
      if (rule.kind !== 'team' || rule.teamId !== team.id) return false;
      if (rule.leaguePath === '') return true;
      if (knownPath !== null) return rule.leaguePath.toLowerCase() === knownPath;
      return rule.leaguePath.split('/')[0]?.toLowerCase() === game.sport.toLowerCase();
    }) ?? null
  );
}

/** A DVR call the server refused or could not answer: `status` 0 = no answer; `serverMessage` = its `{"error"}`. */
export class DvrError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string | null,
  ) {
    super(serverMessage ?? 'HTTP ' + String(status));
  }
}

const BASE = '/JellyTV/Client/v1/recordings';

async function call(method: 'get' | 'post' | 'delete', path: string, body?: Json): Promise<unknown> {
  const api = currentApi();
  try {
    const response = await axios.request({
      method,
      url: api.basePath + path,
      data: body,
      headers: { Authorization: api.authorizationHeader, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return response.data;
  } catch (e) {
    const r = (e as AxiosError).response;
    if (r === undefined) throw new DvrError(0, null);
    const data = obj(r.data);
    throw new DvrError(r.status, typeof data.error === 'string' && data.error !== '' ? data.error : null);
  }
}

export const dvrApi = {
  list: async (): Promise<DvrList> => decodeDvrList(await call('get', BASE)),
  storage: async (gameId?: string): Promise<DvrStorage> =>
    decodeDvrStorage(await call('get', BASE + '/storage' + (gameId === undefined ? '' : '?gameId=' + encodeURIComponent(gameId)))),
  /** Records one game. */
  recordGame: (gameId: string): Promise<unknown> => call('post', BASE, { gameId }),
  /** Every game of a team in `league` (as the board names it, "MLB", or a rule's path / "*"); keeps the last `keepLast`, 0 = all. */
  recordTeam: (teamId: string, league: string, keepLast: number): Promise<unknown> => call('post', BASE, { teamId, league, keepLast }),
  /** Cancels a job that has not started, or stops a recording (what was recorded is kept). */
  cancelJob: (jobId: string): Promise<unknown> => call('delete', `${BASE}/jobs/${encodeURIComponent(jobId)}`),
  /** Deletes a finished recording (its file and library item), or dismisses a failed job. */
  deleteRecording: (jobId: string): Promise<unknown> => call('delete', `${BASE}/jobs/${encodeURIComponent(jobId)}/recording`),
  deleteRule: (ruleId: string): Promise<unknown> => call('delete', `${BASE}/rules/${encodeURIComponent(ruleId)}`),
};
