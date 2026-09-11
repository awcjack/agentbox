#!/usr/bin/env bash
set -euo pipefail

# Exercise the actual generated entrypoint sections without privileged user setup.
entrypoint=$1
clis=("$2" "$3")
shift 3
# Remaining arguments come from image.config.Cmd, just as Docker supplies them.
default_cmd=("$@")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
sed -n '/    PI_RPC_STARTED=false/,/    # Start Claude Code/p' "$entrypoint" > "$scratch/rpc.sh"
# Nix strips common indentation from generated scripts.
if [ ! -s "$scratch/rpc.sh" ]; then
  sed -n '/^PI_RPC_STARTED=false/,/^# Start Claude Code/p' "$entrypoint" > "$scratch/rpc.sh"
fi
test -s "$scratch/rpc.sh"
for enabled in true false; do
  for auto in true false unset; do
    output=$(ENABLE_PI_RPC_API=$enabled PI_RPC_API_AUTO_START=$auto bash -c '
      [ "$PI_RPC_API_AUTO_START" != unset ] || unset PI_RPC_API_AUTO_START
      source "$1"
    ' bash "$scratch/rpc.sh")
    if [ "$enabled" = true ] && [ "$auto" != false ]; then
      [[ "$output" == *"supervisor is unavailable"* ]]
    else
      test -z "$output"
    fi
  done
done

sed -n '/# Detached tmux services/,/# If services were started/p' "$entrypoint" > "$scratch/idle.sh"
test -s "$scratch/idle.sh"
export AGENT_HOME="$scratch/home"
mkdir -p "$AGENT_HOME/.agentbox/on-demand.d"
bash "$scratch/idle.sh" "${default_cmd[@]}"
touch "$AGENT_HOME/.agentbox/on-demand.d/pi-rpc.sh"
bash "$scratch/idle.sh" "${default_cmd[@]}" # Non-executable files do not count.
chmod +x "$AGENT_HOME/.agentbox/on-demand.d/pi-rpc.sh"
bash "$scratch/idle.sh" explicit-command
bash "$scratch/idle.sh" "${default_cmd[@]}" > "$scratch/idle.log" &
pid=$!
sleep 0.2
kill -0 "$pid"
kill -TERM "$pid"
wait "$pid"

# Both platform CLIs must report a stopped on-demand service without starting it.
docker() {
  case "$*" in
    info*) return 0 ;;
    'context show') printf 'test\n' ;;
    inspect*) printf 'running\n' ;;
    'exec agentbox bash -c '*) bash -c "$5" ;;
    'exec -u agent agentbox tmux has-session -t service-pi-rpc') return 1 ;;
    *) printf 'Unexpected docker call: %s\n' "$*" >&2; return 99 ;;
  esac
}
export -f docker
export ENABLE_PI_RPC_API=true PI_RPC_API_AUTO_START=false
for cli in "${clis[@]}"; do
  for command in pi-ui pi-rpc; do
    if output=$(bash "$cli" "$command" 2>&1); then
      printf '%s unexpectedly succeeded\n' "$command" >&2
      exit 1
    fi
    [[ "$output" == *"is stopped (configured on-demand). Start it with: agentbox service start pi-rpc"* ]]
    [[ "$output" != *"Unexpected docker call"* ]]
  done
done
printf 'Pi RPC gate, on-demand idle, and CLI regression tests passed\n'
