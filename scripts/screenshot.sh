#!/usr/bin/env bash
#
# Regenerate the README screenshot (assets/the-wall.png).
#
# Launches the app in demo mode — a fixed multi-pane layout, see runDemo() in
# src/main.ts — waits for it to render, captures its native window (rounded
# corners and drop shadow included) with screencapture, then quits the app.
#
# Requirements:
#   - macOS, with the Tauri dev toolchain (`npm run tauri dev` must work).
#   - Screen Recording permission for the terminal app running this script;
#     macOS prompts the first time screencapture targets another window. Without
#     it the capture is blank.
#
# Usage: npm run screenshot   (or: bash scripts/screenshot.sh)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/assets/the-wall.png"
OWNER="the-wall"        # CGWindowOwnerName of the dev binary (src-tauri Cargo name)
DEV_PORT=1420           # vite dev server port (tauri.conf.json devUrl)
WINDOW_TIMEOUT=300      # seconds to wait for the build + window (cold build is slow)
RENDER_WAIT=13          # seconds for shells to ready, the demo to type, and commands to render

cd "$REPO"

WORKDIR="$(mktemp -d -t the-wall-shot)"
WINID_SWIFT="$WORKDIR/winid.swift"
DEV_PID=""
cleanup() {
  pkill -f "target/debug/$OWNER" 2>/dev/null || true      # the GUI app
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true # the top `npm run tauri dev`
  # tauri runs vite as a beforeDevCommand; it gets reparented to launchd and
  # outlives tauri, holding port 1420. The PID tree no longer reaches it, so
  # kill it by port — but only if it's *our* vite, never a foreign :1420 server.
  for pid in $(lsof -ti "tcp:$DEV_PORT" 2>/dev/null); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -q "the-wall/node_modules"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

# Resolve the app window's CGWindowID by owner name. CGWindowOwnerName is
# readable without Screen Recording permission (window *names* are not), so we
# match on the owner and a normal window layer.
cat >"$WINID_SWIFT" <<'SWIFT'
import CoreGraphics
import Foundation
let owner = CommandLine.arguments.dropFirst().first ?? ""
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for w in list {
    let o = w[kCGWindowOwnerName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    if layer == 0, o == owner, let num = w[kCGWindowNumber as String] as? Int {
        print(num)
        exit(0)
    }
}
exit(1)
SWIFT

echo "Launching the-wall in demo mode…"
THE_WALL_DEMO="$REPO" npm run tauri dev </dev/null >"$WORKDIR/dev.log" 2>&1 &
DEV_PID=$!

echo "Waiting for the window (a cold run builds Rust first; up to ${WINDOW_TIMEOUT}s)…"
WINID=""
for ((i = 0; i < WINDOW_TIMEOUT; i++)); do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "error: 'npm run tauri dev' exited early — see $WORKDIR/dev.log" >&2
    cat "$WORKDIR/dev.log" >&2 || true
    exit 1
  fi
  if WINID="$(swift "$WINID_SWIFT" "$OWNER" 2>/dev/null)" && [ -n "$WINID" ]; then
    break
  fi
  WINID=""
  sleep 1
done
if [ -z "$WINID" ]; then
  echo "error: the-wall window not found within ${WINDOW_TIMEOUT}s (see $WORKDIR/dev.log)" >&2
  exit 1
fi

echo "Window $WINID is up; waiting ${RENDER_WAIT}s for the panes to render…"
sleep "$RENDER_WAIT"

echo "Capturing → $OUT"
# Capture to a temp file first so a failed grab leaves the committed image
# intact. -x: silent; no -o: keep the window shadow.
TMP_OUT="$WORKDIR/the-wall.png"
if ! screencapture -x -l"$WINID" "$TMP_OUT" || [ ! -s "$TMP_OUT" ]; then
  echo "error: screen capture failed." >&2
  echo "Grant Screen Recording permission to this terminal in System Settings →" >&2
  echo "Privacy & Security → Screen Recording, then FULLY QUIT and reopen the" >&2
  echo "terminal (the permission only applies to newly launched processes)." >&2
  exit 1
fi
mv "$TMP_OUT" "$OUT"

echo "Done."
sips -g pixelWidth -g pixelHeight "$OUT"
