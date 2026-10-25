package tv.hianime.wrapper;

import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * Decides which network requests the WebView may make.
 *
 * Three layers, checked in order:
 *  1. curated.txt  - the ad, popunder and tracker domains seen on hianime.dk and its players.
 *  2. URL patterns - the same ad loaders served from rotating domains.
 *  3. hosts.txt    - a general ad/malware hosts list, skipped for video stream URLs so a
 *                    false positive there can never break playback.
 * Hosts in NEVER_BLOCK win over all three.
 *
 * Called from WebView's network threads, so all state is immutable or volatile.
 */
final class AdBlocker {
    private static final String TAG = "HiAnimeTV";

    /** The site, its player embeds and the libraries those players need. */
    private static final Set<String> NEVER_BLOCK = new HashSet<>(java.util.Arrays.asList(
            "hianime.dk", "megaplay.buzz", "vidtube.site", "zokoanime.video", "hianimes.es",
            "anilist.co", "myanimelist.net", "jsdelivr.net", "jquery.com",
            "jwpcdn.com", "jwplayer.com", "challenges.cloudflare.com", "www.gstatic.com"));

    /** Ad loaders whose file names stay fixed while their domains rotate. */
    private static final Pattern AD_PATH = Pattern.compile(
            "/tag\\.min\\.js$"                  // Monetag tag (llvpn.com/tag.min.js)
            + "|/mt/3p\\.js$"                   // Monetag loader (nekostream.site/mt/3p.js)
            + "|/gid\\.js$"                     // Monetag id beacon (rtmark.net/gid.js)
            + "|^/\\d/\\d{6,}/?$"               // Monetag ad request (luugy.com/5/12069550/)
            + "|^/[A-Za-z0-9]{11}/\\d{5,7}$"    // popunder loader (qp.mamminfinfish.com/rV87M00N9da/154949)
            + "|/pfe/current/");
    private static final Pattern AD_QUERY = Pattern.compile("(^|&)js_build=iclick");

    /** Video streams, subtitles and keys. Their CDN hosts are random, so never judge them by the hosts list. */
    private static final Pattern MEDIA_PATH = Pattern.compile(
            "\\.(m3u8|ts|m4s|mp4|webm|vtt|srt|key)$|/seg-\\d|/anime/[0-9a-f]{16,}/", Pattern.CASE_INSENSITIVE);

    private static final byte[] EMPTY = new byte[0];

    /** A video stream, subtitle or key request (also tells the app a video is playing). */
    static boolean isMedia(Uri url) {
        String path = url.getPath();
        return path != null && MEDIA_PATH.matcher(path).find();
    }

    private final Set<String> curated;
    private volatile Set<String> hosts = Collections.emptySet();
    private final AtomicInteger blocked = new AtomicInteger();
    private volatile boolean listsEnabled = true;

    AdBlocker(final AssetManager assets) {
        curated = readDomains(assets, "adblock/curated.txt");
        // ~70k entries: load off the UI thread so startup on slow TV chips stays fast.
        Thread loader = new Thread(() -> {
            hosts = readDomains(assets, "adblock/hosts.txt");
            if (BuildConfig.DEBUG) Log.d(TAG, "hosts list loaded: " + hosts.size());
        }, "adblock-hosts");
        loader.setPriority(Thread.MIN_PRIORITY);
        loader.start();
    }

    /** Debug builds only: turn the domain/pattern lists off to exercise the pop-up and redirect guards. */
    void setListsEnabled(boolean enabled) {
        listsEnabled = enabled;
    }

    int blockedCount() {
        return blocked.get();
    }

    /** True when the host (or a parent domain) may never be blocked. */
    static boolean isProtectedHost(String host) {
        return matchesSuffix(host, NEVER_BLOCK);
    }

    boolean shouldBlock(Uri url) {
        String scheme = url.getScheme();
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https"))) return false;
        String host = url.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (isProtectedHost(host) || !listsEnabled) return false;

        boolean block = matchesSuffix(host, curated);
        if (!block) {
            String path = url.getPath() == null ? "" : url.getPath();
            String query = url.getEncodedQuery();
            block = AD_PATH.matcher(path).find() || (query != null && AD_QUERY.matcher(query).find());
            if (!block && !MEDIA_PATH.matcher(path).find()) block = matchesSuffix(host, hosts);
        }
        if (block) {
            blocked.incrementAndGet();
            if (BuildConfig.DEBUG) Log.d(TAG, "blocked " + url);
        }
        return block;
    }

    /** An empty 200 reply: ad loaders see a "successful" load and stop, instead of retrying on error. */
    static WebResourceResponse emptyResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 200, "OK", headers, new ByteArrayInputStream(EMPTY));
    }

    /**
     * Reply for a blocked main-frame navigation. 204 No Content tells the browser to stay on the
     * current page; an empty 200 would replace the page with a blank document.
     */
    static WebResourceResponse stayOnPageResponse() {
        return new WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                new HashMap<String, String>(), new ByteArrayInputStream(EMPTY));
    }

    private static boolean matchesSuffix(String host, Set<String> set) {
        if (host == null || set.isEmpty()) return false;
        String h = host;
        while (true) {
            if (set.contains(h)) return true;
            int dot = h.indexOf('.');
            if (dot < 0 || h.indexOf('.', dot + 1) < 0) return false; // stop at the registrable domain
            h = h.substring(dot + 1);
        }
    }

    private static Set<String> readDomains(AssetManager assets, String name) {
        Set<String> out = new HashSet<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(assets.open(name), "UTF-8"), 1 << 16)) {
            String line;
            while ((line = r.readLine()) != null) {
                int hash = line.indexOf('#');
                if (hash >= 0) line = line.substring(0, hash);
                line = line.trim().toLowerCase(Locale.ROOT);
                if (!line.isEmpty()) out.add(line);
            }
        } catch (IOException e) {
            Log.w(TAG, "could not read " + name, e);
        }
        return Collections.unmodifiableSet(out);
    }
}
