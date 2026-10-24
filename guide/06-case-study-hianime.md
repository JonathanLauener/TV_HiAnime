# 06 — Case study: hianime.dk (observed 2026-10-24/25)

**Observed** = in a REA browser capture or on the emulator. **Read** = static reading of a downloaded or live
script. **Inferred** = reasoning, not observed.

## Target device

| Field | Value |
|---|---|
| TV | Sony **BRAVIA 4K GB**, platform `BRAVIA_ATV2_EU` |
| Android | 9 (API 28), build `PTT1.190515.001.S54`, kernel 4.9.125 |
| WebView | **138.0.7204.179** (checked over network ADB at `<tv-ip>:5555`) |
| Implications | min SDK 21 / target 34 is fine; pure Java (works on the TV's 32-bit ARM); separate Play and Pause remote keys → idempotent handling; no app-visible MENU key → colour buttons; WebView 138 runs the site's modern JS (and is reported as the last line for Android 8/9) |

## Reference build

`HiAnimeTV.apk`, 542 KB, v1+v2+v3 signed, certificate SHA-256
`956c1717bd1be5d04492d32fcee42bfda23693ece36e01133aceb61dacb30e94`.

## REA evidence

| Evidence ID | What |
|---|---|
| `ev_3104429a0f43ac2a95e49d69b5eb01a1998dbde52da3774b9708abbd033df2eb` | Recon scenario: `/home`, wait, click header (a click on a `/watch/` link failed Playwright strict mode, 107 matches) |
| `ev_b928cb9b03233ac0e0cd1f1c76f2b9b88d7d5247e665a7ca7a2d628cfd2719d3` | Recon scenario: `/watch/one-piece-8719?ep=132738`, wait for iframe, click player. Complete, 393 events, 131 requests, 0 dropped |
| `ev_d1bce2734f633b80aff937b892384c58f07120f2f0e29cd2d971a1f9379b6238` | Recon scenario: a `vidtube.site/stream/…/sub` embed loaded directly (ended on `about:blank`; inferred: anti-hotlink without a parent page) |
| `ev_b5543589322fd2b2da5dbff2c667edec1021408ed810c99c99d13cfd895ac44b` | Static `analyze_javascript_application` over 11 downloaded scripts (graph partial; popunder.js and newclient.min.js exceeded the semantic budget) |
| `ev_390fdf63bed3869636f2b367185237d2db81c1b91fc34624e44966b0a1a3f456` | `trace_application_feature` seed `window.open` → no-match (the graph doesn't model DOM APIs) |
| `ev_67780c8d7b56…` | **In-app** watch-page network on the emulator: 8 ad/tracker hosts blocked, Monetag chain cut, video intact |
| `ev_2486b17dc7aa…` | **In-app**: inject script installed, promo hidden, no page errors |

Recon captures ran in headless Chromium 153 with service workers blocked; scenario mode has no initiator stacks,
so "loaded by X" below comes from request order and script reading.

## Hosts by role

### Main site (hianime.dk)

| Host / path | Role | Basis |
|---|---|---|
| `hianime.dk` | site: pages, `/ajax/v2/…`, `/api/theme/…`, `/auth/social/<provider>` | observed |
| `hianime.dk/sw.js?v=2` | PWA service worker, network-first passthrough. **Stalled a cold-start navigation in the app** (200 OK, 0 bytes, `readyState` stuck at `loading`) → neutralised | observed (emulator) |
| `s4.anilist.co`, `cdn.myanimelist.net`, `lh3.googleusercontent.com` | posters, avatars | observed |
| `qp.mamminfinfish.com/rV87M00N9da/154949` | **popunder / tab-under / interstitial** loader (`data-cfasync="false" async`) | observed (`ERR_BLOCKED_BY_ORB` headless; curl gets 83 859 B of JS), read |
| `www.googletagmanager.com` (G-XVTQQ4SCVG, G-EKJGBYH9EC, G-2XGW8Q7SEN), `region1.google-analytics.com` | tracking | observed |
| `platform-api.sharethis.com`, `buttons-config.sharethis.com`, `l.sharethis.com` | share widget + page-view beacon | observed |
| `www.gstatic.com/cv/js/sender/…cast_sender.js` | Cast SDK (harmless, allowed) | observed |
| `challenges.cloudflare.com` | Turnstile reference in page | read (HTML) |
| `aniwatch.rest` | target of the **"For Ad-Free Streaming Visit Aniwatch.rest"** promo box `.aniwatch-banner-wrap` on watch pages | read (HTML) |
| `discord.com`, `accounts.google.com`, `myanimelist.net`, `anilist.co` | social sign-in providers behind `/auth/social/…`. AniList reached `anilist.co/login` in the app | observed (emulator) |

Watch-page behaviour: every episode switch is recorded with `history.pushState` (`?ep=…`); the app's BACK skips
those entries (`?ep=87189` → `/home` in one press, observed).

### Player iframes

Server list: `GET /ajax/v2/episode/servers?episodeId=N` → HTML with base64 `data-hash` embed URLs (servers
"HD-1", "HD-2", types sub/dub). Over 12 sampled episodes: `megaplay.buzz/stream/…` ×48,
`vidtube.site/stream/…` ×20, `megaplay.buzz/videojs/…` ×1. `watch.min.js` also lists `zokoanime.video` and
`player.hianimes.es` in `PLAYER_ORIGINS` (not seen in the samples, not captured). The site puts the player in
`.player-frame` (the app's `findPlayer` prefers that slot).

| Host | Role | Basis |
|---|---|---|
| `megaplay.buzz` | player page + `/lib/*.js`, `/stream/getSources`, `/stream/trustWatch`, `/domains?h=…`, `check_domain.json` | observed |
| `vidtube.site` | second player (`/stream/getSourcesNew`), also loads `megaplay.buzz/lib/app.main.js` | observed |
| `cdn.jsdelivr.net/gh/itspro-dev/project_files@master/jw/hls.js`, `code.jquery.com` | player libraries | observed |
| `ssl.p.jwpcdn.com` (`jwplayer.core.controls.js`, `jwpsrv.js`), `entitlements.jwplayer.com` | jwplayer 8.46 runtime (required; entitlements answered 400) | observed |
| `fetch.nexabloom.top/anime/<hash>/<hash>/master.m3u8?token=…` | HLS master playlist | observed |
| `7v8gl.eclipseharbor.space/anime/<hash>/<hash>/seg-N-f1-v1-a1.{jpg,html,js,css,txt,png}` | **video segments with disguised extensions** | observed |
| `7xxge.ivorysummit.world/…/subtitles/eng-2.vtt`, `…/preview/thumbnails.vtt`, sprite `.webp` | subtitles, seek thumbnails | observed |
| `nekostream.site/mt/3p.js?h=<yyyymmddhh>` | **Monetag loader**: a 188 B script that appends `<script data-zone="12069550" src="https://llvpn.com/tag.min.js">` | observed (megaplay + vidtube), read |
| `llvpn.com/tag.min.js` | Monetag tag (103 KB) | observed, read |
| `my.rtmark.net/gid.js?fsa=1` | Monetag id beacon | observed |
| `luugy.com/5/12069550/?oo=1&js_build=iclick-v1.1953.0&…&dmn=llvpn.com` | Monetag ad request ("iclick" build), 204 in headless | observed |
| `statlytic.net/js/script.js` (`data-domain="megaplay-1.buzz"`), `plausible.io/js/script.js` | player analytics | observed |
| `prd.jwpltx.com/v1/jwplayer6/ping.gif` | jwplayer analytics | observed |

The embed's `window.settings` has `vast: 0`, so jwplayer VAST video ads were off (read). `jw_player.js` contains
DoubleClick/VAST code paths, inactive with `vast: 0` (read).

## Popunder behaviours (read from the `qp.mamminfinfish.com` script)

| Behaviour | Defence in the app |
|---|---|
| Captures `window.open` at load; if it looks patched, creates a styled `about:blank` iframe and calls its `contentWindow.open` (iframe removed after 1 s) | native `onCreateWindow` probe catches both paths (verified with lists off) |
| Attaches click listeners to every `<a>` on load and at +1 s/+2 s; on a qualifying click, `preventDefault()` then `window.open(ad,'_blank')` or `window.location.href = ad` | navigation guard (verified with lists off) |
| `mouseout` at the window edge → `window.location.href = ad` (exit intent) | navigation guard |
| Builds a form and `submit()`s it | main-frame `shouldInterceptRequest` → **204** (verified) |
| Full-screen interstitial `position:fixed; inset 0; z-index: 2147483640`/`2147483646` with close-after timers. **Mounted at 0×0 and grown later via inline style** (read in the live loader during review) | `inject.js`: CSS on top-level children with an inline `z-index:2147483…` + z-index-only sweeper every 2 s (verified with a synthetic 0×0-then-grown overlay) |
| Frequency cap in `localStorage` key `__tvc__`; reads `window.top.location`/`document.referrer` params; pointer-type sniffing | n/a (network block prevents the script) |

The whole script is blocked by `curated.txt` (`mamminfinfish.com`) and the `AD_PATH` shape
`^/[A-Za-z0-9]{11}/\d{5,7}$`; the behaviour defences cover a future domain.

## Player control, progress and fullscreen (read from megaplay/vidtube scripts, used in the app)

- `handle-bridge.min.js`: a `message` listener with no origin check. Accepts objects or JSON strings with
  `cmd` ∈ `SEEK` (`value`, `skip:true` = relative), `GET_TIME` (→ `{event:'CURRENT_TIME', time, duration}`),
  `GET_PIP`, `SKP_DATA` (intro/outro markers, `auto`), `PLAY_TOGGLE`, `MUTE`; also `{event:'seek', time}`.
  Posts `PLAYER_READY`, `CURRENT_TIME`, `SEEK_DONE`, `PIP_STATE` to the parent.
- The app makes Play/Pause idempotent by sending `GET_TIME` twice 500 ms apart and toggling only if needed
  (verified against `jwplayer().getState()`).
- Progress messages the site's `watch.min.js` parses, and that the app uses for keep-awake:
  `{type:'progress', payload:{currentTime}}`, `{type:'watching-log', currentTime}`, `{event:'time'|'CURRENT_TIME', time}`.
- `parent-fullscreen-bridge.min.js`: asks the parent `{megaCommand:'getFullscreenState'}`; only if the parent
  answers `{megaFullscreenState:bool}` does it route fullscreen (button, double-tap, `f` key) through
  `{megaCommand:'toggleFullscreen'}`. hianime's `watch.min.js` has no `megaCommand` handler (read), so jwplayer's
  **native** fullscreen is used → WebView `onShowCustomView`.
- The iframe markup from `watch.min.js` is `allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
  allowfullscreen`. Embed query params: `autostart=true|false`, `asi=1|0` (auto-skip intro), `time=` (resume).

## Layout on the TV

At WebView's default the site rendered for a 980 px first layout and never refit (zoom disabled). The app sets
`width=1280` with the scale pinned to `screen.width/1280` = 0.75 on the 1080p xhdpi emulator: the desktop layout
(episode list, player with its control bar, server buttons) fits one screen (observed).

## Site HTML ad slots

Only one: `.aniwatch-banner-wrap` (cross-promo for aniwatch.rest), hidden by `inject.js` (observed in-app).
A class/id scan of home/show/watch HTML found no `adsbygoogle` or other ad containers.

## What will rot first

| Item | Likely change | What to do |
|---|---|---|
| Popunder domain (`mamminfinfish.com`) | Rotated often | Re-capture the main page; add the new host to `curated.txt`. The `AD_PATH` shape, the z-index CSS/sweeper and the behaviour guards cover the gap meanwhile. |
| Monetag chain (`nekostream.site` → `llvpn.com` → `rtmark.net` / `luugy.com`) | Tag/zone domains rotate | `/mt/3p.js`, `/tag.min.js`, `/gid.js`, `/5/<zone>/`, `js_build=iclick` keep matching; refresh the domains. |
| Site domain (`hianime.dk`) | Mirrors move (the site's community board had a "proxy index update" post) | https server redirects off the current site host to a `SITE_DOMAIN`-matching host are learned automatically; otherwise change `HOME_URL` and the `mainHosts` seed. |
| Player hosts (megaplay.buzz, vidtube.site, + zokoanime.video, player.hianimes.es) | New or renamed embeds | Add to `NEVER_BLOCK`, `PLAYER_ORIGIN` and, if they speak `{cmd:…}`, `BRIDGE_ORIGIN`; re-read their bridge script. |
| Progress-message shapes | Player updates | Keep-awake and idempotent Play/Pause for unknown players depend on them; re-read `watch.min.js`'s parser. |
| PWA worker | The site may change `/sw.js` | The register stub + unregister cover any path; the kill-switch response only covers `/sw.js`. |
| Video CDN hosts (`*.nexabloom.top`, `*.eclipseharbor.space`, `*.ivorysummit.world`) | Random, rotating | Nothing to do while they stay off the blocklists (the `MEDIA_PATH` exemption protects them from `hosts.txt`). |
| WebView on Android 9 | 138 is reported as the last line for Android 8/9; sites keep raising JS requirements | If the site breaks on the TV but works on the emulator, suspect the WebView version first. |
| `hosts.txt` snapshot (2026-10-18) | Ages | Optional refresh (04). |
