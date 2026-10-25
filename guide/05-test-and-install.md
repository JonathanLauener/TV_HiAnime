# 05 — Test on an emulator, then install on the TV

Everything here was run against the reference build on a headless Android TV emulator (API 36, x86_64)
unless marked otherwise.

Environment (see 01):

```bash
export JAVA_HOME=$(mise where java@21.0.2) ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_AVD_HOME=$HOME/.config/.android/avd
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

## 1. Headless Android TV emulator (KVM)

```bash
echo no | $ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \
  -n tv_test -k "system-images;android-36;android-tv;x86_64" -d tv_1080p --force
CFG=$ANDROID_AVD_HOME/tv_test.avd/config.ini
sed -i 's/^hw.ramSize=.*/hw.ramSize=2048/' $CFG
sed -i 's/^hw.keyboard=.*/hw.keyboard=yes/' $CFG
emulator -avd tv_test -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swangle_indirect -accel on -memory 2048 -cores 2 &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
```

- **Use `-gpu swangle_indirect`.** `-gpu swiftshader_indirect` crashed the emulator (ColorBuffer errors).
- `tv_1080p` = 1920×1080 at density 320 (xhdpi), the common real-TV configuration: `screen.width` is 960 CSS px,
  so the app's TV viewport scale is 0.75 (03 §4).
- The android-tv image has **no `adb root`**.

## 2. Install and launch

```bash
./build.sh debug
adb install -r HiAnimeTV-debug.apk
adb shell am start -n tv.hianime.wrapper/.MainActivity
adb shell dumpsys package tv.hianime.wrapper | grep -A2 LEANBACK   # appears in the TV launcher?
adb logcat -s HiAnimeTV:*                                          # debug builds log blocks, navigations, pointer
```

Debug-only launch extras (03 §11):

```bash
adb shell am start -n tv.hianime.wrapper/.MainActivity --ez no_blocklist true   # lists off: test the behaviour guards alone
adb shell am start -n tv.hianime.wrapper/.MainActivity --es keytest "R200,D200,L300,R900,L200j500"
```

## 3. Driving the remote: what works and what doesn't

| Method | Use it for | Pitfall |
|---|---|---|
| `adb shell input keyevent KEYCODE_…` | single presses: OK, BACK, media keys, colour keys | fine for taps |
| `adb shell input keyevent --duration N …` | **don't** use for hold timing | stamps `downTime` seconds early, so the app (correctly) treats it as stale (03 §5b) |
| `adb emu event send …` | **doesn't work** | keys don't reach the app on the android-tv image |
| **Debug `keytest` hook** | hold timing, acceleration, jank | replays D-pad presses through `dispatchKeyEvent` with real timestamps. Syntax: `<L|R|U|D|C><hold ms>[j<UI-stall ms>]`, comma-separated. |

Snap mode logs every page answer in debug builds (`snap 'move',3 -> {"r":"moved",…,"d":"a.film-poster \"One Piece\""}`),
so `adb logcat -s HiAnimeTV:*` shows which element each press reached. `keytest` steps work in snap mode too
(`C700` holds OK past the long press and switches to the pointer).

**Fast pre-check without a device:** `snap.js` only needs a page laid out like the TV. Headless Chromium with a
1280×720 window (CSS px; screenshots at device scale 1.5 = 1920×1080), the app's blocklists applied as request
routing, and `inject.js` + `snap.js` evaluated on `domcontentloaded`/`load` reproduces it closely. Drive
`window.__hitvSnap('move', dir)` / `('activate')` and click at the returned `x, y`. It finds most logic bugs in
seconds; the TV is still needed for taps, the on-screen keyboard, timing and the look from the sofa.

Read the pointer from the log, not from screenshots:

```
pointer at 1012,540                       ← after each movement settles
release 1 held=200ms travelled=68px       ← dir 0 left, 1 right, 2 up, 3 down
```

Measured: 30 ms → 16 px, 200 → 68, 300 → 113, 900 → 813, `R200j500` (200 ms with a 500 ms stall) → 68.

Common keys:

```bash
k() { adb shell input keyevent "$@"; }
k KEYCODE_DPAD_CENTER KEYCODE_BACK
k KEYCODE_MEDIA_PLAY_PAUSE KEYCODE_MEDIA_PLAY KEYCODE_MEDIA_PAUSE KEYCODE_MEDIA_FAST_FORWARD KEYCODE_MEDIA_REWIND
k KEYCODE_PROG_RED KEYCODE_PROG_GREEN KEYCODE_PROG_YELLOW KEYCODE_PROG_BLUE KEYCODE_INFO
adb exec-out screencap -p > shot.png                       # or REA capture_adb_screen
```

Keycodes: DPAD_UP 19, DOWN 20, LEFT 21, RIGHT 22, CENTER 23, BACK 4, MEDIA_PLAY_PAUSE 85, PLAY 126,
PAUSE 127, FF 90, RW 89, PROG_RED 183, GREEN 184, YELLOW 185, BLUE 186, INFO 165.

## 4. Inspect the app's WebView over CDP (debug builds)

```bash
PID=$(adb shell pidof tv.hianime.wrapper | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json | head      # page targets
```

With REA: `list_browser_targets {cdp_endpoint: "http://127.0.0.1:9222"}`, then `inspect_web_page`,
`observe_web_session`, or `capture_browser_scenario` in **connect** mode. **Connect mode needs
`environment.service_workers: "allow"`.**

How to read what you see:
- **Ad/tracker requests show as 200 in DevTools**, because the app answers them itself with an empty 200.
  The app's log (`blocked https://…`) is the source of truth for what was blocked.
- **Play state:** video buffers constantly on the emulator, so don't judge playing/paused from the clock.
  Ask jwplayer in the **player frame's** context: `Runtime.enable` → pick the execution context whose origin is
  `https://megaplay.buzz` (default context of that frame) → `jwplayer().getState()` → `playing`/`paused`/`buffering`.
- Confirm the inject script installed: in the main page, `window.__hitv === true`, `#hitv-style` exists,
  `.aniwatch-banner-wrap` is `display:none`.

REA evidence from the reference build:

| Evidence | Result |
|---|---|
| `ev_67780c8d7b56…` | In-app watch-page network: 8 ad/tracker hosts blocked, Monetag chain cut, video intact |
| `ev_2486b17dc7aa…` | Inject script installed, promo hidden, no page errors |

## 5. Lint against the TV's API level

No Android 9 TV image exists (01), so check API usage statically. Prerequisite: `<uses-sdk
android:minSdkVersion="21" …/>` **in the manifest**. aapt2 gets the SDK levels from flags, but lint reads only the
manifest and otherwise assumes min SDK 1.

Project descriptor used (`build/lint/project.xml`; build the debug variant first so `gen/` and `classes/` exist):

```xml
<project>
  <sdk dir="/home/USER/Android/Sdk" />
  <module name="app" android="true" library="false" compile-sdk-version="35">
    <manifest file="/ABS/PATH/AndroidManifest.xml" />
    <resource file="/ABS/PATH/res" />
    <src file="/ABS/PATH/src" />
    <src file="/ABS/PATH/build/debug/gen" />
    <classes file="/ABS/PATH/build/debug/classes" />
  </module>
</project>
```

```bash
$ANDROID_HOME/cmdline-tools/latest/bin/lint --project build/lint/project.xml --text build/lint/report.txt
```

The exact invocation isn't recorded; the descriptor and report are. Reference result (`build/lint/report.txt`):
**0 errors, 3 warnings**, all benign: `OldTargetApi` (target 34), `UnusedAttribute`
(`usesCleartextTraffic` needs API 23), `DataExtractionRules` (`allowBackup`).

APIs above min SDK 21, all guarded with `SDK_INT` checks or harmless when absent:
`WebResourceRequest.isRedirect` (24), `ServiceWorkerController` (24), `onRenderProcessGone` (26),
`onReceivedError(…, WebResourceError)` (23). The target TV (API 28) has all of them.

## 6. Install on the real TV (Sony BRAVIA, Android 9)

**Enable sideloading**
1. Settings → Device Preferences → About → select **Build** 7× → developer mode.
2. Settings → Device Preferences → Developer options → **USB debugging** on (network ADB rides on it).
3. For file-manager installs: Settings → Device Preferences → Security & restrictions → **Unknown sources** → allow the installing app.

**Option A: ADB over the network (same LAN)**
```bash
adb connect <tv-ip>:5555        # accept the RSA prompt on the TV
adb -s <tv-ip>:5555 shell dumpsys package com.google.android.webview | grep versionName   # check WebView
adb -s <tv-ip>:5555 install -r HiAnimeTV.apk
```

**Option B: USB stick or "Send files to TV"**: copy the APK, open it with a TV file manager, install.

**WebView version matters.** The site's JavaScript uses modern syntax (optional chaining in `watch.min.js`),
which stock Android 9 WebViews (~Chrome 66–69) can't run. The reference TV reports **WebView
138.0.7204.179**, which is fine. If yours is older: Play Store → "Android System WebView" → Update.
(138 is reported as the last Chrome line for Android 8/9.)

**Before installing a release**, check the signing certificate is the one you expect (04).

**Launch** from the Apps row (banner "HiAnime for TV"). The controls card shows once; INFO reopens it.

## 7. Acceptance checklist

Reference build: all passed on the emulator. On the real TV, only the device facts (Android 9,
WebView 138.0.7204.179) were checked over network ADB.

| Check | How |
|---|---|
| Appears in the TV launcher with banner | `dumpsys package` LEANBACK; launcher screenshot |
| Desktop layout fits one screen (episode list, player bar, server buttons) | screenshot; viewport `width=1280, …scale=0.75` |
| Snap: ring starts on the player (watch), Watch Now (home/detail), first card (lists) | screenshot after load |
| Snap: arrows reach every control; carousels slide; ▼ then ▲ returns; grid keeps its column | `snap … ->` log lines |
| Snap: OK opens links, toggles, dropdowns; on a text box the keyboard opens; on the video → theater + play | |
| Snap: side menu / dialog / dropdown / search suggestions keep the ring inside; BACK closes them, ring back on the opener (also after an OK inside: a tab in the dialog, the search box) | |
| Snap: ▼ ▼ OK pressed fast on the watch page: two moves, then the click (nothing dropped) | `snap … ->` log lines |
| Snap: hold OK → pointer at the ring; 10 s idle → ring back at the pointer | |
| Snap: history back puts the ring on the card you opened | |
| Cold start loads (no stalled empty page) | stall watchdog log `page stalled, reloading` should be rare |
| Pointer: tap ~6 dp, holds accelerate, stalls don't jump | `keytest` + `pointer at`/`release` log lines |
| Edge push and CH+/− scroll | |
| No pop-up or redirect from clicks, **with lists disabled too** | `--ez no_blocklist true`; OSD "Blocked …"; log |
| Ad/tracker hosts blocked, video intact | log `blocked …`; CDP network (§4) |
| Promo box hidden, overlays removed (incl. 0×0-then-grown) | CDP DOM |
| Play/Pause/Play/Pause keys idempotent | `jwplayer().getState()` in the player frame |
| FF/RW/Next/Prev/BLUE seek | player time |
| Fullscreen via the player button; BACK exits | |
| RED theater on/off; re-targets after an episode switch | |
| BACK skips episode pushState entries; help card closes on any key | `?ep=…` → previous page in one press |
| Social sign-in reaches the provider; direct jumps to providers blocked | AniList `→ anilist.co/login` |
| Screen stays awake during playback | `dumpsys window \| grep -i keep` (or wait past the screensaver timeout) |
| Renderer crash recovers; same URL twice within 60 s → home; background crash reloads only on resume | force a renderer exit (method not recorded); watch for `renderer gone` in the log |
| Reopening resumes the last page | |
