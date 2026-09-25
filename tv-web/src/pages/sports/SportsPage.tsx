import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DvrState, type DvrJob, type DvrRule } from '../../api/tallyDvr';
import type { TallyChannel } from '../../api/tallyModels';
import type { PageProps } from '../../app/page';
import { currentFocusKey, focusExists, FocusGroup, setFocus, useFocusable } from '../../focus/focus';
import { IndicatorSquare } from '../../kit/Bits';
import { ToastHost } from '../../kit/Toast';
import { RecordingNoticeHost } from './RecordingNotice';
import type { Route } from '../../router/router';
import { tally } from '../../state/nav';
import { board, boardError, tallyUserSettings, useBoardPolling } from '../../state/sportsData';
import { formatTime, tallyUppercase } from '../../util/format';
import { createStore, useStore } from '../../util/store';
import { ChannelsGrid } from './ChannelsGrid';
import { dvrActions, dvrList, useDvrEnabled } from './dvrState';
import { jobTitle } from './dvrFormat';
import { GameActionsDialog, KeepLastDialog } from './GameActionsDialog';
import { GamesBoard } from './GamesBoard';
import { ConfirmDeleteDialog, JobMenu } from './RecordingsMenus';
import { RecordingsTab, recordingsTarget } from './RecordingsTab';
import { MultiviewQueueTab, SportsSettingsTab } from './SportsTabs';
import { addToMultiviewWithNotice, gameRoute, multiviewQueue, watchGame } from './sportsState';
import { useOkHold } from './useOkHold';
import './sportsPage.css';

export type SportsTab = 'games' | 'channels' | 'multiview' | 'recordings' | 'settings';

const TAB_LABELS: Record<SportsTab, string> = {
  games: 'Games',
  channels: 'Channels',
  multiview: 'Multiview',
  recordings: 'Recordings',
  settings: 'Settings',
};

/** The Sports tabs this server offers: RECORDINGS only when it records (tallyTabs). */
export function sportsTabs(dvr: boolean): SportsTab[] {
  return dvr ? ['games', 'channels', 'multiview', 'recordings', 'settings'] : ['games', 'channels', 'multiview', 'settings'];
}

const tabKey = (tab: SportsTab): string => 'sports-tab-' + tab;

function Tab(props: { tab: SportsTab; selected: boolean; onSelect: (tab: SportsTab) => void }) {
  const f = useFocusable<HTMLDivElement>({ focusKey: tabKey(props.tab), onEnter: () => props.onSelect(props.tab) });
  return (
    <div ref={f.ref} class={'sports-tab' + (props.selected ? ' selected' : '')} role="tab" onClick={() => props.onSelect(props.tab)}>
      <IndicatorSquare />
      <span class="label">{tallyUppercase(TAB_LABELS[props.tab])}</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  return <div class="sports-clock">{formatTime(now)}</div>;
}

/**
 * The Tally top bar (TallyTopBar.kt): the wordmark, the tabs, the clock. Moving onto a tab does not select it; OK
 * does. Coming up from the content always lands on the selected tab (the group prefers it and forgets the last one).
 */
function TopBar(props: { tabs: SportsTab[]; selected: SportsTab; onSelect: (tab: SportsTab) => void }) {
  const group = useFocusable<HTMLDivElement>({ focusKey: 'sports-tabs', saveLastFocusedChild: false, preferredChildFocusKey: tabKey(props.selected) });
  return (
    <div class="sports-topbar">
      <div class="wordmark">SPORTS</div>
      <div ref={group.ref} class="tabs">
        <FocusGroup focusKey="sports-tabs">
          {props.tabs.map((t) => (
            <Tab key={t} tab={t} selected={t === props.selected} onSelect={props.onSelect} />
          ))}
        </FocusGroup>
      </div>
      <Clock />
    </div>
  );
}

type Menu =
  | { kind: 'game'; gameId: string; returnKey: string }
  | { kind: 'job'; jobId: string; returnKey: string }
  | { kind: 'rule'; ruleId: string; returnKey: string }
  | { kind: 'confirm'; job: DvrJob; returnKey: string };

/**
 * Sports (TallyScreens.kt TallyPage): the top bar over the selected tab: GAMES (the board), CHANNELS (the grid),
 * MULTIVIEW (the queue), RECORDINGS (when the server records) and SETTINGS. HOLD OK on a game opens its actions, on
 * a channel adds it to multiview, on a recording opens its menu.
 */
export function SportsPage(props: PageProps<Extract<Route, { name: 'sports' }>>) {
  const plugin = useStore(tally);
  const current = useStore(board);
  const error = useStore(boardError);
  const settings = useStore(tallyUserSettings);
  const queue = useStore(multiviewQueue);
  const list = useStore(dvrList);
  const dvr = useDvrEnabled();
  useBoardPolling(props.active);

  const tabs = sportsTabs(dvr);
  const [selected, setSelected] = useState<SportsTab>('games');
  const tab = tabs.indexOf(selected) >= 0 ? selected : 'games';
  // what was focused last on the board and the grid: coming back to a tab lands there (no re-render on focus)
  const focusedGameId = useMemo(() => createStore<string | null>(null), []);
  const focusedChannelId = useRef<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const content = useFocusable<HTMLDivElement>({ focusKey: 'sports-content', saveLastFocusedChild: true });

  const games = current?.games ?? [];
  const favorites = useMemo(() => new Set(settings?.favorites ?? []), [settings]);
  const teams = useMemo(() => new Set((settings?.favoriteTeams ?? []).map((t) => t.toUpperCase())), [settings]);
  const hideScores = settings?.hideScores === true;
  // default on when at least one game is watchable, so the board is never mysteriously empty
  const onlyWatchable = settings?.onlyWatchable ?? games.some((g) => g.watch !== null);
  const loading = current === null && error === null;

  // focus goes back to what the menu was opened on (before a chosen action runs: see MenuDialog)
  const closeMenu = (): void => {
    const back = menu?.returnKey;
    setMenu(null);
    if (back !== undefined && focusExists(back)) setFocus(back);
  };

  // HOLD OK: what the focused thing offers
  useOkHold(
    () => {
      const key = currentFocusKey();
      if (key.indexOf('sg-') === 0 && key !== 'sg-empty') {
        const game = games.find((g) => 'sg-' + g.id === key);
        if (game === undefined) return false;
        setMenu({ kind: 'game', gameId: game.id, returnKey: key });
        return true;
      }
      if (key.indexOf('sc-') === 0 && key !== 'sc-empty') {
        addToMultiviewWithNotice(key.substring(3));
        return true;
      }
      const target = recordingsTarget(list, key);
      if (target !== null) {
        if ('rule' in target) {
          if (list?.canManage === true) setMenu({ kind: 'rule', ruleId: target.rule.id, returnKey: key });
        } else if (target.job.state === DvrState.FAILED) {
          if (list?.canManage === true) void dvrActions.dismiss(target.job.id);
        } else {
          setMenu({ kind: 'job', jobId: target.job.id, returnKey: key });
        }
        return true;
      }
      return false;
    },
    menu === null,
    props.active,
  );

  // OK on a tab selects it; its content takes focus when it appears (each tab's arrival)
  const select = (t: SportsTab): void => setSelected(t);

  const info = plugin.kind === 'available' ? plugin.info : null;
  let body;
  switch (tab) {
    case 'games':
      body = (
        <GamesBoard
          key="games"
          data={{ games, loading, boardError: error, hasBoard: current !== null, feedErrors: current?.errors ?? {}, favorites, teams, hideScores, onlyWatchable }}
          focusedGameId={focusedGameId}
          takeFocus={true}
          active={props.active}
        />
      );
      break;
    case 'channels':
      body = (
        <ChannelsGrid
          key="channels"
          channels={current?.channels ?? []}
          games={games}
          favorites={favorites}
          hideScores={hideScores}
          loading={loading}
          boardError={error}
          hasBoard={current !== null}
          focusedChannelId={focusedChannelId.current}
          onChannelFocus={(c: TallyChannel) => {
            focusedChannelId.current = c.id;
          }}
          takeFocus={true}
          active={props.active}
        />
      );
      break;
    case 'multiview':
      body = <MultiviewQueueTab key="multiview" queue={queue} channels={current?.channels ?? []} takeFocus={true} active={props.active} />;
      break;
    case 'recordings':
      body = (
        <RecordingsTab
          key="recordings"
          takeFocus={true}
          active={props.active}
          onJobMenu={(job) => setMenu({ kind: 'job', jobId: job.id, returnKey: currentFocusKey() })}
          onRule={(rule) => setMenu({ kind: 'rule', ruleId: rule.id, returnKey: currentFocusKey() })}
        />
      );
      break;
    default:
      body = <SportsSettingsTab key="settings" onlyWatchable={onlyWatchable} hideScores={hideScores} info={info} takeFocus={true} active={props.active} />;
  }

  const menuGame = menu?.kind === 'game' ? (games.find((g) => g.id === menu.gameId) ?? null) : null;
  const menuJob = menu?.kind === 'job' ? (list?.jobs.find((j) => j.id === menu.jobId) ?? null) : null;
  const menuRule: DvrRule | null = menu?.kind === 'rule' ? (list?.rules.find((r) => r.id === menu.ruleId) ?? null) : null;
  // the game or job left the board while its menu was open
  const stale = menu !== null && menu.kind !== 'confirm' && menuGame === null && menuJob === null && menuRule === null;
  useEffect(() => {
    if (stale) closeMenu();
  }, [stale]);

  return (
    <div class="sports-page">
      <TopBar tabs={tabs} selected={tab} onSelect={select} />
      <div ref={content.ref} class="sports-body">
        <FocusGroup focusKey="sports-content">{body}</FocusGroup>
      </div>
      {menuGame !== null ? (
        <GameActionsDialog
          game={menuGame}
          actions={{
            watch: gameRoute(menuGame) !== null ? () => watchGame(menuGame) : undefined,
            addToMultiview: menuGame.watch !== null && menuGame.watch.channelId !== '' ? () => addToMultiviewWithNotice(menuGame.watch?.channelId ?? '') : undefined,
            follow: true,
          }}
          hideScores={hideScores}
          favoriteTeams={teams}
          onDismiss={closeMenu}
        />
      ) : null}
      {menuJob !== null ? (
        <JobMenu
          job={menuJob}
          canManage={list?.canManage === true}
          onDelete={(job) => setMenu({ kind: 'confirm', job, returnKey: menu?.returnKey ?? '' })}
          onDismiss={closeMenu}
        />
      ) : null}
      {menuRule !== null ? (
        <KeepLastDialog
          teamLabel={menuRule.teamName ?? menuRule.title}
          rule={menuRule}
          onChoose={(n) => void dvrActions.changeKeepLast(menuRule.teamId ?? '', menuRule.leaguePath, n)}
          onDelete={() => void dvrActions.deleteRule(menuRule.id)}
          onDismiss={closeMenu}
        />
      ) : null}
      {menu?.kind === 'confirm' ? (
        <ConfirmDeleteDialog
          title={jobTitle(menu.job)}
          onCancel={closeMenu}
          onConfirm={() => {
            void dvrActions.deleteRecording(menu.job.id);
            closeMenu();
          }}
        />
      ) : null}
      <ToastHost />
      <RecordingNoticeHost active={props.active} pageKey={props.pageKey} />
    </div>
  );
}
