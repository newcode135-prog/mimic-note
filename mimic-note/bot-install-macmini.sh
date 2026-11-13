#!/bin/bash
# 코어 오브 미믹노트 봇(bot.mjs)을 맥미니에 상시 실행으로 설치한다(launchd, 꺼지면 다시 켬).
#
#   bash mimic-note/bot-install-macmini.sh            설치(또는 다시 설치)
#   bash mimic-note/bot-install-macmini.sh --status   상태와 최근 로그
#   bash mimic-note/bot-install-macmini.sh --remove   제거
#
# 필요: Node 18 이상, 저장소 루트 .env 에 TELEGRAM_BOT_TOKEN 과 연결된 팀원의 TELEGRAM_CHAT_ID_<아이디>
#       (.env 는 git 에 안 올라감 — 연결한 컴퓨터에서 안전하게 옮기거나, 맥미니에서 telegram.mjs connect 로 다시 연결).
# 같은 봇은 한 컴퓨터에서만: 다른 컴퓨터에서 bot.mjs 를 켜 두었다면 먼저 끄세요.
set -euo pipefail

LABEL="com.mimicnote.core-bot"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.mimic-note"
LOG="$LOG_DIR/core-bot.log"

case "${1:-}" in
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "제거했습니다: $LABEL"
    exit 0 ;;
  --status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|pid" || echo "설치되어 있지 않음"
    echo "--- 최근 로그 ($LOG)"
    tail -n 15 "$LOG" 2>/dev/null || echo "(로그 없음)"
    exit 0 ;;
esac

NODE="$(command -v node || true)"
[ -z "$NODE" ] && for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
[ -z "$NODE" ] && { echo "Node 를 찾지 못했습니다. Node 18 이상을 설치하세요."; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -lt 18 ] && { echo "Node $MAJOR 은 너무 낮습니다(18 이상 필요)."; exit 1; }
grep -q '^TELEGRAM_BOT_TOKEN=' "$REPO_DIR/.env" 2>/dev/null || { echo "$REPO_DIR/.env 에 TELEGRAM_BOT_TOKEN 이 없습니다. 먼저 node mimic-note/telegram.mjs connect 를 실행하세요."; exit 1; }

echo "저장소: $REPO_DIR"
echo "Node:   $NODE (v$("$NODE" -v | tr -d v))"
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
    <string>$REPO_DIR/mimic-note/bot.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
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
echo "설치했습니다: 코어 오브 미믹노트 봇이 항상 켜져 있습니다 ($LABEL)"
echo "상태 보기: bash mimic-note/bot-install-macmini.sh --status"
