#!/bin/zsh
set -euo pipefail

TARGET=${1:?"usage: verify-package.sh <app-or-zip>"}
MAX_ZIP_BYTES=$((30 * 1024 * 1024))
FORBIDDEN_PATTERN='(^|/)(config\.env|.*\.har|vehicle\.json|history\.json|change\.json|checkin\.json|power\.json|vehicle-photos|Electron Framework\.framework|node)(/|$)'

if [[ -d "$TARGET" ]]; then
  FILE_LIST=$(cd "$TARGET" && /usr/bin/find . -print)
  print -r -- "$FILE_LIST" | /usr/bin/grep -Eiq "$FORBIDDEN_PATTERN" && {
    print -u2 "隐私检查失败：安装包含运行期数据或 Electron/Node 文件"
    exit 1
  }
  [[ -f "$TARGET/Contents/Resources/PrivacyInfo.xcprivacy" ]] || {
    print -u2 "隐私检查失败：缺少 PrivacyInfo.xcprivacy"
    exit 1
  }
  ARCHS=$(lipo -archs "$TARGET/Contents/MacOS/NioDashboard")
  [[ "$ARCHS" == "arm64" ]] || {
    print -u2 "架构检查失败：预期 arm64，实际 $ARCHS"
    exit 1
  }
  codesign --verify --deep --strict "$TARGET"
  exit 0
fi

[[ "$TARGET" == *.zip ]] || {
  print -u2 "不支持的产物：$TARGET"
  exit 1
}

SIZE=$(stat -f%z "$TARGET")
(( SIZE <= MAX_ZIP_BYTES )) || {
  print -u2 "体积检查失败：ZIP 超过 30 MB（$SIZE bytes）"
  exit 1
}
FILE_LIST=$(unzip -Z1 "$TARGET")
print -r -- "$FILE_LIST" | /usr/bin/grep -Eiq "$FORBIDDEN_PATTERN" && {
  print -u2 "隐私检查失败：ZIP 含运行期数据或 Electron/Node 文件"
  exit 1
}
print "验证通过：$SIZE bytes"
