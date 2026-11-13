#!/bin/bash
# 패시브 스킬 [1차 압축]을 이 컴퓨터(Claude Code 를 쓰는 곳)에 설치한다: 10초마다 실행되는 launchd 타이머.
# 저장소에는 아무것도 쓰지 않고 ~/.mimic-note/drafts/ 에만 쌓는다. 최종 push 는 [로그아웃].
#
#   bash mimic-note/passive/install-compress.sh            설치(또는 다시 설치)
#   bash mimic-note/passive/install-compress.sh --status   상태와 최근 로그
#   bash mimic-note/passive/install-compress.sh --remove   제거
set -euo pipefail
LABEL="com.mimicnote.compress"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.mimic-note/compress.log"
INTERVAL="${MIMIC_NOTE_COMPRESS_INTERVAL:-10}"
case "${1:-}" in
  --remove) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "제거했습니다: $LABEL"; exit 0 ;;
  --status) launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|run interval" || echo "설치되어 있지 않음"; tail -n 10 "$LOG" 2>/dev/null || true; exit 0 ;;
esac
NODE="$(command -v node || true)"
[ -z "$NODE" ] && for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
[ -z "$NODE" ] && { echo "Node 를 찾지 못했습니다."; exit 1; }
mkdir -p "$HOME/.mimic-note" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO_DIR/mimic-note/passive/compress.mjs</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "설치했습니다: $LABEL (${INTERVAL}초마다) · 로그 $LOG"
