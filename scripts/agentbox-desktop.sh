#!/usr/bin/env bash
set -euo pipefail
set +m
umask 077

# VNC and noVNC intentionally trust local users (no password). Reach them using
# SSH forwarding, e.g. ssh -L 6080:127.0.0.1:6080 host, not public port publishing.
# Container integration must export DISPLAY and this fixed XAUTHORITY to clients.
export DISPLAY=${DISPLAY:-:10}
XAUTHORITY=/tmp/agentbox-desktop-$(id -u)/Xauthority
export XAUTHORITY
runtime=${XAUTHORITY%/*}
vnc_port=${AGENTBOX_DESKTOP_VNC_PORT:-5900}
web_port=${AGENTBOX_DESKTOP_WEB_PORT:-6080}
resolution=${AGENTBOX_DESKTOP_RESOLUTION:-1440x900x24}
novnc=${AGENTBOX_DESKTOP_NOVNC:?noVNC assets must be supplied by the Nix wrapper}
dbus_config=${AGENTBOX_DESKTOP_DBUS_CONFIG:?D-Bus config must be supplied by the Nix wrapper}

fail() { printf 'agentbox-desktop: %s\n' "$*" >&2; exit 1; }
[[ $DISPLAY =~ ^:(0|[1-9][0-9]{0,4})$ ]] || fail 'DISPLAY must be a local :N display'
for port in "$vnc_port" "$web_port"; do
  if [[ ! $port =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
    fail 'ports must be between 1 and 65535'
  fi
done
[[ $vnc_port != "$web_port" ]] || fail 'VNC and web ports must differ'
[[ $resolution =~ ^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}x(16|24|32)$ ]] || fail 'invalid WIDTHxHEIGHTxDEPTH resolution'
[[ -d $novnc ]] || fail "noVNC assets missing: $novnc"
mkdir -m 700 "$runtime" 2>/dev/null || true
[[ -d $runtime && ! -L $runtime && -O $runtime && $(stat -c %a "$runtime") == 700 ]] || fail "unsafe runtime directory: $runtime"
exec 9>"$runtime/lock"
flock -w 10 9 || fail 'timed out waiting for desktop lock (already running or still stopping)'
# Never unlink the lock: waiting/restarting launchers must share the same inode.
[[ ! -e /tmp/.X${DISPLAY#:}-lock && ! -e /tmp/.X11-unix/X${DISPLAY#:} ]] || fail "display $DISPLAY is already occupied (or has stale X files)"

pids=()
stopping=0
# Invoked by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  local pid alive deadline=$((SECONDS + 3))
  trap '' HUP TERM INT
  for pid in "${pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  while (( SECONDS < deadline )); do
    alive=0
    for pid in "${pids[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
    done
    (( alive )) || break
    sleep 0.1
  done
  for pid in "${pids[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -f "$XAUTHORITY" "$runtime/bus"
}
trap cleanup EXIT
trap 'stopping=129' HUP
trap 'stopping=143' TERM
trap 'stopping=130' INT
check_stop() { if (( stopping )); then exit "$stopping"; fi; }
start() {
  check_stop
  # Non-job-control Bash makes $! the setsid process-group leader. Close the
  # lock FD in every child so only the supervisor controls restart exclusion.
  setsid "$@" 9>&- &
  pids+=("$!")
  check_stop
}
ready() {
  local label=$1 pid deadline=$((SECONDS + 20))
  shift
  while (( SECONDS < deadline )); do
    check_stop
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null || fail "child $pid exited while waiting for $label"
    done
    if timeout -k 1 1 "$@" 9>&- >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  fail "timed out waiting for $label"
}
# Expand the port in the probing shell, not in the supervisor.
# shellcheck disable=SC2016
tcp_probe='exec 3<>/dev/tcp/127.0.0.1/"$1"'
tcp_ready() { timeout -k 1 1 bash -c "$tcp_probe" bash "$1" 9>&- >/dev/null 2>&1; }
for port in "$vnc_port" "$web_port"; do
  if tcp_ready "$port"; then fail "port $port is already occupied"; fi
done

rm -f "$XAUTHORITY" "$runtime/bus"
touch "$XAUTHORITY"
cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
xauth -f "$XAUTHORITY" add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$cookie"
start Xvfb "$DISPLAY" -screen 0 "$resolution" -nolisten tcp -auth "$XAUTHORITY" -noreset
ready X xdpyinfo -display "$DISPLAY"
export DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus
start dbus-daemon "--config-file=$dbus_config" --nofork --nopidfile "--address=$DBUS_SESSION_BUS_ADDRESS"
ready D-Bus dbus-send --session --type=method_call --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames
start openbox
start x11vnc -norc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -no6 -noipv6 -rfbport "$vnc_port" -forever -shared -nopw -noxdamage
ready VNC bash -c "$tcp_probe" bash "$vnc_port"
start websockify --web "$novnc" "127.0.0.1:$web_port" "127.0.0.1:$vnc_port"
ready noVNC bash -c "$tcp_probe" bash "$web_port"
check_stop
printf 'agentbox-desktop: ready on %s; http://127.0.0.1:%s/vnc.html (local users trusted, no password)\n' "$DISPLAY" "$web_port"
# Poll every child, including exits Bash already reaped during readiness. A
# late wait -n can miss those exits and wait forever on the remaining children.
while true; do
  check_stop
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      fail "desktop child $pid exited (status $status)"
    fi
  done
  sleep 0.2
done
