#!/bin/bash
# 패시브 스킬 [자동 다운로드]를 맥미니에 설치한다: 10분마다 실행되는 launchd 타이머.
#
#   bash mimic-note/passive/install-macmini.sh            설치(또는 다시 설치)
#   bash mimic-note/passive/install-macmini.sh --status   상태와 최근 로그
#   bash mimic-note/passive/install-macmini.sh --remove   제거
#
# 필요: Node 18 이상, 이 저장소에 push 할 수 있는 GitHub SSH 키.
# 텔레그램 알림: 저장소 루트의 .env 에 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS='{"minho":"…"}' (git 에 안 올라감)
set -euo pipefail

LABEL="com.mimicnote.auto-download"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.mimic-note"
LOG="$LOG_DIR/auto-download.log"
INTERVAL="${MIMIC_NOTE_INTERVAL:-600}"

case "${1:-}" in
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "제거했습니다: $LABEL"
    exit 0 ;;
  --status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|run interval" || echo "설치되어 있지 않음"
    echo "--- 최근 로그 ($LOG)"
    tail -n 15 "$LOG" 2>/dev/null || echo "(로그 없음)"
    exit 0 ;;
esac

NODE="$(command -v node || true)"
[ -z "$NODE" ] && for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
[ -z "$NODE" ] && { echo "Node 를 찾지 못했습니다. Node 18 이상을 설치하세요."; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -lt 18 ] && { echo "Node $MAJOR 은 너무 낮습니다(18 이상 필요)."; exit 1; }

echo "저장소: $REPO_DIR"
echo "Node:   $NODE (v$("$NODE" -v | tr -d v))"
echo -n "GitHub push 권한 확인… "
if git -C "$REPO_DIR" push --dry-run -q origin HEAD 2>/dev/null; then echo "OK"; else
  echo "실패"; echo "이 컴퓨터에서 저장소로 push 할 수 없습니다. GitHub SSH 키를 등록하고 origin 을 git@github.com:newcode135-prog/mimic.git 로 맞추세요."; exit 1; fi

echo "한 번 시험 실행…"
"$NODE" "$REPO_DIR/mimic-note/passive/auto-download.mjs"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO_DIR/mimic-note/passive/auto-download.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "설치했습니다: ${INTERVAL}초마다 실행 ($LABEL)"
echo "상태 보기: bash mimic-note/passive/install-macmini.sh --status"
