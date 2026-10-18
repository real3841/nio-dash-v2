#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
NATIVE_DIR=${SCRIPT_DIR:h}
ROOT_DIR=${NATIVE_DIR:h}
OUTPUT_DIR=${NIO_NATIVE_OUTPUT_DIR:-"$ROOT_DIR/release-native"}
MODE=${1:-zip}
VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")
SHORT_VERSION=${VERSION%%-*}
APP_NAME="NIO-Dash_$VERSION"
APP_DIR="$OUTPUT_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"

cd "$ROOT_DIR"
npm run build

cd "$NATIVE_DIR"
swift build -c release --arch arm64
BIN_DIR=$(swift build -c release --arch arm64 --show-bin-path)

rm -rf "$OUTPUT_DIR"/*.app(N)
mkdir -p "$CONTENTS_DIR/MacOS" "$CONTENTS_DIR/Resources/web"
cp "$BIN_DIR/NioDashboard" "$CONTENTS_DIR/MacOS/NioDashboard"
# 剥掉调试符号：否则二进制里会留下 /Users/<用户名>/... 的绝对路径，
# 把本机用户名和目录结构带到公开发布的安装包里
strip -S -x "$CONTENTS_DIR/MacOS/NioDashboard" 2>/dev/null || strip -S "$CONTENTS_DIR/MacOS/NioDashboard" 2>/dev/null || true
cp "$NATIVE_DIR/Resources/Info.plist" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleShortVersionString -string "$SHORT_VERSION" "$CONTENTS_DIR/Info.plist"
cp "$NATIVE_DIR/Resources/PrivacyInfo.xcprivacy" "$CONTENTS_DIR/Resources/PrivacyInfo.xcprivacy"
ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
swift "$SCRIPT_DIR/make-icon.swift" "$NATIVE_DIR/Resources/AppIcon.svg" "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$CONTENTS_DIR/Resources/AppIcon.icns"
rm -rf "${ICONSET_DIR:h}"
cp -R "$ROOT_DIR/dist/." "$CONTENTS_DIR/Resources/web/"

IDENTITY=${CODESIGN_IDENTITY:--}
codesign --force --deep --options runtime --sign "$IDENTITY" "$APP_DIR"

zsh "$SCRIPT_DIR/verify-package.sh" "$APP_DIR"

if [[ "$MODE" == "app" ]]; then
  print "$APP_DIR"
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
ZIP_PATH="$OUTPUT_DIR/NIO-Dash-$VERSION-arm64.zip"
rm -f "$ZIP_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"
zsh "$SCRIPT_DIR/verify-package.sh" "$ZIP_PATH"

if [[ "$MODE" == "dmg" ]]; then
  DMG_PATH="$OUTPUT_DIR/NIO-Dash-$VERSION-arm64.dmg"
  rm -f "$DMG_PATH"
  hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_PATH"
  print "$DMG_PATH"
else
  print "$ZIP_PATH"
fi
