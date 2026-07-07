# agentbox

A self-contained AI coding-agent sandbox, packaged as a standalone Nix flake.
It ships a full dev toolchain in an OCI container and runs **Claude Code**,
**Codex**, and **OpenCode** inside it, isolated from the host.

- **`agentboxImage`** — a Nix-built OCI image (no Dockerfile, no Homebrew).
- **`agentbox`** — a host-side CLI to drive the container (`status`, `shell`,
  `logs`, `exec`, `start`/`stop`/`restart`).
- **`nixosModules.agentbox`** / **`darwinModules.agentbox`** — run it as a
  systemd `oci-containers` service (NixOS) or via manual management (macOS).

It depends on **nothing but `nixpkgs`**. No private inputs, no bundled
third-party agents — just the sandbox plus Claude Code and Codex.

## The agents

| Agent | How it gets into the box | Toggle (default) |
|---|---|---|
| **Codex** | bundled in the image from nixpkgs (`codex`) | `settings.enableCodex` (false) |
| **OpenCode** | bundled in the image from nixpkgs (`opencode`) | `settings.enableOpencode` (true) |
| **Claude Code** | installed at container start by Anthropic's native installer (self-updates) | `settings.enableClaudeCode` (false) + `claudeCodeVersion` |

All three are first-class: Codex and OpenCode are baked into the image from
nixpkgs; Claude Code is runtime-installed so its own updater keeps it current.
Each toggle sets the matching `ENABLE_*` env the entrypoint reads. Provide
credentials through the secret `environmentFile` (e.g. `OPENAI_API_KEY` for
Codex, `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code).

```nix
services.agentbox = {
  enable = true;
  environmentFile = config.sops.templates."agentbox.env".path;
  settings = {
    enableClaudeCode = true;
    enableCodex = true;
    enableOpencode = true; # on by default
  };
};
```

## What's in the image

| Group | Packages |
|---|---|
| Dev tools | git, neovim (pre-configured), tmux, htop, tree, ripgrep, fd, fzf, jq, yq-go, curl, wget, unzip, gnumake, pkg-config, gcc, nix |
| Languages | go, nodejs 22, bun, python 3.12, uv |
| **AI CLIs** | **codex**, **opencode** (Claude Code is runtime-installed) |
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

## Advanced: baking extra agents in

Beyond the three bundled agents, this standalone ships no others — and there is
no agent-specific code in the image. To add your own you have four generic
hooks, none of which require forking:

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

The image itself stays agent-agnostic; everything specific to your agent lives
in your own config.
