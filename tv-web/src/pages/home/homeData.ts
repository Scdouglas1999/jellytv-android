import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { getShowApi } from '@jellyfin/sdk/lib/utils/api/show-api';
import { currentApi, session } from '../../api/jellyfin';

export type RowState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'items'; items: BaseItemDto[] };

export interface HomeRowSpec {
  key: string;
  title: string;
  shape: 'poster' | 'landscape';
  watching: boolean;
  /** Continue watching: its item menu offers Remove from continue watching (Android's canRemoveContinueWatching). */
  continueWatching?: boolean;
  load: () => Promise<BaseItemDto[]>;
}

const FIELDS = [ItemFields.Overview, ItemFields.PrimaryImageAspectRatio, ItemFields.ChildCount];

/**
 * Upstream Wholphin's default home rows: Continue Watching, Next Up, then Recently Added per library (movies, shows,
 * music). The Tally games row is drawn above them by HomePage.
 */
export function homeRows(views: readonly BaseItemDto[]): HomeRowSpec[] {
  const userId = session.get()?.userId ?? '';
  const rows: HomeRowSpec[] = [
    {
      key: 'resume',
      title: 'Continue watching',
      shape: 'poster',
      watching: true,
      continueWatching: true,
      load: async () =>
        (
          await getLibraryApi(currentApi()).getResumeItems({
            userId,
            limit: 16,
            mediaTypes: [MediaType.Video],
            fields: FIELDS,
            enableUserData: true,
            enableTotalRecordCount: false,
          })
        ).data.Items ?? [],
    },
    {
      key: 'nextup',
      title: 'Next up',
      shape: 'poster',
      watching: true,
      load: async () =>
        (
          await getShowApi(currentApi()).getNextUp({
            userId,
            limit: 16,
            fields: FIELDS,
            enableUserData: true,
            enableTotalRecordCount: false,
          })
        ).data.Items ?? [],
    },
  ];
  for (const view of views) {
    const type = view.CollectionType;
    if (view.Id == null || (type !== 'movies' && type !== 'tvshows' && type !== 'music')) continue;
    const parentId = view.Id;
    rows.push({
      key: 'latest-' + parentId,
      title: 'Recently added in ' + (view.Name ?? ''),
      shape: 'poster',
      watching: false,
      load: async () =>
        (
          await getLibraryApi(currentApi()).getLatestMedia({
            userId,
            parentId,
            limit: 16,
            fields: FIELDS,
            enableUserData: true,
          })
        ).data,
    });
  }
  return rows;
}
