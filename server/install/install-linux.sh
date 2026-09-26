#!/bin/bash
# Installs the Tally plugin on a Debian or Ubuntu Jellyfin server:
#
#   curl -fsSL https://github.com/Scdouglas1999/Tally/releases/latest/download/install-linux.sh | sudo bash
#
# If Jellyfin is not installed, this first runs Jellyfin's own install script from repo.jellyfin.org, which adds
# Jellyfin's apt repository and installs the official packages. Then it stops Jellyfin, puts the Tally build that
# matches the Jellyfin version into Jellyfin's plugins folder, starts Jellyfin again and prints the address.
# It changes nothing else: no settings, no libraries, no other plugins. Run it again at any time; it only replaces
# an older or mismatched Tally.
set -euo pipefail

TALLY_VERSION="${TALLY_VERSION:-2.2.0}"
TALLY_RELEASES="${TALLY_RELEASES:-https://github.com/Scdouglas1999/Tally/releases/download}"
JELLYFIN_INSTALL_SCRIPT="https://repo.jellyfin.org/install-debuntu.sh"
TALLY_GUID="91920c7b-e920-46ee-b4d3-421f05d3761b"

say() { printf '\n> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root, for example: curl -fsSL <address of this script> | sudo bash"
[ -d /etc/apt ] && [ -f /etc/os-release ] || die "This script is for Debian and Ubuntu. On other systems see
  https://github.com/Scdouglas1999/Tally/blob/main/server/install/README.md"
command -v systemctl >/dev/null || die "This script needs systemd to stop and start Jellyfin."

installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

# The system's time zone (a tz database name), which Jellyfin follows: its guide and Tally's channel cards show times
# in it (the Tally apps ask for their own zone).
host_zone() {
  local z=""
  command -v timedatectl >/dev/null && z="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [ -z "$z" ] && [ -f /etc/timezone ] && z="$(head -1 /etc/timezone)"
  [ -z "$z" ] && [ -L /etc/localtime ] && z="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"
  printf '%s' "${z:-UTC}"
}

missing=()
for tool in curl unzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  say "Installing ${missing[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" </dev/null >/dev/null
fi

# 1. Jellyfin
if ! installed jellyfin-server; then
  say "Jellyfin is not installed. Installing it with Jellyfin's own script ($JELLYFIN_INSTALL_SCRIPT)."
  script="$(mktemp)"
  curl -fsSL "$JELLYFIN_INSTALL_SCRIPT" -o "$script"
  SKIP_CONFIRM=true bash "$script" </dev/null || die "Jellyfin's install script failed; see its messages above."
  rm -f "$script"
  installed jellyfin-server || die "Jellyfin's install script finished, but the jellyfin-server package is not installed."
fi

jellyfin_version="$(dpkg-query -W -f='${Version}' jellyfin-server)"
case "$jellyfin_version" in
  10.10.*) abi=10.10 ;;
  10.11.*) abi=10.11 ;;
  12.0|12.0[.+]*) die "Tally's build for Jellyfin 12 needs 12.1 or later. This server has Jellyfin $jellyfin_version; update Jellyfin first." ;;
  12.*|1[3-9].*) abi=12 ;;
  *) die "Tally has builds for Jellyfin 10.10, 10.11 and 12.1 or later. This server has Jellyfin $jellyfin_version." ;;
esac
say "Jellyfin $jellyfin_version is installed; using Tally's build for Jellyfin $abi."

# 2. Where Jellyfin keeps its plugins
data_dir=/var/lib/jellyfin
if [ -f /etc/default/jellyfin ]; then
  configured="$(sed -n 's/^JELLYFIN_DATA_DIR="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/default/jellyfin | tail -1)"
  [ -n "$configured" ] && data_dir="$configured"
fi
plugins="$data_dir/plugins"

# 3. Tally already there? Found by its plugin id, whatever its folder is called.
# each build has its own plugin version: <Tally version>.10, .11 or .12 for the Jellyfin line
case "$abi" in 10.10) want="$TALLY_VERSION.10" ;; 10.11) want="$TALLY_VERSION.11" ;; *) want="$TALLY_VERSION.12" ;; esac
old=()
for meta in "$plugins"/*/meta.json; do
  if [ ! -f "$meta" ] || ! grep -qi "$TALLY_GUID" "$meta"; then continue; fi
  dir="$(dirname "$meta")"
  version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$meta" | head -1)"
  target_abi="$(sed -n 's/.*"targetAbi": *"\([^"]*\)".*/\1/p' "$meta" | head -1)"
  if [[ "$target_abi" == "$abi".* ]] && dpkg --compare-versions "${version:-0}" ge "$want"; then
    say "Tally $version is already installed in $dir. Jellyfin keeps it up to date."
    keep="$dir"
  else
    old+=("$dir")
  fi
done

if [ -z "${keep:-}" ]; then
  zip="Tally-server-$TALLY_VERSION-jf$abi.zip"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading $zip"
  curl -fL --progress-bar "$TALLY_RELEASES/tally-v$TALLY_VERSION/$zip" -o "$tmp/$zip" \
    || die "Could not download $TALLY_RELEASES/tally-v$TALLY_VERSION/$zip"
  unzip -tq "$tmp/$zip" >/dev/null || die "The download is not a valid zip file."

  say "Stopping Jellyfin"
  systemctl stop jellyfin
  for dir in "${old[@]}"; do
    echo "  removing the previous Tally in $dir"
    rm -rf "$dir"
  done
  target="$plugins/Tally_$want"
  mkdir -p "$target"
  unzip -oq "$tmp/$zip" -d "$target"
  owner="$(stat -c %U:%G "$data_dir")"
  chown -R "$owner" "$plugins"
  echo "  installed Tally $TALLY_VERSION in $target"
fi

say "Starting Jellyfin"
systemctl restart jellyfin

# 4. Wait for it and print the address
port=8096
if [ -f /etc/jellyfin/network.xml ]; then
  p="$(sed -n 's:.*<InternalHttpPort>\([0-9]*\)</InternalHttpPort>.*:\1:p' /etc/jellyfin/network.xml | head -1)"
  [ -n "$p" ] && port="$p"
fi
info=""
for _ in $(seq 1 90); do
  info="$(curl -fs "http://127.0.0.1:$port/System/Info/Public" 2>/dev/null)" && break
  sleep 2
done
[ -n "$info" ] || die "Jellyfin did not answer on port $port within 3 minutes. Check: journalctl -u jellyfin"

ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
address="http://${ip:-$(hostname -I | awk '{print $1}')}:$port"
echo
echo "Done. Jellyfin is running at $address"
zone="$(host_zone)"
case "$zone" in
  UTC|Etc/UTC|Etc/Universal|Universal|Zulu|Etc/Zulu)
    echo "This server's time zone is UTC, so Jellyfin's guide shows times in UTC. To change it: sudo timedatectl set-timezone <Area/City>, then sudo systemctl restart jellyfin" ;;
  *) echo "Times in Jellyfin's guide and on Tally's channel cards follow this server's time zone ($zone)." ;;
esac
if printf '%s' "$info" | grep -qi '"startupwizardcompleted":false'; then
  echo "Open that address to set Jellyfin up (your user, your media folders). Tally is ready once you are signed in."
else
  echo "Tally is in Jellyfin's side menu (Live TV, or Dashboard > Plugins > Tally). Reload the browser tab once."
fi
