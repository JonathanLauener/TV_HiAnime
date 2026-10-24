# 02 — Mapping a site's ads with REA

Goal: an **evidence ledger** of every ad, popunder and tracker host the site and its video
players load, plus how each ad script behaves (pop-ups, redirects, overlays). The blocklist
and the app's defences are built from this ledger, not from guesses.

REA = the reverse-engineering MCP server (`mcp__rea__*` tools). Load tool schemas with
ToolSearch before calling, e.g.
`select:mcp__rea__capture_browser_scenario,mcp__rea__analyze_javascript_application,mcp__rea__trace_application_feature,mcp__rea__inspect_analysis_view`.

## 0. Cheap first pass with curl (no REA needed)

Use a TV user agent; save pages to a scratch folder.

```bash
UA="Mozilla/5.0 (Linux; Android 12; SHIELD Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
curl -sSL -A "$UA" -o home.html https://SITE/
grep -oE '<script[^>]*>' home.html                       # third-party loaders stand out
grep -oE 'https?://[a-zA-Z0-9.-]+' home.html | sort | uniq -c | sort -rn
```

Red flags: `<script data-cfasync="false" async src="//random-words.com/<11 chars>/<digits>">`
(popunder loader), gtag/analytics, share widgets.

## 1. Runtime capture: `capture_browser_scenario`

Launch mode drives a temporary headless Chromium. Use a wide viewport and record network,
pop-ups and frames. Click once: popunders arm on the first click.

```json
{
  "browser": {"mode": "launch", "executable_path": "/usr/bin/chromium", "headless": true},
  "start_url": {"url": "https://SITE/watch/some-show", "query": [{"name": "ep", "value": {"source": "literal", "value": "123"}}]},
  "actions": [
    {"step_id": "waitIframe", "action": "wait_for", "locator": {"kind": "css", "selector": "iframe"}, "state": "attached", "timeout_ms": 20000},
    {"step_id": "settle", "action": "wait_for_timeout", "duration_ms": 8000},
    {"step_id": "clickPlayer", "action": "click", "locator": {"kind": "css", "selector": "iframe >> nth=0"}, "timeout_ms": 8000},
    {"step_id": "afterClick", "action": "wait_for_timeout", "duration_ms": 8000}
  ],
  "capture": {"events": ["network", "popups", "frames", "page-errors"], "at_end": ["url"]},
  "environment": {"service_workers": "block", "viewport": {"width": 1920, "height": 1080, "device_scale_factor": 1}}
}
```

Rules learned:
- Query values go in `start_url.query`, not in the URL string.
- CSS locators run in Playwright strict mode: `a[href*='/watch/']` matching 107 links **fails**.
  Use a unique selector or `>> nth=0`.
- Run one capture per page type: home, show/detail, watch page, and **each player host directly**.
- For recon, launch mode with `service_workers: "block"` is fine. Later, attaching to the app's own
  WebView in **connect** mode needs `environment.service_workers: "allow"` (05 §4).

## 2. Parse oversized results with Python

Watch-page captures run to 1.3 MB of JSON; the client saves the result to a file under
`~/.claude/projects/<project>/<session>/tool-results/`. Don't read it raw — summarise it:

```python
import json, sys
from urllib.parse import urlparse
from collections import Counter, defaultdict
d = json.load(open(sys.argv[1]))
nr = d['normalized_result']
print(d['evidence_id'], nr['completeness'])
for s in nr['steps']: print(s['step_id'], s['status'], (s.get('error') or '')[:150])
items = nr['events']['items']
print(Counter(i['kind'] for i in items))           # request/response/request-failed/frame-*/popup
by = defaultdict(list)
for r in (i for i in items if i['kind'] == 'request'):
    by[urlparse(r['url']['url']).hostname].append((r['step_index'], r['resource_type'], r['url']['url'][:140]))
for h, l in sorted(by.items(), key=lambda x: -len(x[1])):
    print(f"## {h} ({len(l)}) {dict(Counter(x[1] for x in l))}")
    for x in l[:6]: print("   ", x)
for i in items:
    if i['kind'] == 'request-failed': print("FAILED", i['url']['url'][:120], i['failure'])
```

Then classify each host: **site**, **player**, **library CDN the player needs**, **video CDN**,
**ad**, **tracker**. Note the step index (before/after the click) and sequence order (ad chains
load in sequence; there are no initiator stacks in scenario mode).

## 3. Find every player host

Streaming mirrors load the player iframe from a server-list API. On hianime-style sites the list
HTML carries base64 `data-hash` attributes holding the embed URL:

```bash
curl -sS -A "$UA" -H "X-Requested-With: XMLHttpRequest" \
  "https://SITE/ajax/v2/episode/servers?episodeId=$EP" \
| python3 -c "import json,sys,re,base64; d=json.load(sys.stdin)
[print(base64.b64decode(h+'==').decode()) for h in re.findall(r'data-hash=\"([^\"]+)\"', d.get('html',''))]"
```

Loop over a dozen episode ids and count hosts (`sed -E 's#(https://[^/]+/[^/]+).*#\1#' | sort | uniq -c`).
Also grep the site's player JS for host allowlists (hianime's `watch.min.js` had a `PLAYER_ORIGINS` array).
Then run a capture **directly on each player embed URL** — ads injected inside the iframe never
show in the parent page's HTML.

## 4. Fetch ad scripts with curl, read them statically

### Gotcha: `ERR_BLOCKED_BY_ORB` in headless Chromium
The popunder script failed in every headless capture with `net::ERR_BLOCKED_BY_ORB`, while `curl`
with a TV UA got 83 KB of JavaScript. The ad server answers headless browsers with non-JS. So a
failed load in the capture is still an ad host — download it yourself:

```bash
curl -sS -A "$UA" -H "Referer: https://SITE/" -o popunder.js "https://ADHOST/path"
```

### Static analysis
Put the scripts in one folder with a minimal `package.json` and run
`analyze_javascript_application` with `detail: "summary"` and `integrity_policy: "record-and-continue"`.
Large minified files exceed the semantic-graph budget (coverage `partial`).

**REA's application graph does not model browser DOM APIs.** `trace_application_feature` with
seed `api: window.open` returned `no-match` ("not evidence that the feature is absent"). Fall back to
reading code context around the patterns, treating the code as inert text:

```python
import re
s = open('popunder.js', encoding='utf-8', errors='ignore').read()
for pat in [r'window\.open', r"addEventListener\(['\"](click|pointerdown|mouseout)",
            r"createElement\(['\"]iframe", r'top\.location', r'location\.href\s*=',
            r'z-?index', r'localStorage']:
    for m in list(re.finditer(pat, s))[:2]:
        print(pat, '::', s[max(0, m.start()-160):m.end()+160].replace('\n', ' '))
```

Look for: pop-up calls and their fallbacks (fresh `about:blank` iframe → its `contentWindow.open`),
anchor-click hijacks, exit-intent (`mouseout`) redirects, full-screen overlay styles,
frequency caps in `localStorage`, `form.submit()` navigations, and what the loader injects next
(e.g. a tiny loader that sets `data-zone` and loads `tag.min.js`).

Read the **player's own scripts** the same way: they reveal the fullscreen bridge and any
postMessage command protocol (03 uses it for remote control).

## 5. Gotchas that shape the blocker

| Observation | Consequence |
|---|---|
| Video segments named `seg-N-….jpg/.html/.js/.css/.txt/.png` on random domains (`*.eclipseharbor.space`, master playlist on `fetch.nexabloom.top`, subtitles on `*.ivorysummit.world`) | **Never** allowlist hosts or block by file extension. Use a blocklist, plus an exemption for media-looking paths. |
| Ad/CDN domains rotate | Add URL **path patterns** for ad loaders whose file names stay fixed. |
| StevenBlack unified hosts (71k entries, 2026-10-18) contained **none** of the site's real ad hosts (`mamminfinfish.com`, `nekostream.site`, `llvpn.com`, `luugy.com`) | The site-specific curated list is what removes the ads; the big list is only a backstop. |
| The same list **did** contain `entitlements.jwplayer.com`, which the player calls | Check the big list against every required host and keep a `NEVER_BLOCK` allowlist. |
| `ssl.p.jwpcdn.com/…/jwplayer.core.controls.js` is required by the player | Library CDNs the player needs go in `NEVER_BLOCK`. |
| The popunder's interstitial is inserted at **0×0** and only grown later via its inline style (read in the live loader during review) | Don't judge overlays by size; match the extreme `z-index` (03 §3). |
| The site's PWA worker (`/sw.js`, a network-first passthrough) stalled a cold-start navigation inside the app (200 OK, 0 bytes, `readyState` stuck at `loading`) | Look for `serviceWorker.register` in the site's HTML; plan to neutralise it (03 §1). |
| Social sign-in goes through the site's `/auth/social/<provider>` and then off-site OAuth pages | Record the provider hosts; the main-frame guard must allow exactly those flows (03 §2). |
| The watch page `pushState`s one history entry per episode switch | BACK needs to skip them (03 §5b). |

Collateral-block check:

```bash
for h in SITE PLAYER1 PLAYER2 jsdelivr.net jwpcdn.com jwplayer.com; do
  printf "%-24s %s\n" "$h" "$(grep -cE "^0\.0\.0\.0 ([a-z0-9-]+\.)*${h//./\\.}\s*$" hosts)"; done
```

## 6. Evidence ledger

Keep a table; every row cites what produced it. Separate **observed** (in a capture),
**read** (static code reading) and **inferred**.

| Host / behaviour | Where | Kind | Basis | Evidence |
|---|---|---|---|---|
| `qp.<adhost>.com/<id>/<zone>` | main page | popunder loader | observed request (ORB-failed) + read script | `ev_…` |
| `nekostream.site/mt/3p.js` | player iframe | Monetag loader | observed, read | `ev_…` |
| … | | | | |

The hianime.dk ledger is in [06-case-study-hianime.md](06-case-study-hianime.md).

## Without REA

Every step has a manual equivalent: Chromium DevTools → Network (preserve log, disable cache),
`curl` for scripts, the same Python reading. You lose reproducible evidence IDs and the
structured popup/frame events.
