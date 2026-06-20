#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null && pwd)"

"$script_dir/cleanup-tauri-dmg.sh"
tauri build
