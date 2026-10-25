package tv.hianime.wrapper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Iterator;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends Activity {
    private static final String TAG = "HiAnimeTV";
    static final String HOME_URL = "https://hianime.dk/home";
    private static final String PREFS = "hitv";
    private static final int TV_LAYOUT_WIDTH = 1280;   // CSS px; the site's desktop layout starts here
    /** A domain the site may move to (learned only from an https redirect off a known site host). */
    private static final java.util.regex.Pattern SITE_DOMAIN =
            java.util.regex.Pattern.compile("^(www\\.)?hianime[a-z0-9-]*\\.[a-z]{2,}(\\.[a-z]{2})?$");
    /** Social sign-in: the site's /auth/social/<provider> redirects to these OAuth pages and back. */
    private static final String[] AUTH_HOSTS = {"discord.com", "accounts.google.com", "myanimelist.net", "anilist.co"};

    // Pointer feel, in dp per 16 ms frame.
    private static final float SPEED_MIN = 2.5f;
    private static final float SPEED_MAX = 20f;
    private static final long SPEED_RAMP_MS = 1000;
    private static final long FRAME_MS = 16;
    /** How far back a key's own timestamp is trusted (UI-thread lag); older stamps are treated as bogus. */
    private static final long MAX_INPUT_LAG_MS = 300;
    private static final long MAX_FRAME_GAP_MS = 50;
    private static final long HIDE_POINTER_BROWSE_MS = 10_000;
    private static final long HIDE_POINTER_PLAYER_MS = 3_000;

    // Snap navigation (the default): the D-pad jumps a focus ring between links and buttons (snap.js).
    /** Holding OK this long switches to the pointer instead of clicking. */
    private static final long LONG_PRESS_MS = 600;
    /** Fastest focus steps while a direction is held (the TV repeats keys every ~50 ms). */
    private static final long SNAP_REPEAT_MS = 120;
    /** How long a synthesised tap holds the finger down. */
    private static final long TAP_MS = 40;
    /** A page that hasn't answered a snap call by then is treated as having no snap.js. */
    private static final long SNAP_TIMEOUT_MS = 1500;

    /** Scroll whatever is under the pointer (inner scroll boxes first, then the page). */
    private static final String SCROLL_JS = "(function(x,y,dx,dy){var k=window.innerWidth/%d;x*=k;y*=k;dx*=k;dy*=k;"
            + "var el=document.elementFromPoint(x,y);"
            + "while(el&&el!==document.body&&el!==document.documentElement){var s=getComputedStyle(el);"
            + "if(dy&&/(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+1){var t=el.scrollTop;el.scrollTop+=dy;if(el.scrollTop!==t)return;}"
            + "if(dx&&/(auto|scroll)/.test(s.overflowX)&&el.scrollWidth>el.clientWidth+1){var l=el.scrollLeft;el.scrollLeft+=dx;if(el.scrollLeft!==l)return;}"
            + "el=el.parentElement;}window.scrollBy(dx,dy);})(%.1f,%.1f,%.1f,%.1f)";

    private static final String HELP_TEXT = "HiAnime TV — remote controls\n\n"
            + "D-pad  jump between links and buttons  ·  OK  open\n"
            + "CH +/−  page up/down\n"
            + "Hold OK  mouse pointer (D-pad moves it, OK clicks, hold OK\n"
            + "    and move to drag, screen edge scrolls; it hides after 10 s)\n"
            + "BACK  go back / leave fullscreen\n"
            + "▶❙❙  play/pause   ◀◀ ▶▶  seek 10 s   ⏮ ⏭  seek 1 min\n\n"
            + "In fullscreen: OK play/pause · ◀ ▶ seek · ▲ ▼ pointer\n\n"
            + "RED  theater mode   GREEN  home   YELLOW  reload\n"
            + "BLUE  skip 85 s (intro)   INFO  this help";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<String> mainHosts = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private FrameLayout root;
    private WebView web;
    private FrameLayout fullscreen;
    private CursorView cursor;
    private TextView osd;
    private TextView help;
    private AdBlocker blocker;
    private SharedPreferences prefs;
    private String injectJs = "";

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean theater;

    // Pointer state.
    // Directions: 0 left, 1 right, 2 up, 3 down.
    private static final int[] DIR_X = {-1, 1, 0, 0};
    private static final int[] DIR_Y = {0, 0, -1, 1};
    private final boolean[] held = new boolean[4];
    private final long[] heldSince = new long[4];
    private final float[] travelled = new float[4];
    private final float[] heldFor = new float[4];   // hold time the mover has seen, in ms
    private long lastMoverFrame;
    private boolean moving;
    private float density;
    private long lastPointerActivity;
    private boolean touching;
    private long touchDownTime;
    private int swallowKey;
    private float pendingScrollX, pendingScrollY;
    private long lastScrollFlush;

    // Snap state.
    private static final int SNAP_OK = 4, SNAP_PAGE_UP = 5, SNAP_PAGE_DOWN = 6;   // after the directions 0-3
    private boolean snapBusy;          // a snap.js call (or the tap OK sends) is in flight
    /** Presses that came while busy, in order: {command, 1 if a held key's repeat}. Run as each call returns. */
    private final ArrayDeque<int[]> snapQueue = new ArrayDeque<>();
    private long lastSnapMove;
    private int okCode;                // the OK key held in snap mode (0: none)

    private long lastBackPress;
    /** Target of the main-frame navigation in flight (server redirects are judged by where they came from). */
    private volatile Uri pendingMainUrl;
    private boolean resumed;
    private boolean pendingLoad;
    private String lastCrashUrl;
    private long lastCrashTime;
    private long lastBlockedNotice;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        density = getResources().getDisplayMetrics().density;
        blocker = new AdBlocker(getAssets());
        if (BuildConfig.DEBUG && getIntent().getBooleanExtra("no_blocklist", false)) {
            blocker.setListsEnabled(false);   // adb shell am start ... --ez no_blocklist true
            Log.w(TAG, "blocklists disabled for testing");
        }
        // On a TV, lay pages out 1280 CSS px wide (see inject.js); phones keep the site's own viewport.
        UiModeManager uiMode = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        boolean tv = uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        injectJs = "window.__hitvViewport=" + (tv ? TV_LAYOUT_WIDTH : 0) + ";" + readAsset("inject.js")
                + "\n" + readAsset("snap.js");
        mainHosts.add("hianime.dk");
        mainHosts.addAll(prefs.getStringSet("main_hosts", new HashSet<String>()));

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        buildUi();
        configureWebView();

        String start = prefs.getString("last_url", null);
        web.loadUrl(start != null && isMainHost(Uri.parse(start).getHost()) ? start : HOME_URL);

        handleDebugIntent(getIntent());
        if (!prefs.getBoolean("help_seen_v11", false)) {
            prefs.edit().putBoolean("help_seen_v11", true).apply();
            showHelp(14_000);
        }
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        web = new WebView(this);
        root.addView(web, match());

        fullscreen = new FrameLayout(this);
        fullscreen.setBackgroundColor(0xFF000000);
        fullscreen.setVisibility(View.GONE);
        root.addView(fullscreen, match());

        cursor = new CursorView(this);
        cursor.setVisibility(View.GONE);   // snap mode first; holding OK brings the pointer
        root.addView(cursor, match());

        osd = new TextView(this);
        osd.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        osd.setTextColor(0xFFFFFFFF);
        osd.setBackground(rounded(0xD0101018));
        osd.setPadding(dp(16), dp(10), dp(16), dp(10));
        osd.setVisibility(View.GONE);
        FrameLayout.LayoutParams osdLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        osdLp.setMargins(dp(32), dp(24), dp(32), dp(24));
        root.addView(osd, osdLp);

        help = new TextView(this);
        help.setText(HELP_TEXT);
        help.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        help.setLineSpacing(0, 1.25f);
        help.setTextColor(0xFFFFFFFF);
        help.setBackground(rounded(0xE6101018));
        help.setPadding(dp(28), dp(22), dp(28), dp(22));
        help.setVisibility(View.GONE);
        root.addView(help, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        setContentView(root);
        lastPointerActivity = SystemClock.uptimeMillis();
        ui.postDelayed(pointerIdleCheck, 1000);
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private GradientDrawable rounded(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(10));
        return g;
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private final Runnable hideOsd = () -> osd.setVisibility(View.GONE);
    private final Runnable hideHelp = () -> help.setVisibility(View.GONE);

    private void osd(String text) {
        osd.setText(text);
        osd.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideOsd);
        ui.postDelayed(hideOsd, 2200);
    }

    private final Runnable refreshHelp = new Runnable() {
        @Override
        public void run() {
            if (help.getVisibility() != View.VISIBLE) return;
            help.setText(HELP_TEXT + "\n\nAds and trackers blocked this session: " + blocker.blockedCount());
            ui.postDelayed(this, 1000);
        }
    };

    private void showHelp(long ms) {
        help.setVisibility(View.VISIBLE);
        ui.removeCallbacks(refreshHelp);
        refreshHelp.run();
        ui.removeCallbacks(hideHelp);
        ui.postDelayed(hideHelp, ms);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(true);            // route every window.open through onCreateWindow
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        // Look like Chrome rather than an embedded WebView; some players refuse WebViews.
        s.setUserAgentString(s.getUserAgentString().replace("; wv)", ")").replaceAll("Version/[\\d.]+ ", ""));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);  // the player iframes keep their own cookies

        web.setBackgroundColor(0xFF000000);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (Build.VERSION.SDK_INT >= 24) {
            // The site registers a service worker; its fetches bypass shouldInterceptRequest otherwise.
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return intercept(request.getUrl());
                }
            });
        }
        web.requestFocus();
    }

    /** Main-frame hosts the app may show: hianime.dk, plus any hianime domain the site itself redirects to. */
    private boolean isMainHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String allowed : mainHosts) {
            if (h.equals(allowed) || h.endsWith("." + allowed)) return true;
        }
        return false;
    }

    private void rememberMainHost(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("www.")) h = h.substring(4);
        if (mainHosts.add(h)) {
            prefs.edit().putStringSet("main_hosts", new HashSet<>(mainHosts)).apply();
            Log.i(TAG, "site moved to " + h);
        }
    }

    private static boolean isHttp(Uri u) {
        String scheme = u.getScheme();
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    private void noteBlocked(final String what) {
        if (BuildConfig.DEBUG) Log.d(TAG, what);
        ui.post(() -> {
            long now = SystemClock.uptimeMillis();
            if (now - lastBlockedNotice > 4000) {
                lastBlockedNotice = now;
                osd(what);
            }
        });
    }

    /** @return true to cancel the navigation. */
    private boolean guardNavigation(Uri url, boolean mainFrame, boolean redirect) {
        if (!isHttp(url)) {
            // intent:, market:, tel: ... are how ads escape to other apps. Allow only inert schemes in frames.
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
            boolean inert = scheme.equals("about") || scheme.equals("blob") || scheme.equals("data") || scheme.equals("javascript");
            if (mainFrame || !inert) {
                noteBlocked("Blocked a redirect");
                return true;
            }
            return false;
        }
        String host = url.getHost();
        if (mainFrame) {
            Uri from = pendingMainUrl;
            if (BuildConfig.DEBUG) Log.d(TAG, "nav " + url + " redirect=" + redirect + " from=" + from);
            if (isMainHost(host)) {
                if ("http".equalsIgnoreCase(url.getScheme())) {
                    // Never show the site over cleartext; ask for the same address over https instead.
                    web.loadUrl(url.buildUpon().scheme("https").build().toString());
                    return true;
                }
                pendingMainUrl = url;
                return false;
            }
            if (redirect && from != null && isMainHost(from.getHost()) && "https".equalsIgnoreCase(url.getScheme())
                    && host != null && SITE_DOMAIN.matcher(host.toLowerCase(Locale.ROOT)).matches()) {
                rememberMainHost(host);   // the site itself moved to a new hianime domain
                pendingMainUrl = url;
                return false;
            }
            if (isAuthHost(host) && "https".equalsIgnoreCase(url.getScheme())) {
                // Allowed only as part of a sign-in the user started on the site, or within the provider.
                boolean fromSiteLogin = redirect && from != null && isMainHost(from.getHost())
                        && from.getPath() != null && from.getPath().startsWith("/auth/social/");
                // Providers redirect within themselves (authorize -> login); `from` is only ever an auth
                // host if a sign-in the user started already got us there.
                String current = web.getUrl();
                boolean withinProvider = (from != null && isAuthHost(from.getHost()))
                        || (current != null && isAuthHost(Uri.parse(current).getHost()));
                if (fromSiteLogin || withinProvider) {
                    pendingMainUrl = url;
                    return false;
                }
            }
            noteBlocked("Blocked redirect to " + host);
            return true;
        }
        return blocker.shouldBlock(url);
    }

    private static boolean isAuthHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String a : AUTH_HOSTS) {
            if (h.equals(a) || h.endsWith("." + a)) return true;
        }
        return false;
    }

    /** Replaces the site's service worker: installs, unregisters itself, never handles a fetch. */
    private static final String SW_KILL_SWITCH = "self.addEventListener('install',function(){self.skipWaiting();});"
            + "self.addEventListener('activate',function(e){e.waitUntil(self.registration.unregister());});";

    /** Interception shared by page and service-worker requests. Runs on WebView network threads. */
    private WebResourceResponse intercept(Uri url) {
        if (isMainHost(url.getHost()) && "/sw.js".equals(url.getPath())) {
            return new WebResourceResponse("application/javascript", "utf-8",
                    new java.io.ByteArrayInputStream(SW_KILL_SWITCH.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        return blocker.shouldBlock(url) ? AdBlocker.emptyResponse() : null;
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            boolean redirect = Build.VERSION.SDK_INT >= 24 && request.isRedirect();
            return guardNavigation(request.getUrl(), request.isForMainFrame(), redirect);
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return guardNavigation(Uri.parse(url), true, false);   // pre-Android 7 callback: main frame only
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (request.isForMainFrame()) {
                // Catches main-frame navigations shouldOverrideUrlLoading never sees (form POSTs).
                if (isHttp(url) && !isMainHost(url.getHost()) && !isAuthHost(url.getHost())) {
                    noteBlocked("Blocked redirect to " + url.getHost());
                    return AdBlocker.stayOnPageResponse();
                }
                return null;
            }
            return intercept(url);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            theater = false;
            pendingMainUrl = url == null ? null : Uri.parse(url);   // also covers loadUrl/history loads
            inject();
            // The DOM may not exist yet; retry before onPageFinished, which can be slow on a TV.
            ui.removeCallbacks(injectRunnable);
            ui.postDelayed(injectRunnable, 500);
            ui.postDelayed(injectRunnable, 1500);
            ui.removeCallbacks(stallCheck);
            ui.postDelayed(stallCheck, 30_000);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            inject();
            // Save now, not only in onPause: a TV app is often killed without onPause (power off, low memory).
            if (url != null && isMainHost(Uri.parse(url).getHost())) prefs.edit().putString("last_url", url).apply();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(request.getUrl().toString(), String.valueOf(error.getDescription()));
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < 23) showError(failingUrl, description);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's renderer crashed (or was killed for memory). Rebuild instead of crashing the app.
            Log.w(TAG, "renderer gone, crashed=" + detail.didCrash());
            String url = view.getUrl();
            long now = SystemClock.uptimeMillis();
            boolean again = url != null && url.equals(lastCrashUrl) && now - lastCrashTime < 60_000;
            lastCrashUrl = url;
            lastCrashTime = now;
            // A page that keeps killing the renderer must not come back on every start.
            prefs.edit().putString("last_url", again || url == null ? HOME_URL : url).apply();
            recreateWebView();
            if (again) osd("That page keeps crashing \u2014 back to home");
            return true;
        }
    }

    private void recreateWebView() {
        leaveFullscreen();
        theater = false;
        root.removeView(web);
        web.destroy();
        web = new WebView(this);
        root.addView(web, 0, match());
        configureWebView();
        // Loading starts a new renderer; in the background wait for onResume (Android's guidance).
        if (resumed) loadLastUrl();
        else pendingLoad = true;
    }

    private void loadLastUrl() {
        pendingLoad = false;
        String last = prefs.getString("last_url", HOME_URL);
        web.loadUrl(isMainHost(Uri.parse(last).getHost()) ? last : HOME_URL);
    }

    private final Runnable injectRunnable = this::inject;
    private String lastStallReload;

    /** A page that is still empty after 30 s (seen on cold starts) gets one automatic reload. */
    private final Runnable stallCheck = () -> web.evaluateJavascript(
            "document.documentElement?document.documentElement.innerHTML.length:0", result -> {
                String url = web.getUrl();
                if ("0".equals(result) && url != null && !url.equals(lastStallReload)) {
                    lastStallReload = url;
                    Log.w(TAG, "page stalled, reloading " + url);
                    web.reload();
                }
            });

    private void inject() {
        // snap.js shows its focus ring on load only while the pointer is off.
        if (!injectJs.isEmpty()) {
            web.evaluateJavascript("window.__hitvPointer=" + (cursor.getVisibility() == View.VISIBLE) + ";" + injectJs, null);
        }
    }

    private void showError(String failingUrl, String description) {
        String html = "<html><body style=\"background:#0d0d1a;color:#eee;font:20px sans-serif;display:flex;align-items:center;"
                + "justify-content:center;height:100vh;margin:0;text-align:center\"><div><h2>Can't reach the site</h2><p style=\"color:#aaa\">"
                + android.text.TextUtils.htmlEncode(description) + "</p><button style=\"font-size:22px;padding:14px 36px;border:0;border-radius:10px;"
                + "background:#ff5e9c;color:#fff\" data-u=\"" + android.text.TextUtils.htmlEncode(failingUrl)
                + "\" onclick=\"location.replace(this.getAttribute('data-u'))\">Retry</button></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", failingUrl);
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, final boolean isUserGesture, Message resultMsg) {
            // Hand the page a throwaway window, read where it wants to go, then drop it.
            // Same-site links (target=_blank) open in place; anything else is an ad pop-up.
            final WebView probe = new WebView(MainActivity.this);
            final boolean[] done = {false};
            final boolean[] destroyed = {false};
            final Runnable dispose = () -> {
                if (!destroyed[0]) {
                    destroyed[0] = true;
                    probe.destroy();
                }
            };
            probe.setWebViewClient(new WebViewClient() {
                private boolean take(String url) {
                    Uri u = Uri.parse(url);
                    if (done[0] || !isHttp(u)) return true;   // about:blank first, real URL later
                    done[0] = true;
                    ui.post(() -> {
                        if (isUserGesture && isMainHost(u.getHost())) web.loadUrl(url);
                        else noteBlocked("Blocked a pop-up");
                        dispose.run();
                    });
                    return true;
                }

                @Override
                public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                    // All WebViews share one renderer; an unhandled exit here would kill the app.
                    done[0] = true;
                    ui.post(dispose);
                    return true;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    return take(r.getUrl().toString());
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    return take(url);
                }

                @Override
                public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                    return AdBlocker.emptyResponse();     // never let the pop-up fetch anything
                }

                @Override
                public void onPageStarted(WebView v, String url, Bitmap favicon) {
                    if (take(url) && done[0]) v.stopLoading();
                }
            });
            ui.postDelayed(() -> {
                if (!done[0]) {
                    done[0] = true;
                    noteBlocked("Blocked a pop-up");
                }
                dispose.run();
            }, 5000);
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreen.addView(view, match());
            fullscreen.setVisibility(View.VISIBLE);
            web.setVisibility(View.INVISIBLE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            cancelSnapInput();
            hidePointer();
            osd("OK play/pause · ◀ ▶ seek · ▲ ▼ pointer · BACK exit");
        }

        @Override
        public void onHideCustomView() {
            tearDownFullscreen();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);   // no grey play-icon placeholder
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }
    }

    /** Every 20 s: if the player's time advanced recently (inject.js), keep the TV screen on. */
    private final Runnable awakePoll = new Runnable() {
        @Override
        public void run() {
            web.evaluateJavascript("window.__hitvRecentlyPlaying?window.__hitvRecentlyPlaying():false", result -> {
                if ("true".equals(result)) keepAwake(60_000);
            });
            ui.postDelayed(this, 20_000);
        }
    };

    private final Runnable releaseScreen = () -> {
        if (customView == null) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    };

    private void keepAwake(long ms) {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        ui.removeCallbacks(releaseScreen);
        ui.postDelayed(releaseScreen, ms);
    }

    private boolean inPlayerView() {
        return customView != null || theater;
    }

    private void leaveFullscreen() {
        WebChromeClient.CustomViewCallback cb = customViewCallback;
        tearDownFullscreen();
        if (cb != null) cb.onCustomViewHidden();
    }

    private void tearDownFullscreen() {
        if (customView == null) return;
        fullscreen.removeView(customView);
        fullscreen.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        customView = null;
        customViewCallback = null;
        ui.removeCallbacks(releaseScreen);
        ui.postDelayed(releaseScreen, 120_000);
        if (cursor.getVisibility() != View.VISIBLE) resumeSnap(false);
        web.requestFocus();
    }

    private void setTheater(final boolean on) {
        web.evaluateJavascript("window.__hitvTheater?window.__hitvTheater(" + on + "):'none'", result -> {
            if ("\"on\"".equals(result)) {
                theater = true;
                cancelSnapInput();
                hidePointer();
                keepAwake(120_000);
                osd("Theater mode · OK play/pause · ◀ ▶ seek · BACK exit");
            } else {
                theater = false;
                if (on) osd("No video player on this page");
                else if (cursor.getVisibility() != View.VISIBLE) resumeSnap(false);
            }
        });
    }

    // ---------------------------------------------------------------- player commands

    /** Sends cmd to the page's player through inject.js (see window.__hitvCmd there). */
    private void player(String cmd, int value, final int fallbackKey, String label) {
        if (label != null) osd(label);
        String js = "window.__hitvCmd?window.__hitvCmd('" + cmd + "'," + value + "):'none'";
        web.evaluateJavascript(js, result -> {
            // Unknown players don't speak the postMessage protocol: press the key a desktop user would.
            if ("\"frame\"".equals(result) && fallbackKey != 0) {
                View target = customView != null ? customView : web;
                long t = SystemClock.uptimeMillis();
                target.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, fallbackKey, 0));
                target.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, fallbackKey, 0));
            } else if ("\"none\"".equals(result)) {
                osd("No video player on this page");
            }
        });
        keepAwake(120_000);
    }

    private void togglePlay() {
        player("PLAY_PAUSE", 0, KeyEvent.KEYCODE_SPACE, "\u25b6\u2759\u2759");
    }

    private void seekBy(int seconds) {
        player("SEEK", seconds, seconds < 0 ? KeyEvent.KEYCODE_DPAD_LEFT : KeyEvent.KEYCODE_DPAD_RIGHT,
                (seconds < 0 ? "\u25c0\u25c0 " : "\u25b6\u25b6 +") + seconds + " s");
    }

    // ---------------------------------------------------------------- remote control

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        final int code = e.getKeyCode();
        final boolean isDown = e.getAction() == KeyEvent.ACTION_DOWN;
        final boolean first = isDown && e.getRepeatCount() == 0;
        if (BuildConfig.DEBUG) Log.v(TAG, "dispatch " + KeyEvent.keyCodeToString(code) + (isDown ? " down" : " up")
                + " rep=" + e.getRepeatCount() + " held=" + (e.getEventTime() - e.getDownTime()) + "ms");

        if (help.getVisibility() == View.VISIBLE && first && code != KeyEvent.KEYCODE_INFO) {
            help.setVisibility(View.GONE);   // any key closes the help card
            return true;
        }

        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                if (first) togglePlay();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:      // Sony remotes have separate play and pause keys
                if (first) player("PLAY", 0, KeyEvent.KEYCODE_SPACE, "\u25b6");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (first) player("PAUSE", 0, KeyEvent.KEYCODE_SPACE, "\u2759\u2759");
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                if (isDown && e.getRepeatCount() % 3 == 0) seekBy(10);
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if (isDown && e.getRepeatCount() % 3 == 0) seekBy(-10);
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                if (first) seekBy(60);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                if (first) seekBy(-60);
                return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                if (first) exitPlayerView();
                return true;
            case KeyEvent.KEYCODE_PROG_RED:
            case KeyEvent.KEYCODE_MENU:
                if (first) {
                    if (customView != null) leaveFullscreen();
                    else setTheater(!theater);
                }
                return true;
            case KeyEvent.KEYCODE_PROG_GREEN:
                if (first) {
                    exitPlayerView();
                    web.loadUrl(HOME_URL);
                }
                return true;
            case KeyEvent.KEYCODE_PROG_YELLOW:
                if (first) web.reload();
                return true;
            case KeyEvent.KEYCODE_PROG_BLUE:
                if (first) seekBy(85);
                return true;
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_HELP:
                if (first) {
                    if (help.getVisibility() == View.VISIBLE) help.setVisibility(View.GONE);
                    else showHelp(20_000);
                }
                return true;
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
                if (isDown) scrollPage(-1, !first);
                else dropSnapRepeats();
                return true;
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
                if (isDown) scrollPage(1, !first);
                else dropSnapRepeats();
                return true;
            case KeyEvent.KEYCODE_BACK:
                if (first) {
                    if (cursor.getVisibility() != View.VISIBLE && !inPlayerView()) {
                        // Snap mode: the page closes what it has open (search, side menu, dialog) first.
                        snapCall("'back'", r -> {
                            if (r == null || !"handled".equals(r.optString("r"))) onBackKey();
                        });
                    } else {
                        onBackKey();
                    }
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                return onNavKey(e);
            default:
                return super.dispatchKeyEvent(e);
        }
    }

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_BUTTON_A;
    }

    private boolean onNavKey(KeyEvent e) {
        final int code = e.getKeyCode();
        final boolean isDown = e.getAction() == KeyEvent.ACTION_DOWN;
        final boolean first = isDown && e.getRepeatCount() == 0;

        if (swallowKey == code) {             // rest of a press that only woke the pointer
            if (!isDown) swallowKey = 0;
            return true;
        }

        if (BuildConfig.DEBUG && first) Log.d(TAG, "key " + KeyEvent.keyCodeToString(code) + " pointerVisible=" + (cursor.getVisibility() == View.VISIBLE));
        if (!isDown && code == okCode && (cursor.getVisibility() == View.VISIBLE || inPlayerView())) {
            disarmOk();   // pressed in snap mode, released after the mode changed: neither a click nor a hold
        }
        if (cursor.getVisibility() != View.VISIBLE) {
            if (inPlayerView()) {
                // Pointer hidden over the video: the remote drives playback directly.
                if (isOk(code)) {
                    if (first) togglePlay();
                    return true;
                }
                if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                    if (isDown && e.getRepeatCount() % 3 == 0) seekBy(code == KeyEvent.KEYCODE_DPAD_LEFT ? -10 : 10);
                    return true;
                }
                // ▲ ▼ bring the pointer back to reach the player's own buttons.
                if (first) {
                    showPointer();
                    swallowKey = code;
                }
                return true;
            }
            return onSnapKey(e);
        }

        lastPointerActivity = SystemClock.uptimeMillis();
        if (isOk(code)) {
            if (first) touch(MotionEvent.ACTION_DOWN);
            else if (!isDown && touching) touch(MotionEvent.ACTION_UP);
            return true;
        }
        int dir = code == KeyEvent.KEYCODE_DPAD_LEFT ? 0 : code == KeyEvent.KEYCODE_DPAD_RIGHT ? 1
                : code == KeyEvent.KEYCODE_DPAD_UP ? 2 : 3;
        if (isDown) {
            if (!held[dir]) {
                held[dir] = true;
                heldSince[dir] = Math.max(e.getDownTime(), SystemClock.uptimeMillis() - MAX_INPUT_LAG_MS);
                travelled[dir] = 0;
                heldFor[dir] = 0;
            }
            if (!moving) {
                moving = true;
                lastMoverFrame = SystemClock.uptimeMillis();
                ui.post(mover);
            }
        } else if (held[dir]) {
            held[dir] = false;
            // Key events queue up behind a busy UI thread (slow TV chip, heavy page). Settle whatever
            // distance this press was owed so the pointer always travels what the hold time says.
            long end = Math.min(e.getEventTime(), SystemClock.uptimeMillis());
            float owed = travelFor(end - heldSince[dir]) - travelled[dir];
            if (owed > 0) movePointer(DIR_X[dir] * owed, DIR_Y[dir] * owed);
            if (BuildConfig.DEBUG) Log.d(TAG, "release " + dir + " held=" + (end - heldSince[dir]) + "ms travelled="
                    + Math.round(Math.max(travelled[dir], travelFor(end - heldSince[dir]))) + "px");
        }
        return true;
    }

    // ---------------------------------------------------------------- snap navigation

    /**
     * Snap mode: arrows move snap.js's focus ring, OK taps the focused element, holding OK switches
     * to the pointer. Directions as for the pointer: 0 left, 1 right, 2 up, 3 down.
     */
    private boolean onSnapKey(KeyEvent e) {
        final int code = e.getKeyCode();
        final boolean isDown = e.getAction() == KeyEvent.ACTION_DOWN;
        final boolean first = isDown && e.getRepeatCount() == 0;
        if (isOk(code)) {
            // Click on release, so a long press can mean "pointer" instead.
            if (first) {
                okCode = code;
                ui.removeCallbacks(okLongPress);
                ui.postDelayed(okLongPress, LONG_PRESS_MS);
            } else if (!isDown && okCode == code) {
                disarmOk();
                snapSend(SNAP_OK, false);
            }
            return true;
        }
        if (!isDown) {
            // Released: a held key's repeat still waiting for the page must not move once more
            // (a tap waiting behind a slow move still counts).
            dropSnapRepeats();
            return true;
        }
        long now = SystemClock.uptimeMillis();
        if (!first && now - lastSnapMove < SNAP_REPEAT_MS) return true;
        int dir = code == KeyEvent.KEYCODE_DPAD_LEFT ? 0 : code == KeyEvent.KEYCODE_DPAD_RIGHT ? 1
                : code == KeyEvent.KEYCODE_DPAD_UP ? 2 : 3;
        snapSend(dir, !first);
        return true;
    }

    private void disarmOk() {
        okCode = 0;
        ui.removeCallbacks(okLongPress);
    }

    /** Leaving snap mode (pointer, video): presses still waiting were meant for the ring. */
    private void cancelSnapInput() {
        disarmOk();
        snapQueue.clear();
    }

    private final Runnable okLongPress = () -> {
        if (okCode == 0 || cursor.getVisibility() == View.VISIBLE || inPlayerView()) {
            okCode = 0;
            return;
        }
        swallowKey = okCode;   // the release must not click
        okCode = 0;
        snapCall("'pointer',true", r -> {
            if (r != null && r.has("x")) {
                float k = cssToView(r);
                cursor.moveTo(r.optInt("x") * k, r.optInt("y") * k);
            }
            showPointer();
            osd("Pointer · OK click · hides after 10 s, then the D-pad jumps again");
        });
    };

    /**
     * Runs a snap command (a direction 0-3, SNAP_OK, SNAP_PAGE_UP/DOWN), one at a time: the page answers
     * slower than the remote repeats, so presses wait their turn in order. A held key keeps only its latest
     * repeat waiting.
     */
    private void snapSend(int cmd, boolean repeat) {
        if (snapBusy) {
            int[] tail = snapQueue.peekLast();
            if (repeat && tail != null && tail[1] == 1) snapQueue.pollLast();
            if (snapQueue.size() < 4) snapQueue.add(new int[]{cmd, repeat ? 1 : 0});
            return;
        }
        snapBusy = true;
        if (cmd < 4) {
            lastSnapMove = SystemClock.uptimeMillis();
            snapCall("'move'," + cmd, r -> onSnapMoved(cmd, r));
        } else if (cmd == SNAP_OK) {
            snapActivate();
        } else {
            snapCall("'page'," + (cmd == SNAP_PAGE_UP ? -1 : 1), r -> onSnapMoved(cmd == SNAP_PAGE_UP ? 2 : 3, r));
        }
    }

    /** The call in flight is done: run the next press that waited for it. */
    private void snapIdle() {
        snapBusy = false;
        int[] next = snapQueue.poll();
        if (next != null) snapSend(next[0], next[1] == 1);
    }

    private void dropSnapRepeats() {
        for (Iterator<int[]> it = snapQueue.iterator(); it.hasNext(); ) {
            if (it.next()[1] == 1) it.remove();
        }
    }

    private void onSnapMoved(int dir, org.json.JSONObject r) {
        if (r == null) {
            // No snap.js on this page yet (still loading): ▲ ▼ scroll a little instead.
            if (dir >= 2 && web.getWidth() > 0) {
                scrollAt(web.getWidth() / 2f, web.getHeight() / 2f, 0, (dir == 2 ? -1 : 1) * web.getHeight() * 0.25f);
            }
        }
        snapIdle();
    }

    /** OK: tap what the ring is on. Busy until the tap is sent, so a press after it can't move the page first. */
    private void snapActivate() {
        snapCall("'activate'", r -> {
            String kind = r == null ? "" : r.optString("r");
            if ("tap".equals(kind)) {
                float k = cssToView(r);
                tapWeb(r.optInt("x") * k, r.optInt("y") * k, this::snapIdle);
                return;
            }
            snapIdle();
            if ("player".equals(kind)) {
                // The video itself: fill the screen with it and make sure it plays.
                setTheater(true);
                player("PLAY", 0, 0, null);
            }
        });
    }

    /** The answer to a snap call the page didn't answer in time: no result fields, so nothing was handled. */
    private static final org.json.JSONObject SNAP_TIMED_OUT = new org.json.JSONObject();

    /**
     * Calls window.__hitvSnap(args) in the page; the callback gets its result object, null if the page has no
     * snap.js yet, or SNAP_TIMED_OUT after SNAP_TIMEOUT_MS without an answer (a hung page or a rebuilt WebView
     * must not leave the remote dead: BACK still works, the arrows unlock).
     */
    private void snapCall(String args, final SnapResult cb) {
        final boolean[] done = {false};
        final Runnable timeout = () -> {
            if (done[0]) return;
            done[0] = true;
            Log.w(TAG, "snap " + args + ": no answer from the page");
            if (cb != null) cb.on(SNAP_TIMED_OUT);
        };
        ui.postDelayed(timeout, SNAP_TIMEOUT_MS);
        web.evaluateJavascript("window.__hitvSnap?window.__hitvSnap(" + args + "):null", json -> {
            if (done[0]) return;
            done[0] = true;
            ui.removeCallbacks(timeout);
            org.json.JSONObject r = null;
            if (json != null && json.startsWith("{")) {
                try {
                    r = new org.json.JSONObject(json);
                } catch (org.json.JSONException ignored) {
                }
            }
            if (BuildConfig.DEBUG) Log.d(TAG, "snap " + args + " -> " + json);
            if (cb != null) cb.on(r);
        });
    }

    private interface SnapResult {
        void on(org.json.JSONObject r);
    }

    /** CSS px (snap.js reports viewport coordinates and its innerWidth as "w") to WebView px. */
    private float cssToView(org.json.JSONObject r) {
        double w = r.optDouble("w", 0);
        return w > 0 ? (float) (web.getWidth() / w) : 1f;
    }

    /** A finger tap on the page at WebView coordinates: the same real input a pointer click sends. */
    private void tapWeb(final float x, final float y, final Runnable sent) {
        final long down = SystemClock.uptimeMillis();
        MotionEvent ev = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0);
        ev.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        web.dispatchTouchEvent(ev);
        ev.recycle();
        ui.postDelayed(() -> {
            MotionEvent up = MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
            up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            web.dispatchTouchEvent(up);
            up.recycle();
            sent.run();
        }, TAP_MS);
    }

    /** Pixels a press held for {@code ms} moves the pointer: the integral of the speed ramp. */
    private float travelFor(long ms) {
        float t = Math.max(ms, 40);   // even the shortest tap moves ~6 dp
        float r = SPEED_RAMP_MS;
        float dpFrames = t <= r
                ? SPEED_MIN * t + (SPEED_MAX - SPEED_MIN) * t * t * t / (3 * r * r)
                : SPEED_MIN * r + (SPEED_MAX - SPEED_MIN) * r / 3 + SPEED_MAX * (t - r);
        return dpFrames * density / FRAME_MS;
    }

    private final Runnable mover = new Runnable() {
        @Override
        public void run() {
            long now = SystemClock.uptimeMillis();
            // A stalled UI thread must not turn into a jump (the release may still be queued), so count
            // at most MAX_FRAME_GAP_MS per frame; the release tops the distance up from real timestamps.
            long dt = Math.min(MAX_FRAME_GAP_MS, now - lastMoverFrame);
            lastMoverFrame = now;
            float mx = 0, my = 0;
            boolean any = false;
            for (int d = 0; d < 4; d++) {
                if (!held[d]) continue;
                any = true;
                heldFor[d] += dt;
                float step = Math.max(0, travelFor((long) heldFor[d]) - travelled[d]);
                travelled[d] += step;
                mx += DIR_X[d] * step;
                my += DIR_Y[d] * step;
            }
            if (!any) {
                moving = false;
                flushScroll(true);
                if (BuildConfig.DEBUG) Log.d(TAG, "pointer at " + Math.round(cursor.cursorX()) + "," + Math.round(cursor.cursorY()));
                return;
            }
            lastPointerActivity = now;
            movePointer(mx, my);
            ui.postDelayed(this, FRAME_MS);
        }
    };

    private void movePointer(float mx, float my) {
        float x = cursor.cursorX() + mx;
        float y = cursor.cursorY() + my;
        int w = cursor.getWidth(), h = cursor.getHeight();
        if (customView == null && !theater) {
            // Pushing past an edge scrolls the page instead (never over a fullscreen video).
            if (y < 0) pendingScrollY += y * 2;
            else if (y > h - 1) pendingScrollY += (y - (h - 1)) * 2;
            if (x < 0) pendingScrollX += x * 2;
            else if (x > w - 1) pendingScrollX += (x - (w - 1)) * 2;
            flushScroll(false);
        }
        cursor.moveTo(x, y);
        if (touching) dispatchTouch(MotionEvent.ACTION_MOVE);
    }

    private void flushScroll(boolean force) {
        long now = SystemClock.uptimeMillis();
        if ((pendingScrollX == 0 && pendingScrollY == 0) || (!force && now - lastScrollFlush < 48)) return;
        lastScrollFlush = now;
        scrollAt(cursor.cursorX(), cursor.cursorY(), pendingScrollX, pendingScrollY);
        pendingScrollX = pendingScrollY = 0;
    }

    private void scrollAt(float x, float y, float dx, float dy) {
        if (web.getWidth() == 0) return;
        web.evaluateJavascript(String.format(Locale.US, SCROLL_JS, web.getWidth(), x, y, dx, dy), null);
    }

    private void scrollPage(int direction, boolean repeat) {
        if (inPlayerView()) return;
        if (cursor.getVisibility() != View.VISIBLE) snapSend(direction < 0 ? SNAP_PAGE_UP : SNAP_PAGE_DOWN, repeat);
        else scrollAt(cursor.cursorX(), cursor.cursorY(), 0, direction * web.getHeight() * 0.8f);
    }

    private void touch(int action) {
        if (action == MotionEvent.ACTION_DOWN) {
            touching = true;
            touchDownTime = SystemClock.uptimeMillis();
            cursor.setPressedLook(true);
        }
        dispatchTouch(action);
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            touching = false;
            cursor.setPressedLook(false);
        }
    }

    /** Synthesises a finger touch at the pointer on whatever is showing (page or fullscreen video). */
    private void dispatchTouch(int action) {
        View target = customView != null ? customView : web;
        int[] rootLoc = new int[2], targetLoc = new int[2];
        cursor.getLocationOnScreen(rootLoc);
        target.getLocationOnScreen(targetLoc);
        float x = cursor.cursorX() + rootLoc[0] - targetLoc[0];
        float y = cursor.cursorY() + rootLoc[1] - targetLoc[1];
        MotionEvent ev = MotionEvent.obtain(touchDownTime, SystemClock.uptimeMillis(), action, x, y, 0);
        ev.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        target.dispatchTouchEvent(ev);
        ev.recycle();
    }

    private void showPointer() {
        cancelSnapInput();
        if (cursor.getVisibility() != View.VISIBLE) snapCall("'pointer',true", null);   // hides the focus ring
        cursor.setVisibility(View.VISIBLE);
        lastPointerActivity = SystemClock.uptimeMillis();
    }

    /** Back to snap mode; the focus ring comes back, on whatever the pointer was over if it was showing. */
    private void resumeSnap(boolean fromPointer) {
        if (fromPointer) {
            snapCall(String.format(Locale.US, "'pointer',false,%.0f,%.0f,%d",
                    cursor.cursorX(), cursor.cursorY(), web.getWidth()), null);
        } else {
            snapCall("'pointer',false", null);
        }
    }

    private void hidePointer() {
        if (touching) touch(MotionEvent.ACTION_CANCEL);
        java.util.Arrays.fill(held, false);
        cursor.setVisibility(View.GONE);
    }

    private final Runnable pointerIdleCheck = new Runnable() {
        @Override
        public void run() {
            long idle = SystemClock.uptimeMillis() - lastPointerActivity;
            long limit = inPlayerView() ? HIDE_POINTER_PLAYER_MS : HIDE_POINTER_BROWSE_MS;
            if (cursor.getVisibility() == View.VISIBLE && !touching && !moving && idle > limit) {
                hidePointer();
                if (!inPlayerView()) resumeSnap(true);
            }
            ui.postDelayed(this, 500);
        }
    };

    private void exitPlayerView() {
        if (customView != null) leaveFullscreen();
        else if (theater) setTheater(false);
    }

    /**
     * The watch page records every episode switch with pushState; those entries all show the same
     * page, so BACK steps over them to the previous real page.
     */
    private int backSteps() {
        WebBackForwardList list = web.copyBackForwardList();
        int cur = list.getCurrentIndex();
        if (cur < 1 || list.getCurrentItem() == null) return 1;
        String path = Uri.parse(list.getCurrentItem().getUrl()).getPath();
        if (path == null || !path.startsWith("/watch/")) return 1;
        int i = cur - 1;
        while (i > 0 && path.equals(Uri.parse(list.getItemAtIndex(i).getUrl()).getPath())) i--;
        return cur - i;
    }

    private void onBackKey() {
        if (touching) {
            touch(MotionEvent.ACTION_CANCEL);
            return;
        }
        if (customView != null) {
            leaveFullscreen();
            return;
        }
        if (theater) {
            setTheater(false);
            return;
        }
        if (web.canGoBack()) {
            web.goBackOrForward(-backSteps());
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastBackPress < 2000) {
            finish();
        } else {
            lastBackPress = now;
            osd("Press BACK again to exit");
        }
    }

    // ---------------------------------------------------------------- debug-only test hooks

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        handleDebugIntent(intent);
    }

    /**
     * Debug builds: {@code am start -n tv.hianime.wrapper/.MainActivity --es keytest "R200,D200,R300j250,L30"}
     * replays D-pad presses (direction + hold ms) with real timestamps through dispatchKeyEvent;
     * "jN" also blocks the UI thread for N ms during that press, like a busy TV chip.
     */
    private void handleDebugIntent(android.content.Intent intent) {
        if (!BuildConfig.DEBUG || intent == null) return;
        String spec = intent.getStringExtra("keytest");
        if (spec == null) return;
        long t = 1000;
        for (String step : spec.split(",")) {
            char c = Character.toUpperCase(step.charAt(0));
            String[] parts = step.substring(1).toLowerCase(Locale.ROOT).split("j");
            final int hold = Integer.parseInt(parts[0]);
            final int jank = parts.length > 1 ? Integer.parseInt(parts[1]) : 0;
            final int code = c == 'L' ? KeyEvent.KEYCODE_DPAD_LEFT : c == 'R' ? KeyEvent.KEYCODE_DPAD_RIGHT
                    : c == 'U' ? KeyEvent.KEYCODE_DPAD_UP : c == 'D' ? KeyEvent.KEYCODE_DPAD_DOWN : KeyEvent.KEYCODE_DPAD_CENTER;
            ui.postDelayed(() -> {
                final long down = SystemClock.uptimeMillis();
                dispatchKeyEvent(new KeyEvent(down, down, KeyEvent.ACTION_DOWN, code, 0));
                if (jank > 0) ui.postDelayed(() -> SystemClock.sleep(jank), 10);
                // Stamped at the real release time; a blocked UI thread delivers it late, as with real input.
                ui.postDelayed(() -> dispatchKeyEvent(new KeyEvent(down, down + hold, KeyEvent.ACTION_UP, code, 0)), hold);
            }, t);
            t += hold + Math.max(jank, 0) + 600;
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        web.onResume();
        web.resumeTimers();
        if (pendingLoad) loadLastUrl();   // the renderer died while we were in the background
        ui.removeCallbacks(awakePoll);
        ui.postDelayed(awakePoll, 20_000);
    }

    @Override
    protected void onPause() {
        resumed = false;
        ui.removeCallbacks(awakePoll);
        String url = web.getUrl();
        if (url != null && isMainHost(Uri.parse(url).getHost())) prefs.edit().putString("last_url", url).apply();
        CookieManager.getInstance().flush();
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (IOException e) {
            Log.w(TAG, "missing asset " + name, e);
            return "";
        }
    }
}
