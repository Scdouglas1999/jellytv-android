import { useMemo, useRef, useState } from 'preact/hooks';
import { artUrl } from '../../api/tally';
import { isLive, type TallyChannel, type TallyGame } from '../../api/tallyModels';
import { useFocusable } from '../../focus/focus';
import { LabelBar } from '../../kit/Bits';
import { offsetWithin, reveal } from '../../kit/scroll';
import { stableSort } from '../../sports/homeRow';
import { EmptyState } from '../../sports/SportsBits';
import { useTabArrival } from './tabArrival';
import { watchChannel } from './sportsState';

export const channelFocusKey = (channel: TallyChannel): string => 'sc-' + channel.id;

/** "IND 7 · KC 0": abbreviation then score, away first. */
/** A card's picture width in the 4-column grid (sportsPage.css .channel-card, measured at 1080p). */
const CHANNEL_CARD_W = 384;

function scoreline(game: TallyGame): string {
  return [game.away, game.home].map((t) => `${t.abbr !== '' ? t.abbr : t.shortName} ${t.score === null ? '–' : String(t.score)}`).join(' · ');
}

/**
 * A channel card (ChannelCard.kt): the channel's 16:9 card image cropped onto the screen face, then a black label bar
 * with the channel name, the live indicator on, and the live game's scoreline in amber when scores are shown.
 */
function ChannelCard(props: { channel: TallyChannel; game: TallyGame | null; hideScores: boolean; onFocusCard: (el: HTMLElement, channel: TallyChannel) => void }) {
  const { channel } = props;
  const [failed, setFailed] = useState(false);
  const f = useFocusable<HTMLDivElement>({
    focusKey: channelFocusKey(channel),
    onEnter: () => watchChannel(channel),
    onFocus: () => {
      if (f.ref.current !== null) props.onFocusCard(f.ref.current, channel);
    },
  });
  const url = channel.cardPath !== '' ? artUrl(channel.cardPath, CHANNEL_CARD_W) : null;
  return (
    <div ref={f.ref} class="channel-card" onClick={() => watchChannel(channel)}>
      <div class="art">{url !== null && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : null}</div>
      <LabelBar text={channel.name} live={true}>
        {props.game !== null && !props.hideScores ? <span class="trailing mono-label">{scoreline(props.game)}</span> : null}
      </LabelBar>
    </div>
  );
}

/**
 * The channels tab (ChannelsGrid.kt): a 4-column grid of channel cards, favorites first then alphabetical. OK
 * watches, HOLD adds the channel to multiview. Opening the tab lands on the card focused last.
 */
export function ChannelsGrid(props: {
  channels: TallyChannel[];
  games: TallyGame[];
  favorites: ReadonlySet<string>;
  hideScores: boolean;
  loading: boolean;
  boardError: string | null;
  hasBoard: boolean;
  focusedChannelId: string | null;
  onChannelFocus: (channel: TallyChannel) => void;
  takeFocus: boolean;
  active: boolean;
}) {
  const sorted = useMemo(
    () =>
      stableSort(props.channels, (a, b) => {
        const fa = props.favorites.has(a.id) ? 1 : 0;
        const fb = props.favorites.has(b.id) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        const x = a.name.toLowerCase();
        const y = b.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      }),
    [props.channels, props.favorites],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const remembered = sorted.find((c) => c.id === props.focusedChannelId) ?? sorted[0] ?? null;
  const empty = props.loading || sorted.length === 0;
  useTabArrival(props.takeFocus && props.active, empty ? 'sc-empty' : remembered !== null ? channelFocusKey(remembered) : null, true);

  const onFocusCard = (el: HTMLElement, channel: TallyChannel): void => {
    props.onChannelFocus(channel);
    const s = scroller.current;
    if (s === null) return;
    const top = offsetWithin(el, s).top + s.scrollTop;
    s.scrollTop = reveal(s.scrollTop, s.clientHeight, top, el.offsetHeight, 43, 43, s.scrollHeight - s.clientHeight);
  };

  if (props.loading) return <EmptyState focusKey="sc-empty" class="tab-empty fill" title="Loading channels…" subtitle="" />;
  if (props.boardError !== null && !props.hasBoard) return <EmptyState focusKey="sc-empty" class="tab-empty fill" title="Board unavailable" subtitle={props.boardError} />;
  if (sorted.length === 0) {
    return <EmptyState focusKey="sc-empty" class="tab-empty fill" title="No channels yet" subtitle="Channels appear here once the server registers them" />;
  }
  return (
    <div ref={scroller} class="channels-grid">
      <div class="grid">
        {sorted.map((c) => (
          <ChannelCard
            key={c.id}
            channel={c}
            game={props.games.find((g) => isLive(g) && g.id === c.gameId) ?? null}
            hideScores={props.hideScores}
            onFocusCard={onFocusCard}
          />
        ))}
      </div>
    </div>
  );
}
