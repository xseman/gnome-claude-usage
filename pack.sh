#!/usr/bin/env bash
#
# Builds lib/ and zips it into the bundle extensions.gnome.org expects: every
# file at the archive root, metadata.json among them.
#
# `gnome-extensions pack` would do the same, but it ships in the gnome-shell
# package, so using it in CI means installing all of GNOME to produce a 20 kB
# zip. It also bundles only a fixed set of files unless every extra one is
# listed. A plain zip needs nothing installed and is explicit about its contents.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

./build.sh >/dev/null

uuid="$(python3 -c 'import json; print(json.load(open("src/metadata.json"))["uuid"])')"
zip_path="$here/dist/$uuid.shell-extension.zip"

mkdir -p dist
rm -f "$zip_path"

# -X drops uid/gid and extra attributes so the same tree always zips the same.
# The reviewers compile the schema themselves; only the XML belongs in the zip.
(cd lib && zip -q -r -X "$zip_path" . -x 'schemas/gschemas.compiled')

# A bundle missing either of these is rejected on upload, so fail here instead.
for required in metadata.json "schemas/$(basename "$(ls src/schemas/*.gschema.xml)")"; do
	unzip -l "$zip_path" | grep -q " $required\$" || {
		echo "✗ $required is missing from the bundle" >&2
		exit 1
	}
done

echo "✓ $zip_path"
