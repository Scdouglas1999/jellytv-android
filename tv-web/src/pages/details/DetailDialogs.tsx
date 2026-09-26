/**
 * The dialogs an item page opens (tally/UI.md ItemDialogsHost): the item menu (MORE, or MENU on a card), a person's
 * menu, the full overview, confirmations, the trailer list, Add to playlist and Media information. Every one is a
 * Tally Panel; closing one puts focus back where it was.
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaUrl } from '@jellyfin/sdk/lib/generated-client/models/media-url';
import { useEffect, useState } from 'preact/hooks';
import { setFocus } from '../../focus/focus';
import { Panel, type PanelEntry } from '../../kit/Panel';
import { push } from '../../router/router';
import { formatRuntime } from '../../util/format';
import { addToPlaylist, loadItem, loadPlaylists, setFavorite, setPlayed } from './detailsData';
import { isPlayable, openDetails, playItem } from './navigate';

export type Trailer = { kind: 'local'; item: BaseItemDto } | { kind: 'remote'; url: MediaUrl };

export type Dialog =
  | {
      kind: 'menu';
      item: BaseItemDto;
      goTo?: () => void;
      returnKey: string;
      /** Opened on a Continue watching card (Android's canRemoveContinueWatching): offers Remove from continue watching. */
      continueWatching?: boolean;
      /** Runs as Remove from continue watching is chosen (the row drops the card at once). */
      onRemovedFromContinueWatching?: () => void;
      /** Opened in a playlist its user can edit (Android's showRemoveFromPlaylist): offers Remove from playlist. */
      onRemoveFromPlaylist?: () => void;
    }
  | { kind: 'person'; personId: string; name: string; returnKey: string }
  | { kind: 'overview'; title: string; text: string; returnKey: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; onConfirm: () => void; returnKey: string }
  | { kind: 'trailers'; title: string; trailers: Trailer[]; returnKey: string }
  | { kind: 'playlists'; item: BaseItemDto; returnKey: string }
  | { kind: 'info'; item: BaseItemDto; returnKey: string };

/** Opens a remote (YouTube) trailer where the platform can: a new tab in a browser. */
export function openRemoteTrailer(url: MediaUrl): void {
  if (url.Url == null) return;
  window.open(url.Url, '_blank', 'noopener');
}

function playTrailer(t: Trailer): void {
  if (t.kind === 'local') playItem(t.item, true);
  else openRemoteTrailer(t.url);
}

/** A trailer: the one plays, several open the list (Android TrailerDialog). */
export function onTrailer(trailers: Trailer[], open: () => void): void {
  const first = trailers[0];
  if (trailers.length === 1 && first !== undefined) playTrailer(first);
  else if (trailers.length > 1) open();
}

/**
 * The item menu's entries, in upstream's order (TallyContextMenu.kt itemMenuActions): Go to, Resume / Play from
 * start or Play, Remove from playlist, Add to playlist, Remove from continue watching, Mark watched, Favorite, Go to
 * series, Media information.
 */
export function itemMenuEntries(d: Extract<Dialog, { kind: 'menu' }>, run: (action: () => void | Promise<void>, changed?: boolean) => void, sub: (d: Dialog) => void): PanelEntry[] {
  const { item, goTo, returnKey } = d;
  const entries: PanelEntry[] = [];
  if (goTo !== undefined) entries.push({ key: 'goto', label: 'Go to', onPress: () => run(goTo) });
  if (isPlayable(item)) {
    if ((item.UserData?.PlaybackPositionTicks ?? 0) > 0) {
      entries.push({ key: 'resume', label: 'Resume', onPress: () => run(() => playItem(item)) });
      entries.push({ key: 'start', label: 'Play from start', onPress: () => run(() => playItem(item, true)) });
    } else {
      entries.push({ key: 'play', label: 'Play', onPress: () => run(() => playItem(item, true)) });
    }
  }
  const removeFromPlaylist = d.onRemoveFromPlaylist;
  if (removeFromPlaylist !== undefined) entries.push({ key: 'unlist', label: 'Remove from playlist', onPress: () => run(removeFromPlaylist) });
  entries.push({ key: 'playlist', label: 'Add to playlist', onPress: () => sub({ kind: 'playlists', item, returnKey }) });
  const played = item.UserData?.Played === true;
  // upstream's "Remove from continue watching" is its Mark unwatched: the resume point goes, the card leaves the row
  if (d.continueWatching === true && !played && (item.UserData?.PlaybackPositionTicks ?? 0) > 0) {
    entries.push({
      key: 'uncontinue',
      label: 'Remove from continue watching',
      onPress: () =>
        run(() => {
          d.onRemovedFromContinueWatching?.();
          return setPlayed(item.Id ?? '', false);
        }, true),
    });
  }
  entries.push({ key: 'watched', label: played ? 'Mark unwatched' : 'Mark watched', onPress: () => run(() => setPlayed(item.Id ?? '', !played), true) });
  const favorite = item.UserData?.IsFavorite === true;
  entries.push({ key: 'favorite', label: favorite ? 'Unfavorite' : 'Favorite', onPress: () => run(() => setFavorite(item.Id ?? '', !favorite), true) });
  const seriesId = item.SeriesId;
  if (seriesId != null && item.Type !== 'Series') entries.push({ key: 'series', label: 'Go to series', onPress: () => run(() => push({ name: 'item', itemId: seriesId })) });
  if ((item.MediaSources ?? []).length > 0) entries.push({ key: 'info', label: 'Media information', onPress: () => sub({ kind: 'info', item, returnKey }) });
  return entries;
}

function streamLine(s: NonNullable<NonNullable<BaseItemDto['MediaSources']>[number]['MediaStreams']>[number]): { label: string; supporting: string } {
  const parts: string[] = [];
  if (s.Codec != null) parts.push(s.Codec.toUpperCase());
  if (s.Type === 'Video' && s.Width != null && s.Height != null) parts.push(`${s.Width}x${s.Height}`);
  if (s.Type === 'Video' && s.RealFrameRate != null) parts.push(`${Math.round(s.RealFrameRate * 100) / 100} fps`);
  if (s.Type === 'Audio' && s.ChannelLayout != null) parts.push(s.ChannelLayout);
  if (s.BitRate != null && s.BitRate > 0) parts.push(`${Math.round(s.BitRate / 100_000) / 10} Mbps`);
  if (s.Language != null) parts.push(s.Language);
  if (s.IsExternal === true) parts.push('external');
  return { label: `${s.Type ?? ''} · ${s.DisplayTitle ?? s.Title ?? ''}`, supporting: parts.join(' · ') };
}

function infoEntries(item: BaseItemDto, close: () => void): PanelEntry[] {
  const source = item.MediaSources?.[0];
  if (source === undefined) return [];
  const file: string[] = [];
  if (source.Container != null) file.push(source.Container.toUpperCase());
  if (source.Size != null && source.Size > 0) file.push(`${Math.round(source.Size / 1_048_576)} MB`);
  if (source.Bitrate != null && source.Bitrate > 0) file.push(`${Math.round(source.Bitrate / 100_000) / 10} Mbps`);
  if ((source.RunTimeTicks ?? 0) > 0) file.push(formatRuntime(source.RunTimeTicks ?? 0));
  const entries: PanelEntry[] = [{ key: 'file', label: source.Name ?? item.Name ?? '', supporting: file.join(' · '), onPress: close }];
  (source.MediaStreams ?? []).forEach((s, i) => {
    const line = streamLine(s);
    entries.push({ key: 's' + String(i), label: line.label, supporting: line.supporting, onPress: close });
  });
  return entries;
}

function PlaylistPanel(props: { item: BaseItemDto; focusKey: string; onClose: () => void }) {
  const [playlists, setPlaylists] = useState<BaseItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadPlaylists()
      .then(setPlaylists)
      .catch(() => setError('Could not load your playlists.'));
  }, []);
  const entries: PanelEntry[] = (playlists ?? []).map((p) => ({
    key: p.Id ?? '',
    label: p.Name ?? '',
    onPress: () => {
      void addToPlaylist(p.Id ?? '', props.item.Id ?? '').finally(props.onClose);
    },
  }));
  const body = error ?? (playlists === null ? 'Loading…' : playlists.length === 0 ? 'No playlists yet.' : null);
  // the panel mounts again once the list is in, so its first row takes focus
  return <Panel key={playlists === null ? 'wait' : 'ready'} title="Add to playlist" body={body} entries={entries} focusKey={props.focusKey} onClose={props.onClose} />;
}

function PersonPanel(props: { personId: string; name: string; focusKey: string; onClose: () => void }) {
  const [person, setPerson] = useState<BaseItemDto | null>(null);
  useEffect(() => {
    loadItem(props.personId)
      .then(setPerson)
      .catch(() => undefined);
  }, []);
  const favorite = person?.UserData?.IsFavorite === true;
  const entries: PanelEntry[] = [{ key: 'goto', label: 'Go to', onPress: () => { props.onClose(); push({ name: 'item', itemId: props.personId }); } }];
  if (person !== null) {
    entries.push({ key: 'fav', label: favorite ? 'Unfavorite' : 'Favorite', onPress: () => void setFavorite(props.personId, !favorite).finally(props.onClose) });
  }
  return <Panel key={person === null ? 'wait' : 'ready'} title={props.name} entries={entries} focusKey={props.focusKey} onClose={props.onClose} />;
}

/** Renders `dialog` (null: nothing). `onChanged` runs after an action that changed the item (watched, favorite). */
export function DetailDialogs(props: { dialog: Dialog | null; setDialog: (d: Dialog | null) => void; pageKey: string; onChanged: () => void }) {
  const d = props.dialog;
  if (d === null) return null;
  const focusKey = props.pageKey + '-dialog';
  const close = (): void => {
    props.setDialog(null);
    window.setTimeout(() => setFocus(d.returnKey), 0);
  };
  const run = (action: () => void | Promise<void>, changed = false): void => {
    close();
    const result = action();
    if (changed && result instanceof Promise) {
      result.then(props.onChanged).catch(() => undefined);
    }
  };
  switch (d.kind) {
    case 'menu':
      return <Panel key={'menu-' + (d.item.Id ?? '')} title={d.item.Name ?? ''} entries={itemMenuEntries(d, run, (next) => props.setDialog(next))} focusKey={focusKey} onClose={close} />;
    case 'person':
      return <PersonPanel personId={d.personId} name={d.name} focusKey={focusKey} onClose={close} />;
    case 'overview':
      return <Panel title={d.title} body={d.text} entries={[{ key: 'close', label: 'Close', onPress: close }]} focusKey={focusKey} onClose={close} />;
    case 'confirm':
      return (
        <Panel
          title={d.title}
          body={d.body}
          entries={[
            { key: 'cancel', label: 'Cancel', onPress: close },
            { key: 'ok', label: d.confirmLabel, destructive: true, onPress: () => run(d.onConfirm) },
          ]}
          focusKey={focusKey}
          onClose={close}
        />
      );
    case 'trailers':
      return (
        <Panel
          title={d.title}
          entries={d.trailers.map((t, i) => ({
            key: String(i),
            label: t.kind === 'local' ? (t.item.Name ?? 'Trailer') : (t.url.Name ?? 'Trailer'),
            onPress: () => run(() => playTrailer(t)),
          }))}
          focusKey={focusKey}
          onClose={close}
        />
      );
    case 'playlists':
      return <PlaylistPanel item={d.item} focusKey={focusKey} onClose={close} />;
    case 'info':
      return <Panel title="Media information" entries={infoEntries(d.item, close)} focusKey={focusKey} onClose={close} />;
  }
}

/** The menu of a card in a row (Go to, play, watched, favorite…), for the MENU key. */
export function cardMenu(item: BaseItemDto, returnKey: string, goTo: () => void = () => openDetails(item)): Extract<Dialog, { kind: 'menu' }> {
  return { kind: 'menu', item, goTo, returnKey };
}
