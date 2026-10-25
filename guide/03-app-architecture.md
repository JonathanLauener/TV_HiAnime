# 03 — App architecture and why

One activity, one full-screen `android.webkit.WebView`, framework APIs only (no AndroidX), min SDK 21,
target 34, compiled against android-35. Pure Java, no native code, so a single APK runs on 32-bit ARM
TV chips and x86_64 emulators alike.

Reference files (line numbers checked against the final code, 2026-10-25):

| File | Role |
|---|---|
| `src/tv/hianime/wrapper/MainActivity.java` (1137 lines) | WebView setup, navigation/pop-up guard, service-worker kill switch, remote control, pointer timing, fullscreen, lifecycle, debug hooks |
| `src/tv/hianime/wrapper/AdBlocker.java` (153) | Request blocking: curated list → URL patterns → hosts list, plus `NEVER_BLOCK`; empty-200 and 204 replies |
| `src/tv/hianime/wrapper/CursorView.java` (91) | Drawn pointer overlay (never focusable or clickable) |
| `assets/inject.js` (259) | ES5 page script: dead `window.open`, SW neutraliser, TV viewport, ad CSS + overlay sweeper, player finder/commands, theater mode, playback tracking |
| `assets/adblock/curated.txt` | Site-specific ad/tracker domains from the evidence ledger |
| `assets/adblock/hosts.txt` | StevenBlack unified hosts snapshot (domains only, required hosts removed) |
| `AndroidManifest.xml` | TV launcher integration, `<uses-sdk>` (also read by lint) |

```
┌──────────────────────── FrameLayout root ────────────────────────┐
│ WebView (site)          ← Client: guard + intercept + inject      │
│ FrameLayout fullscreen  ← holds onShowCustomView's view           │
│ CursorView              ← pointer, drawn only                     │
│ TextView osd / help     ← transient messages, controls card       │
└───────────────────────────────────────────────────────────────────┘
```

## 1. Network ad defence

All page subresources and service-worker fetches go through `intercept()` (MainActivity.java:430),
which answers the site's `/sw.js` itself (below) and otherwise asks `AdBlocker.shouldBlock`
(AdBlocker.java:88).

| Layer | What | Why |
|---|---|---|
| 0. `NEVER_BLOCK` (AdBlocker.java:37) | Site, player hosts, `anilist.co`, `myanimelist.net`, `jsdelivr.net`, `jquery.com`, `jwpcdn.com`, `jwplayer.com`, `challenges.cloudflare.com`, `www.gstatic.com` | Wins over everything; protects against list false positives |
| 1. `curated.txt` | Domains from the evidence ledger (suffix match that stops at the registrable domain, `matchesSuffix` :127) | This is what actually removes this site's ads |
| 2. `AD_PATH` / `AD_QUERY` (:43, :50) | Ad loader paths that stay fixed while domains rotate (`/tag.min.js`, `/mt/3p.js`, `/gid.js`, `/<d>/<6+ digits>/`, `/<11 alnum>/<5–7 digits>`, `/pfe/current/`, `js_build=iclick`) | Survives domain rotation |
| 3. `hosts.txt` | ~71k general ad/malware domains, loaded on a background thread (:66) | Backstop; **skipped when `MEDIA_PATH` (:53) matches** (`.m3u8/.ts/.vtt…`, `/seg-N`, `/anime/<hash>/`) so a false positive can't break video |

Replies:
- Blocked **subresource**: `emptyResponse()` (AdBlocker.java:111), an empty **HTTP 200** with
  `Access-Control-Allow-Origin: *`. A 4xx/onerror makes loaders retry other domains or trip anti-adblock
  walls; an empty success just does nothing.
- Blocked **main-frame navigation**: `stayOnPageResponse()` (:122), **HTTP 204**. The browser stays on the
  current page; an empty 200 had replaced the page with a blank document.

`setListsEnabled(false)` (:75) turns layers 1–3 off. It's only reachable from debug builds
(`--ez no_blocklist true`, MainActivity.java:163) and exists to test the behaviour guards in §2 on their own.

### Service worker: neutralised

The site's PWA worker (`/sw.js`, a network-first passthrough) stalled a cold-start navigation in testing
(200 OK, 0 bytes, `readyState` stuck at `loading`). Four pieces:

| Piece | Where |
|---|---|
| `navigator.serviceWorker.register` stubbed to reject | inject.js:13 |
| Existing registrations unregistered | inject.js:48 |
| App answers `/sw.js` on a site host with a kill-switch worker (`skipWaiting`, then `registration.unregister()`, no fetch handler) | `SW_KILL_SWITCH` MainActivity.java:426, served in `intercept` :431 |
| `ServiceWorkerController` client (API 24+) runs the same `intercept()` for any worker fetch | MainActivity.java:320 |
| 30 s stall watchdog: a page whose `documentElement.innerHTML` is still empty gets **one** reload per URL | `stallCheck` :536, scheduled in `onPageStarted` :474 |

## 2. Behaviour-based pop-up and redirect defence (domain-agnostic)

Verified with the blocklists **disabled** (debug `--ez no_blocklist true`): `location.href`, `intent:`,
POST form, off-site `target=_blank` and the about:blank-iframe `window.open` were all blocked.

| Vector | Defence | Where |
|---|---|---|
| `window.open`, incl. the fresh-`about:blank`-iframe `contentWindow.open` fallback | `setSupportMultipleWindows(true)` + `setJavaScriptCanOpenWindowsAutomatically(false)` route every new window to `onCreateWindow`. It hands the page a **probe WebView** whose fetches are all answered empty (:609), reads its first http(s) URL, and loads it in the main view **only** if it's a main-site host **and** a user gesture; otherwise "Blocked a pop-up". A 5 s timer disposes it (:618). The probe handles `onRenderProcessGone` (:590): all WebViews share one renderer, and an unhandled exit would kill the app on API 26+. | MainActivity.java:299, :564 |
| `location.href = adUrl` (anchor-click hijack, mouseout exit redirect) | `guardNavigation` (:366): the main frame may show only `mainHosts` (plus the sign-in rule below). Non-http schemes (`intent:`, `market:`, …) are blocked in the main frame; frames may use only `about:`/`blob:`/`data:`/`javascript:` | `Client.shouldOverrideUrlLoading` :440 |
| `form.submit()` POST navigations (never reach `shouldOverrideUrlLoading`) | `shouldInterceptRequest` with `isForMainFrame()` to a host that is neither a site nor an auth host → **204** | :452–459 |
| Cleartext site URLs | Main-frame `http://` on a site host is re-requested as `https://` | :382 |
| Site moves to a new domain | Learned only from an **https server redirect off a known site host** to a host matching `SITE_DOMAIN` `^(www\.)?hianime[a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2})?$`; persisted as `main_hosts` | `SITE_DOMAIN` :60, :390, `rememberMainHost` :340 |
| Social sign-in | `AUTH_HOSTS` (`discord.com`, `accounts.google.com`, `myanimelist.net`, `anilist.co`) are allowed in the main frame **only** via a redirect from the site's `/auth/social/…`, or while already on a provider. `pendingMainUrl` tracks where the current navigation came from (set on allowed navigations, reset in `onPageStarted` :468). Verified: AniList sign-in reaches `anilist.co/login`; a direct ad-style jump to a provider stays blocked. | `AUTH_HOSTS` :63, :396–409, `isAuthHost` :416 |

Feedback goes to the OSD, rate-limited to one notice per 4 s (`noteBlocked` :354).

## 3. Injected page script (`assets/inject.js`, ES5 on purpose)

### Injection schedule
`inject()` (MainActivity.java:546) runs `window.__hitvViewport=<n>;` plus the script at
`onPageStarted`, **+0.5 s**, **+1.5 s** (`injectRunnable` :532, scheduled :471–473) and `onPageFinished`
(:480). Injection is **main frame only**: `evaluateJavascript` can't reach cross-origin iframes. Without
AndroidX there's no document-start injection, so the network layer is the first defence and this is the second.

**Guard rule (a bug fixed in review).** The cheap, repeatable parts (dead `window.open`, SW stub, viewport
refresh) run on every injection. `window.__hitv` is set **only once `document.documentElement` exists**
(inject.js:20–22). An early injection used to crash before the root element existed while setting the guard
anyway, so the CSS and sweeper never installed.

| Part | inject.js | Purpose |
|---|---|---|
| Dead `window.open` | :5, :9 | Returns a fake closed window so ad scripts don't retry or crash |
| SW neutraliser | :13, :48 | See §1 |
| TV viewport | :32 (`fixViewport`), :56–57, re-run on every injection (:20) and when a `<meta>` is added (:149) | See §4 |
| CSS | :62 | Hides in-HTML ad slots (`.aniwatch-banner-wrap` promo, `ins.adsbygoogle`, share widget); **`body>`/`html>` children with an inline `z-index: 2147483…` → `display:none`** (:69–70); focus ring; theater-mode rules (:76–80) |
| Overlay sweeper | `isAdOverlay` :96, `sweep` :104, MutationObserver :140, `sweepTop` every 2 s :157 | Removes `position:fixed/absolute` elements with computed `z-index ≥ 2147483000` (`OVERLAY_Z` :26) among added nodes and top-level children; skips `data-hitv` and the fullscreen element. **No size check:** the popunder's interstitial is mounted at 0×0 and grown later via inline style. Verified with a synthetic 0×0-then-grown overlay. |
| Player finder | `findPlayer` :116 | `.player-frame iframe` → first iframe on a `PLAYER_ORIGIN` (:24) → largest non-overlay iframe ≥ 40 000 px² |
| Player commands | `window.__hitvCmd` :206 | §7 |
| Theater mode | `window.__hitvTheater` :240, `keepTheaterTarget` :133 | §6 |
| Playback tracking | message listener :163, `window.__hitvRecentlyPlaying` :259 | §8 |

ES5 because the TV may run an old WebView. The site itself needs a modern one (05 §6).

## 4. TV layout: desktop width, pinned scale

The app passes `window.__hitvViewport=1280` (`TV_LAYOUT_WIDTH` MainActivity.java:58) **only when
`UiModeManager` reports `UI_MODE_TYPE_TELEVISION`** (:168–170); phones and tablets get `0` and keep the site's
own viewport. `fixViewport` (inject.js:32) then rewrites the last `<meta name=viewport>` to

```
width=1280, initial-scale=S, minimum-scale=S, maximum-scale=S      S = screen.width / 1280
```

On a 1080p xhdpi TV, `screen.width` is 960 CSS px, so S = 0.75: the site's **desktop** layout (episode list,
player with its control bar, server buttons) fits on one screen.

**Why pin the scale:** WebView sized the page for its first, empty layout (980 px) and, with zoom disabled,
never refit when the viewport changed later. Pinning initial = min = max forces the right scale.

## 5. WebView settings worth copying (`configureWebView` MainActivity.java:288)

- JS, DOM storage, database on; `setMediaPlaybackRequiresUserGesture(false)`.
- Wide viewport + overview mode; zoom off (the scale comes from §4).
- `MIXED_CONTENT_COMPATIBILITY_MODE`; file/content access off; geolocation off; permission requests denied (:658).
- UA: strip `; wv` and `Version/x.y` so players that refuse WebViews see plain Chrome (:306).
- Third-party cookies on: the player iframes keep their own state (:310).
- **No `addJavascriptInterface`**: nothing native is exposed to page or ad frames. Playback state is polled instead (§8).
- `getDefaultVideoPoster` returns a 1×1 bitmap: no grey play-icon placeholder (:653).
- Remote debugging only in debug builds (`BuildConfig.DEBUG`, :175).

### Renderer crash handling (`onRenderProcessGone` :497)
- Rebuilds the WebView instead of letting the app die (`recreateWebView` :513).
- **Crash-loop guard:** the same URL crashing twice within 60 s → `last_url` is set to home and the OSD says so (:502–508).
- In the background, the WebView is rebuilt but **not loaded** until `onResume` (`pendingLoad`, :522–523, :1359).

### Error page (`showError` :553)
The failing URL goes, HTML-encoded, into a `data-u` attribute. The button's `onclick` is a constant
(`location.replace(this.getAttribute('data-u'))`), so no URL text is ever spliced into script.

## 5b. Remote control: the pointer (the fallback since 1.1)

Since 1.1 the D-pad drives **snap navigation** (§5c) by default. The pointer below is still there for
anything snap can't reach: hold OK for 600 ms (`LONG_PRESS_MS` :78) and it appears where the focus ring was; after
10 s without a key it hides and the D-pad snaps again, from the element under the pointer.

### Rendering and input routing
- `CursorView` draws a 1.4× density arrow (CursorView.java:23); it is not focusable or clickable.
- `dispatchKeyEvent` (MainActivity.java:766) intercepts the D-pad. An Activity sees keys **after** the IME,
  so the on-screen keyboard still gets the D-pad while it's open.
- OK = synthetic **touch**: `ACTION_DOWN` on key-down, `ACTION_UP` on key-up, `ACTION_MOVE` while moving
  (drag works for seek bars) (`touch` :1206). Dispatched to the fullscreen custom view if one is showing, else the
  WebView, with coordinates translated via `getLocationOnScreen` (`dispatchTouch` :1220).

### Timing model (distance from hold time, never from frame count)
Speed ramps quadratically from `SPEED_MIN` 2.5 to `SPEED_MAX` 20 dp per 16 ms frame over `SPEED_RAMP_MS` 1 s
(:66–69). Distance is the **integral** of that ramp (`travelFor` :1131):

```
t ≤ 1000 ms:  dp = (2.5·t + 17.5·t³ / (3·1000²)) / 16
t > 1000 ms:  dp = (2.5·1000 + 17.5·1000/3 + 20·(t − 1000)) / 16          (t clamped to ≥ 40 ms)
px = dp × density
```

| Rule | Where | Why |
|---|---|---|
| Shortest tap counts as 40 ms → ~6 dp | `travelFor` :1132 | A tap always moves visibly |
| On key-down, `heldSince = max(downTime, now − 300 ms)` (`MAX_INPUT_LAG_MS` :71) | :916 | Bogus or stale `downTime` stamps can't produce jumps |
| While held, the mover counts only time it saw itself, **≤ 50 ms per frame** (`MAX_FRAME_GAP_MS` :72) | `mover` :1140–1158 | A stalled UI thread never turns into a jump |
| On key-up, top the distance up to `travelFor(min(eventTime, now) − heldSince)` | :925–1126 | Queued key events behind a busy UI thread still move the distance the hold time says |

Measured on the emulator with the debug key-replay hook (05 §3): 30 ms → 16 px, 200 → 68, 300 → 113,
900 → 813, and 200 ms with a 500 ms UI stall → 68 (no jump).

### Scrolling and hiding
- Pushing past an edge accumulates scroll (`movePointer` :1171), flushed every 48 ms (`flushScroll` :1187)
  through `SCROLL_JS` (:87). That script runs `elementFromPoint` at the pointer, scrolls the nearest scrollable
  ancestor that actually moves, and falls back to `window.scrollBy`. Coordinates are scaled by
  `innerWidth / view width`, so it stays correct under the §4 scale. CH+/−, PgUp/PgDn scroll 80% (`scrollPage` :1200).
- The pointer auto-hides after 10 s browsing / 3 s over video (`HIDE_POINTER_*` :73, `pointerIdleCheck` :1256).
  Hiding it while browsing hands the D-pad back to snap mode (`resumeSnap` :1241), focused on what the
  pointer was over. Over a video, ▲ ▼ bring it back (below).

### Player mode
When fullscreen (custom view) or theater is active **and** the pointer is hidden (`onNavKey` :870, :884–895):
OK = play/pause, ◀ ▶ = seek ∓10 s (every 3rd key repeat), ▲ ▼ = bring the pointer back to reach the
player's own buttons.

### Key map (`dispatchKeyEvent` :766)

| Key | Action |
|---|---|
| D-pad | snap: move the focus ring (§5c). Pointer mode: move the pointer |
| OK | snap: open the focused item **on release**; **hold** 600 ms → pointer. On the video: theater mode + play. Pointer mode: click (drag while held) |
| BACK | snap: first let the page close what it has open (search suggestions, dialog, side menu, dropdown, search box, light-off; `snap.js back()`). Then: cancel drag → leave fullscreen → leave theater → history back, **skipping the watch page's pushState episode entries** (`backSteps` :1278) → "press again to exit" (`onBackKey` :1289) |
| CH +/−, PgUp/PgDn | snap: a screen up/down, the ring stays about where it was on screen. Pointer mode: scroll 80% |
| any key while the help card is open | **only closes the card** (BACK included) (:773–776) |
| Play/Pause | toggle |
| **Play**, **Pause** (separate keys on Sony remotes) | **idempotent** play / pause (:782, :785; §7) |
| FF / RW | seek ±10 s (holding repeats) |
| Next / Prev | seek ±60 s |
| Stop | leave fullscreen/theater |
| RED (and MENU) | theater on/off (or leave fullscreen) (:803) |
| GREEN | home |
| YELLOW | reload |
| BLUE | skip 85 s (intro) |
| INFO / HELP | controls card with a live "Ads and trackers blocked this session" count (`showHelp` :266, `refreshHelp` :257) |

BACK skip, verified: `?ep=87189` → `/home` in one press. Colour keys are used because Sony BRAVIA remotes
have no app-visible MENU key (Action Menu is a system overlay). The help card shows once on first launch, and
once more after the update to 1.1 (`help_seen_v11`), because the controls changed.

## 5c. Remote control: snap navigation (the default since 1.1)

A mouse pointer on a TV remote is slow: every link is a drive across the screen. Snap navigation works like
YouTube TV: the arrows jump a **focus ring** to the next thing you can click in that direction, OK opens it.
Java owns the keys and the input it sends to the page; `assets/snap.js` (ES5, injected right after
`inject.js`) decides what is focusable, which target is next, and draws the ring. They talk only through
`evaluateJavascript` return values: still no `addJavascriptInterface` (§5).

### Why not WebView's own spatial navigation
WebView already turns Blink's spatial navigation on by default on devices **without a touchscreen**
(`AwSettings`: `mSpatialNavigationEnabled = !hasSystemFeature(FEATURE_TOUCHSCREEN)`), i.e. on TVs; there is no
public switch. It is not usable here (verified in Chromium 153 with `--enable-spatial-navigation`): it skips
off-screen targets and scrolls 40 px per press, focuses a fixed header after scrolling under it, can't reach
clipped carousel slides, and never focuses cross-origin iframes (the player). So the app consumes the D-pad and
the page never sees arrow keys.

### Java side (`onSnapKey` :944)

| What | How | Why |
|---|---|---|
| Arrows | `__hitvSnap('move', dir)`; one call in flight, presses that come meanwhile (arrows, OK, CH ±) wait **in order**, at most 4 (`snapSend` :1007); held keys step at most every 120 ms (`SNAP_REPEAT_MS` :80), only a held key's latest repeat waits, and waiting repeats are dropped on key-up (`dropSnapRepeats` :1032) | The page answers slower than the TV repeats keys (50 ms): no extra move after letting go, but a quick ▼ ▼ OK still moves twice and then clicks |
| OK | click on **release**: `activate` returns `{r:'tap', x, y, w}` (viewport CSS px + `innerWidth`); `tapWeb` :1115 sends a real touch down/up (40 ms) at `x·viewWidth/w`. Busy until the up is sent (`snapActivate` :1049) | A real input event carries user activation: same-site `target=_blank` passes the pop-up probe's `isUserGesture` (§2), text fields open the on-screen keyboard, the Fullscreen API works. A press right after OK can't scroll the page under the tap |
| Hold OK | after 600 ms: `__hitvSnap('pointer', true)` returns the focus centre, the pointer appears there, the release is swallowed (`okLongPress` :985). A press whose release comes after the mode changed (theater started, pointer shown) is neither a click nor a hold (`disarmOk` :974) | Fallback for anything snap can't reach (the player's own controls, odd widgets) |
| OK on the video | `{r:'player'}` → theater mode (§6) + idempotent PLAY (§7); busy until the page has switched theater on (`setTheater(on, after)`) | One press from the episode list to a filled screen; a quick ▼ after it can't move the ring under the video |
| BACK | `__hitvSnap('back')` first; only if it answers `none`, the usual `onBackKey` | Closing the open layer is what a TV user expects from BACK |
| CH ± | `__hitvSnap('page', ±1)` (`scrollPage` :1200) | |
| Loading page (no snap.js yet → `null`) | ▲ ▼ scroll a quarter screen (`onSnapMoved` :1038) | The remote never feels dead |
| No answer within 1.5 s (`SNAP_TIMEOUT_MS` :84: a hung page, a WebView rebuilt after a renderer crash) | `snapCall` :1076 answers `SNAP_TIMED_OUT` itself: the arrows unlock, BACK falls through to `onBackKey`. Each call carries a deadline (`window.__hitvSnapBy`); a call the page reaches after it answers `{r:'late'}` without acting | v1.0's BACK never depended on the page; a press given up during a busy page load must not still move the ring a second later |
| Pointer shown, theater or fullscreen starts | presses still waiting are dropped (`cancelSnapInput` :980) | They were meant for the ring |
| Leaving fullscreen/theater | back to snap, ring on the video (`resumeSnap(false)`) | Was: pointer reappears |
| Page loads while the pointer shows | `inject()` prefixes `window.__hitvPointer=true`, so snap.js keeps its ring off | |

### Page side (`assets/snap.js`)

**Targets.** `a[href]`, buttons, inputs, ARIA roles, `[tabindex]`, `[onclick]`, the player iframe, `SITE.extra`,
plus an **idle-time scan** for the outermost elements with `cursor:pointer` that aren't links or buttons (the
site's div buttons: Light / Auto Play toggles, the search opener, the episode-range picker). That is Blink's own
spatial-navigation heuristic. The scan runs in `requestIdleCallback` slices of 300 elements and again 1.5 s after
the DOM changes. The query result is cached until a `MutationObserver` sees nodes added or removed.
A **card** (`SITE.card`) is one stop: the ring frames the card, OK taps `SITE.cardMain` (the poster link).

**Choosing the next target** (`move`):
- Android `FocusFinder` rules: `isCandidate`, beam first (`beamBeats`), then `13·major² + minor²`.
- The minor axis is measured from a remembered **column** (`goalX`, set by sideways moves) or **row** (`goalY`, in
  page coordinates) to the candidate's span, so passing a wide element doesn't lose your grid column.
- **Sideways stays in the row:** a left/right candidate must overlap vertically or be within half the origin's
  height; otherwise the row ends (no diagonal jumps into the next section).
- **The opposite key undoes the last move** (down then up returns to the same card), unless a target lies between
  here and where the move came from: Left from the player lands on the current episode, Right then takes the next
  episode, not the player.
- Targets **off to the side** of the screen (a closed side menu at x < 0) are dropped before the comparison unless a
  carousel or a sideways scroll box can bring them in. `FocusFinder`'s comparison isn't transitive: a dead candidate
  could beat the real best one and then lose to a worse one.
- **Fixed bars** (headers, floating buttons) are reached only by ▲ ▼ and only when the content has nothing in that
  direction.
- Entering a **group** (`SITE.groups`: the episode list) from outside lands on its current item.
- Expensive checks run only on the winner, in this order: `SITE.skip`, foreign `target=_blank` links (dead in
  this app), `reach()` (hidden by style or opacity; clipped by an `overflow:hidden` box = unreachable, by a
  scroll box = reachable, by a carousel = reachable by sliding, even when boxes around the carousel clip it too),
  wrappers lose to targets inside them, and `covered()` (3 `elementFromPoint` probes in the part that shows: a
  card peeking in at the screen edge or an item at a scroll box's edge counts; a suggestion list or dialog over it
  rejects it).

**Scrolling** (`reveal`) is done by hand, **never `scrollIntoView()` or `focus()`**: both scroll the
`overflow:hidden` box of a Swiper carousel itself (verified), which leaves the carousel misaligned for good.
Scroll boxes around the target are scrolled minimally, then the page so the target sits in a comfort band
(centred if it was outside). Single presses scroll smoothly, held keys instantly.
- **Long text** between here and the next target (gap > 0.6 screen, target not yet visible): scroll 0.55 screen
  instead of jumping. Once the focus is off-screen, the next press searches from the screen edge it went off at,
  in its column; pressing back towards it scrolls back and lands on it.
- **Carousels** (Swiper; the instance is `el.swiper`): `slideTo` / `slideToLoop` brings the target slide fully into
  view; the ring follows the slide. Autoplay is stopped while the ring is inside, started again when it leaves.

**Layers.** While a dialog (`.modal.show`), the side menu (`#sidebar_menu.active`), a dropdown
(`.dropdown-menu.show`) or any full-screen fixed layer with targets is open, the ring stays inside it. After an OK
that opens one, the ring moves in once it has stopped animating. BACK closes it and returns the ring to what opened
it: each layer keeps its own opener (the OK that opened it, else where the first move into it came from), and OKs
inside the layer don't change it. `SITE.then` moves the ring to what an opener opens: the search box, the player
after an episode, Less after More, an episode range's first episode. It looks only once the tap has landed (a
`click` listener), so the old state can't match first.

**The ring** is one `div[data-hitv=ring]` on `<html>`: positioned in page coordinates for page content (the
compositor scrolls it with the page, no per-frame script on a slow TV) and in screen coordinates for fixed layers.
`requestAnimationFrame` only follows inner scroll boxes, carousels and transitions. Hidden in theater mode.

**Start and return.** On a fresh page the ring goes to the first on-screen `SITE.start` match: the player, else
the current episode on watch pages, the spotlight's Watch Now on /home, Watch now on a detail page, the first card
on lists. For 10 s, until the first key, a better-ranked start that arrives later (the player is built by ajax)
takes over; a first press that only put the ring on a start target (`{r:'start'}`, e.g. before the slider was
built) doesn't stop that. After history back (or a reload), the ring returns to the link you opened from that page
(`sessionStorage`; page links only, an OK on a script link clears it).

**Lost focus** (the page re-rendered it): `recover()` takes a usable stand-in within 80 px of where it was; a
swapped player (next episode, other server) takes over directly, also in theater mode. After an OK it waits 1.5 s,
so what the OK opens places the ring first. After a miss it tries again only once the DOM has changed (it is polled
twice a second, and a full candidate scan on the TV shares the main thread with the player).

**Cost** (the watch page: 12 000 elements, 1 900 candidates of which 1 500 are hidden episode pages): a move takes
~18 ms on a desktop CPU and 85–110 ms with Chrome's 6× CPU throttling (190 ms before the query cache).

**Site knowledge** lives in the `SITE` table at the top of `snap.js` (extra targets, skips, layers, start targets,
cards, groups, openers). Everything else is generic.

## 6. Fullscreen and theater mode

- `onShowCustomView` (:631) puts the fullscreen view in `fullscreen`, hides the WebView, keeps the screen on,
  hides the pointer and shows a hint. `onHideCustomView` (:648) tears down. BACK calls `leaveFullscreen`
  (:693): idempotent teardown, then `CustomViewCallback.onCustomViewHidden()`.
- The site creates the player iframe with `allow="… fullscreen …" allowfullscreen`; jwplayer's own fullscreen
  button reaches `onShowCustomView`. A pointer click is a real input event and carries the user activation the
  Fullscreen API needs. `evaluateJavascript` does not.
- **Theater mode** (`setTheater` :712 → `window.__hitvTheater` inject.js:240) needs no Fullscreen API. It adds
  `html.hitv-theater` and marks the player `data-hitv="theater"`. The CSS (inject.js:76–80) makes **everything
  invisible** with `visibility:hidden` (which, unlike `display` or `opacity`, a descendant can switch back) and
  shows only the marked iframe, fixed at 100vw×100vh.
  - **Off is unconditional:** removes the class and every mark, even if the site swapped the player.
  - **Re-targets:** when the site replaces the iframe (new episode/server, auto-next), `keepTheaterTarget`
    (:133) marks the new one. Verified.
  - Untested edge: an ancestor with `transform`/`filter` would make `position:fixed` relative to that ancestor.

## 7. Player control protocol

Read from the player's shipped `handle-bridge.min.js` (megaplay.buzz and vidtube.site). The iframe accepts
object or JSON-string messages from the parent page, without an origin check:

| Message | Effect |
|---|---|
| `{cmd:'PLAY_TOGGLE'}` | play if paused, else pause |
| `{cmd:'SEEK', value:N, skip:true}` | seek **relative** by N s |
| `{cmd:'SEEK', value:T}` | seek absolute to T s |
| `{cmd:'MUTE'}` | toggle mute |
| `{cmd:'GET_TIME'}` | replies `{event:'CURRENT_TIME', time, duration, …}` |

Native `player()` (MainActivity.java:737) calls `window.__hitvCmd(cmd, value)` (inject.js:206), with
cmd ∈ `PLAY_PAUSE | PLAY | PAUSE | SEEK | MUTE`. The return value says what happened:

| Return | Case | Behaviour |
|---|---|---|
| `bridge` | player on a `BRIDGE_ORIGIN` (inject.js:25) | Posts one object message. `PLAY`/`PAUSE` first run `probePlaying` (:178): `GET_TIME` twice, 500 ms apart, 800 ms timeout each; toggle only if the state differs. Verified against jwplayer state: pause, pause → paused; play, play → playing. |
| `frame` | other player iframe | Focuses it; native code sends the key a desktop user would press (Space, ←/→) to the WebView/custom view (:742–746) |
| `noop` | other player, `PLAY`/`PAUSE` already in that state (from its progress messages, §8) | nothing |
| `video` | no iframe, `<video>` in the page | Drives the element directly |
| `none` | nothing found | OSD "No video player on this page" |

Send **one** message form per command, never object and string both: the bridge accepts both, so a toggle
would fire twice.

## 8. Keep the screen awake

- `inject.js` tracks playback-time advances **only from `PLAYER_ORIGIN` frames** (:163–175), using the message
  shapes the site's own `watch.min.js` parses: `{type:'progress', payload:{currentTime}}`,
  `{type:'watching-log', currentTime}`, `{event:'time'|'CURRENT_TIME', time}`.
- `__hitvRecentlyPlaying()` (:259) is true if the time advanced within 45 s.
- The app polls it every **20 s while resumed** (`awakePoll` MainActivity.java:669, started in `onResume` :1360–1361,
  stopped in `onPause` :1367) → `FLAG_KEEP_SCREEN_ON` for 60 s (`keepAwake` :683).
- Fullscreen sets the flag for its duration; remote player commands and theater add 120 s.

## 9. Android TV manifest requirements (`AndroidManifest.xml`)

| Requirement | Line |
|---|---|
| `<uses-sdk minSdkVersion="21" targetSdkVersion="34"/>`: without it, **lint assumes min SDK 1** | :7 |
| `android.software.leanback` `required="false"` | :13 |
| `android.hardware.touchscreen` `required="false"` (TVs have none) | :14 |
| `android:banner="@drawable/banner"`: **320×180** PNG in `drawable-xhdpi` | :19 |
| `usesCleartextTraffic="true"`, `largeHeap="true"`, `allowBackup="false"` | :21–24 |
| `launchMode="singleTask"`, `configChanges=…` so remote/keyboard/uiMode changes don't recreate the WebView | :29–30 |
| `<category android:name="android.intent.category.LEANBACK_LAUNCHER"/>` (keep `LAUNCHER` too) | :35 |

## 10. State

| Key | Written | Read |
|---|---|---|
| `last_url` | `onPageFinished` (:482: TV apps are often killed without `onPause`), `onPause` (:1369), crash handler | `onCreate` (:179), `loadLastUrl` (:526) |
| `main_hosts` | `rememberMainHost` (:340) | `onCreate` (:173) |
| `help_seen` | first launch (:183) | |

Cookies are flushed in `onPause` (:1370).

## 11. Debug-only hooks (stripped of effect in release: `BuildConfig.DEBUG`)

| Hook | Where |
|---|---|
| `--ez no_blocklist true`: lists off, behaviour guards still on | :163 |
| `--es keytest "R200,D200,L300,R900,L200j500"`: replays D-pad presses with real timestamps (dir + hold ms; `jN` blocks the UI thread N ms) | `handleDebugIntent` :1328, also via `onNewIntent` :1318 |
| Log lines `dispatch …`, `key …`, `pointer at x,y`, `release <dir> held=…ms travelled=…px`, `blocked <url>`, `nav … redirect= from=` | :770, :880, :1162, :932, AdBlocker.java:105, :357 |
| WebView remote debugging | :153 |
