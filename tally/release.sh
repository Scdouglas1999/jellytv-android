#!/bin/bash
# Builds a Tally release into tally/out/: the signed APKs for Android TV, the server plugin (a zip per Jellyfin
# version, Tally-Server-Setup.exe, docker-compose.yml, install-linux.sh, and the plugin repository's manifest.json), and
# "Tally for Samsung" and "Tally for LG", the TV installers (Tally-Samsung-Installer-windows.exe, -linux, -macos-arm64,
# -macos-x64, and the same four Tally-LG-Installer-*).
#   tally/release.sh              build everything and show what --publish would run
#   tally/release.sh --publish    also tag, push, create the GitHub release and publish the plugin repository entry
#   --stores                      also build the Play bundle and the Amazon APK
# The signing key lives OUTSIDE the repository: ~/.config/tally/release.jks + release.env
# (KEY_ALIAS, KEY_PASSWORD, KEY_STORE_PASSWORD). Keep a backup of both: an APK signed with a
# different key cannot update an installed one.
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLISH=0; [ "${1:-}" = "--publish" ] && PUBLISH=1
DOTNET="${DOTNET:-$HOME/.dotnet/dotnet}"; command -v "$DOTNET" >/dev/null || DOTNET=dotnet
KEYDIR="${TALLY_KEYDIR:-$HOME/.config/tally}"
[ -f "$KEYDIR/release.jks" ] && [ -f "$KEYDIR/release.env" ] || { echo "missing $KEYDIR/release.jks or release.env" >&2; exit 1; }
if [ $PUBLISH = 1 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "commit your changes first: the version is derived from git" >&2; exit 1; fi
set -a; . "$KEYDIR/release.env"; set +a
export CI=true   # upstream only signs "CI" builds; this is the only thing the flag changes
export SIGNING_KEY="$(base64 -w0 "$KEYDIR/release.jks")"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

# Tally's version line: a release is tagged tally-vMAJOR.MINOR.PATCH before it is built (git tag tally-v2.0.1), and
# the release is named vMAJOR.MINOR.PATCH, which is what installed apps compare against their own version.
# Without a tally-v tag this falls back to the old upstream numbering (v1.0.8-25-gabc1234).
TALLY_DESCRIBE="$(git describe --tags --long --match='tally-v*' 2>/dev/null || true)"
if [[ "$TALLY_DESCRIBE" =~ ^tally-(v[0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)-g([0-9a-f]+)$ ]]; then
  if [ "${BASH_REMATCH[2]}" = 0 ]; then VERSION="${BASH_REMATCH[1]}"; TAG="tally-${BASH_REMATCH[1]}"
  else VERSION="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-g${BASH_REMATCH[3]}"; TAG=""; fi
else
  VERSION="$(git describe --tags --long --match='v*')"; TAG="tally-${VERSION#v}"
fi
if [ $PUBLISH = 1 ] && [ -z "$TAG" ]; then echo "tag the release first (git tag tally-vX.Y.Z): HEAD is $VERSION" >&2; exit 1; fi
# The server plugin is versioned with the app: Tally v2.0.1 ships plugin 2.0.1.10/.11/.12 (one per Jellyfin line). Only a tally-vX.Y.Z tag gives
# the plugin a version, so only such a release is published; untagged builds use TALLY_VERSION or the default in
# server/Directory.Build.props and are for looking at.
if [[ "$VERSION" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  SERVER_VERSION="${BASH_REMATCH[1]}"
else
  if [ $PUBLISH = 1 ]; then echo "the server plugin needs a tally-vX.Y.Z tag at HEAD (HEAD is $VERSION)" >&2; exit 1; fi
  SERVER_VERSION="${TALLY_VERSION:-$(sed -n 's:.*<TallyVersion[^>]*>\(.*\)</TallyVersion>.*:\1:p' server/Directory.Build.props)}"
fi
SERVER_TAG="tally-v$SERVER_VERSION"
NOTES="${TALLY_NOTES:-Tally for Android TV $VERSION}"
# One quiet line at the end of every release's notes. The app's update screen cuts the notes at the marker, so the line
# shows on GitHub and not on the TV. Apps older than 2.1 do not cut it, so the release that 2.0.x apps are offered
# leaves it out (TALLY_NO_SUPPORT_LINE=1).
[ "${TALLY_NO_SUPPORT_LINE:-}" = 1 ] || NOTES="$NOTES

<!-- tally-support -->
---
*Tally is free. If it's useful to you, you can support it on [Patreon](https://www.patreon.com/SeanDouglas).*"
# the plugin's changelog in Jellyfin's catalog: one short paragraph (the first line of TALLY_NOTES by default)
SERVER_CHANGELOG="${TALLY_SERVER_CHANGELOG:-$(printf '%s\n' "${TALLY_NOTES:-Tally $SERVER_VERSION}" | head -1)}"
# R8 on the release build no longer fits in the 2 GB upstream's gradle.properties gives the daemon
GRADLE_MEM="-Dorg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8"
./gradlew "$GRADLE_MEM" :app:assembleDefaultRelease
rm -f app/ci.keystore

OUT=tally/out; rm -rf "$OUT"; mkdir -p "$OUT"
SRC=app/build/outputs/apk/default/release
# Tally's names: Tally.apk (universal, what people download) and Tally-<abi>.apk (what the in-app updater picks from
# 2.0.2 on). The Wholphin-release* copies are only for installs from before 2.0.2, whose updater knows no other names:
# stop publishing them once no device reports an older version (see tally/README.md, "Release assets").
for abi in arm64-v8a armeabi-v7a x86_64; do
  cp "$SRC"/*-"$abi".apk "$OUT/Tally-$abi.apk"
  cp "$SRC"/*-"$abi".apk "$OUT/Wholphin-release-$abi.apk"
done
# the universal APK is the one without an ABI suffix
UNIVERSAL="$(ls "$SRC"/*.apk | grep -v -E -- '-(arm64-v8a|armeabi-v7a|x86_64)\.apk$')"
cp "$UNIVERSAL" "$OUT/Tally.apk"
cp "$UNIVERSAL" "$OUT/Wholphin-release.apk"
ls -lh "$OUT"

# Store builds (no self-update, TV-only): an app bundle for Google Play, an APK for the Amazon Appstore.
# Same signing key as the sideloaded build, so the three can update over one another.
if [ "${1:-}" = "--stores" ] || [ "${2:-}" = "--stores" ]; then
  # one variant at a time: compiling two at once exhausts the 2 GB Kotlin daemon upstream configures
  ./gradlew "$GRADLE_MEM" :app:bundleAppstoreRelease
  ./gradlew "$GRADLE_MEM" :app:assembleFiretvRelease
  rm -f app/ci.keystore
  cp app/build/outputs/bundle/appstoreRelease/*.aab "$OUT/Tally-play.aab"
  cp "$(ls app/build/outputs/apk/firetv/release/*.apk | grep -v -E -- '-(arm64-v8a|armeabi-v7a|x86_64)\.apk$')" "$OUT/Tally-amazon.apk"
  ls -lh "$OUT"/Tally-play.aab "$OUT"/Tally-amazon.apk
fi

# The server plugin: a zip per Jellyfin version, the Windows installer (which embeds the zips), the Docker Compose
# file and the Linux script with this version as their default, and the plugin repository with this release added.
TALLY_VERSION="$SERVER_VERSION" TALLY_CHANGELOG="$SERVER_CHANGELOG" server/build.sh
cp server/dist/Tally-server-"$SERVER_VERSION"-jf*.zip "$OUT/"
"$DOTNET" publish server/install/windows -c Release -p:TallyVersion="$SERVER_VERSION" -o server/install/windows/bin/publish --nologo -v q
cp server/install/windows/bin/publish/Tally-Server-Setup.exe "$OUT/"
sed "s/TALLY_VERSION: \"[0-9.]*\"/TALLY_VERSION: \"$SERVER_VERSION\"/" server/install/docker-compose.yml > "$OUT/docker-compose.yml"
sed "s/TALLY_VERSION=\"\${TALLY_VERSION:-[0-9.]*}\"/TALLY_VERSION=\"\${TALLY_VERSION:-$SERVER_VERSION}\"/" server/install/install-linux.sh > "$OUT/install-linux.sh"
chmod +x "$OUT/install-linux.sh"
python3 server/manifest.py add server/manifest.json --tag "$SERVER_TAG" "$OUT"/Tally-server-"$SERVER_VERSION"-jf*.zip --out "$OUT/manifest.json"
grep -q "TALLY_VERSION: \"$SERVER_VERSION\"" "$OUT/docker-compose.yml" && grep -q "TALLY_VERSION:-$SERVER_VERSION}" "$OUT/install-linux.sh" \
  || { echo "could not stamp $SERVER_VERSION into docker-compose.yml / install-linux.sh" >&2; exit 1; }
# "Tally for Samsung" and "Tally for LG": the programs that install the Tally TV app on a Samsung or LG TV (one per
# desktop OS each, one source tree). They carry the TV shell (tv-web/shell) and package it on the user's PC; nothing
# about a server is inside them.
TALLY_VERSION="$SERVER_VERSION" DOTNET="$DOTNET" tv-web/installer/build.sh all
TV_INSTALLERS=()
for program in Samsung LG; do
  for os in windows.exe linux macos-arm64 macos-x64; do TV_INSTALLERS+=("Tally-$program-Installer-$os"); done
done
for f in "${TV_INSTALLERS[@]}"; do cp "tv-web/installer/dist/$f" "$OUT/"; done
( cd "$OUT" && md5sum Tally-server-*.zip Tally-Server-Setup.exe Tally-Samsung-Installer-* Tally-LG-Installer-* )
ls -lh "$OUT"

ASSETS=("$OUT"/Tally.apk "$OUT"/Tally-arm64-v8a.apk "$OUT"/Tally-armeabi-v7a.apk "$OUT"/Tally-x86_64.apk "$OUT"/Wholphin-release*.apk
        "$OUT"/Tally-server-"$SERVER_VERSION"-jf*.zip "$OUT"/Tally-Server-Setup.exe "$OUT"/docker-compose.yml "$OUT"/install-linux.sh
        "${TV_INSTALLERS[@]/#/$OUT/}")
# After the release exists (so its zips can be downloaded), main gets the plugin repository entry and the new
# default version for the Docker and Linux installs.
publish_repository() {
  cp "$OUT/manifest.json" server/manifest.json
  cp "$OUT/docker-compose.yml" server/install/docker-compose.yml
  cp "$OUT/install-linux.sh" server/install/install-linux.sh
  git add server/manifest.json server/install/docker-compose.yml server/install/install-linux.sh
  git commit -m "Plugin repository: Tally server $SERVER_VERSION"
  git push origin HEAD:main
}

if [ $PUBLISH = 1 ]; then
  git tag -f "$TAG" && git push -f origin "refs/tags/$TAG" && git push origin main
  gh release create "$TAG" "${ASSETS[@]}" --repo Scdouglas1999/Tally --title "$VERSION" --notes "$NOTES" --latest
  publish_repository
  echo "published $VERSION"
else
  echo
  echo "Dry run: nothing was tagged, pushed or published. --publish would run:"
  echo "  git tag -f $TAG && git push -f origin refs/tags/$TAG && git push origin main"
  printf '  gh release create %q' "${TAG:-$SERVER_TAG}"; printf ' %q' "${ASSETS[@]}"
  printf ' --repo Scdouglas1999/Tally --title %q --notes %q --latest\n' "$VERSION" "$NOTES"
  echo "  then copy $OUT/manifest.json, docker-compose.yml and install-linux.sh into server/, commit"
  echo "  \"Plugin repository: Tally server $SERVER_VERSION\" and git push origin HEAD:main"
  echo "Plugin repository after publishing (diff against server/manifest.json):"
  diff -u server/manifest.json "$OUT/manifest.json" || true
fi
