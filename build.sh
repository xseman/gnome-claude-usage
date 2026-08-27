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
cp -r src/schemas lib/
glib-compile-schemas lib/schemas

# The wrapper travels with the extension so the preferences dialog can point
# settings.json at a stable absolute path.
mkdir -p lib/bin
install -m 0755 bin/claude-usage-statusline lib/bin/claude-usage-statusline

echo "✓ Built lib/"
