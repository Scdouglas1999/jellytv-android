#!/usr/bin/env bash
# Builds the programs that install Tally on a TV, for every desktop OS from one source tree (self-contained
# single-file .NET apps: nothing to install first). They share common/ (console, server step, network scan):
#   "Tally for Samsung" (src/)                     "Tally for LG" (lg/src/)
#   dist/Tally-Samsung-Installer-windows.exe       dist/Tally-LG-Installer-windows.exe     Windows 10/11, x64 (also Arm64)
#   dist/Tally-Samsung-Installer-linux             dist/Tally-LG-Installer-linux           Linux x64
#   dist/Tally-Samsung-Installer-macos-arm64       dist/Tally-LG-Installer-macos-arm64     macOS on Apple silicon
#   dist/Tally-Samsung-Installer-macos-x64         dist/Tally-LG-Installer-macos-x64       macOS on Intel
# The tests run first. Usage: tv-web/installer/build.sh [samsung|lg|all] [win-x64|linux-x64|osx-arm64|osx-x64 ...]
# Environment: DOTNET (default ~/.dotnet/dotnet), TALLY_VERSION (x.y.z, the programs' version; default 1.0.0).
set -euo pipefail
cd "$(dirname "$0")"
DOTNET="${DOTNET:-$HOME/.dotnet/dotnet}"; command -v "$DOTNET" >/dev/null || DOTNET=dotnet
VERSION="${TALLY_VERSION:-1.0.0}"
PROGRAMS=(samsung lg)
case "${1:-}" in
  samsung|lg) PROGRAMS=("$1"); shift ;;
  all) shift ;;
esac
TARGETS=("$@"); [[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=(win-x64 linux-x64 osx-arm64 osx-x64)

mkdir -p dist
for program in "${PROGRAMS[@]}"; do
  case "$program" in
    samsung) project=src; tests=tests; name=Tally-Samsung-Installer ;;
    lg) project=lg/src; tests=lg/tests; name=Tally-LG-Installer ;;
  esac
  "$DOTNET" test "$tests" -c Release --nologo -v q -p:UseSharedCompilation=false
  for rid in "${TARGETS[@]}"; do
    case "$rid" in
      win-x64) file=$name-windows.exe ;;
      linux-x64) file=$name-linux ;;
      osx-arm64) file=$name-macos-arm64 ;;
      osx-x64) file=$name-macos-x64 ;;
      *) echo "unknown target $rid" >&2; exit 2 ;;
    esac
    out="bin/publish/$program/$rid"
    rm -rf "$out"
    "$DOTNET" publish "$project" -c Release -r "$rid" -p:Version="$VERSION" -p:UseSharedCompilation=false -o "$out" --nologo -v q
    exe="$out/$name"; [[ "$rid" == win-* ]] && exe="$exe.exe"
    cp "$exe" "dist/$file"
    chmod +x "dist/$file"
  done
done
ls -lh dist
