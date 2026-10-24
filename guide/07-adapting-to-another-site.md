# 07 — Retarget the app to another site

## 1. Copy the project, never the key

```bash
rsync -a --exclude 'keystore/' --exclude '*.jks' --exclude '*.password' \
         --exclude 'build/' --exclude '*.apk' --exclude '*.apk.idsig' --exclude 'guide/' \
         /home/deep/hianime-tv/ ~/newsite-tv/
cd ~/newsite-tv
test ! -e keystore && ! find . -name '*.jks' -o -name '*.password' | grep -q . && echo "no key copied"
```

- **Never copy `keystore/` (or any `*.jks` / password file) into a derived project.** The new project's
  first `./build.sh` generates its own key (04). An earlier version of this guide said "keep `keystore/`",
  and a derived project ended up with a byte-identical copy of this app's key and password.
- To share a key between apps **on purpose**, leave it where it is and point at it:
  `HITV_KEYSTORE=/secure/path/shared.jks HITV_KEYSTORE_PASS=/secure/path/shared.password ./build.sh`
  (the alias must match, 04).
- Check after the first release build: `apksigner verify --print-certs` must **not** print the reference
  digest `956c1717…` unless you chose to share.

## 2. What to change

| What | Where | Notes |
|---|---|---|
| Package name | `AndroidManifest.xml` `package=`, `src/tv/hianime/wrapper/` path + `package` lines, `PKG_DIR` and the BuildConfig heredoc in `build.sh` (:13, :31–33) | A new package installs side by side with the old app |
| App label | `res/values/strings.xml` | |
| Icon + banner | `res/mipmap-*/ic_launcher.png`, `res/drawable-xhdpi/banner.png` (320×180) | Original artwork (04) |
| APK name, key alias, default key path | `build.sh` (`APK=` :29–30, `KS=` default :59, `-alias` :71, `--ks-key-alias` :76) | Each app gets its own key |
| Version | `android:versionCode`/`versionName` in the manifest **and** `VERSION_CODE`/`VERSION_NAME` in `build.sh` | The manifest values win (04) |
| `HOME_URL` | MainActivity.java:54 | Start page |
| `mainHosts` seed | MainActivity.java:150 | Every domain the **main frame** may show |
| `SITE_DOMAIN` | MainActivity.java:58 | Regex for domains the site may move to (learned only from https redirects off a site host) |
| `AUTH_HOSTS` + `/auth/social/` prefix | MainActivity.java:61, :376 | The site's sign-in providers and its OAuth start path; empty the array if there's no social login |
| `/sw.js` kill switch | MainActivity.java:408 | The site's service-worker path, if any |
| `/watch/` in `backSteps` | MainActivity.java:1025 | The path whose pushState entries BACK should skip |
| `TV_LAYOUT_WIDTH` | MainActivity.java:56 | The narrowest width at which the site shows its desktop layout |
| `HELP_TEXT`, colour keys | MainActivity.java:82, `dispatchKeyEvent` :732 | e.g. BLUE "skip 85 s" assumes anime openings |
| `NEVER_BLOCK` | AdBlocker.java:37 | Site, every player host, library CDNs the player needs |
| `AD_PATH` / `AD_QUERY` / `MEDIA_PATH` | AdBlocker.java:43, :50, :53 | Fixed-name ad loaders of **your** networks; test each regex against your player and CDN URLs for false positives; adapt the media-path shape to your CDN |
| `curated.txt` | `assets/adblock/` | Observed ad/tracker hosts from your ledger; keep the generic network block |
| `hosts.txt` exclusions | regenerate (04) | Exclude your required hosts |
| `PLAYER_ORIGIN`, `BRIDGE_ORIGIN` | inject.js:24–25 | All player hosts / those that speak your bridge protocol |
| Player slot selector | `findPlayer` inject.js:115 (`.player-frame iframe`) | The site's player container |
| Bridge messages | `__hitvCmd` inject.js:203–216, `probePlaying` :175 | See §3 |
| Progress-message shapes | inject.js:166–168 | Drives keep-awake and idempotent Play/Pause for non-bridge players |
| Promo CSS | inject.js:62–66 | Ad slots in the site's own HTML; keep the z-index rules (:67–68) |

## 3. Discover a player's control protocol

1. Download every script the embed loads (`curl` with the TV UA and `Referer: https://SITE/`).
2. Find `addEventListener("message"` / `onmessage` and read the handler: which fields (`cmd`, `event`, `type`,
   `action`, `method`) and values it switches on, whether it checks `event.origin`, and whether it accepts
   strings, objects, or both.
3. Find `postMessage(` to see what the player reports (progress, ready, ended). Feed the progress shapes to
   inject.js:166–168 and to a `probePlaying`-style state query if there's a "get time/state" command.
4. Look for a fullscreen bridge (`requestFullscreen`, `setFullscreen`, a parent handshake such as `megaCommand`).
   If the parent must answer for the bridge to activate, don't answer; native fullscreen then reaches `onShowCustomView`.
5. Without a bridge: jwplayer in the iframe takes the keyboard (Space, ←/→, `f`, `m`) through the `frame` fallback.
   Video.js, Plyr or Vidstack embeds sometimes accept method-style messages; confirm by reading the code first.
   A `<video>` in the main document is driven directly (`video` path).
6. Send **one** message form per command, never object and string both, or a toggle fires twice.
7. Verify state with the player itself (e.g. `jwplayer().getState()` in the player frame's DevTools context,
   05 §4), not with the clock.

## 4. Test checklist

Run 05 §7 in full, plus:

- [ ] Every player host from the server list plays at least one episode.
- [ ] The debug log shows blocks only for ad/tracker hosts, never for the site, player, playlist or segment hosts.
- [ ] With `--ez no_blocklist true`, clicking 10+ links never opens or redirects anywhere else. Popunders often
      fire once per frequency-cap window: clear app data and retry.
- [ ] Sign-in, search (on-screen keyboard) and dropdowns work with the pointer; sign-in reaches the provider and
      returns; a direct jump to the provider from an ad is blocked.
- [ ] Fullscreen from the player's own button; BACK exits; theater mode as fallback, including after the site
      swaps the player.
- [ ] Cold start with an existing service-worker registration loads normally.
- [ ] Domain move: an https redirect from the site to a `SITE_DOMAIN` host is followed and remembered; an
      off-pattern host is not.

## 5. Review checklist (four lenses)

Run four independent reviews of the finished app, each **trying to break** one aspect. In the reference build,
this found 13 issues (12 distinct); all were fixed and re-verified. The items below come from those findings.

### Compatibility (old TV, old WebView)
- [ ] Injected JS is ES5 and survives running **before `documentElement` exists**; one-time guards are set only
      after the DOM is there, and injection is repeated (start, +0.5 s, +1.5 s, finished).
- [ ] The layout fits the TV at its real density: viewport width chosen and **scale pinned** (WebView doesn't refit
      after its first layout when zoom is off).
- [ ] Every API above min SDK is guarded; lint runs with `<uses-sdk>` present (0 errors).
- [ ] Renderer death is handled for **every** WebView, including throwaway probes; there's a crash-loop guard,
      and no reload happens in the background.
- [ ] A site service worker can't stall navigations (stubbed, unregistered, killed, stall watchdog).

### Ad blocking
- [ ] Ad overlays are matched by z-index/inline style, **not by size** (0×0-then-grown interstitials).
- [ ] Behaviour guards work with all lists disabled: `window.open` (incl. the about:blank-iframe trick),
      `location.href`, `intent:`, POST forms, off-site `target=_blank`.
- [ ] A blocked main-frame navigation leaves the user on the page (204), not on a blank document.
- [ ] Media URLs can never be blocked by the generic list; required hosts are in `NEVER_BLOCK`.

### Remote
- [ ] Separate Play and Pause keys are **idempotent** (state probe, not a blind toggle).
- [ ] Pointer distance comes from hold time, with stale-timestamp clamps and a per-frame cap: no jumps after UI
      stalls, taps always move.
- [ ] BACK: closes the help card only, leaves fullscreen/theater, skips pushState entries of the same page.
- [ ] Theater mode re-targets a swapped player; off always clears every trace.

### Security
- [ ] No `addJavascriptInterface`. If one is unavoidable, assume ad frames call it.
- [ ] Messages that change app state are accepted only from known player origins.
- [ ] Main-frame allowlist: https only for the site (http is upgraded); domain learning only from an https
      redirect off a known site host and a strict regex; OAuth hosts only inside a user-started sign-in.
- [ ] No untrusted text spliced into HTML/JS (error page: encoded data attribute + constant handler).
- [ ] Signing key private (`umask 077`, `chmod 600`, password never in argv, `.gitignore`), unique per app, backed up.

## 6. Prompt template for another model

> You have shell access on Linux and (if available) the REA MCP tools. Follow the guide in
> `/home/deep/hianime-tv/guide/` (start with README.md) to build an ad-free Android TV APK for
> **https://NEW-SITE/**. Target TV: **<brand/model>, Android <version> (API <n>), WebView <version>**.
>
> 1. Set up the toolchain per 01 if `~/Android/Sdk` and `mise where java@21.0.2` are missing.
> 2. Do recon per 02: capture the home, a detail and a watch page, decode the player server list, capture each
>    player host, download and read the ad scripts statically. Write an evidence ledger table (host, where,
>    role, observed/read/inferred, evidence ID) into `guide/case-study.md` of the new project.
> 3. Copy `/home/deep/hianime-tv` to `~/NEWSITE-tv` **with the rsync command in 07 §1. Never copy `keystore/`
>    or any key or password file.** Change everything in 07 §2, using only hosts from your ledger for
>    `curated.txt` and `NEVER_BLOCK`.
> 4. Find the player's postMessage protocol per 07 §3 and wire it into `window.__hitvCmd` in `inject.js`.
> 5. Build with `./build.sh debug` and test in the headless Android TV emulator per 05: pointer (debug `keytest`
>    hook), clicks, pop-ups blocked with `--ez no_blocklist true`, video plays (check the player's own state),
>    fullscreen, media keys, BACK. Inspect the WebView over CDP and the app log to confirm no ad hosts load.
>    Run lint for API <n>.
> 6. Run the four-lens review in 07 §5 and fix what it finds.
> 7. Build the release APK with `./build.sh`, print its certificate digest (it must be new), and give me install
>    steps for my TV.
>
> Report: the evidence ledger, what you blocked and why, test results with screenshots, review findings and
> fixes, and anything you couldn't verify.
