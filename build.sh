#!/usr/bin/env bash
#
# Compiles src/ and assembles lib/ into a complete, installable extension:
# compiled JavaScript, metadata, stylesheet and the status line wrapper.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

rm -rf lib
./node_modules/.bin/tsc

cp src/metadata.json src/stylesheet.css lib/
cp -r src/schemas src/icons lib/
glib-compile-schemas lib/schemas

# The wrapper travels with the extension so the preferences dialog can point
# settings.json at a stable absolute path. It is run as `gjs -m <path>`, never
# executed directly, so it carries no executable bit.
mkdir -p lib/bin
install -m 0644 bin/claude-usage-statusline.js lib/bin/claude-usage-statusline.js

echo "✓ Built lib/"
