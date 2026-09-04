#!/usr/bin/env bash

set -u

runtime=${PI_RPC_RUNTIME_EXECUTABLE:?PI_RPC_RUNTIME_EXECUTABLE is required}
log_file=${PI_RPC_LOG_FILE:-/home/agent/.agentbox-logs/pi-rpc-runtime.log}
max_log_bytes=${PI_RPC_MAX_LOG_BYTES:-1048576}
max_crashes=${PI_RPC_MAX_CRASHES:-5}
stable_seconds=${PI_RPC_STABLE_SECONDS:-60}
backoff=${PI_RPC_INITIAL_BACKOFF_SECONDS:-1}
max_backoff=${PI_RPC_MAX_BACKOFF_SECONDS:-30}

case "$max_log_bytes:$max_crashes:$stable_seconds:$backoff:$max_backoff" in
  *[!0-9:]*|:*|*::*|*:)
    echo "pi-rpc-runtime-supervise: limits must be non-negative integers" >&2
    exit 2
    ;;
esac
if [ "$max_log_bytes" -eq 0 ] || [ "$max_crashes" -eq 0 ] || [ "$stable_seconds" -eq 0 ]; then
  echo "pi-rpc-runtime-supervise: log size, crash count, and stable interval must be positive" >&2
  exit 2
fi
if [ "$backoff" -gt "$max_backoff" ]; then
  backoff=$max_backoff
fi
if [ ! -x "$runtime" ] || [ "${runtime#/}" = "$runtime" ]; then
  echo "pi-rpc-runtime-supervise: runtime must be an absolute executable path" >&2
  exit 2
fi

mkdir -p "$(dirname "$log_file")"
touch "$log_file"

trim_log() {
  local size temporary
  size=$(wc -c < "$log_file")
  if [ "$size" -gt "$max_log_bytes" ]; then
    temporary="$log_file.tmp.$$"
    tail -c "$max_log_bytes" "$log_file" > "$temporary"
    mv -f "$temporary" "$log_file"
  fi
}

log() {
  printf '%s\n' "$*" >> "$log_file"
  trim_log
}

child_pid=
stopping=false
stop_child() {
  stopping=true
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}
trap stop_child INT TERM

crashes=0
while true; do
  trim_log
  started=$SECONDS
  "$runtime" >> "$log_file" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  status=$?
  child_pid=
  trim_log

  if [ "$stopping" = true ]; then
    exit "$status"
  fi

  elapsed=$((SECONDS - started))
  if [ "$elapsed" -ge "$stable_seconds" ]; then
    crashes=1
    backoff=${PI_RPC_INITIAL_BACKOFF_SECONDS:-1}
  else
    crashes=$((crashes + 1))
  fi
  if [ "$crashes" -ge "$max_crashes" ]; then
    log "pi-rpc-runtime exited with status $status $crashes times without staying ready; giving up"
    exit 1
  fi

  log "pi-rpc-runtime exited with status $status after ${elapsed}s; restarting in ${backoff}s ($crashes/$max_crashes)"
  sleep "$backoff" &
  child_pid=$!
  wait "$child_pid" || true
  child_pid=
  if [ "$stopping" = true ]; then
    exit 0
  fi
  if [ "$backoff" -lt "$max_backoff" ]; then
    backoff=$((backoff * 2))
    if [ "$backoff" -gt "$max_backoff" ]; then
      backoff=$max_backoff
    fi
  fi
done
