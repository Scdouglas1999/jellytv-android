/**
 * The DeviceProfile sent with every PlaybackInfo request: what this TV plays as is (direct play), and what the
 * server must convert to (HLS, H.264 or HEVC + AAC/AC-3). Built from two sources:
 *  - probes (`MediaSource.isTypeSupported` / `canPlayType`) for codecs the web engine reports honestly;
 *  - per-platform tables for what the native pipeline plays although the web engine does not say so (AVPlay plays
 *    MKV, TS, AC-3/E-AC-3 and HEVC from files that `canPlayType` knows nothing about).
 * Tables are conservative for 2020 sets (Tizen 5.5 / webOS 5); anything unlisted is transcoded, never refused.
 * DTS: Samsung left it out of 2018-2022 sets and LG out of 2020-2022 sets, so it is only offered when probed.
 * LG webOS has its own table per webOS version and per container (`webosDirect`, sources in ARCHITECTURE.md §6).
 */
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { ShellPlatform } from '../shell-contract/shell';

export interface Capabilities {
  platform: ShellPlatform;
  /** Containers played directly. */
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  /** Largest picture decoded (3840x2160 on UHD sets). */
  maxWidth: number;
  maxHeight: number;
  /** HEVC Main 10 / HDR10 / HLG shown as HDR. */
  hdr: boolean;
  /** Most audio channels output as is (surround passthrough on TVs). */
  maxAudioChannels: number;
  /** HEVC allowed inside the server's HLS (fewer bits for 4K transcodes; AVPlay and webOS play it). */
  hevcInHls: boolean;
  /**
   * Direct play per container (webOS: LG's AV format tables list codecs per container). Absent: one rule, every
   * container with every codec above.
   */
  direct?: DirectRule[];
  /** Highest H.264 level played as is (Jellyfin's VideoLevel: 51 = 5.1). */
  h264Level?: number;
  /** Highest HEVC level played as is (level × 30: 153 = 5.1, 123 = 4.1). */
  hevcLevel?: number;
  /** HEVC VideoRangeTypes played as is, and the containers Dolby Vision itself plays in (webOS). */
  hevcRanges?: string;
  dolbyVision?: { ranges: string; containers: string[] };
  /** FLAC in a video file: most channels (webOS: 2). */
  flacMaxChannels?: number;
}

export interface DirectRule {
  containers: string[];
  video: string[];
  audio: string[];
}

/** What the platform says about the TV (Platform.display + osVersion). */
export interface MediaHints {
  uhd: boolean;
  /** null: not reported (then UHD means HDR10/HLG). */
  hdr10: boolean | null;
  dolbyVision: boolean;
  /** webOS 5, 6, 22 … 25; Tizen 6.5; 0 unknown. */
  osVersion: number;
}

export type Probe = (mime: string) => boolean;

const MP4_VIDEO: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640029"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L150.B0"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  vp8: 'video/webm; codecs="vp8"',
};

const AUDIO: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  opus: 'audio/webm; codecs="opus"',
  flac: 'audio/flac',
  vorbis: 'audio/webm; codecs="vorbis"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  dts: 'audio/mp4; codecs="dtsc"',
};

const union = (a: string[], b: string[]): string[] => a.concat(b.filter((x) => a.indexOf(x) < 0));

/** What each platform's native pipeline plays from a file, whatever the probes say (2020 sets and later). */
const NATIVE: Record<ShellPlatform, { containers: string[]; video: string[]; audio: string[] }> = {
  tizen: {
    containers: ['mp4', 'm4v', 'mkv', 'webm', 'ts', 'mpegts', 'm2ts', 'mov', 'avi', 'mpg', 'mpeg', 'flv', '3gp', 'asf', 'wmv'],
    video: ['h264', 'hevc', 'mpeg2video', 'mpeg4', 'vp9', 'vc1'],
    audio: ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le', 'mp2'],
  },
  webos: {
    containers: ['mp4', 'm4v', 'mkv', 'webm', 'ts', 'mpegts', 'm2ts', 'mov', 'avi', 'mpg', 'mpeg'],
    video: ['h264', 'hevc', 'mpeg2video', 'mpeg4', 'vp9'],
    audio: ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'mp2'],
  },
  browser: { containers: ['mp4', 'm4v', 'webm'], video: ['h264'], audio: ['aac', 'mp3'] },
};

/**
 * Codecs a platform's web probe reports that its native player does not play from files: on the Tizen emulator
 * (Tizen 10, September 2026) MSE says yes to AV1 while AVPlay refuses an AV1 MKV (prepareAsync: InvalidAccessError).
 * They are left to the server (converted), which always works.
 */
const PROBE_NOT_NATIVE: Partial<Record<ShellPlatform, string[]>> = { tizen: ['av1'] };

export function detectCapabilities(platform: ShellPlatform, probe: Probe, uhdOrHints: boolean | MediaHints): Capabilities {
  const hints: MediaHints = typeof uhdOrHints === 'boolean' ? { uhd: uhdOrHints, hdr10: null, dolbyVision: false, osVersion: 0 } : uhdOrHints;
  if (platform === 'webos') return webosCapabilities(probe, hints);
  const uhd = hints.uhd;
  const skip = PROBE_NOT_NATIVE[platform] ?? [];
  const probedVideo = Object.keys(MP4_VIDEO).filter((c) => skip.indexOf(c) < 0 && probe(MP4_VIDEO[c] as string));
  const probedAudio = Object.keys(AUDIO).filter((c) => probe(AUDIO[c] as string));
  const native = NATIVE[platform];
  const tv = platform !== 'browser';
  return {
    platform,
    containers: native.containers,
    videoCodecs: union(native.video, probedVideo),
    audioCodecs: union(native.audio, probedAudio),
    maxWidth: uhd ? 3840 : 1920,
    maxHeight: uhd ? 2160 : 1080,
    hdr: tv && uhd,
    maxAudioChannels: tv ? 6 : 2,
    hevcInHls: tv && union(native.video, probedVideo).indexOf('hevc') >= 0,
  };
}

/**
 * LG webOS 5+ (2020 on), per LG's "AV Format" pages for webOS 5, 6, 22, 23, 24 and 25
 * (webostv.developer.lge.com/develop/specifications/video-audio-50 … -250), with jellyfin-web's webOS rules where LG
 * is silent or wrong (browserDeviceProfile.js):
 *  - MP4/MOV: H.264, MPEG-4, HEVC, AV1 (UHD sets) + AAC, MP3, AC-3, E-AC-3;
 *  - MKV: MPEG-2, MPEG-4, H.264, VP8, VP9 and AV1 (UHD sets), HEVC + AC-3, E-AC-3, AAC, PCM, MP2, MP3, FLAC (2
 *    channels: jellyfin-web), Opus from webOS 24 (LG adds it to MKV there);
 *  - TS: H.264, MPEG-2, HEVC + MP2, MP3, AC-3, E-AC-3, AAC, PCM; AVI: H.264, MPEG-4 + MP2, MP3, AC-3, PCM;
 *    MPEG-PS: MPEG-1/2 + MP2, MP3; WebM only where the engine says it plays VP9 (LG does not list WebM);
 *  - DTS: none on webOS 5, 6 and 22 (LG's pages list it, the 2020-2022 sets lack it: jellyfin-web and reviews);
 *    webOS 23+ "on specific models": only when the engine says so; TrueHD, VC-1, Vorbis in video: converted;
 *  - VP9 and AV1 only on UHD sets (LG lists them in the Ultra HD rows only); H.264 up to 5.1 on UHD sets, 4.2 on
 *    Full HD sets; HEVC 5.1 / 4.1 likewise;
 *  - HDR10/HLG where the TV reports it (UHD otherwise), Dolby Vision where it reports it, in MP4 and TS (and MKV
 *    from webOS 25: jellyfin-web), the Dolby Vision files' HDR10/HLG/SDR base layer everywhere else.
 * The server converts to HLS in MPEG-TS (H.264 or HEVC + AAC/AC-3/E-AC-3): LG's native HLS; never fMP4 (black screen
 * on some sets: jellyfin-webos #126). Anything else is converted, never refused.
 */
export function webosDirect(version: number, uhd: boolean, probe: Probe): DirectRule[] {
  const dts = version >= 23 && (probe('audio/mp4; codecs="dtsc"') || probe('audio/mp4; codecs="dts-"'));
  const plus = (list: string[], add: boolean, ...codecs: string[]): string[] => (add ? list.concat(codecs) : list);
  const rules: DirectRule[] = [
    { containers: ['mp4', 'm4v', 'mov'], video: plus(['h264', 'hevc', 'mpeg4'], uhd, 'av1'), audio: plus(['aac', 'mp3', 'ac3', 'eac3'], dts, 'dts') },
    {
      containers: ['mkv'],
      video: plus(['h264', 'hevc', 'mpeg2video', 'mpeg4', 'vp8'], uhd, 'vp9', 'av1'),
      audio: plus(plus(['aac', 'mp3', 'ac3', 'eac3', 'mp2', 'pcm_s16le', 'pcm_s24le', 'flac'], dts, 'dts'), version >= 24, 'opus'),
    },
    { containers: ['ts', 'mpegts', 'm2ts', 'mts'], video: ['h264', 'hevc', 'mpeg2video'], audio: plus(['aac', 'mp3', 'ac3', 'eac3', 'mp2', 'pcm_s16le'], dts, 'dts') },
    { containers: ['avi'], video: ['h264', 'mpeg4'], audio: ['mp3', 'ac3', 'mp2', 'pcm_s16le'] },
    { containers: ['mpg', 'mpeg'], video: ['mpeg1video', 'mpeg2video'], audio: ['mp2', 'mp3'] },
  ];
  if (probe('video/webm; codecs="vp9"')) {
    rules.push({ containers: ['webm'], video: plus(['vp8'], uhd, 'vp9', 'av1'), audio: ['vorbis', 'opus'] });
  }
  return rules;
}

function webosCapabilities(probe: Probe, hints: MediaHints): Capabilities {
  const { uhd, osVersion } = hints;
  const direct = webosDirect(osVersion, uhd, probe);
  const all = (pick: (r: DirectRule) => string[]): string[] => direct.reduce<string[]>((acc, r) => union(acc, pick(r)), []);
  const hdr = hints.hdr10 ?? uhd;
  // a Dolby Vision file's base layer (HDR10, HLG, SDR) plays on any HDR set (jellyfin-web adds these for webOS)
  const hevcRanges = hdr ? 'SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR' : 'SDR|DOVIWithSDR';
  return {
    platform: 'webos',
    containers: all((r) => r.containers),
    videoCodecs: all((r) => r.video),
    audioCodecs: all((r) => r.audio),
    maxWidth: uhd ? 3840 : 1920,
    maxHeight: uhd ? 2160 : 1080,
    hdr,
    maxAudioChannels: 6,
    hevcInHls: true,
    direct,
    h264Level: uhd ? 51 : 42,
    hevcLevel: uhd ? 153 : 123,
    hevcRanges,
    dolbyVision: hints.dolbyVision
      ? { ranges: hevcRanges + '|DOVI', containers: osVersion >= 25 ? ['mp4', 'm4v', 'mov', 'ts', 'mpegts', 'm2ts', 'mkv'] : ['mp4', 'm4v', 'mov', 'ts', 'mpegts', 'm2ts'] }
      : undefined,
    flacMaxChannels: 2,
  };
}

/** A probe on the running engine (MSE where it exists, else canPlayType). */
export function browserProbe(): Probe {
  const video = document.createElement('video');
  const ms = (window as unknown as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
  return (mime) => {
    try {
      if (ms !== undefined && ms.isTypeSupported(mime)) return true;
      return video.canPlayType(mime) !== '';
    } catch {
      return false;
    }
  };
}

export function buildDeviceProfile(caps: Capabilities, maxBitrate: number): DeviceProfile {
  const video = caps.videoCodecs.join(',');
  const audio = caps.audioCodecs.join(',');
  const hlsVideo = caps.hevcInHls ? 'hevc,h264' : 'h264';
  const hlsAudio = caps.audioCodecs.filter((a) => ['aac', 'ac3', 'eac3', 'mp3'].indexOf(a) >= 0).join(',') || 'aac';
  const size = [
    { Condition: 'LessThanEqual' as const, Property: 'Width' as const, Value: String(caps.maxWidth), IsRequired: false },
    { Condition: 'LessThanEqual' as const, Property: 'Height' as const, Value: String(caps.maxHeight), IsRequired: false },
  ];
  const ranges = caps.hevcRanges ?? (caps.hdr ? 'SDR|HDR10|HLG' : 'SDR');
  const direct = caps.direct ?? [{ containers: caps.containers, video: caps.videoCodecs, audio: caps.audioCodecs }];
  const hevcLevel = caps.hevcLevel === undefined ? [] : [{ Condition: 'LessThanEqual' as never, Property: 'VideoLevel' as never, Value: String(caps.hevcLevel), IsRequired: false }];
  const hevcProfile = (container: string | undefined, rangeTypes: string) => ({
    Type: 'Video' as never,
    Codec: 'hevc',
    Container: container,
    Conditions: size.concat(hevcLevel).concat([
      { Condition: 'EqualsAny' as never, Property: 'VideoRangeType' as never, Value: rangeTypes, IsRequired: false },
    ]),
  });
  const dv = caps.dolbyVision;
  const everyContainer = direct.reduce<string[]>((acc, r) => acc.concat(r.containers), []);
  const hevcProfiles =
    dv === undefined
      ? [hevcProfile(undefined, ranges)]
      : [hevcProfile(dv.containers.join(','), dv.ranges), hevcProfile(everyContainer.filter((c) => dv.containers.indexOf(c) < 0).join(','), ranges)];
  return {
    Name: 'Tally TV (' + caps.platform + ')',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      ...(caps.direct === undefined
        ? [{ Container: caps.containers.join(','), Type: 'Video' as const, VideoCodec: video, AudioCodec: audio }]
        : direct.map((r) => ({ Container: r.containers.join(','), Type: 'Video' as const, VideoCodec: r.video.join(','), AudioCodec: r.audio.join(',') }))),
      { Container: 'mp3,aac,m4a,flac,ogg,opus,wav,webma', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: hlsVideo,
        AudioCodec: hlsAudio,
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: String(caps.maxAudioChannels),
        MinSegments: 1,
        BreakOnNonKeyFrames: false,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming', MaxAudioChannels: '2' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: 'Video',
        Codec: 'h264',
        Conditions: size.concat([
          { Condition: 'LessThanEqual' as never, Property: 'VideoLevel' as never, Value: String(caps.h264Level ?? 52), IsRequired: false },
          { Condition: 'LessThanEqual' as never, Property: 'VideoBitDepth' as never, Value: '8', IsRequired: false },
        ]),
      },
      ...hevcProfiles,
      { Type: 'Video', Codec: 'vp9', Conditions: size },
      { Type: 'Video', Codec: 'av1', Conditions: size },
      {
        Type: 'VideoAudio',
        Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(caps.maxAudioChannels), IsRequired: false }],
      },
      ...(caps.flacMaxChannels === undefined
        ? []
        : [
            {
              Type: 'VideoAudio' as const,
              Codec: 'flac',
              Conditions: [{ Condition: 'LessThanEqual' as const, Property: 'AudioChannels' as const, Value: String(caps.flacMaxChannels), IsRequired: false }],
            },
          ]),
    ],
    // Text subtitles come to the app as files the app draws itself (same look on every engine); pictures (PGS,
    // DVD, DVB) are burned into the video by the server.
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
  };
}
