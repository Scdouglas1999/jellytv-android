/**
 * The contract between the installed shell (shell/: config.xml or appinfo.json + index.html + shell.js, installed
 * once on the TV) and this bundle (served by the Tally plugin at /JellyTV/TV/, updated with the plugin).
 *
 * The shell sets `window.TallyShell` before it loads the bundle. The bundle must keep working with every shell
 * version it claims in `MIN_SHELL_VERSION` (vite.config.ts writes it into manifest.json, and a shell older than that
 * shows "reinstall" instead of loading the bundle). Only ADD to this interface; never change what a member means.
 */
export type ShellPlatform = 'tizen' | 'webos' | 'browser';

export interface TallyShell {
  /** 1 = the first shell. */
  readonly shellVersion: number;
  readonly platform: ShellPlatform;
  /** The Jellyfin server the shell loaded the bundle from (no trailing slash), or null in a plain browser. */
  readonly serverUrl: string | null;
  /** Absolute URL of the folder the bundle was loaded from, ending in '/'. */
  readonly bundleBase: string;
  /** Remembers another server (null forgets it) and restarts through the shell's address step. */
  changeServer(url: string | null): void;
  /** Reloads the shell, which fetches the bundle again (after a plugin update, or to recover). */
  reload(): void;
  /** Leaves the app (Tizen: application.exit; webOS: window.close; browser: nothing). */
  exit(): void;
  /** The bundle has drawn its first screen: the shell removes its loading screen. */
  started(): void;
  /**
   * LG only: the TV's Developer Mode session token that Tally for LG stamped into config.js (null or absent
   * elsewhere, and in shells installed by LG's own tools). The bundle hands it to the Tally plugin, which renews the
   * session so LG does not remove the app when Developer Mode's 50 hours run out.
   */
  readonly devModeToken?: string | null;
}

declare global {
  interface Window {
    TallyShell?: TallyShell;
  }
}

/** Oldest shell this bundle works with. Raise it only when the bundle needs a shell feature that older shells lack. */
export const MIN_SHELL_VERSION = 1;

function detectPlatform(): ShellPlatform {
  const w = window as unknown as Record<string, unknown>;
  if (w.tizen !== undefined) return 'tizen';
  if (w.webOS !== undefined || w.webOSSystem !== undefined || w.PalmSystem !== undefined) return 'webos';
  return 'browser';
}

function scriptBase(): string {
  const current = document.currentScript as HTMLScriptElement | null;
  const src = current !== null && current.src !== '' ? current.src : document.baseURI;
  return src.substring(0, src.lastIndexOf('/') + 1);
}

/**
 * The shell, or (running without one: `npm run dev`, a desktop browser) a stand-in that keeps the server address in
 * localStorage. Must be called while the bundle's script is first evaluated (document.currentScript).
 */
export function resolveShell(): TallyShell {
  if (window.TallyShell !== undefined) return window.TallyShell;
  const key = 'tally.shell.server';
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('server');
  // served by a Jellyfin (the plugin's /JellyTV/TV/index.html): that server, unless one was chosen
  const path = window.location.pathname;
  const at = path.indexOf('/JellyTV/TV/');
  const hosting = window.location.protocol.indexOf('http') === 0 && at >= 0 ? window.location.origin + path.substring(0, at) : null;
  let stored: string | null;
  try {
    stored = fromQuery ?? window.localStorage.getItem(key) ?? hosting;
    if (fromQuery !== null) window.localStorage.setItem(key, fromQuery);
  } catch {
    stored = fromQuery ?? hosting;
  }
  const standalone: TallyShell = {
    shellVersion: 0,
    platform: detectPlatform(),
    serverUrl: stored !== null && stored !== '' ? stored.replace(/\/+$/, '') : null,
    bundleBase: scriptBase(),
    changeServer(url) {
      try {
        if (url === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, url);
      } catch {
        // storage unavailable: the address lives for this page only
      }
      window.location.search = '';
    },
    reload() {
      window.location.reload();
    },
    exit() {
      // a browser tab cannot close itself
    },
    started() {
      // no shell screen to remove
    },
  };
  window.TallyShell = standalone;
  return standalone;
}
