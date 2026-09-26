import { SERVER, adminToken, api } from './env';

/**
 * Puts back what a playback test changes on the dev server: the tracks Jellyfin remembers for the viewer and the
 * item's played state and resume point (the same steps as player.spec.ts, shared with webos.spec.ts).
 */
export interface UserData {
  PlaybackPositionTicks: number;
  PlayCount: number;
  Played: boolean;
  LastPlayedDate?: string;
  IsFavorite: boolean;
}

export interface Defaults {
  audio: number | null;
  subtitle: number | null;
}

const auth = (): Record<string, string> => ({ Authorization: `MediaBrowser Token="${adminToken()}"`, 'Content-Type': 'application/json' });

export async function userData(userId: string, itemId: string): Promise<UserData> {
  return api<UserData>(`/UserItems/${itemId}/UserData?userId=${userId}`);
}

export async function trackDefaults(userId: string, itemId: string): Promise<Defaults> {
  const r = await fetch(`${SERVER}/Items/${itemId}/PlaybackInfo?userId=${userId}`, { method: 'POST', headers: auth(), body: '{}' });
  const b = (await r.json()) as { MediaSources: Array<{ DefaultAudioStreamIndex?: number; DefaultSubtitleStreamIndex?: number }> };
  return { audio: b.MediaSources[0]?.DefaultAudioStreamIndex ?? null, subtitle: b.MediaSources[0]?.DefaultSubtitleStreamIndex ?? null };
}

/** A progress report with the tracks is how Jellyfin learns (and here: relearns) a viewer's choice. */
export async function restoreTracks(itemId: string, d: Defaults): Promise<void> {
  const post = (path: string, body: unknown) => fetch(`${SERVER}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  const common = { ItemId: itemId, MediaSourceId: itemId, PlaySessionId: 'e2e-restore', PositionTicks: 0 };
  await post('/Sessions/Playing/Progress', { ...common, AudioStreamIndex: d.audio, SubtitleStreamIndex: d.subtitle ?? -1, PlayMethod: 'DirectPlay' });
  await post('/Sessions/Playing/Stopped', common);
}

/** Written again until it stays put for 3 s (the server applies stop reports a few seconds after answering them). */
export async function restoreUserData(userId: string, itemId: string, data: UserData): Promise<void> {
  const same = (now: UserData): boolean =>
    now.Played === data.Played && now.PlayCount === data.PlayCount && now.PlaybackPositionTicks === data.PlaybackPositionTicks;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${SERVER}/UserItems/${itemId}/UserData?userId=${userId}`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        PlaybackPositionTicks: data.PlaybackPositionTicks,
        PlayCount: data.PlayCount,
        Played: data.Played,
        LastPlayedDate: data.LastPlayedDate ?? null,
        IsFavorite: data.IsFavorite,
      }),
    });
    if (!r.ok) throw new Error('restoring user data failed: HTTP ' + String(r.status));
    let stayed = true;
    for (let check = 0; check < 3 && stayed; check++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      stayed = same(await userData(userId, itemId));
    }
    if (stayed) return;
  }
  throw new Error('the user data of ' + itemId + ' did not stay restored');
}
