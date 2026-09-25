#!/usr/bin/env bash
# Runs the Tally shell in LG's webOS TV Simulator (an Electron app with LG's webOSSystem, PalmServiceBridge and a
# remote, on the web engine of the webOS version it simulates) on a private Xvfb display, with the web inspector open
# for scripts (Chrome DevTools Protocol on 127.0.0.1:$CDP_PORT).
#   scripts/webos-simulator.sh start [--server URL] [--bundle URL]   package the shell and start the simulator
#   scripts/webos-simulator.sh shot <png>                            screenshot of the display
#   scripts/webos-simulator.sh stop
# SIMULATOR: the simulator's extracted AppRun (default: ~/tools/webos-simulator/webOS_TV_6.0_Simulator_1.4.1/
# squashfs-root/AppRun; LG's Linux AppImage, extracted with --appimage-extract). The shell is staged as
# scripts/package-webos.sh stages it (dist/webos), so this needs the webOS CLI only for that script's final
# ares-package step.
set -euo pipefail
cd "$(dirname "$0")/.."
SIMULATOR="${SIMULATOR:-$HOME/tools/webos-simulator/webOS_TV_6.0_Simulator_1.4.1/squashfs-root/AppRun}"
DISPLAY_NO="${WEBOS_SIM_DISPLAY:-:73}"
CDP_PORT="${CDP_PORT:-9339}"
RUN="${XDG_RUNTIME_DIR:-/tmp}/tally-webos-sim"
mkdir -p "$RUN"
case "${1:-}" in
  start)
    shift
    scripts/package-webos.sh "$@" >/dev/null
    Xvfb "$DISPLAY_NO" -screen 0 2560x1600x24 -nolisten tcp >"$RUN/xvfb.log" 2>&1 &
    echo $! >"$RUN/xvfb.pid"
    sleep 1
    DISPLAY="$DISPLAY_NO" "$SIMULATOR" "$PWD/dist/webos" '{}' --no-sandbox --remote-debugging-port="$CDP_PORT" \
      >"$RUN/simulator.log" 2>&1 &
    echo $! >"$RUN/simulator.pid"
    echo "simulator on $DISPLAY_NO, DevTools on 127.0.0.1:$CDP_PORT, log $RUN/simulator.log"
    ;;
  shot)
    DISPLAY="$DISPLAY_NO" import -window root "${2:?png}"
    ;;
  stop)
    for p in simulator xvfb; do
      [[ -f "$RUN/$p.pid" ]] && kill "$(cat "$RUN/$p.pid")" 2>/dev/null || true
      rm -f "$RUN/$p.pid"
    done
    ;;
  *) echo "usage: $0 start [--server URL] [--bundle URL] | shot <png> | stop" >&2; exit 2 ;;
esac
