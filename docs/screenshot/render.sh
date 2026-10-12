#!/bin/sh
# Renders docs/screenshot.png: runs scenario.tsx through the engine's test kit
# (as a test, for the run only) and paints the pane it draws, beside a Claude
# Code session, the way a 24-bit terminal shows it.
# Needs `claude`, and `uv` for Pillow and fontTools.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
mod="$root/plugin"
work=$(mktemp -d)
trap 'rm -rf "$work" "$mod/tests/zz-screenshot.test.tsx"' EXIT

cp "$here/scenario.tsx" "$mod/tests/zz-screenshot.test.tsx"
(cd "$mod" && claude plugin test . >"$work/out.txt" 2>&1) || {
  grep -A8 '(fail)' "$work/out.txt" >&2 || cat "$work/out.txt" >&2
  exit 1
}
sed -n 's/.*TREE_CELLS//p' "$work/out.txt" >"$work/cells.json"
sed -n 's/.*TREE_PIXELS//p' "$work/out.txt" >"$work/pixels.json"
uv run --quiet --with pillow --with fonttools python3 "$here/paint.py" "$work/cells.json" "$root/docs/screenshot.png"
