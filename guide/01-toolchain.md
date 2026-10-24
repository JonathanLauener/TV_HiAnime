# 01 — Gradle-free Android toolchain on Linux

Goal: everything needed to build, sign, lint and emulator-test an APK, installed per-user,
without Gradle/AGP and without changing global shell config.

## What you need

| Component | Version used | Why |
|---|---|---|
| JDK | OpenJDK 21.0.2 (via mise) | `javac`, `keytool`; runs d8/apksigner/lint |
| Android cmdline-tools | latest (`sdkmanager`, `avdmanager`, `lint`) | install the rest |
| `platform-tools` | latest | `adb` |
| `platforms;android-35` | 35 | `android.jar` to compile against |
| `build-tools;35.0.0` | 35.0.0 | `aapt2`, `d8`, `zipalign`, `apksigner`, `core-lambda-stubs.jar` |
| `emulator` | latest | headless Android TV emulator |
| TV system image | `system-images;android-36;android-tv;x86_64` | test device |

Disk: SDK + one TV image ≈ 3–4 GB in `~/Android/Sdk`.

## 1. JDK via mise (no global activation)

```bash
mise install java@21.0.2                 # installs, does NOT change your global default
export JAVA_HOME=$(mise where java@21.0.2)
"$JAVA_HOME/bin/java" -version
```

`mise` warns "installed but not activated" — that's intended. Every later command sets
`JAVA_HOME` explicitly; `build.sh` falls back to `mise where java@21.0.2` if `JAVA_HOME` is unset.

## 2. cmdline-tools

Find the newest build number from Google's repository index. **Sort numerically** — a lexical
sort picks `9862592` over `16111833`:

```bash
V=$(curl -sS https://dl.google.com/android/repository/repository2-3.xml \
  | grep -oE 'commandlinetools-linux-[0-9]+_latest\.zip' | grep -oE '[0-9]+' | sort -n | tail -1)
echo "cmdline-tools build $V"

export ANDROID_HOME=$HOME/Android/Sdk
mkdir -p "$ANDROID_HOME/cmdline-tools"
curl -sSL -o /tmp/clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-${V}_latest.zip"
rm -rf /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt
rm -rf "$ANDROID_HOME/cmdline-tools/latest" && mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

The layout must be `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`, or sdkmanager
cannot find the SDK root.

## 3. SDK packages

```bash
export JAVA_HOME=$(mise where java@21.0.2) ANDROID_HOME=$HOME/Android/Sdk
SM=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
yes | "$SM" --licenses >/dev/null || true      # newer releases say this is no longer needed
"$SM" --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" "emulator"
```

Notes seen with cmdline-tools build 16111833:
- `sdkmanager` prints a deprecation notice pointing at the new `android` CLI; it still works.
- `--licenses` prints "no longer needed".

### TV system image

List what exists (the output format changed; grep on `system-images` and `tv`):

```bash
"$SM" --list 2>/dev/null | grep -iE 'system-images' | grep -iE 'tv' | awk '{print $1}' | sort -u
```

Observed on 2026-10-24: TV images exist for API 33, 34 and 36 only (`android-tv` and `google-tv`).
**No API 28/29 TV image was offered**, so an Android 9 TV can't be emulated exactly. Use the newest
x86_64 image for behaviour and Android lint for API-level compatibility (05).

```bash
"$SM" --install "system-images;android-36;android-tv;x86_64"
```

## 4. KVM check (needed for a usable emulator)

```bash
ls -l /dev/kvm                       # want crw-rw-rw- or your user in group kvm
grep -cE 'vmx|svm' /proc/cpuinfo     # > 0 means hardware virtualisation is available
```

## 5. Where AVDs land

On this machine (XDG config layout) `avdmanager` wrote the AVD to
`~/.config/.android/avd/`, **not** `~/.android/avd/`. The emulator then needs:

```bash
export ANDROID_AVD_HOME=$HOME/.config/.android/avd
```

If `avdmanager create` exits 0 but `~/.android/avd` doesn't exist, look there:

```bash
find ~ -maxdepth 4 -name '*.ini' -path '*avd*'
```

## 6. Other tools used

| Tool | Used for | Check |
|---|---|---|
| `zip` / `unzip` | adding `classes.dex` to the APK | `which zip` |
| ImageMagick `magick` | generating icon + 320×180 TV banner | `which magick` |
| `/usr/bin/chromium` | REA browser captures (launch mode) | `chromium --version` |
| `python3` | parsing oversized capture JSON | stdlib only |

## Environment snippet for every later step

```bash
export JAVA_HOME=$(mise where java@21.0.2)
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_AVD_HOME=$HOME/.config/.android/avd
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```
