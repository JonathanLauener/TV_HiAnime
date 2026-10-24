# Website → ad-free Android TV APK: reusable guide

This guide lets another AI model (or a person) repeat the conversion done for
**hianime.dk → "HiAnime TV"**: a Gradle-free Android WebView app that

- removes the site's ads, popunders, redirects and trackers, and
- is usable with a **TV remote** (virtual D-pad pointer, media keys, fullscreen video,
  desktop layout scaled to the TV, Android TV launcher banner).

The reference implementation is the project this folder lives in: `/home/deep/hianime-tv`.

> Personal-use wrapper. Ad blocking happens on the device, inside the app. Nothing here
> downloads or redistributes the site's video; the app is a browser pinned to one site.

## Who it's for

- An AI coding agent with shell access on Linux, optionally with the **REA** MCP server
  (reverse-engineering tools: browser scenario capture, static JS analysis, adb helpers).
- A human following the same steps by hand. REA steps also have plain `curl`/`grep` equivalents.

## End-to-end flow

```
 1. Toolchain        JDK 21 + Android cmdline-tools, build-tools 35, platform 35, emulator, TV image
        │            (01-toolchain.md)
 2. Recon            REA browser captures of the site + every player embed host,
        │            static reading of the ad scripts → evidence ledger of ad/tracker hosts
        │            (02-recon-with-rea.md)
 3. App design       layered network blocker + behaviour-based pop-up/redirect guard +
        │            injected ES5 page script + TV remote UX + player control protocol
        │            (03-app-architecture.md)
 4. Build & sign     aapt2 → javac → d8 → zip → zipalign → apksigner, one private key per app
        │            (04-build-sign.md)
 5. Test & install   headless Android TV emulator, debug key-replay hook, CDP into the WebView,
                     lint vs the TV's API level, then sideload to the real TV
                     (05-test-and-install.md)
```

## File index

| File | Contents | Generic or site-specific |
|---|---|---|
| [01-toolchain.md](01-toolchain.md) | Gradle-free SDK + JDK install on Linux, KVM check, AVD location | Generic |
| [02-recon-with-rea.md](02-recon-with-rea.md) | Mapping ads with REA: captures, parsing, player hosts, static ad-script reading, gotchas | Generic method |
| [03-app-architecture.md](03-app-architecture.md) | Why each defence/UX layer exists, with file:line pointers | Generic design |
| [04-build-sign.md](04-build-sign.md) | `build.sh` pipeline, signing-key rules, errors hit and fixes | Generic |
| [05-test-and-install.md](05-test-and-install.md) | Emulator + debug hooks + CDP verification, lint, real-TV install, testing pitfalls | Generic procedure |
| [06-case-study-hianime.md](06-case-study-hianime.md) | Every host/behaviour observed on hianime.dk and its players, device facts, evidence IDs, what will rot | **hianime.dk-specific** |
| [07-adapting-to-another-site.md](07-adapting-to-another-site.md) | Retargeting the app, review checklist, prompt template for another model | Generic procedure |

### What is generic vs hianime.dk-specific in the code

| Generic (reuse as-is) | Site-specific (change per site) |
|---|---|
| `build.sh` pipeline and key handling | `HOME_URL`, `mainHosts` seed, `SITE_DOMAIN`, `AUTH_HOSTS` (`MainActivity.java`) |
| `CursorView.java`, pointer timing model, key map | `NEVER_BLOCK`, `AD_PATH` patterns (`AdBlocker.java`) |
| Pop-up probe, navigation guard, 204 POST catch, crash-loop guard | `assets/adblock/curated.txt` |
| Service-worker kill switch, stall watchdog, re-injection schedule | `/sw.js` path, `/watch/` path in `backSteps` |
| `inject.js`: dead `window.open`, overlay sweeper, viewport pinning, theater CSS, `__hitvCmd` dispatch | `PLAYER_ORIGIN` / `BRIDGE_ORIGIN`, `.player-frame`, promo CSS, progress-message shapes (`inject.js`) |
| `assets/adblock/hosts.txt` (StevenBlack snapshot) | Package name, label, icon, banner, signing alias |

## Quick start for a new site (checklist)

- [ ] Install the toolchain (01). Confirm `/dev/kvm` if you want the emulator.
- [ ] Copy the project **without** `keystore/`, `build/` and APKs (07 §1). Never copy a signing key into a derived project; each app gets its own key on its first build (04).
- [ ] Recon (02): capture home, detail and watch pages; list player iframe hosts; capture each player host; read the ad scripts statically. Write an evidence ledger.
- [ ] Fill `curated.txt` with the **observed** ad/tracker hosts; add `AD_PATH` patterns for ad loaders whose file names stay fixed while domains rotate.
- [ ] Put the site, its player hosts and any library CDNs the player needs into `NEVER_BLOCK`; check the big hosts list for collateral blocks of those.
- [ ] Set `HOME_URL`, the `mainHosts` seed, `SITE_DOMAIN`, `AUTH_HOSTS`; update `inject.js` (player origins, promo CSS, message shapes).
- [ ] Find the player's parent→iframe control protocol (postMessage) and wire it into `window.__hitvCmd`.
- [ ] Rename package/label/icons/signing alias (07 §2).
- [ ] `./build.sh debug`, test in the TV emulator (05): ads gone, pop-ups blocked, video plays, fullscreen works, remote keys work. Run the review checklist (07 §5).
- [ ] `./build.sh` (release), check the signing certificate, install on the TV.

## Status of the reference build (2026-10-25)

- Release `HiAnimeTV.apk`: 542 KB, v1+v2+v3 signed, certificate SHA-256
  `956c1717bd1be5d04492d32fcee42bfda23693ece36e01133aceb61dacb30e94`.
- Verified on the headless Android TV emulator (API 36): ad/tracker hosts blocked with the Monetag chain cut
  and video intact (REA `ev_67780c8d7b56…`); inject script installed, promo hidden, no page errors
  (`ev_2486b17dc7aa…`); pop-up/redirect guards with the blocklists disabled; viewport, remote, BACK, theater
  and pointer timing (details in 03/05).
- Lint against min SDK 21: 0 errors, 3 benign warnings.
- A 4-lens adversarial review (compat, adblock, remote, security) found 13 issues (12 distinct). All were fixed
  and re-verified.
- Target TV: Sony BRAVIA 4K GB, Android 9, WebView 138.0.7204.179 (06).
