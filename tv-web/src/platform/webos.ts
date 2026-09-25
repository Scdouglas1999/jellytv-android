/**
 * The parts of LG webOS TV this app uses, called directly (LG's webOSTV.js library is not loaded; what it does is
 * small and documented):
 *  - `webOSSystem` (webOS 5+; `PalmSystem` before): `deviceInfo` (a JSON string: modelName, platformVersion,
 *    platformVersionMajor…), `launchParams`, `activate()`, `platformBack()`
 *    (webostv.developer.lge.com/develop/guides/app-lifecycle-management; the fields as webOS OSE's Chromium builds
 *    them, webosose/chromium108 platform_system_delegate_webos.cc);
 *  - Luna services through `PalmServiceBridge` (as webOSTV.js 1.2.11's `webOS.service.request` and Enact's
 *    LS2Request, both Apache-2.0: `new PalmServiceBridge()`, `onservicecallback`, `call(uri, json)`, `cancel()`);
 *  - the web engine's Chromium version, which names the webOS version (LG's web-api-and-web-engine page:
 *    68 = webOS 5, 79 = 6, 87 = 22, 94 = 23, 108 = 24, 120 = 25, 132 = 26; jellyfin-web browser.js maps the same).
 */

export interface WebosSystem {
  deviceInfo?: string;
  launchParams?: string;
  identifier?: string;
  activate?(): void;
  platformBack?(): void;
}

interface ServiceBridge {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, params: string): void;
  cancel(): void;
}

type BridgeConstructor = new () => ServiceBridge;

interface WebosWindow {
  webOSSystem?: WebosSystem;
  PalmSystem?: WebosSystem;
  PalmServiceBridge?: BridgeConstructor;
  WebOSServiceBridge?: BridgeConstructor;
}

const w = (): WebosWindow => window as unknown as WebosWindow;

export function webosSystem(): WebosSystem | undefined {
  return w().webOSSystem ?? w().PalmSystem;
}

export interface WebosDeviceInfo {
  modelName: string;
  /** The TV's own version numbering (5.x, 6.x, then 7.x for webOS 22 … 10.x for webOS 25). */
  platformVersionMajor: number;
}

export function readDeviceInfo(system: WebosSystem | undefined = webosSystem()): WebosDeviceInfo {
  try {
    const info = JSON.parse(system?.deviceInfo ?? '{}') as Record<string, unknown>;
    const major = Number(info.platformVersionMajor ?? String(info.platformVersion ?? '').split('.')[0]);
    return { modelName: typeof info.modelName === 'string' ? info.modelName : '', platformVersionMajor: isFinite(major) ? major : 0 };
  } catch {
    return { modelName: '', platformVersionMajor: 0 };
  }
}

/** webOS by its web engine: the Chromium major version in the user agent. 0 when it is not webOS's. */
export function webosVersionFromUserAgent(ua: string): number {
  const m = /Chrome\/(\d+)/.exec(ua);
  if (m === null || !/Web0S|webOS|NetCast/i.test(ua)) return 0;
  const chrome = Number(m[1]);
  if (chrome >= 132) return 26;
  if (chrome >= 120) return 25;
  if (chrome >= 108) return 24;
  if (chrome >= 94) return 23;
  if (chrome >= 87) return 22;
  if (chrome >= 79) return 6;
  if (chrome >= 68) return 5;
  if (chrome >= 53) return 4;
  return 3;
}

/**
 * The webOS version as LG names it (5, 6, 22, 23, 24, 25): from the TV's platform version (internal 7 = webOS 22,
 * so + 15 from 7 on; forum.webostv.developer.lge.com/t/740: a 2022 set reports 7.2.0), else from the web engine.
 */
export function webosVersion(info: WebosDeviceInfo, ua: string): number {
  const major = info.platformVersionMajor;
  if (major >= 7) return major + 15;
  if (major >= 3) return major;
  return webosVersionFromUserAgent(ua);
}

export interface LunaHandle {
  cancel(): void;
}

/** Requests in flight are kept referenced (a collected bridge never calls back; Enact's LS2Request does the same). */
const inFlight = new Set<ServiceBridge>();

/**
 * One Luna call. `onReply` gets every reply (once without `subscribe`); failures (errorCode, returnValue false)
 * go to `onError`. Without a bridge (a desktop browser), `onError` is called at once.
 */
export function luna(
  uri: string,
  params: Record<string, unknown>,
  onReply: (reply: Record<string, unknown>) => void,
  onError: (error: Record<string, unknown>) => void = () => undefined,
): LunaHandle {
  const Bridge = w().WebOSServiceBridge ?? w().PalmServiceBridge;
  if (Bridge === undefined) {
    onError({ errorCode: -1, errorText: 'PalmServiceBridge is not found.', returnValue: false });
    return { cancel: () => undefined };
  }
  const subscribe = params.subscribe === true;
  const bridge = new Bridge();
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    inFlight.delete(bridge);
    try {
      bridge.cancel();
    } catch {
      // already closed
    }
  };
  bridge.onservicecallback = (message: string) => {
    if (cancelled) return;
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(message) as Record<string, unknown>;
    } catch {
      reply = { errorCode: -1, errorText: 'unreadable reply', returnValue: false };
    }
    if (reply.errorCode !== undefined || reply.returnValue === false) onError(reply);
    else onReply(reply);
    if (!subscribe) cancel();
  };
  inFlight.add(bridge);
  const service = uri.indexOf('luna://') === 0 ? uri : 'luna://' + uri;
  bridge.call(service, JSON.stringify(params));
  return { cancel };
}

export interface WebosDisplay {
  uhd: boolean;
  /** null: the TV did not say (then UHD sets are taken as HDR10/HLG, as on Samsung). */
  hdr10: boolean | null;
  dolbyVision: boolean;
}

/**
 * What the panel shows, as webOSTV.js 1.2.11 `webOS.deviceInfo` reads it: `com.webos.service.config/getConfigs`
 * (tv.hw.panelResolution UD/8K, tv.model.supportHDR, tv.config.supportDolbyHDRContents), else
 * `com.webos.service.tv.systemproperty/getSystemInfo` (UHD "true").
 */
export function readDisplay(done: (display: WebosDisplay) => void): void {
  const yes = (v: unknown): boolean => v === true || v === 'true' || v === 'TRUE';
  luna(
    'luna://com.webos.service.config/getConfigs',
    { configNames: ['tv.hw.panelResolution', 'tv.model.supportHDR', 'tv.config.supportDolbyHDRContents'] },
    (reply) => {
      const configs = (reply.configs ?? {}) as Record<string, unknown>;
      const panel = String(configs['tv.hw.panelResolution'] ?? '');
      if (panel === '') {
        systemInfoDisplay(done, yes);
        return;
      }
      done({
        uhd: panel === 'UD' || panel === '8K',
        hdr10: 'tv.model.supportHDR' in configs ? yes(configs['tv.model.supportHDR']) : null,
        dolbyVision: yes(configs['tv.config.supportDolbyHDRContents']),
      });
    },
    () => systemInfoDisplay(done, yes),
  );
}

function systemInfoDisplay(done: (display: WebosDisplay) => void, yes: (v: unknown) => boolean): void {
  luna(
    'luna://com.webos.service.tv.systemproperty/getSystemInfo',
    { keys: ['UHD', 'modelName', 'sdkVersion'] },
    (reply) => done({ uhd: yes(reply.UHD), hdr10: null, dolbyVision: false }),
    () => done({ uhd: false, hdr10: null, dolbyVision: false }),
  );
}

/**
 * Keeps the TV's screensaver away while `awake`. LG shows no screensaver while a video plays full screen
 * (webostv.developer.lge.com/develop/guides/screensaver), but multiview tiles, the live player's paused picture and
 * the board are not that; webOS 6+ has no setting for apps. The TV asks every client registered with
 * `com.webos.service.tvpower/power/registerScreenSaverRequest` before it starts the screensaver (state "Active");
 * answering `responseScreenSaverRequest` with ack false keeps it off (undocumented: mariotaku in
 * webosbrew/apps-repo#60; Kodi's OSScreenSaverWebOS.cpp and Moonfin's video.js do the same). Registered once, then
 * answered by the current `awake`.
 */
export function createScreenSaverGuard(clientName: string): (awake: boolean) => void {
  let awake = false;
  let registered = false;
  return (next: boolean) => {
    awake = next;
    if (registered || !next) return;
    registered = true;
    luna(
      'luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
      { subscribe: true, clientName },
      (reply) => {
        if (reply.state !== 'Active') return;
        luna(
          'luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
          { clientName, ack: !awake, timestamp: reply.timestamp },
          () => undefined,
        );
      },
      () => {
        // an older firmware without the service: the full-screen video rule still applies
        registered = false;
      },
    );
  };
}
