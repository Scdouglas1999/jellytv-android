/**
 * The DVR as the Sports screens see it (port of TallyDvrRepository + DvrViewModel): whether the server records
 * (`dvr` in /info's features), the rules and jobs list, the storage line and per-game estimates. The list is fetched
 * when a screen asks, every few seconds while the Recordings tab or a game's menu is open, and after every change the
 * app makes; a change also refreshes the board, whose cards carry each game's recording. Refusals come back as toasts
 * with the server's own reason.
 */
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { useEffect } from 'preact/hooks';
import { currentApi, session } from '../../api/jellyfin';
import { DvrError, dvrApi, type DvrList, type DvrStorage, type LibraryState } from '../../api/tallyDvr';
import type { TallyGame, TallyTeam } from '../../api/tallyModels';
import { showToast } from '../../kit/Toast';
import { push } from '../../router/router';
import { tally } from '../../state/nav';
import { showRecordingNotice } from './RecordingNotice';
import { refreshBoard } from '../../state/sportsData';
import { createStore, useStore } from '../../util/store';

export const dvrList = createStore<DvrList | null>(null);
export const dvrStorage = createStore<DvrStorage | null>(null);
/** Why the last list fetch failed; null after a good one. */
export const dvrError = createStore<string | null>(null);
/** gameId → the storage answer carrying that game's estimate. */
export const dvrEstimates = createStore<Record<string, DvrStorage>>({});

session.subscribe(() => {
  dvrList.set(null);
  dvrStorage.set(null);
  dvrError.set(null);
  dvrEstimates.set({});
});

/** The server records: the plugin lists the `dvr` feature. */
export function dvrEnabled(): boolean {
  const t = tally.get();
  return t.kind === 'available' && t.info.features.indexOf('dvr') >= 0;
}

export function useDvrEnabled(): boolean {
  const t = useStore(tally);
  return t.kind === 'available' && t.info.features.indexOf('dvr') >= 0;
}

/** Fetches the list, then the storage line (the list first: it is what the screens wait for). */
export async function refreshDvr(): Promise<void> {
  if (!dvrEnabled()) return;
  try {
    dvrList.set(await dvrApi.list());
    dvrError.set(null);
  } catch (e) {
    dvrError.set(e instanceof DvrError ? (e.serverMessage ?? e.message) : 'Could not load the recordings');
  }
  try {
    dvrStorage.set(await dvrApi.storage());
  } catch {
    // the storage line is optional
  }
}

/** Fetches how much recording `gameId` would take and whether it fits. */
export async function loadEstimate(gameId: string): Promise<void> {
  if (!dvrEnabled()) return;
  try {
    const answer = await dvrApi.storage(gameId);
    dvrEstimates.set({ ...dvrEstimates.get(), [gameId]: answer });
  } catch {
    // no estimate: RECORD is still offered
  }
}

/** Keeps the list fresh (every `ms`) while `active`. */
export function useDvrPolling(active: boolean, ms: number): void {
  const enabled = useDvrEnabled() && active;
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer = 0;
    const tick = (): void => {
      void refreshDvr().then(() => {
        if (alive) timer = window.setTimeout(tick, ms);
      });
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled, ms]);
}

/** Runs a change, says why when the server refuses it, then refreshes the list and the board whatever the outcome. */
async function act(run: () => Promise<unknown>, conflict?: string): Promise<void> {
  try {
    await run();
  } catch (e) {
    const err = e instanceof DvrError ? e : new DvrError(0, null);
    if (err.status === 409 && conflict !== undefined) showToast(conflict, 3500);
    else if (err.status === 0) showToast("Can't reach the server.", 3500);
    else showToast(err.serverMessage ?? 'The server could not do that.', 3500);
  } finally {
    void refreshDvr();
    void refreshBoard();
  }
}

export const dvrActions = {
  record: (game: TallyGame): Promise<void> => act(() => dvrApi.recordGame(game.id)),
  /** Every `team` game in `game`'s league, keeping the last `keepLast` (0 = all). Also changes an existing rule. */
  recordTeam: (game: TallyGame, team: TallyTeam, keepLast: number): Promise<void> => act(() => dvrApi.recordTeam(team.id, game.league, keepLast)),
  /** A rule's keep-last (the server updates the rule it already has for the team; its league path, or any league). */
  changeKeepLast: (teamId: string, leaguePath: string, keepLast: number): Promise<void> =>
    act(() => dvrApi.recordTeam(teamId, leaguePath === '' ? '*' : leaguePath, keepLast)),
  /** Cancels a job that has not started, or stops a recording (keeping what was recorded). */
  cancel: (jobId: string): Promise<void> => act(() => dvrApi.cancelJob(jobId)),
  /** Deletes a finished recording; 409 = someone is watching it. */
  deleteRecording: (jobId: string): Promise<void> => act(() => dvrApi.deleteRecording(jobId), 'Someone is watching this recording right now.'),
  /** Removes a failed (or canceled) job from the list. */
  dismiss: (jobId: string): Promise<void> => act(() => dvrApi.deleteRecording(jobId)),
  deleteRule: (ruleId: string): Promise<void> => act(() => dvrApi.deleteRule(ruleId)),
};

/**
 * Plays a finished recording (a library item) from where this user stopped watching it; without an item yet, the
 * notice says why (contract 3: still being added, or no library for recordings on the server).
 */
export async function playRecording(itemId: string | null, libraryState: LibraryState = 'adding', title = ''): Promise<void> {
  if (itemId === null || itemId === '') {
    showRecordingNotice(libraryState === 'ready' ? 'adding' : libraryState, title);
    return;
  }
  const s = session.get();
  let startMs = 0;
  if (s !== null) {
    try {
      const item = await getLibraryApi(currentApi()).getItem({ itemId, userId: s.userId });
      startMs = Math.floor((item.data.UserData?.PlaybackPositionTicks ?? 0) / 10_000);
    } catch {
      // no resume point: from the start
    }
  }
  push({ name: 'player', itemId, startMs });
}

/** WATCH FROM THE START: everything recorded so far of a game being recorded, from its first minute. */
export function watchFromStart(path: string, title: string): void {
  push({ name: 'startover', path, title });
}
