#!/usr/bin/env bash
set -euo pipefail

script="${1:?usage: agent-archive-request.sh /path/to/script}"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

export AGENT_HISTORY_REQUESTS_ENABLED=true
export AGENT_HISTORY_REQUEST_DIR="$root/inbox"
export AGENT_HISTORY_PENDING_DIR="$root/pending"
export AGENT_HISTORY_PRODUCER_ID=test-host
export AGENT_HISTORY_REQUEST_TTL_SECONDS=3600
mkdir -p "$AGENT_HISTORY_REQUEST_DIR"

request_id="$(bash "$script" request claude session-1 /workspace/repo scope-1)"
case "$request_id" in sha256:*) ;; *) exit 1 ;; esac

test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name '*.json' | wc -l)" -eq 1
test "$(find "$AGENT_HISTORY_REQUEST_DIR" -type f | wc -l)" -eq 0

# Repeating an unexpired request in the same scope is idempotent.
test "$(bash "$script" request claude session-1 /workspace/repo scope-1)" = "$request_id"

# A completion for another native session must not consume the intent.
if bash "$script" resolve claude session-2 Stop /workspace/repo /tmp/transcript scope-1 2>/dev/null; then
    exit 1
fi
test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name '*.json' | wc -l)" -eq 1

# A completion from another pane/scope must never claim the sole pending intent.
bash "$script" resolve claude session-1 Stop /workspace/repo /tmp/transcript scope-2
test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name '*.json' | wc -l)" -eq 1
test "$(find "$AGENT_HISTORY_REQUEST_DIR" -type f | wc -l)" -eq 0

destination="$(bash "$script" resolve claude session-1 Stop /workspace/repo /tmp/transcript scope-1)"
test -f "$destination"
test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name '*.json' | wc -l)" -eq 0
test "$(stat -c %a "$destination")" = 600

jq -e --arg request_id "$request_id" '
  .type == "archive_request" and
  .schema_version == 1 and
  .request_id == $request_id and
  .producer_host == "test-host" and
  .agent == "claude" and
  .selection == "session-through-request" and
  .native_session_id == "session-1" and
  .boundary.event == "Stop" and
  .boundary.cutoff_at == .requested_at and
  .context.cwd == "/workspace/repo" and
  .context.source_path == "/tmp/transcript" and
  (has("content") | not)
' "$destination" >/dev/null

# Duplicate lifecycle events are a no-op and create no second request.
bash "$script" resolve claude session-1 Stop /workspace/repo /tmp/transcript scope-1
test "$(find "$AGENT_HISTORY_REQUEST_DIR" -type f | wc -l)" -eq 1

# Concurrent requests in one scope converge on one request ID.
mkdir -p "$root/concurrent"
for index in $(seq 1 12); do
    bash "$script" request opencode session-2 /workspace/repo opencode-scope > "$root/concurrent/$index" &
done
wait
test "$(sort -u "$root"/concurrent/* | wc -l)" -eq 1
test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name 'opencode-*.json' | wc -l)" -eq 1
bash "$script" cancel opencode opencode-scope
test "$(find "$AGENT_HISTORY_PENDING_DIR" -type f -name 'opencode-*.json' | wc -l)" -eq 0

printf 'agent archive request tests passed\n'
