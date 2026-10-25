/*
 * Snap navigation: the remote's arrows jump a focus ring between the things you can click, like a TV
 * app (MainActivity.onSnapKey). OK becomes a real tap at the focused element (the app sends it), so
 * the site sees the same input a pointer click gives. Main frame only. ES5 on purpose.
 *
 * window.__hitvSnap(cmd, ...) is the app's only entry point; every call returns a plain object:
 *   'move', dir           dir 0 left, 1 right, 2 up, 3 down
 *   'page', ±1            CH -/+: a screen up/down, the ring stays about where it was on screen
 *   'activate'            {r:'tap', x, y, w} (viewport CSS px + innerWidth) | {r:'player'} | {r:'done'}
 *   'back'                {r:'handled'} if BACK closed something on the page (search, menu, dialog)
 *   'pointer', true       pointer mode: ring off; returns the focus centre to put the pointer there
 *   'pointer', false[, x, y, viewWidth]   back to snap mode, focusing what's under the pointer
 *
 * A target is a pair: `el` is what OK taps, `box` is what the ring frames and what the arrows measure
 * (a whole card for a card, else the element itself).
 */
(function () {
  if (window.__hitvSnap || !document.documentElement) return;

  // ------------------------------------------------------------------ site knowledge (hianime.dk)
  // Everything here is a selector list; adapting to another site starts with this table.

  var SITE = {
    // Click targets that aren't links or buttons (div buttons with script handlers). The idle
    // pointer-cursor scan below finds these too; listing them makes them work before it has run.
    extra: '[data-toggle],#mobile_search,.toggle-lang,.swiper-button-next,.swiper-button-prev,.trending-navi>div,' +
      '#display-comment,.btn-user-avatar,label.custom-control-label,.toggle-basic,.btn-more-desc,#ssc-list .ssc-name',
    // Never focus these: tooltips and qTip shells, mobile duplicates, dead social links, controls
    // that are switched off, inputs drawn by their label.
    skip: '.qtip,.tooltip,template,#pick_menu,.sb-setting,.aniwatch-banner-wrap,a.zr-social-button[href="#"],' +
      '.swiper-button-disabled,.swiper-pagination,input.custom-control-input,.bac-item,[data-toggle=tooltip]:not(a),' +
      '.hianime-cm-ep-btn,.hianime-cm-avatar',   // comments: a label that looks like a button; avatar = name link
    // Layers that take the remote while they are open (topmost first). A full-screen fixed layer
    // holding targets counts too, without being listed.
    scopes: ['.modal.show .modal-dialog', '#sidebar_menu.active', '.dropdown-menu.show'],
    // Where the ring starts on a fresh page, best first: the first one on screen wins.
    // (The watch page's player arrives by ajax a second or two after load; autoStart waits for it.)
    start: ['.player-frame iframe', '.ep-item.active', '#slider .swiper-slide-active .desi-buttons a.btn-primary',
      '.film-buttons a.btn-play', '.film_list-wrap .flw-item'],
    // Coming into one of these boxes from outside lands on its current item, not the nearest one.
    groups: [['.ss-list', '.ep-item.active']],
    // One stop per card: the ring frames the card and OK opens `cardMain` (else its first target).
    card: '.flw-item,.anif-block-ul li,.block_area-realtime li.item-top,a.tsl-link',
    cardMain: 'a.film-poster-ahref',
    // After OK on the first, the ring moves to the second once it shows: the search opener to the
    // search box; an episode to the player (OK again = theater mode, like picking a video on YouTube).
    // OK on description More/Less swaps the button; an episode range shows that range's list.
    then: [['#mobile_search', '#search input.search-input'], ['.ep-item', '.player-frame iframe'],
      ['.btn-more-desc.more', '.btn-more-desc.less'], ['.btn-more-desc.less', '.btn-more-desc.more'],
      ['.ep-page-item', '.ss-list.active .ep-item']]
  };

  var BASE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],' +
    '[tabindex]:not([tabindex="-1"]),[onclick],iframe';
  var SEL = BASE_SEL + (SITE.extra ? ',' + SITE.extra : '');

  // ------------------------------------------------------------------ state

  var focusEl = null, focusBox = null;
  var lastDoc = null;          // the focus box in document coordinates (survives the element)
  var ring = null, ringOn = false;
  var pointer = !!window.__hitvPointer;
  var lastMoveAt = 0;
  var syncUntil = 0, syncing = false;
  var scrollShift = 0;         // a smooth page scroll just started: how far it will move things up
  var opener = null;           // the last thing OK pressed outside a layer: where BACK returns by default
                               // (a layer keeps its own opener in __hitvOpener: what OK or a move entered it from)
  var pausedSwiper = null;     // a carousel whose autoplay we stopped while the ring is in it
  var stamp = 0;               // collect() generation, for marks on cards
  var holdRecoverUntil = 0;    // OK or BACK is putting the ring somewhere itself: recover() must wait
  var recoverGen = -1;         // cacheGen of recover()'s last failed try: no new elements, no new try
  var installedAt = now(), startTimer = 0, startRank = 99, userMoved = false;
  var goalX = null, goalYDoc = null;   // the column (row, in page coordinates) to come back to
  var goalBox = null;                  // the box goalX was taken from
  var last = null;                  // the last move {from, to, dir}: the opposite key undoes it
  var REVERSE = [1, 0, 3, 2];

  function now() { return Date.now(); }
  function vw() { return window.innerWidth || document.documentElement.clientWidth; }
  function vh() { return window.innerHeight || document.documentElement.clientHeight; }
  function sx() { return window.pageXOffset || 0; }
  function sy() { return window.pageYOffset || 0; }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  function toDoc(r) {
    return { left: r.left + sx(), top: r.top + sy(), right: r.right + sx(), bottom: r.bottom + sy(), width: r.width, height: r.height };
  }
  function fromDoc(d) {
    return { left: d.left - sx(), top: d.top - sy(), right: d.right - sx(), bottom: d.bottom - sy(), width: d.width, height: d.height };
  }
  function matches(el, sel) {
    if (!sel || !el || el.nodeType !== 1) return false;
    var m = el.matches || el.webkitMatchesSelector;
    try { return m.call(el, sel); } catch (e) { return false; }
  }
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      if (matches(el, sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function style(el) {
    try { return window.getComputedStyle(el); } catch (e) { return null; }
  }
  function sized(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  function alive(el) {
    return !!el && document.documentElement.contains(el) && sized(el);
  }
  function describe(el) {
    if (!el) return '';
    var t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40);
    var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (c ? '.' + c : '') + (t ? ' "' + t + '"' : '');
  }

  var RING_TRANSITION = 'transform .12s ease-out,width .12s ease-out,height .12s ease-out';
  var css = document.createElement('style');
  css.setAttribute('data-hitv', 'snap');
  // Bootstrap tooltips pop up on taps and cover neighbours; the ring says what's focused.
  // The back-to-top bubble covers targets in the bottom-right corner; CH +/- does its job.
  css.textContent = '.tooltip{display:none!important}#totop{display:none!important}' +
    'html.hitv-theater>[data-hitv=ring]{display:none!important}';
  (document.head || document.documentElement).appendChild(css);

  // ------------------------------------------------------------------ the player iframe

  var PLAYER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(megaplay\.buzz|vidtube\.site|zokoanime\.video|hianimes\.es)\//i;
  function isPlayer(el) {
    if (!el || el.tagName !== 'IFRAME') return false;
    if (window.__hitvFindPlayer) return window.__hitvFindPlayer() === el;
    return !!closest(el, '.player-frame') || PLAYER_ORIGIN.test(el.src || '');
  }

  // ------------------------------------------------------------------ layers and bars

  /** Fixed or sticky ancestor (or self): bars and layers that don't scroll with the page. */
  function fixedRoot(el) {
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      var s = style(el);
      if (s && (s.position === 'fixed' || s.position === 'sticky')) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** How much of the top (or bottom) of the screen a fixed bar covers, in CSS px. */
  function obstruction(bottom) {
    var y = bottom ? vh() - 2 : 1, w = vw(), most = 0;
    var xs = [w * 0.1, w * 0.5, w * 0.9];
    for (var i = 0; i < xs.length; i++) {
      var hit = document.elementFromPoint(xs[i], y);
      var f = hit ? fixedRoot(hit) : null;
      if (!f || f === ring) continue;
      var r = f.getBoundingClientRect();
      // A bar spans the width but not the height (a menu's dimmed backdrop is no header).
      if (r.width < w * 0.5 || r.height > vh() * 0.4) continue;
      var cover = bottom ? vh() - r.top : r.bottom;
      if (cover > most) most = cover;
    }
    return Math.max(0, Math.min(most, vh() * 0.4));
  }

  /** The open layer (dialog, side menu) the ring must stay in, or null for the whole page. */
  function scopeRoot() {
    for (var i = 0; i < SITE.scopes.length; i++) {
      var els = document.querySelectorAll(SITE.scopes[i]);
      for (var j = els.length - 1; j >= 0; j--) if (sized(els[j])) return els[j];
    }
    var hit = document.elementFromPoint(vw() / 2, vh() / 2);
    var f = hit ? fixedRoot(hit) : null;
    if (!f || f === ring || isPlayer(f)) return null;
    var r = f.getBoundingClientRect();
    if (r.width * r.height < vw() * vh() * 0.5) return null;
    return f.querySelector(SEL) ? f : null;
  }

  // ------------------------------------------------------------------ carousels (Swiper)

  /** The Swiper container el sits in (the box that clips its slides), or null. */
  function swiperOf(el) {
    for (var n = el && el.parentElement, d = 0; n && n !== document.body && d < 12; n = n.parentElement, d++) {
      if (n.swiper && n.swiper.slides && !n.swiper.destroyed) return n;
    }
    return null;
  }

  /** Slides the carousel so the slide holding el is fully in view; returns the slide time in ms. */
  function pageSwiper(container, el) {
    var sw = container.swiper, slide = closest(el, '.swiper-slide');
    if (!sw || !slide) return 0;
    var cr = container.getBoundingClientRect(), r = slide.getBoundingClientRect();
    if (r.left >= cr.left - 1 && r.right <= cr.right + 1) return 0;
    try {
      if (sw.params && sw.params.loop) {
        var real = parseInt(slide.getAttribute('data-swiper-slide-index'), 10);
        if (isFinite(real)) sw.slideToLoop(real);
      } else {
        var idx = Array.prototype.indexOf.call(sw.slides, slide);
        if (idx < 0) return 0;
        if (r.left < cr.left) {
          sw.slideTo(idx);
        } else {
          // Moving right: the smallest step that shows the whole slide.
          var grid = sw.slidesGrid || [], cur = sw.activeIndex, target = cur, need = r.right - cr.right;
          while (target < sw.slides.length - 1 && (grid[target] - grid[cur]) < need) target++;
          sw.slideTo(target);
        }
      }
    } catch (e) { return 0; }
    return (sw.params && sw.params.speed) || 300;
  }

  /** A carousel that turns by itself would carry the focused slide away: hold it while we're in it. */
  function holdAutoplay(el) {
    var c = el ? swiperOf(el) : null, sw = c ? c.swiper : null;
    if (pausedSwiper && pausedSwiper !== sw) {
      try { if (!pausedSwiper.destroyed) pausedSwiper.autoplay.start(); } catch (e) {}
      pausedSwiper = null;
    }
    if (sw && sw.autoplay && sw.autoplay.running) {
      try { sw.autoplay.stop(); pausedSwiper = sw; } catch (e) {}
    }
  }

  // ------------------------------------------------------------------ click targets without a tag for it

  // Sites make buttons out of plain divs and spans with script handlers (the watch page's Light /
  // Auto Play toggles, for one). They all show a pointer cursor, so find the outermost element with
  // one that isn't already a link or button. Scanned in idle slices: a big page must not stall the remote.
  var extraTargets = [], scanList = null, scanAt = 0, scanFound = [], scanTimer = 0, scanning = false;
  function whenIdle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 400 });
    else setTimeout(fn, 30);
  }
  function scheduleScan(delay) {
    if (scanTimer || scanning) return;
    scanTimer = setTimeout(function () {
      scanTimer = 0;
      if (!document.body) return;
      scanning = true;
      scanList = document.body.getElementsByTagName('*');
      scanAt = 0;
      scanFound = [];
      whenIdle(scanSlice);
    }, delay);
  }
  function scanSlice() {
    var end = Math.min(scanList.length, scanAt + 300);
    for (; scanAt < end; scanAt++) {
      var el = scanList[scanAt];
      if (!el.offsetWidth || !el.offsetHeight || el === ring) continue;   // also skips SVG parts
      var s = style(el);
      if (!s || s.cursor !== 'pointer') continue;
      var ps = el.parentElement ? style(el.parentElement) : null;
      if (ps && ps.cursor === 'pointer') continue;    // cursor is inherited: only the outermost counts
      if (closest(el, SEL) || el.querySelector(SEL)) continue;
      scanFound.push(el);
    }
    if (scanAt < scanList.length) { whenIdle(scanSlice); return; }
    extraTargets = scanFound;
    scanning = false;
  }
  if (window.MutationObserver) {
    new MutationObserver(function () {
      cacheDirty = true;
      scheduleScan(1500);
      // Early on, a better start target may still arrive by ajax (the watch page's player).
      if (!userMoved && now() - installedAt < 10000 && !startTimer) {
        startTimer = setTimeout(function () { startTimer = 0; autoStart(); }, 300);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  scheduleScan(800);

  // ------------------------------------------------------------------ targets

  // The page's targets and cards, queried again only after the page added or removed elements: on a
  // watch page (1,200 episode links, 12,000 elements) the query is most of a move's cost on a TV.
  var cacheDirty = true, cacheGen = 0, cacheList = [];
  function refreshCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    cacheGen++;
    if (SITE.card) {
      var cards = document.querySelectorAll(SITE.card);
      for (var k = 0; k < cards.length; k++) cards[k].__hitvCard = cacheGen;
    }
    cacheList = Array.prototype.slice.call(document.querySelectorAll(SEL));
  }

  /** The card el belongs to (cards are marked by refreshCache). */
  function cardOf(el) {
    for (var n = el, d = 0; n && n.nodeType === 1 && d < 8; n = n.parentElement, d++) {
      if (n.__hitvCard === cacheGen) return n;
    }
    return null;
  }
  function cardMain(card) {
    if (matches(card, SEL)) return card;
    var m = SITE.cardMain ? card.querySelector(SITE.cardMain) : null;
    if (m && sized(m)) return m;
    var all = card.querySelectorAll(SEL);
    for (var i = 0; i < all.length; i++) if (sized(all[i])) return all[i];
    return null;
  }

  /** The target an element stands for: its card (one stop per card), else itself. */
  function targetFor(el) {
    var card = SITE.card ? closest(el, SITE.card) : null;
    if (card) {
      var main = cardMain(card);
      if (main) return { el: main, box: card };
    }
    return { el: el, box: el };
  }

  /** All rendered targets: [{el, box, r}] with r the box in viewport coordinates. Cheap checks only. */
  function collect(scope) {
    refreshCache();
    stamp++;
    var list = scope ? Array.prototype.slice.call(scope.querySelectorAll(SEL)) : cacheList.slice(), out = [];
    for (var x = 0; x < extraTargets.length; x++) {
      var t = extraTargets[x];
      if ((!scope || scope.contains(t)) && document.documentElement.contains(t)) list.push(t);
    }
    for (var i = 0; i < list.length; i++) {
      var el = list[i], box = el;
      if (el === ring || el.disabled) continue;
      if (el.tagName === 'IFRAME' && !isPlayer(el)) continue;
      var card = SITE.card ? cardOf(el) : null;
      if (card) {
        if (card.__hitvSeen === stamp) continue;
        card.__hitvSeen = stamp;
        el = cardMain(card);
        if (!el) continue;
        box = card;
      }
      var r = box.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      out.push({ el: el, box: box, r: r });
    }
    return out;
  }

  /**
   * Where a target can be seen: 0 hidden (by style, or clipped by an overflow box it can't be scrolled
   * into), 1 shown or reachable by scrolling, 2 clipped inside a carousel that can slide it in.
   * Leaves the part of r that is on screen and not clipped by its boxes in reachClip.
   */
  var reachClip = null;
  function reach(el, r) {
    var s = style(el);
    if (!s || s.visibility === 'hidden' || s.visibility === 'collapse') return 0;
    var n = el, depth = 0, scrollableX = false, carousel = false;
    var clip = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, vw()), bottom: Math.min(r.bottom, vh()) };
    reachClip = clip;
    while (n && n.nodeType === 1 && n !== document.body && depth++ < 30) {
      var ns = n === el ? s : style(n);
      if (!ns) break;
      if (parseFloat(ns.opacity) < 0.05) return 0;
      if (n !== el && ns.overflow !== 'visible') {
        var p = n.getBoundingClientRect();
        // Page-wide wrappers never scroll sideways in practice (the site's #wrapper is overflow-x:auto).
        var scrollY = /(auto|scroll)/.test(ns.overflowY);
        var scrollX = /(auto|scroll)/.test(ns.overflowX) && p.width < vw() * 0.9;
        if (scrollX) scrollableX = true;
        var outY = r.bottom <= p.top + 1 || r.top >= p.bottom - 1;
        var outX = r.right <= p.left + 1 || r.left >= p.right - 1;
        var partX = r.left < p.left - 1 || r.right > p.right + 1;
        if (n.swiper && n.swiper.slides) {
          if (outY) return 0;
          if (outX || partX) carousel = true;
        } else {
          if (!scrollY && outY) return 0;
          // Boxes around a carousel clip its slides too, but sliding brings them in.
          if (!scrollX && outX && !carousel) return 0;
          clip.left = Math.max(clip.left, p.left); clip.right = Math.min(clip.right, p.right);
          clip.top = Math.max(clip.top, p.top); clip.bottom = Math.min(clip.bottom, p.bottom);
        }
      }
      if (ns.position === 'fixed') break;
      n = n.parentElement;
    }
    if (carousel) return 2;
    // The page never scrolls sideways: off to the side means unreachable (moved out of view).
    if (!scrollableX && (r.right <= 0 || r.left >= vw())) return 0;
    return r.bottom + sy() <= 0 ? 0 : 1;
  }

  /**
   * Something else is drawn over the target (a suggestion list, a dialog): not reachable now. Probes the
   * part that shows (c.clip, from reach): a card peeking in at the screen edge, an item at a list's edge.
   */
  function covered(c) {
    var k = c.clip || c.r, fx = [0.5, 0.25, 0.75], fy = [0.5, 0.3, 0.7];
    var left = Math.max(k.left, 0), right = Math.min(k.right, vw()), top = Math.max(k.top, 0), bottom = Math.min(k.bottom, vh());
    if (right - left < 1 || bottom - top < 1) return false;   // nothing of it shows: can't tell
    for (var i = 0; i < fx.length; i++) {
      var x = Math.min(left + (right - left) * fx[i], vw() - 1), y = Math.min(top + (bottom - top) * fy[i], vh() - 1);
      var hit = document.elementFromPoint(x, y);
      if (!hit || hit === c.box || c.box.contains(hit) || hit.contains(c.box)) return false;
      if (hit === c.el || c.el.contains(hit)) return false;
    }
    return true;
  }

  /** A link to a real page (not javascript: or a #fragment of this one). */
  function isPage(el) {
    var h = el && el.href;
    if (!h || typeof h !== 'string' || !/^https?:/i.test(h)) return false;
    return h.split('#')[0] !== location.href.split('#')[0] || h.indexOf('#') < 0;
  }

  /** The full checks, run only on the few candidates that would win. Sets c.reach. */
  function usable(c, from) {
    var el = c.el;
    if (SITE.skip && (closest(el, SITE.skip) || (c.box !== el && closest(c.box, SITE.skip)))) return false;
    // Foreign sites in a new window: the app refuses those, so the link is dead here.
    if (el.target === '_blank' && el.hostname && el.hostname !== location.hostname) return false;
    c.reach = reach(c.box, c.r);
    c.clip = reachClip;
    if (!c.reach) return false;
    if (from && from.box) {
      if (c.box.contains(from.box) || from.box.contains(c.box)) return false;
      // The same page twice in one card (poster and title): one stop is enough. Script links
      // (javascript:, #) all look alike and aren't duplicates.
      if (isPage(el) && el.href === from.el.href) {
        var f = from.box.getBoundingClientRect();
        var gapX = Math.max(0, Math.max(f.left, c.r.left) - Math.min(f.right, c.r.right));
        var gapY = Math.max(0, Math.max(f.top, c.r.top) - Math.min(f.bottom, c.r.bottom));
        if (gapX < 60 && gapY < 60) return false;
      }
    }
    // A wrapper around other targets: the targets inside win (a card is already one target).
    if (c.box === el && el.tagName !== 'IFRAME' && !(SITE.card && matches(el, SITE.card))) {
      var inner = el.querySelector(SEL);
      if (inner && sized(inner)) return false;
    }
    if (c.reach === 1 && covered(c)) return false;
    return true;
  }

  // ------------------------------------------------------------------ direction rules (Android FocusFinder)

  function isCandidate(dir, s, d) {
    switch (dir) {
      case 0: return (s.right > d.right || s.left >= d.right) && s.left > d.left;
      case 1: return (s.left < d.left || s.right <= d.left) && s.right < d.right;
      case 2: return (s.bottom > d.bottom || s.top >= d.bottom) && s.top > d.top;
      default: return (s.top < d.top || s.bottom <= d.top) && s.bottom < d.bottom;
    }
  }
  function beamsOverlap(dir, a, b) {
    return dir < 2 ? (b.bottom > a.top && b.top < a.bottom) : (b.right > a.left && b.left < a.right);
  }
  function isToDirectionOf(dir, s, d) {
    switch (dir) {
      case 0: return s.left >= d.right;
      case 1: return s.right <= d.left;
      case 2: return s.top >= d.bottom;
      default: return s.bottom <= d.top;
    }
  }
  function majorAxisDistance(dir, s, d) {
    switch (dir) {
      case 0: return Math.max(0, s.left - d.right);
      case 1: return Math.max(0, d.left - s.right);
      case 2: return Math.max(0, s.top - d.bottom);
      default: return Math.max(0, d.top - s.bottom);
    }
  }
  function majorAxisDistanceToFarEdge(dir, s, d) {
    switch (dir) {
      case 0: return Math.max(1, s.left - d.left);
      case 1: return Math.max(1, d.right - s.right);
      case 2: return Math.max(1, s.top - d.top);
      default: return Math.max(1, d.bottom - s.bottom);
    }
  }
  function minorAxisDistance(dir, s, d) {
    return dir < 2 ? Math.abs((s.top + s.height / 2) - (d.top + d.height / 2))
      : Math.abs((s.left + s.width / 2) - (d.left + d.width / 2));
  }
  /**
   * FocusFinder's score, with the minor axis measured from the remembered column (row) to the
   * candidate's span instead of centre to centre: a wide element in between doesn't lose your column.
   */
  function weighted(dir, s, d) {
    var major = majorAxisDistance(dir, s, d), minor = minorAxisDistance(dir, s, d);
    var anchor = dir < 2 ? (goalYDoc === null ? null : goalYDoc - sy()) : goalX;
    if (anchor !== null) {
      var lo = dir < 2 ? d.top : d.left, hi = dir < 2 ? d.bottom : d.right;
      minor = (anchor < lo ? lo - anchor : anchor > hi ? anchor - hi : 0) + 0.1 * minor;
    }
    return 13 * major * major + minor * minor;
  }
  function beamBeats(dir, s, r1, r2) {
    var in1 = beamsOverlap(dir, s, r1), in2 = beamsOverlap(dir, s, r2);
    if (in2 || !in1) return false;
    if (!isToDirectionOf(dir, s, r2)) return true;
    if (dir < 2) return true;
    return majorAxisDistance(dir, s, r1) < majorAxisDistanceToFarEdge(dir, s, r2);
  }
  function isBetter(dir, s, cand, best) {
    if (!best) return true;
    if (beamBeats(dir, s, cand, best)) return true;
    if (beamBeats(dir, s, best, cand)) return false;
    return weighted(dir, s, cand) < weighted(dir, s, best);
  }

  /**
   * The best usable candidate in a direction from rect s. Fixed bars come last unless we're on one,
   * and are reached only by going up or down: sideways off the page content leads nowhere.
   */
  function pick(dir, s, cands, from, originFixed) {
    var deferred = null;
    for (var round = 0; round < 40; round++) {
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (c.bad || (from && c.box === from.box) || !isCandidate(dir, s, c.r)) continue;
        // Off to the side (a closed side menu, a slide not shown): only usable ones may compete. The
        // comparison isn't transitive, so a dead one could knock out the real best and then lose.
        if (c.r.right <= 0 || c.r.left >= vw()) {
          if (c.side === undefined) c.side = reach(c.box, c.r);
          if (!c.side) continue;
        }
        // Sideways stays on the same row (like a TV app): nothing level with us means the row ends.
        if (dir < 2 && !beamsOverlap(dir, s, c.r) &&
            Math.max(c.r.top - s.bottom, s.top - c.r.bottom) > Math.max(16, s.height * 0.5)) continue;
        if (!best || isBetter(dir, s, c.r, best.r)) best = c;
      }
      if (!best) return deferred;
      if (!usable(best, from)) { best.bad = true; continue; }
      if (!originFixed && fixedRoot(best.box)) {
        if (!deferred && dir >= 2) deferred = best;
        best.bad = true;
        continue;
      }
      return best;
    }
    return deferred;
  }

  // ------------------------------------------------------------------ scrolling

  function scrollByY(target, dy, smooth) {
    if (!dy) return;
    try { target.scrollBy({ top: dy, left: 0, behavior: smooth ? 'smooth' : 'auto' }); }
    catch (e) { if (target === window) window.scrollBy(0, dy); else target.scrollTop += dy; }
  }
  function scrollByX(target, dx) {
    if (!dx) return;
    try { target.scrollBy({ left: dx, top: 0, behavior: 'auto' }); } catch (e) { target.scrollLeft += dx; }
  }

  /**
   * Brings a box into view: scroll boxes it sits in first, then the page, keeping clear of fixed bars.
   * Never scrollIntoView/focus(): inside a carousel's clipped box that scrolls the box itself and
   * breaks the carousel. Carousels are slid by pageSwiper instead.
   */
  function reveal(box, smooth) {
    var n = box.parentElement, depth = 0;
    while (n && n !== document.body && n !== document.documentElement && depth++ < 30) {
      if (n.swiper && n.swiper.slides) { n = n.parentElement; continue; }
      var s = style(n);
      if (s && /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        var p = n.getBoundingClientRect(), r = box.getBoundingClientRect(), m = Math.min(40, p.height * 0.15);
        if (r.top < p.top + m) scrollByY(n, r.top - p.top - m, false);
        else if (r.bottom > p.bottom - m) scrollByY(n, Math.min(r.bottom - p.bottom + m, r.top - p.top - m), false);
      }
      if (s && /(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1 && n.clientWidth < vw() * 0.9) {
        var px = n.getBoundingClientRect(), rx = box.getBoundingClientRect(), mx = Math.min(40, px.width * 0.1);
        if (rx.left < px.left + mx) scrollByX(n, rx.left - px.left - mx);
        else if (rx.right > px.right - mx) scrollByX(n, Math.min(rx.right - px.right + mx, rx.left - px.left - mx));
      }
      if (s && s.position === 'fixed') return;   // a fixed layer doesn't move with the page
      n = n.parentElement;
    }
    if (fixedRoot(box)) return;
    var rr = box.getBoundingClientRect();
    var top = obstruction(false) + 24, bottom = vh() - obstruction(true) - 24;
    if (rr.top >= top && rr.bottom <= bottom) return;
    // Out of the comfortable band: centre it (a tall box: its top near the top).
    var dy = rr.height > bottom - top ? rr.top - top : (rr.top + rr.height / 2) - (top + bottom) / 2;
    var max = Math.max(0, document.documentElement.scrollHeight - vh());
    var from = sy();
    scrollByY(window, dy, smooth);
    if (smooth) scrollShift = Math.max(0, Math.min(max, from + dy)) - from;
  }

  // ------------------------------------------------------------------ the ring

  // The ring lives on <html>, positioned in page coordinates for page content (the compositor
  // scrolls it along with the page, nothing to do per frame on a slow TV) and in screen coordinates
  // for fixed bars and layers.
  function ensureRing() {
    if (ring && ring.parentNode) return ring;
    ring = document.createElement('div');
    ring.setAttribute('data-hitv', 'ring');
    ring.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'z-index:2147482000;box-sizing:border-box;border:3px solid #ff5e9c;border-radius:8px;' +
      'box-shadow:0 0 0 2px rgba(0,0,0,.65),0 0 18px 3px rgba(255,94,156,.55);display:none;' +
      'transition:' + RING_TRANSITION;
    document.documentElement.appendChild(ring);
    return ring;
  }

  /**
   * What the ring frames: the target's box; for a plain link, the biggest box around it that holds
   * only links to the same place (poster + title), so it reads like a TV app's card. Cached per focus.
   */
  var frameFor = null, frameEl = null;
  function frameOf(el, box) {
    if (box !== el) return box;
    if (frameFor === el && frameEl && document.documentElement.contains(frameEl)) return frameEl;
    frameFor = el;
    frameEl = el;
    if (!isPage(el) || fixedRoot(el)) return el;
    var max = vw() * vh() * 0.2, n = el.parentElement, depth = 0, own = el.getBoundingClientRect();
    while (n && n !== document.body && depth++ < 5) {
      var r = n.getBoundingClientRect();
      if (r.width * r.height > max || r.width > vw() * 0.5) break;
      var links = n.querySelectorAll(SEL), ok = true;
      for (var i = 0; i < links.length && ok; i++) {
        if (links[i] !== el && links[i].href !== el.href) ok = false;
      }
      if (!ok) break;
      // A box much bigger than the link but holding nothing else to click is layout, not a card.
      if (links.length > 1 || r.height < own.height * 2.5) frameEl = n;
      n = n.parentElement;
    }
    return frameEl;
  }

  function place() {
    if (!ringOn || pointer || !focusEl || !alive(focusBox)) {
      if (ring) ring.style.display = 'none';
      return;
    }
    ensureRing();
    var box = frameOf(focusEl, focusBox);
    var r = box.getBoundingClientRect(), pad = 4;
    var s = style(box);
    var radius = s ? parseFloat(s.borderTopLeftRadius) || 0 : 0;
    // Full-width rows: keep the ring inside the screen so all four sides show.
    var left = Math.max(r.left - pad, 2), right = Math.min(r.right + pad, vw() - 2);
    var fixed = !!fixedRoot(box), ox = fixed ? 0 : sx(), oy = fixed ? 0 : sy();
    if (ring.style.position !== (fixed ? 'fixed' : 'absolute')) {
      ring.style.transition = 'none';   // switching coordinate systems: jump, don't glide
      ring.style.position = fixed ? 'fixed' : 'absolute';
      ring.offsetWidth;
      ring.style.transition = RING_TRANSITION;
    }
    ring.style.display = 'block';
    ring.style.transform = 'translate(' + Math.round(left + ox) + 'px,' + Math.round(r.top - pad + oy) + 'px)';
    ring.style.width = Math.round(Math.max(right - left, 8)) + 'px';
    ring.style.height = Math.round(r.height + pad * 2) + 'px';
    ring.style.borderRadius = Math.max(6, Math.min(radius + pad, 40)) + 'px';
  }

  /** Keep the ring on its element for a moment (smooth scrolls, carousel slides, transitions). */
  function follow(ms) {
    syncUntil = Math.max(syncUntil, now() + (ms || 700));
    if (syncing) return;
    syncing = true;
    var step = function () {
      place();
      if (now() < syncUntil) window.requestAnimationFrame(step);
      else syncing = false;
    };
    window.requestAnimationFrame(step);
  }

  /** Focus target t ({el, box}); scroll (or slide its carousel) so it's in view. */
  function setFocus(t, scroll, smooth) {
    var prevEl = focusEl;
    focusEl = t.el;
    focusBox = t.box;
    scrollShift = 0;
    var wait = 0;
    if (scroll) {
      var car = swiperOf(t.box);
      if (car) wait = pageSwiper(car, t.box);
      reveal(car || t.box, smooth);
    }
    holdAutoplay(t.box);
    lastDoc = toDoc(rectOf(t.box));
    if (wait) {
      setTimeout(function () {
        if (focusBox !== t.box) return;
        var r = rectOf(t.box);
        lastDoc = toDoc(r);
        if (goalBox === t.box) goalX = r.left + r.width / 2;
      }, wait + 50);
    }
    ringOn = true;
    // A text box keeps the caret after you leave it; let it go so it doesn't eat keys.
    var a = document.activeElement;
    if (a && a !== t.el && prevEl && (a === prevEl || prevEl.contains(a)) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      try { a.blur(); } catch (e) {}
    }
    place();
    follow(Math.max(scroll ? 900 : 300, wait + 150));
  }

  /** Take c as the focus without moving anything (the page re-rendered it, the pointer chose it). */
  function adopt(c) {
    focusEl = c.el;
    focusBox = c.box;
    lastDoc = toDoc(rectOf(c.box));
    holdAutoplay(c.box);
  }

  function result(kind) {
    var out = { r: kind, w: vw() };
    var shift = scrollShift;
    scrollShift = 0;
    if (focusEl && alive(focusBox)) {
      var r = rectOf(focusBox);
      out.x = Math.round(Math.max(1, Math.min(vw() - 1, r.left + r.width / 2)));
      out.y = Math.round(Math.max(1, Math.min(vh() - 1, r.top + r.height / 2 - shift)));
      out.d = describe(focusEl);
    }
    return out;
  }

  // ------------------------------------------------------------------ choosing

  function onScreen(r, top, bottom) {
    return r.top >= top - 1 && r.bottom <= bottom + 1 && r.left >= -1 && r.right <= vw() + 1;
  }

  /** The first thing to focus on a page: the site's favourite if it's on screen, else the first target. */
  function startTarget() {
    var top = obstruction(false), bottom = vh() - obstruction(true), i, j, c;
    var scope = scopeRoot();
    if (!scope) {
      for (i = 0; i < SITE.start.length; i++) {
        var els = document.querySelectorAll(SITE.start[i]);
        for (j = 0; j < els.length; j++) {
          var t = targetFor(els[j]);
          c = { el: t.el, box: t.box, r: t.box.getBoundingClientRect() };
          if (c.r.width > 2 && onScreen(c.r, top, bottom) && usable(c, null) && c.reach === 1) return c;
        }
      }
    }
    var cands = collect(scope);
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      if (!onScreen(c.r, top, bottom) || (!scope && fixedRoot(c.box)) || !usable(c, null) || c.reach !== 1) continue;
      return c;
    }
    for (i = 0; i < cands.length; i++) {
      if (onScreen(cands[i].r, 0, vh()) && usable(cands[i], null)) return cands[i];
    }
    return null;
  }

  function current() {
    if (!focusEl || !alive(focusBox) || !document.documentElement.contains(focusEl)) return null;
    return reach(focusBox, focusBox.getBoundingClientRect()) ? { el: focusEl, box: focusBox } : null;
  }

  function move(dir) {
    var t = now(), smooth = t - lastMoveAt > 350;   // held keys scroll instantly, single presses glide
    lastMoveAt = t;
    pointer = false;
    var cur = current();
    var s = cur ? rectOf(cur.box) : (lastDoc ? fromDoc(lastDoc) : null);
    var toward = null;   // an unseen focus the press heads back to
    if (s && cur && !fixedRoot(cur.box) && (s.bottom <= 0 || s.top >= vh())) {
      // Scrolled away from the focus (text in between): search from the screen edge we left it
      // behind, in its column, so the next press takes what's on screen, or heads back to it.
      var above = s.bottom <= 0, edge = above ? 0 : vh();
      if (dir < 2) cur = null;   // sideways from an unseen focus: start over on screen
      else {
        if (dir === (above ? 2 : 3)) toward = { el: cur.el, box: cur.box, r: s, reach: 1 };
        s = { left: s.left, right: s.right, width: s.width, top: edge, bottom: edge, height: 0 };
      }
    }
    if (!s || (!cur && !onScreen(s, 0, vh()))) {
      var st = startTarget();
      if (!st) return verticalStep(dir) ? { r: 'scrolled' } : { r: 'empty' };
      setFocus(st, true, smooth);
      return result('start');
    }
    if (cur && !ringOn && onScreen(s, 0, vh())) {
      // The ring was off (pointer, page step): the first press only shows where we are.
      ringOn = true;
      place();
      return result('shown');
    }
    var scope = scopeRoot();
    if (scope && cur && !scope.contains(cur.box)) {
      var first = startTarget();
      if (first) { scope.__hitvOpener = cur; setFocus(first, true, smooth); return result('layer'); }
    }
    var originFixed = !!(cur && fixedRoot(cur.box));
    var best = pick(dir, s, collect(scope), cur, originFixed);
    // Heading back to the unseen focus: it comes before anything beyond it.
    if (toward && (!best || !before(dir, best.r, toward.r))) best = toward;
    // The opposite key goes back where we came from (down, then up, returns to the same card),
    // unless the last move carried us past something on the way (the episode list's current item).
    if (last && cur && last.to === cur.box && dir === REVERSE[last.dir] && alive(last.from.box) &&
        (!scope || scope.contains(last.from.box))) {
      var back = { el: last.from.el, box: last.from.box, r: last.from.box.getBoundingClientRect() };
      if (isCandidate(dir, s, back.r) && (!best || !before(dir, best.r, back.r)) && usable(back, cur)) {
        commit(back, cur, dir, smooth);
        return result('moved');
      }
    }
    if (!best) return verticalStep(dir) ? { r: 'scrolled' } : result('edge');
    // A long stretch of text between here and the next target: scroll through it instead of jumping.
    if (dir >= 2 && !scope && best.reach === 1 && !fixedRoot(best.box)) {
      var gap = dir === 3 ? best.r.top - Math.max(s.bottom, 0) : Math.min(s.top, vh()) - best.r.bottom;
      var unseen = dir === 3 ? best.r.top >= vh() - 8 : best.r.bottom <= obstruction(false) + 8;
      if (unseen && gap > vh() * 0.6) {
        scrollByY(window, (dir === 3 ? 1 : -1) * vh() * 0.55, smooth);
        follow(700);
        return { r: 'scrolled' };
      }
    }
    commit(enterGroup(best, cur), cur, dir, smooth);
    return result('moved');
  }

  /** Rect a lies wholly before rect b, going in direction dir. */
  function before(dir, a, b) {
    switch (dir) {
      case 0: return a.left >= b.right;
      case 1: return a.right <= b.left;
      case 2: return a.top >= b.bottom;
      default: return a.bottom <= b.top;
    }
  }

  /** Focus a target reached by a move: remember the move (for undo) and the column/row it sets. */
  function commit(t, from, dir, smooth) {
    setFocus(t, true, smooth);
    var r = rectOf(t.box);
    if (dir < 2 || goalX === null) {   // sideways sets the column
      goalX = r.left + r.width / 2;
      goalBox = t.box;   // a carousel still sliding it: setFocus corrects goalX once it has stopped
    }
    if (dir >= 2 || goalYDoc === null) goalYDoc = r.top + r.height / 2 + sy();   // up/down sets the row
    last = from ? { from: from, to: t.box, dir: dir } : null;
  }

  /** Forget the column, row and undo (new page area: paging, pointer, a layer, a click). */
  function resetMemory() {
    goalX = goalYDoc = goalBox = null;
    last = null;
  }

  /** Entering a group box (the episode list) from outside lands on its current item. */
  function enterGroup(best, from) {
    for (var i = 0; i < SITE.groups.length; i++) {
      var g = closest(best.box, SITE.groups[i][0]);
      if (!g || (from && g.contains(from.box))) continue;
      var items = g.querySelectorAll(SITE.groups[i][1]);
      for (var j = 0; j < items.length; j++) {
        var t = targetFor(items[j]);
        var c = { el: t.el, box: t.box, r: t.box.getBoundingClientRect() };
        if (c.r.width > 2 && usable(c, from)) return c;
      }
    }
    return best;
  }

  /** ▲ ▼ with nothing more to reach: scroll the page a bit, so text and the footer can still be read. */
  function verticalStep(dir) {
    if (dir < 2) return false;
    var before = sy();
    scrollByY(window, (dir === 3 ? 1 : -1) * vh() * 0.4, false);
    follow(300);
    return sy() !== before;
  }

  /** CH -/+: a screen up or down; the ring stays about where it was on the screen. */
  function page(direction) {
    pointer = false;
    var top = obstruction(false), bottom = vh() - obstruction(true);
    var cur = current();
    var at = cur ? rectOf(cur.box) : null;
    var cx = at ? at.left + at.width / 2 : vw() / 2, cy = at ? at.top + at.height / 2 : (top + bottom) / 2;
    if (cy < top || cy > bottom) cy = (top + bottom) / 2;
    var before = sy();
    scrollByY(window, direction * (bottom - top) * 0.85, false);
    if (sy() === before) return move(direction > 0 ? 3 : 2);
    var cands = collect(scopeRoot()), best = null, bestD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!onScreen(c.r, top, bottom) || fixedRoot(c.box)) continue;
      var d = Math.abs(c.r.top + c.r.height / 2 - cy) + 0.5 * Math.abs(c.r.left + c.r.width / 2 - cx);
      if (d < bestD && usable(c, null) && c.reach === 1) { bestD = d; best = c; }
    }
    resetMemory();
    if (best) setFocus(best, false, false);
    else { ringOn = false; place(); }
    return result('paged');
  }

  // ------------------------------------------------------------------ OK and BACK

  /** A point inside the target that really hits it (not a cover or a neighbour), in viewport CSS px. */
  function tapPoint(el) {
    var rects = el.getClientRects();
    // An inline link that wraps (a clamped title) has a big box but text only on its first line.
    var r = rects.length > 1 ? rects[0] : el.getBoundingClientRect();
    var left = Math.max(r.left, 0), right = Math.min(r.right, vw());
    var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, vh());
    if (right - left < 1 || bottom - top < 1) return null;
    var fx = [0.5, 0.3, 0.7, 0.5, 0.5, 0.15, 0.85], fy = [0.5, 0.5, 0.5, 0.3, 0.7, 0.5, 0.5];
    for (var i = 0; i < fx.length; i++) {
      var x = left + (right - left) * fx[i], y = top + (bottom - top) * fy[i];
      var hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || (hit.tagName === 'LABEL' && hit.control === el))) {
        return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  }

  function restoreKey() { return 'hitv-snap:' + location.pathname + location.search; }

  /** After OK on an opener (SITE.then), move the ring to what it opened once that shows. */
  function thenFocus(el) {
    for (var i = 0; i < SITE.then.length; i++) {
      if (!matches(el, SITE.then[i][0])) continue;
      var sel = SITE.then[i][1], tries = 0, started = false;
      var poll = function () {
        var target = document.querySelector(sel);
        if (target && sized(target)) { setFocus(targetFor(target), true, true); return; }
        if (++tries < 10) setTimeout(poll, 150);
      };
      // Look once the tap has landed (the app sends it after this returns): until then the old
      // state may still match, e.g. the first episode of the range shown before.
      var start = function () {
        if (started) return;
        started = true;
        el.removeEventListener('click', start, true);
        setTimeout(poll, 150);
      };
      el.addEventListener('click', start, true);
      setTimeout(start, 1000);   // no click seen (the page stopped it): look anyway
      return;
    }
  }

  /** If OK (on `from`) opened a layer (dialog, side menu), move the ring into it as soon as it's there. */
  function followLayer(before, from) {
    var tries = 0, lastKey = '';
    var poll = function () {
      var scope = scopeRoot();
      if (scope && scope !== before) {
        scope.__hitvOpener = from;
        // Side menus and dialogs slide in: choose only once the layer has stopped moving.
        var r = scope.getBoundingClientRect(), key = Math.round(r.left) + ',' + Math.round(r.top);
        if (key !== lastKey && ++tries < 12) {
          lastKey = key;
          holdRecoverUntil = Math.max(holdRecoverUntil, now() + 400);
          setTimeout(poll, 120);
          return;
        }
        var c = current();
        if (!c || !scope.contains(c.box)) { var st = startTarget(); if (st) setFocus(st, true, true); }
        return;
      }
      if (++tries < 8) setTimeout(poll, 150);
    };
    setTimeout(poll, 250);
  }

  function activate() {
    pointer = false;
    var cur = current();
    if (!cur) {
      var st = startTarget();
      if (!st) return { r: 'empty' };
      setFocus(st, true, true);
      return result('start');
    }
    if (!ringOn) { ringOn = true; place(); return result('shown'); }
    var el = cur.el;
    resetMemory();
    if (isPlayer(el)) return { r: 'player', d: describe(el) };
    var car = swiperOf(cur.box);
    if (car) pageSwiper(car, cur.box);
    reveal(car || cur.box, false);
    place();
    var scope = scopeRoot(), layer = scope || document.querySelector('#search.active');
    if (!layer || !layer.contains(cur.box)) opener = cur;
    // History back to this page comes back to this link (script links: the start target).
    try {
      if (isPage(el)) sessionStorage.setItem(restoreKey(), JSON.stringify({ href: el.href }));
      else sessionStorage.removeItem(restoreKey());
    } catch (e) {}
    // If the target goes away (a menu item, a button that swaps), what it opens places the ring first.
    holdRecoverUntil = now() + 1500;
    thenFocus(el);
    followLayer(scope, cur);
    var p = tapPoint(el);
    if (!p) {
      // Covered everywhere, or no hit area of its own: a plain click is the best we can do.
      try { el.click(); } catch (e) {}
      return { r: 'done', d: describe(el) };
    }
    return { r: 'tap', x: p.x, y: p.y, w: vw(), d: describe(el) };
  }

  /** BACK closes what the page has open, innermost first; the ring goes back to what opened it. */
  function back() {
    var $ = window.jQuery, closed = false, layer = scopeRoot();
    var suggest = document.querySelector('#search-suggest');
    var input = document.querySelector('#search input.search-input');
    if (suggest && sized(suggest) && document.querySelector('#search-suggest .result a')) {
      if (input) input.value = '';
      suggest.style.display = 'none';
      layer = suggest;
      closed = true;
    } else {
      var modals = document.querySelectorAll('.modal.show');
      if (modals.length) {
        try { $(modals[modals.length - 1]).modal('hide'); } catch (e) { modals[modals.length - 1].classList.remove('show'); }
        closed = true;
      } else if (document.querySelector('#sidebar_menu.active')) {
        var close = document.querySelector('#sidebar_menu .toggle-sidebar') || document.querySelector('#sidebar_menu_bg');
        if (close) close.click();
        closed = true;
      } else if (document.querySelector('.dropdown-menu.show')) {
        var dd = document.querySelectorAll('.dropdown-menu.show');
        for (var i = 0; i < dd.length; i++) {
          var toggleEl = dd[i].parentNode ? dd[i].parentNode.querySelector('[data-toggle=dropdown]') : null;
          try { $(toggleEl).dropdown('hide'); } catch (e) {}
          dd[i].classList.remove('show');
          if (dd[i].parentNode) dd[i].parentNode.classList.remove('show');
        }
        closed = true;
      } else if (document.querySelector('#search.active')) {
        var toggle = document.querySelector('#mobile_search');
        if (toggle) toggle.click();
        layer = document.querySelector('#search');
        closed = true;
      }
    }
    if (!closed && document.querySelector('#mask-overlay.active')) {
      // Light off (the page dimmed around the player): BACK turns it back on.
      var light = document.querySelector('#turn-off-light') || document.querySelector('#mask-overlay');
      if (light) light.click();
      closed = true;
    }
    if (!closed) return { r: 'none' };
    resetMemory();
    // Put the ring back on what opened the layer. Anything inside the closed layer counts as gone,
    // even while it animates out (side menu, dialogs).
    holdRecoverUntil = now() + 800;
    var to = (layer && layer.__hitvOpener) || opener;
    if (layer) layer.__hitvOpener = null;
    var c = current();
    if (c && (!layer || !layer.contains(c.box))) { place(); return { r: 'handled' }; }
    if (to && alive(to.box) && (!layer || !layer.contains(to.box))) setFocus(to, true, true);
    else {
      ringOn = false;
      place();
      setTimeout(function () { var st = startTarget(); if (st) setFocus(st, true, true); }, 400);
    }
    return { r: 'handled' };
  }

  // ------------------------------------------------------------------ pointer hand-over

  function pointerMode(on, x, y, viewWidth) {
    resetMemory();
    if (on) {
      pointer = true;
      opener = null;   // what the pointer opens has no opener; layers it opens get one on the first move in
      place();
      var cur = current();
      if (cur) {
        var r = rectOf(cur.el);
        if (onScreen(r, 0, vh())) return { r: 'pointer', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: vw() };
      }
      return { r: 'pointer' };
    }
    pointer = false;
    if (viewWidth > 0) {
      var k = vw() / viewWidth;
      var hit = document.elementFromPoint(x * k, y * k);
      var el = hit ? closest(hit, SEL) : null;
      if (!el && hit) {
        for (var n = hit; n && n.nodeType === 1 && !el; n = n.parentElement) if (extraTargets.indexOf(n) >= 0) el = n;
      }
      if (el && el !== ring) {
        var t = targetFor(el);
        var c = { el: t.el, box: t.box, r: t.box.getBoundingClientRect() };
        if (usable(c, null)) adopt(c);
      }
    }
    if (current()) { ringOn = true; place(); }
    return { r: 'snap' };
  }

  // ------------------------------------------------------------------ page life

  /**
   * The page re-rendered the focused element: take its stand-in (same link, same place) if there is one.
   * After a miss, tries again only once the page has changed (it runs twice a second).
   */
  function recover() {
    if (current() || !lastDoc) return;
    if (recoverGen === cacheGen && !cacheDirty) return;
    // The player was swapped (next episode, another server): the new one takes over, in theater too.
    if (focusEl && focusEl.tagName === 'IFRAME' && window.__hitvFindPlayer) {
      var p = window.__hitvFindPlayer();
      if (p && p !== focusEl && alive(p)) { adopt({ el: p, box: p }); place(); return; }
    }
    var r = fromDoc(lastDoc), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var href = focusEl && focusEl.href, cands = collect(scopeRoot()), near = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var d = Math.abs(c.r.left + c.r.width / 2 - cx) + Math.abs(c.r.top + c.r.height / 2 - cy);
      if (href && c.el.href === href) d -= 40;
      if (d < 80) near.push({ c: c, d: d });
    }
    near.sort(function (a, b) { return a.d - b.d; });
    for (var j = 0; j < near.length; j++) {
      if (usable(near[j].c, null)) { adopt(near[j].c); place(); return; }
    }
    recoverGen = cacheGen;
    if (ring) ring.style.display = 'none';
  }

  /** On a fresh page: back to the link you opened from here (history back), else the start target. */
  function autoStart() {
    if (pointer || userMoved) return;
    if (current()) {
      // Already on an automatic start: switch if a better one has arrived since (the ajax player).
      var better = rankedStart(startRank);
      if (better) { setFocus(better.c, false, false); startRank = better.rank; }
      return;
    }
    var saved = null;
    try {
      var nav = window.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
      if (!nav || nav.type === 'back_forward' || nav.type === 'reload') saved = JSON.parse(sessionStorage.getItem(restoreKey()) || 'null');
    } catch (e) {}
    if (saved && saved.href) {
      var links = document.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].href !== saved.href) continue;
        var t = targetFor(links[i]);
        var c = { el: t.el, box: t.box, r: t.box.getBoundingClientRect() };
        if (c.r.width > 2 && usable(c, null)) { setFocus(c, true, false); startRank = -1; return; }
      }
    }
    var ranked = rankedStart(99);
    if (ranked) { setFocus(ranked.c, false, false); startRank = ranked.rank; return; }
    var st = startTarget();
    if (st) setFocus(st, false, false);
  }

  /** The best SITE.start target on screen ranked above `than`, as {c, rank}. */
  function rankedStart(than) {
    var top = obstruction(false), bottom = vh() - obstruction(true);
    if (scopeRoot()) return null;
    for (var i = 0; i < Math.min(than, SITE.start.length); i++) {
      var els = document.querySelectorAll(SITE.start[i]);
      for (var j = 0; j < els.length; j++) {
        var t = targetFor(els[j]);
        var c = { el: t.el, box: t.box, r: t.box.getBoundingClientRect() };
        if (c.r.width > 2 && onScreen(c.r, top, bottom) && usable(c, null) && c.reach === 1) return { c: c, rank: i };
      }
    }
    return null;
  }

  window.addEventListener('scroll', function (e) {
    // The page's own scroll carries the ring; boxes scrolling inside it (the episode list) don't.
    if (ringOn && e.target !== document && e.target !== window) follow(400);
  }, true);
  window.addEventListener('resize', function () { if (ringOn) follow(400); }, false);
  setInterval(function () {
    // Early on, keep looking for a better start (the player shows up behind a spinner first).
    if (!userMoved && !pointer && now() - installedAt < 10000) autoStart();
    if (!ringOn || pointer) return;
    if (!current()) { if (now() > holdRecoverUntil) recover(); }
    else place();
  }, 500);
  setTimeout(autoStart, 1200);
  window.addEventListener('load', function () { setTimeout(autoStart, 400); }, false);

  window.__hitvSnap = function (cmd, a, b, c) {
    // The app gave up waiting for this call (the page was busy): it already handled the key its own way.
    if (cmd !== 'pointer' && cmd !== 'info' && window.__hitvSnapBy && now() > window.__hitvSnapBy) return { r: 'late' };
    var out;
    try {
      if (cmd === 'move') out = move(a);
      else if (cmd === 'page') out = page(a);
      else if (cmd === 'activate') out = activate();
      else if (cmd === 'back') out = back();
      else if (cmd === 'pointer') out = pointerMode(!!a, b, c, arguments[4]);
      else if (cmd === 'info') return result('info');
      else return { r: 'unknown' };
    } catch (e) {
      out = { r: 'error', m: String(e && e.message || e) };
    }
    // A first press that only put the ring on a start target isn't a choice yet: a better start that
    // arrives later (a slider built by script, the ajax player) may still take over.
    if (!out || (out.r !== 'start' && out.r !== 'shown' && out.r !== 'empty')) userMoved = true;
    return out;
  };
})();
