import { useEffect, useState } from 'preact/hooks';
import { allowsNewRecording, DvrState, recordingView, spoilerGuarded, teamRuleFor, type DvrRule, type GameRecordingView, type LibraryState } from '../../api/tallyDvr';
import { isLive, isUpcoming, teamKey, type TallyGame, type TallyTeam } from '../../api/tallyModels';
import { setFocus } from '../../focus/focus';
import { gameStatusLabel, tallyUppercase } from '../../util/format';
import { useStore } from '../../util/store';
import { matchupTitle, teamName } from '../../sports/SportsBits';
import { setHideScores, toggleFollowTeam } from '../../state/sportsData';
import { dvrActions, dvrEstimates, dvrList, loadEstimate, playRecording, useDvrEnabled, useDvrPolling, watchFromStart } from './dvrState';
import { estimateLine, KEEP_LAST_CHOICES, keepLastText, recordingStateText } from './dvrFormat';
import { MenuDialog, type MenuLine } from './MenuDialog';

/**
 * What can be done with a game from wherever it is shown; a missing action is not offered. `watchLabel` replaces
 * "Watch" where the game is already on screen (multiview: "Watch full screen").
 */
export interface GameActions {
  watch?: () => void;
  watchLabel?: string;
  addToMultiview?: () => void;
  removeFromMultiview?: () => void;
  /** Offer following each team (the board, the switcher, a multiview tile's game). */
  follow: boolean;
}

/** The DVR's part of a game's menu (GameDvr.kt): the job, the permission, the estimate, each team's rule. */
interface GameDvr {
  canManage: boolean;
  recording: GameRecordingView | null;
  /** A live game that won't fit: RECORD disabled with this reason. */
  refusal: string | null;
  /** The server's space warning or refusal, shown under RECORD (an upcoming game stays recordable). */
  spaceLine: string | null;
  estimate: string | null;
  awayRule: DvrRule | null;
  homeRule: DvrRule | null;
  guarded: boolean;
  /** A finished recording to watch (its item may still be on its way into a library: the notice then says so). */
  watchable: { itemId: string | null; libraryState: LibraryState } | null;
  startOverPath: string | null;
  canRecord: boolean;
}

/** The game's DVR while its menu is open: the list refreshed every 5 s, the estimate for a game still to record. */
function useGameDvr(game: TallyGame | null): GameDvr | null {
  const enabled = useDvrEnabled();
  const list = useStore(dvrList);
  const estimates = useStore(dvrEstimates);
  useDvrPolling(enabled && game !== null, 5000);
  useEffect(() => {
    if (enabled && game !== null && (isUpcoming(game) || isLive(game))) void loadEstimate(game.id);
  }, [enabled, game?.id]);
  if (!enabled || game === null) return null;
  const recording = recordingView(game, list);
  const canManage = list?.canManage === true;
  const storage = estimates[game.id];
  const shortOfSpace = storage?.estimate !== null && storage?.estimate !== undefined && !storage.estimate.fits ? storage.estimate.message : null;
  // an upcoming game that won't fit today stays recordable: the server schedules it and judges the space again when
  // it starts (GameDvr.kt)
  const refusal = isUpcoming(game) ? null : shortOfSpace;
  return {
    canManage,
    recording,
    refusal,
    spaceLine: shortOfSpace,
    estimate: estimateLine(storage),
    awayRule: list !== null ? teamRuleFor(list, game, game.away) : null,
    homeRule: list !== null ? teamRuleFor(list, game, game.home) : null,
    guarded: spoilerGuarded(game),
    watchable: recording !== null && recording.state === DvrState.DONE ? { itemId: recording.itemId, libraryState: recording.libraryState } : null,
    startOverPath: recording !== null && recording.state === DvrState.RECORDING ? recording.startOverPath : null,
    canRecord: canManage && (isUpcoming(game) || isLive(game)) && (recording === null || allowsNewRecording(recording)),
  };
}

/** RECORD and a job's state (dvrGameMenuLines): after Watch and multiview. Actions only with the permission. */
function dvrGameLines(game: TallyGame, dvr: GameDvr): MenuLine[] {
  const lines: MenuLine[] = [];
  const r = dvr.recording;
  const title = matchupTitle(game);
  if (r !== null && r.state !== DvrState.CANCELED) {
    const state = tallyUppercase(recordingStateText(r));
    if (r.state === DvrState.RECORDING) {
      const startOver = dvr.startOverPath;
      if (startOver !== null) {
        lines.push({ id: 'dvr-start', label: 'Watch from the start', info: state, infoLive: true, dismiss: true, onPress: () => watchFromStart(startOver, title) });
        if (dvr.canManage) lines.push({ id: 'dvr-stop', label: 'Stop recording', description: 'Stopping keeps what was recorded.', onPress: () => void dvrActions.cancel(r.jobId) });
      } else if (dvr.canManage) {
        lines.push({ id: 'dvr-stop', label: 'Stop recording', info: state, infoLive: true, description: 'Stopping keeps what was recorded.', onPress: () => void dvrActions.cancel(r.jobId) });
      } else {
        lines.push({ id: 'dvr-state', info: state, infoLive: true });
      }
    } else if ((r.state === DvrState.SCHEDULED || r.state === DvrState.WAITING) && dvr.canManage) {
      lines.push({ id: 'dvr-cancel', label: 'Cancel recording', info: state, onPress: () => void dvrActions.cancel(r.jobId) });
    } else if (r.state === DvrState.DONE && dvr.watchable !== null && dvr.guarded) {
      // "Watch the recording" leads the menu
    } else {
      lines.push({ id: 'dvr-state', info: state, infoLive: r.state === DvrState.FAILED });
    }
  }
  if (dvr.canRecord) {
    const refusalLine = dvr.spaceLine !== null && dvr.spaceLine !== r?.reason ? dvr.spaceLine : null;
    lines.push({
      id: 'dvr-record',
      label: 'Record',
      info: dvr.estimate !== null ? tallyUppercase(dvr.estimate) : null,
      enabled: dvr.refusal === null,
      description: refusalLine,
      onPress: () => void dvrActions.record(game),
    });
  }
  return lines;
}

/**
 * "Keep the last N games" for a team rule: all / 5 / 10 / 20 (the rule's choice marked); choosing one records every
 * game of the team (or changes the rule); with a rule, a last row stops recording them (DvrKeepLastTvDialog).
 */
export function KeepLastDialog(props: { teamLabel: string; rule: DvrRule | null; onChoose: (keepLast: number) => void; onDelete: () => void; onDismiss: () => void }) {
  const lines: MenuLine[] = KEEP_LAST_CHOICES.map((n) => ({
    id: 'keep-' + String(n),
    label: keepLastText(n),
    marked: props.rule !== null && props.rule.keepLast === n,
    dismiss: true,
    onPress: () => props.onChoose(n),
  }));
  if (props.rule !== null) lines.push({ id: 'keep-stop', label: `Stop recording every ${props.teamLabel} game`, dismiss: true, onPress: props.onDelete });
  return <MenuDialog focusKey="sports-keep-menu" title={`Record every ${props.teamLabel} game`} lines={lines} onDismiss={props.onDismiss} />;
}

/**
 * The HOLD OK menu for a game (GameActionsDialog.kt): Watch, Add to multiview, the DVR's lines, follow each team (and
 * record every game of it), hide or show scores, remove from multiview. Watch, multiview and remove close the menu;
 * follow and hide scores toggle in place. `game` null: a channel with no game (a multiview tile between games), titled
 * with `channelName`, without the follow rows.
 */
export function GameActionsDialog(props: {
  game: TallyGame | null;
  channelName?: string;
  actions: GameActions;
  hideScores: boolean;
  favoriteTeams: ReadonlySet<string>;
  onDismiss: () => void;
}) {
  const { game, actions } = props;
  const dvr = useGameDvr(game);
  const [scoreShown, setScoreShown] = useState(false);
  const [keepTeam, setKeepTeam] = useState<TallyTeam | null>(null);
  const lines: MenuLine[] = [];
  if (dvr !== null && dvr.guarded && dvr.watchable !== null && game !== null) {
    const w = dvr.watchable;
    lines.push({ id: 'watch-recording', label: 'Watch the recording', dismiss: true, onPress: () => void playRecording(w.itemId, w.libraryState, matchupTitle(game)) });
  }
  if (actions.watch !== undefined) lines.push({ id: 'watch', label: actions.watchLabel ?? 'Watch', dismiss: true, onPress: actions.watch });
  if (actions.addToMultiview !== undefined) lines.push({ id: 'multiview', label: 'Add to multiview', dismiss: true, onPress: actions.addToMultiview });
  if (game !== null && dvr !== null) lines.push(...dvrGameLines(game, dvr));
  const teamLines = (g: TallyGame, team: TallyTeam, side: 'away' | 'home'): void => {
    const key = teamKey(g, team);
    const followed = props.favoriteTeams.has(key);
    const name = teamName(team);
    lines.push({ id: 'follow-' + side, label: followed ? `Following the ${name}` : `Follow the ${name}`, onPress: () => void toggleFollowTeam(key) });
    if (dvr !== null && dvr.canManage && team.id !== '') {
      const rule = side === 'away' ? dvr.awayRule : dvr.homeRule;
      lines.push({
        id: 'rule-' + side,
        label: rule !== null ? `Recording every ${name} game` : `Record every ${name} game`,
        marked: rule !== null,
        onPress: () => setKeepTeam(team),
      });
    }
  };
  if (actions.follow && game !== null) {
    teamLines(game, game.away, 'away');
    teamLines(game, game.home, 'home');
  }
  lines.push({ id: 'hide-scores', label: props.hideScores ? 'Show scores' : 'Hide scores', onPress: () => void setHideScores(!props.hideScores) });
  if (dvr !== null && dvr.guarded) lines.push({ id: 'show-score', label: scoreShown ? 'Hide the score' : 'Show the score', onPress: () => setScoreShown(!scoreShown) });
  if (actions.removeFromMultiview !== undefined) lines.push({ id: 'remove', label: 'Remove from multiview', dismiss: true, onPress: actions.removeFromMultiview });

  const kicker = game !== null ? `${game.league.toUpperCase()}   ${gameStatusLabel(game)}` : null;
  const subtitle =
    game !== null && scoreShown ? `${teamName(game.away)} ${game.away.score ?? 0}  ·  ${teamName(game.home)} ${game.home.score ?? 0}` : null;
  const rule = keepTeam !== null && dvr !== null ? (keepTeam.id === game?.away.id ? dvr.awayRule : dvr.homeRule) : null;
  return (
    <>
      <MenuDialog
        focusKey="sports-game-menu"
        kicker={kicker}
        kickerLive={game !== null && isLive(game)}
        title={game !== null ? matchupTitle(game) : (props.channelName ?? '')}
        subtitle={subtitle}
        lines={lines}
        onDismiss={props.onDismiss}
      />
      {keepTeam !== null && game !== null ? (
        <KeepLastDialog
          teamLabel={teamName(keepTeam)}
          rule={rule}
          onChoose={(n) => void dvrActions.recordTeam(game, keepTeam, n)}
          onDelete={() => {
            if (rule !== null) void dvrActions.deleteRule(rule.id);
          }}
          onDismiss={() => {
            setKeepTeam(null);
            setFocus('sports-game-menu');
          }}
        />
      ) : null}
    </>
  );
}
