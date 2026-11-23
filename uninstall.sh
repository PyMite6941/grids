#!/bin/sh
# Grids uninstall (macOS / Linux). Run: sh uninstall.sh
# Nothing is deleted without asking; every question defaults to "no" unless shown otherwise.
ROOT=$(cd "$(dirname "$0")" && pwd)

if command -v node >/dev/null 2>&1; then
  if ! node "$ROOT/web/setup.mjs" --uninstall --from-script; then
    echo
    echo "Uninstall stopped before it finished; nothing else was changed."
    exit 1
  fi
else
  echo "Node.js was not found, so the guided uninstall can't run. Do these by hand:"
  echo "  1. Claude Code:  claude mcp remove --scope user grids"
  echo "  2. Other MCP clients: delete their \"grids\" entry."
  echo "  3. Delete your key file if you want: $ROOT/.env or ~/.grids/.env"
  echo "     (and .grids-usage.json beside it), then the folder ~/.grids."
  echo "  Your workbooks are not touched."
fi

echo
if command -v git >/dev/null 2>&1 && [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  echo "Warning: this folder has changes that are not committed to git; deleting it loses them."
fi
printf 'Delete the Grids folder itself (%s)? (y/n) [n] ' "$ROOT"
read -r ANS
case "$ANS" in
  y|Y|yes|YES)
    cd / && rm -rf -- "$ROOT"
    if [ -e "$ROOT" ]; then echo "Could not delete everything; delete $ROOT by hand."; else echo "Grids is uninstalled."; fi
    ;;
  *) echo "Kept the folder." ;;
esac
