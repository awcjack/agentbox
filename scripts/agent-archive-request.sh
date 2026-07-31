#!/usr/bin/env bash
set -euo pipefail

die() {
    printf 'agent-archive-request: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

check_size() {
    local name="$1" value="$2" limit="$3"
    if [ "$(LC_ALL=C; printf '%s' "$value" | wc -c)" -gt "$limit" ]; then
        die "$name exceeds $limit bytes"
    fi
}

validate_agent() {
    case "$1" in
        claude|opencode) ;;
        *) die "agent must be claude or opencode" ;;
    esac
}

scope_for() {
    local supplied="${1:-}"
    if [ -n "$supplied" ]; then
        printf '%s' "$supplied"
    elif [ -n "${TMUX_PANE:-}" ]; then
        printf 'tmux:%s' "$TMUX_PANE"
    else
        printf 'default'
    fi
}

pending_path_for() {
    local agent="$1" scope="$2" digest
    digest="$(printf '%s:%s' "$agent" "$scope" | sha256sum | cut -d' ' -f1)"
    printf '%s/%s-%s.json' "$pending_dir" "$agent" "$digest"
}

atomic_write() {
    local destination="$1" content="$2" directory temporary
    directory="$(dirname "$destination")"
    mkdir -p "$directory"
    temporary="$directory/.tmp-$$-${RANDOM:-0}"
    printf '%s\n' "$content" > "$temporary"
    chmod 0600 "$temporary"
    sync -f "$temporary"
    mv -f "$temporary" "$destination"
    sync -f "$directory"
}

find_pending() {
    local agent="$1" supplied_scope="$2" candidate
    candidate="$(pending_path_for "$agent" "$(scope_for "$supplied_scope")")"
    if [ -f "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
    fi
    return 1
}

lock_agent() {
    local agent="$1"
    mkdir -p "$pending_dir"
    exec 9>"$pending_dir/$agent.lock"
    flock -x 9
}

[ "${AGENT_HISTORY_REQUESTS_ENABLED:-false}" = "true" ] \
    || die "conversation archive requests are not enabled on this host"

request_dir="${AGENT_HISTORY_REQUEST_DIR:-}"
producer_id="${AGENT_HISTORY_PRODUCER_ID:-}"
pending_dir="${AGENT_HISTORY_PENDING_DIR:-/tmp/agent-history-requests}"
ttl_seconds="${AGENT_HISTORY_REQUEST_TTL_SECONDS:-86400}"

[ -n "$request_dir" ] || die "AGENT_HISTORY_REQUEST_DIR is not set"
[ -n "$producer_id" ] || die "AGENT_HISTORY_PRODUCER_ID is not set"
case "$ttl_seconds" in
    ''|*[!0-9]*) die "AGENT_HISTORY_REQUEST_TTL_SECONDS must be an integer" ;;
esac
[ "$ttl_seconds" -ge 60 ] || die "request TTL must be at least 60 seconds"

check_size "producer ID" "$producer_id" 128
require_command jq
require_command sha256sum
require_command sync
require_command flock

operation="${1:-}"
case "$operation" in
    request)
        agent="${2:-}"
        native_session_id="${3:-}"
        cwd="${4:-$PWD}"
        supplied_scope="${5:-}"
        validate_agent "$agent"
        check_size "native session ID" "$native_session_id" 512
        check_size "working directory" "$cwd" 4096

        scope="$(scope_for "$supplied_scope")"
        check_size "request scope" "$scope" 512
        pending_file="$(pending_path_for "$agent" "$scope")"
        lock_agent "$agent"
        now_epoch="$(date -u +%s)"

        if [ -f "$pending_file" ]; then
            existing_expiry="$(jq -r '.expires_at_epoch // 0' "$pending_file" 2>/dev/null || printf '0')"
            if [ "$existing_expiry" -gt "$now_epoch" ] 2>/dev/null; then
                existing_session="$(jq -r '.native_session_id // ""' "$pending_file")"
                if [ -n "$existing_session" ] && [ -n "$native_session_id" ] \
                    && [ "$existing_session" != "$native_session_id" ]; then
                    die "another unexpired request already uses this session scope"
                fi
                jq -r '.request_id' "$pending_file"
                exit 0
            fi
            rm -f "$pending_file"
        fi

        random="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
        request_hash="$(printf '%s:%s:%s:%s' "$producer_id" "$agent" "$now_epoch" "$random" | sha256sum | cut -d' ' -f1)"
        request_id="sha256:$request_hash"
        expires_epoch="$((now_epoch + ttl_seconds))"
        requested_at="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
        expires_at="$(date -u -d "@$expires_epoch" +%Y-%m-%dT%H:%M:%SZ)"

        pending_json="$(jq -cn \
            --arg request_id "$request_id" \
            --arg producer "$producer_id" \
            --arg agent "$agent" \
            --arg session_id "$native_session_id" \
            --arg cwd "$cwd" \
            --arg scope "$scope" \
            --arg requested_at "$requested_at" \
            --arg expires_at "$expires_at" \
            --argjson expires_at_epoch "$expires_epoch" \
            '{
                type: "archive_request_intent",
                schema_version: 1,
                request_id: $request_id,
                producer_host: $producer,
                agent: $agent,
                selection: "session-through-request",
                native_session_id: $session_id,
                cwd: $cwd,
                scope: $scope,
                requested_at: $requested_at,
                expires_at: $expires_at,
                expires_at_epoch: $expires_at_epoch
            }')"
        atomic_write "$pending_file" "$pending_json"
        printf '%s\n' "$request_id"
        ;;

    resolve)
        agent="${2:-}"
        native_session_id="${3:-}"
        boundary_event="${4:-}"
        cwd="${5:-}"
        source_path="${6:-}"
        supplied_scope="${7:-}"
        validate_agent "$agent"
        [ -n "$native_session_id" ] || die "resolve requires a native session ID"
        [ -n "$boundary_event" ] || die "resolve requires a boundary event"
        check_size "native session ID" "$native_session_id" 512
        check_size "boundary event" "$boundary_event" 128
        check_size "working directory" "$cwd" 4096
        check_size "source path" "$source_path" 4096

        lock_agent "$agent"
        pending_file="$(find_pending "$agent" "$supplied_scope" || true)"
        [ -n "$pending_file" ] || exit 0

        now_epoch="$(date -u +%s)"
        expires_epoch="$(jq -r '.expires_at_epoch // 0' "$pending_file" 2>/dev/null || printf '0')"
        if [ "$expires_epoch" -le "$now_epoch" ] 2>/dev/null; then
            rm -f "$pending_file"
            exit 0
        fi

        requested_session="$(jq -r '.native_session_id // ""' "$pending_file")"
        if [ -n "$requested_session" ] && [ "$requested_session" != "$native_session_id" ]; then
            die "completion event does not match the requested session"
        fi

        request_id="$(jq -r '.request_id' "$pending_file")"
        requested_at="$(jq -r '.requested_at' "$pending_file")"
        request_hash="${request_id#sha256:}"
        resolved_at="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
        destination="$request_dir/$request_hash.json"

        if [ -f "$destination" ]; then
            existing_id="$(jq -r '.request_id // ""' "$destination" 2>/dev/null || true)"
            [ "$existing_id" = "$request_id" ] \
                || die "request destination already exists with different content"
            rm -f "$pending_file"
            printf '%s\n' "$destination"
            exit 0
        fi

        resolved_json="$(jq -cn \
            --arg request_id "$request_id" \
            --arg producer "$producer_id" \
            --arg agent "$agent" \
            --arg session_id "$native_session_id" \
            --arg requested_at "$requested_at" \
            --arg resolved_at "$resolved_at" \
            --arg boundary_event "$boundary_event" \
            --arg cwd "$cwd" \
            --arg source_path "$source_path" \
            '{
                type: "archive_request",
                schema_version: 1,
                request_id: $request_id,
                producer_host: $producer,
                agent: $agent,
                selection: "session-through-request",
                native_session_id: $session_id,
                requested_at: $requested_at,
                resolved_at: $resolved_at,
                boundary: { event: $boundary_event, cutoff_at: $requested_at },
                context: ({ cwd: $cwd }
                    + if $source_path == "" then {} else { source_path: $source_path } end)
            }')"
        atomic_write "$destination" "$resolved_json"
        rm -f "$pending_file"
        printf '%s\n' "$destination"
        ;;

    cancel)
        agent="${2:-}"
        supplied_scope="${3:-}"
        validate_agent "$agent"
        lock_agent "$agent"
        pending_file="$(find_pending "$agent" "$supplied_scope" || true)"
        [ -n "$pending_file" ] && rm -f "$pending_file"
        ;;

    *)
        die "usage: agent-archive-request.sh {request <agent> [session-id] [cwd] [scope]|resolve <agent> <session-id> <event> [cwd] [source-path] [scope]|cancel <agent> [scope]}"
        ;;
esac
