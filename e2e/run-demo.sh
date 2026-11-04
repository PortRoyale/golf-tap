#!/usr/bin/env bash
# Starts the demo GSPro and golf-tap in a clean folder, then runs the screenshot walk.
# Usage: e2e/run-demo.sh <workDir>
set -euo pipefail
W="$1"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in "$W/gspro.pid" "$W/tap.pid"; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
sleep 0.5
rm -rf "$W"; mkdir -p "$W/home/AppData/LocalLow/GSPro/GSPro" "$W/run" "$W/shots"
cd "$ROOT"
node --no-warnings build-ui.ts
HOME="$W/home" node --no-warnings e2e/fake-gspro.ts 9921 "$W/home/AppData/LocalLow/GSPro/GSPro" > "$W/gspro.log" 2>&1 &
echo $! > "$W/gspro.pid"
sleep 1
cd "$W/run"
HOME="$W/home" GOLF_TAP_DEMO_CLOCK=1 node --no-warnings "$ROOT/tap.ts" --listen 9211 --upstream 127.0.0.1:9921 --ui 8080 > "$W/tap-console.txt" 2>&1 &
echo $! > "$W/tap.pid"
cd "$ROOT"
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8080/api/stats && break; sleep 0.25; done
sleep 1
status=0
HOME="$W/home" node --no-warnings e2e/shoot.ts "$W/shots" "$W/tap-console.txt" "$W/run/sqe.db" || status=$?
kill "$(cat "$W/tap.pid")" "$(cat "$W/gspro.pid")" 2>/dev/null || true
exit $status
