/* ============================================================
   Tally — embedded Jellyfin plugin page
   Views: Games · Channels · Guide · Multiview · Settings
   ============================================================ */
(function () {
'use strict';

/* ---------------- environment / api ---------------- */

const env = {
  token() {
    try { const t = window.ApiClient && ApiClient.accessToken && ApiClient.accessToken(); if (t) return t; } catch (e) {}
    try {
      const c = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
      return (c.Servers && c.Servers[0] && c.Servers[0].AccessToken) || '';
    } catch (e) { return ''; }
  },
  url(p) {
    if (window.ApiClient && ApiClient.getUrl) return ApiClient.getUrl(p);
    const m = location.pathname.match(/^(.*)\/web\//);
    return (m ? m[1] : '') + '/' + p;
  },
  asset(f) { return env.url('JellyTV/Assets/' + f); }
};

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ Authorization: 'MediaBrowser Token="' + env.token() + '"' }, opts.headers);
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(env.url('JellyTV/' + path), Object.assign({}, opts, { headers }));
  if (!r.ok) throw new Error('Tally ' + path + ' → HTTP ' + r.status);
  if (r.status === 204) return null;
  return r.json();
}

/* ---------------- helpers ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);

// crypto.randomUUID() needs a secure context — plugin runs on http:// LAN URLs.
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function mono(name) {
  const parts = String(name).replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2)).toUpperCase();
}
// channel mark: provider logo, else a monogram. `big` = monitor face, otherwise a 34px list mark.
function chanMark(c, big) {
  return c.logo
    ? `<img src="${esc(c.logo)}" loading="lazy" referrerpolicy="no-referrer" alt="">`
    : `<span class="${big ? 'mono' : 'mono-sm'}">${esc(mono(c.name))}</span>`;
}
function toast(msg, err) {
  const t = el(`<div class="jtv-toast${err ? ' err' : ''}"><i class="led ${err ? 'live' : 'on'}"></i><span>${esc(msg)}</span></div>`);
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 2600);
}
function prog(p, now) {
  if (!p || !p.end || !p.start) return 0;
  return clamp((now - new Date(p.start)) / (new Date(p.end) - new Date(p.start)), 0, 1);
}
function fmtSpan(ms, secs) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (secs) return h + ':' + pad(m) + ':' + pad(s % 60);
  return h ? h + ' h ' + pad(m) + ' min' : m + ' min';
}
// Started / Remaining / Next readout + segmented progress, shared by the guide
// detail panel and the player overlay.
function progReadout(p, next, now, secs) {
  if (!p) return '';
  const s = new Date(p.start), e = new Date(p.end);
  const live = s <= now && e > now, past = e <= now;
  const stats = [
    [live || past ? 'Started' : 'Starts', fmtTime(s)],
    live ? ['Remaining', fmtSpan(e - now, secs), 'hot'] : past ? ['Ended', fmtTime(e)] : ['Runs', fmtSpan(e - s)]
  ];
  if (next) stats.push(['Next at ' + fmtTime(next.start), next.title || 'Untitled', 'txt']);
  return `<div class="jtv-stats">${stats.map(([l, v, c]) =>
    `<div class="jtv-stat"><span class="l">${esc(l)}</span><span class="v${c ? ' ' + c : ''}">${esc(v)}</span></div>`).join('')}</div>`
    + (live ? `<div class="jtv-progress"><div style="width:${(prog(p, now) * 100).toFixed(1)}%"></div></div>` : '');
}
const icons = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.9-6.86a1.03 1.03 0 0 0 0-1.76L9.56 4.26A1.03 1.03 0 0 0 8 5.14z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3-5.7-3.1-5.7 3.1 1.2-6.3L2.8 9.3l6.4-.8z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M3 8V5h18v14h-7"/><path d="M3 12a7 7 0 0 1 7 7M3 16a3 3 0 0 1 3 3"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/></svg>'
};

/* ---------------- immersive / rotation ---------------- */

// Jellyfin's mobile apps (iOS, Android) keep the screen in portrait until the web client says
// video is on screen — jellyfin-web's own player does it with NativeShell.enableFullscreen().
// JellyTV has its own player, so it has to say so itself or phones never rotate.
let immersive = false;
function setImmersive(on) {
  if (on === immersive) return;
  immersive = on;
  try {
    const ns = window.NativeShell;
    if (ns) { const fn = on ? ns.enableFullscreen : ns.disableFullscreen; if (typeof fn === 'function') fn.call(ns); }
  } catch (e) {}
}
// video is on screen whenever the player is open or multiview is showing streams
const syncImmersive = () => setImmersive(!!state.player || (state.view === 'multi' && state.mv.length > 0));

// Browsers have no app shell to ask: real fullscreen, plus a landscape lock where the platform
// allows one (Android). iPhone Safari can't fullscreen an element — hand the <video> to the native player.
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
async function toggleFullscreen(box, video) {
  try {
    if (fsElement()) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      try { screen.orientation.unlock(); } catch (e) {}
      return;
    }
    const req = box.requestFullscreen || box.webkitRequestFullscreen;
    if (req) {
      await req.call(box);
      try { await screen.orientation.lock('landscape'); } catch (e) {}
    } else if (video && video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  } catch (e) {}
}

/* ---------------- hls ---------------- */

let hlsReady = null;
function ensureHls() {
  if (!hlsReady) {
    hlsReady = new Promise((res, rej) => {
      if (window.Hls) return res();
      const s = document.createElement('script');
      s.src = env.asset('hls.min.js');
      s.onload = res; s.onerror = () => rej(new Error('hls.js failed to load'));
      document.head.appendChild(s);
    });
  }
  return hlsReady;
}

async function attachStream(video, url, extra) {
  await ensureHls();
  // Handle object survives internal re-creations — callers just hold it and
  // call .destroy(); fatal-error recovery swaps the inner hls instance.
  const handle = {
    h: null,
    dead: false,
    retries: 0,
    totalRebuilds: 0,
    _wd: null,
    onerror: null,
    destroy() {
      this.dead = true;
      clearInterval(this._wd);
      try { this.h && this.h.destroy(); } catch (_) {}
    }
  };
  if (window.Hls && Hls.isSupported()) {
    let lastT = -1, lastProgressAt = Date.now();
    const start = () => {
      if (handle.dead) return;
      const h = new Hls({
        // Regular (non-LL) HLS: a deep buffer absorbs slow/redirected segments.
        // lowLatencyMode here starves the player and causes permanent stalls.
        backBufferLength: 30,
        maxBufferLength: 90,
        maxMaxBufferLength: 180,
        // Start optimistic: default bandwidth estimate (~500kbps) makes hls.js
        // open on the worst quality and climb — on fast connections that's just
        // needless low-res seconds. 10Mbps picks a top variant immediately.
        abrEwmaDefaultEstimate: 10000000,
        // A 400px multiview tile can't show 1080p — don't pull it. Big win for
        // multiview bandwidth contention.
        capLevelToPlayerSize: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 12,
        maxBufferHole: 0.6,
        nudgeMaxRetry: 10,
        // hls.js retry delays are exponential (delay * 2^n, capped by
        // MaxRetryDelay) — cap them or one dead segment burns minutes while
        // the buffer drains. The proxy is the real bottleneck anyway; a stuck
        // upstream is detected by the watchdog + rebuilt instead.
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryDelay: 8000,
        manifestLoadingTimeOut: 25000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 1000,
        levelLoadingMaxRetryDelay: 8000,
        levelLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryDelay: 8000,
        fragLoadingTimeOut: 40000,
        ...(extra || {})
      });
      h.on(Hls.Events.ERROR, (_e, d) => {
        if (handle.dead || !d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { h.startLoad(); } catch (_) {}
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { h.recoverMediaError(); } catch (_) {}
        } else {
          rebuild();
        }
      });
      // Any decoded fragment counts as progress for the watchdog.
      h.on(Hls.Events.FRAG_BUFFERED, () => { lastProgressAt = Date.now(); });
      h.loadSource(url);
      h.attachMedia(video);
      handle.h = h;
    };
    const rebuild = () => {
      if (handle.dead || ++handle.totalRebuilds > 12) {
        if (!handle.dead && handle.onerror) handle.onerror(new Error('Stream is not responding'));
        return;
      }
      try { handle.h && handle.h.destroy(); } catch (_) {}
      // A full rebuild re-loads the master playlist — a fresh draw on rotating
      // upstream hosts, which is the only escape from a dead variant host.
      setTimeout(() => { if (!handle.dead) start(); }, 1500);
    };
    start();
    // Recurring stall watchdog: covers never-start AND mid-playback freezes.
    // currentTime not advancing + no fragments decoded for 12s -> rebuild.
    // The hls.js-level retries above still run underneath; this is the floor.
    handle._wd = setInterval(() => {
      if (handle.dead) return;
      const t = video.currentTime;
      if (t > lastT + 0.25) {
        lastT = t;
        lastProgressAt = Date.now();
        handle.retries = 0;
        return;
      }
      if (video.paused && t > 0) { lastProgressAt = Date.now(); return; } // user-paused
      if (Date.now() - lastProgressAt > 12000) {
        lastProgressAt = Date.now();
        rebuild();
      }
    }, 3000);
    return handle;
  }
  video.src = url; // Safari native HLS
  handle.h = { destroy() { try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {} } };
  return handle;
}

/* ---------------- state ---------------- */

const state = {
  view: 'guide',
  status: null,
  channels: [],
  guide: null,          // guide channel rows w/ programmes
  guideStart: null, guideEnd: null,
  settings: {},          // per-user settings (favorites, defaults, future: fantasy)
  groupFilter: null,     // null = all, FAV_KEY = favorites, else a group name
  search: '',
  detail: null,          // guide detail panel: { ch, pi } (pi = programme index, -1 = channel's now)
  guideScroll: null,     // { left, top } — survives the 60s re-render
  games: [],             // live scoreboard (see loadScores)
  scoreErrors: {},       // league -> why its last refresh failed (server-side)
  scoresAt: 0,           // last successful scores poll
  flash: {},             // game id -> flash-until timestamp (score just changed)
  alerted: {},           // game id -> last switch-alert timestamp
  leagueFilter: null,
  onlyMine: false,       // games board: only games on your channels
  tv: null,              // Play-on-TV target: { id, deviceId, name, client, canPlay, canMessage }
  tvNow: null,           // channel id last sent to the TV
  follow: false,         // auto-switch the TV to the hottest game
  tvSwitchAt: 0,
  ltv: null, ltvAt: 0,   // Jellyfin Live TV channel items (for id lookup)
  player: null,          // { id, hls, video }
  mv: [],                // [{ id, hls, video }]
  mvFocus: -1,
  pickerCb: null
};

const chanById = (id) => state.channels.find(c => c.id === id);
const favorites = () => new Set((state.settings && state.settings.favorites) || []);
const isFav = (id) => favorites().has(id);
function toggleFav(id) {
  const f = favorites();
  f.has(id) ? f.delete(id) : f.add(id);
  state.settings.favorites = [...f];
  saveSettings();
}

function saveSettings() {
  api('UserSettings', { method: 'PUT', body: state.settings }).catch(() => {});
}

/* ---------------- data loading ---------------- */

async function loadStatus() { state.status = await api('Status'); }
async function loadChannels() { state.channels = (await api('Channels')).channels || []; }
async function loadGuide() {
  const start = new Date(Date.now() - 60 * 60e3);
  const end = new Date(Date.now() + 5.5 * 3600e3);
  const d = await api('Guide?start=' + encodeURIComponent(start.toISOString()) + '&end=' + encodeURIComponent(end.toISOString()));
  state.guide = d.channels; state.guideStart = new Date(d.start); state.guideEnd = new Date(d.end);
}
async function loadSettings() { try { state.settings = (await api('UserSettings')) || {}; } catch (e) { state.settings = {}; } }

/* ---------------- shell ---------------- */

let root, clockTimer, refreshTimer, scoreTimer, dvrTimer;
function shell() {
  root.innerHTML = `
  <div class="jtv-shell">
    <header class="jtv-topbar">
      <button class="jtv-back" id="jtv-back" title="Back to Jellyfin" aria-label="Back to Jellyfin">${icons.back}</button>
      <div class="jtv-logo">TALLY</div>
      <nav class="jtv-nav">
        <button class="jtv-tab" data-view="games"><i class="led"></i>Games</button>
        <button class="jtv-tab" data-view="live"><i class="led"></i>Channels</button>
        <button class="jtv-tab" data-view="guide"><i class="led"></i>Guide</button>
        <button class="jtv-tab" data-view="multi"><i class="led"></i>Multiview<span class="cnt"></span></button>
        <button class="jtv-tab" data-view="settings"><i class="led"></i>Settings</button>
      </nav>
      <div class="jtv-topright">
        <button class="jtv-tvbtn" id="jtv-tv" title="Play on a TV">${icons.cast}<span class="lbl">This device</span></button>
        <span class="jtv-livecount"><i class="led live"></i><span><span id="jtv-live-n">0</span> CHANNELS</span></span>
        <span class="jtv-clock" id="jtv-clock"></span>
      </div>
    </header>
    <div class="jtv-content" id="jtv-content"></div>
  </div>`;

  $('#jtv-back').onclick = () => {
    try { window.Dashboard && Dashboard.navigate('home.html'); } catch (e) { history.back(); }
  };
  $$('.jtv-tab', root).forEach(t => t.onclick = () => setView(t.dataset.view));
  $('#jtv-tv').onclick = openTvPicker;
  paintTvButton();
  tickClock(); clockTimer = setInterval(tickClock, 1000);
}

function tickClock() {
  const c = $('#jtv-clock');
  if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const n = $('#jtv-live-n');
  if (n) n.textContent = state.channels.length;
  placeNowline();
}

function setView(v) {
  state.view = v;
  render();
}

function render() {
  $$('.jtv-tab', root).forEach(t => t.classList.toggle('active', t.dataset.view === state.view));
  const cnt = $('.jtv-tab .cnt', root);
  if (cnt) cnt.textContent = state.mv.length ? String(state.mv.length) : '';
  // Games needs the scores feed; a time-grid guide only earns a tab when some channel has EPG data
  const scoresOn = !(state.status && state.status.scoresEnabled === false);
  const hasEpg = state.channels.some(c => c.hasEpg);
  $$('.jtv-tab', root).forEach(t => {
    if (t.dataset.view === 'games') t.style.display = scoresOn ? '' : 'none';
    if (t.dataset.view === 'guide') t.style.display = hasEpg || state.view === 'guide' ? '' : 'none';
  });
  const content = $('#jtv-content');
  if (state.view === 'games') renderGames(content);
  else if (state.view === 'guide') renderGuide(content);
  else if (state.view === 'live') renderLive(content);
  else if (state.view === 'multi') renderMulti(content);
  else if (state.view === 'settings') renderSettings(content);
  updateBugs();
  syncImmersive();
}

/* ---------------- guide view ---------------- */

const PPM = 6;                 // px per minute
// sticky channel column — must match the .gcell-chan widths in app.css
const chanW = () => (window.matchMedia('(max-width: 720px)').matches ? 148 : 280);

const guideChan = (id) => (state.guide || []).find(c => c.id === id);
function liveIndex(ch) {
  const now = Date.now();
  return ((ch && ch.programmes) || []).findIndex(p => new Date(p.start) <= now && new Date(p.end) > now);
}

function placeNowline() {
  const n = $('#jtv-nowline');
  if (!n || !state.guideStart) return;
  const now = Date.now();
  n.style.left = (chanW() + (now - state.guideStart) / 60000 * PPM) + 'px';
  n.firstElementChild.textContent = fmtTime(now);
  // the label parks in the header row — blank the slot time it would otherwise overprint
  $$('.ghead-time', n.parentElement).forEach(h => {
    const dt = now - +h.dataset.t;
    h.classList.toggle('under-now', dt > -60e3 && dt < 13 * 60e3);
  });
}

// Detail panel: what the pointer/focus is on in the grid. Falls back to the
// last-watched channel, then a favorite, then the first channel.
function ensureDetail() {
  let d = state.detail;
  if (!d || !chanById(d.ch)) {
    const favs = favorites();
    const c = chanById(state.settings.lastChannel) || state.channels.find(x => favs.has(x.id)) || state.channels[0];
    d = state.detail = c ? { ch: c.id, pi: -1, ps: null, auto: true } : null;
  }
  if (!d) return;
  // Programme indices shift every time the guide window reloads — re-find the
  // pinned programme by start time; an auto selection just follows what's live.
  const g = guideChan(d.ch), list = (g && g.programmes) || [];
  const i = !d.auto && d.ps ? list.findIndex(p => p.start === d.ps) : -1;
  d.pi = i >= 0 ? i : liveIndex(g);
  if (i < 0) d.auto = true;
  d.ps = d.pi >= 0 ? list[d.pi].start : null;
}

function renderDetail() {
  const box = $('#jtv-detail');
  if (!box) return;
  const d = state.detail, c = d && chanById(d.ch);
  if (!c) { box.style.display = 'none'; return; }
  box.style.display = '';

  const list = (guideChan(c.id) || {}).programmes || [];
  const p = d.pi >= 0 && list[d.pi] ? list[d.pi] : c.now;
  const next = d.pi >= 0 && list[d.pi] ? list[d.pi + 1] : c.next;
  const now = new Date();
  const live = !p || (new Date(p.start) <= now && new Date(p.end) > now);
  const past = !!p && new Date(p.end) <= now;
  const kicker = [live ? 'On now' : past ? 'Earlier' : 'Later', (p && p.category) || c.group].filter(Boolean).join(' · ');
  const desc = p ? [p.subTitle, p.description].filter(Boolean).join(' — ') : 'No guide data for this channel.';

  const slots = [0, 1, 2, 3].map(i => {
    const m = state.mv[i], mc = m && chanById(m.id);
    return m
      ? `<button class="bus-slot" data-bus="go" title="Open multiview"><span class="face">${mc && mc.logo ? `<img src="${esc(mc.logo)}" referrerpolicy="no-referrer" alt="">` : ''}</span>
          <span class="jtv-umd"><i class="led live"></i><span class="nm">${esc(mc ? mc.name : m.id)}</span></span></button>`
      : `<button class="bus-slot empty" data-bus="add" aria-label="Add a stream to multiview">+</button>`;
  }).join('');

  box.innerHTML = `
    <div class="d-mon${live ? ' live' : ''}">
      <div class="jtv-monitor">${chanMark(c, true)}<span class="jtv-tag${live ? ' live' : ''}">${live ? 'LIVE' : esc(fmtTime(p.start))}</span></div>
      <div class="jtv-umd"><i class="led${live ? ' live' : ''}"></i><span class="nm">${esc(c.name)}</span></div>
    </div>
    <div class="d-info">
      <div class="jtv-k${live ? ' live' : ''}">${esc(kicker)}</div>
      <div class="d-title">${esc(p ? (p.title || 'Untitled') : c.name)}</div>
      ${desc ? `<div class="d-desc">${esc(desc)}</div>` : ''}
      ${progReadout(p, next, now)}
      <div class="d-actions">
        <button class="btn btn-primary" data-act="watch">${icons.play} ${live ? 'Watch' : 'Watch ' + esc(c.name)}</button>
        <button class="btn" data-act="mv">Add to multiview</button>
        <button class="btn${isFav(c.id) ? ' is-on' : ''}" data-act="fav" aria-pressed="${isFav(c.id)}">${icons.star} ${isFav(c.id) ? 'Favorited' : 'Favorite'}</button>
      </div>
    </div>
    <div class="jtv-bus">
      <div class="jtv-k">Multiview · ${state.mv.length}/4</div>
      <div class="jtv-bus-grid">${slots}</div>
    </div>`;
}

function renderGuide(content) {
  const skel = Array.from({ length: 8 }, (_, i) => {
    const a = (i * 197) % 560, w1 = 170 + (i * 53) % 230, w2 = 130 + (i * 97) % 250;
    return `<div class="skel-row"><div class="skel-cell"><span class="skel-logo shimmer"></span><span class="skel-txt"><span class="shimmer"></span><span class="shimmer w60"></span></span></div><div class="skel-track"><span class="shimmer" style="left:${a}px;width:${w1}px"></span><span class="shimmer" style="left:${a + w1 + 260}px;width:${w2}px"></span></div></div>`;
  }).join('');
  content.innerHTML = `<div class="jtv-guide-wrap">
    <div class="jtv-detail" id="jtv-detail"></div>
    <div class="jtv-guide-scroll" id="jtv-gs"><div class="jtv-skel-guide">${skel}</div></div></div>`;

  ensureDetail();
  renderDetail();
  $('#jtv-detail', content).onclick = (ev) => {
    const b = ev.target.closest('[data-act], [data-bus]');
    if (!b || !state.detail) return;
    const id = state.detail.ch;
    if (b.dataset.bus === 'go') setView('multi');
    else if (b.dataset.bus === 'add') openPicker((pick) => addToMultiview(pick));
    else if (b.dataset.act === 'watch') play(id);
    else if (b.dataset.act === 'mv') addToMultiview(id);
    else if (b.dataset.act === 'fav') {
      toggleFav(id);
      renderDetail();
      $$('.gcell-chan', content).forEach(n => { if (n.dataset.ch === id) $('.cname', n).classList.toggle('fav', isFav(id)); });
    }
  };

  const scrollEl = $('#jtv-gs');
  if (!state.guide) return;

  const start = state.guideStart, end = state.guideEnd;
  const totalMin = (end - start) / 60000;
  const trackW = totalMin * PPM;
  const now = Date.now();
  const CHAN_W = chanW();
  const det = state.detail || {};

  // header slots every 30 min
  let head = `<div class="jtv-guide-head"><div class="ghead-chan">CHANNEL</div>`;
  const slot0 = new Date(Math.ceil(start / 1800e3) * 1800e3);
  const slot0Left = (slot0 - start) / 60000 * PPM;
  for (let t = slot0; t < end; t = new Date(+t + 1800e3)) {
    const left = (t - start) / 60000 * PPM;
    head += `<div class="ghead-time" data-t="${+t}" style="position:absolute;top:0;left:${CHAN_W + left}px;width:${30 * PPM}px">${fmtTime(t)}</div>`;
  }
  head += `<div class="ghead-fill"></div></div>`;

  const rows = state.guide.map(ch => {
    const progs = (ch.programmes || []).map((p, pi) => {
      const s = new Date(p.start), e = new Date(p.end);
      const left = Math.max(0, (s - start) / 60000 * PPM);
      const right = Math.min(trackW, (e - start) / 60000 * PPM);
      if (right - left < 4) return '';
      const live = s <= now && e > now;
      const sel = det.ch === ch.id && det.pi === pi;
      return `<div class="gprog${live ? ' live' : ''}${e <= now ? ' past' : ''}${sel ? ' sel' : ''}" data-ch="${esc(ch.id)}" data-pi="${pi}" title="${esc(p.title)}"
        style="left:${left}px;width:${right - left}px">
        <div class="t">${esc(p.title || 'Untitled')}</div>
        <div class="tm">${fmtTime(s)} – ${fmtTime(e)}</div></div>`;
    }).join('');

    const body = progs || `<div class="gprog noepg" data-ch="${esc(ch.id)}" style="left:0;width:${trackW}px"><span>No guide data — select to watch</span></div>`;
    return `<div class="grow${det.ch === ch.id ? ' sel' : ''}">
      <div class="gcell-chan" data-ch="${esc(ch.id)}" tabindex="0">
        ${chanMark(ch)}
        <div class="ctext"><div class="cname${isFav(ch.id) ? ' fav' : ''}">${esc(ch.name)}</div><div class="cgroup">${esc(ch.group || '')}</div></div>
      </div>
      <div class="gtrack" style="width:${trackW}px">${body}</div>
    </div>`;
  }).join('');

  scrollEl.innerHTML = `
    <div style="min-width:${CHAN_W + trackW}px;position:relative;--jtv-slot0:${slot0Left}px">
      ${head}
      <div class="jtv-guide-body">${rows}</div>
      <div class="jtv-nowline" id="jtv-nowline"><span></span></div>
    </div>`;
  placeNowline();

  // first paint parks "now" ~15% from the left; afterwards the 60s re-render keeps the user's place
  if (state.guideScroll) {
    scrollEl.scrollLeft = state.guideScroll.left; scrollEl.scrollTop = state.guideScroll.top;
  } else {
    const nowLeft = CHAN_W + (now - start) / 60000 * PPM;
    scrollEl.scrollLeft = Math.max(0, nowLeft - CHAN_W - scrollEl.clientWidth * 0.15);
  }
  scrollEl.addEventListener('scroll', () => {
    state.guideScroll = { left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
  }, { passive: true });

  // pointer/focus drives the detail panel — no re-render of the grid
  const point = (ev) => {
    const n = ev.target.closest('.gprog, .gcell-chan');
    if (!n) return;
    const ch = n.dataset.ch, g = guideChan(ch);
    const auto = n.dataset.pi == null;
    const pi = auto ? liveIndex(g) : +n.dataset.pi;
    if (state.detail && state.detail.ch === ch && state.detail.pi === pi) return;
    state.detail = { ch, pi, ps: pi >= 0 ? g.programmes[pi].start : null, auto };
    $$('.gprog.sel, .grow.sel', scrollEl).forEach(x => x.classList.remove('sel'));
    const row = n.closest('.grow');
    row.classList.add('sel');
    const cell = $(`.gprog[data-pi="${pi}"]`, row);
    if (cell) cell.classList.add('sel');
    renderDetail();
  };
  scrollEl.addEventListener('mouseover', point);
  scrollEl.addEventListener('focusin', point);

  scrollEl.addEventListener('click', (ev) => {
    const n = ev.target.closest('[data-ch]');
    if (n) play(n.dataset.ch);
  });
  scrollEl.addEventListener('keydown', (ev) => {
    const n = ev.key === 'Enter' && ev.target.closest('.gcell-chan');
    if (n) play(n.dataset.ch);
  });
}

/* ---------------- live view ---------------- */

const FAV_KEY = '::favorites::';   // filter key, not a group name

function renderLive(content) {
  const groups = [...new Set(state.channels.map(c => c.group || 'Live'))];
  if (state.groupFilter && state.groupFilter !== FAV_KEY && !groups.includes(state.groupFilter)) state.groupFilter = null;

  // the 60s refresh re-renders this view — don't steal the caret from someone mid-search
  const q0 = $('#jtv-q', content);
  const caret = q0 && document.activeElement === q0 ? [q0.selectionStart, q0.selectionEnd] : null;

  const chip = (key, label) => `<button class="jtv-chip" data-g="${esc(key == null ? '' : key)}">${label}</button>`;
  content.innerHTML = `<div class="jtv-view">
    <div class="jtv-viewhead"><h2 class="jtv-h2">Live now</h2><span class="jtv-k" id="jtv-live-count"></span></div>
    <div class="jtv-filterbar">
      <div class="jtv-chips">${chip(null, 'All')}${chip(FAV_KEY, icons.star + ' Favorites')}${groups.map(g => chip(g, esc(g))).join('')}</div>
      <input class="jtv-search" id="jtv-q" type="search" placeholder="Search channels" aria-label="Search channels" value="${esc(state.search)}">
    </div>
    <div id="jtv-cards-host"></div>
  </div>`;

  const host = $('#jtv-cards-host', content);
  const draw = () => {
    const filter = state.groupFilter;
    $$('.jtv-chip', content).forEach(ch => ch.classList.toggle('active', (ch.dataset.g || null) === filter));

    let list = state.channels;
    if (filter === FAV_KEY) list = list.filter(c => isFav(c.id));
    else if (filter) list = list.filter(c => (c.group || 'Live') === filter);
    const needle = state.search.trim().toLowerCase();
    if (needle) list = list.filter(c => c.name.toLowerCase().includes(needle));
    $('#jtv-live-count', content).textContent = list.length + (list.length === 1 ? ' channel' : ' channels');

    const now = new Date();
    const cards = list.map(c => {
      const p = c.now ? prog(c.now, now) : null;
      const inMv = state.mv.some(m => m.id === c.id);
      return `<div class="jtv-card" data-ch="${esc(c.id)}" tabindex="0">
        <div class="jtv-monitor">
          ${chanMark(c, true)}
          <span class="jtv-tag live">LIVE</span>
          <div class="mini-actions">
            <button class="icon-btn${isFav(c.id) ? ' faved' : ''}" data-fav="${esc(c.id)}" title="Favorite" aria-label="Favorite" aria-pressed="${isFav(c.id)}">${icons.star}</button>
            <button class="icon-btn" data-mv="${esc(c.id)}" title="Add to multiview" aria-label="Add to multiview">${icons.grid}</button>
          </div>
          <div class="hover-cta"><span class="playbtn">${icons.play} Watch</span></div>
        </div>
        <div class="jtv-umd"><i class="led${inMv ? ' live' : ''}"></i><span class="nm">${esc(c.name)}</span>${isFav(c.id) ? `<span class="fav">${icons.star}</span>` : ''}</div>
        <div class="jtv-card-info">
          <div class="jtv-card-now">${c.now ? esc(c.now.title || 'Untitled') : 'Live stream'}</div>
          <div class="jtv-card-time" data-bug="${esc(c.id)}" data-idle="${esc(c.now ? fmtTime(c.now.start) + ' – ' + fmtTime(c.now.end) : (c.group || 'No guide data'))}"></div>
          ${p !== null ? `<div class="jtv-progress"><div style="width:${(p * 100).toFixed(1)}%"></div></div>` : ''}
        </div>
      </div>`;
    }).join('');

    const empty = !state.channels.length
      ? ['No channels yet.', state.status && state.status.isAdmin ? 'Add a source under Settings to get started.' : 'Ask your server admin to add a source.']
      : filter === FAV_KEY && !needle
        ? ['No favorites yet.', 'Use the star on any channel to pin it here.']
        : ['No channels match.', 'Try another group or clear the search.'];
    host.innerHTML = list.length
      ? `<div class="jtv-cards">${cards}</div>`
      : `<div class="jtv-empty"><div>${empty[0]}</div><div class="sub">${empty[1]}</div></div>`;
  };
  draw();

  $$('.jtv-chip', content).forEach(ch => ch.onclick = () => { state.groupFilter = ch.dataset.g || null; draw(); });
  const q = $('#jtv-q', content);
  q.oninput = () => { state.search = q.value; draw(); };
  if (caret) { q.focus(); try { q.setSelectionRange(caret[0], caret[1]); } catch (e) {} }

  host.onclick = (ev) => {
    const fav = ev.target.closest('[data-fav]'), mv = ev.target.closest('[data-mv]'), card = ev.target.closest('.jtv-card');
    if (fav) { toggleFav(fav.dataset.fav); draw(); }
    else if (mv) addToMultiview(mv.dataset.mv);
    else if (card) play(card.dataset.ch);
  };
  host.onkeydown = (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('jtv-card')) play(ev.target.dataset.ch);
  };
}

/* ---------------- games: live scores, heat, alerts ---------------- */

const spoilerFree = () => !!(state.settings && state.settings.hideScores);
const alertsOn = () => !(state.settings && state.settings.alerts === false);

async function loadScores() {
  if (state.status && state.status.scoresEnabled === false) { state.games = []; return; }
  const d = await api('Scores');
  const first = !state.scoresAt;
  const prev = state.games;
  state.games = (d && d.games) || [];
  state.scoreErrors = (d && d.errors) || {};
  state.scoresAt = Date.now();
  if (!first) noteChanges(prev, state.games);
}

const total = (g) => (g.home.score || 0) + (g.away.score || 0);

// What changed since the last poll: scores flash on the board, and a game that just
// turned hot raises a switch alert — but only while you're busy watching something else.
function noteChanges(prev, next) {
  const before = new Map(prev.map(g => [g.id, g]));
  const watching = new Set([state.player && state.player.id, state.tv && state.tvNow, ...(state.view === 'multi' ? state.mv.map(m => m.id) : [])].filter(Boolean));
  const now = Date.now();
  for (const g of next) {
    const old = before.get(g.id);
    if (!old || g.state !== 'in') continue;
    const scored = total(g) > total(old);
    if (scored) state.flash[g.id] = now + 8000;

    if (!watching.size || !alertsOn() || spoilerFree()) continue;
    const chan = bestChannel(g);
    if (!chan || g.channels.some(c => watching.has(c.id))) continue;
    const turnedHot = g.heat >= 75 && old.heat < 75;
    const bigScore = scored && g.heat >= 55;
    if (!(turnedHot || bigScore) || (state.alerted[g.id] || 0) > now - 4 * 60e3) continue;
    state.alerted[g.id] = now;
    if (state.tv && !state.follow) tvMessage('Tally · ' + (g.tags[0] || 'Hot game'), bugText(g) + ' — on ' + chan.name);
    showAlert(g, chan, bigScore && !turnedHot ? (g.lastPlayType || 'Score').toUpperCase() : g.tags[0]);
  }
}

// The channel to open for a game. A broadcaster-only match is trusted only when that
// channel isn't also the broadcaster of another live game (regional feeds: eight games, one "FOX").
function bestChannel(g) {
  for (const gc of g.channels || []) {
    const c = chanById(gc.id);
    if (!c) continue;
    if (gc.kind !== 'network') return c;
    const rivals = state.games.filter(o => o.id !== g.id && o.state === 'in' && o.channels.some(x => x.id === gc.id));
    if (!rivals.length || g.state !== 'in') return c;
  }
  const any = (g.channels || []).map(gc => chanById(gc.id)).find(Boolean);
  return any || null;
}

// The game a channel is showing, for score bugs. Ambiguous broadcaster matches get no bug.
function gameForChannel(id) {
  if (spoilerFree()) return null;
  const hits = state.games.filter(g => g.state === 'in' && g.channels.some(c => c.id === id));
  const sure = hits.find(g => g.channels.some(c => c.id === id && c.kind !== 'network'));
  return sure || (hits.length === 1 ? hits[0] : null);
}

const bugText = (g) => `${g.away.abbr} ${g.away.score ?? 0} · ${g.home.abbr} ${g.home.score ?? 0} · ${g.detail}`;

function updateBugs() {
  $$('[data-bug]').forEach(n => {
    const g = gameForChannel(n.dataset.bug);
    n.textContent = g ? bugText(g) : (n.dataset.idle || '');
    n.classList.toggle('on', !!g);
  });
}

function showAlert(g, chan, reason) {
  $$('.jtv-alert').forEach(n => n.remove());
  const inMulti = state.view === 'multi' && !state.player;
  const full = state.mv.length >= 4;
  const box = el(`<div class="jtv-alert" role="alert">
    <div class="a-head"><span class="jtv-tag live">${esc(reason || 'HOT')}</span><span class="jtv-k">${esc(g.league)} · ${esc(g.detail)}</span>
      <button class="a-x" aria-label="Dismiss">${icons.close}</button></div>
    <div class="a-score">${esc(g.away.abbr)} <b>${g.away.score ?? 0}</b><span>·</span>${esc(g.home.abbr)} <b>${g.home.score ?? 0}</b></div>
    ${g.downDistance || g.lastPlay ? `<div class="a-sit">${esc((g.lastPlayScore > 0 && g.lastPlay) || g.downDistance || g.lastPlay)}</div>` : ''}
    <div class="a-actions">
      <button class="btn btn-primary" data-a="${inMulti ? (full ? 'swap' : 'add') : 'switch'}">${inMulti ? (full ? 'Swap into focused tile' : 'Add to multiview') : 'Switch ' + (state.tv ? esc(state.tv.name) + ' to ' : 'to ') + esc(chan.name)}</button>
      ${inMulti || state.tv ? '' : '<button class="btn" data-a="add">Multiview</button>'}
    </div></div>`);
  document.body.appendChild(box);
  const close = () => box.remove();
  const timer = setTimeout(close, 12000);
  box.onclick = (ev) => {
    const b = ev.target.closest('[data-a], .a-x');
    if (!b) return;
    clearTimeout(timer); close();
    const a = b.dataset.a;
    if (a === 'switch') play(chan.id);
    else if (a === 'add') { closePlayer(); addToMultiview(chan.id); }
    else if (a === 'swap') {
      const m = state.mv[Math.max(0, state.mvFocus)];
      if (m) { try { m.hls && m.hls.destroy(); } catch (e) {} m.id = chan.id; m.hls = null; m.video = null; render(); }
    }
  };
}

// One click: fill the free multiview slots with the hottest live games you can actually watch.
function fillMultiview() {
  const used = new Set(state.mv.map(m => m.id));
  const picks = state.games
    .filter(g => g.state === 'in')
    .sort((a, b) => b.heat - a.heat)
    .map(bestChannel)
    .filter(c => c && !used.has(c.id) && (used.add(c.id), true))
    .slice(0, 4 - state.mv.length);
  if (!picks.length) { toast(state.mv.length >= 4 ? 'Multiview is full' : 'No live games on your channels right now', true); return; }
  picks.forEach(c => state.mv.push({ id: c.id, hls: null, video: null }));
  if (state.mvFocus < 0) state.mvFocus = 0;
  setView('multi');
  toast(picks.length + (picks.length === 1 ? ' game' : ' games') + ' added — hottest first');
}

function gameRow(g, hide) {
  const live = g.state === 'in', pre = g.state === 'pre', post = g.state === 'post';
  const chans = (g.channels || []).map(gc => ({ kind: gc.kind, c: chanById(gc.id) })).filter(x => x.c).slice(0, 3);
  const start = new Date(g.start);
  const today = start.toDateString() === new Date().toDateString();
  const when = (today ? '' : start.toLocaleDateString([], { weekday: 'short' }) + ' ') + fmtTime(start);
  const flash = !hide && (state.flash[g.id] || 0) > Date.now();

  const team = (t, other) => `<div class="g-team${post && !hide && !t.winner && other.winner ? ' lose' : ''}">
      ${t.logo ? `<img class="g-logo" src="${esc(t.logo)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : '<span class="g-logo"></span>'}
      <span class="g-name">${esc(t.shortName || t.abbr)}</span>
      ${t.record ? `<span class="g-rec">${esc(t.record)}</span>` : ''}
      ${live && !hide && t.possession ? '<i class="led on" title="Possession"></i>' : ''}
      <span class="g-score">${pre ? '' : hide ? '–' : (t.score ?? 0)}</span></div>`;

  let sit = '';
  if (live && !hide) {
    const bases = g.sport === 'baseball' && g.outs != null
      ? `<span class="diamond" aria-label="Runners"><i class="b2${g.onSecond ? ' on' : ''}"></i><i class="b3${g.onThird ? ' on' : ''}"></i><i class="b1${g.onFirst ? ' on' : ''}"></i></span>${g.balls ?? 0}-${g.strikes ?? 0} · ${g.outs} OUT`
      : '';
    const fav = g.homeWinPct != null ? (g.homeWinPct >= 0.5 ? [g.home.abbr, g.homeWinPct] : [g.away.abbr, 1 - g.homeWinPct]) : null;
    sit = `${g.tags.length ? `<div class="g-tags">${g.tags.map((t, i) => `<span class="jtv-tag${i === 0 && g.heat >= 70 ? ' live' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="g-line">${bases || esc(g.downDistance || '')}${fav ? `<span class="g-wp">WIN ${esc(fav[0])} ${Math.round(fav[1] * 100)}%</span>` : ''}</div>
      ${g.lastPlay ? `<div class="g-play">${esc(g.lastPlay)}</div>` : ''}`;
  } else if (pre) {
    sit = `${g.tags.length ? `<div class="g-tags">${g.tags.map(t => `<span class="jtv-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="g-play">${g.broadcasts.length ? 'On ' + esc(g.broadcasts.slice(0, 4).join(', ')) : 'No broadcaster listed'}</div>`;
  } else if (post && !hide && g.lastPlay) {
    sit = `<div class="g-play">${esc(g.lastPlay)}</div>`;
  }

  const watch = chans.length
    ? chans.map((x, i) => `<button class="g-chan${i === 0 ? ' first' : ''}" data-watch="${esc(x.c.id)}" title="${x.kind === 'network' ? 'Broadcaster match — may be carrying a different regional game' : 'Watch'}">
        <i class="led${live ? ' live' : ''}"></i><span class="nm">${esc(x.c.name)}</span>${x.kind === 'network' ? '<span class="q">NET</span>' : ''}</button>`).join('')
      + `<button class="icon-btn" data-gmv="${esc(chans[0].c.id)}" title="Add to multiview" aria-label="Add to multiview">${icons.grid}</button>`
    : post ? '' : `<span class="g-none">Not on your channels</span>`;

  return `<div class="game${live ? ' live' : ''}${flash ? ' flash' : ''}${chans.length ? ' can' : ''}" data-game="${esc(g.id)}">
    <div class="g-status"><div class="jtv-k">${esc(g.league)}</div><div class="g-clock">${esc(live ? g.detail : pre ? when : 'Final')}</div></div>
    <div class="g-teams">${team(g.away, g.home)}${team(g.home, g.away)}</div>
    <div class="g-sit">${sit}</div>
    <div class="g-watch">${watch}</div>
  </div>`;
}

function renderGames(content) {
  const hide = spoilerFree();
  const mine = (g) => (g.channels || []).some(gc => chanById(gc.id));
  const leagues = [...new Set(state.games.map(g => g.league))];
  if (state.leagueFilter && !leagues.includes(state.leagueFilter)) state.leagueFilter = null;

  let list = state.games;
  if (state.leagueFilter) list = list.filter(g => g.league === state.leagueFilter);
  if (state.onlyMine) list = list.filter(mine);

  const by = (s) => list.filter(g => g.state === s);
  const live = by('in').sort((a, b) => hide ? new Date(a.start) - new Date(b.start) : b.heat - a.heat);
  const pre = by('pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  const post = by('post').sort((a, b) => new Date(b.start) - new Date(a.start));
  const sec = (label, arr) => arr.length
    ? `<div class="g-sec"><span class="jtv-k">${label} · ${arr.length}</span></div>${arr.map(g => gameRow(g, hide)).join('')}` : '';

  // A feed failure must never pass for a quiet day — say which leagues are dark and why.
  const errs = Object.entries(state.scoreErrors || {});
  const feedNote = errs.length
    ? `<div class="g-feed" role="status"><span class="jtv-k live">Scores feed</span><span>${errs.length} of your leagues didn’t load — ${esc(errs.slice(0, 3).map(([l, m]) => l + ': ' + m).join(' · '))}${errs.length > 3 ? ' …' : ''}</span></div>` : '';

  const chip = (key, label, on) => `<button class="jtv-chip${on ? ' active' : ''}" data-l="${esc(key)}">${label}</button>`;
  const top = content.firstElementChild && content.firstElementChild.classList.contains('jtv-games') ? content.firstElementChild.scrollTop : 0;

  content.innerHTML = `<div class="jtv-view jtv-games">
    <div class="jtv-viewhead"><h2 class="jtv-h2">Games</h2>
      <span class="jtv-k">${state.scoresAt ? `${state.games.filter(g => g.state === 'in').length} live · ${state.games.filter(g => g.state === 'pre').length} upcoming` : 'Loading…'}</span>
      <button class="btn" id="g-fill">${icons.grid} Fill multiview with the hottest games</button></div>
    <div class="jtv-filterbar g-filter">
      <div class="jtv-chips">${chip('', 'All', !state.leagueFilter)}${leagues.map(l => chip(l, esc(l), state.leagueFilter === l)).join('')}</div>
      <button class="jtv-chip${state.onlyMine ? ' active' : ''}" id="g-mine"><i class="led${state.onlyMine ? ' on' : ''}"></i>My channels</button>
      <button class="jtv-chip${hide ? ' active' : ''}" id="g-hide"><i class="led${hide ? ' on' : ''}"></i>Hide scores</button>
    </div>
    ${feedNote}
    ${list.length ? sec('Live', live) + sec('Upcoming', pre) + sec('Final', post)
      : `<div class="jtv-empty"><div>${state.scoresAt ? 'No games to show.' : state.scoresErr ? 'Couldn’t reach the scores feed — retrying.' : 'Loading games…'}</div>${state.scoresAt ? `<div class="sub">${state.onlyMine ? 'None of today’s games match your channels — turn off “My channels” to see the full board.' : errs.length ? 'The scores feed is failing — details above. The server log has more.' : 'Nothing scheduled today in the leagues you follow.'}</div>` : ''}</div>`}
  </div>`;
  content.firstElementChild.scrollTop = top;

  $$('[data-l]', content).forEach(b => b.onclick = () => { state.leagueFilter = b.dataset.l || null; render(); });
  $('#g-mine', content).onclick = () => { state.onlyMine = !state.onlyMine; render(); };
  $('#g-hide', content).onclick = () => { state.settings.hideScores = !hide; saveSettings(); render(); };
  $('#g-fill', content).onclick = fillMultiview;
  content.firstElementChild.onclick = (ev) => {
    const mv = ev.target.closest('[data-gmv]'), w = ev.target.closest('[data-watch]'), row = ev.target.closest('.game.can');
    if (mv) addToMultiview(mv.dataset.gmv);
    else if (w) play(w.dataset.watch);
    else if (row) { const c = bestChannel(state.games.find(g => g.id === row.dataset.game) || {}); if (c) play(c.id); }
  };
}

/* ---------------- play on TV ---------------- */

// Native TV apps (Swiftfin, Jellyfin for Android TV) can't show this UI, but they hold a socket to the
// server and obey "play this item now" — the same channel Jellyfin's own cast button uses. So the phone
// or laptop is the JellyTV UI and the TV app is the screen: pick a TV once, and every Watch goes there.

async function jf(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ Authorization: 'MediaBrowser Token="' + env.token() + '"' }, opts.headers);
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(env.url(path), Object.assign({}, opts, { headers }));
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const myUserId = () => { try { return ApiClient.getCurrentUserId(); } catch (e) { return ''; } };
const myDeviceId = () => { try { return ApiClient.deviceId(); } catch (e) { return ''; } };
// Wholphin shows pushed messages but ignores a pushed Play (checked against its source)
const ignoresPlay = (s) => /wholphin/i.test(s.Client || '');

async function loadTvs() {
  const list = (await jf('Sessions?controllableByUserId=' + encodeURIComponent(myUserId()))) || [];
  return list
    .filter(s => s.SupportsRemoteControl && s.DeviceId !== myDeviceId() && (s.PlayableMediaTypes || []).includes('Video'))
    .map(s => ({
      id: s.Id, deviceId: s.DeviceId, name: s.DeviceName || s.Client || 'TV', client: [s.Client, s.ApplicationVersion].filter(Boolean).join(' '),
      nowPlaying: s.NowPlayingItem ? s.NowPlayingItem.Name : null,
      canPlay: !ignoresPlay(s),
      canMessage: (s.SupportedCommands || []).includes('DisplayMessage')
    }));
}

function setTv(tv) {
  state.tv = tv;
  state.tvNow = null;
  if (!tv) state.follow = false;
  try { tv ? localStorage.setItem('jtv_tv', tv.deviceId) : localStorage.removeItem('jtv_tv'); } catch (e) {}
  paintTvButton();
}

function paintTvButton() {
  const b = $('#jtv-tv');
  if (!b) return;
  b.classList.toggle('on', !!state.tv);
  $('.lbl', b).textContent = state.tv ? state.tv.name : 'This device';
  b.title = state.tv ? 'Playing on ' + state.tv.name + (state.follow ? ' — following the hottest game' : '') : 'Play on a TV';
}

// JellyTV channel -> the Jellyfin Live TV item a native app can play. Looked up at tap time:
// ids change whenever a source's stream URLs rotate.
async function liveTvItemFor(chan) {
  if (!state.ltv || Date.now() - state.ltvAt > 30e3) {
    const d = await jf('LiveTv/Channels?userId=' + encodeURIComponent(myUserId()) + '&limit=2000&enableImages=false&enableUserData=false');
    state.ltv = (d && d.Items) || [];
    state.ltvAt = Date.now();
  }
  const want = chan.name.trim().toLowerCase();
  return state.ltv.find(i => (i.Name || '').trim().toLowerCase() === want) || null;
}

async function playOnTv(id, quiet) {
  const c = chanById(id), tv = state.tv;
  if (!c || !tv) return false;
  try {
    const item = await liveTvItemFor(c);
    if (!item) { toast(c.name + ' isn’t in Jellyfin’s Live TV yet — try again in a minute', true); return false; }
    await jf('Sessions/' + encodeURIComponent(tv.id) + '/Playing?playCommand=PlayNow&itemIds=' + encodeURIComponent(item.Id), { method: 'POST' });
    state.tvNow = id;
    state.tvSwitchAt = Date.now();
    if (state.settings.lastChannel !== id) { state.settings.lastChannel = id; saveSettings(); }
    if (!quiet) toast('Playing ' + c.name + ' on ' + tv.name);
    return true;
  } catch (e) {
    if (e.status === 404 || e.status === 400) { toast(tv.name + ' is no longer connected', true); setTv(null); }
    else toast('Couldn’t reach ' + tv.name + ': ' + e.message, true);
    return false;
  }
}

function tvMessage(header, text) {
  const tv = state.tv;
  if (!tv || !tv.canMessage) return;
  jf('Sessions/' + encodeURIComponent(tv.id) + '/Message', { method: 'POST', body: { Header: header, Text: text, TimeoutMs: 9000 } }).catch(() => {});
}

// "Follow the hottest game": RedZone-style whip-around using the TV app's own player. Runs while
// JellyTV is open here. Switches only for a clearly hotter game, and never more than every 90 s.
function autoDirect() {
  if (!state.tv || !state.follow || spoilerFree()) return;
  if (Date.now() - (state.tvSwitchAt || 0) < 90e3) return;
  const ranked = state.games.filter(g => g.state === 'in' && g.heat >= 50)
    .sort((a, b) => b.heat - a.heat).map(g => ({ g, c: bestChannel(g) })).filter(x => x.c);
  if (!ranked.length) return;
  const top = ranked[0];
  if (top.c.id === state.tvNow) return;
  const current = state.tvNow ? gameForChannel(state.tvNow) : null;
  if (current && current.state === 'in' && top.g.heat < current.heat + 15) return;
  playOnTv(top.c.id, true).then(ok => {
    if (ok) { toast('Switched ' + state.tv.name + ' to ' + bugText(top.g) + (top.g.tags[0] ? ' — ' + top.g.tags[0] : '')); tvMessage('Tally', (top.g.tags[0] ? top.g.tags[0] + ' · ' : '') + bugText(top.g)); }
  });
}

async function openTvPicker() {
  const veil = el(`<div class="jtv-modal-veil"><div class="jtv-modal" role="dialog" aria-label="Play on">
    <div class="m-head"><h3>Play on</h3><button class="icon-btn" id="m-x" aria-label="Close">${icons.close}</button></div>
    <div class="m-body" id="tv-list"><div class="m-none">Looking for TVs…</div></div>
    <div class="m-foot" id="tv-foot"></div></div></div>`);
  document.body.appendChild(veil);
  const close = () => veil.remove();
  $('#m-x', veil).onclick = close;
  veil.onclick = (e) => { if (e.target === veil) close(); };

  let tvs = [];
  try { tvs = await loadTvs(); } catch (e) { $('#tv-list', veil).innerHTML = `<div class="m-none">Couldn’t list devices: ${esc(e.message)}</div>`; return; }
  if (!veil.isConnected) return;

  const row = (key, name, sub, on, off) => `<div class="m-row tv-row${on ? ' on' : ''}${off ? ' off' : ''}" data-tv="${esc(key)}" tabindex="0">
      <i class="led${on ? ' on' : ''}"></i><div class="r-text"><div class="r-name">${esc(name)}</div><div class="r-sub">${esc(sub)}</div></div></div>`;
  $('#tv-list', veil).innerHTML = row('', 'This device', 'Watch here, in Tally’s own player', !state.tv)
    + tvs.map(t => row(t.id, t.name, t.canPlay ? t.client + (t.nowPlaying ? ' · playing ' + t.nowPlaying : '') : t.client + ' — can show alerts, but ignores play commands', state.tv && state.tv.id === t.id, !t.canPlay)).join('')
    + (tvs.length ? '' : `<div class="m-none">No TVs found. Open Jellyfin for Android TV or Swiftfin on the TV, signed in as you — it shows up here while the app is open.</div>`);

  const paintFoot = () => {
    $('#tv-foot', veil).innerHTML = state.tv
      ? `<label class="check"><button class="toggle${state.follow ? ' on' : ''}" id="tv-follow" role="switch" aria-checked="${!!state.follow}"></button>
           Follow the hottest game — switch ${esc(state.tv.name)} automatically while Tally is open here</label>
         <button class="btn" id="tv-stop">Stop the TV</button>` : '';
    const f = $('#tv-follow', veil);
    if (f) f.onclick = () => { state.follow = !state.follow; paintFoot(); paintTvButton(); if (state.follow) { state.tvSwitchAt = 0; autoDirect(); } };
    const s = $('#tv-stop', veil);
    if (s) s.onclick = () => { jf('Sessions/' + encodeURIComponent(state.tv.id) + '/Playing/Stop', { method: 'POST' }).catch(() => {}); state.tvNow = null; toast('Stopped ' + state.tv.name); };
  };
  paintFoot();

  $$('.tv-row', veil).forEach(r => {
    const pick = () => {
      const t = tvs.find(x => x.id === r.dataset.tv) || null;
      if (t && !t.canPlay) { toast(t.name + ' can’t be told what to play — use Jellyfin for Android TV on that device', true); return; }
      setTv(t);
      if (t && state.player) { const id = state.player.id; closePlayer(); playOnTv(id); }   // hand the current game over
      close();
      if (t) toast('Watch buttons now play on ' + t.name);
    };
    r.onclick = pick;
    r.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
  });
}

// Re-attach to the TV used last time, if its app is open.
async function restoreTv() {
  let want = null;
  try { want = localStorage.getItem('jtv_tv'); } catch (e) {}
  if (!want) return;
  try { const t = (await loadTvs()).find(x => x.deviceId === want && x.canPlay); if (t) setTv(t); } catch (e) {}
}

/* ---------------- multiview ---------------- */

function addToMultiview(id) {
  if (state.mv.length >= 4) { toast('Multiview supports up to 4 streams', true); return; }
  if (state.mv.some(m => m.id === id)) { toast('Already in multiview'); setView('multi'); return; }
  state.mv.push({ id, hls: null, video: null });
  if (state.mvFocus < 0) state.mvFocus = 0;
  setView('multi');
  toast(chanById(id)?.name + ' added to multiview');
}

function renderMulti(content) {
  const n = clamp(state.mv.length || 1, 1, 4);
  let tiles = state.mv.map((m, i) => {
    const c = chanById(m.id);
    const on = i === state.mvFocus;
    return `<div class="mv-tile${on ? ' focused' : ''}" data-tile="${i}" tabindex="0">
      <video muted playsinline></video>
      <span class="mv-audio">${on ? 'AUDIO' : 'MUTED'}</span>
      <button class="icon-btn mv-close" data-close="${i}" title="Remove" aria-label="Remove from multiview">${icons.close}</button>
      <div class="jtv-umd"><i class="led live"></i>${c && c.logo ? `<img src="${esc(c.logo)}" referrerpolicy="no-referrer" alt="">` : ''}
        <span class="nm">${esc(c ? c.name : m.id)}</span><span class="mv-bug" data-bug="${esc(m.id)}" data-idle="LIVE">LIVE</span></div>
    </div>`;
  }).join('');

  if (state.mv.length < 4) {
    tiles += `<button class="mv-tile mv-add" id="mv-add"><span class="plus">+</span>Add a stream</button>`;
  }

  content.innerHTML = `<div class="jtv-mv-wrap">
    <div class="jtv-viewhead"><h2 class="jtv-h2">Multiview</h2>
      <span class="jtv-k">${state.mv.length}/4 streams · select a tile to hear its audio</span>
      ${state.mv.length < 4 && !(state.status && state.status.scoresEnabled === false) ? `<button class="btn" id="mv-fill">${icons.grid} Fill with the hottest games</button>` : ''}</div>
    <div class="jtv-mv-grid n${n}">${tiles}</div></div>`;

  // attach streams
  state.mv.forEach((m, i) => {
    const tile = $(`[data-tile="${i}"]`, content);
    const video = $('video', tile);
    if (m.video !== video) {
      // The tile's <video> is recreated on every render — destroy the old hls
      // instance first or it keeps pulling segments forever in the background,
      // exhausting the browser's per-origin connection limit.
      try { m.hls && m.hls.destroy(); } catch (e) {}
      m.video = video;
      const c = chanById(m.id);
      if (c) {
        const src = c.streamUrl;
        attachStream(video, src).then(h => {
          if (!state.mv.includes(m) || !video.isConnected) { h.destroy(); return; }
          h.onerror = () => {
            if (!tile.isConnected) return;
            tile.classList.add('mv-failed');
            if (!$('.mv-err', tile)) {
              tile.insertAdjacentHTML('beforeend', '<div class="mv-err"><span class="jtv-k live">No signal</span><span>Stream failed — select to retry</span></div>');
            }
          };
          m.hls = h; video.muted = i !== state.mvFocus; video.play().catch(() => {});
        }).catch(() => toast('Failed to load stream', true));
      }
    }
    const pick = () => {
      if (tile.classList.contains('mv-failed')) {
        try { m.hls && m.hls.destroy(); } catch (e) {}
        m.hls = null; m.video = null;
        render();
        return;
      }
      state.mvFocus = i; syncMvAudio();
      $$('.mv-tile', content).forEach((t, j) => t.classList.toggle('focused', j === i));
      $$('.mv-audio', content).forEach((a, j) => a.textContent = j === i ? 'AUDIO' : 'MUTED');
    };
    tile.onclick = pick;
    tile.onkeydown = (e) => { if (e.key === 'Enter' && e.target === tile) pick(); };
  });

  $$('[data-close]', content).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const i = +b.dataset.close;
    const m = state.mv[i];
    if (m && m.hls) m.hls.destroy();
    state.mv.splice(i, 1);
    if (state.mvFocus >= state.mv.length) state.mvFocus = state.mv.length - 1;
    render();
  });

  const fill = $('#mv-fill', content);
  if (fill) fill.onclick = fillMultiview;
  const add = $('#mv-add', content);
  if (add) add.onclick = () => openPicker((id) => addToMultiview(id));
}

function syncMvAudio() {
  state.mv.forEach((m, i) => { if (m.video) m.video.muted = i !== state.mvFocus; });
}

function openPicker(cb) {
  const veil = el(`<div class="jtv-modal-veil"><div class="jtv-modal" role="dialog" aria-label="Add a stream">
    <div class="m-head"><h3>Add a stream</h3><button class="icon-btn" id="m-x" aria-label="Close">${icons.close}</button></div>
    <input class="m-search" id="m-q" type="search" placeholder="Search channels" aria-label="Search channels">
    <div class="m-body" id="m-list"></div></div></div>`);
  document.body.appendChild(veil);

  const renderList = (q) => {
    const inMv = new Set(state.mv.map(m => m.id));
    const list = state.channels
      .filter(c => !inMv.has(c.id))
      .filter(c => !q || c.name.toLowerCase().includes(q));
    $('#m-list', veil).innerHTML = list.map(c =>
      `<div class="m-row" data-id="${esc(c.id)}" tabindex="0">
        ${chanMark(c)}
        <div class="r-text"><div class="r-name">${esc(c.name)}</div><div class="r-sub">${c.now ? esc(c.now.title) : esc(c.group || '')}</div></div>
      </div>`).join('') || '<div class="m-none">No matches</div>';
    $$('.m-row', veil).forEach(r => {
      r.onclick = () => { veil.remove(); cb(r.dataset.id); };
      r.onkeydown = (e) => { if (e.key === 'Enter') r.onclick(); };
    });
  };

  renderList('');
  $('#m-q', veil).oninput = (e) => renderList(e.target.value.trim().toLowerCase());
  $('#m-x', veil).onclick = () => veil.remove();
  veil.onclick = (e) => { if (e.target === veil) veil.remove(); };
  setTimeout(() => $('#m-q', veil).focus(), 50);
}

/* ---------------- player ---------------- */

async function play(id) {
  const c = chanById(id);
  if (!c) return;
  if (state.tv) { playOnTv(id); return; }

  closePlayer();
  if (state.settings.lastChannel !== id) { state.settings.lastChannel = id; saveSettings(); }

  const overlay = el(`<div class="jtv-player" id="jtv-player">
    <video autoplay playsinline></video>
    <div class="jp-top">
      <button class="jp-back" id="jp-back" title="Close" aria-label="Close player">${icons.back}</button>
      <div class="jp-chan">
        ${c.logo ? `<img src="${esc(c.logo)}" referrerpolicy="no-referrer" alt="">` : ''}
        <div><div class="n">${esc(c.name)} <span class="jtv-tag live">LIVE</span></div>
          <div class="g jtv-k">${esc([c.group || 'Live', c.source].filter(Boolean).join(' · '))}</div></div>
      </div>
      <div class="jp-bug" data-bug="${esc(id)}"></div>
    </div>
    <div class="jp-bottom">
      <div class="jp-info" id="jp-info"></div>
      <div class="jp-actions">
        <button class="btn" id="jp-mv">${icons.grid} Add to multiview</button>
        <button class="btn" id="jp-mute">Mute</button>
        <button class="btn" id="jp-full" title="Fullscreen (F)" aria-label="Fullscreen">${icons.full}</button>
      </div>
    </div>
  </div>`);
  document.body.appendChild(overlay);

  const video = $('video', overlay);
  const player = { id, hls: null, video, overlay, timer: null };
  state.player = player;
  syncImmersive();

  // Now/next comes from the 60s channel refresh — repaint every second so the
  // remaining-time readout counts down and rolls over to the next programme.
  const paintInfo = () => {
    const cc = chanById(id) || c, g = gameForChannel(id);
    $('#jp-info', overlay).innerHTML =
      `<div class="jp-title">${cc.now ? esc(cc.now.title || 'Untitled') : g ? esc(g.away.name + ' at ' + g.home.name) : 'Live'}</div>`
      + (g && (g.downDistance || g.lastPlay) ? `<div class="jp-play">${g.downDistance ? `<b>${esc(g.downDistance)}</b>` : ''}${esc(g.lastPlay || '')}</div>` : '')
      + progReadout(cc.now, cc.next, new Date(), true);
  };
  paintInfo();
  updateBugs();   // score bug now, not at the next scores poll
  player.timer = setInterval(paintInfo, 1000);

  let hideTimer;
  const poke = () => {
    overlay.classList.remove('hide-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => overlay.classList.add('hide-ui'), 3200);
  };
  overlay.addEventListener('mousemove', poke);
  overlay.addEventListener('click', poke);
  poke();

  $('#jp-back', overlay).onclick = closePlayer;
  $('#jp-mute', overlay).onclick = (e) => { video.muted = !video.muted; e.target.closest('button').textContent = video.muted ? 'Unmute' : 'Mute'; };
  $('#jp-mv', overlay).onclick = () => { addToMultiview(id); };
  $('#jp-full', overlay).onclick = () => toggleFullscreen(overlay, video);
  video.ondblclick = () => toggleFullscreen(overlay, video);

  const showErr = (msg) => {
    if (state.player !== player) return;
    overlay.querySelector('.jp-error')?.remove();
    overlay.insertAdjacentHTML('beforeend',
      `<div class="jp-error"><span class="jtv-k live">No signal</span>
       <div class="ttl">Stream unavailable</div>
       <div class="msg">${esc(msg || 'The stream could not be loaded.')}</div>
       <div class="jp-err-btns"><button class="btn btn-primary" id="jp-retry">${icons.refresh} Retry</button>
       <button class="btn btn-ghost" id="jp-close-err">Close</button></div></div>`);
    const r = $('#jp-retry', overlay);
    if (r) r.onclick = () => play(id);
    const cl = $('#jp-close-err', overlay);
    if (cl) cl.onclick = closePlayer;
  };

  try {
    const h = await attachStream(video, c.streamUrl);
    if (state.player !== player) { h.destroy(); return; } // closed while loading
    h.onerror = (e) => showErr(e.message);
    player.hls = h;
    // Unmuted autoplay can be blocked on gesture-less entry (?play= deep link).
    // Fall back to muted autoplay — always allowed — rather than a dead frame.
    await video.play().catch(async () => {
      video.muted = true;
      try { await video.play(); } catch (_) {}
    });
  } catch (e) {
    showErr(e.message || 'The stream could not be loaded.');
  }
}

function closePlayer() {
  const p = state.player;
  if (!p) return;
  clearInterval(p.timer);
  try { p.hls && p.hls.destroy(); } catch (e) {}
  try { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } catch (e) {}
  if (fsElement() === p.overlay) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
  p.overlay.remove();
  state.player = null;
  syncImmersive();
}

/* ---------------- settings view ---------------- */

async function renderSettings(content) {
  const isAdmin = state.status && state.status.isAdmin;
  content.innerHTML = `<div class="jtv-view"><div class="jtv-settings">
    <div class="jtv-viewhead"><h2 class="jtv-h2">Settings</h2></div>

    <div class="set-card">
      <h3>Your preferences</h3>
      <div class="hint">Saved to your Jellyfin profile — not shared with other users.</div>
      <div class="f-row"><label>Default view</label>
        <select id="set-default-view">
          <option value="">Games</option><option value="live">Channels</option><option value="guide">Guide</option><option value="multi">Multiview</option>
        </select></div>
      <div class="f-row"><label class="check"><button class="toggle${alertsOn() ? ' on' : ''}" id="set-alerts" role="switch" aria-checked="${alertsOn()}"></button>
        Switch alerts — while you're watching, tell me when another game on my channels turns hot</label></div>
      <div class="f-row"><label class="check"><button class="toggle${spoilerFree() ? ' on' : ''}" id="set-hide" role="switch" aria-checked="${spoilerFree()}"></button>
        Hide scores — no scores, last plays, score bugs or alerts anywhere</label></div>
      <div class="f-row"><label>Favorites</label>
        <div class="set-note">${favorites().size} channel(s) favorited — they appear under the Favorites filter on the Live tab.</div></div>
      <div class="f-row"><label>Fantasy integration</label>
        <div class="set-note">Coming soon — per-profile fantasy league connections (Sleeper, ESPN, Yahoo) will live here.</div></div>
    </div>

    <div class="set-card">
      <h3>Tally on a TV</h3>
      <div class="hint">The TV app has the games board, the score bug, a game switcher and multiview, and updates itself. Send this link to anyone who watches here, or let them scan it: the page walks them through their kind of TV.</div>
      <div class="get-app">
        <img class="get-qr" src="${esc(env.url('JellyTV/Get/qr.svg'))}" alt="QR code for the install page" width="148" height="148">
        <div class="get-side">
          <a class="get-link" href="${esc(getUrl())}" target="_blank" rel="noopener">${esc(getUrl())}</a>
          <div class="get-actions">
            <button class="btn btn-ghost" id="get-copy">Copy link</button>
            ${navigator.share ? '<button class="btn btn-ghost" id="get-share">Share…</button>' : ''}
          </div>
        </div>
      </div>
      ${lgDevModeLine()}
    </div>

    <div id="jtv-dvr"></div>
    <div id="jtv-admin"></div>
    <div class="jtv-k set-build">Tally ${esc((state.status && (state.status.build || state.status.version)) || '')}</div>
  </div></div>`;

  $('#set-default-view', content).value = state.settings.defaultView || '';
  $('#set-default-view', content).onchange = (e) => { state.settings.defaultView = e.target.value || undefined; saveSettings(); toast('Saved'); };

  // flip in place — a full render() would refetch the admin config and drop unsaved source edits
  const flip = (sel, read, write) => { $(sel, content).onclick = (e) => {
    write(); saveSettings();
    e.currentTarget.classList.toggle('on', read()); e.currentTarget.setAttribute('aria-checked', read());
  }; };
  flip('#set-alerts', alertsOn, () => { state.settings.alerts = !alertsOn(); });
  flip('#set-hide', spoilerFree, () => { state.settings.hideScores = !spoilerFree(); });

  $('#get-copy', content).onclick = async () => {
    try { await navigator.clipboard.writeText(getUrl()); toast('Link copied'); } catch (e) { toast('Copy failed — long-press the link instead'); }
  };
  if ($('#get-share', content)) $('#get-share', content).onclick = () => {
    navigator.share({ title: 'Tally on your TV', text: 'Set up Tally on your TV (about three minutes):', url: getUrl() }).catch(() => {});
  };

  renderDvr($('#jtv-dvr', content), isAdmin, true);
  if (isAdmin) renderAdmin($('#jtv-admin', content), true);
}

// LG TVs installed with Tally for LG: this server keeps their Developer Mode on (LgDevModeService).
function lgDevModeLine() {
  const lg = state.status && state.status.lgDevMode;
  if (!lg || !lg.tvs) return '';
  const tvs = lg.tvs === 1 ? '1 TV' : lg.tvs + ' TVs';
  const when = lg.renewedAt ? ' · renewed ' + (new Date(lg.renewedAt).toDateString() === new Date().toDateString()
    ? fmtTime(lg.renewedAt) : fmtWhen(lg.renewedAt)) : ' · renewing…';
  const problem = lg.failing ? `<div class="set-note">Renewing failed for ${lg.failing === 1 ? '1 TV' : lg.failing + ' TVs'}${lg.lastError ? ': ' + esc(lg.lastError) : ''}. Open Developer Mode on the TV and check that it is on and signed in.</div>` : '';
  return `<div class="set-note" id="lg-devmode">LG Developer Mode kept on for ${esc(tvs + when)}</div>${problem}`;
}

// The install page as the server says friends should reach it (its configured public address, else this one).
function getUrl() { return (state.status && state.status.getUrl) || env.url('JellyTV/Get'); }

async function renderAdmin(container, fresh) {
  // Keep the working config in state.adminCfg — mutating then re-rendering
  // must NOT refetch from the server or unsaved changes get discarded.
  if (fresh || !state.adminCfg) {
    try {
      state.adminCfg = window.ApiClient && ApiClient.getPluginConfiguration
        ? await ApiClient.getPluginConfiguration(state.status.pluginId)
        : null;
    } catch (e) { state.adminCfg = null; }
    if (state.adminCfg && !state.adminCfg.Sources) state.adminCfg.Sources = [];
  }
  const cfg = state.adminCfg;

  const sources = (cfg && cfg.Sources) || [];
  const errors = (state.status && state.status.sourceErrors) || {};

  container.innerHTML = `
    <div class="set-card">
      <h3>Sources <span class="jtv-k">Admin</span></h3>
      <div class="hint">M3U playlists (with optional XMLTV EPG) and direct HLS streams. Changes apply to every Tally user.</div>
      <div id="src-list">
        ${sources.map((s, i) => `
          <div class="src-row">
            <button class="toggle${s.Enabled ? ' on' : ''}" data-toggle="${i}" title="Enable/disable" role="switch" aria-checked="${!!s.Enabled}" aria-label="Enable ${esc(s.Name || 'source')}"></button>
            <div class="s-text"><div class="s-name">${esc(s.Name || 'Source')}</div>
            <div class="s-meta">${esc((s.Kind === 2 || s.Kind === 'Web') ? 'Web page' : (s.Kind === 0 || s.Kind === 'M3u' ? 'M3U' : 'Direct'))} · ${esc((s.Kind === 2 || s.Kind === 'Web') ? (s.PageUrl || '') : (s.Kind === 0 || s.Kind === 'M3u' ? (s.PlaylistUrl || '') : (s.Streams || []).length + ' stream(s)'))}${s.Include ? ' · only: ' + esc(s.Include) : ''}</div>
            ${isWeb(s) ? `<div class="src-browser" data-browser>${browserLine()}</div>` : ''}
            ${errors[s.Name] && !(isWeb(s) && browserOwns(errors[s.Name])) ? `<div class="src-error">${esc(errors[s.Name])}</div>` : ''}</div>
            <button class="btn btn-danger" data-del="${i}">Remove</button>
          </div>`).join('')}
      </div>
      ${sources.length ? '' : '<div class="set-note" style="margin-bottom:16px">No sources configured yet.</div>'}
      <button class="btn btn-ghost" id="src-add">+ Add source</button>
      <div id="src-form"></div>
    </div>

    <div class="set-card">
      <h3>TV app install link <span class="jtv-k">Admin</span></h3>
      <div class="hint">The link and QR code above, and the address people type on their TV, are built from the address below. Set it to the one your friends use from outside your house.</div>
      <div class="f-row"><label for="set-public-url">Public server address — blank uses whatever address this page is open on</label>
        <input type="text" id="set-public-url" value="${esc(cfg ? cfg.PublicUrl || '' : '')}" placeholder="http://203.0.113.7:8096" autocapitalize="off" spellcheck="false"></div>
      <div class="f-row"><label for="set-dl-code">Downloader code — optional. Create one at aftv.news for <span class="mono">${esc(cfg ? cfg.TvAppUrl || '' : '')}</span> and people type five digits instead of an address</label>
        <input type="text" id="set-dl-code" value="${esc(cfg ? cfg.DownloaderCode || '' : '')}" placeholder="e.g. 12345" inputmode="numeric"></div>
    </div>

    <div class="set-card">
      <h3>Jellyfin web client <span class="jtv-k">Admin</span></h3>
      <div class="hint">For everyone who uses Jellyfin in a browser, not just admins. The plugin adds a few tags to the web page as it is served; no Jellyfin files are changed, and switching both off gives the stock web client back. Native TV and mobile apps are not affected. Save, then reload the browser tab to see a change.</div>
      <div class="f-row"><label class="check"><button class="toggle${cfg && cfg.WebLook !== false ? ' on' : ''}" id="set-weblook" role="switch" aria-checked="${!!(cfg && cfg.WebLook !== false)}"></button>
        Tally look for Jellyfin web — the Tally theme and name, and a Sports entry in the menu</label></div>
      <div class="f-row"><label class="check"><button class="toggle${cfg && cfg.ReplaceLiveTv !== false ? ' on' : ''}" id="set-takeover" role="switch" aria-checked="${!!(cfg && cfg.ReplaceLiveTv !== false)}"></button>
        Replace Jellyfin's Live TV page with Tally — the home screen card, the side menu, a bookmark</label></div>
    </div>

    <div class="set-card">
      <h3>Live scores <span class="jtv-k">Admin</span></h3>
      <div class="hint">Scores, last play and game situation come from ESPN's public scoreboard feed, fetched by this server only while someone has Tally open or a recording is scheduled. Turn it off and the server makes no third-party requests of its own (and cannot record games).</div>
      <div class="f-row"><label class="check"><button class="toggle${cfg && cfg.ScoresEnabled !== false ? ' on' : ''}" id="set-scores" role="switch" aria-checked="${!!(cfg && cfg.ScoresEnabled !== false)}"></button>
        Show the Games board, score bugs and switch alerts</label></div>
      <div class="f-row"><label class="check"><button class="toggle${cfg && cfg.LiveCardsEnabled !== false ? ' on' : ''}" id="set-livecards" role="switch" aria-checked="${!!(cfg && cfg.LiveCardsEnabled !== false)}"></button>
        Live cards for TV apps — redraw channel cards with the current score every 2 minutes while games are on, and keep channels numbered hottest-first (re-runs Jellyfin's guide refresh each time)</label></div>
      <div class="f-row"><label for="set-leagues">Leagues — comma-separated ESPN paths, blank for the defaults (NFL and MLB)</label>
        <input type="text" id="set-leagues" value="${esc(cfg ? cfg.ScoreLeagues || '' : '')}" placeholder="football/nfl, baseball/mlb"></div>
    </div>

    <div class="set-card">
      <h3>Refresh</h3>
      <div class="hint">Playlists & EPG are re-fetched periodically and whenever sources change.</div>
      <div class="f-row"><label>Refresh interval (minutes)</label>
        <input type="number" id="set-interval" min="1" max="720" value="${cfg ? cfg.RefreshIntervalMinutes : 30}"></div>
      <div class="set-actions">
        <button class="btn btn-primary" id="save-cfg">Save configuration</button>
        <button class="btn btn-ghost" id="force-refresh">${icons.refresh} Refresh now</button>
      </div>
      <div id="cfg-msg" class="set-msg" role="status"></div>
    </div>`;

  if (!cfg) { $('#cfg-msg', container).textContent = 'Could not load plugin configuration.'; return; }
  watchBrowser(container);

  $$('[data-toggle]', container).forEach(b => b.onclick = () => { const i = +b.dataset.toggle; cfg.Sources[i].Enabled = !cfg.Sources[i].Enabled; renderAdmin(container); });
  $$('[data-del]', container).forEach(b => b.onclick = () => { cfg.Sources.splice(+b.dataset.del, 1); renderAdmin(container); });

  // written through on every keystroke: the toggles below re-render this whole panel from cfg
  $('#set-public-url', container).oninput = (e) => { cfg.PublicUrl = e.target.value.trim().replace(/\/+$/, ''); };
  $('#set-dl-code', container).oninput = (e) => { cfg.DownloaderCode = e.target.value.trim(); };

  $('#set-weblook', container).onclick = () => { cfg.WebLook = cfg.WebLook === false; cfg.ScoreLeagues = $('#set-leagues', container).value; renderAdmin(container); };
  $('#set-takeover', container).onclick = () => { cfg.ReplaceLiveTv = cfg.ReplaceLiveTv === false; cfg.ScoreLeagues = $('#set-leagues', container).value; renderAdmin(container); };
  $('#set-livecards', container).onclick = () => { cfg.LiveCardsEnabled = cfg.LiveCardsEnabled === false; cfg.ScoreLeagues = $('#set-leagues', container).value; renderAdmin(container); };
  $('#set-scores', container).onclick = () => { cfg.ScoresEnabled = cfg.ScoresEnabled === false; cfg.ScoreLeagues = $('#set-leagues', container).value; renderAdmin(container); };

  $('#src-add', container).onclick = () => {
    $('#src-form', container).innerHTML = `
      <div class="set-sub">
        <div class="f-row"><label>Type</label>
          <select id="ns-kind"><option value="M3u">M3U playlist (+ optional XMLTV EPG)</option><option value="Web">Web page (auto-extract streams)</option><option value="Direct">Direct HLS stream(s)</option></select></div>
        <div class="f-row"><label>Name</label><input type="text" id="ns-name" placeholder="e.g. Sports"></div>
        <div id="ns-m3u">
          <div class="f-row"><label>Playlist URL (.m3u / .m3u8)</label><input type="text" id="ns-url" placeholder="https://…/playlist.m3u"></div>
          <div class="f-row"><label>EPG URL (optional, overrides url-tvg)</label><input type="text" id="ns-epg" placeholder="https://…/epg.xml or .xml.gz"></div>
        </div>
        <div id="ns-web" style="display:none">
          <div class="f-row"><label>Page URL — streams are auto-detected on the page and its embeds</label>
            <input type="text" id="ns-page" placeholder="https://example.com/live"></div>
          <div class="f-row"><label>Only include — leagues or groups, comma-separated (blank = everything)</label>
            <input type="text" id="ns-include" placeholder="NFL, MLB"></div>
          <div class="f-row"><label class="check">
            <input type="checkbox" id="ns-browser" checked>
            Headless-browser fallback — sniff streams that only appear after JavaScript runs</label></div>
        </div>
        <div id="ns-direct" style="display:none">
          <div class="f-row"><label>Streams — one per line: Name | .m3u8 URL | logo URL (opt) | group (opt)</label>
            <textarea id="ns-streams" placeholder="Sky Sports F1 | https://…/f1.m3u8 | https://…/logo.png | F1"></textarea></div>
          <div class="f-row"><label>EPG URL (optional)</label><input type="text" id="ns-depge" placeholder="https://…/epg.xml"></div>
        </div>
        <div class="f-row"><label>Upstream headers (optional, one per line: Header: value)</label>
          <textarea id="ns-headers" placeholder="Referer: https://example.com/\nUser-Agent: …"></textarea></div>
        <button class="btn btn-primary" id="ns-save">Add source</button>
      </div>`;

    $('#ns-kind', container).onchange = (e) => {
      const v = e.target.value;
      $('#ns-m3u', container).style.display = v === 'M3u' ? '' : 'none';
      $('#ns-web', container).style.display = v === 'Web' ? '' : 'none';
      $('#ns-direct', container).style.display = v === 'Direct' ? '' : 'none';
    };

    $('#ns-save', container).onclick = () => {
      const kind = $('#ns-kind', container).value;
      const headers = ($('#ns-headers', container).value || '').split('\n')
        .map(l => { const i = l.indexOf(':'); return i > 0 ? { Key: l.slice(0, i).trim(), Value: l.slice(i + 1).trim() } : null; })
        .filter(Boolean);

      const kindNum = { M3u: 0, Direct: 1, Web: 2 }[kind];
      const src = {
        Id: uuid(), Name: $('#ns-name', container).value.trim() || 'Source',
        Kind: kindNum, Enabled: true, Headers: headers,
        PlaylistUrl: '', EpgUrl: '', PageUrl: '', UseBrowserFallback: true, MaxPages: 12, Include: '', Streams: []
      };

      if (kind === 'M3u') {
        src.PlaylistUrl = $('#ns-url', container).value.trim();
        src.EpgUrl = $('#ns-epg', container).value.trim();
        if (!src.PlaylistUrl) { toast('Playlist URL required', true); return; }
      } else if (kind === 'Web') {
        src.PageUrl = $('#ns-page', container).value.trim();
        src.UseBrowserFallback = $('#ns-browser', container).checked;
        src.Include = $('#ns-include', container).value.trim();
        if (!src.PageUrl) { toast('Page URL required', true); return; }
      } else {
        src.EpgUrl = $('#ns-depge', container).value.trim();
        src.Streams = ($('#ns-streams', container).value || '').split('\n')
          .map(l => l.split('|').map(x => x.trim()))
          .filter(p => p.length >= 2 && p[1])
          .map(p => ({ Name: p[0] || 'Stream', Url: p[1], LogoUrl: p[2] || '', Group: p[3] || 'Live', TvgId: '', Headers: [] }));
        if (!src.Streams.length) { toast('Add at least one stream', true); return; }
      }

      cfg.Sources.push(src);
      renderAdmin(container);
      toast('Source added — remember to Save configuration');
    };
  };

  $('#save-cfg', container).onclick = async () => {
    cfg.RefreshIntervalMinutes = clamp(+$('#set-interval', container).value || 30, 1, 720);
    cfg.ScoreLeagues = $('#set-leagues', container).value.trim();
    try {
      await ApiClient.updatePluginConfiguration(state.status.pluginId, cfg);
      $('#cfg-msg', container).textContent = 'Saved — scanning sources…';
      // Scanning can take a while (browser fallback) — poll until channels/errors settle.
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        await loadStatus(); await loadChannels();
        const errs = (state.status && state.status.sourceErrors) || {};
        const pending = Object.keys(errs).length === 0 && i < 3;
        if (!pending || Object.keys(errs).length) break;
      }
      const errs = (state.status && state.status.sourceErrors) || {};
      const errText = Object.entries(errs).filter(([, v]) => !browserOwns(v)).map(([k, v]) => `${k}: ${v}`).join(' · ');
      renderAdmin(container); // re-render list so per-source errors show inline
      const msg = $('#cfg-msg', container); // element was recreated by renderAdmin
      if (msg) msg.innerHTML = errText
        ? `<span class="bad">${esc(errText)}</span>`
        : `<span class="ok">${state.channels.length} channels loaded</span>`
          + (browserState().state === 'preparing' ? ' · web page sources follow once the browser is ready' : '');
    } catch (e) {
      $('#cfg-msg', container).textContent = 'Save failed: ' + e.message;
    }
  };

  $('#force-refresh', container).onclick = async () => {
    try {
      $('#cfg-msg', container).textContent = 'Scanning sources…';
      const r = await api('Refresh', { method: 'POST' });
      await loadStatus(); await loadChannels();
      const errs = (r.errors) || (state.status && state.status.sourceErrors) || {};
      const errText = Object.entries(errs).filter(([, v]) => !browserOwns(v)).map(([k, v]) => `${k}: ${v}`).join(' · ');
      renderAdmin(container);
      const msg = $('#cfg-msg', container); // recreated by renderAdmin
      if (msg) msg.innerHTML = errText
        ? `<span class="bad">${esc(errText)}</span>`
        : `<span class="ok">${r.channelCount} channels</span>`
          + (browserState().state === 'preparing' ? ' · web page sources follow once the browser is ready' : '');
      toast(errText ? 'Done with errors — see below' : 'Refreshed — ' + r.channelCount + ' channels');
    } catch (e) { toast('Refresh failed: ' + e.message, true); }
  };
}

/* ---------------- DVR ---------------- */

// Recordings: what is recording, scheduled, done and failed (everyone who may record), a way to record a game or a
// team, and for admins the folder, space and limits. Refreshed every 10 s while it is on screen.
const GB = 1024 * 1024 * 1024;
const fmtBytes = (b) => b == null ? '?' : b >= 10 * GB ? Math.round(b / GB) + ' GB' : b >= GB ? (b / GB).toFixed(1).replace(/\.0$/, '') + ' GB' : Math.round(b / 1048576) + ' MB';
const fmtWhen = (d) => new Date(d).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DVR_STATE = { scheduled: 'Scheduled', waiting: 'Waiting', recording: 'Recording', finishing: 'Finishing', done: 'Recorded', failed: 'Failed', canceled: 'Canceled' };

async function dvrApi(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ Authorization: 'MediaBrowser Token="' + env.token() + '"' }, opts.headers);
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(env.url('JellyTV/' + path), Object.assign({}, opts, { headers }));
  if (r.status === 204) return null;
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || 'HTTP ' + r.status);
  return body;
}

function dvrJobRow(j, canManage) {
  const live = j.state === 'recording';
  const bits = [j.game.league, fmtWhen(j.game.start), DVR_STATE[j.state] || j.state];
  if (live || j.state === 'finishing') bits.push(fmtSpan((j.seconds || 0) * 1000) + ' · ' + fmtBytes(j.bytes) + (j.channelName ? ' · ' + j.channelName : ''));
  if (j.state === 'done') bits.push(fmtSpan((j.seconds || 0) * 1000) + ' · ' + fmtBytes(j.fileBytes) + (j.itemId ? ' · in the library' : ''));
  const btns = [];
  if (live && j.startOverPath) btns.push(`<button class="btn btn-ghost" data-dvr-watch="${esc(j.id)}">Watch from start</button>`);
  if (canManage && ['scheduled', 'waiting', 'recording'].includes(j.state)) btns.push(`<button class="btn btn-danger" data-dvr-cancel="${esc(j.id)}">${live ? 'Stop' : 'Cancel'}</button>`);
  if (canManage && j.state === 'done') btns.push(`<button class="btn btn-danger" data-dvr-delete="${esc(j.id)}">Delete</button>`);
  return `<div class="src-row">
    ${live ? '<i class="led live" title="Recording"></i>' : ''}
    <div class="s-text"><div class="s-name">${esc(j.title)}</div>
      <div class="s-meta">${esc(bits.join(' · '))}</div>
      ${j.reason ? `<div class="${j.state === 'failed' ? 'src-error' : 'src-browser'}">${esc(j.reason)}</div>` : ''}</div>
    ${btns.join('')}
  </div>`;
}

async function renderDvr(container, isAdmin, fresh) {
  clearTimeout(dvrTimer);
  if (!container || !document.contains(container)) return;
  let list, admin = null, games = state.games || [];
  try {
    list = await dvrApi('Client/v1/recordings');
    if (isAdmin && (fresh || !state.dvrAdmin)) state.dvrAdmin = await dvrApi('Recordings/Settings');
    admin = isAdmin ? state.dvrAdmin : null;
    if (list.canManage && fresh && state.status && state.status.scoresEnabled !== false) { await loadScores().catch(() => {}); games = state.games || []; }
  } catch (e) {
    container.innerHTML = `<div class="set-card"><h3>Recordings</h3><div class="set-note">${esc(e.message)}</div></div>`;
    return;
  }
  if (!document.contains(container)) return;
  const jobs = list.jobs || [];
  const active = jobs.filter(j => ['recording', 'finishing', 'waiting', 'scheduled'].includes(j.state));
  const done = jobs.filter(j => j.state === 'done');
  const failed = jobs.filter(j => j.state === 'failed' || j.state === 'canceled').slice(0, 8);
  const recordable = games.filter(g => g.state !== 'post');
  const teams = [];
  const seen = new Set();
  games.forEach(g => [g.away, g.home].forEach(t => {
    const k = g.league + ':' + t.id;
    if (t.id && !seen.has(k)) { seen.add(k); teams.push({ id: t.id, name: t.name || t.shortName, league: g.league }); }
  }));
  teams.sort((a, b) => a.name.localeCompare(b.name));
  const s = admin && admin.settings;

  container.innerHTML = `
    <div class="set-card">
      <h3>Recordings</h3>
      <div class="hint">The server records games in the background: it starts when the game does (up to 15 minutes early once a channel carries it), follows the channel through stream switches, stops a few minutes after the final and files the game in your library. Recordings are shared by everyone on this server.</div>
      ${list.canManage ? `
        <div class="f-row"><label for="dvr-game">Record a game</label>
          <div class="set-actions"><select id="dvr-game" style="flex:1">${recordable.length ? recordable.map(g => `<option value="${esc(g.id)}">${esc(g.league + ' · ' + g.away.name + ' at ' + g.home.name + ' · ' + (g.state === 'in' ? 'live now' : fmtWhen(g.start)))}</option>`).join('') : '<option value="">No upcoming games on the board</option>'}</select>
          <button class="btn btn-primary" id="dvr-rec-game"${recordable.length ? '' : ' disabled'}>Record</button></div></div>
        <div class="f-row"><label for="dvr-team">Record every game of a team</label>
          <div class="set-actions"><select id="dvr-team" style="flex:1">${teams.length ? teams.map(t => `<option value="${esc(t.league + '|' + t.id)}">${esc(t.name + ' (' + t.league + ')')}</option>`).join('') : '<option value="">No teams on the board</option>'}</select>
          <input type="number" id="dvr-keep" min="0" max="999" value="0" title="Keep the last N games (0 = all)" style="max-width:110px">
          <button class="btn btn-ghost" id="dvr-rec-team"${teams.length ? '' : ' disabled'}>Record team</button></div>
          <div class="set-note">The number keeps only the last N recorded games of the team (0 keeps them all).</div></div>`
        : `<div class="set-note" style="margin-bottom:16px">${esc(list.reason || '')}</div>`}
      <div id="dvr-msg" class="set-msg" role="status"></div>
      <div id="src-list">
        ${active.map(j => dvrJobRow(j, list.canManage)).join('') || '<div class="set-note" style="padding:12px 0">Nothing scheduled.</div>'}
      </div>
      ${(list.rules || []).filter(r => r.kind === 'team').length ? `<div class="f-row"><label>Team rules</label>${list.rules.filter(r => r.kind === 'team').map(r => `
        <div class="src-row"><div class="s-text"><div class="s-name">${esc(r.title)}</div>
          <div class="s-meta">${esc((r.leaguePath || 'any league') + (r.keepLast ? ' · keeps the last ' + r.keepLast : ' · keeps all') + ' · by ' + (r.createdByName || '?'))}</div></div>
          ${list.canManage ? `<button class="btn btn-danger" data-dvr-rule="${esc(r.id)}">Remove</button>` : ''}</div>`).join('')}</div>` : ''}
      ${done.length ? `<div class="f-row"><label>Recorded</label><div>${done.slice(0, 20).map(j => dvrJobRow(j, list.canManage)).join('')}</div></div>` : ''}
      ${failed.length ? `<div class="f-row"><label>Did not record</label><div>${failed.map(j => dvrJobRow(j, list.canManage)).join('')}</div></div>` : ''}
    </div>
    ${s ? `
    <div class="set-card">
      <h3>Recording settings <span class="jtv-k">Admin</span></h3>
      <div class="hint">Where recordings go and how much of the drive they may use. A recording only starts when its estimated size (the stream's bitrate times a typical game) still leaves the reserve free, and stops, keeping what it has, if the drive falls below the reserve.</div>
      <div class="f-row"><label for="dvr-folder">Recordings folder, blank for the default (${esc(admin.defaultFolder)})</label>
        <div class="set-actions"><input type="text" id="dvr-folder" style="flex:1" value="${esc(s.folder || '')}" placeholder="${esc(admin.defaultFolder)}" autocapitalize="off" spellcheck="false">
        <button class="btn btn-ghost" id="dvr-check">Check</button></div>
        <div class="set-note" id="dvr-space">${esc(admin.folder)}: ${admin.freeBytes != null ? esc(fmtBytes(admin.freeBytes)) + ' free of ' + esc(fmtBytes(admin.totalBytes)) : 'free space unknown'} · recordings use ${esc(fmtBytes(admin.usedBytes))}</div></div>
      <div class="f-row"><label for="dvr-reserve">Keep this much free (GB)</label><input type="number" id="dvr-reserve" min="0" step="0.5" value="${+(s.reserveBytes / GB).toFixed(2)}"></div>
      <div class="f-row"><label for="dvr-conc">Recordings at the same time</label><input type="number" id="dvr-conc" min="1" max="20" value="${s.maxConcurrent}"></div>
      <div class="f-row"><label for="dvr-post">Keep recording after the final (minutes)</label><input type="number" id="dvr-post" min="0" max="120" value="${s.postRollMinutes}"></div>
      <div class="f-row"><label for="dvr-max">Longest recording (hours)</label><input type="number" id="dvr-max" min="0.25" max="24" step="0.25" value="${s.maxHours}"></div>
      <div class="f-row"><label for="dvr-days">Delete recordings after (days, 0 = never)</label><input type="number" id="dvr-days" min="0" max="3650" value="${s.deleteAfterDays}"></div>
      <div class="f-row"><label>Library</label>
        ${admin.library ? `<div class="set-note">Recordings appear in the Jellyfin library "${esc(admin.library)}".</div>`
          : `<div class="set-note">No Jellyfin library includes the recordings folder yet, so finished recordings are only files on the drive.</div>
             <div><button class="btn btn-ghost" id="dvr-lib">Create a Sports Recordings library</button></div>`}</div>
      <div class="set-actions"><button class="btn btn-primary" id="dvr-save">Save recording settings</button></div>
      <div id="dvr-set-msg" class="set-msg" role="status"></div>
    </div>` : ''}`;

  const msg = (text, bad) => { const m = $('#dvr-msg', container); if (m) m.innerHTML = `<span class="${bad ? 'bad' : 'ok'}">${esc(text)}</span>`; };
  const again = () => renderDvr(container, isAdmin, false);
  const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); again(); } catch (e) { msg(e.message, true); } };

  if ($('#dvr-rec-game', container)) $('#dvr-rec-game', container).onclick = () => act(() => dvrApi('Client/v1/recordings', { method: 'POST', body: { gameId: $('#dvr-game', container).value } }), 'Recording scheduled');
  if ($('#dvr-rec-team', container)) $('#dvr-rec-team', container).onclick = () => act(() => {
    const [league, id] = $('#dvr-team', container).value.split('|');
    return dvrApi('Client/v1/recordings', { method: 'POST', body: { teamId: id, league, keepLast: +$('#dvr-keep', container).value || 0 } });
  }, 'Team rule added');
  $$('[data-dvr-cancel]', container).forEach(b => b.onclick = () => act(() => dvrApi('Client/v1/recordings/jobs/' + b.dataset.dvrCancel, { method: 'DELETE' }), 'Canceled'));
  $$('[data-dvr-delete]', container).forEach(b => b.onclick = () => { if (confirm('Delete this recording and its file?')) act(() => dvrApi('Client/v1/recordings/jobs/' + b.dataset.dvrDelete + '/recording', { method: 'DELETE' }), 'Deleted'); });
  $$('[data-dvr-rule]', container).forEach(b => b.onclick = () => act(() => dvrApi('Client/v1/recordings/rules/' + b.dataset.dvrRule, { method: 'DELETE' }), 'Rule removed'));
  $$('[data-dvr-watch]', container).forEach(b => b.onclick = () => { const j = jobs.find(x => x.id === b.dataset.dvrWatch); if (j) playRecording(j); });

  if (s) {
    const setMsg = (text, bad) => { const m = $('#dvr-set-msg', container); if (m) m.innerHTML = `<span class="${bad ? 'bad' : 'ok'}">${esc(text)}</span>`; };
    $('#dvr-check', container).onclick = async () => {
      try {
        const r = await dvrApi('Recordings/Folder?path=' + encodeURIComponent($('#dvr-folder', container).value.trim()));
        $('#dvr-space', container).innerHTML = r.ok ? `${esc(r.folder)}: ${esc(fmtBytes(r.freeBytes))} free of ${esc(fmtBytes(r.totalBytes))}` : `<span class="bad">${esc(r.error)}</span>`;
      } catch (e) { setMsg(e.message, true); }
    };
    $('#dvr-save', container).onclick = async () => {
      try {
        state.dvrAdmin = await dvrApi('Recordings/Settings', { method: 'POST', body: {
          folder: $('#dvr-folder', container).value.trim(),
          reserveBytes: Math.round((+$('#dvr-reserve', container).value || 0) * GB),
          maxConcurrent: +$('#dvr-conc', container).value || 3,
          postRollMinutes: +$('#dvr-post', container).value || 0,
          maxHours: +$('#dvr-max', container).value || 6,
          deleteAfterDays: +$('#dvr-days', container).value || 0
        } });
        toast('Recording settings saved');
        again();
      } catch (e) { setMsg(e.message, true); }
    };
    if ($('#dvr-lib', container)) $('#dvr-lib', container).onclick = async () => {
      try {
        const r = await dvrApi('Recordings/Library', { method: 'POST' });
        toast('Library "' + r.library + '" ' + (r.created ? 'created' : 'already covers the folder'));
        renderDvr(container, isAdmin, true);
      } catch (e) { setMsg(e.message, true); }
    };
  }

  // keep the list moving while it is on screen (not while someone is typing in the settings)
  dvrTimer = setTimeout(() => {
    if (!document.contains(container)) return;
    const typing = document.activeElement && container.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (typing) { dvrTimer = setTimeout(() => again(), 10e3); return; }
    again();
  }, active.length ? 10e3 : 30e3);
}

/* A recording in progress from its first minute: the server's growing (EVENT) playlist, seekable, with the
   browser's own controls. The finished recording is a normal library item and plays in Jellyfin's player. */
async function playRecording(job) {
  closePlayer();
  const overlay = el(`<div class="jtv-player" id="jtv-player">
    <video autoplay playsinline controls></video>
    <div class="jp-top">
      <button class="jp-back" id="jp-back" title="Close" aria-label="Close player">${icons.back}</button>
      <div class="jp-chan"><div><div class="n">${esc(job.title)} <span class="jtv-tag live">REC</span></div>
        <div class="g jtv-k">From the start · still recording</div></div></div>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  const video = $('video', overlay);
  const player = { id: null, hls: null, video, overlay, timer: null };
  state.player = player;
  syncImmersive();
  $('#jp-back', overlay).onclick = closePlayer;
  try {
    const h = await attachStream(video, job.startOverPath, { startPosition: 0, liveMaxLatencyDurationCount: Infinity });
    if (state.player !== player) { h.destroy(); return; }
    player.hls = h;
    await video.play().catch(async () => { video.muted = true; try { await video.play(); } catch (_) {} });
  } catch (e) {
    toast('The recording could not be played: ' + e.message, true);
  }
}

/* The headless browser web page sources need is set up on first use (a one-time download that can take minutes):
   its state shows under every web page source, and the page follows it until it settles. */
const isWeb = (s) => s.Kind === 2 || s.Kind === 'Web';
const browserState = () => (state.status && state.status.browser) || { state: 'idle' };
// the source error that only repeats the browser's own state is shown once, as the browser line
const browserOwns = (err) => { const b = browserState(); return (b.state === 'preparing' || b.state === 'failed') && (err === b.message || /^Preparing the browser/.test(err)); };

function browserLine() {
  const b = browserState();
  if (b.state === 'preparing') return `<span class="busy">${esc(b.message || 'Preparing the browser…')}</span>`;
  if (b.state === 'ready') return `<span class="ok">Browser ready</span>${b.browser ? ' · ' + esc(b.browser) : ''}`;
  if (b.state === 'failed') return `<span class="bad">${esc(b.message || 'The browser could not be set up')}</span>`;
  return '';
}

let browserTimer = null;
function watchBrowser(container) {
  clearTimeout(browserTimer);
  if (browserState().state !== 'preparing') return;
  browserTimer = setTimeout(async () => {
    if (!document.contains(container)) return;
    try { await loadStatus(); } catch (e) { /* keep polling */ }
    if (browserState().state === 'preparing') {
      $$('[data-browser]', container).forEach(n => { n.innerHTML = browserLine(); });
      watchBrowser(container);
    } else {
      // settled: the server rescans web page sources by itself once the browser is ready
      if (browserState().state === 'ready') await new Promise(r => setTimeout(r, 1500));
      try { await loadChannels(); } catch (e) { /* ignore */ }
      $$('[data-browser]', container).forEach(n => { n.innerHTML = browserLine(); });
    }
  }, 3000);
}

/* ---------------- keyboard ---------------- */

const onKeydown = (e) => {
  if (!root || !document.contains(root)) return;
  if (e.key === 'Escape') {
    const veil = $('.jtv-modal-veil');
    if (veil) { veil.remove(); return; }
    if (state.player) { closePlayer(); return; }
  }
  if (state.player) {
    if (e.key === 'm' || e.key === 'M') { const v = state.player.video; v.muted = !v.muted; }
    if (e.key === 'f' || e.key === 'F') toggleFullscreen(state.player.overlay, state.player.video);
  }
};

/* ---------------- boot ---------------- */

async function boot() {
  // the Live TV takeover (inject.js) names its own mount point; the admin plugin page is found by id
  root = window.__jtvMount || document.getElementById('jellytv-app');
  window.__jtvMount = null;
  if (!root || root.dataset.jtvBooted) return;
  root.dataset.jtvBooted = '1';
  window.__jtvLoaded = true;

  document.addEventListener('keydown', onKeydown);

  // Torn down by the jellyfin-web view controller on 'viewdestroy'
  window.__jtvCleanup = () => {
    document.removeEventListener('keydown', onKeydown);
    clearInterval(clockTimer);
    clearInterval(refreshTimer);
    clearInterval(scoreTimer);
    clearTimeout(browserTimer);
    clearTimeout(dvrTimer);
    setImmersive(false);
    $$('.jtv-alert').forEach(n => n.remove());
    closePlayer();
    (state.mv || []).forEach(m => { try { m.hls && m.hls.destroy(); } catch (e) {} });
    state.mv = [];
    const veil = $('.jtv-modal-veil');
    if (veil) veil.remove();
  };

  root.innerHTML = '<div class="jtv-shell"><div class="jtv-boot"><div class="jtv-logo">TALLY</div><div class="jtv-progress jtv-boot-bar"><div></div></div></div></div>';

  try {
    await loadStatus();
    if (state.status && state.status.isAdmin === false && state.status.allowNonAdmin === false) {
      root.innerHTML = '<div class="jtv-shell"><div class="jtv-empty full"><span class="jtv-k">Restricted</span><div>Tally is limited to administrators.</div></div></div>';
      return;
    }
    await Promise.all([loadChannels(), loadSettings()]);

    shell();
    const q = new URLSearchParams(location.search);
    const scoresOn = state.status.scoresEnabled !== false;
    const home = scoresOn ? 'games' : 'live';
    state.view = q.get('view') || (state.settings && state.settings.defaultView) || home;
    if (!['games', 'guide', 'live', 'multi', 'settings'].includes(state.view) || (state.view === 'games' && !scoresOn)) state.view = home;
    if (q.get('mv')) {
      state.mv = q.get('mv').split(',').filter(id => chanById(id)).slice(0, 4).map(id => ({ id, hls: null, video: null }));
      if (state.mv.length) { state.view = 'multi'; state.mvFocus = 0; }
    }
    render();
    if (q.get('play') && chanById(q.get('play'))) play(q.get('play'));

    loadGuide().then(() => { if (state.view === 'guide') render(); }).catch(() => {});

    // Scores: every 15s while they're on screen (board, player bug, multiview bugs), otherwise
    // once a minute — enough to keep switch alerts honest. Nothing while the tab is hidden.
    const pollScores = async (force) => {
      if (!scoresOn || document.hidden) return;
      const watching = state.view === 'games' || state.player || state.tv || (state.view === 'multi' && state.mv.length);
      if (!force && !watching && Date.now() - state.scoresAt < 60e3) return;
      try {
        await loadScores();
        state.scoresErr = false;
      } catch (e) { state.scoresErr = true; }
      if (state.view === 'games' && !state.player) render(); else updateBugs();
      autoDirect();
    };
    restoreTv();
    pollScores(true);
    scoreTimer = setInterval(pollScores, 15e3);

    // periodic refresh of channels/now-next
    refreshTimer = setInterval(async () => {
      try {
        await loadChannels();
        await loadGuide().catch(() => {});
        if (state.view === 'guide' || state.view === 'live') render();
      } catch (e) {}
    }, 60e3);
  } catch (e) {
    root.innerHTML = `<div class="jtv-shell"><div class="jtv-empty full">
      <span class="jtv-k live">Error</span><div>Tally failed to start.</div><div class="sub">${esc(e.message)}</div></div></div>`;
  }
}

boot();
})();
