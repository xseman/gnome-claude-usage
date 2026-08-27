#!/usr/bin/env bash
#
# Installs the built extension into the current user's extension directory.
# Nothing outside that directory is touched: the status line hook is installed
# per profile from the extension's preferences, so no Claude Code config is ever
# rewritten here.
#
#   EXT_DIR=~/somewhere ./install.sh     # override the install dir
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$here/lib" ]]; then
	echo "✗ lib/ is missing, build it first:" >&2
	echo "    bun install && bun run build" >&2
	exit 1
fi

uuid="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/src/metadata.json")"
ext_dir="${EXT_DIR:-$HOME/.local/share/gnome-shell/extensions/$uuid}"

rm -rf "$ext_dir"
mkdir -p "$ext_dir"
cp -r "$here/lib/." "$ext_dir/"

echo "✓ Installed $ext_dir"

# GNOME Shell has to pick the extension up before it can be enabled. On Wayland
# that means a new session; on Xorg an Alt+F2 r is enough.
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
	echo "ℹ Wayland: log out and back in, then run:"
else
	echo "ℹ Press Alt+F2, type r, press Enter, then run:"
fi

echo "    gnome-extensions enable $uuid"
echo "    gnome-extensions prefs $uuid"
