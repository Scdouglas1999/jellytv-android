import type { ShellPlatform, TallyShell } from '../shell-contract/shell';
import { TIZEN_KEY_NAMES, type Key } from './keys';
import './tizen-types';
import { createScreenSaverGuard, readDeviceInfo, readDisplay, webosVersion, type WebosDisplay } from './webos';

/** What the screen shows, for the device profile (direct play of 4K, HDR10/HLG, Dolby Vision). */
export type Display = WebosDisplay;

/**
 * What differs between Samsung, LG and a browser, behind one small interface. Screens never test the platform
 * themselves; they ask this.
 */
export interface Platform {
  readonly name: ShellPlatform;
  /** Key codes the TV reported at startup (Tizen registered keys); merged into mapKey. */
  readonly runtimeKeys: Readonly<Record<number, Key>>;
  /** Human device name for Jellyfin's session list ("Samsung QN65Q80T"). */
  deviceName(): string;
  /** Keeps the TV from starting its screensaver (playback) or lets it (everything else). */
  keepAwake(awake: boolean): void;
  /** Leaves the app. */
  exit(): void;
  /** The TV model (Samsung's model code, e.g. "QN55Q80AAFXZA"), '' where unknown. */
  model(): string;
  /** Tizen's version as a number (6.5), 0 elsewhere. */
  tizenVersion(): number;
  /** The TV's OS version as its maker names it: Tizen 6.5, webOS 5, 6, 22 … 25; 0 in a browser. */
  osVersion(): number;
  /** The panel: UHD, HDR10, Dolby Vision (Samsung: productinfo; LG: the TV's configs, read at start). */
  display(): Display;
}

function tizenPlatform(shell: TallyShell): Platform {
  const runtimeKeys: Record<number, Key> = {};
  const tizen = window.tizen;
  if (tizen !== undefined) {
    for (const name of Object.keys(TIZEN_KEY_NAMES)) {
      try {
        tizen.tvinputdevice.registerKey(name);
        const key = tizen.tvinputdevice.getKey(name);
        const meaning = TIZEN_KEY_NAMES[name];
        if (key !== null && meaning !== undefined) runtimeKeys[key.code] = meaning;
      } catch {
        // a key this model does not have (no color keys on the Smart Remote): skip it
      }
    }
  }
  return {
    name: 'tizen',
    runtimeKeys,
    deviceName() {
      try {
        const model = window.webapis?.productinfo?.getRealModel();
        if (model !== undefined && model !== '') return 'Samsung ' + model;
      } catch {
        // productinfo needs its privilege; the name is cosmetic
      }
      return 'Samsung TV';
    },
    keepAwake(awake) {
      const common = window.webapis?.appcommon;
      if (common === undefined) return;
      const states = common.AppCommonScreenSaverState;
      try {
        common.setScreenSaver(awake ? states.SCREEN_SAVER_OFF : states.SCREEN_SAVER_ON);
      } catch {
        // not fatal: the TV may dim during a long film
      }
    },
    exit() {
      shell.exit();
    },
    model() {
      try {
        return window.webapis?.productinfo?.getRealModel() ?? '';
      } catch {
        return '';
      }
    },
    tizenVersion,
    osVersion: tizenVersion,
    display() {
      let uhd: boolean;
      try {
        uhd = window.webapis?.productinfo?.isUdPanelSupported?.() === true;
      } catch {
        uhd = false;
      }
      return { uhd, hdr10: null, dolbyVision: false };
    },
  };
}

function tizenVersion(): number {
  try {
    const v = window.tizen?.systeminfo?.getCapability('http://tizen.org/feature/platform.version');
    return typeof v === 'string' ? parseFloat(v) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * LG webOS (platform/webos.ts): the model and version from webOSSystem.deviceInfo and the web engine, the panel
 * from the TV's configs (read once at start: the answer arrives long before anything plays), the screensaver held off
 * through the TV's power service while something plays.
 */
function webosPlatform(shell: TallyShell): Platform {
  const info = readDeviceInfo();
  const version = webosVersion(info, navigator.userAgent);
  let display: Display = { uhd: false, hdr10: null, dolbyVision: false };
  readDisplay((d) => (display = d));
  const screenSaver = createScreenSaverGuard('io.github.scdouglas1999.tally');
  return {
    name: 'webos',
    runtimeKeys: {},
    deviceName() {
      return info.modelName !== '' ? 'LG ' + info.modelName : 'LG TV';
    },
    keepAwake(awake) {
      screenSaver(awake);
    },
    exit() {
      shell.exit();
    },
    model: () => info.modelName,
    tizenVersion: () => 0,
    osVersion: () => version,
    display: () => display,
  };
}

function browserPlatform(shell: TallyShell): Platform {
  return {
    name: 'browser',
    runtimeKeys: {},
    deviceName() {
      const ua = navigator.userAgent;
      if (ua.indexOf('Firefox') >= 0) return 'Firefox';
      if (ua.indexOf('Edg/') >= 0) return 'Edge';
      if (ua.indexOf('Chrome') >= 0) return 'Chrome';
      return 'Browser';
    },
    keepAwake() {
      // the Screen Wake Lock API is Chrome 84+: later
    },
    exit() {
      shell.exit();
    },
    model: () => '',
    tizenVersion: () => 0,
    osVersion: () => 0,
    display: () => ({ uhd: false, hdr10: null, dolbyVision: false }),
  };
}

export function createPlatform(shell: TallyShell): Platform {
  switch (shell.platform) {
    case 'tizen':
      return tizenPlatform(shell);
    case 'webos':
      return webosPlatform(shell);
    default:
      return browserPlatform(shell);
  }
}
