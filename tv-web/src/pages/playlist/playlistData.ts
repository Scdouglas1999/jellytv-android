/**
 * The playlist page's requests (upstream's PlaylistViewModel): the playlist, whether this user may edit it, its items
 * under the chosen sort and filters, removing an item and moving one (with Jellyfin 10.10's move corrected, see
 * pagesFormat.movePlan). The sort and filters are remembered per playlist, as upstream's LibraryDisplayInfo.
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api';
import { currentApi, session } from '../../api/jellyfin';
import { readJson, writeJson } from '../../util/storage';
import { BOX_SET_SORTS, filterParams, sortParams, type FilterKind, type LibraryFilter, type SortAndDirection } from '../library/libraryModel';
import { applyMove, moveIsOffByOne, movePlan } from '../collection/pagesFormat';

const FIELDS = [ItemFields.Overview, ItemFields.SortName, ItemFields.PrimaryImageAspectRatio, ItemFields.MediaSourceCount];
const IMAGE_TYPES = [ImageType.Primary, ImageType.Thumb, ImageType.Backdrop];
/** The most rows the page lists (upstream pages them in; a TV's page stays light). */
export const PLAYLIST_LIMIT = 300;

function userId(): string {
  return session.get()?.userId ?? '';
}

/** Upstream's BoxSetSortOptions (DEFAULT is the playlist's own order) and DefaultPlaylistItemsOptions. */
export const PLAYLIST_SORTS = BOX_SET_SORTS;
export const PLAYLIST_FILTERS: readonly FilterKind[] = ['played', 'favorite', 'communityRating', 'officialRating', 'video', 'year', 'decade'];
export const PLAYLIST_DEFAULT_SORT: SortAndDirection = { sort: ItemSortBy.Default, direction: SortOrder.Ascending };

export interface PlaylistDisplay {
  sort: SortAndDirection;
  filter: LibraryFilter;
}

export function loadPlaylistDisplay(playlistId: string): PlaylistDisplay {
  const saved = readJson<Partial<PlaylistDisplay>>(`tally.playlist.v1.${userId()}.${playlistId}`);
  const sort = saved?.sort !== undefined && PLAYLIST_SORTS.indexOf(saved.sort.sort) >= 0 ? saved.sort : PLAYLIST_DEFAULT_SORT;
  return { sort, filter: saved?.filter ?? {} };
}

export function savePlaylistDisplay(playlistId: string, display: PlaylistDisplay): void {
  writeJson(`tally.playlist.v1.${userId()}.${playlistId}`, display);
}

/** Whether this user may change the playlist (a 404 means no permission entry: not editable, as upstream reads it). */
export async function canEditPlaylist(playlistId: string): Promise<boolean> {
  try {
    return (await getPlaylistApi(currentApi()).getPlaylistUser({ playlistId, userId: userId() })).data.CanEdit === true;
  } catch {
    return false;
  }
}

/** The playlist's items in the chosen order (DEFAULT: the playlist's own), filtered. */
export async function loadPlaylistItems(playlistId: string, display: PlaylistDisplay): Promise<BaseItemDto[]> {
  const r = await getLibraryApi(currentApi()).getItems({
    userId: userId(),
    parentId: playlistId,
    fields: FIELDS,
    enableImageTypes: IMAGE_TYPES,
    enableUserData: true,
    limit: PLAYLIST_LIMIT,
    ...sortParams(display.sort, false),
    ...filterParams(display.filter),
  });
  return r.data.Items ?? [];
}

/** Upstream's removeFromServerPlaylist: the item's id as the entry (what Jellyfin 10.10 and 12 match). */
export async function removeFromPlaylist(playlistId: string, itemId: string): Promise<void> {
  await getPlaylistApi(currentApi()).removeItemFromPlaylist({ playlistId, entryIds: [itemId] });
}

/**
 * Moves the item at `from` to `to` in `items` (the playlist in its own order), with as many calls as this server
 * needs (movePlan). Resolves with the order the server should now have.
 */
export async function moveInPlaylist(playlistId: string, items: readonly BaseItemDto[], from: number, to: number): Promise<BaseItemDto[]> {
  const offByOne = moveIsOffByOne(session.get()?.serverVersion ?? '');
  let order = items.slice();
  for (const step of movePlan(order.length, from, to, offByOne)) {
    const id = order[step.at]?.Id;
    if (id == null) break;
    await getPlaylistApi(currentApi()).moveItem({ playlistId, itemId: id, newIndex: step.request });
    order = applyMove(order, step.at, step.request, offByOne);
  }
  return order;
}
