import { describe, expect, it } from 'vitest';
import { buildDeviceProfile, detectCapabilities, type Probe } from '../src/player/deviceProfile';

const none = (): boolean => false;
const chrome = (mime: string): boolean => /avc1|vp9|opus|mp4a|audio\/mpeg|flac|vorbis|av01/.test(mime);

describe('device profiles', () => {
  it('lets Tizen direct play MKV with AC-3 and HEVC even when the web engine probes nothing', () => {
    const caps = detectCapabilities('tizen', none, true);
    const profile = buildDeviceProfile(caps, 120_000_000);
    const direct = profile.DirectPlayProfiles?.[0];
    expect(direct?.Container).toContain('mkv');
    expect(direct?.VideoCodec).toContain('hevc');
    expect(direct?.AudioCodec).toContain('ac3');
    expect(direct?.AudioCodec).not.toContain('dts');
    expect(profile.TranscodingProfiles?.[0]).toMatchObject({ Container: 'ts', Protocol: 'hls', VideoCodec: 'hevc,h264' });
    expect(caps.maxWidth).toBe(3840);
  });

  it('on Tizen, leaves AV1 to the server although the web engine probes it (AVPlay refused AV1 on the emulator)', () => {
    // what the Tizen 10 emulator's MSE answered: AV1, HEVC, VP9, AC-3, E-AC-3, Opus yes; DTS no
    const emulator = (mime: string): boolean => /av01|hvc1|vp9|ac-3|ec-3|opus|avc1|mp4a/.test(mime);
    const caps = detectCapabilities('tizen', emulator, true);
    expect(caps.videoCodecs).not.toContain('av1');
    expect(caps.videoCodecs).toContain('vp9');
    expect(caps.audioCodecs).not.toContain('dts');
    expect(detectCapabilities('browser', emulator, false).videoCodecs).toContain('av1');
  });

  it('keeps a browser to what it probes, converts MKV, and sends 2 channels', () => {
    const caps = detectCapabilities('browser', chrome, false);
    const profile = buildDeviceProfile(caps, 8_000_000);
    expect(profile.DirectPlayProfiles?.[0]?.Container).not.toContain('mkv');
    expect(profile.DirectPlayProfiles?.[0]?.VideoCodec).toContain('vp9');
    expect(profile.TranscodingProfiles?.[0]).toMatchObject({ VideoCodec: 'h264', MaxAudioChannels: '2' });
    expect(profile.MaxStreamingBitrate).toBe(8_000_000);
  });

  it('draws text subtitles itself and burns in picture subtitles', () => {
    const profile = buildDeviceProfile(detectCapabilities('webos', none, false), 1);
    const methods = Object.fromEntries((profile.SubtitleProfiles ?? []).map((s) => [s.Format, s.Method]));
    expect(methods.srt).toBe('External');
    expect(methods.ass).toBe('External');
    expect(methods.pgssub).toBe('Encode');
  });
});

describe('webOS device profiles (LG AV format pages per version, jellyfin-web where LG is silent)', () => {
  const hints = (osVersion: number, uhd = true, dolbyVision = false) => ({ uhd, hdr10: uhd, dolbyVision, osVersion });
  const direct = (osVersion: number, probe: Probe = none, uhd = true, dv = false) =>
    buildDeviceProfile(detectCapabilities('webos', probe, hints(osVersion, uhd, dv)), 120_000_000);
  const rule = (p: ReturnType<typeof direct>, container: string) =>
    (p.DirectPlayProfiles ?? []).find((d) => d.Type === 'Video' && (d.Container ?? '').split(',').indexOf(container) >= 0);

  it('plays MKV, MP4 and TS as LG lists them, each with its own codecs', () => {
    const p = direct(5);
    expect(rule(p, 'mkv')?.VideoCodec?.split(',')).toEqual(expect.arrayContaining(['h264', 'hevc', 'vp9', 'av1', 'mpeg2video']));
    expect(rule(p, 'mkv')?.AudioCodec?.split(',')).toEqual(expect.arrayContaining(['aac', 'ac3', 'eac3', 'mp3', 'pcm_s16le', 'flac']));
    expect(rule(p, 'mp4')?.VideoCodec).toBe('h264,hevc,mpeg4,av1');
    expect(rule(p, 'mp4')?.AudioCodec).toBe('aac,mp3,ac3,eac3');
    expect(rule(p, 'ts')?.VideoCodec).toBe('h264,hevc,mpeg2video');
    expect(rule(p, 'avi')?.VideoCodec).toBe('h264,mpeg4');
    // not in LG's tables: converted
    expect(rule(p, 'webm')).toBeUndefined();
    expect(rule(p, 'wmv')).toBeUndefined();
    for (const d of p.DirectPlayProfiles ?? []) expect(d.AudioCodec ?? '').not.toMatch(/truehd|dts|vorbis/);
  });

  it('leaves DTS to the server on webOS 5, 6 and 22 whatever the engine says, and asks the engine from 23', () => {
    const saysDts = (mime: string): boolean => /dts/.test(mime);
    for (const v of [5, 6, 22]) expect(rule(direct(v, saysDts), 'mkv')?.AudioCodec).not.toContain('dts');
    expect(rule(direct(23, saysDts), 'mkv')?.AudioCodec).toContain('dts');
    expect(rule(direct(24, saysDts), 'ts')?.AudioCodec).toContain('dts');
    expect(rule(direct(23, none), 'mkv')?.AudioCodec).not.toContain('dts');
  });

  it('adds Opus in MKV from webOS 24, as LG does', () => {
    expect(rule(direct(23), 'mkv')?.AudioCodec).not.toContain('opus');
    expect(rule(direct(24), 'mkv')?.AudioCodec).toContain('opus');
    expect(rule(direct(25), 'mkv')?.AudioCodec).toContain('opus');
  });

  it('keeps VP9 and AV1 to UHD sets, and H.264/HEVC levels to the panel', () => {
    const fhd = direct(6, none, false);
    expect(rule(fhd, 'mkv')?.VideoCodec).not.toMatch(/vp9|av1/);
    expect(rule(fhd, 'mp4')?.VideoCodec).not.toContain('av1');
    const level = (p: ReturnType<typeof direct>, codec: string) =>
      (p.CodecProfiles ?? []).find((c) => c.Codec === codec)?.Conditions?.find((c) => c.Property === 'VideoLevel')?.Value;
    expect(level(fhd, 'h264')).toBe('42');
    expect(level(fhd, 'hevc')).toBe('123');
    expect(level(direct(6), 'h264')).toBe('51');
    expect(level(direct(6), 'hevc')).toBe('153');
  });

  it('plays WebM only where the engine says it plays VP9', () => {
    const vp9 = (mime: string): boolean => /webm/.test(mime);
    expect(rule(direct(22, vp9), 'webm')?.VideoCodec).toBe('vp8,vp9,av1');
  });

  it('plays HDR10/HLG and Dolby Vision base layers on HDR sets, Dolby Vision itself only where the TV has it', () => {
    const ranges = (p: ReturnType<typeof direct>) => (p.CodecProfiles ?? []).filter((c) => c.Codec === 'hevc').map((c) => [c.Container ?? '', c.Conditions?.find((x) => x.Property === 'VideoRangeType')?.Value ?? '']);
    const hdr = ranges(direct(22));
    expect(hdr).toHaveLength(1);
    expect(hdr[0]?.[1]).toContain('HDR10');
    expect(hdr[0]?.[1]).toContain('DOVIWithHDR10');
    expect(hdr[0]?.[1]?.split('|')).not.toContain('DOVI');
    const dv = ranges(direct(22, none, true, true));
    expect(dv).toHaveLength(2);
    expect(dv[0]?.[0]).toBe('mp4,m4v,mov,ts,mpegts,m2ts');
    expect(dv[0]?.[1]?.split('|')).toContain('DOVI');
    expect(dv[1]?.[0]).toContain('mkv');
    expect(dv[1]?.[1]?.split('|')).not.toContain('DOVI');
    // webOS 25: Dolby Vision in MKV too (jellyfin-web)
    expect(ranges(direct(25, none, true, true))[0]?.[0]).toContain('mkv');
    expect(ranges(direct(6, none, false))[0]?.[1]).toBe('SDR|DOVIWithSDR');
  });

  it('converts to HLS in MPEG-TS with HEVC or H.264 and surround audio, FLAC in video at 2 channels', () => {
    const p = direct(5);
    expect(p.TranscodingProfiles?.[0]).toMatchObject({ Container: 'ts', Protocol: 'hls', VideoCodec: 'hevc,h264', MaxAudioChannels: '6' });
    expect(p.TranscodingProfiles?.[0]?.AudioCodec).toBe('aac,mp3,ac3,eac3');
    const flac = (p.CodecProfiles ?? []).find((c) => c.Type === 'VideoAudio' && c.Codec === 'flac');
    expect(flac?.Conditions?.[0]).toMatchObject({ Property: 'AudioChannels', Value: '2' });
  });
});
