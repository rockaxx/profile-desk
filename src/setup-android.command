#!/bin/bash
set -euo pipefail

fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

download_verified() {
  local url=$1 digest=$2 destination=$3
  printf '\nDownloading %s…\n' "$(/usr/bin/basename "$url")"
  /usr/bin/curl --fail --location --show-error --progress-bar --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 900 --retry 2 --output "$destination" "$url"
  local actual
  actual=$(/usr/bin/shasum -a 256 "$destination" | /usr/bin/awk '{print $1}')
  [[ "$actual" == "$digest" ]] || fail 'Download verification failed (SHA-256 mismatch).'
}

java21() {
  local candidate=$1 version
  [[ -n "$candidate" && -x "$candidate/bin/java" ]] || return 1
  version=$("$candidate/bin/java" -version 2>&1) || return 1
  [[ "$version" =~ version\ \"([0-9]+) ]] && (( BASH_REMATCH[1] >= 21 ))
}

printf 'Profile Desk Android setup\n'
[[ "$#" -eq 1 && "$1" == --accept-sdk-license ]] ||
  fail 'Accept the Android SDK License Agreement in Profile Desk before installing.'

cpu=$(/usr/bin/uname -m)
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then cpu=arm64; fi
case "$cpu" in
  arm64)
    abi=arm64-v8a
    tools_archive=commandlinetools-mac_arm64-15859902_latest.zip
    tools_hash=835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e
    java_archive=OpenJDK21U-jre_aarch64_mac_hotspot_21.0.13_9.tar.gz
    java_hash=225bab0a09491ef06835488cd942f5d2befa9a0410a2484f0c8bbcf7506ec09a
    ;;
  x86_64)
    abi=x86_64
    tools_archive=commandlinetools-mac_x86_64-15859902_latest.zip
    tools_hash=c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3
    java_archive=OpenJDK21U-jre_x64_mac_hotspot_21.0.13_9.tar.gz
    java_hash=c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89
    ;;
  *) fail "Unsupported Mac architecture: $cpu." ;;
esac

sdk="$HOME/Library/Android/sdk"
/bin/mkdir -p "$sdk"
lock="$sdk/.profile-desk-setup-lock"
if ! /bin/mkdir "$lock" 2>/dev/null; then
  existing=$(/bin/cat "$lock/pid" 2>/dev/null || true)
  if [[ "$existing" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$existing" 2>/dev/null; then
    /bin/rm -f "$lock/pid"
    /bin/rmdir "$lock" && /bin/mkdir "$lock" || fail 'Another Android setup is running.'
  else
    fail 'Another Android setup is running.'
  fi
fi
printf '%s\n' "$$" > "$lock/pid"
staging=''
cleanup() {
  if [[ -n "$staging" && "$staging" == "$sdk"/.profile-desk-stage-* ]]; then /bin/rm -rf -- "$staging"; fi
  /bin/rm -f "$lock/pid"
  /bin/rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
staging=$(/usr/bin/mktemp -d "$sdk/.profile-desk-stage-XXXXXX")

private_java="$sdk/profile-desk-java"
java_home="$private_java"
if ! java21 "$java_home"; then
  java_home="${JAVA_HOME:-}"
fi
if ! java21 "$java_home"; then
  java_home=$(/usr/libexec/java_home -F -v '21+' -a "$cpu" 2>/dev/null || true)
fi
if ! java21 "$java_home"; then
  [[ ! -e "$private_java" ]] || fail 'The private Java directory exists but its runtime failed verification.'
  download_verified "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/$java_archive" "$java_hash" "$staging/java.tar.gz"
  /bin/mkdir "$staging/java"
  /usr/bin/tar -xzf "$staging/java.tar.gz" -C "$staging/java"
  java_home=''
  for candidate in "$staging/java"/*/Contents/Home; do
    if [[ -x "$candidate/bin/java" ]]; then java_home="$candidate"; break; fi
  done
  java21 "$java_home" || fail 'Unexpected Java archive layout or version.'
  /bin/mv "$java_home" "$private_java"
  java_home="$private_java"
fi
export JAVA_HOME="$java_home" ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"

tools="$sdk/cmdline-tools/latest"
manager="$tools/bin/sdkmanager"
avdmanager="$tools/bin/avdmanager"
if [[ ! -x "$manager" || ! -x "$avdmanager" ]]; then
  [[ ! -e "$tools" ]] || fail 'Repair the incomplete cmdline-tools/latest directory before retrying.'
  download_verified "https://dl.google.com/android/repository/$tools_archive" "$tools_hash" "$staging/sdk-tools.zip"
  /usr/bin/ditto -x -k "$staging/sdk-tools.zip" "$staging/tools"
  unpacked="$staging/tools/cmdline-tools"
  [[ -f "$unpacked/bin/sdkmanager" && -f "$unpacked/bin/avdmanager" ]] || fail 'Unexpected Android command-line tools archive layout.'
  /bin/chmod u+x "$unpacked/bin/sdkmanager" "$unpacked/bin/avdmanager"
  /bin/mkdir -p "$sdk/cmdline-tools"
  /bin/mv "$unpacked" "$tools"
fi

image="system-images;android-35;google_apis_playstore;$abi"
printf '\nInstalling Android Emulator, Platform-Tools and the Android 35 Google Play image…\n'
printf 'y\n%.0s' {1..16} | "$manager" "--sdk_root=$sdk" --install platform-tools emulator "$image" ||
  fail 'sdkmanager did not complete. Check the messages above and rerun setup.'

emulator="$sdk/emulator/emulator"
[[ -x "$emulator" && -x "$sdk/platform-tools/adb" ]] || fail 'Emulator or Platform-Tools are missing after installation.'
avd=Profile_Desk_Pixel
devices=$("$emulator" -list-avds) || fail 'The emulator could not list devices.'
if ! /usr/bin/grep -Fxq "$avd" <<< "$devices"; then
  printf 'no\n' | "$avdmanager" create avd --name "$avd" --package "$image" --device pixel_7 ||
    fail 'avdmanager could not create the test phone.'
  devices=$("$emulator" -list-avds) || fail 'The emulator could not list devices.'
  /usr/bin/grep -Fxq "$avd" <<< "$devices" || fail 'The new virtual device could not be verified.'
fi
printf '%s\n' "$avd" > "$sdk/.profile-desk-android-ready"
printf '\nAndroid SDK and %s are ready. Return to Profile Desk and click Refresh devices.\n' "$avd"
