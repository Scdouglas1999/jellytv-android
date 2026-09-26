/**
 * Asking Jellyfin how to play an item (POST /Items/{id}/PlaybackInfo with this TV's DeviceProfile), turning the
 * answer into a stream URL, and reporting progress so resume points and Continue Watching stay right.
 */
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api';
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api';
import { currentApi, deviceId, session } from '../api/jellyfin';
import type { Platform } from '../platform/platform';
import { browserProbe, buildDeviceProfile, detectCapabilities } from './deviceProfile';
import type { NativeAudioTrack, Source } from './engine';
import { applyQualityToUrl, type QualityOption } from './qualityLadder';

/** Original quality's cap: high enough never to force a transcode on a LAN. */
export const ORIGINAL_MAX_BITRATE = 120_000_000;

export interface PlayRequest {
  itemId: string;
  /**
   * The media source to play. Required for a track choice to take effect: Jellyfin 10.10 ignores AudioStreamIndex
   * in PlaybackInfo unless the request names the source (measured on the dev server).
   */
  mediaSourceId?: string;
  startMs: number;
  audioIndex?: number;
  /** -1 = subtitles off. */
  subtitleIndex?: number;
  quality: QualityOption;
  /** Burn the chosen subtitle into the picture (image subtitles always are). */
  burnIn?: boolean;
}

export interface Track {
  index: number;
  label: string;
  language: string;
  isDefault: boolean;
}

export interface SubtitleTrack extends Track {
  /** Text subtitles are fetched as WebVTT and drawn by the app; image ones must be burned in. */
  text: boolean;
  /** Absolute WebVTT URL for text subtitles delivered externally. */
  vttUrl: string | null;
}

export interface Prepared {
  source: Source;
  mediaSource: MediaSourceInfo;
  playSessionId: string;
  method: 'DirectPlay' | 'DirectStream' | 'Transcode';
  /** What the viewer is told: the file as is, repackaged (remux: the only reason is the container), or converted. */
  delivery: 'direct' | 'remux' | 'convert';
  audio: Track[];
  subtitles: SubtitleTrack[];
  audioIndex: number | null;
  subtitleIndex: number | null;
  /** Height and bitrate of the source, for the quality ladder. */
  sourceHeight: number | null;
  sourceBitrate: number | null;
}

function label(s: MediaStream): string {
  return s.DisplayTitle ?? s.Title ?? s.Language ?? `Track ${String(s.Index)}`;
}

let profileCache: ReturnType<typeof buildDeviceProfile> | null = null;

export function deviceProfile(platform: Platform, maxBitrate: number): ReturnType<typeof buildDeviceProfile> {
  if (profileCache === null) {
    const display = platform.display();
    profileCache = buildDeviceProfile(
      detectCapabilities(platform.name, browserProbe(), { ...display, osVersion: platform.osVersion() }),
      ORIGINAL_MAX_BITRATE,
    );
  }
  return { ...profileCache, MaxStreamingBitrate: maxBitrate, MaxStaticBitrate: maxBitrate };
}

export async function preparePlayback(platform: Platform, req: PlayRequest): Promise<Prepared> {
  const api = currentApi();
  const s = session.get();
  if (s === null) throw new Error('signed out');
  const maxBitrate = req.quality.bitsPerSecond ?? ORIGINAL_MAX_BITRATE;
  const chosenQuality = req.quality.bitsPerSecond !== null;
  const info = (
    await getMediaInfoApi(api).getPostedPlaybackInfo({
      itemId: req.itemId,
      playbackInfoDto: {
        UserId: s.userId,
        MediaSourceId: req.mediaSourceId,
        DeviceProfile: deviceProfile(platform, maxBitrate),
        MaxStreamingBitrate: maxBitrate,
        StartTimeTicks: Math.floor(req.startMs * 10_000),
        AudioStreamIndex: req.audioIndex,
        SubtitleStreamIndex: req.subtitleIndex,
        // a chosen quality is a transcode by definition (see qualityLadder.ts)
        EnableDirectPlay: !chosenQuality,
        EnableDirectStream: !chosenQuality,
        EnableTranscoding: true,
        AllowVideoStreamCopy: !chosenQuality,
        AllowAudioStreamCopy: true,
        AutoOpenLiveStream: true,
        AlwaysBurnInSubtitleWhenTranscoding: req.burnIn === true,
      },
    })
  ).data;
  const ms = info.MediaSources?.[0];
  if (ms === undefined || ms.Id == null) throw new Error(info.ErrorCode != null ? `The server said: ${info.ErrorCode}` : 'Nothing to play.');
  const streams = ms.MediaStreams ?? [];
  const video = streams.find((x) => x.Type === 'Video');
  const token = s.token;
  const base = api.basePath;

  let url: string;
  let method: Prepared['method'];
  let kind: Source['kind'];
  if (ms.SupportsDirectPlay === true && !chosenQuality) {
    method = 'DirectPlay';
    kind = 'file';
    const params = new URLSearchParams({
      Static: 'true',
      MediaSourceId: ms.Id,
      DeviceId: deviceId(),
      ApiKey: token,
      PlaySessionId: info.PlaySessionId ?? '',
    });
    if (ms.ETag != null) params.set('Tag', ms.ETag);
    url = `${base}/Videos/${req.itemId}/stream.${ms.Container ?? 'mp4'}?${params.toString()}`;
  } else if (ms.TranscodingUrl != null) {
    method = ms.SupportsDirectStream === true && !chosenQuality ? 'DirectStream' : 'Transcode';
    kind = ms.TranscodingSubProtocol === 'hls' || ms.TranscodingUrl.indexOf('.m3u8') >= 0 ? 'hls' : 'file';
    url = applyQualityToUrl(base + ms.TranscodingUrl, req.quality);
  } else {
    throw new Error('The server offered no way to play this on this TV.');
  }

  const subtitles: SubtitleTrack[] = streams
    .filter((x) => x.Type === 'Subtitle' && x.Index != null)
    .map((x) => ({
      index: x.Index as number,
      label: label(x),
      language: x.Language ?? '',
      isDefault: x.IsDefault === true,
      text: x.IsTextSubtitleStream === true,
      vttUrl:
        x.IsTextSubtitleStream === true
          ? `${base}/Videos/${req.itemId}/${ms.Id}/Subtitles/${String(x.Index)}/0/Stream.vtt?ApiKey=${encodeURIComponent(token)}`
          : null,
    }));
  const audio: Track[] = streams
    .filter((x) => x.Type === 'Audio' && x.Index != null)
    .map((x) => ({ index: x.Index as number, label: label(x), language: x.Language ?? '', isDefault: x.IsDefault === true }));

  const reasons = /[?&]TranscodeReasons=([^&]*)/i.exec(url)?.[1];
  const remuxOnly = reasons !== undefined && decodeURIComponent(reasons).split(',').every((r) => r.trim() === 'ContainerNotSupported');
  return {
    delivery: method === 'DirectPlay' ? 'direct' : remuxOnly || method === 'DirectStream' ? 'remux' : 'convert',
    source: { url, kind, live: ms.IsInfiniteStream === true, startMs: req.startMs },
    mediaSource: ms,
    playSessionId: info.PlaySessionId ?? '',
    method,
    audio,
    subtitles,
    audioIndex: req.audioIndex ?? ms.DefaultAudioStreamIndex ?? null,
    subtitleIndex: req.subtitleIndex ?? ms.DefaultSubtitleStreamIndex ?? null,
    sourceHeight: video?.Height ?? null,
    sourceBitrate: ms.Bitrate ?? null,
  };
}

const ticks = (ms: number): number => Math.floor(ms * 10_000);

/** Start / progress / stop reports (/Sessions/Playing…). Failures are ignored: playback matters more. */
export function reporter(itemId: string, prepared: () => Prepared | null) {
  const common = (ms: number, paused: boolean) => {
    const p = prepared();
    return {
      ItemId: itemId,
      MediaSourceId: p?.mediaSource.Id ?? undefined,
      PlaySessionId: p?.playSessionId,
      PositionTicks: ticks(ms),
      IsPaused: paused,
      AudioStreamIndex: p?.audioIndex ?? undefined,
      SubtitleStreamIndex: p?.subtitleIndex ?? undefined,
      PlayMethod: p?.method,
      CanSeek: true,
    };
  };
  return {
    start(ms: number) {
      getSessionApi(currentApi()).reportPlaybackStart({ playbackStartInfo: common(ms, false) }).catch(() => undefined);
    },
    progress(ms: number, paused: boolean) {
      getSessionApi(currentApi()).reportPlaybackProgress({ playbackProgressInfo: common(ms, paused) }).catch(() => undefined);
    },
    stop(ms: number) {
      const p = prepared();
      getSessionApi(currentApi())
        .reportPlaybackStopped({
          playbackStopInfo: { ItemId: itemId, MediaSourceId: p?.mediaSource.Id ?? undefined, PlaySessionId: p?.playSessionId, PositionTicks: ticks(ms) },
        })
        .catch(() => undefined);
    },
  };
}

/**
 * The engine's own track for the chosen audio of a directly played file, or null when the engine has nothing to
 * switch (a stream the server made already carries the chosen track). AVPlay plays a file's first audio track unless
 * told otherwise, so without this a direct-played film ignored the viewer's (and Jellyfin's default) audio choice.
 * Tracks are matched by their order among the file's own audio streams (external audio files are not in the file).
 */
export function nativeAudioFor(p: Prepared, tracks: readonly NativeAudioTrack[]): number | null {
  if (p.method !== 'DirectPlay' || p.audioIndex === null || tracks.length < 2) return null;
  const internal = (p.mediaSource.MediaStreams ?? [])
    .filter((x) => x.Type === 'Audio' && x.IsExternal !== true && x.Index != null)
    .sort((a, b) => (a.Index as number) - (b.Index as number));
  const at = internal.findIndex((x) => x.Index === p.audioIndex);
  if (at < 0 || internal.length !== tracks.length) return null;
  const ordered = tracks.slice().sort((a, b) => a.index - b.index);
  return ordered[at]?.index ?? null;
}
