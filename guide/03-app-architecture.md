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

All page subresources and service-worker fetches go through `intercept()` (MainActivity.java:407),
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
(`--ez no_blocklist true`, MainActivity.java:142) and exists to test the behaviour guards in §2 on their own.

### Service worker: neutralised

The site's PWA worker (`/sw.js`, a network-first passthrough) stalled a cold-start navigation in testing
(200 OK, 0 bytes, `readyState` stuck at `loading`). Four pieces:

| Piece | Where |
|---|---|
| `navigator.serviceWorker.register` stubbed to reject | inject.js:13 |
| Existing registrations unregistered | inject.js:48 |
| App answers `/sw.js` on a site host with a kill-switch worker (`skipWaiting`, then `registration.unregister()`, no fetch handler) | `SW_KILL_SWITCH` MainActivity.java:403, served in `intercept` :408 |
| `ServiceWorkerController` client (API 24+) runs the same `intercept()` for any worker fetch | MainActivity.java:297 |
| 30 s stall watchdog: a page whose `documentElement.innerHTML` is still empty gets **one** reload per URL | `stallCheck` :513, scheduled in `onPageStarted` :451 |

## 2. Behaviour-based pop-up and redirect defence (domain-agnostic)

Verified with the blocklists **disabled** (debug `--ez no_blocklist true`): `location.href`, `intent:`,
POST form, off-site `target=_blank` and the about:blank-iframe `window.open` were all blocked.

| Vector | Defence | Where |
|---|---|---|
| `window.open`, incl. the fresh-`about:blank`-iframe `contentWindow.open` fallback | `setSupportMultipleWindows(true)` + `setJavaScriptCanOpenWindowsAutomatically(false)` route every new window to `onCreateWindow`. It hands the page a **probe WebView** whose fetches are all answered empty (:583), reads its first http(s) URL, and loads it in the main view **only** if it's a main-site host **and** a user gesture; otherwise "Blocked a pop-up". A 5 s timer disposes it (:592). The probe handles `onRenderProcessGone` (:564): all WebViews share one renderer, and an unhandled exit would kill the app on API 26+. | MainActivity.java:276, :538 |
| `location.href = adUrl` (anchor-click hijack, mouseout exit redirect) | `guardNavigation` (:343): the main frame may show only `mainHosts` (plus the sign-in rule below). Non-http schemes (`intent:`, `market:`, …) are blocked in the main frame; frames may use only `about:`/`blob:`/`data:`/`javascript:` | `Client.shouldOverrideUrlLoading` :417 |
| `form.submit()` POST navigations (never reach `shouldOverrideUrlLoading`) | `shouldInterceptRequest` with `isForMainFrame()` to a host that is neither a site nor an auth host → **204** | :429–436 |
| Cleartext site URLs | Main-frame `http://` on a site host is re-requested as `https://` | :359 |
| Site moves to a new domain | Learned only from an **https server redirect off a known site host** to a host matching `SITE_DOMAIN` `^(www\.)?hianime[a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2})?$`; persisted as `main_hosts` | `SITE_DOMAIN` :58, :367, `rememberMainHost` :317 |
| Social sign-in | `AUTH_HOSTS` (`discord.com`, `accounts.google.com`, `myanimelist.net`, `anilist.co`) are allowed in the main frame **only** via a redirect from the site's `/auth/social/…`, or while already on a provider. `pendingMainUrl` tracks where the current navigation came from (set on allowed navigations, reset in `onPageStarted` :445). Verified: AniList sign-in reaches `anilist.co/login`; a direct ad-style jump to a provider stays blocked. | `AUTH_HOSTS` :61, :373–386, `isAuthHost` :393 |

Feedback goes to the OSD, rate-limited to one notice per 4 s (`noteBlocked` :331).

## 3. Injected page script (`assets/inject.js`, ES5 on purpose)

### Injection schedule
`inject()` (MainActivity.java:523) runs `window.__hitvViewport=<n>;` plus the script at
`onPageStarted`, **+0.5 s**, **+1.5 s** (`injectRunnable` :509, scheduled :448–450) and `onPageFinished`
(:457). Injection is **main frame only**: `evaluateJavascript` can't reach cross-origin iframes. Without
AndroidX there's no document-start injection, so the network layer is the first defence and this is the second.

**Guard rule (a bug fixed in review).** The cheap, repeatable parts (dead `window.open`, SW stub, viewport
refresh) run on every injection. `window.__hitv` is set **only once `document.documentElement` exists**
(inject.js:20–22). An early injection used to crash before the root element existed while setting the guard
anyway, so the CSS and sweeper never installed.

| Part | inject.js | Purpose |
|---|---|---|
| Dead `window.open` | :5, :9 | Returns a fake closed window so ad scripts don't retry or crash |
| SW neutraliser | :13, :48 | See §1 |
| TV viewport | :32 (`fixViewport`), :56–57, re-run on every injection (:20) and when a `<meta>` is added (:146) | See §4 |
| CSS | :62 | Hides in-HTML ad slots (`.aniwatch-banner-wrap` promo, `ins.adsbygoogle`, share widget); **`body>`/`html>` children with an inline `z-index: 2147483…` → `display:none`** (:67–68); focus ring; theater-mode rules (:74–78) |
| Overlay sweeper | `isAdOverlay` :94, `sweep` :102, MutationObserver :137, `sweepTop` every 2 s :154 | Removes `position:fixed/absolute` elements with computed `z-index ≥ 2147483000` (`OVERLAY_Z` :26) among added nodes and top-level children; skips `data-hitv` and the fullscreen element. **No size check:** the popunder's interstitial is mounted at 0×0 and grown later via inline style. Verified with a synthetic 0×0-then-grown overlay. |
| Player finder | `findPlayer` :114 | `.player-frame iframe` → first iframe on a `PLAYER_ORIGIN` (:24) → largest non-overlay iframe ≥ 40 000 px² |
| Player commands | `window.__hitvCmd` :203 | §7 |
| Theater mode | `window.__hitvTheater` :237, `keepTheaterTarget` :130 | §6 |
| Playback tracking | message listener :160, `window.__hitvRecentlyPlaying` :256 | §8 |

ES5 because the TV may run an old WebView. The site itself needs a modern one (05 §6).

## 4. TV layout: desktop width, pinned scale

The app passes `window.__hitvViewport=1280` (`TV_LAYOUT_WIDTH` MainActivity.java:56) **only when
`UiModeManager` reports `UI_MODE_TYPE_TELEVISION`** (:147–149); phones and tablets get `0` and keep the site's
own viewport. `fixViewport` (inject.js:32) then rewrites the last `<meta name=viewport>` to

```
width=1280, initial-scale=S, minimum-scale=S, maximum-scale=S      S = screen.width / 1280
```

On a 1080p xhdpi TV, `screen.width` is 960 CSS px, so S = 0.75: the site's **desktop** layout (episode list,
player with its control bar, server buttons) fits on one screen.

**Why pin the scale:** WebView sized the page for its first, empty layout (980 px) and, with zoom disabled,
never refit when the viewport changed later. Pinning initial = min = max forces the right scale.

## 5. WebView settings worth copying (`configureWebView` MainActivity.java:265)

- JS, DOM storage, database on; `setMediaPlaybackRequiresUserGesture(false)`.
- Wide viewport + overview mode; zoom off (the scale comes from §4).
- `MIXED_CONTENT_COMPATIBILITY_MODE`; file/content access off; geolocation off; permission requests denied (:631).
- UA: strip `; wv` and `Version/x.y` so players that refuse WebViews see plain Chrome (:283).
- Third-party cookies on: the player iframes keep their own state (:287).
- **No `addJavascriptInterface`**: nothing native is exposed to page or ad frames. Playback state is polled instead (§8).
- `getDefaultVideoPoster` returns a 1×1 bitmap: no grey play-icon placeholder (:626).
- Remote debugging only in debug builds (`BuildConfig.DEBUG`, :153).

### Renderer crash handling (`onRenderProcessGone` :474)
- Rebuilds the WebView instead of letting the app die (`recreateWebView` :490).
- **Crash-loop guard:** the same URL crashing twice within 60 s → `last_url` is set to home and the OSD says so (:479–485).
- In the background, the WebView is rebuilt but **not loaded** until `onResume` (`pendingLoad`, :499–500, :1101).

### Error page (`showError` :527)
The failing URL goes, HTML-encoded, into a `data-u` attribute. The button's `onclick` is a constant
(`location.replace(this.getAttribute('data-u'))`), so no URL text is ever spliced into script.

## 5b. Remote control: the pointer

### Rendering and input routing
- `CursorView` draws a 1.4× density arrow (CursorView.java:23); it is not focusable or clickable.
- `dispatchKeyEvent` (MainActivity.java:732) intercepts the D-pad. An Activity sees keys **after** the IME,
  so the on-screen keyboard still gets the D-pad while it's open.
- OK = synthetic **touch**: `ACTION_DOWN` on key-down, `ACTION_UP` on key-up, `ACTION_MOVE` while moving
  (drag works for seek bars) (`touch` :963). Dispatched to the fullscreen custom view if one is showing, else the
  WebView, with coordinates translated via `getLocationOnScreen` (`dispatchTouch` :977).

### Timing model (distance from hold time, never from frame count)
Speed ramps quadratically from `SPEED_MIN` 2.5 to `SPEED_MAX` 20 dp per 16 ms frame over `SPEED_RAMP_MS` 1 s
(:64–67). Distance is the **integral** of that ramp (`travelFor` :889):

```
t ≤ 1000 ms:  dp = (2.5·t + 17.5·t³ / (3·1000²)) / 16
t > 1000 ms:  dp = (2.5·1000 + 17.5·1000/3 + 20·(t − 1000)) / 16          (t clamped to ≥ 40 ms)
px = dp × density
```

| Rule | Where | Why |
|---|---|---|
| Shortest tap counts as 40 ms → ~6 dp | `travelFor` :890 | A tap always moves visibly |
| On key-down, `heldSince = max(downTime, now − 300 ms)` (`MAX_INPUT_LAG_MS` :69) | :866 | Bogus or stale `downTime` stamps can't produce jumps |
| While held, the mover counts only time it saw itself, **≤ 50 ms per frame** (`MAX_FRAME_GAP_MS` :70) | `mover` :898–916 | A stalled UI thread never turns into a jump |
| On key-up, top the distance up to `travelFor(min(eventTime, now) − heldSince)` | :875–884 | Queued key events behind a busy UI thread still move the distance the hold time says |

Measured on the emulator with the debug key-replay hook (05 §3): 30 ms → 16 px, 200 → 68, 300 → 113,
900 → 813, and 200 ms with a 500 ms UI stall → 68 (no jump).

### Scrolling and hiding
- Pushing past an edge accumulates scroll (`movePointer` :929), flushed every 48 ms (`flushScroll` :945)
  through `SCROLL_JS` (:75). That script runs `elementFromPoint` at the pointer, scrolls the nearest scrollable
  ancestor that actually moves, and falls back to `window.scrollBy`. Coordinates are scaled by
  `innerWidth / view width`, so it stays correct under the §4 scale. CH+/−, PgUp/PgDn scroll 80% (`scrollPage` :958).
- The pointer auto-hides after 10 s browsing / 3 s over video (`HIDE_POINTER_*` :71–72, `pointerIdleCheck` :1001).
  When hidden, the first key press only reveals it; the rest of that press is swallowed (`swallowKey`, :830).

### Player mode
When fullscreen (custom view) or theater is active **and** the pointer is hidden (`onNavKey` :825, :836–847):
OK = play/pause, ◀ ▶ = seek ∓10 s (every 3rd key repeat), ▲ ▼ = bring the pointer back to reach the
player's own buttons.

### Key map (`dispatchKeyEvent` :732)

| Key | Action |
|---|---|
| D-pad / OK | pointer / click (drag while held) |
| BACK | cancel drag → leave fullscreen → leave theater → history back, **skipping the watch page's pushState episode entries** (`backSteps` :1020) → "press again to exit" (`onBackKey` :1031) |
| any key while the help card is open | **only closes the card** (BACK included) (:739–742) |
| Play/Pause | toggle |
| **Play**, **Pause** (separate keys on Sony remotes) | **idempotent** play / pause (:748, :751; §7) |
| FF / RW | seek ±10 s (holding repeats) |
| Next / Prev | seek ±60 s |
| Stop | leave fullscreen/theater |
| RED (and MENU) | theater on/off (or leave fullscreen) (:769) |
| GREEN | home |
| YELLOW | reload |
| BLUE | skip 85 s (intro) |
| INFO / HELP | controls card with a live "Ads and trackers blocked this session" count (`showHelp` :243, `refreshHelp` :234) |

BACK skip, verified: `?ep=87189` → `/home` in one press. Colour keys are used because Sony BRAVIA remotes
have no app-visible MENU key (Action Menu is a system overlay). The help card shows once on first launch.

## 6. Fullscreen and theater mode

- `onShowCustomView` (:605) puts the fullscreen view in `fullscreen`, hides the WebView, keeps the screen on,
  hides the pointer and shows a hint. `onHideCustomView` (:621) tears down. BACK calls `leaveFullscreen`
  (:666): idempotent teardown, then `CustomViewCallback.onCustomViewHidden()`.
- The site creates the player iframe with `allow="… fullscreen …" allowfullscreen`; jwplayer's own fullscreen
  button reaches `onShowCustomView`. A pointer click is a real input event and carries the user activation the
  Fullscreen API needs. `evaluateJavascript` does not.
- **Theater mode** (`setTheater` :685 → `window.__hitvTheater` inject.js:237) needs no Fullscreen API. It adds
  `html.hitv-theater` and marks the player `data-hitv="theater"`. The CSS (inject.js:74–78) makes **everything
  invisible** with `visibility:hidden` (which, unlike `display` or `opacity`, a descendant can switch back) and
  shows only the marked iframe, fixed at 100vw×100vh.
  - **Off is unconditional:** removes the class and every mark, even if the site swapped the player.
  - **Re-targets:** when the site replaces the iframe (new episode/server, auto-next), `keepTheaterTarget`
    (:130) marks the new one. Verified.
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

Native `player()` (MainActivity.java:703) calls `window.__hitvCmd(cmd, value)` (inject.js:203), with
cmd ∈ `PLAY_PAUSE | PLAY | PAUSE | SEEK | MUTE`. The return value says what happened:

| Return | Case | Behaviour |
|---|---|---|
| `bridge` | player on a `BRIDGE_ORIGIN` (inject.js:25) | Posts one object message. `PLAY`/`PAUSE` first run `probePlaying` (:175): `GET_TIME` twice, 500 ms apart, 800 ms timeout each; toggle only if the state differs. Verified against jwplayer state: pause, pause → paused; play, play → playing. |
| `frame` | other player iframe | Focuses it; native code sends the key a desktop user would press (Space, ←/→) to the WebView/custom view (:708–712) |
| `noop` | other player, `PLAY`/`PAUSE` already in that state (from its progress messages, §8) | nothing |
| `video` | no iframe, `<video>` in the page | Drives the element directly |
| `none` | nothing found | OSD "No video player on this page" |

Send **one** message form per command, never object and string both: the bridge accepts both, so a toggle
would fire twice.

## 8. Keep the screen awake

- `inject.js` tracks playback-time advances **only from `PLAYER_ORIGIN` frames** (:160–172), using the message
  shapes the site's own `watch.min.js` parses: `{type:'progress', payload:{currentTime}}`,
  `{type:'watching-log', currentTime}`, `{event:'time'|'CURRENT_TIME', time}`.
- `__hitvRecentlyPlaying()` (:256) is true if the time advanced within 45 s.
- The app polls it every **20 s while resumed** (`awakePoll` MainActivity.java:642, started in `onResume` :1102–1103,
  stopped in `onPause` :1109) → `FLAG_KEEP_SCREEN_ON` for 60 s (`keepAwake` :656).
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
| `last_url` | `onPageFinished` (:459: TV apps are often killed without `onPause`), `onPause` (:1111), crash handler | `onCreate` (:157), `loadLastUrl` (:503) |
| `main_hosts` | `rememberMainHost` (:317) | `onCreate` (:151) |
| `help_seen` | first launch (:161) | |

Cookies are flushed in `onPause` (:1112).

## 11. Debug-only hooks (stripped of effect in release: `BuildConfig.DEBUG`)

| Hook | Where |
|---|---|
| `--ez no_blocklist true`: lists off, behaviour guards still on | :142 |
| `--es keytest "R200,D200,L300,R900,L200j500"`: replays D-pad presses with real timestamps (dir + hold ms; `jN` blocks the UI thread N ms) | `handleDebugIntent` :1070, also via `onNewIntent` :1060 |
| Log lines `dispatch …`, `key …`, `pointer at x,y`, `release <dir> held=…ms travelled=…px`, `blocked <url>`, `nav … redirect= from=` | :736, :835, :920, :882, AdBlocker.java:105, :357 |
| WebView remote debugging | :153 |
