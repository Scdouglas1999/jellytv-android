#!/usr/bin/env bash
# Runs LG's webOS TV Emulator (a VirtualBox VM: webostv.developer.lge.com/develop/tools/emulator-installation) under
# QEMU with KVM instead of VirtualBox, without root: the VM's disk (monolithic sparse VMDK, IDE on PIIX) behind a
# qcow2 overlay (the download stays untouched), the VM's own devices (PIIX3, e1000 on NAT with its port forwards:
# SSH 6622 -> 22, web inspector 9998, remote 19001; USB tablet; VBoxVGA as QEMU's std VGA), a VNC display on
# 127.0.0.1:59xx and the QEMU monitor on a socket for screenshots and keys.
#   scripts/webos-emulator.sh start          boot it (the TV's home screen after ~1-2 minutes)
#   scripts/webos-emulator.sh shot <png>     screenshot
#   scripts/webos-emulator.sh key <name>...  QEMU key names (ret, esc, up, down, left, right, ...)
#   scripts/webos-emulator.sh stop
# The emulator reaches this PC at 10.0.2.2. SSH: ssh -p 6622 -i <webos-cli>/files/conf/webos_emul developer@127.0.0.1
# (LG's CLI's key for the emulator); Tally for LG: --tv 127.0.0.1 --ssh-port 6622 --user developer --key <that key>.
# QEMU: QEMU_ROOT (default ~/tools/qemu/root: Arch's qemu-system-x86, qemu-common, qemu-img and their libraries
# unpacked there; run it with LD_LIBRARY_PATH=$QEMU_ROOT/usr/lib). VM: WEBOS_EMU_DIR (default
# ~/tools/webos-emulator, with Emulator/v5.0.0/LG_webOS_TV_Emulator.vmdk from Emulator_tv_linux_v5.0.0.zip).
# Memory: 1 GB for the guest (the VM's own setting); run it only with >= 6 GB free.
set -euo pipefail
QEMU_ROOT="${QEMU_ROOT:-$HOME/tools/qemu/root}"
DIR="${WEBOS_EMU_DIR:-$HOME/tools/webos-emulator}"
VMDK="${WEBOS_EMU_VMDK:-$DIR/Emulator/v5.0.0/LG_webOS_TV_Emulator.vmdk}"
VNC="${WEBOS_EMU_VNC:-77}"
MON="$DIR/monitor.sock"
export LD_LIBRARY_PATH="$QEMU_ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
monitor() { printf '%s\n' "$1" | socat - "UNIX-CONNECT:$MON" >/dev/null; }
case "${1:-}" in
  start)
    [[ -f "$DIR/overlay.qcow2" ]] || "$QEMU_ROOT/usr/bin/qemu-img" create -q -f qcow2 -b "$VMDK" -F vmdk "$DIR/overlay.qcow2"
    "$QEMU_ROOT/usr/bin/qemu-system-x86_64" -L "$QEMU_ROOT/usr/share/qemu" -name webos-tv-emulator \
      -enable-kvm -machine pc -cpu host -smp 2 -m 1024 -rtc base=utc \
      -drive "file=$DIR/overlay.qcow2,if=ide,format=qcow2" \
      -netdev user,id=n0,hostfwd=tcp:127.0.0.1:6622-:22,hostfwd=tcp:127.0.0.1:9998-:9998,hostfwd=tcp:127.0.0.1:19001-:19001 \
      -device e1000,netdev=n0 -vga std -usb -device usb-tablet \
      -display none -vnc "127.0.0.1:$VNC" -monitor "unix:$MON,server,nowait" \
      -daemonize -pidfile "$DIR/qemu.pid"
    echo "webOS TV emulator: VNC 127.0.0.1:59$VNC, SSH 127.0.0.1:6622, inspector 127.0.0.1:9998"
    ;;
  shot)
    out="${2:?png}"
    monitor "screendump $DIR/shot.ppm"
    sleep 1
    magick "$DIR/shot.ppm" "$out" 2>/dev/null || convert "$DIR/shot.ppm" "$out"
    ;;
  key)
    shift
    for k in "$@"; do monitor "sendkey $k"; sleep 0.3; done
    ;;
  stop)
    [[ -f "$DIR/qemu.pid" ]] && kill "$(cat "$DIR/qemu.pid")" 2>/dev/null || true
    rm -f "$DIR/qemu.pid"
    ;;
  *) echo "usage: $0 start | shot <png> | key <name>... | stop" >&2; exit 2 ;;
esac
