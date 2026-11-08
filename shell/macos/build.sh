#!/bin/bash
# Build Hadron.app on a Mac: `shell/macos/build.sh [out-dir]` (default ~/Applications).
# Needs Xcode command line tools (swift, iconutil, codesign); no Xcode project.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-$HOME/Applications}"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../../package.json | head -1)"
[ -n "$VERSION" ] || { echo "no version in package.json" >&2; exit 1; }
running() { pgrep -x HadronShell >/dev/null; }
if running; then echo "Hadron.app is running — quit it first (osascript -e 'quit app \"Hadron\"')" >&2; exit 1; fi
swift build -c release
# Assemble in a staging dir; the bundle in $OUT is replaced only after it signed.
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Hadron.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/HadronShell "$APP/Contents/MacOS/"
sed "s/__VERSION__/$VERSION/g" Info.plist > "$APP/Contents/Info.plist"
# Icon: the PWA 512 master → .icns. No 512@2x: there is no 1024 source and an
# upscale would only be soft.
ICONSET="$STAGE/Hadron.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s ../../client/assets/icons/icon-512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); if [ $d -le 512 ]; then sips -z $d $d ../../client/assets/icons/icon-512.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null; fi
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Hadron.icns"
codesign --force --sign - "$APP" || { echo "codesign failed" >&2; exit 1; }
codesign --verify --strict "$APP" || { echo "codesign verify failed" >&2; exit 1; }
if running; then echo "Hadron.app was launched during the build — quit it and rerun" >&2; exit 1; fi
mkdir -p "$OUT"; rm -rf "$OUT/Hadron.app"; mv "$APP" "$OUT/Hadron.app"   # same volume as mktemp → atomic
echo "built $OUT/Hadron.app (v$VERSION)"
