# Pi RPC runtime

Authenticated HTTP/SSE supervision for Pi RPC processes. It uses Node built-ins
only, creates exactly one `pi --mode rpc` child per API session, and does not
provide a WebSocket endpoint.

## Browser UI

The supervisor serves the bundled static `web/` chat UI at `/` whenever it is
enabled. UI and API share the existing `piRpcApi` listener; no separate service,
build-time frontend dependency, or UI enable option is needed. `agentbox pi-ui`
shows that root URL, while `agentbox pi-rpc` checks readiness. The existing
`agentbox pi-web` command is still the separate ttyd terminal UI.

Open the root URL without SSH, enter the raw bearer token/password, and select
an approved profile. The password stays in page memory, not localStorage,
sessionStorage, or URLs; reload or log out to clear it. Browser API requests
use the Authorization header, including the fetch-based SSE connection. Configure
the exact browser origin (scheme, host, and port) in `allowedOrigins`, including
same-origin use. Protect remote HTTP access with a trusted VPN or terminate TLS
at a trusted reverse proxy; bearer authentication alone does not encrypt traffic.

Working directories and history roots are administrator-owned profile settings,
not arbitrary browser input. The UI uses native Pi sessions and credentials;
it does not convert OpenCode conversations or import OpenCode authentication.
Each additional profile needs a distinct, non-overlapping persistent session
directory. Pi provider credentials in environment variables must be explicitly
mapped into the profile, separate from the browser's RPC password.

Image prompts include base64 overhead in the JSON body. For example, set
`limits.maxBodyBytes` to `8388608` and `limits.maxRecordBytes` to `16777216` for
larger image-bearing requests and Pi records. These are finite limits, not an
unlimited upload endpoint; large transcripts and event replay remain bounded.

## Configuration

`main.mjs` reads `PI_AGENTBOX_RUNTIME_CONFIG`, defaulting to
`/etc/agentbox/pi-runtime.json`, and consumes its `piRpcApi` object:

```json
{
  "piRpcApi": {
    "host": "127.0.0.1",
    "port": 4098,
    "executable": "/bin/pi",
    "allowedOrigins": ["https://agent.example.com"],
    "auth": {
      "tokens": [
        {
          "sha256Env": "PI_RPC_TOKEN_SHA256",
          "scopes": ["profiles:read", "sessions:create", "sessions:read", "sessions:write", "sessions:delete"]
        }
      ]
    },
    "allowedCommands": ["prompt", "abort", "get_state", "get_messages", "get_session_stats"],
    "profiles": {
      "default": {
        "cwd": "/workspace",
        "sessionDir": "/home/agent/.pi/agent/sessions",
        "args": ["--approve"],
        "envReferences": { "PROVIDER_TOKEN": "PI_PROFILE_PROVIDER_TOKEN" }
      }
    },
    "limits": {
      "maxSessions": 16,
      "idleTimeoutMs": 1800000
    }
  }
}
```

Generate a digest without putting the token or digest in the Nix-generated
runtime config, then place the assignment in the secret environment file:

```bash
printf 'PI_RPC_TOKEN_SHA256=%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
```

Alternatively, replace `sha256Env` with `"tokenEnv": "OPENCODE_PASSWORD"` to
reuse a raw bearer token already present in the secret environment file. It is
hashed at supervisor startup. Each runtime token entry must specify exactly one
of `tokenEnv`, `sha256Env`, or `sha256`; they are mutually exclusive. The managed
Nix modules emit `tokenEnv` only when non-null and otherwise emit `sha256Env`,
whose default remains `PI_RPC_TOKEN_SHA256`. Never put raw secrets in Nix options.
Raw tokens must be non-empty printable ASCII without whitespace. A password with
spaces cannot be reused as this API's bearer token; use a separate random token.

`tokenEnv`, `sha256Env`, and profile `envReferences` are resolved from the process
environment at startup and fail closed when missing. The lower-level runtime API
continues to accept an inline `sha256` digest and literal profile `env` for
non-Nix embedders, but managed Agentbox configuration never emits either.

The child does not inherit the supervisor environment. It receives a fixed
baseline (`HOME`, user/XDG paths, locale, terminal, executable path, temporary
directory, and system CA paths) plus only its profile's explicit `env` and
`envReferences`. An RPC token or token-hash variable cannot be referenced by a
profile.
The configured executable must be absolute and must resolve at startup to a
path under `/nix/store`; the resolved path, not the mutable symlink, is used for
all children. Unknown keys at every RPC configuration level are startup errors.

Profile `allowedCommands` may narrow the global command set. `bash`, session
switch/fork/clone/new-session, HTML export, and raw `extension_ui_response` are
always forbidden. Profile arguments also cannot set supervisor-owned mode,
name, session, session ID, session directory, continue, resume, or fork flags.
Extension dialogs must use the checked UI endpoint.

Resume accepts only a complete UUIDv4 or UUIDv7, never a path or partial
identifier, and requires the selected profile to have a `sessionDir`. The
supervisor resolves an exact, unique regular file with matching header ID and
working directory, rejects symlinks, then passes that server-owned path to Pi.
New sessions receive a supervisor-owned `--session-id` immediately; concurrent
resumes of the same native ID are rejected across all profiles, including
directory aliases or copied files retaining that ID. This does not lock out an
independent CLI process: stop that process before resuming its conversation.
Configured profile directories must be normalized and non-overlapping.

History scans direct files only, with up to 10,000 directory entries and the
latest 1,000 candidate files; the response includes `truncated` when capped.
Only bounded header/tail windows are read, so very old display names may fall
back to the first prompt or an untitled label. For normal CLI continuity in
`/workspace`, use `/home/agent/.pi/agent/sessions/--workspace--`, not its parent
directory. Other working directories need separately configured profiles.

## API

The static UI shell/assets and the two health routes are public; session data
and all `/v1` routes require `Authorization: Bearer <token>` and the listed scope.
An Origin header is optional for non-browser callers; when
present, it must exactly match `allowedOrigins`.

| Method and path | Scope | Result |
|---|---|---|
| `GET /` | public | Bundled native Pi chat UI shell |
| `GET /health/live` | public | Process liveness |
| `GET /health/ready` | public | Readiness; returns 503 during shutdown |
| `GET /v1/profiles` | `profiles:read` | Configured profile names |
| `GET /v1/history?profile=default` | `sessions:read` | Native Pi history from the approved profile's session directory |
| `POST /v1/sessions` | `sessions:create` | Create or resume a supervised child |
| `GET /v1/sessions` | `sessions:read` | List in-memory sessions |
| `GET /v1/sessions/:id` | `sessions:read` | Session state and bounded stderr tail |
| `DELETE /v1/sessions/:id` | `sessions:delete` | Abort and terminate the child |
| `POST /v1/sessions/:id/rpc` | `sessions:read` for the read commands listed below; otherwise `sessions:write` | Forward an allowed RPC command and await its response |
| `POST /v1/sessions/:id/ui` | `sessions:write` | Answer one pending extension dialog |
| `GET /v1/sessions/:id/events` | `sessions:read` | SSE stream with bounded replay |

The read-command set is `get_available_models`,
`get_available_thinking_levels`, `get_commands`, `get_entries`,
`get_fork_messages`, `get_last_assistant_text`, `get_messages`,
`get_session_stats`, `get_state`, and `get_tree`. A write-only token cannot use
these commands as a way to read session data.

Create requests are `{"profile":"default"}`, optionally with `name` and a full
UUID `resume` session ID. Exited sessions remain available for inspection until
idle cleanup but do not consume the active-session quota. RPC requests are Pi
command objects. UI requests
are `{"id":"...","confirmed":true}`, `{"id":"...","value":"..."}`, or
`{"id":"...","cancelled":true}`. Select values must match an offered option.

Session metadata includes `name`, `cwd`, `nativeSessionId`, `latestEventId`, and
pending UI requests. Accepted answers publish `extension_ui_resolved` supervisor
events so other browser tabs remove the same request.

SSE records use monotonically increasing IDs. Reconnect with `Last-Event-ID` or
`?after=<id>`. If the requested cursor predates the bounded ring, the first SSE
message is a `reset` event containing `oldestEventId`.
Read-command responses travel over HTTP only, not the SSE replay ring. Capture
`latestEventId` before snapshot reads, then subscribe from that cursor and
reconcile completed messages rather than appending replayed copies. Normal
socket backpressure is buffered; persistently slow clients are disconnected
once their buffer exceeds `maxEventBytes + maxRecordBytes`.

Pi does not paginate `get_messages`. An oversized correlated read response in
Pi 0.84's metadata-first JSON format is drained and returns HTTP 413
`snapshot_too_large` without terminating the agent. The UI stops retrying and
still allows ending the session. Start a new conversation or deliberately raise
the record limit for large histories. Other oversized/malformed protocol
records still fail closed. This is bounded failure handling, not unlimited
transcript support. Timed-out reads retain bounded correlation until Pi replies;
further reads may return 429 while those replies are outstanding. Late oversized
snapshots are also drained rather than killing the child.

## Supervision and trust boundary

`pi-rpc-runtime-supervise` uses exponential restart backoff, stops after five
consecutive processes fail to remain up for 60 seconds, and keeps only the last
1 MiB of its log by default. Session stderr and event replay are independently
bounded by API limits. Pi children run in detached process groups on Unix so
shutdown and protocol failures terminate descendants as well as the direct
child.

Bearer authentication is a network-client control, not an isolation boundary
against code running as the same UID. A same-UID process can inspect or signal
the supervisor and its Pi children, access profile credentials and session
files, and connect over container loopback. Container root or a compromised
container is equally trusted. Use separate containers/UIDs for mutually
untrusted tenants, protect the Docker daemon and host, and put non-loopback
access behind a trusted TLS reverse proxy or VPN.
