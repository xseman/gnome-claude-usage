#!/bin/sh
#
# Builds the extension, then runs every suite against the compiled output under
# plain gjs. Fails on the first suite that does.
#
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"

"$root/build.sh" >/dev/null

for suite in "$here"/*.test.js; do
	echo "== $(basename "$suite")"
	gjs -m "$suite"
	echo
done

echo "all suites passed"
