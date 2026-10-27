#!/usr/bin/env bash
# Installs an APK on the running emulator, opens it and fails when the app is not running
# 30 seconds later: the release build must at least start. Leaves launch-logcat.txt and
# launch.png behind for the workflow to keep. Usage: launch-check.sh <apk> <package>
set -uo pipefail
apk=$1
package=$2

adb install -r "$apk"
adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1
sleep 30
adb exec-out screencap -p > launch.png || true
adb logcat -d > launch-logcat.txt

# What a crash at start leaves in the log: a Java exception, a JavaScript error or a native one.
grep -E "FATAL EXCEPTION|AndroidRuntime|ReactNativeJS|ReactNative|Hermes|SoLoader|DEBUG +: |libc +: " \
  launch-logcat.txt | tail -n 200

if adb shell pidof "$package" > /dev/null; then
  echo "$package is running 30 s after launch"
else
  echo "::error::$package is not running 30 s after launch (see the log above)"
  exit 1
fi
