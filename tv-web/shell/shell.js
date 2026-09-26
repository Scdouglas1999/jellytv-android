/*
 * Tally TV shell: the small app installed on the TV once. It finds the Jellyfin server, loads the Tally TV bundle
 * that the server's Tally plugin serves (/JellyTV/TV/manifest.json → app.<hash>.js + app.<hash>.css) into this page,
 * and hands over. Every plugin update therefore updates every TV, with no reinstall. The bundle runs inside this
 * local page, so it keeps the platform's APIs (Tizen `tizen` / `webapis` for AVPlay and remote keys).
 *
 * The contract with the bundle is `window.TallyShell` (tv-web/src/shell-contract/shell.ts). Plain ES5 on purpose:
 * this file is never transpiled and must run on the oldest TV the shell is installed on.
 */
(function () {
  'use strict';

  var SHELL_VERSION = 1;
  var SERVER_KEY = 'tally.shell.server';
  var BUNDLE_KEY = 'tally.shell.bundle';
  var ASK_KEY = 'tally.shell.ask';
  var STAMP_KEY = 'tally.shell.stamp';
  var TIMEOUT_MS = 10000;
  var config = window.TALLY_SHELL_CONFIG || {};
  var platform = config.platform || 'browser';

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, TIZEN_BACK: 10009, WEBOS_BACK: 461, ESCAPE: 27, IME_DONE: 65376, IME_CANCEL: 65385 };

  function $(id) { return document.getElementById(id); }

  function store(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    } catch (e) { /* storage off: remembered for this launch only */ }
  }

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function query(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** "192.168.1.50" → "http://192.168.1.50:8096"; a full URL is kept as typed (minus trailing slashes). */
  function normalize(address) {
    var a = (address || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    if (a === '') return '';
    if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
    var m = /^(https?:\/\/)([^\/:]+)(:\d+)?(\/.*)?$/i.exec(a);
    if (m && !m[3] && !m[4] && m[1].toLowerCase() === 'http://') a = m[1] + m[2] + ':8096';
    return a;
  }

  function get(url, done) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      xhr.abort();
      done(0, null);
    }, TIMEOUT_MS);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || finished) return;
      finished = true;
      clearTimeout(timer);
      done(xhr.status, xhr.responseText);
    };
    try {
      xhr.open('GET', url, true);
      xhr.send();
    } catch (e) {
      finished = true;
      clearTimeout(timer);
      done(0, null);
    }
  }

  function exitApp() {
    try {
      if (platform === 'tizen' && window.tizen) { window.tizen.application.getCurrentApplication().exit(); return; }
      if (platform === 'webos') {
        // LG's exit: webOS 6+ asks "exit the app?", webOS 5 goes to Home (developer guide, back-button)
        var system = window.webOSSystem || window.PalmSystem;
        if (system && system.platformBack) { system.platformBack(); return; }
        window.close();
        return;
      }
    } catch (e) { /* fall through */ }
  }

  /* ---- the shell's own screens: a tiny focus list, arrows move it, OK presses ---- */

  var focusables = [];
  var focusIndex = 0;
  var keyHandler = null;

  function setFocus(i) {
    if (focusables.length === 0) return;
    focusIndex = Math.max(0, Math.min(focusables.length - 1, i));
    for (var j = 0; j < focusables.length; j++) {
      focusables[j].el.className = focusables[j].el.className.replace(/\s*focused/g, '') + (j === focusIndex ? ' focused' : '');
    }
  }

  function screen(step, html, items) {
    $('shell').className = '';
    $('shell-step').textContent = step;
    $('shell-body').innerHTML = html;
    focusables = items();
    setFocus(0);
  }

  function onShellKey(e) {
    if (keyHandler === null) return;
    var code = e.keyCode;
    var input = e.target && e.target.tagName === 'INPUT' ? e.target : null;
    if (code === KEY.TIZEN_BACK || code === KEY.WEBOS_BACK || (code === KEY.ESCAPE && !input)) {
      e.preventDefault();
      if (input) { input.blur(); return; }
      exitApp();
      return;
    }
    if (input && code !== KEY.ENTER && code !== KEY.IME_DONE && code !== KEY.UP && code !== KEY.DOWN && code !== KEY.IME_CANCEL) return;
    if (code === KEY.IME_CANCEL) { if (input) input.blur(); return; }
    var item = focusables[focusIndex];
    if (code === KEY.UP || code === KEY.LEFT) { if (input) input.blur(); setFocus(focusIndex - 1); e.preventDefault(); }
    else if (code === KEY.DOWN || code === KEY.RIGHT) { if (input) input.blur(); setFocus(focusIndex + 1); e.preventDefault(); }
    else if ((code === KEY.ENTER || code === KEY.IME_DONE) && item) { e.preventDefault(); item.press(input !== null); }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function askAddress(error, tried) {
    keyHandler = onShellKey;
    var current = tried || read(SERVER_KEY) || config.server || '';
    screen('ADD SERVER',
      '<div class="shell-form">' +
      '<div class="shell-text">Type your server\'s IP address or URL.</div>' +
      '<div class="shell-field" id="f-address"><input id="address" type="url" placeholder="SERVER IP OR URL" value="' + escapeHtml(current) + '"></div>' +
      (error ? '<div class="shell-error">' + escapeHtml(error) + '</div>' : '') +
      '<div class="shell-buttons"><div class="shell-button primary" id="b-connect">CONNECT</div></div>' +
      '</div>',
      function () {
        var input = $('address');
        var connect = function () { start(normalize(input.value)); };
        return [
          { el: $('f-address'), press: function (typing) { if (typing) connect(); else input.focus(); } },
          { el: $('b-connect'), press: connect }
        ];
      });
  }

  function problem(message, server) {
    keyHandler = onShellKey;
    screen('CAN\'T CONNECT',
      '<div class="shell-form">' +
      '<div class="shell-error">' + escapeHtml(message) + '</div>' +
      '<div class="shell-muted">' + escapeHtml(server) + '</div>' +
      '<div class="shell-buttons"><div class="shell-button primary" id="b-retry">TRY AGAIN</div><div class="shell-button" id="b-change">CHANGE SERVER</div></div>' +
      '</div>',
      function () {
        return [
          { el: $('b-retry'), press: function () { start(server); } },
          { el: $('b-change'), press: function () { askAddress(null, server); } }
        ];
      });
  }

  function loading(server) {
    keyHandler = onShellKey;
    screen('CONNECTING', '<div class="shell-form"><div class="shell-muted">' + escapeHtml(server) + '</div></div>', function () { return []; });
  }

  /* ---- loading the bundle ---- */

  function inject(base, manifest, server) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = base + manifest.css;
    document.head.appendChild(css);
    window.TallyShell = {
      shellVersion: SHELL_VERSION,
      platform: platform,
      serverUrl: server,
      bundleBase: base,
      changeServer: function (url) {
        store(SERVER_KEY, url);
        // null: ask for an address on the next start, even when the installer stamped one in
        if (url === null) store(ASK_KEY, '1');
        window.location.reload();
      },
      reload: function () { window.location.reload(); },
      exit: exitApp,
      // LG: the TV's Developer Mode session, stamped in by Tally for LG (the Tally plugin keeps it renewed)
      devModeToken: config.devModeToken || null,
      started: function () {
        keyHandler = null;
        $('shell').className = 'gone';
      }
    };
    var script = document.createElement('script');
    script.src = base + manifest.js;
    script.onerror = function () { problem('The TV app could not be loaded from the server.', server); };
    document.body.appendChild(script);
  }

  function start(server) {
    if (!server) { askAddress(null); return; }
    loading(server);
    get(server + '/System/Info/Public', function (status, body) {
      if (status !== 200) {
        problem(status === 0 ? 'The server did not answer. Check that it is on and that this TV is on the same network.' : 'The server answered with an error (HTTP ' + status + ').', server);
        return;
      }
      try { JSON.parse(body); } catch (e) { problem('That address is not a Jellyfin server.', server); return; }
      store(SERVER_KEY, server);
      var base = read(BUNDLE_KEY) || config.bundle || (server + '/JellyTV/TV/');
      get(base + 'manifest.json?t=' + Date.now(), function (mStatus, mBody) {
        if (mStatus === 404) { problem('This server has no Tally TV app. Install or update the Tally plugin on the server.', server); return; }
        if (mStatus !== 200) { problem('The server could not send the TV app (HTTP ' + mStatus + ').', server); return; }
        var manifest;
        try { manifest = JSON.parse(mBody); } catch (e) { problem('The server sent a broken TV app manifest.', server); return; }
        if ((manifest.minShell || 1) > SHELL_VERSION) {
          problem('This server\'s Tally needs a newer Tally app on this TV. Reinstall Tally on the TV.', server);
          return;
        }
        inject(base, manifest, server);
      });
    });
  }

  function fit() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('shell').style.transform = scale === 1 ? '' : 'scale(' + scale + ')';
  }

  window.addEventListener('keydown', function (e) { if (keyHandler) keyHandler(e); });
  // webOS: launching Tally while it runs in the background relaunches it; bring the running app to the front
  document.addEventListener('webOSRelaunch', function () {
    var system = window.webOSSystem || window.PalmSystem;
    try { if (system && system.activate) system.activate(); } catch (e) { /* nothing to do */ }
  });
  window.addEventListener('resize', fit);
  fit();
  // development: ?bundle=<url of a bundle folder> loads the bundle from elsewhere (a dev machine) and is remembered
  // until ?bundle= (empty) clears it
  var bundleOverride = query('bundle');
  if (bundleOverride !== null) store(BUNDLE_KEY, bundleOverride === '' ? null : bundleOverride);
  var fromQuery = query('server');
  // an address the installer stamped in this time (a reinstall for a server that moved) wins over the remembered one
  var stamped = config.server || '';
  if (stamped !== '' && stamped !== (read(STAMP_KEY) || '')) {
    store(STAMP_KEY, stamped);
    store(SERVER_KEY, null);
  }
  if (!fromQuery && read(ASK_KEY) === '1') {
    store(ASK_KEY, null);
    askAddress(null);
  } else {
    start(normalize(fromQuery || read(SERVER_KEY) || stamped));
  }
})();
