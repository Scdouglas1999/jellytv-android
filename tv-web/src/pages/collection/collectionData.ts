/**
 * The collection page's requests (upstream's CollectionViewModel): the box set, its items one row per type (or all
 * of them for the mixed grid) under the chosen sort and filters, and what PLAY / SHUFFLE queue. The sort, filters and
 * view options are remembered as upstream does (sort and filters per collection, the view options per user).
 */
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { currentApi, session } from '../../api/jellyfin';
import { readJson, writeJson } from '../../util/storage';
import { PLAY_ALL_MAX } from '../library/libraryData';
import { BOX_SET_SORTS, filterParams, sortParams, type LibraryFilter, type SortAndDirection } from '../library/libraryModel';
import { COLLECTION_TYPES } from './pagesFormat';

/** Upstream's SlimItemFields, plus what the cards and the header's meta line read. */
const FIELDS = [ItemFields.Overview, ItemFields.SortName, ItemFields.ChildCount, ItemFields.PrimaryImageAspectRatio, ItemFields.MediaSourceCount];
const IMAGE_TYPES = [ImageType.Primary, ImageType.Thumb, ImageType.Backdrop, ImageType.Logo];
/** Items per row (a collection is short; upstream pages them in as the row scrolls). */
const ROW_LIMIT = 200;

function userId(): string {
  return session.get()?.userId ?? '';
}

/** The sort a collection starts with: the server's own order (upstream's DEFAULT, the box set's display order). */
export const COLLECTION_DEFAULT_SORT: SortAndDirection = { sort: ItemSortBy.Default, direction: SortOrder.Ascending };
export const COLLECTION_SORTS = BOX_SET_SORTS;

export interface CollectionDisplay {
  sort: SortAndDirection;
  filter: LibraryFilter;
}

/** Upstream's CollectionViewOptions: one row per type (the default) or one mixed grid. */
export interface CollectionView {
  separateTypes: boolean;
}

export function loadCollectionDisplay(collectionId: string): CollectionDisplay {
  const saved = readJson<Partial<CollectionDisplay>>(`tally.collection.v1.${userId()}.${collectionId}`);
  const sort = saved?.sort !== undefined && COLLECTION_SORTS.indexOf(saved.sort.sort) >= 0 ? saved.sort : COLLECTION_DEFAULT_SORT;
  return { sort, filter: saved?.filter ?? {} };
}

export function saveCollectionDisplay(collectionId: string, display: CollectionDisplay): void {
  writeJson(`tally.collection.v1.${userId()}.${collectionId}`, display);
}

export function loadCollectionView(): CollectionView {
  const saved = readJson<Partial<CollectionView>>(`tally.collection.view.v1.${userId()}`);
  return { separateTypes: saved?.separateTypes !== false };
}

export function saveCollectionView(view: CollectionView): void {
  writeJson(`tally.collection.view.v1.${userId()}`, view);
}

/**
 * The box set's items of `types` (not recursive), sorted and filtered. A box set's own box sets are asked for by
 * excluding every other type, as upstream does (jellyfin/jellyfin#16454: includeItemTypes=BoxSet alone misses them).
 */
async function fetchItems(collectionId: string, display: CollectionDisplay, types: readonly string[], limit: number): Promise<BaseItemDto[]> {
  const kinds = types.length === 1 && types[0] === 'BoxSet' ? { excludeItemTypes: COLLECTION_TYPES.filter((t) => t !== 'BoxSet') as unknown as BaseItemKind[] } : { includeItemTypes: types as unknown as BaseItemKind[] };
  const r = await getLibraryApi(currentApi()).getItems({
    userId: userId(),
    parentId: collectionId,
    recursive: false,
    fields: FIELDS,
    enableImageTypes: IMAGE_TYPES,
    enableUserData: true,
    limit,
    ...sortParams(display.sort, false),
    ...filterParams(display.filter),
    ...kinds,
  });
  return r.data.Items ?? [];
}

export type RowLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'items'; items: BaseItemDto[] };

/** One row per type, each loaded on its own (a failed row says so, the others still show). */
export function loadTypeRows(collectionId: string, display: CollectionDisplay, onRow: (type: string, row: RowLoad) => void): void {
  for (const type of COLLECTION_TYPES) {
    fetchItems(collectionId, display, [type], ROW_LIMIT)
      .then((items) => onRow(type, { kind: 'items', items }))
      .catch((e: unknown) => onRow(type, { kind: 'error', message: e instanceof Error ? e.message : 'Could not load this row.' }));
  }
}

/** Every item of the collection in one list (the mixed grid). */
export function loadMixed(collectionId: string, display: CollectionDisplay): Promise<BaseItemDto[]> {
  return fetchItems(collectionId, display, COLLECTION_TYPES, ROW_LIMIT);
}

/**
 * What PLAY and SHUFFLE queue (upstream's PlaybackList with recursive = true): the playable items under the box set
 * (a show's episodes too), in the chosen order or a random one, at most PLAY_ALL_MAX.
 */
export async function collectionQueue(collectionId: string, display: CollectionDisplay, shuffle: boolean): Promise<BaseItemDto[]> {
  const sort = shuffle ? { sort: ItemSortBy.Random, direction: SortOrder.Ascending } : display.sort;
  const r = await getLibraryApi(currentApi()).getItems({
    userId: userId(),
    parentId: collectionId,
    recursive: true,
    includeItemTypes: ['Movie', 'Episode', 'Video', 'MusicVideo'] as unknown as BaseItemKind[],
    fields: [ItemFields.SortName],
    enableUserData: true,
    enableImages: false,
    limit: PLAY_ALL_MAX,
    ...sortParams(sort, false),
    ...filterParams(display.filter),
  });
  return r.data.Items ?? [];
}
