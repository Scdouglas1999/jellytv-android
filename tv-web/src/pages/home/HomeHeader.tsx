import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { useState } from 'preact/hooks';
import { logoUrl } from '../../api/images';
import type { TallyGame } from '../../api/tallyModels';
import { episodeCode } from '../../kit/ItemCard';
import { formatRuntime, formatTime, gameStatusLabel, hasNoResult, tallyUppercase } from '../../util/format';

export type HomeFocus = { kind: 'item'; item: BaseItemDto; rowTitle: string } | { kind: 'game'; game: TallyGame; hideScores: boolean } | null;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type MetaPart = { text: string; boxed?: boolean };

/** `S1 E6 · OCT 6, 2018 · [TV-G] · 1m · ★ 6.9 · ENDS 12:53 AM` / `2021 · [PG-13] · 2h 35m · ★ 7.8`. */
export function itemMeta(item: BaseItemDto, now: Date = new Date()): MetaPart[] {
  const parts: MetaPart[] = [];
  const code = episodeCode(item);
  if (code !== null) parts.push({ text: code });
  if (item.Type === 'Episode' && item.PremiereDate != null) {
    const d = new Date(item.PremiereDate);
    if (!isNaN(d.getTime())) parts.push({ text: `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}, ${d.getUTCFullYear()}` });
  } else if (item.ProductionYear != null) {
    parts.push({ text: String(item.ProductionYear) });
  }
  if (item.OfficialRating != null && item.OfficialRating !== '') parts.push({ text: item.OfficialRating, boxed: true });
  const runtime = item.RunTimeTicks ?? 0;
  const timed = hasRuntime(item.Type);
  if (runtime > 0 && timed) parts.push({ text: formatRuntime(runtime) });
  if (item.CommunityRating != null) parts.push({ text: `★ ${item.CommunityRating.toFixed(1)}` });
  // as Android's homeMeta: no end time for something already watched (it would start over), or nothing left
  const left = runtime - (item.UserData?.PlaybackPositionTicks ?? 0);
  if (timed && item.UserData?.Played !== true && left > 0) {
    parts.push({ text: 'ENDS ' + formatTime(new Date(now.getTime() + left / 10_000)) });
  }
  return parts;
}

/** Kinds with a running time of their own (Android's BaseItemKind.hasRuntime). */
function hasRuntime(type: BaseItemDto['Type']): boolean {
  return type === 'Movie' || type === 'Episode' || type === 'Video' || type === 'MusicVideo' || type === 'Recording' || type === 'Audio';
}

function Meta(props: { parts: MetaPart[] }) {
  return (
    <div class="meta">
      {props.parts.map((p, i) => [
        i > 0 ? <span key={'s' + String(i)} class="sep">·</span> : null,
        <span key={'p' + String(i)} class={p.boxed === true ? 'rating' : undefined}>
          {tallyUppercase(p.text)}
        </span>,
      ])}
    </div>
  );
}

function ItemHeader(props: { item: BaseItemDto; rowTitle: string }) {
  const { item } = props;
  const logo = logoUrl(item);
  const [logoFailed, setLogoFailed] = useState(false);
  const title = item.Type === 'Episode' ? (item.SeriesName ?? item.Name ?? '') : (item.Name ?? '');
  return (
    <>
      <div class="kicker mono-label">{tallyUppercase(props.rowTitle)}</div>
      {logo !== null && !logoFailed ? (
        <div class="logo">
          <img src={logo} alt={title} onError={() => setLogoFailed(true)} />
        </div>
      ) : (
        <div class="title ellipsis">{title}</div>
      )}
      <Meta parts={itemMeta(item)} />
      {item.Overview != null ? <div class="overview clamp-2">{item.Overview}</div> : null}
    </>
  );
}

/**
 * The header's lines for a focused game (ui/home/TallyHomeHeader.kt TallyGameHeader): kicker `MLB · TOP 3RD` (the
 * league, never the sport), the matchup, the score line (the broadcasts for a game that has not started or has no
 * result), and the last play as the overview line (else "On ESPN" under a score). With scores hidden there is no
 * score and no last play.
 */
export function gameHeaderText(game: TallyGame, hideScores: boolean, now?: Date): { kicker: string; title: string; meta: string; overview: string } {
  const name = (t: TallyGame['away']): string => (t.shortName !== '' ? t.shortName : t.abbr !== '' ? t.abbr : t.name);
  const kicker = [game.league, gameStatusLabel(game, now)].filter((x) => x.trim() !== '').join(' · ');
  const showScore = !hideScores && game.state !== 'pre' && !hasNoResult(game.state, game.detail);
  const meta = showScore ? `${game.away.abbr} ${game.away.score ?? 0} · ${game.home.abbr} ${game.home.score ?? 0}` : game.broadcasts.join(' · ');
  const overview = hideScores
    ? ''
    : game.lastPlay !== null && game.lastPlay.trim() !== ''
      ? game.lastPlay
      : showScore && game.broadcasts.length > 0
        ? `On ${game.broadcasts.join(', ')}`
        : '';
  return { kicker, title: `${name(game.away)} at ${name(game.home)}`, meta, overview };
}

function GameHeader(props: { game: TallyGame; hideScores: boolean }) {
  const t = gameHeaderText(props.game, props.hideScores);
  return (
    <>
      <div class="kicker mono-label ellipsis">{tallyUppercase(t.kicker)}</div>
      <div class="title ellipsis">{t.title}</div>
      <Meta parts={t.meta !== '' ? [{ text: t.meta }] : []} />
      {t.overview !== '' ? <div class="overview clamp-2">{t.overview}</div> : null}
    </>
  );
}

/** The fixed-height header over Home's rows: whatever card has focus, described. */
export function HomeHeader(props: { focus: HomeFocus }) {
  const f = props.focus;
  return (
    <div class="home-header">
      {f === null ? null : f.kind === 'item' ? <ItemHeader key={f.item.Id} item={f.item} rowTitle={f.rowTitle} /> : <GameHeader game={f.game} hideScores={f.hideScores} />}
    </div>
  );
}
