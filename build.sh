#!/usr/bin/env bash
# Builds HiAnimeTV.apk without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
#   ./build.sh          release build  -> HiAnimeTV.apk
#   ./build.sh debug    adds WebView remote debugging -> HiAnimeTV-debug.apk
set -euo pipefail
cd "$(dirname "$0")"

VARIANT=${1:-release}
VERSION_CODE=2
VERSION_NAME=1.1
MIN_SDK=21          # Android 5; the target TV runs Android 9 (API 28)
TARGET_SDK=34
PKG_DIR=tv/hianime/wrapper

ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
BT=$ANDROID_HOME/build-tools/35.0.0
PLATFORM=$ANDROID_HOME/platforms/android-35/android.jar
if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME=$(mise where java@21.0.2 2>/dev/null || true)
fi
[[ -x "${JAVA_HOME:-}/bin/javac" ]] || { echo "JDK not found: set JAVA_HOME" >&2; exit 1; }
[[ -f "$PLATFORM" && -x "$BT/aapt2" ]] || { echo "Android SDK not found at $ANDROID_HOME" >&2; exit 1; }
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"

OUT=build/$VARIANT
rm -rf "$OUT"
mkdir -p "$OUT/gen/$PKG_DIR" "$OUT/classes" "$OUT/dex"

DEBUG=false; APK=HiAnimeTV.apk
if [[ "$VARIANT" == debug ]]; then DEBUG=true; APK=HiAnimeTV-debug.apk; fi
cat > "$OUT/gen/$PKG_DIR/BuildConfig.java" <<EOF
package tv.hianime.wrapper;
public final class BuildConfig { public static final boolean DEBUG = $DEBUG; }
EOF

echo "[1/6] resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLATFORM" --manifest AndroidManifest.xml -A assets \
  --java "$OUT/gen" --min-sdk-version $MIN_SDK --target-sdk-version $TARGET_SDK \
  --version-code $VERSION_CODE --version-name $VERSION_NAME "$OUT/res.zip"

echo "[2/6] javac"
find src "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 -bootclasspath "$PLATFORM:$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "[3/6] d8"
"$BT/d8" --release --min-api $MIN_SDK --lib "$PLATFORM" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[4/6] package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -X ../unsigned.apk classes.dex)
"$BT/zipalign" -P 16 -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[5/6] sign"
# One key for every future build, so updates install over the old version. Keep it private, and
# never copy keystore/ into another project: point HITV_KEYSTORE at a key instead.
KS=${HITV_KEYSTORE:-keystore/hianime-tv.jks}
if [[ -n "${HITV_KEYSTORE_PASS:-}" ]]; then
  KS_PASS_FILE=$HITV_KEYSTORE_PASS
elif [[ -z "${HITV_KEYSTORE:-}" && -f keystore/password.txt ]]; then
  KS_PASS_FILE=keystore/password.txt          # the project's own key (original layout)
else
  KS_PASS_FILE=${KS%.jks}.password
fi
if [[ ! -f "$KS" ]]; then
  ( umask 077
    mkdir -p "$(dirname "$KS")"
    head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$KS_PASS_FILE"
    keytool -genkeypair -keystore "$KS" -alias hianime-tv -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass:file "$KS_PASS_FILE" -keypass:file "$KS_PASS_FILE" \
      -dname "CN=HiAnime TV personal build" >/dev/null )
fi
chmod 600 "$KS" "$KS_PASS_FILE"
"$BT/apksigner" sign --ks "$KS" --ks-key-alias hianime-tv --ks-pass "file:$KS_PASS_FILE" \
  --out "$APK" "$OUT/aligned.apk"

echo "[6/6] verify"
"$BT/apksigner" verify --min-sdk-version $MIN_SDK "$APK"
"$BT/aapt2" dump badging "$APK" | grep -E "^(package|sdkVersion|targetSdkVersion|application-label|leanback-launchable|uses-feature)" || true
ls -lh "$APK"
