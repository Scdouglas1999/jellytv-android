#!/usr/bin/env bash
# Runs LG's webOS TV Emulator (a VirtualBox VM: webostv.developer.lge.com/develop/tools/emulator-installation) under
# QEMU with KVM instead of VirtualBox, without root: the VM's disk (monolithic sparse VMDK, IDE on PIIX) behind a
# qcow2 overlay (the download stays untouched), the VM's own devices (PIIX3, e1000 on NAT with its port forwards:
# SSH 6622 -> 22, web inspector 9998, remote 19001; USB tablet; VBoxVGA as QEMU's std VGA), a VNC display on
# 127.0.0.1:59xx and the QEMU monitor on a socket for screenshots and keys.
#   scripts/webos-emulator.sh start          boot it (the TV's home screen after ~1-2 minutes)
#   scripts/webos-emulator.sh shot <png>     screenshot
#   scripts/webos-emulator.sh key <name>...  QEMU key names (ret, esc, up, down, left, right, ...): a PC keyboard
#                                            (Escape arrives as 27, not as BACK)
#   scripts/webos-emulator.sh remote <key>... LG's remote (ok, back, up, down, left, right, home, play, pause, stop,
#                                            rew, ff, red, green, yellow, blue, chup, chdown, 0-9): the protocol of
#                                            the emulator launcher's remote (its RemoconSocket: the key's number as
#                                            text on TCP 19001); the app gets LG's codes (BACK 461, CH+ 33, PAUSE 19)
#   scripts/webos-emulator.sh stop
# The Magic Remote pointer is the VNC pointer (absolute, a USB tablet): webOS shows its cursor and sends
# cursorStateChange, the wheel scrolls (e.g. vncdotool: vncdo -s 127.0.0.1::5977 move 960 540 click 1).
# The web inspector (Chrome DevTools Protocol, Chrome 68) is http://127.0.0.1:9998/json while an app runs.
# luna-send-pub over OpenSSH (9.x) printed nothing after the first calls; over SSH.NET or paramiko it answers.
# QEMU daemonizes and keeps every descriptor it inherits: start it outside any lock (a flock held by the caller
# would stay held as long as the VM runs).
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
  remote)
    shift
    declare -A rc=([ok]=506 [up]=504 [left]=505 [right]=507 [down]=508 [back]=509 [exit]=511 [home]=502
      [play]=705 [pause]=706 [stop]=704 [rew]=707 [ff]=708 [red]=601 [green]=602 [yellow]=603 [blue]=604
      [chup]=403 [chdown]=407 [1]=301 [2]=302 [3]=303 [4]=304 [5]=305 [6]=306 [7]=307 [8]=308 [9]=309 [0]=310)
    for k in "$@"; do printf '%s' "${rc[$k]:?unknown key $k}" | socat -t1 - TCP:127.0.0.1:19001; sleep 0.5; done
    ;;
  stop)
    [[ -f "$DIR/qemu.pid" ]] && kill "$(cat "$DIR/qemu.pid")" 2>/dev/null || true
    rm -f "$DIR/qemu.pid"
    ;;
  *) echo "usage: $0 start | shot <png> | key <name>... | remote <key>... | stop" >&2; exit 2 ;;
esac
