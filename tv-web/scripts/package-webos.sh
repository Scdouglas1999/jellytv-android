#!/usr/bin/env bash
# Builds the webOS package (dist/io.github.scdouglas1999.tally_<version>_all.ipk): the installed shell.
#   scripts/package-webos.sh [--server http://192.168.1.50:8096]
# ARES overrides the folder of the webOS CLI (default ~/tools/webos-cli/node_modules/.bin).
# For development with LG's CLI (ares-install); people use Tally for LG (installer/lg), which writes the same package.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER="" BUNDLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;  # development: bundle from a dev machine (vite preview)
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
ARES="${ARES:-$HOME/tools/webos-cli/node_modules/.bin}"
[[ -x "$ARES/ares-package" ]] || { echo "webOS CLI not found in $ARES (npm install @webos-tools/cli, see README.md)" >&2; exit 1; }
VERSION="$(node -p "require('./package.json').version")"
STAGE="dist/webos"
rm -rf "$STAGE" && mkdir -p "$STAGE/fonts"
cp shell/shell.js shell/shell.css "$STAGE/"
cp shell/fonts/*.woff2 "$STAGE/fonts/"
cp ../IBM-PLEX-OFL.txt "$STAGE/fonts/OFL.txt"
cp shell/icons/icon-80.png shell/icons/icon-130.png "$STAGE/"
sed "s/@VERSION@/$VERSION/" shell/webos/appinfo.json > "$STAGE/appinfo.json"
sed 's#<!-- PLATFORM:.*-->##' shell/index.html > "$STAGE/index.html"
node -e '
const [server, bundle] = process.argv.slice(1);
process.stdout.write("window.TALLY_SHELL_CONFIG = " + JSON.stringify({ platform: "webos", server, bundle }, null, 2) + ";\n");
' "$SERVER" "$BUNDLE" > "$STAGE/config.js"
"$ARES/ares-package" --no-minify -o dist "$STAGE"
ls -la dist/*.ipk
