#!/usr/bin/env bash
#
# Render docs/server-mode.html to one PNG per wireframe frame.
#
# The document draws each frame from data (see its inline <script>) and honours
# an `?only=<frame id>` query parameter, which drops every other frame and
# strips the page chrome. Each frame is captured twice: once with --dump-dom to
# read back the size the page reports in `data-capture-w/h`, then again with
# --screenshot at exactly that size. That keeps the PNGs tight without any
# per-frame numbers to maintain here.
#
# Requirements: Google Chrome. "Fira Mono for Powerline" — the terminal font
# the app asks for — is worth having but is not required: the row and column
# counts the page prints come from the cell-size constants in its <script>, not
# from measuring the rendered font, so they are the same either way. Without it
# the mock terminal text falls back to Menlo, whose 11px advance (6.62px) is
# within a third of a percent of Fira's, so the frames look the same too.
#
# Usage: bash scripts/wireframes.sh [outdir] [frame...]
#
#   outdir   where the PNGs go (default: a fresh temp dir)
#   frame    frame ids to render (default: all of them). Naming a subset —
#            e.g. `wireframes.sh out f4` — re-renders just those, which is the
#            difference between 20 seconds and ten minutes while iterating on
#            one frame.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$REPO/docs/server-mode.html"
OUT="${1:-$(mktemp -d -t the-wall-wireframes)}"
shift || true
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ALL_FRAMES=(f1 f2 f3 f4 f5 f6 f7 f8)
if [ "$#" -gt 0 ]; then FRAMES=("$@"); else FRAMES=("${ALL_FRAMES[@]}"); fi
SCALE=2      # device pixel ratio: 2× keeps the 11px terminal text legible
SETTLE=0.35  # poll interval while waiting for Chrome's output to stop growing
MAX_POLLS=170

[ -x "$CHROME" ] || {
  echo "error: Google Chrome not found at $CHROME" >&2
  exit 1
}
[ -f "$DOC" ] || {
  echo "error: $DOC not found" >&2
  exit 1
}
mkdir -p "$OUT"

WORKDIR="$(mktemp -d -t the-wall-wireframes-work)"
PROFILE="$WORKDIR/profile" # Chrome won't share a profile with a running instance
trap 'rm -rf "$WORKDIR"' EXIT

# Headless Chrome finishes writing its output long before it exits — on a fresh
# profile the shutdown path can sit for a minute tearing down background
# networking. Rather than wait it out, run it detached and stop it once the file
# it is producing has stopped growing.
#
#   chrome_until <file to watch> <stdout destination> <chrome args...>
chrome_until() {
  local watch="$1" stdout="$2"
  shift 2
  rm -f "$watch"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --no-first-run \
    --no-default-browser-check --disable-background-networking \
    --user-data-dir="$PROFILE" "$@" >"$stdout" 2>/dev/null &
  local pid=$! last=-1 size=0 stable=0 i=0
  while [ "$i" -lt "$MAX_POLLS" ]; do
    sleep "$SETTLE"
    i=$((i + 1))
    # Braces so the *redirection* failure is silenced too: for the first polls
    # the file does not exist yet, and bash reports that itself, before wc runs.
    size=$({ wc -c <"$watch"; } 2>/dev/null || echo 0)
    if [ "$size" -gt 0 ] && [ "$size" -eq "$last" ]; then
      stable=$((stable + 1))
      [ "$stable" -ge 2 ] && break
    else
      stable=0
    fi
    last=$size
    kill -0 "$pid" 2>/dev/null || break
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -s "$watch" ]
}

for id in "${FRAMES[@]}"; do
  url="file://$DOC?only=$id"
  dom="$WORKDIR/$id.html"

  # Ask the page how big it rendered. It sets both attributes after layout and
  # again once fonts have loaded, so the last match is the settled one.
  chrome_until "$dom" "$dom" --dump-dom "$url" || {
    echo "error: $id produced no DOM" >&2
    exit 1
  }
  w="$(grep -o 'data-capture-w="[0-9]*"' "$dom" | tail -1 | tr -dc '0-9')"
  h="$(grep -o 'data-capture-h="[0-9]*"' "$dom" | tail -1 | tr -dc '0-9')"
  if [ -z "$w" ] || [ -z "$h" ]; then
    echo "error: $id did not report a size — is the document rendering?" >&2
    exit 1
  fi

  chrome_until "$OUT/$id.png" /dev/null --screenshot="$OUT/$id.png" \
    --window-size="$w,$h" --force-device-scale-factor="$SCALE" "$url" || {
    echo "error: $id produced no screenshot" >&2
    exit 1
  }
  printf '%s  %sx%s @%sx\n' "$id" "$w" "$h" "$SCALE"
done

echo "Wrote ${#FRAMES[@]} frames to $OUT"
