#!/usr/bin/env bash
#
# Builds lib/ and bundles it into the zip extensions.gnome.org expects. Every
# module has to be listed: `gnome-extensions pack` only picks up extension.js,
# prefs.js, metadata.json, stylesheet.css and schemas/ on its own, and silently
# leaves everything else out.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

./build.sh >/dev/null

args=()
for module in lib/*.js; do
	case "$(basename "$module")" in
		extension.js | prefs.js) ;;
		*) args+=("--extra-source=$(basename "$module")") ;;
	esac
done

mkdir -p dist
gnome-extensions pack --force \
	"${args[@]}" \
	--extra-source=icons \
	--extra-source=bin \
	--out-dir "$here/dist" \
	lib

for zip in dist/*.shell-extension.zip; do echo "✓ $zip"; done
