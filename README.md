# agentbox

A self-contained AI coding-agent sandbox, packaged as a standalone Nix flake.
It ships a full dev toolchain in an OCI container and runs **Claude Code**,
**Codex**, **OpenCode**, and **Pi** inside it, isolated from the host.

- **`agentboxImage`** — a Nix-built OCI image (no Dockerfile, no Homebrew).
- **`agentbox`** — a host-side CLI to drive the container (`status`, `shell`,
  `logs`, `exec`, `opencode`, `pi`, `pi-web`, `pi-rpc`, `claude`, on-demand services,
  `pause`/`resume`, and `start`/`stop`/`restart`).
- **`nixosModules.agentbox`** / **`darwinModules.agentbox`** — run it as a
  systemd `oci-containers` service (NixOS) or via manual management (macOS).

It depends on **nothing but `nixpkgs`**. No private inputs; Codex, OpenCode, and
Pi come from nixpkgs, while Claude Code uses Anthropic's runtime installer.

## The agents

| Agent | How it gets into the box | Toggle (default) |
|---|---|---|
| **Codex** | bundled in the image from nixpkgs (`codex`) | `settings.enableCodex` (false) |
| **OpenCode** | bundled in the image from nixpkgs (`opencode`) | `settings.enableOpencode` (true) |
| **Pi** | bundled in the image from nixpkgs (`pi-coding-agent`) | `settings.enablePi` (true; availability toggle) |
| **Claude Code** | installed at container start by Anthropic's native installer (self-updates) | `settings.enableClaudeCode` (false) + `claudeCodeVersion` |

All four are first-class: Codex, OpenCode, and Pi are baked into the image from
nixpkgs; Claude Code is runtime-installed so its own updater keeps it current.
Each toggle sets the matching `ENABLE_*` env the entrypoint reads. Provide
credentials through the secret `environmentFile` (e.g. `OPENAI_API_KEY` for
Codex, `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code).

Codex and Pi are interactive CLIs, so `enableCodex` and `enablePi` control
startup availability checks rather than removing their binaries from the image.
`enablePiWeb` separately controls Pi's browser service.

Pi also has a browser TUI at `http://localhost:4097`, enabled by
`settings.enablePiWeb` (default: true). It runs the exact wrapped Pi CLI in a
persistent tmux session, so terminal and browser use the same native settings,
credentials, sessions, skills, and immutable Agentbox extension. Set
`PI_WEB_PASSWORD` in the secret `environmentFile`; `OPENCODE_PASSWORD` is used
as a fallback. The Basic Auth username is `pi`. It binds to host loopback by
default on NixOS. The Darwin container binds all interfaces because its Docker
runtime may cross a Linux VM, and refuses to start Pi web without a password;
use a trusted TLS reverse proxy or VPN rather than exposing plain HTTP Basic
Auth directly.

Pi runs through an immutable wrapper that rejects `-e`/`--extension`, disables
extension discovery, and force-loads trusted Agentbox extensions in this order:
core integration, workflow, MCP, and final managed policy. Delegated workflow
jobs and RPC sessions re-enter the same wrapper. Pi's positional package/config/
auth management commands remain available, but their installed extensions are
not discovered by agent runs. The final policy fails closed
if `/etc/pi/agentbox-policy.json` is absent or invalid. Direct file targets are
canonicalized, so safe symlinks whose destinations are allowed work, while
aliases into sensitive paths and writes through aliases into managed/Nix-store
paths remain immutable denials. Obvious sudo/su and privilege-escalation calls,
privileged containers or host-root mounts, root deletion, and filesystem/device
destruction are also immutable denials. These run before configurable rules. Any
matching configured `deny` wins; otherwise the last matching `allow` or `ask`
wins per target. A multi-target call is denied if any target is denied, or asks
if none is denied but any target asks. The defaults allow workspace file work
plus todo/questions and ask for shell, web, MCP, and delegated tasks. Task prompts
and bounded string arguments from MCP/custom tools are policy targets. The
policy, workflow, and shared runtime JSON files are generated declaratively,
mounted read-only, and cannot be replaced by Pi or project configuration.

A Pi `bash` approval is approval of the submitted command string, not a command
sandbox. The policy rejects listed immutable operations and inspects obvious
nested `sh`/`bash` and interpreter `-c`/`-e` payloads, but shell parsing is
necessarily heuristic: generated scripts, alternate interpreters, expansion,
obfuscation, subprocesses, and time-of-check/time-of-use changes can evade
string inspection. Treat an approved shell call as arbitrary code execution
inside Agentbox. The security boundary is the container and the credentials,
host mounts, network access, Docker access, and cloud permissions granted to it;
scope each of those to the least privilege needed.

Pi adds `web_search`, `web_fetch`, `code_diagnostics`, `code_navigation`,
`todo`, `question`, and `task`. Diagnostics and navigation lazily start and reuse
language servers for Go, Nix, TypeScript/JavaScript, JSON, YAML, HTML, and CSS;
diagnostics fall back to the existing deterministic type/syntax checks and still
run automatically after `write`/`edit` alongside project tests. LSP output and
targets with disallowed file URIs are removed; free-form diagnostic and hover
text is bounded but is not a sensitive-content filter. Search uses anonymous
DuckDuckGo HTML or Jina Search with `JINA_API_KEY`; fetch only accepts public
HTTPS URLs and output is bounded.

Workflow defaults provide `simple-task`, `explore`, and `general` roles without
pinning a provider or model. Roles inherit the active Pi selection unless
configured otherwise. Todo/task state follows the current session branch,
delegation has concurrency/job/step/output limits, and `question` works in both
the TUI and an RPC-provided UI.

For headless ChatGPT/Codex login, run `/login`, select `ChatGPT Plus/Pro
(Codex)`, then choose `Device code login (headless)`. Pi stores and refreshes
the result in `~/.pi/agent/auth.json`.

```nix
services.agentbox = {
  enable = true;
  environmentFile = config.sops.templates."agentbox.env".path;
  settings = {
    enableClaudeCode = true;
    enableCodex = true;
    enableOpencode = true; # on by default
    enablePi = true;       # on by default
    enablePiWeb = true;    # browser TUI on http://localhost:4097

    piConfig.workflow.maxConcurrency = 4;
    piConfig.permissions.timeoutMs = 30000;

    # Empty by default. Values below are interpreted as environment variable
    # identifiers; keep the corresponding secret values in environmentFile.
    piConfig.mcpServers.docs = {
      transport = {
        type = "http";
        url = "https://mcp.example.com/rpc";
        headers.Authorization = "DOCS_MCP_AUTH";
      };
      allowedTools = [ "search_*" ];
      approval = "destructive";
    };
  };
};
```

`settings.piConfig.workflow` types roles and delegation limits.
`settings.piConfig.permissions` types and bounds ordered
`tools`/`patterns`/`decision` rules, generated policy size, and approval timeout.
`settings.piConfig.mcpServers` supports stdio
(`command`, `args`, `cwd`, env references) and Streamable HTTP (`url`, header
references), per-server allow/deny tool globs, approval mode, and connection,
call, close, response, output, and tool-count limits. HTTP endpoints must use
public HTTPS unless `transport.allowInsecureLoopback = true` explicitly enables
a loopback endpoint. Identifier-shaped values cannot be distinguished from
literals by the module schema, so MCP secret values belong in `environmentFile`.
No MCP server is enabled by default.

### Pi RPC API

The optional `settings.piRpcApi` service exposes authenticated HTTP/SSE
supervision on port 4098. It is disabled by default and binds to `127.0.0.1` on
both NixOS and Darwin. Some Darwin Docker runtimes cannot route host requests to
container loopback; `agentbox pi-rpc` still checks readiness inside the
container. To make it host-accessible there, set `bindAddress = "0.0.0.0"` and
explicitly acknowledge plain-HTTP exposure with
`allowInsecureRemoteAccess = true`, then restrict access with a trusted TLS
reverse proxy or VPN.

Only the environment variable name for a bearer-token hash is placed in managed
JSON. Put the lowercase SHA-256 digest in the secret `environmentFile`:

```bash
TOKEN="$(openssl rand -hex 32)"
printf 'PI_RPC_TOKEN_SHA256=%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
```

```nix
services.agentbox.settings.piRpcApi = {
  enable = true;
  auth.tokens = [
    {
      sha256Env = "PI_RPC_TOKEN_SHA256";
      scopes = [ "*" ];
    }
  ];
  allowedOrigins = [ "https://agent.example.com" ];
  profiles.default = {
    cwd = "/workspace";
    # Destination -> source variable in environmentFile.
    env.PROVIDER_TOKEN = "PI_PROFILE_PROVIDER_TOKEN";
  };
};
```

`profiles`, command allowlists, token scopes, origins, and resource/time limits
are typed. Session-switch/fork/clone/new-session, direct bash, HTML export, and
raw UI-response commands are always forbidden by the supervisor. Extension UI
dialogs use the checked `/ui` endpoint. Run `agentbox pi-rpc` to show the URL and
check health; see `rpc-runtime/README.md` for routes and scopes.
The container entrypoint bounds the API log and caps each backoff-controlled
restart run; the API runtime separately supervises and bounds each
`pi --mode rpc` child.
Bearer authentication does not isolate same-UID code inside the container:
agents with that trust level can inspect processes, credentials, and session
files. Use separate containers and UIDs for mutually untrusted tenants.

## What's in the image

| Group | Packages |
|---|---|
| Dev tools | git, neovim (pre-configured), tmux, htop, tree, ripgrep, fd, fzf, jq, yq-go, curl, wget, unzip, gnumake, pkg-config, gcc, nix |
| Languages | go, nodejs 22, bun, python 3.12, uv |
| **AI CLIs** | **codex**, **opencode**, **pi**, Pi MCP runtime, Pi RPC supervisor (Claude Code is runtime-installed) |
| Language servers | gopls, nil, typescript-language-server, yaml-language-server, vscode-langservers-extracted |
| Formatters | nixfmt (RFC), prettier |
| Cloud CLIs | awscli2, kubectl, kubernetes-helm, google-cloud-sdk (+gke-gcloud-auth-plugin), docker-client |
| VCS / scanning | gh, gitleaks, openssh |

Base core/system utilities are tagged REQUIRED vs CONVENIENCE inline in
`image.nix` — `readline` and `expect` were dropped from the base as unneeded.

## In-container sudo & package installs

The image has no apt/dpkg (it isn't Debian). Two knobs cover the usual "let me
just install a thing" workflow, both **on by default**:

- **`settings.hardening.enableSudo`** — the entrypoint stages a setuid-root
  `sudo` under `/run/wrappers/bin` at boot (Nix store paths can't carry setuid
  bits, and there's no `security.wrappers` inside the container, so plain
  `/bin/sudo` can't elevate). `agent` gets passwordless sudo. Turning on
  `hardening.noNewPrivileges` disables it at the kernel level regardless.
- **`settings.enableNix`** — bakes the `nix` CLI in, registers the store DB
  (`buildLayeredImageWithNixDb`), and starts a root `nix-daemon` at boot so the
  unprivileged agent can install throwaway packages:

  ```bash
  nix profile install nixpkgs#ripgrep   # persists for the container's life
  nix shell nixpkgs#hello -c hello       # ephemeral, one command
  ```

  These land in the container's writable layer and are **lost on recreate** —
  bake anything permanent into the image instead (`extraPackages`, or the
  package lists in `image.nix`). Language-level installs (`bun add -g`,
  `go install`, `uv tool install`, `cargo install`) work without either knob.

## Build

```bash
nix build .#agentboxImage      # -> ./result (a docker image tarball)
docker load < result           # loads agentbox:latest
```

### CI

`.github/workflows/build-image.yml` evaluates the flake, builds every extension
and runtime test derivation, then builds the image on every push and PR. On
pushes to `main` / `v*` tags it publishes to GHCR
(`ghcr.io/<owner>/agentbox:latest` and `:<sha>` / `:<tag>`). Building needs no
secrets (nixpkgs-only); only the push uses the built-in `GITHUB_TOKEN`.

## Use the modules

```nix
# flake.nix (consumer)
{
  inputs.agentbox.url = "github:<you>/agentbox";   # or path:./agentbox

  outputs = { self, nixpkgs, agentbox, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        { nixpkgs.overlays = [ agentbox.overlays.default ]; }
        agentbox.nixosModules.agentbox
        {
          services.agentbox = {
            enable = true;
            user = "you";
            settings.enableCodex = true;
            # image/package default to pkgs.agentboxImage / pkgs.agentbox
          };
        }
      ];
    };
  };
}
```

For macOS swap `nixosModules` → `darwinModules` and use `darwin.lib.darwinSystem`
(set `image` to a Linux-built image copied onto the Mac).

Both platform modules share one option schema (`modules/common-options.nix`,
covering `hardening`, `enableDocker`, `enableNotification`, cloud creds, the
`dockerProxy`, `autoCloneRepos`, …). Each platform module adds only its
OS-specific top-level options and config body (systemd vs launchd/manual).

## Selective conversation archive requests

Agentbox can expose an opt-in request inbox for a separate host collector. It
does not upload transcripts and never receives object-storage credentials.

```nix
services.agentbox.settings.historyArchive = {
  enable = true;
  hostId = "home-macbook";
};
```

This creates only `<dataDir>/history-sync/requests` and mounts that directory at
`/home/agent/.agent-history/requests`. The rest of a collector's spool should be
host-only and must not be mounted into Agentbox.

Explicitly invoke `/archive-conversation` in Claude Code or OpenCode, or
`/skill:archive-conversation` in Pi. The command
creates a bounded intent; the next Claude `Stop` or terminal OpenCode idle event
resolves it with the native session ID. The request timestamp is the content
cutoff, so delayed resolution must not include later messages. Archiving more of
the session requires another explicit request. Codex support is intentionally
deferred until its skill invocation can be bound to a native thread ID before
the completion callback.

Pi's extension resolves its intent on the next `agent_end` event using Pi's
native session ID and JSONL session path.

Resolved files contain identifiers, timestamps, event type, and local source
context, but no message content. They are untrusted input: a host collector must
still validate repository remotes and allowlists before reading or uploading a
transcript. The request is an opt-in user interface, not an authentication
boundary: code running inside Agentbox can forge or delete inbox files, just as
it can alter its local transcript. A collector must derive host and trust-domain
identity from host configuration rather than trusting request fields.

## Advanced: baking extra agents in

Beyond the four bundled agents, this standalone ships no others. To add your own
you have four generic hooks, none of which require forking:

| Hook | Purpose |
|---|---|
| `agentboxImage.override { extraPackages = [ … ]; }` | bake the binary into the image |
| `services.agentbox.extraEnvironment` | pass its config/env vars |
| `services.agentbox.extraVolumes` | mount its data |
| `services.agentbox.extraActivation` | stage files on the host at activation |
| `services.agentbox.bootScripts` | **run it at container boot** (as the agent, backgrounded) |
| `services.agentbox.onDemandScripts` | install a service that starts only through the Agentbox CLI |

`bootScripts` is what lets a daemon-style agent actually start — the entrypoint
launches each snippet in the background and keeps the container alive while it
runs (it also honors a single `AGENTBOX_BOOT_CMD` env var, or any executables
mounted into `~/.agentbox/boot.d`).

```nix
nixpkgs.overlays = [
  agentbox.overlays.default
  (final: prev: {
    agentboxImage = prev.agentboxImage.override { extraPackages = [ myAgent ]; };
  })
];

services.agentbox = {
  extraEnvironment.MY_AGENT_PORT = "1234";
  onDemandScripts.my-agent = ''
    exec my-agent serve --port "$MY_AGENT_PORT"
  '';
};
```

Manage the service without restarting the container:

```bash
agentbox service list
agentbox service start my-agent
agentbox service status my-agent
agentbox service restart my-agent
agentbox service stop my-agent
```

`agentbox service list` includes both boot-time and on-demand services, showing
each service's startup mode and current active or inactive status. The other
service actions manage on-demand services only.

For a short break, `agentbox pause` freezes every process while preserving tmux
sessions; `agentbox resume` continues them. `agentbox stop` tears the container
down and, on NixOS, also stops Docker when no other containers are running.
The NixOS image-load unit records the source store path and skips importing an
unchanged `agentbox:latest` image after reboot.

The generic hooks keep additional agents out of this repository; everything
specific to an added agent lives in your own config.
