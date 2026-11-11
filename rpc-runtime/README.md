# Pi RPC runtime

Authenticated HTTP/SSE supervision for Pi RPC processes. It uses Node built-ins
only, creates exactly one `pi --mode rpc` child per API session, and does not
provide a WebSocket endpoint.

## Browser UI

The running supervisor serves the bundled static `web/` chat UI at `/`.
UI and API share the existing `piRpcApi` listener; no separate service,
build-time frontend dependency, or UI enable option is needed. `agentbox pi-ui`
shows that root URL, while `agentbox pi-rpc` checks readiness. The existing
`agentbox pi-web` command is still the separate ttyd terminal UI.

For manual startup instead of starting the server at container boot, configure:

```nix
services.agentbox.settings.piRpcApi = {
  enable = true;
  autoStart = false;
  # Keep the existing auth, profiles, port and allowedOrigins settings.
};
```

Then use `agentbox service start pi-rpc`, `agentbox service status pi-rpc`, and
`agentbox service stop pi-rpc`. The container stays available while on-demand
services are stopped. Visiting the URL does not start the server. `pi-ui` and
`pi-rpc` show a start hint if it is stopped. `autoStart` defaults to true for
existing users and does not affect authentication or profile configuration.
This is separate from `services.agentbox.autoStart`, which controls container
startup at host boot, and from `agentbox pi`, the on-demand interactive CLI.

Open the root URL without SSH, enter the raw bearer token/password, and select
a session folder (or Ungrouped). By default the password stays in page memory only;
optional Remember on this device stores it in localStorage until logout. It never
enters sessionStorage or URLs. Browser API requests
use the Authorization header, including the fetch-based SSE connection. Configure
the exact browser origin (scheme, host, and port) in `allowedOrigins`, including
same-origin use. Protect remote HTTP access with a trusted VPN or terminate TLS
at a trusted reverse proxy; bearer authentication alone does not encrypt traffic.

Type `/` in the composer to discover the selected Pi process's extension,
skill, and prompt-template commands. Arrow keys navigate; Tab, Enter, or clicking
inserts a suggestion without executing it. Escape dismisses the menu. Suggestions
load lazily through `get_commands` (which the profile and read scope must allow),
are cached per selection, and can be reloaded with Refresh. TUI-only built-ins
are not advertised. `/auto on`, `/auto off`, and `/auto status` are suggested only
when the process actually registers `auto`.

Prefix a message with `!` to run a shell command immediately through Pi's RPC
`bash` command (OpenCode / Pi TUI parity). The composer enters a green shell theme
(`>` prompt, Shell badge, Run) while drafting; the transcript shows a Shell tool
card with a live `running · Ns` indicator and streamed output while the command is
active; finished cards collapse like other tools. Output is included in the next
model context. Use `!!` to run a command while excluding its output from context.
Attachments are not allowed with shell prefixes. Stop sends `abort_bash` while a
shell command is running.

### Persistent defaults

Open **Settings** in the session sidebar (the sessions drawer on mobile) with an
idle, writable session selected. The dialog uses the policy extension's existing
`/agentbox-defaults` command; it never writes settings files itself:

- **Use current model as default** sends `model current`. To save another model,
  first choose it in the session's model selector, then open Settings.
- **Save default auto** sends `auto off` or `auto on`. On requires the extension's
  explicit confirmation, shown in the normal agent-request UI after the dialog
  closes. Cancelling or declining does not enable the default.
- **Show saved defaults** sends `status`; the extension reports saved values in
  the session notification. The dialog's auto selector is a proposed value, not
  an indication of the saved default. RPC acceptance alone is not proof of saving.

These are global Pi defaults for future fresh sessions, not changes to the
selected session's live model or auto mode. Resuming a session does not apply
fresh-session defaults. Managed policy can still make auto unavailable.

Settings preserves the unsent draft and attachments and sends only a command via
`POST /v1/sessions/:id/rpc`, with the displayed native-session precondition.
It requires `get_commands`, `prompt`, `sessions:read`, and `sessions:write`, plus
extension UI replies for confirmation. Unsupported/undiscoverable commands fail
closed instead of becoming model prompts. Controls are locked while saving;
streaming, queued work, pending UI, conversation replacement, and offline/read-only
sessions prevent starting settings operations. Failed writes are never retried.
Refresh retries command discovery; upgrading the extension requires a new process.

### Session thinking level

The thinking-level selector beside the model shows Pi's current reasoning effort.
Available choices come from `get_available_thinking_levels` for the selected
model, including `xhigh`/`max` only where supported. A model with only `off` shows
that value without an editable choice. Discovery failures leave the current
level visible but disable changes; Refresh retries discovery. Changes use
`set_thinking_level`, require `sessions:write`, carry the displayed native-session
identity, and are confirmed by `get_state`; failed writes are never retried.
The selector is disabled while streaming, compacting, changing models, or without
write access. Custom command allowlists must include `get_available_thinking_levels`
and `set_thinking_level`; both runtime and Nix defaults include them.

If metadata does not report auto-mode support, the header shows **Auto: unknown**,
not a misleading off state. The browser refuses to send `/auto` to the model in
that case. Deploy the updated runtime and policy extension and start a new Pi
session; merely refreshing the page does not upgrade an existing child process.

Profiles define administrator-owned workspace roots and history directories. In the
browser UI they appear as **Projects**: each project root is one profile
(`cwd` + `sessionDir`). Choosing a project's **+** (or New Session after selecting
that project) starts Pi in that profile's cwd. Nested sidebar folders are only
organizational labels inside a project; they do not change the working directory.
The New Session dialog shows the selected project and an optional session-folder
label. Each project/folder heading has a **+** that preselects that target without
toggling collapse. API clients may still request an explicit cwd within a profile
root; both the path and its canonical target are checked so symlinks cannot escape
that root. The UI uses native Pi sessions and credentials; it does not convert
OpenCode conversations or import OpenCode authentication. Each additional profile
needs a distinct, non-overlapping persistent session directory. Pi provider
credentials in environment variables must be explicitly mapped into the profile,
separate from the browser's RPC password.

Optional `autoDiscoverProfiles` scans one absolute root at supervisor startup and
synthesizes a profile for each immediate child directory (`cwd=<root>/<name>`,
`sessionDir=<sessionDirPrefix>/--<name>--`). Those discovered profiles become
Projects in the sidebar automatically. Explicit `profiles` entries always win on
name conflicts. Discovery skips invalid profile names, excluded names,
`excludePrefixes` (default `tmp-`), non-directories, and symlink targets outside
the root. It fails closed when the root is missing or discovery would exceed
`maxProfiles`. Keep the explicit default `sessionDir` as a sibling path such as
`.../sessions/--workspace--`, not the shared prefix directory itself, or overlap
checks reject startup. Pi still loads each project's `AGENTS.md` / `CLAUDE.md`
from that profile's cwd. Filesystem isolation is controlled separately below.

### Per-profile filesystem sandbox

Agentbox's NixOS and nix-darwin container modules enable
`settings.piRpcApi.sandbox.enable` by default. Each RPC Pi process starts through
Linux Bubblewrap, with a fresh mount/PID/user namespace, dropped capabilities,
private `/tmp`, `/run`, and agent home, and a minimal `/dev`. Only the selected
profile's canonical `cwd` and `sessionDir` are bound read-write. Required system
and managed runtime files are read-only; sibling projects and sibling session
folders are absent. File tools, extensions, language servers, shell commands,
and delegated children inherit this boundary. Selecting a subfolder narrows the
project mount to that folder. Symlinked cwd/session paths are rejected rather
than silently granting their targets. Profile roots must be distinct from their
session storage and cannot be broad/reserved roots such as `/` or `/workspace`.
Use canonical project-specific profiles; an ancestor project mount necessarily
includes its descendants, so do not treat nested profile roots as isolated peers.

Additional trusted grants are configured with
`settings.piRpcApi.sandbox.readOnlyPaths` / `readWritePaths`. These expose the
same paths to **every** profile and explicitly widen the boundary. Paths must
exist and be canonical; broad, reserved, and overlapping mounts are rejected.
Installed home-directory skills are not exposed automatically; explicitly grant
read-only access to `/home/agent/.pi/agent/skills` if needed. Extra sockets, SSH
keys, browser displays, and cloud credential files are not implicitly exposed.
The managed `/home/agent/.gitconfig` is exposed as a single read-only file, so
Git retains the configured author name/email without exposing the rest of the
home directory. Missing Git configuration is allowed. Global configuration writes
are blocked; use repository-local `git config` for project overrides. Included
configuration files, signing keys, and credential-helper data outside the allowed
mounts remain unavailable unless separately granted. External MCP services retain
their own permissions; this sandbox cannot restrict a remote tool's filesystem or
database access.

Authentication, settings, and models are seeded from the agent's existing files
into **private writable copies**. Lock files and OAuth refreshes work within a
session, but these changes disappear on exit; rotating refresh tokens can make
the original credentials stale and require re-authentication. Credentials remain
readable by the process. Networking is inherited, not filtered: this is not a
credential-confidentiality or network-exfiltration boundary.

Bubblewrap requires Linux user namespaces and compatible outer-container seccomp,
AppArmor, and kernel settings. Docker's default policy and Agentbox's narrow
`browser` preset do not permit this launcher's namespace/mount setup. For an
unprivileged x86_64/aarch64 Docker container, explicitly configure:

```nix
services.agentbox.settings = {
  enableDocker = false;
  hardening.seccompProfile = "browser-rpc";
  piRpcApi.sandbox.enable = true;
  # Additional explicit relaxation if Docker's system-path masks deny procfs:
  # hardening.allowNestedProcMount = true;
  # hardening.noNewPrivileges = true; # required for the relaxation; disables sudo
};
```

If namespace creation succeeds but Bubblewrap reports `Can't mount proc on
/newroot/proc: Operation not permitted`, Docker's default system-path masks may
be preventing the kernel from mounting a fresh procfs inside the nested user/PID
namespace. AppArmor/LSM rules can independently cause the same error. After
reviewing the container-wide tradeoff, enable both commented hardening options
above and recreate the container. `allowNestedProcMount` emits
`--security-opt systempaths=unconfined`: this removes **all** Docker default masked
and read-only system-path protections, including under `/proc` and `/sys`, not
just a single proc mount restriction. It defaults off and requires `browser-rpc`,
`noNewPrivileges = true` and enabled RPC filesystem sandboxing. This does not
disable AppArmor or seccomp; a remaining LSM denial requires separate review.
Do not bind the outer `/proc` into RPC sessions: that would expose sibling
processes and potentially their filesystem roots, undermining profile isolation.

This opt-in retains Chromium's sandbox and RPC filesystem isolation but exposes
additional namespace and mount syscalls **container-wide**; see the
[policy contract](../security/seccomp/README.md#rpc-bubblewrap-preset).
Recreate the container after changing the policy; restarting Pi or pi-rpc is not
enough. Consumers pinned to an older Agentbox input must update that pin to a
revision containing this preset before selecting it. A local sibling checkout
does not update the pinned input. Host AppArmor/LSM restrictions can still block
user namespaces or mounts and require a separately reviewed host policy.

Unsupported environments fail closed: Pi is never
launched directly as a fallback. Do not solve namespace failures with privileged
containers or broadly disabling security policy. Validate the isolation integration
test in the actual deployment environment before relying on the boundary.
Disabling `sandbox.enable` explicitly restores the previous shared-filesystem
behavior. Independently launched interactive Pi sessions are not covered.

### Opt-in SSH-agent forwarding

Forwarding is disabled by default and must be granted per profile. First arrange
for a **dedicated** SSH agent's Unix socket to be reachable inside the outer
Agentbox container. Then configure:

```nix
services.agentbox.settings.piRpcApi = {
  sandbox = {
    sshAgentSocket = "/run/dedicated-ssh-agent.sock";
    sshKnownHostsPath = "/home/agent/.ssh/known_hosts";
  };
  profiles.my-project.sshAgentForwarding = true;
  # Optional grant to every discovered project (explicit profiles keep their setting):
  # autoDiscoverProfiles.sshAgentForwarding = true;
};
```

For a dedicated host-side agent, an explicit outer-container volume can supply
its socket; adapt the source path and permissions to the host:

```nix
services.agentbox.extraVolumes = [
  "/run/user/1000/agentbox-ssh-agent.sock:/run/dedicated-ssh-agent.sock:ro"
];
```

The forwarded socket must already exist, be canonical, and be accessible to the
container's agent UID. No agent is started and no keys are loaded automatically;
interactive-shell SSH agents do not automatically supply a stable socket to the
RPC service. Platform-specific host-agent forwarding (including Docker Desktop)
is separate from this per-profile grant.

Opted-in sandboxes receive only the socket at `/run/pi-ssh-agent.sock`, with
`SSH_AUTH_SOCK` set accordingly, plus a read-only `known_hosts` file at its normal
agent-home location. Populate that file using trusted host keys via Agentbox's
`settings.sshKnownHosts`, or configure another canonical trust file. Missing,
non-socket, or symlinked agent paths and missing/invalid trust files fail closed.
Neither source may be inside any profile workspace/session tree; the socket also
cannot live in shared runtime mounts. Private key files and parent directories
are not exposed. Opted-out profiles have `SSH_AUTH_SOCK` unset, regardless of
profile environment mappings. Forwarding requires the filesystem sandbox.

**A read-only socket mount does not make the SSH-agent protocol read-only.**
Clients can authenticate/sign with all loaded identities and can list, add, or
remove identities. A malicious project can use the agent to access other
repositories/servers or disrupt other projects sharing it. Use a dedicated,
least-privilege agent, not an unrestricted personal agent. Host verification is
not disabled, and no SSH configuration or private keys are copied. If the agent
replaces its socket, restart affected RPC sessions (and recreate an outer file
bind mount if necessary); existing mounts pin the old socket inode.

For standalone runtime JSON, opt in with `piRpcApi.sandbox.enable = true`;
`executable` selects an absolute immutable Bubblewrap path, defaulting to the
packaged `PI_RPC_SANDBOX_EXECUTABLE`. The package also supplies immutable bootstrap
shell/coreutils paths. Standalone JSON without `sandbox` retains legacy behavior.

When a previously discovered project's working directory is missing at startup,
its `--name--` history folder is attached to the **default** profile as an extra
session directory. Those conversations stay listed under default (never hidden)
until the project directory returns and discovery recreates the project profile.
Resuming such a session falls back to the default workspace root when the saved
cwd is missing. Before starting Pi, the runtime atomically updates the saved
session header cwd to that root, preserving the session ID, file location and
conversation entries. This fallback is persistent: once resumed, the session
stays under default even if the old project directory returns. Inaccessible or
out-of-workspace existing directories are rejected rather than rebased. If
`sessionDirPrefix` itself does not exist yet (fresh install or empty volume),
orphan scanning is a no-op rather than a startup failure.

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
        "sessionDir": "/home/agent/.pi/agent/sessions/--workspace--",
        "args": ["--approve"],
        "envReferences": { "PROVIDER_TOKEN": "PI_PROFILE_PROVIDER_TOKEN" }
      }
    },
    "autoDiscoverProfiles": {
      "enable": true,
      "root": "/workspace",
      "sessionDirPrefix": "/home/agent/.pi/agent/sessions",
      "excludePrefixes": ["tmp-"],
      "maxProfiles": 64,
      "envReferences": { "PROVIDER_TOKEN": "PI_PROFILE_PROVIDER_TOKEN" }
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

Profile `allowedCommands` may narrow the global command set. Session
switch/fork/clone/new-session, HTML export, and raw `extension_ui_response` are
always forbidden. User shell (`bash`) is allowed by default so the web UI can
run OpenCode-style `!command` / `!!command` without prompting the model.
Profile arguments also cannot set supervisor-owned mode,
name, session, session ID, session directory, continue, resume, or fork flags.
Extension dialogs must use the checked UI endpoint.

Resume accepts only a complete UUIDv4 or UUIDv7, never a path or partial
identifier, and requires the selected profile to have a `sessionDir`. The
supervisor resolves an exact, unique regular file with matching header ID and
working directory within the profile root, rejects session-file symlinks, then
passes that server-owned path to Pi. Resume restores the header's cwd after
checking that its folder still exists within the approved root.
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
directory. Browser-created subfolder sessions share the profile's configured
sessionDir and retain their own cwd in the session header; CLI sessions in other
per-cwd directories are not automatically imported.

## API

The static UI shell/assets and the two health routes are public; session data
and all `/v1` routes require `Authorization: Bearer <token>` and the listed scope.
An Origin header is optional for non-browser callers except browser control
POSTs; when present, it must exactly match `allowedOrigins`.

### Managed browser preview and control

With a browser-enabled image/configuration, the **Browser** pane previews the
selected live conversation's main tab. It uses the existing HTTP listener and a
private inherited fd to Pi, not public CDP or WebSockets. Preview never starts a
browser. Routes require `X-Pi-Session-Id`, the current running/unlocked session,
and profile `get_state` permission:

- `GET /v1/sessions/:id/browser` — status; `sessions:read` + `browser:read`.
- `GET /v1/sessions/:id/browser/frame` — bounded JPEG/ref frame; same scopes.
- `POST /v1/sessions/:id/browser/control` — acquire/renew/release/fresh-frame input;
  additionally `sessions:write` + `browser:control`, profile `prompt`, and Origin.

With control held, click the preview and type or paste directly, including editing
keys and Cmd/Ctrl+A. Coordinate clicks use `{action:"pointer",x,y}` within the
acknowledged frame; focused text uses `{action:"type",text}`. Both retain the same
lease and consumed-frame checks as reference input. The agent's `browser` tool
also exposes `pointer`, `type`, `wheel`, and `resize`, using separate single-use
agent screenshot IDs (60-second lifetime); human preview IDs/leases cannot be
used by that tool. Human takeover blocks it and invalidates its earlier frames
across the delegated family. The frontend buffers only unsent input in memory, bounds its size, and
discards it after five seconds waiting for freshness or when control is lost.
Wheel input uses `{action:"wheel",x,y,deltaX,deltaY}` with integer deltas bounded
to ±2000; `{action:"resize",width,height}` changes the remote CSS viewport within
320–2560 by 240–1600. Frame responses carry the actual width and height. Presets
and custom sizes are available in Browser viewport; local frame resizing and
expansion are independent display controls. Viewing polls at 1 fps; takeover
polls at up to 4 fps. Renewal preserves fresh frames under the unchanged lease.
Frames also project the current page `url` (HTTP(S) or `about:blank`, with embedded
credentials removed). The URL bar supports Enter/Go, Back, Forward and Reload
under the same control permissions and frame guards, and remains visible when expanded.

Wildcard tokens retain full authority. Tokens are operator-wide capabilities,
not per-user ownership. All responses are no-store; frames and leases never enter
Pi stdout, history or SSE replay. Takeover leases expire after 30 seconds, bind to
the principal/native session/browser incarnation and pause structured browser
operations across the delegated family. No mutation retries. A failed/expired
browser requires explicit agent recovery; a permanently closed private bridge
returns `browser_bridge_closed` and requires restarting the conversation process.

See [the browser guide](../docs/browser.md) and
[wire/arbitration contract](../docs/browser-phase2-contract.md) for limits,
security boundaries and remaining live acceptance requirements.

### Route reference

| Method and path | Scope | Result |
|---|---|---|
| `GET /` | public | Bundled native Pi chat UI shell |
| `GET /health/live` | public | Process liveness |
| `GET /health/ready` | public | Readiness; returns 503 during shutdown |
| `GET /v1/profiles` | `profiles:read` | Configured profile names |
| `GET /v1/folders` | `profiles:read` | Approved workspace roots as `{roots:[{profile,path}]}` |
| `GET /v1/folders?path=...` | `profiles:read` | Folder path, root, parent, child directories and truncation flag |
| `DELETE /v1/history/:nativeId?profile=default` | `sessions:delete` | Archive saved history without starting Pi; rejects an active session |
| `POST /v1/history/:nativeId/move` | `sessions:write` | Move saved history to another profile with `{profile,targetProfile,folder?}`; rewrites session `cwd`, relocates the JSONL, and assigns the destination folder |
| `GET /v1/history?profile=default` | `sessions:read` | Native Pi history from the approved profile's session directory |
| `GET /v1/session-folders?profile=default` | `sessions:read` | Shared folder assignments as `{folders:[{id,folder}]}` |
| `PUT /v1/session-folders?profile=default` | `sessions:write` | Assign a native session with `{id,folder}`; empty folder ungroups |
| `DELETE /v1/session-folders?profile=default` | `sessions:write` | Delete a folder label with `{folder}`; ungroups exact and nested matches |
| `POST /v1/sessions` | `sessions:create` | Create or resume a supervised child |
| `GET /v1/sessions` | `sessions:read` | List in-memory sessions |
| `GET /v1/sessions/:id` | `sessions:read` | Session state and bounded stderr tail |
| `GET /v1/sessions/:id/export` | `sessions:read` | Complete conversation tree as versioned JSON; requires an idle running child and allowed `get_state`/`get_entries` commands |
| `DELETE /v1/sessions/:id` | `sessions:delete` | Terminate the child and persistently archive its history |
| `POST /v1/sessions/:id/rpc` | `sessions:read` for the read commands listed below; otherwise `sessions:write` | Forward an allowed RPC command and await its response |
| `POST /v1/sessions/:id/ui` | `sessions:write` | Answer one pending extension dialog |
| `POST /v1/sessions/:id/auto` | `sessions:write` | Set session auto mode using exactly `{"enabled":true}` or `{"enabled":false}` |
| `GET /v1/sessions/:id/events` | `sessions:read` | SSE stream with bounded replay |

The read-command set is `get_available_models`,
`get_available_thinking_levels`, `get_commands`, `get_entries`,
`get_fork_messages`, `get_last_assistant_text`, `get_messages`,
`get_session_stats`, `get_state`, and `get_tree`. A write-only token cannot use
these commands as a way to read session data.

The browser creates with `{"profile":"default","folder":"Work/Project","name":"Project"}`.
`folder` is an optional conversation-group label, not a filesystem path. It uses
the same normalization and bounds as sidebar assignments, requires `sessions:write`
as well as `sessions:create`, and is saved in the profile's persistent session
storage before the child starts. GET `/v1/session-folders` includes active sessions
before Pi persists their first prompt, so other browsers see the group immediately.
Omit `folder` for Ungrouped; resuming cannot overwrite an existing assignment.
The API also accepts `{"cwd":"/workspace/project","name":"Project"}` for an explicit
working directory. The server selects the most specific matching profile; an
optional `profile` can constrain that choice. `{"profile":"default"}` remains
supported and starts at its configured cwd. Omitted profile/cwd uses the default profile, or the first
configured profile if none is named default. Names are optional. Resume uses
`{"profile":"default","resume":"<full UUID>"}` and cannot override the saved cwd.
The optional server-directory API scans at most 10,000 entries and returns at
most 1,000 directories; `truncated:true` means clients should request the desired
path directly. Exited sessions remain available for inspection until idle cleanup but do not consume the active-session quota. Idle cleanup (30 minutes
by default) only stops disconnected sessions without outstanding commands, active
agent work, compaction, or pending UI dialogs. Quiet tools such as a long `sleep`
and unanswered approvals are not idle. Once work settles or a dialog closes, its
last activity starts a fresh idle window. Explicit end and runtime shutdown still
stop these sessions. “PICK UP WHERE YOU LEFT OFF” lists saved conversations with
no running/stopping process; it is not a waiting-for-tool or approval status.
RPC requests are Pi command objects. UI requests
are `{"id":"...","confirmed":true}`, `{"id":"...","value":"..."}`, or
`{"id":"...","cancelled":true}`. Select values must match an offered option.

Session metadata includes `name`, `cwd`, `nativeSessionId`, `latestEventId`, and an
optional initial `folder` label. It also includes
pending UI requests. `autoMode` is `null` until the policy extension announces
support, then `{available, enabled}`. Auto restores the conversation's last explicit
choice on restart/resume, including from “PICK UP WHERE YOU LEFT OFF”; without a
saved choice, resumed conversations start off. Managed `auto.enable` must still
permit it. Fresh sessions alone may use an explicitly saved global default. The web toggle requires write
scope and allowed `prompt`, binds the request to the displayed native session,
and sends the policy extension's `/auto on` or `/auto off` command. It waits for
confirmed state, never optimistically enables auto, and never retries failed
writes. State changes synchronize through the existing SSE/metadata flow.
Forks and workflow children do not inherit saved Auto authorization. Resuming or
replacing a process for the same native conversation restores its own choice.
The browser never copies Auto state between sessions or persists it globally.

`fastMode` is likewise `null` until the managed `pi-openai-fast` extension reports
`{available, enabled}` through `agentbox-fast` status. The active-session toolbar’s OpenAI fast mode control (beside Auto, not global Settings)
affects only the selected session; switching sessions reflects their own confirmed mode. It sends `/fast on|off` through native-session-bound prompt RPC and waits for refreshed
metadata. This is not a saved global preference: new parent Pi processes start off.
Managed subagents inherit the parent's live mode at spawn (including resumed jobs),
only for supported OpenAI/Codex providers. Already-running children are unchanged.
It requires idle writable state and resets on session or
model changes. Only OpenAI/Codex providers are supported; premium pricing/credits
may apply. This option is distinct from reasoning effort and auto permissions.

`activity` distinguishes `starting`, `running`,
`waiting_reply` (text input/editor), `waiting_action` (confirmation/selection),
and `idle`; stopped processes retain their process status. Idle is reported only
after `agent_settled`, not a low-level `agent_end` that may still retry or continue.
The browser polls the lightweight session list every 1.5 seconds to update all
sidebar rows, without opening an SSE stream or reading transcripts for each one.
End & archive terminates the child and persistently hides its history, including
across browser and runtime restarts. The web composer also accepts `/archive` as a
frontend-only shortcut that opens the same confirmation and never prompts the
model (distinct from Pi's `/skill:archive-conversation` host-uploader skill).
Native JSONL files are never deleted or rewritten: private
`.archived-<native-uuid>` marker files live in the profile's session directory.
Markers are written only after the child exits. An archive failure returns
`archive_failed` and retains the stopped runtime slot for an explicit DELETE
retry. Ephemeral profiles have no history to archive.

Session folder assignments are stored in the profile's `sessionDir/.session-folders/`
as private, atomically replaced per-conversation sidecars, isolated by profile
name and working directory. Native Pi JSONL files are not changed. Include this
hidden directory in backups and keep `sessionDir` on persistent storage for
container replacements. Folder names are labels, not filesystem paths; slash
separates up to 12 nested levels (80 characters per level). Writes validate native
session ownership, and profiles without accessible persistent storage return 409.
Assignments are shared by authorized clients of the runtime, not private per token.
Updates to different sessions cannot overwrite one another; for the same session,
the last successful write wins. The browser refreshes assignments every 15 seconds
and on manual Refresh. Legacy browser assignments are imported on login using
`{id,folder,importOnly:true}`: atomic create-if-absent returns the stored winner
without overwriting another device's assignment. Ungrouping persists an empty
folder tombstone (also returned by GET), preventing an older browser from
resurrecting removed assignments. DELETE `{folder:"Work/Project"}` ungroups every
assignment equal to that label or nested under it (for example `Work/Project/UI`),
including live sessions that have not yet written a native JSONL header, and
returns `{folder,ungrouped:[{id,folder:""},...]}`. Empty folder is rejected;
deleting a label with no matches still succeeds with an empty `ungrouped` list.

`GET /v1/history?profile=default&includeArchived=true` includes archived history
with an `archived` boolean on each history entry. History includes `createdAt`
from the native session header timestamp (falling back to `modifiedAt` for missing
or invalid timestamps). The web sidebar groups archives under **Archived
conversations**, newest creation date first, respecting the profile filter. Archived
entries are excluded from browser Recents. Click an entry
to reopen it for reading or continuing (starting a new process), then use
**End & archive** again when done. Its archive marker remains while reopened;
running conversations appear in the runtime list instead of the archive list.
To restore normal history visibility, an administrator can remove that UUID's
marker from the configured session directory. Listings remain bounded to 1,000
sessions and the UI warns when the server reports truncation.
Previously ended conversations are not retroactively archived.

`POST /v1/history/:nativeId/move` relocates a saved conversation between Projects
(profiles). Body is `{profile,targetProfile,folder?}` with `sessions:write`.
The runtime rewrites the session header `cwd` to the destination profile cwd,
publishes the JSONL into that profile's `sessionDir` (keeping the original
filename), moves any archive marker, assigns the destination folder label, and
clears the source folder assignment. Active/resuming sessions are rejected with
`session_active`; end them first. Same-profile moves and missing/ambiguous
sources are rejected. Retries are idempotent once the destination owns the file.

The web **Export JSON** button downloads `GET /v1/sessions/:id/export` as
`conversation-<native-uuid>.json`. The version-1 `agentbox-conversation` document
contains `exportedAt`, `nativeSessionId`, `leafId`, `name`, `profile`, `cwd`, and
all native `entries`, including inactive branches and entries preceding compaction.
It uses the same locked, authoritative snapshot checks as conversation actions,
without writing files or prompting Pi. Reopen archives before exporting. Read
scope is sufficient; busy sessions and oversized RPC records fail explicitly.
Inline attachments are preserved; external referenced files are not bundled.
Exported messages and tool output may contain sensitive data. This is an export
format, not an import endpoint or a raw native session JSONL file.

The tab title shows unread session counts, e.g. `1! 2 | Pi Agent | Agentbox`
means one session needs input/approval and two have finished. Entering a session
acknowledges its current requests/completion; subsequent requests and completions
can notify again. The selected session is acknowledged while the tab is visible
and focused, including when returning to the tab. Counters are page-memory only
and clear on logout. Fresh idle sessions do not count as finished. Metadata's
`settledEventId` retains the most recent `agent_settled` event ID even after replay
ring eviction, so a run completed between sidebar polls is not missed.

Collapsed tool rows include shortened commands, paths, or queries. Consecutive
thinking/tool-only assistant messages from the same model share one header and
compact, wrapping rows; opening a row reveals the full original input/output.
User turns, prose, errors and model changes remain separate.

New-session creation no longer immediately rescans history while Pi is loading
that same directory. The connection label distinguishes agent startup and
conversation synchronization from opening the event stream. Each session still
starts a fresh Pi process: extension/MCP initialization can take time before
snapshot RPCs return, so this does not promise instant cold starts. Accepted answers publish `extension_ui_resolved` supervisor
events so other browser tabs remove the same request.

SSE records use monotonically increasing IDs.
Each authenticated subscription immediately sends a `: connected` SSE comment,
even when there is nothing to replay. This supplies body bytes without waiting
for Pi activity or the periodic heartbeat and does not advance the event cursor.

Reconnect with `Last-Event-ID` or
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

## Forwarded child approvals

Managed workflow children forward human-required policy approvals through private
stdio pipes to the parent extension, which opens the existing select UI. This
includes effective explicit `ask` rules even with auto enabled, default asks
when auto is disabled, and immediate human fallbacks whenever an enabled auto
classifier denies or cannot evaluate a call. All use the same existing transport and public decision schema. The
child still evaluates immutable guards and managed rules; forwarding does not
override denies, change auto-permission behavior, or grant blanket access.
Requests use per-child IDs, bounded frames and deadlines that include queue time.
Children without a working parent approval channel fail closed.

A classifier denial, timeout, missing credentials, an image-only latest request,
or other inability to classify immediately asks a human about that same call.
Historical screenshots no longer automatically defeat later clear textual intent;
omitted attachments are disclosed and cannot establish authorization. The latest
user request and recent follow-ups guide classification, including explicitly
requested normal commit/push operations. Installed skill Markdown reads default
to no prompt, but explicit ask/deny rules and sensitive-path guards still win.
There is no silent-denial threshold. Denied, cancelled, timed-out, or unavailable
human approval still blocks; no classifier failure grants permission. Explicit
Auto/review choices belong to the native session and restore on resume; they do
not authorize another session, fork, or workflow child.
Disabling it cancels an in-flight classification without accepting a late allow.
Existing pending approvals still require a human answer. No approval overrides
rule denials. See the main README's Pi auto permissions section for classifier
history evidence and trust limits.

The workflow extension tags forwarded select titles with a `Pi child approval `
JSON identity line containing `version`, parent `toolCallId`, `taskId`, `role`,
and `requestId`. The runtime renders a readable role/task/operation request.
Workflow progress reports `details.jobs[].approvalClosed` when a request settles,
allowing the runtime to expire the matching pending card immediately. Parent tool
completion also expires remaining associated cards. Identity metadata only
controls display and cleanup; it never authorizes tool execution. These pipes
separate control traffic from model output, not from arbitrary same-UID code.

## Conversation actions

`GET /v1/sessions/:id/conversation` requires `sessions:read` and returns
`{nativeSessionId, leafId, messages: [{entryId, parentId, message}]}` along the
active branch. It includes messages before compaction, unlike the current model
context returned by `get_messages`.

`POST /v1/sessions/:id/conversation` accepts exactly:

```json
{
  "action": "fork",
  "entryId": "user-entry-id",
  "expectedNativeSessionId": "native-session-uuid",
  "expectedLeafId": "current-leaf-id"
}
```

`action` is `fork` or `revert`; the expected leaf may be `null`. The target must
be a user message on the current branch. Both actions require read/write scopes,
allowed `get_state`, `get_entries` and `prompt` commands, fully persisted Pi v3
history in the profile-owned directory, and an idle agent with no queue or pending
dialogs. Fork also requires `sessions:create`. Both need one spare `maxSessions`
slot to verify the replacement before changing anything.

The response is `{session, draft: {text, images}}`. History ends before the
selected message; its text/images become an unsent draft. Fork creates a separate
supervisor/native session and leaves the source running. Revert switches the
existing supervisor slot to a new native history while retaining the original
file for resume. Neither action undoes filesystem changes or tool side effects.
The current model, thinking level, auto-compaction and queue delivery modes are
restored and verified on the new child. Preparation failures can leave an unused
child history file; the original file is never rewritten.

Browser RPC/UI writes include `X-Pi-Session-Id` to bind mutations to the displayed
native conversation. Stale writes return 409 `conversation_stale` without being
forwarded. The header remains optional for existing API clients. Raw `fork` stays
forbidden; this endpoint is the controlled history boundary.

On revert, `supervisor` events `conversation_replacing` and
`conversation_source_exited` precede closing the old stream. Clients must poll
metadata while `conversationReplacing` is true, then refresh and reconnect even
though the old child exited. Success emits `conversation_changed`; failure clears
the flag and emits `conversation_replace_failed`. Event cursors remain monotonic,
but abandoned transcript events are removed from replay. Do not automatically
retry failed POSTs: an interrupted response can leave the outcome unknown.

Run the optional offline contract check against the pinned Pi version with
`PI_CONVERSATION_TEST_EXECUTABLE=/absolute/path/to/pi node --test test/conversation-pi.test.mjs`.

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

### Browser regression smoke test

Run `npm test` for the runtime/unit suite. The optional real-browser fixture uses
Playwright without adding a production dependency:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node web/browser-smoke.mjs
```

`SETTINGS_ONLY=1` runs just the Settings desktop/mobile regression scenarios.
`FOLDERS_TABS_ONLY=1` covers session-folder selection, creation from collapsed
folder headings, row archive/cancel for running and saved conversations, session
tabs, independent drafts, and explicit catalog refresh.
For a portable Nix check, run `nix build path:.#checks.aarch64-darwin.pi-rpc-workspace`
from the Agentbox root, substituting the desired system. The full
`pi-rpc-runtime-test` also exercises Linux procfs history storage.
`CHROMIUM_EXECUTABLE` can select a system Chromium. The desktop/mobile smoke test
covers Settings commands, native write headers, draft preservation, unchanged
live model/auto, confirmation/decline, concurrent-write locks, missing command
support, and keyboard dismissal, alongside the existing chat flows.

### Browser file attachments

The composer accepts arbitrary files (5 MiB combined per draft). PNG, JPEG,
WebP and GIF retain previews and native Pi image sending; a vision-capable model
is still required. Other files, including text, PDF, audio, video and archives,
are uploaded when Send is pressed. The prompt contains their original display
names and generated absolute filesystem paths, not native binary model blocks.
The agent needs appropriate filesystem tools/parsers to use those files; model
support for these formats is not implied. Treat file contents as untrusted.

`POST /v1/sessions/:id/uploads` is part of this authenticated HTTP wrapper, not Pi
RPC. It requires `sessions:write`, an allowed `prompt` command in the session's
profile, and a mandatory matching `X-Pi-Session-Id` native UUID. JSON body:
`{"profile":"default","data":"<canonical base64>"}`. No client filename or path
is accepted. Response: `{path, size, nativeSessionId}`. Origin policy applies as
for other writes. Stopped, changing, mismatched-profile and stale sessions are
rejected, including a second identity check after asynchronous storage.

Limits: 5 MiB decoded per file, the smaller of `maxBodyBytes` and 7 MiB for JSON,
and 50 MiB / 100 files per runtime session (including concurrent reservations).
Smaller configured body limits also constrain uploads. Each file has a fresh
server-generated private `pi-upload-*` directory in the runtime's OS temporary
directory (0700), with an exclusively created `file` (0600). No upload download,
list, overwrite, or delete API is exposed. Files live in the same environment as
Pi. API session isolation is **not an OS sandbox**: Pi processes running as the
same Unix user can access one another's files if they discover their paths, just
as they can access other shared filesystem state. Tokens retain the wrapper's
existing scope model, not per-user session ownership.

Removing an unsent file prevents its upload. Failed sends keep the draft and
reuse completed uploads in that native conversation; switching conversations
while uploading prevents automatic sending. Failed partial storage is removed.
Successful uploads (including abandoned drafts or ambiguous network failures)
are retained so sent references and resumed history remain usable until the OS
or administrator removes them. They are not deleted on session end or runtime
shutdown. Temporary storage may be ephemeral; archive important files elsewhere.
Administrators should budget/clean `pi-upload-*` storage: quotas are per runtime
session, not durable global/user disk quotas, and reset on session replacement
or runtime restart. Only trusted authenticated writers should have access.
