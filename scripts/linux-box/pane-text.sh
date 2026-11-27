#!/usr/bin/env bash
# Prints the text a qmux pane has drawn, from its persisted scrollback.
#
# Linux builds have no terminal renderer yet (panes are native Ghostty surfaces
# on macOS only), so a pane's area stays blank on screen. The PTY still runs and
# qmux still records its output under the workspace root, which is how the
# Linux smoke test checks that an agent CLI started.
#
# Usage: scripts/linux-box/pane-text.sh [pane-id | path-to-.pty]
#   With no argument, prints the most recently written pane.
# Set QMUX_WORKSPACE_ROOT if qmux uses a non-default workspace root.
set -euo pipefail

root="${QMUX_WORKSPACE_ROOT:-$HOME/.local/share/qmux/workspaces}"
dir="$root/.qmux/terminal"

case "${1:-}" in
  "") file="$(ls -t "$dir"/*.pty 2>/dev/null | head -1)" ;;
  */*) file="$1" ;;
  *) file="$dir/$1.pty" ;;
esac

if [[ -z "$file" || ! -f "$file" ]]; then
  echo "no pane scrollback found (looked in $dir)" >&2
  exit 1
fi

echo "== $(basename "$file" .pty) ($(wc -c <"$file") bytes)"
# Drop CSI, OSC, charset and single-character escapes. Cursor-movement codes
# stand in for spaces in TUI output, so words can run together; that is enough
# to recognise a CLI's screen.
perl -pe '
  s/\e\[[0-9;?<>=]*[ -\/]*[@-~]//g;
  s/\e\][^\a\e]*(?:\a|\e\\)//g;
  s/\e[()][A-Z0-9]//g;
  s/\e[=>78M]//g;
  s/\r//g;
' "$file" | grep -v '^[[:space:]]*$'
