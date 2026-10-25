# 04 — Build and sign without Gradle

`build.sh` turns `AndroidManifest.xml + res/ + assets/ + src/` into a signed, aligned APK using only
build-tools binaries. It works with framework APIs only; no AndroidX/AAR dependencies.

```bash
./build.sh          # release → HiAnimeTV.apk
./build.sh debug    # BuildConfig.DEBUG=true (remote debugging, test hooks) → HiAnimeTV-debug.apk
```

## Pipeline

| Step | Command (build.sh line) | Output |
|---|---|---|
| 0. BuildConfig | heredoc writes `build/<v>/gen/<pkg>/BuildConfig.java` with `DEBUG` (:31) | generated source |
| 1. Compile resources | `aapt2 compile --dir res -o res.zip` (:37) | flat resource zip |
| 1. Link | `aapt2 link -o base.apk -I android.jar --manifest AndroidManifest.xml -A assets --java gen --min-sdk-version 21 --target-sdk-version 34 --version-code N --version-name X res.zip` (:38) | `base.apk` (manifest, resources, assets) + `R.java` |
| 2. Java | `javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -bootclasspath "android.jar:$BT/core-lambda-stubs.jar" -d classes @sources.txt` (:44) | `.class` files |
| 3. Dex | `d8 --release --min-api 21 --lib android.jar --output dex <classes>` (:48) | `classes.dex` (lambdas desugared) |
| 4. Package | `cp base.apk unsigned.apk; (cd dex && zip -q -X ../unsigned.apk classes.dex)` (:52–53) | unsigned APK |
| 4. Align | `zipalign -P 16 -f 4 unsigned.apk aligned.apk` (:54) | 4-byte aligned, 16 KB page-aligned for any `.so` |
| 5. Key (first build only) | `keytool -genkeypair … -storepass:file P -keypass:file P` under `umask 077` (:73–80), then `chmod 600` (:81) | private key + password file |
| 5. Sign | `apksigner sign --ks "$KS" --ks-key-alias hianime-tv --ks-pass "file:$KS_PASS_FILE" --out APK aligned.apk` (:82) | v1+v2+v3 signed (v1 is added automatically because min SDK < 24) |
| 6. Verify | `apksigner verify --min-sdk-version 21` (:86), `aapt2 dump badging` (:87) | sanity output |

Expected badging lines:

```
package: name='tv.hianime.wrapper' versionCode='1' versionName='1.0' … compileSdkVersion='35'
targetSdkVersion:'34'
application-label:'HiAnime TV'
leanback-launchable-activity: name='tv.hianime.wrapper.MainActivity' …
```

`leanback-launchable-activity` missing ⇒ the app won't appear on the Android TV home screen.

## Signing keys: rules

**One private key per app. Never copy `keystore/` (or any `*.jks` / password file) into a derived project.**

| Situation | What happens / what to do |
|---|---|
| First build of a project | `build.sh` creates a fresh RSA-2048 key (10 000 days) and a random password under `umask 077`, `chmod 600`. The password goes to keytool via `-storepass:file`/`-keypass:file`, never in argv (`ps` can't see it). |
| Default paths | `KS=keystore/hianime-tv.jks` (:59). Password file: `keystore/password.txt` if it exists (this project's original layout, :62–63), otherwise `${KS%.jks}.password` (:65). A fresh derived project therefore gets `keystore/hianime-tv.jks` + `keystore/hianime-tv.password`. |
| Deliberately sharing one key between apps | Don't copy it. Point at it: `HITV_KEYSTORE=/secure/path/shared.jks [HITV_KEYSTORE_PASS=/secure/path/shared.password] ./build.sh`. The `--ks-key-alias` in `build.sh` must match the alias inside that keystore. |
| Every later build of the same app | Must use the same key. Android refuses an update signed with a different key; the user would have to uninstall and lose cookies/sign-in. |
| Git | `.gitignore` excludes `keystore/`, `*.jks`, `*.password`, `build/`, `*.apk`, `*.apk.idsig`. |

Check which key signed an APK:

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs HiAnimeTV.apk | grep -i 'SHA-256'
# reference release: 956c1717bd1be5d04492d32fcee42bfda23693ece36e01133aceb61dacb30e94
```

Two apps that print the same certificate digest share a key. That's only acceptable if you chose it.

### Incidents and lessons

1. **A key was copied into a derived project.** An earlier version of this guide said "copy the whole folder,
   keep `keystore/`". A separate session followed it, and `~/123moviesfree-tv/keystore/` ended up holding a
   byte-identical copy of this app's key and password. That advice is withdrawn. If you find a copied key in a
   derived project: before its first release, delete the copied files and rebuild (a new key is generated). If
   APKs signed with the copy were already installed, switching keys means uninstalling them once. Either way,
   keep the copy out of version control and backups that leave the machine.
2. **A password file was overwritten.** A buggy password-file fallback in a test run of `build.sh` once
   overwrote `keystore/password.txt`. It was restored only because an identical copy existed (the one from
   incident 1). **Always back up the key and password before touching signing logic**, to a private location
   outside every project tree:

   ```bash
   install -d -m 700 ~/.local/share/signing-backup
   cp -a keystore/hianime-tv.jks keystore/password.txt ~/.local/share/signing-backup/
   # after any change to signing code, check the key still opens and the certificate is unchanged:
   keytool -list -keystore keystore/hianime-tv.jks -storepass:file keystore/password.txt >/dev/null && echo key-ok
   ```

## Errors hit and their fixes

### 1. `cannot find symbol … method metafactory(Lookup,String,…) location: interface LambdaMetafactory`

```
src/…/AdBlocker.java:72: error: cannot find symbol
        Thread loader = new Thread(() -> {
  symbol:   method metafactory(...)
Fatal Error: Unable to find method metafactory
```

`android.jar` has no `java.lang.invoke.LambdaMetafactory`. AGP adds build-tools' `core-lambda-stubs.jar`;
without Gradle you must add it yourself (build.sh:44):

```bash
-bootclasspath "$PLATFORM:$BT/core-lambda-stubs.jar"
```

d8 then desugars the lambdas for min API 21.

### 2. `Failed to read Key "…" password for signer #1 : end of file reached in …/password.txt`

When `--ks-pass` and `--key-pass` name **the same file**, apksigner reads the store password from line 1 and
the key password from **line 2**. The generated file has one line. Fix: pass only `--ks-pass`; the key password
defaults to it, and keytool created the key with the same password.

## Assets

- `aapt2 link -A assets` stores `assets/` in the APK. The 71k-line `hosts.txt` (~1.6 MB) compresses well:
  the release APK is 542 KB.
- To regenerate `hosts.txt` from StevenBlack while removing required hosts:

```bash
grep -E '^0\.0\.0\.0 [a-z0-9]' hosts | awk '{print $2}' | grep -vE '^(0\.0\.0\.0|localhost)$' \
 | grep -vE '(^|\.)(SITE|PLAYER1|PLAYER2|jsdelivr\.net|jquery\.com|jwpcdn\.com|jwplayer\.com)$' \
 | sort -u > assets/adblock/hosts.txt
```

## Icons and banner (ImageMagick, original artwork)

Don't reuse the site's logo. A plain play mark plus text is enough:

```bash
FONT=$(fc-match -f '%{file}' 'sans:bold')
magick -size 320x180 gradient:'#1a1630'-'#0b0a16' \
  \( -size 320x180 xc:none -fill '#ff5e9c' -draw "roundrectangle 34,52 110,128 18,18" \
     -fill white -draw "polygon 62,72 62,108 92,90" \) -composite \
  -font "$FONT" -fill white -pointsize 34 -annotate +126+86 'AppName' res/drawable-xhdpi/banner.png
magick -size 192x192 xc:none -fill '#ff5e9c' -draw "roundrectangle 8,8 184,184 40,40" \
  -fill '#1a1630' -draw "polygon 74,56 74,136 140,96" res/mipmap-xxxhdpi/ic_launcher.png
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144; do
  magick res/mipmap-xxxhdpi/ic_launcher.png -resize ${d##*:}x${d##*:} res/mipmap-${d%%:*}/ic_launcher.png; done
```

## Versioning updates

The manifest now carries `android:versionCode`/`versionName` (AndroidManifest.xml:4–5) and `<uses-sdk>` (:7). aapt2's
`--version-code`/`--version-name`/`--min-sdk-version` only fill in values **missing** from the manifest
(build.sh doesn't pass `--replace-version`; behaviour per aapt2's documented flags, not separately tested here).
So bump `android:versionCode` (integer, must increase) in `AndroidManifest.xml` **and** keep `VERSION_CODE`
in `build.sh` (:9) in step. Rebuild, then `adb install -r`. Confirm with `aapt2 dump badging`.
