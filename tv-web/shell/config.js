// Written by the package scripts (scripts/package-tizen.sh, scripts/package-webos.sh) and the installers. Values here
// are defaults for opening shell/index.html in a desktop browser.
window.TALLY_SHELL_CONFIG = {
  // 'tizen' | 'webos' | 'browser'
  platform: 'browser',
  // the Jellyfin address stamped in by the installer (--server); the viewer is asked when empty
  server: '',
  // development only: load the bundle from here instead of the server's /JellyTV/TV/ (package --bundle)
  bundle: '',
  // LG only, written by Tally for LG: the TV's Developer Mode session token (the Tally plugin keeps the session on)
  // devModeToken: '',
};
