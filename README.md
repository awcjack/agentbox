# agentbox

A self-contained AI coding-agent sandbox, packaged as a standalone Nix flake.
It ships a full dev toolchain in an OCI container and runs **Claude Code**,
**Codex**, **OpenCode**, and **Pi** inside it, isolated from the host.

- **`agentboxImage`** — a Nix-built OCI image (no Dockerfile, no Homebrew).
- **`agentbox`** — a host-side CLI to drive the container (`status`, `shell`,
  `logs`, `exec`, `opencode`, `pi`, `pi-web`, `claude`, `start`/`stop`/`restart`).
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

Pi force-loads an immutable Agentbox extension that mirrors the Agentbox-owned
OpenCode integrations: secret-path and dangerous-command guards, post-edit
tests, gitleaks before commits, tmux/desktop notifications, shared skills, and
selective archive requests. For headless ChatGPT/Codex login, run `/login`,
select `ChatGPT Plus/Pro (Codex)`, then choose `Device code login (headless)`.
Open the displayed URL and enter the code. Pi stores and refreshes the resulting
credentials normally in `~/.pi/agent/auth.json`. Pi has no native managed-policy
layer equivalent to OpenCode's `/etc/opencode` config, so the container remains
the hard boundary; the extension supplies the strongest harness-level
enforcement Pi exposes.

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
  };
};
```

## What's in the image

| Group | Packages |
|---|---|
| Dev tools | git, neovim (pre-configured), tmux, htop, tree, ripgrep, fd, fzf, jq, yq-go, curl, wget, unzip, gnumake, pkg-config, gcc, nix |
| Languages | go, nodejs 22, bun, python 3.12, uv |
| **AI CLIs** | **codex**, **opencode**, **pi** (Claude Code is runtime-installed) |
| Language servers | gopls, nil, typescript-language-server, vscode-langservers-extracted |
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

`.github/workflows/build-image.yml` builds the image with Nix on every push and
PR, and on pushes to `main` / `v*` tags publishes it to GHCR
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
  bootScripts.my-agent = ''
    exec my-agent serve --port "$MY_AGENT_PORT"
  '';
};
```

The generic hooks keep additional agents out of this repository; everything
specific to an added agent lives in your own config.
