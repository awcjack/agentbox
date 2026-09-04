# Pi RPC runtime

Authenticated HTTP/SSE supervision for Pi RPC processes. It uses Node built-ins
only, creates exactly one `pi --mode rpc` child per API session, and does not
provide a WebSocket endpoint.

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

`sha256Env` and profile `envReferences` are resolved from the process
environment at startup and fail closed when missing. The lower-level runtime API
continues to accept an inline `sha256` digest and literal profile `env` for
non-Nix embedders, but managed Agentbox configuration never emits either.

The child does not inherit the supervisor environment. It receives a fixed
baseline (`HOME`, user/XDG paths, locale, terminal, executable path, temporary
directory, and system CA paths) plus only its profile's explicit `env` and
`envReferences`. An RPC token-hash variable cannot be referenced by a profile.
The configured executable must be absolute and must resolve at startup to a
path under `/nix/store`; the resolved path, not the mutable symlink, is used for
all children. Unknown keys at every RPC configuration level are startup errors.

Profile `allowedCommands` may narrow the global command set. `bash`, session
switch/fork/clone/new-session, HTML export, and raw `extension_ui_response` are
always forbidden. Profile arguments also cannot set supervisor-owned mode,
name, session, session ID, session directory, continue, resume, or fork flags.
Extension dialogs must use the checked UI endpoint.

Resume accepts only a complete UUID, never a path or partial identifier, and
requires the selected profile to have a `sessionDir`. Configured profile session
directories must be normalized and non-overlapping, so Pi's lookup is confined
to the profile-owned directory. Each profile needs a distinct directory when
more than one profile is configured.

## API

All routes except the two health routes require `Authorization: Bearer <token>`
and the listed scope. An Origin header is optional for non-browser callers; when
present, it must exactly match `allowedOrigins`.

| Method and path | Scope | Result |
|---|---|---|
| `GET /health/live` | public | Process liveness |
| `GET /health/ready` | public | Readiness; returns 503 during shutdown |
| `GET /v1/profiles` | `profiles:read` | Configured profile names |
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

SSE records use monotonically increasing IDs. Reconnect with `Last-Event-ID` or
`?after=<id>`. If the requested cursor predates the bounded ring, the first SSE
message is a `reset` event containing `oldestEventId`.

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
