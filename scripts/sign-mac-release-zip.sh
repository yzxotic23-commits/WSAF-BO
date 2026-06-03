#!/usr/bin/env bash
# Deep ad-hoc sign the .app inside the macOS update zip (required for Squirrel.Mac).
set -euo pipefail

RELEASE_DIR="${1:-release}"
ZIP="$(ls "$RELEASE_DIR"/*arm64-mac.zip 2>/dev/null | head -1 || true)"

if [[ -z "$ZIP" ]]; then
  echo "[sign-mac] No *arm64-mac.zip in $RELEASE_DIR"
  exit 1
fi

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "[sign-mac] Unpacking $(basename "$ZIP")"
unzip -q "$ZIP" -d "$WORKDIR"

APP="$(find "$WORKDIR" -maxdepth 3 -name '*.app' -print -quit)"
if [[ -z "$APP" ]]; then
  echo "[sign-mac] No .app bundle found inside zip"
  exit 1
fi

echo "[sign-mac] Signing $(basename "$APP")"
xattr -cr "$APP" || true
codesign --deep --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

REPACK="$WORKDIR/repack.zip"
(
  cd "$WORKDIR"
  APP_NAME="$(basename "$APP")"
  rm -f "$REPACK"
  ditto -c -k --sequesterRsrc --keepParent "$APP_NAME" "$REPACK"
)

mv "$REPACK" "$ZIP"
rm -f "$ZIP.blockmap"

node "$(dirname "$0")/fix-latest-mac-yml.js" "$RELEASE_DIR"
echo "[sign-mac] OK $(basename "$ZIP")"
