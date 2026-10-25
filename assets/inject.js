/* Injected into hianime.dk pages (main frame only). ES5 on purpose: the TV's WebView may be old. */
(function () {
  // The app refuses every new window natively; hand ad scripts a dead window so they don't retry.
  // Cheap and safe to repeat, so do it even on the early (pre-DOM) injection.
  var deadWindow = {
    closed: true, opener: null, location: {}, document: { write: function () {}, close: function () {} },
    close: function () {}, focus: function () {}, blur: function () {}, postMessage: function () {}
  };
  try { window.open = function () { return deadWindow; }; } catch (e) {}

  // The site's PWA service worker only adds a second network path (one that stalled page loads in
  // testing). Refuse new registrations; the app also answers /sw.js with a self-removing worker.
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function () { return Promise.reject(new Error('disabled by HiAnime TV')); };
    }
  } catch (e) {}

  // onPageStarted can run before the document has a root element; onPageFinished injects again.
  if (window.__hitvFixViewport) window.__hitvFixViewport();
  if (window.__hitv || !document.documentElement) return;
  window.__hitv = true;

  var PLAYER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(megaplay\.buzz|vidtube\.site|zokoanime\.video|hianimes\.es)$/i;
  var BRIDGE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(megaplay\.buzz|vidtube\.site)$/i;   // speak {cmd:...}
  var OVERLAY_Z = 2147483000;

  // TV: lay the site out 1280 CSS px wide (desktop layout: episode list, player and its controls all
  // fit on one screen) and let WebView's overview mode scale it to the panel. The app sets
  // window.__hitvViewport to 0 on phones/tablets to keep the site's own viewport.
  var viewportWidth = window.__hitvViewport || 0;
  function fixViewport() {
    if (!viewportWidth) return;
    // Pin the scale too: WebView sizes the page for its first (often empty) layout and, with user zoom
    // off, never re-fits when the viewport changes later.
    var scale = Math.min(1, (window.screen && screen.width ? screen.width : viewportWidth) / viewportWidth);
    scale = Math.round(scale * 1000) / 1000;
    var want = 'width=' + viewportWidth + ', initial-scale=' + scale + ', minimum-scale=' + scale + ', maximum-scale=' + scale;
    var metas = document.querySelectorAll('meta[name="viewport"]');
    var m = metas.length ? metas[metas.length - 1] : null;   // the last one wins
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      (document.head || document.documentElement).appendChild(m);
    }
    if (m.getAttribute('content') !== want) m.setAttribute('content', want);
  }
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        for (var i = 0; i < rs.length; i++) rs[i].unregister();
      })['catch'](function () {});
    }
  } catch (e) {}

  window.__hitvFixViewport = fixViewport;
  fixViewport();

  // Ad slots that live in the site's own HTML, and the popunder's full-screen interstitial: it is
  // mounted at 0x0 and only grown later through its inline style, so match the inline z-index
  // instead of waiting to see it big.
  var css =
    '.aniwatch-banner-wrap,' +                    // "Visit Aniwatch.rest" cross-promo on watch pages
    'ins.adsbygoogle,' +
    'iframe[src*="doubleclick.net"],iframe[src*="googlesyndication.com"],' +
    // The share bars: the site re-renders ShareThis buttons inside .sharethis-inline-share-buttons and
    // forces that box to display:flex!important, so hide the whole bar (every button opens a foreign window).
    '.sharethis-inline-share-buttons,#st-1,.share-buttons,' +
    'body>[style*="z-index: 2147483"]:not([data-hitv]),html>[style*="z-index: 2147483"]:not([data-hitv]),' +
    'body>[style*="z-index:2147483"]:not([data-hitv]),html>[style*="z-index:2147483"]:not([data-hitv])' +
    '{display:none!important}' +
    // Give links a visible hover/focus ring for the remote pointer.
    'a:focus,button:focus{outline:2px solid #ff5e9c!important;outline-offset:2px}' +
    // Theater mode (RED): everything but the player is made invisible; visibility, unlike
    // display/opacity, can be switched back on for a descendant.
    'html.hitv-theater,html.hitv-theater body{background:#000!important;overflow:hidden!important}' +
    'html.hitv-theater body *{visibility:hidden!important}' +
    'html.hitv-theater iframe[data-hitv=theater]{visibility:visible!important;position:fixed!important;' +
    'left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-width:none!important;' +
    'max-height:none!important;margin:0!important;border:0!important;z-index:2147483647!important;background:#000!important}';
  function addStyle() {
    if (document.getElementById('hitv-style')) return;
    var s = document.createElement('style');
    s.id = 'hitv-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  addStyle();

  function originOf(url) {
    var m = /^https?:\/\/[^\/?#]+/i.exec(url || '');
    return m ? m[0] : '';
  }

  // Full-screen overlays: the popunder script draws click-catching iframes at z-index 2147483640+.
  function isAdOverlay(el) {
    if (!el || el.nodeType !== 1 || el.hasAttribute('data-hitv')) return false;
    if (el === document.fullscreenElement || el === document.webkitFullscreenElement) return false;
    var s;
    try { s = window.getComputedStyle(el); } catch (e) { return false; }
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;
    return parseInt(s.zIndex, 10) >= OVERLAY_Z;
  }
  function sweep(nodes) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (isAdOverlay(n) && n.parentNode) n.parentNode.removeChild(n);
    }
  }
  function sweepTop() {
    if (document.body) sweep(document.body.children);
    sweep(document.documentElement.children);
  }

  /** The video player iframe: the site's player slot, else a known player host, else the largest frame. */
  function findPlayer() {
    var f = document.querySelector('.player-frame iframe');
    if (f) return f;
    var fs = document.querySelectorAll('iframe'), best = null, area = 0, i;
    for (i = 0; i < fs.length; i++) {
      if (PLAYER_ORIGIN.test(originOf(fs[i].src))) return fs[i];
    }
    for (i = 0; i < fs.length; i++) {
      if (isAdOverlay(fs[i])) continue;
      var r = fs[i].getBoundingClientRect(), a = r.width * r.height;
      if (a > area) { area = a; best = fs[i]; }
    }
    return area >= 40000 ? best : null;
  }
  window.__hitvFindPlayer = findPlayer;   // snap.js: OK on the video opens theater mode

  // Theater mode survives the site swapping the player iframe (new episode/server, auto-next).
  function keepTheaterTarget() {
    var root = document.documentElement;
    if (!root.classList.contains('hitv-theater') || document.querySelector('iframe[data-hitv="theater"]')) return;
    var p = findPlayer();
    if (p) p.setAttribute('data-hitv', 'theater');
  }

  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      var added = [];
      for (var i = 0; i < muts.length; i++) {
        var a = muts[i].addedNodes;
        for (var j = 0; j < a.length; j++) added.push(a[j]);
      }
      if (!added.length) return;
      for (var k = 0; k < added.length; k++) {
        if (added[k].nodeName === 'META') { fixViewport(); break; }   // the site's own viewport tag arrived
      }
      sweep(added);
      addStyle();
      keepTheaterTarget();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  // Overlays can also appear by restyling an existing element, so check the top level regularly.
  setInterval(sweepTop, 2000);

  // Playback state, from the players' own progress messages (the shapes the site's watch.min.js
  // parses). Only player origins count, so ad frames can't fake it.
  var lastTime = -1;
  window.__hitvLastAdvance = 0;
  window.addEventListener('message', function (e) {
    if (!PLAYER_ORIGIN.test(e.origin || '')) return;
    var d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { return; } }
    if (!d || typeof d !== 'object') return;
    var t = NaN;
    if (d.type === 'progress' && d.payload) t = +d.payload.currentTime;
    else if (d.type === 'watching-log') t = +d.currentTime;
    else if (d.event === 'time' || d.event === 'CURRENT_TIME') t = +d.time;
    if (!isFinite(t)) return;
    if (lastTime >= 0 && t !== lastTime) window.__hitvLastAdvance = Date.now();
    lastTime = t;
  }, false);

  /** Ask a bridge player for its time twice; calls back with true if it is advancing. */
  function probePlaying(frame, cb) {
    function ask(next) {
      var done = false;
      function onMsg(e) {
        if (e.source !== frame.contentWindow) return;
        var d = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { return; } }
        if (!d || d.event !== 'CURRENT_TIME' || done) return;
        done = true;
        window.removeEventListener('message', onMsg, false);
        next(+d.time);
      }
      window.addEventListener('message', onMsg, false);
      try { frame.contentWindow.postMessage({ cmd: 'GET_TIME' }, '*'); } catch (x) {}
      setTimeout(function () {
        if (!done) { done = true; window.removeEventListener('message', onMsg, false); next(NaN); }
      }, 800);
    }
    ask(function (t1) {
      setTimeout(function () { ask(function (t2) { cb(isFinite(t1) && isFinite(t2) && t2 > t1); }); }, 500);
    });
  }

  /**
   * Remote commands from the app. cmd: PLAY_PAUSE | PLAY | PAUSE | SEEK (value = seconds, relative) | MUTE.
   * megaplay.buzz / vidtube.site (handle-bridge.min.js) take {cmd:'PLAY_TOGGLE'|'SEEK'|'MUTE'|'GET_TIME'}.
   * Returns 'bridge', 'frame' (unknown player: the app presses a key instead) , 'video' or 'none'.
   */
  window.__hitvCmd = function (cmd, value) {
    var f = findPlayer();
    if (f && BRIDGE_ORIGIN.test(originOf(f.src))) {
      var w = f.contentWindow;
      if (cmd === 'PLAY_PAUSE') w.postMessage({ cmd: 'PLAY_TOGGLE' }, '*');
      else if (cmd === 'SEEK') w.postMessage({ cmd: 'SEEK', value: value, skip: true }, '*');
      else if (cmd === 'MUTE') w.postMessage({ cmd: 'MUTE' }, '*');
      else if (cmd === 'PLAY' || cmd === 'PAUSE') {
        probePlaying(f, function (playing) {
          if ((cmd === 'PLAY') !== playing) w.postMessage({ cmd: 'PLAY_TOGGLE' }, '*');
        });
      }
      return 'bridge';
    }
    if (f) {
      // Unknown player: only toggle for PLAY/PAUSE when its progress messages say it is needed.
      if (cmd === 'PLAY' || cmd === 'PAUSE') {
        var playing = Date.now() - window.__hitvLastAdvance < 2000;
        if ((cmd === 'PLAY') === playing) return 'noop';
      }
      try { f.focus(); } catch (x) {}
      return 'frame';
    }
    var v = document.querySelector('video');
    if (!v) return 'none';
    if (cmd === 'PLAY_PAUSE') { if (v.paused) v.play(); else v.pause(); }
    else if (cmd === 'PLAY') v.play();
    else if (cmd === 'PAUSE') v.pause();
    else if (cmd === 'SEEK') v.currentTime = Math.max(0, v.currentTime + value);
    else if (cmd === 'MUTE') v.muted = !v.muted;
    return 'video';
  };

  /** Theater mode on/off. Off always clears every trace, even if the site replaced the player. */
  window.__hitvTheater = function (on) {
    var root = document.documentElement;
    if (!on) {
      var was = root.classList.contains('hitv-theater');
      root.classList.remove('hitv-theater');
      var marked = document.querySelectorAll('iframe[data-hitv="theater"]');
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-hitv');
      return was || marked.length ? 'off' : 'none';
    }
    var p = findPlayer();
    if (!p) return 'none';
    addStyle();
    p.setAttribute('data-hitv', 'theater');
    root.classList.add('hitv-theater');
    try { p.focus(); } catch (x) {}
    return 'on';
  };

  /** Recent playback progress, for keeping the TV screen awake (polled by the app). */
  window.__hitvRecentlyPlaying = function () {
    return Date.now() - window.__hitvLastAdvance < 45000;
  };
})();
