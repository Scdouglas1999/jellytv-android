import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createScreenSaverGuard,
  luna,
  readDeviceInfo,
  readDisplay,
  webosVersion,
  webosVersionFromUserAgent,
  type WebosDisplay,
} from '../src/platform/webos';
import { handOff, plausibleToken, resetHandoff, type DevModeHandoff } from '../src/platform/lgDevMode';
import type { Session } from '../src/api/jellyfin';

/**
 * The webOS platform parts against a fake PalmServiceBridge that answers as LG documents the services (the real
 * thing needs a TV, the emulator or LG's simulator).
 */
interface Call {
  uri: string;
  params: Record<string, unknown>;
  reply: (message: Record<string, unknown>) => void;
  cancelled: boolean;
}
let calls: Call[];
let answer: (uri: string, params: Record<string, unknown>) => Record<string, unknown> | null;

class FakeBridge {
  onservicecallback: ((m: string) => void) | null = null;
  private call_: Call | null = null;
  call(uri: string, params: string): void {
    const c: Call = { uri, params: JSON.parse(params) as Record<string, unknown>, reply: (m) => this.onservicecallback?.(JSON.stringify(m)), cancelled: false };
    this.call_ = c;
    calls.push(c);
    const a = answer(uri, c.params);
    if (a !== null) c.reply(a);
  }
  cancel(): void {
    if (this.call_ !== null) this.call_.cancelled = true;
  }
}

beforeEach(() => {
  calls = [];
  answer = () => ({ returnValue: true });
  (globalThis as Record<string, unknown>).window = { PalmServiceBridge: FakeBridge };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('webOS version', () => {
  const ua = (chrome: string) => `Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 WebAppManager`;
  it('names webOS by its web engine (LG: 68 = 5, 79 = 6, 87 = 22, 94 = 23, 108 = 24, 120 = 25)', () => {
    expect(webosVersionFromUserAgent(ua('68.0.3440.106'))).toBe(5);
    expect(webosVersionFromUserAgent(ua('79.0.3945.79'))).toBe(6);
    expect(webosVersionFromUserAgent(ua('87.0.4280.88'))).toBe(22);
    expect(webosVersionFromUserAgent(ua('94.0.4606.128'))).toBe(23);
    expect(webosVersionFromUserAgent(ua('108.0.5359.211'))).toBe(24);
    expect(webosVersionFromUserAgent(ua('120.0.6099.270'))).toBe(25);
    expect(webosVersionFromUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36')).toBe(0);
  });

  it('prefers the TV’s platform version, which counts 7 for webOS 22', () => {
    expect(webosVersion({ modelName: 'OLED55C2', platformVersionMajor: 7 }, ua('87.0'))).toBe(22);
    expect(webosVersion({ modelName: 'OLED55C4', platformVersionMajor: 10 }, ua('94.0'))).toBe(25);
    expect(webosVersion({ modelName: 'OLED55CX', platformVersionMajor: 5 }, '')).toBe(5);
    expect(webosVersion({ modelName: '', platformVersionMajor: 0 }, ua('79.0'))).toBe(6);
  });

  it('reads webOSSystem.deviceInfo', () => {
    const info = readDeviceInfo({ deviceInfo: JSON.stringify({ modelName: 'OLED55CX9LA', platformVersion: '5.2.0', platformVersionMajor: 5 }) });
    expect(info).toEqual({ modelName: 'OLED55CX9LA', platformVersionMajor: 5 });
    expect(readDeviceInfo({ deviceInfo: 'not json' })).toEqual({ modelName: '', platformVersionMajor: 0 });
    expect(readDeviceInfo(undefined)).toEqual({ modelName: '', platformVersionMajor: 0 });
  });
});

describe('Luna calls through PalmServiceBridge', () => {
  it('sends the parameters as JSON, answers once and cancels a one-shot call', () => {
    const replies: unknown[] = [];
    luna('luna://com.webos.service.tv.systemproperty/getSystemInfo', { keys: ['UHD'] }, (r) => replies.push(r));
    expect(calls[0]?.uri).toBe('luna://com.webos.service.tv.systemproperty/getSystemInfo');
    expect(calls[0]?.params).toEqual({ keys: ['UHD'] });
    expect(replies).toEqual([{ returnValue: true }]);
    expect(calls[0]?.cancelled).toBe(true);
  });

  it('keeps a subscription open and routes failures to onError', () => {
    answer = () => null;
    const replies: unknown[] = [];
    const errors: unknown[] = [];
    luna('com.webos.service.x/y', { subscribe: true }, (r) => replies.push(r), (e) => errors.push(e));
    expect(calls[0]?.uri).toBe('luna://com.webos.service.x/y');
    calls[0]?.reply({ returnValue: true, n: 1 });
    calls[0]?.reply({ returnValue: true, n: 2 });
    calls[0]?.reply({ returnValue: false, errorText: 'nope' });
    expect(replies).toHaveLength(2);
    expect(errors).toEqual([{ returnValue: false, errorText: 'nope' }]);
    expect(calls[0]?.cancelled).toBe(false);
  });

  it('fails at once without a bridge (a desktop browser)', () => {
    (globalThis as Record<string, unknown>).window = {};
    const errors: unknown[] = [];
    luna('luna://a/b', {}, () => undefined, (e) => errors.push(e));
    expect(errors).toHaveLength(1);
  });
});

describe('the panel (webOSTV.js deviceInfo’s sources)', () => {
  it('reads UHD, HDR10 and Dolby Vision from the TV’s configs', () => {
    answer = (uri) =>
      uri.indexOf('getConfigs') > 0
        ? { returnValue: true, configs: { 'tv.hw.panelResolution': 'UD', 'tv.model.supportHDR': true, 'tv.config.supportDolbyHDRContents': true } }
        : null;
    let got: WebosDisplay | null = null;
    readDisplay((d) => (got = d));
    expect(calls[0]?.params).toEqual({ configNames: ['tv.hw.panelResolution', 'tv.model.supportHDR', 'tv.config.supportDolbyHDRContents'] });
    expect(got).toEqual({ uhd: true, hdr10: true, dolbyVision: true });
  });

  it('falls back to getSystemInfo’s UHD, then to a Full HD set', () => {
    answer = (uri) => (uri.indexOf('getConfigs') > 0 ? { returnValue: false, errorText: 'no configs' } : { returnValue: true, UHD: 'true' });
    let got: WebosDisplay | null = null;
    readDisplay((d) => (got = d));
    expect(got).toEqual({ uhd: true, hdr10: null, dolbyVision: false });
    answer = () => ({ returnValue: false });
    readDisplay((d) => (got = d));
    expect(got).toEqual({ uhd: false, hdr10: null, dolbyVision: false });
  });
});

describe('screensaver while playing (tvpower registerScreenSaverRequest)', () => {
  it('registers once and answers the TV’s request with ack false while awake, true otherwise', () => {
    answer = () => null;
    const keepAwake = createScreenSaverGuard('io.github.scdouglas1999.tally');
    keepAwake(false);
    expect(calls).toHaveLength(0); // nothing to hold off yet
    keepAwake(true);
    keepAwake(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.uri).toBe('luna://com.webos.service.tvpower/power/registerScreenSaverRequest');
    expect(calls[0]?.params).toEqual({ subscribe: true, clientName: 'io.github.scdouglas1999.tally' });
    calls[0]?.reply({ returnValue: true, subscribed: true });
    expect(calls).toHaveLength(1); // not a request yet
    calls[0]?.reply({ returnValue: true, timestamp: '1388518297', state: 'Active' });
    expect(calls[1]?.uri).toBe('luna://com.webos.service.tvpower/power/responseScreenSaverRequest');
    expect(calls[1]?.params).toEqual({ clientName: 'io.github.scdouglas1999.tally', ack: false, timestamp: '1388518297' });
    keepAwake(false);
    calls[0]?.reply({ returnValue: true, timestamp: '1388518999', state: 'Active' });
    expect(calls[2]?.params).toEqual({ clientName: 'io.github.scdouglas1999.tally', ack: true, timestamp: '1388518999' });
  });
});

describe('LG Developer Mode hand-off', () => {
  const s: Session = { serverUrl: 'http://s', serverId: 'x', serverName: 'S', serverVersion: '10.10.6', userId: 'u1', userName: 'a', token: 't1' };
  it('accepts tokens as the TV stores them and nothing else', () => {
    expect(plausibleToken('0a1B2c3D4e5F6a7b8c9d')).toBe(true);
    expect(plausibleToken('')).toBe(false);
    expect(plausibleToken(null)).toBe(false);
    expect(plausibleToken('has space in it')).toBe(false);
    expect(plausibleToken('<script>alert(1)</script>')).toBe(false);
  });

  it('sends once per signed-in session, again after a failure or another sign-in, never signed out', async () => {
    resetHandoff();
    const sent: DevModeHandoff[] = [];
    const ok = async (b: DevModeHandoff): Promise<void> => {
      sent.push(b);
    };
    expect(await handOff(null, 'abcdef1234', 'OLED55CX', ok)).toBe(false);
    expect(await handOff(s, 'abcdef1234', 'OLED55CX', ok)).toBe(true);
    expect(await handOff(s, 'abcdef1234', 'OLED55CX', ok)).toBe(false);
    expect(sent).toEqual([{ token: 'abcdef1234', model: 'OLED55CX' }]);
    expect(await handOff({ ...s, token: 't2' }, 'abcdef1234', 'OLED55CX', ok)).toBe(true);
    resetHandoff();
    const failing = async (): Promise<void> => {
      throw new Error('404');
    };
    expect(await handOff(s, 'abcdef1234', 'OLED55CX', failing)).toBe(false);
    expect(await handOff(s, 'abcdef1234', 'OLED55CX', ok)).toBe(true);
  });
});
