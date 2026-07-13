# nix-darwin module for Agentbox - AI Coding Agent Sandbox
# Manual container management for macOS (no auto-start via launchd)
#
# This module:
# - Sets up data directories and configuration files
# - Provides an `agentbox` CLI script for manual container management
# - Loads the Nix-built Docker image on activation
#
# Usage:
#   agentbox start   # Start the container
#   agentbox stop    # Stop the container
#   agentbox shell   # Open a shell in the container
#   agentbox status  # Show container status
#   agentbox logs    # View container logs
#
# Prerequisites:
# - A Docker-compatible runtime must be running: Docker Desktop, OrbStack, or Colima
# - Start the chosen runtime before invoking agentbox (e.g. `colima start`, launch OrbStack/Docker Desktop)
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.agentbox;

  # Effective permission sets: curated defaults + per-host extras. Kept here so
  # settings.json and managed-settings.json stay in lock-step.
  effectiveClaudePermissions =
    let
      p = cfg.settings.claudeConfig.permissions;
    in
    p
    // {
      allow = (p.allow or [ ]) ++ cfg.settings.claudeConfig.extraAllow;
      deny = (p.deny or [ ]) ++ cfg.settings.claudeConfig.extraDeny;
    };
  effectiveOpencodePermission = lib.recursiveUpdate cfg.settings.opencodeConfig.permission cfg.settings.opencodeConfig.extraPermission;

  codexFormat = pkgs.formats.toml { };
  codexConfigToml = codexFormat.generate "agentbox-codex-config.toml" (
    lib.recursiveUpdate cfg.settings.codexConfig.settings {
      notify = [
        "bash"
        "/home/agent/.local/bin/codex-notify.sh"
      ];
    }
  );
  codexRequirementsToml = codexFormat.generate "agentbox-codex-requirements.toml" cfg.settings.codexConfig.requirements;

  # Claude Code configuration.
  # ~/.claude.json holds mcpServers (and Claude's own runtime state). Hooks and
  # permissions are NOT read from this file — Claude Code reads those from
  # ~/.claude/settings.json (see settingsJson below). Putting them here is
  # silently ignored.
  claudeConfigJson = pkgs.writeText ".claude.json" (
    builtins.toJSON {
      mcpServers = cfg.settings.claudeConfig.mcpServers;
    }
  );

  # ~/.claude/settings.json — the file Claude Code actually reads hooks and
  # permissions from.
  settingsJson = pkgs.writeText "settings.json" (
    builtins.toJSON {
      "$schema" = "https://json.schemastore.org/claude-code-settings.json";
      hooks = cfg.settings.claudeConfig.hooks;
      permissions = effectiveClaudePermissions;
    }
  );

  # Enterprise "managed settings" — the SAME permissions + hooks, but written to
  # /etc/claude-code/managed-settings.json (root-owned, mounted read-only). This
  # layer outranks user and project settings and cannot be overridden:
  #   - a managed `deny` is authoritative — no user/project `allow` can re-enable
  #     it, so the agent cannot edit its own ~/.claude/settings.json to read the
  #     secret files or run sudo;
  #   - allowManagedHooksOnly makes the managed hooks the ONLY hooks that run, so
  #     the agent cannot drop the dangerous-command-blocker / secret-scanner by
  #     rewriting settings.json.
  # The user-level settings.json (above) stays in place as a graceful fallback
  # if this policy file is ever not honored.
  managedSettingsJson = pkgs.writeText "managed-settings.json" (
    builtins.toJSON {
      "$schema" = "https://json.schemastore.org/claude-code-settings.json";
      permissions = effectiveClaudePermissions;
      hooks = cfg.settings.claudeConfig.hooks;
      allowManagedHooksOnly = true;
    }
  );

  # OpenCode configuration. Generic settings are the base; typed module
  # options remain authoritative where both define the same key.
  opencodeConfigJson = pkgs.writeText "opencode.json" (
    builtins.toJSON (
      lib.recursiveUpdate cfg.settings.opencodeConfig.settings (
        {
          "$schema" = "https://opencode.ai/config.json";
          default_agent = cfg.settings.opencodeConfig.defaultAgent;
          plugin = cfg.settings.opencodeConfig.plugins;
          permission = effectiveOpencodePermission;
          agent = cfg.settings.opencodeConfig.agents;
          small_model = cfg.settings.opencodeConfig.smallModel;
        }
        // lib.optionalAttrs (cfg.settings.opencodeConfig.defaultModel != null) {
          model = cfg.settings.opencodeConfig.defaultModel;
        }
        // lib.optionalAttrs (cfg.settings.opencodeConfig.providers != { }) {
          provider = cfg.settings.opencodeConfig.providers;
        }
      )
    )
  );
  opencodeManagedConfigJson = pkgs.writeText "managed-opencode.json" (
    builtins.toJSON {
      "$schema" = "https://opencode.ai/config.json";
      permission = effectiveOpencodePermission;
    }
  );

  gitConfigFile = pkgs.writeText ".gitconfig" cfg.settings.gitConfig;
  tmuxConfigFile = pkgs.writeText ".tmux.conf" cfg.settings.tmuxConfig;

  sshKnownHostsFile = pkgs.writeText "known_hosts" cfg.settings.sshKnownHosts;
  awsConfigFile =
    if cfg.settings.awsConfig != "" then pkgs.writeText "aws-config" cfg.settings.awsConfig else null;
  sshPublicKeyFile =
    if cfg.settings.sshPublicKey != null then
      pkgs.writeText "id_ed25519.pub" (cfg.settings.sshPublicKey + "\n")
    else
      null;

  # Container environment variables (non-secret)
  containerEnvArgs = lib.concatStringsSep " " (
    lib.mapAttrsToList (k: v: "-e ${k}=\"${v}\"") (
      {
        DISPLAY = ":10";
        TERM = "xterm-256color";
        GOPRIVATE = cfg.settings.goprivate;
        # Resolved by the host shell at `agentbox start` time so the
        # in-container `agent` user matches the macOS user that owns
        # ${"\${cfg.dataDir}"}. OrbStack hides the mismatch via automatic
        # UID remapping on bind mounts, but Docker Desktop (VirtioFS) and
        # Colima do not — without this, agent (UID 1000) cannot read the
        # 0600 SSH key or write the bind-mounted opencode/.config dirs.
        PUID = "$(id -u)";
        PGID = "$(id -g)";
        TZ = cfg.settings.timezone;
        # OpenCode services
        ENABLE_OPENCODE = lib.boolToString cfg.settings.enableOpencode;
        ENABLE_CHAT_BRIDGE = "false";
        # Claude Code services
        ENABLE_CLAUDE_CODE = lib.boolToString cfg.settings.enableClaudeCode;
        ENABLE_CODEX = lib.boolToString cfg.settings.enableCodex;
        # In-container sudo (setuid wrapper staged at boot) + nix daemon.
        # The image itself must be built on a Linux host with the matching
        # `withNix` flag; these only gate the runtime behaviour.
        ENABLE_SUDO = lib.boolToString cfg.settings.hardening.enableSudo;
        ENABLE_NIX = lib.boolToString cfg.settings.enableNix;
        # OpenCode server settings
        OPENCODE_BIND_ADDRESS = "0.0.0.0";
        OPENCODE_SERVER_URL = "http://127.0.0.1:4096";
        # Session settings
        SESSION_WORKING_DIRECTORY = cfg.settings.sessionWorkingDirectory;
        # Claude Code version to install
        CLAUDE_CODE_VERSION = cfg.settings.claudeCodeVersion;
        CLAUDE_CWD = "/workspace";
        CLAUDE_PROVIDER_MAX_TURNS = "500";
      }
      # Env contributed via the generic extension surface
      # (services.agentbox.extraEnvironment) — used by any add-on module.
      // cfg.extraEnvironment
      # Point Application Default Credentials at the bind-mounted service-account
      # key (path is not secret; the file is mounted read-only). Enables gcloud
      # client libraries and the GKE auth plugin.
      // lib.optionalAttrs (cfg.settings.gcpServiceAccountKeyPath != null) {
        GOOGLE_APPLICATION_CREDENTIALS = "/home/agent/.config/gcloud/sa-key.json";
        CLOUDSDK_CORE_PROJECT = cfg.settings.gcpProject;
      }
      # Point the in-container docker CLI at the restricted socket proxy (the
      # raw daemon socket is never mounted into agentbox). Read-only routes
      # only — container create/exec are rejected by the proxy allowlist.
      // lib.optionalAttrs cfg.settings.dockerProxy.enable {
        DOCKER_HOST = "tcp://127.0.0.1:2375";
      }
    )
  );

  # Volume mount arguments
  volumeArgs = lib.concatStringsSep " " (
    [
      "-v ${cfg.dataDir}/home/.gitconfig:/home/agent/.gitconfig"
      "-v ${cfg.dataDir}/home/.tmux.conf:/home/agent/.tmux.conf"
      "-v ${cfg.dataDir}/home/.ssh:/home/agent/.ssh"
      "-v ${cfg.dataDir}/home/.claude.json:/home/agent/.claude.json"
      "-v ${cfg.dataDir}/home/.claude:/home/agent/.claude"
      "-v ${cfg.dataDir}/home/.codex:/home/agent/.codex"
      # Enterprise policy file, READ-ONLY: pins the permission deny list and the
      # safety hooks above the agent-writable settings.json (see managedSettingsJson).
      # Written root-owned 0644 on activation so Claude Code honors it as policy.
      "-v ${cfg.dataDir}/managed/managed-settings.json:/etc/claude-code/managed-settings.json:ro"
      # Codex managed requirements enforce the reviewer and secret-path policy.
      "-v ${cfg.dataDir}/managed/codex-requirements.toml:/etc/codex/requirements.toml:ro"
      "-v ${cfg.dataDir}/managed/opencode.json:/etc/opencode/opencode.json:ro"
      "-v ${cfg.dataDir}/home/.config/opencode:/home/agent/.config/opencode"
      "-v ${cfg.dataDir}/home/.local/share/opencode:/home/agent/.local/share/opencode"
      "-v ${cfg.dataDir}/workspaces/opencode:/workspace"
      "-v ${cfg.dataDir}/hooks:/home/agent/.hooks:ro"
      # Notification signals: hooks write here; macOS LaunchAgent reads and
      # calls osascript to show notification center alerts.
      "-v ${cfg.dataDir}/signals:/home/agent/.signals"
    ]
    # Volumes contributed by optional integration add-ons (each "src:dst" is
    # prefixed with -v here).
    ++ map (v: "-v ${v}") cfg.extraVolumes
    # Cloud credentials: mount only the individual secret files read-only, so
    # the CLIs' own writable state (~/.config/gcloud, ~/.kube/cache) is untouched.
    ++ lib.optional (
      cfg.settings.awsCredentialsPath != null
    ) "-v ${cfg.dataDir}/home/.aws/credentials:/home/agent/.aws/credentials:ro"
    ++ lib.optional (
      cfg.settings.awsConfig != ""
    ) "-v ${cfg.dataDir}/home/.aws/config:/home/agent/.aws/config:ro"
    ++ lib.optional (
      cfg.settings.gcpServiceAccountKeyPath != null
    ) "-v ${cfg.dataDir}/home/.config/gcloud/sa-key.json:/home/agent/.config/gcloud/sa-key.json:ro"
    ++ lib.optional (
      cfg.settings.kubeConfigPath != null
    ) "-v ${cfg.dataDir}/home/.kube/config:/home/agent/.kube/config:ro"
    # Overlay the SSH PRIVATE KEY read-only on top of the writable ~/.ssh mount.
    # The dir stays writable (ssh appends to known_hosts), but the key file itself
    # becomes a read-only mountpoint: the agent can use it for git but cannot
    # overwrite or `rm` it (an active mountpoint can't be unlinked) — closing the
    # "delete the host key via the bind mount" hole. Reading the key for exfil is
    # NOT prevented here; that is governed by the credential-scoping guidance and
    # the (best-effort) deny list.
    ++ lib.optional (
      cfg.settings.sshPrivateKeyPath != null
    ) "-v ${cfg.dataDir}/home/.ssh/id_ed25519:/home/agent/.ssh/id_ed25519:ro"
  );

  # H2: container hardening flags. Defaults reduce kernel attack surface (the
  # container→host escape boundary) WITHOUT locking down inside the box — this
  # sandbox intentionally allows in-container sudo / tool installs.
  securityOptArgs = lib.concatStringsSep " " (
    # "default" => omit the flag so Docker applies its built-in default seccomp
    # profile (blocks the ~44 most dangerous syscalls). Only emit --security-opt
    # when a non-default profile is requested.
    lib.optional (
      cfg.settings.hardening.seccompProfile != "default"
    ) "--security-opt seccomp=${cfg.settings.hardening.seccompProfile}"
    ++ lib.optional cfg.settings.hardening.noNewPrivileges "--security-opt no-new-privileges"
  );

  # Click-to-jump handler — runs ONLY when you click an Agentbox notification
  # (terminal-notifier -execute). $1 is the "session:window" tmux target the hook
  # recorded. It points the attached tmux client at that window, then raises the
  # single Alacritty macOS tab whose title we pinned with set-titles. Nothing here
  # runs when the banner merely appears.
  jumpScript = pkgs.writeShellScript "agentbox-jump" ''
    export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/run/current-system/sw/bin:$PATH"
    target="$1"
    [ -n "$target" ] && docker exec -u agent agentbox tmux select-window -t "$target" 2>/dev/null || true
    # Raise the macOS tab whose Alacritty title starts with the set-titles prefix.
    # Needs Accessibility permission for the process running this (granted once in
    # System Settings › Privacy & Security › Accessibility).
    /usr/bin/osascript <<'OSA' 2>/dev/null || true
    tell application "System Events"
      tell process "Alacritty"
        set frontmost to true
        repeat with w in windows
          if name of w starts with "agentbox ❯" then
            perform action "AXRaise" of w
            exit repeat
          end if
        end repeat
      end tell
    end tell
    OSA
  '';

  # macOS notification script — runs on the host (via LaunchAgent) when notify.sh
  # or claude-waiting.sh drops a file in ${cfg.dataDir}/signals/. The signal is
  # "message<TAB>session:window"; terminal-notifier shows the banner and only on
  # click does -execute run jumpScript with that target. terminal-notifier is the
  # Intel prebuilt run under Rosetta — chosen deliberately over a native osacompile
  # applet, which on this host never registers with Notification Center and so
  # never shows a banner.
  notifyHostScript = pkgs.writeShellScript "agentbox-notify-host" ''
    signal="${cfg.dataDir}/signals/claude-notify"
    [ -f "$signal" ] || exit 0
    raw=$(cat "$signal" 2>/dev/null | head -c 300)
    rm -f "$signal"
    IFS=$'\t' read -r msg target <<< "$raw"
    # The signal file is written from inside the container, so treat both fields
    # as untrusted. `target` is interpolated into terminal-notifier's -execute
    # shell string, which runs on the host (as this user) when the banner is
    # clicked — a single quote in it would break out of the quoting and execute
    # arbitrary code. Drop anything that is not a literal tmux "session:window"
    # token, and strip control chars from the (argv-safe) message for hygiene.
    case "$target" in
      ""|*[!A-Za-z0-9_:.-]*) target="" ;;
    esac
    msg=$(printf '%s' "$msg" | tr -d '\000-\037')
    : "''${msg:=Agentbox notification}"
    ${pkgs.terminal-notifier}/bin/terminal-notifier \
      -title "Agentbox" \
      -message "$msg" \
      -sound Glass \
      -execute "${jumpScript} '$target'"
  '';

  # Agentbox CLI script for manual management
  agentboxScript = pkgs.writeShellScriptBin "agentbox" ''
    #!/bin/bash
    set -euo pipefail

    CONTAINER_NAME="agentbox"
    IMAGE_NAME="agentbox:latest"
    DATA_DIR="${cfg.dataDir}"
    ENV_FILE="${if cfg.environmentFile != null then cfg.environmentFile else ""}"

    # Restricted Docker socket proxy (read-only routes only). Holds the only
    # mount of the runtime VM's docker socket and re-serves a default-deny TCP
    # endpoint on 127.0.0.1:2375; agentbox reaches it via DOCKER_HOST.
    PROXY_ENABLED="${lib.boolToString cfg.settings.dockerProxy.enable}"
    PROXY_NAME="agentbox-docker-proxy"
    PROXY_IMAGE="${cfg.settings.dockerProxy.image}"

    # Detect which Docker-compatible runtime is serving the active context.
    # Echoes one of: "Docker Desktop", "Colima", "OrbStack", "Unknown".
    detect_runtime() {
      local ctx os
      ctx="$(docker context show 2>/dev/null || echo)"
      case "$ctx" in
        desktop-linux|desktop) echo "Docker Desktop"; return ;;
        colima*)               echo "Colima"; return ;;
        orbstack)              echo "OrbStack"; return ;;
      esac
      os="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || echo)"
      case "$os" in
        *OrbStack*)        echo "OrbStack" ;;
        *Docker\ Desktop*) echo "Docker Desktop" ;;
        *Alpine*)          echo "Colima" ;;
        *)                 echo "Unknown" ;;
      esac
    }

    # Check if Docker is available
    check_docker() {
      if ! command -v docker &> /dev/null; then
        echo "Error: Docker is not installed or not in PATH"
        exit 1
      fi
      if ! docker info &> /dev/null; then
        echo "Error: Docker daemon is not running"
        echo "Please start one of: Docker Desktop, OrbStack, or 'colima start'"
        exit 1
      fi
      echo "Using runtime: $(detect_runtime)"
    }

    # Start the restricted socket proxy sidecar (no-op unless enabled). The
    # raw socket is mounted ONLY here, never into agentbox. wollomatic flags:
    # default-deny, so only the allow{GET,HEAD} routes are reachable and all
    # writes (container create/exec/build) are rejected.
    start_proxy() {
      [ "$PROXY_ENABLED" = "true" ] || return 0
      if docker ps --format '{{.Names}}' | grep -q "^$PROXY_NAME$"; then
        return 0
      fi
      if docker ps -a --format '{{.Names}}' | grep -q "^$PROXY_NAME$"; then
        docker rm "$PROXY_NAME" >/dev/null
      fi
      echo "Starting docker socket proxy ($PROXY_NAME, read-only routes only)..."
      PROXY_ARGS=(
        run -d
        --name "$PROXY_NAME"
        --network=host
        --read-only
        --security-opt no-new-privileges
        --user ${cfg.settings.dockerProxy.user}
        --restart unless-stopped
        -v ${cfg.settings.dockerProxy.socketPath}:/var/run/docker.sock:ro
        "$PROXY_IMAGE"
        -loglevel=info
        -listenip=127.0.0.1
        -allowfrom=${cfg.settings.dockerProxy.allowFrom}
        -allowGET=${lib.escapeShellArg cfg.settings.dockerProxy.allowGET}
        -allowHEAD=${lib.escapeShellArg cfg.settings.dockerProxy.allowHEAD}
        ${lib.concatMapStringsSep "\n        " lib.escapeShellArg cfg.settings.dockerProxy.extraArgs}
      )
      docker "''${PROXY_ARGS[@]}"
    }

    stop_proxy() {
      [ "$PROXY_ENABLED" = "true" ] || return 0
      if docker ps --format '{{.Names}}' | grep -q "^$PROXY_NAME$"; then
        echo "Stopping docker socket proxy..."
        docker stop "$PROXY_NAME" >/dev/null
        docker rm "$PROXY_NAME" >/dev/null
      fi
    }

    cmd_start() {
      check_docker

      # Bring up the socket proxy first so DOCKER_HOST is reachable from the box.
      start_proxy

      # Check if already running
      if docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
        echo "Agentbox is already running"
        docker ps --filter "name=$CONTAINER_NAME"
        return 0
      fi

      # Remove stopped container if exists
      if docker ps -a --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
        echo "Removing stopped container..."
        docker rm "$CONTAINER_NAME"
      fi

      echo "Starting agentbox container..."

      # Build docker run command as an array so the healthcheck
      # command (which contains $OPENCODE_PASSWORD) survives quoting
      # and is expanded inside the container, not on the host.
      DOCKER_ARGS=(
        run -d
        --name "$CONTAINER_NAME"
        --network=host
        ${securityOptArgs}
        --cpus=${toString cfg.settings.cpuLimits}
        --memory=${cfg.settings.memoryLimits}
        --pids-limit=${toString cfg.settings.pidsLimit}
        ${containerEnvArgs}
        ${volumeArgs}
        --health-cmd 'curl -fsS -u "opencode:$OPENCODE_PASSWORD" http://127.0.0.1:4096/global/health || exit 1'
        --health-interval=30s
        --health-timeout=5s
        --health-retries=3
        --health-start-period=60s
        --restart unless-stopped
      )

      # Add env file if specified
      if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
        DOCKER_ARGS+=(--env-file "$ENV_FILE")
      fi

      DOCKER_ARGS+=("$IMAGE_NAME")

      docker "''${DOCKER_ARGS[@]}"

      echo ""
      echo "Agentbox started!"
      echo "  OpenCode: http://localhost:4096"
      echo ""
      echo "Use 'agentbox shell' to access the container"
    }

    cmd_stop() {
      check_docker
      if docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
        echo "Stopping agentbox..."
        docker stop "$CONTAINER_NAME"
        docker rm "$CONTAINER_NAME"
        echo "Agentbox stopped"
      else
        echo "Agentbox is not running"
      fi
      stop_proxy
    }

    cmd_restart() {
      cmd_stop
      cmd_start
    }

    cmd_status() {
      check_docker
      if docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
        echo "Agentbox is running"
        docker ps --filter "name=$CONTAINER_NAME"
      else
        echo "Agentbox is not running"
      fi
      if [ "$PROXY_ENABLED" = "true" ]; then
        if docker ps --format '{{.Names}}' | grep -q "^$PROXY_NAME$"; then
          echo "Docker socket proxy is running (read-only routes)"
          docker ps --filter "name=$PROXY_NAME"
        else
          echo "Docker socket proxy is enabled but not running"
        fi
      fi
    }

    cmd_logs() {
      check_docker
      docker logs -f "$CONTAINER_NAME" "''${@}"
    }

    cmd_shell() {
      check_docker
      if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
        echo "Agentbox is not running. Starting it first..."
        cmd_start
        sleep 2
      fi
      docker exec -it -u agent -w /workspace "$CONTAINER_NAME" bash -lc 'tmux new-session -A -s main'
    }

    cmd_load_image() {
      check_docker
      echo "Loading agentbox image from Nix store..."
      if [ -f "${cfg.image}" ]; then
        docker load < "${cfg.image}"
        echo "Image loaded successfully"
      else
        echo "Error: Image not found at ${cfg.image}"
        exit 1
      fi
    }

    cmd_setup() {
      echo "Setting up agentbox directories..."

    # Create directories
      mkdir -p "$DATA_DIR/home/.ssh"
      mkdir -p "$DATA_DIR/home/.claude"
      mkdir -p "$DATA_DIR/home/.codex/skills"
      mkdir -p "$DATA_DIR/home/.config/opencode/plugins"
      mkdir -p "$DATA_DIR/home/.local/share/opencode"
      mkdir -p "$DATA_DIR/workspaces/opencode"
      mkdir -p "$DATA_DIR/hooks"
      mkdir -p "$DATA_DIR/signals"

      # Set SSH directory permissions
      chmod 700 "$DATA_DIR/home/.ssh"

      echo "Setup complete!"
      echo "  Data directory: $DATA_DIR"
      echo ""
      echo "Next steps:"
      echo "  1. Ensure a Docker runtime is running (Docker Desktop, OrbStack, or 'colima start')"
      echo "  2. Load the image: agentbox load-image"
      echo "  3. Start the container: agentbox start"
    }

    usage() {
      cat <<EOF
    Agentbox - AI Coding Agent Sandbox (macOS)

    Usage: agentbox <command> [options]

    Commands:
      start       Start agentbox container
      stop        Stop agentbox container
      restart     Restart agentbox container
      status      Show container status
      logs        Show container logs (follow mode)
      shell       Open a shell in the container
      load-image  Load the Nix-built Docker image
      setup       Initialize directories and configuration

    Prerequisites:
      - A Docker-compatible runtime must be running (Docker Desktop, OrbStack, or Colima)
      - Start one of them before running agentbox (e.g. 'colima start', launch OrbStack/Docker Desktop)

    Data directory: $DATA_DIR
    EOF
    }

    case "''${1:-help}" in
      start)      cmd_start ;;
      stop)       cmd_stop ;;
      restart)    cmd_restart ;;
      status)     cmd_status ;;
      logs)       shift; cmd_logs "$@" ;;
      shell)      cmd_shell ;;
      load-image) cmd_load_image ;;
      setup)      cmd_setup ;;
      help|--help|-h) usage ;;
      *) echo "Unknown command: $1"; usage; exit 1 ;;
    esac
  '';

in
{
  imports = [ ./common-options.nix ];

  options.services.agentbox = {
    enable = lib.mkEnableOption "Agentbox AI Coding Agent Sandbox (manual management)";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = ''
        The agentbox package to use (for hooks and plugins).
        On Darwin, this should be null as agentbox CLI is Linux-only.
        Hooks and plugins will be copied from hooksDir if specified.
      '';
    };

    image = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path to the Nix-built agentbox Docker image.
        Build on a Linux system with: nix build .#agentboxImage
        Then copy the result to this path.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/Users/${config.system.primaryUser}/.agentbox";
      description = "Directory for storing agentbox data and configuration.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to an environment file containing secrets.

        Required variables:
          AGENT_PASSWORD - Password for SSH/container access

        Optional: agent credentials (e.g. CLAUDE_CODE_OAUTH_TOKEN,
        OPENAI_API_KEY) and any env your extra packages need.
      '';
    };

    hooksDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a directory containing hook scripts for Claude Code.
        If not specified, default hooks from the agentbox package are used.
      '';
    };

    # All sandbox settings (incl. hardening + enableNotification) live in
    # ./common-options.nix (shared with nixos).
  };

  config = lib.mkIf cfg.enable {
    # Add agentbox CLI to system packages
    environment.systemPackages = [
      agentboxScript
      pkgs.docker-client
    ];

    # User LaunchAgent: polls for signal files written by in-container hooks
    # and pops macOS notification center alerts via osascript.
    #
    # We POLL (StartInterval) rather than use WatchPaths. WatchPaths is backed by
    # a kqueue EVFILT_VNODE watch that launchd binds to the watched path's vnode
    # at agent-load time. The signal file lives inside a Docker bind mount
    # (${cfg.dataDir}/signals → /home/agent/.signals), which on macOS is served
    # through the runtime VM's file-sharing layer (VirtioFS / gRPC-FUSE). Two
    # problems make WatchPaths unreliable here:
    #   1. `agentbox restart` tears down and recreates that share, so the vnode
    #      launchd latched onto goes stale and the watch never fires again until
    #      the agent is reloaded (which is why a `darwin-rebuild switch` was
    #      needed after every container restart).
    #   2. Writes made from inside the container don't reliably raise host kqueue
    #      vnode events anyway — only reads/stat are dependable through the share.
    # Polling re-opens the path on every tick, so it is immune to the vnode being
    # invalidated by a container restart. Cost is a cheap wakeup every 2s and up
    # to ~2s of notification latency.
    launchd.user.agents."com.agentbox.notify" = lib.mkIf cfg.settings.enableNotification {
      serviceConfig = {
        Label = "com.agentbox.notify";
        ProgramArguments = [
          "/bin/bash"
          "${notifyHostScript}"
        ];
        StartInterval = 2;
        RunAtLoad = true;
        StandardErrorPath = "/tmp/agentbox-notify.err";
      };
    };

    # Setup directories and config on activation
    system.activationScripts.postActivation.text = ''
            echo "Setting up agentbox directories..."

            # Create directories
            mkdir -p "${cfg.dataDir}/home/.ssh"
            mkdir -p "${cfg.dataDir}/home/.claude"
            mkdir -p "${cfg.dataDir}/home/.codex/skills"
            mkdir -p "${cfg.dataDir}/home/.config/opencode/plugins"
            mkdir -p "${cfg.dataDir}/home/.local/share/opencode"
            mkdir -p "${cfg.dataDir}/workspaces/opencode"
            mkdir -p "${cfg.dataDir}/hooks"
            mkdir -p "${cfg.dataDir}/signals"
            mkdir -p "${cfg.dataDir}/managed"

            # Activation contributed via the generic extension surface
            # (services.agentbox.extraActivation).
            ${cfg.extraActivation}

            # Clean up the abandoned osacompile-applet notifier (it never registered
            # with Notification Center on this host, so no banner ever showed). Click
            # notifications are handled by terminal-notifier + jumpScript instead.
            rm -rf "${cfg.dataDir}/AgentboxNotify.app" \
                   "${cfg.dataDir}/AgentboxNotify.applescript" \
                   "${cfg.dataDir}/agentbox-jump.sh" \
                   "${cfg.dataDir}/notify-mode" \
                   "${cfg.dataDir}/notify-msg" \
                   "${cfg.dataDir}/jump-target" 2>/dev/null || true

            # Set SSH directory permissions
            chmod 700 "${cfg.dataDir}/home/.ssh"

            # Codex's user config is shared with CLI-persisted state. Merge
            # Nix-owned settings over it while preserving unknown keys.
            _nix_codex="${codexConfigToml}"
            _live_codex="${cfg.dataDir}/home/.codex/config.toml"
            _merged_codex=""
            if [ -f "$_live_codex" ]; then
              _merged_codex="$(${pkgs.yq-go}/bin/yq eval-all \
                --input-format=toml --output-format=toml \
                '. as $item ireduce ({}; . * $item)' \
                "$_live_codex" "$_nix_codex" 2>/dev/null)"
            fi
            [ -n "$_merged_codex" ] || _merged_codex="$(cat "$_nix_codex")"
            if [ ! -f "$_live_codex" ] || [ "$(cat "$_live_codex" 2>/dev/null)" != "$_merged_codex" ]; then
              _codex_tmp="$_live_codex.tmp"
              printf '%s\n' "$_merged_codex" > "$_codex_tmp"
              mv -f "$_codex_tmp" "$_live_codex"
              chmod 644 "$_live_codex"
            fi

            # Preserve OpenCode-owned/global keys while reasserting all
            # declarative settings and permission denies.
            _nix_opencode="${opencodeConfigJson}"
            _live_opencode="${cfg.dataDir}/home/.config/opencode/opencode.json"
            _merged_opencode=""
            if [ -f "$_live_opencode" ]; then
              _merged_opencode="$(${pkgs.jq}/bin/jq -s '.[0] * .[1]' \
                "$_live_opencode" "$_nix_opencode" 2>/dev/null)"
            fi
            [ -n "$_merged_opencode" ] || _merged_opencode="$(cat "$_nix_opencode")"
            if [ ! -f "$_live_opencode" ] || [ "$(cat "$_live_opencode" 2>/dev/null)" != "$_merged_opencode" ]; then
              _opencode_tmp="$_live_opencode.tmp"
              printf '%s\n' "$_merged_opencode" > "$_opencode_tmp"
              mv -f "$_opencode_tmp" "$_live_opencode"
              chmod 644 "$_live_opencode"
            fi

            # Merge Claude Code configuration (MCP servers) into ~/.claude.json only
            # when the Nix config changed. The store path is content-addressed, so it
            # only differs when mcpServers actually changed — no extra hashing needed.
            _nix_claude_cfg="${claudeConfigJson}"
            _marker_claude="${cfg.dataDir}/home/.claude.json.nix-store-path"
            if [ ! -f "$_marker_claude" ] || [ "$(cat "$_marker_claude" 2>/dev/null)" != "$_nix_claude_cfg" ]; then
              if [ -f "${cfg.dataDir}/home/.claude.json" ]; then
                _merged="$(${pkgs.jq}/bin/jq -s \
                  '.[0] + {mcpServers: .[1].mcpServers}' \
                  "${cfg.dataDir}/home/.claude.json" \
                  "$_nix_claude_cfg" 2>/dev/null)" \
                && printf '%s\n' "$_merged" > "${cfg.dataDir}/home/.claude.json" \
                || true
              else
                cp -f "$_nix_claude_cfg" "${cfg.dataDir}/home/.claude.json"
              fi
              chmod 644 "${cfg.dataDir}/home/.claude.json"
              printf '%s' "$_nix_claude_cfg" > "$_marker_claude"
            fi

            # Re-assert the Nix-owned keys ($schema, hooks, permissions) into
            # ~/.claude/settings.json by MERGING them over whatever is on disk, rather
            # than a marker-gated full overwrite.
            #
            # Why merge instead of overwrite-when-changed: settings.json is a SHARED
            # file. Claude Code writes its own runtime state there (e.g. `model`, and
            # `permissions.defaultMode` when you switch permission mode) and, when it
            # rewrites the file, it does NOT preserve our `hooks` block — so the tmux
            # title hooks and the secret-file deny list silently vanish mid-session.
            # The previous logic only rewrote when the *Nix* store path changed, so it
            # never noticed Claude had clobbered the file: a plain `darwin-rebuild
            # switch` was a no-op and the hooks stayed gone. Merging on the live file
            # (and writing only when the result actually differs) self-heals that on
            # every activation while preserving Claude's own keys like `model`.
            _nix_settings="${settingsJson}"
            _live_settings="${cfg.dataDir}/home/.claude/settings.json"
            _merged_settings=""
            if [ -f "$_live_settings" ]; then
              _merged_settings="$(${pkgs.jq}/bin/jq -s \
                '.[0] + {"$schema": .[1]["$schema"], hooks: .[1].hooks, permissions: .[1].permissions}' \
                "$_live_settings" "$_nix_settings" 2>/dev/null)"
            fi
            # Fall back to the raw Nix file when there is no live file yet or the merge
            # failed (e.g. Claude wrote invalid JSON).
            [ -n "$_merged_settings" ] || _merged_settings="$(cat "$_nix_settings")"
            # Write only when the on-disk content differs, to avoid signaling Claude
            # Code to reload settings on every activation.
            if [ ! -f "$_live_settings" ] || [ "$(cat "$_live_settings" 2>/dev/null)" != "$_merged_settings" ]; then
              printf '%s\n' "$_merged_settings" > "$_live_settings"
              chmod 644 "$_live_settings"
            fi

            # Write the enterprise "managed settings" policy file. It is bind-mounted
            # read-only into the container at /etc/claude-code/managed-settings.json and
            # outranks the agent-writable settings.json (authoritative deny + managed
            # hooks). Ownership is forced to root at the very end of this script (after
            # the recursive chown below) — Claude Code only honors managed settings that
            # are not user-writable.
            mkdir -p "${cfg.dataDir}/managed"
            cp -f "${managedSettingsJson}" "${cfg.dataDir}/managed/managed-settings.json"
            chmod 644 "${cfg.dataDir}/managed/managed-settings.json"

            # Codex requirements are the managed equivalent of Claude settings.
            cp -f "${codexRequirementsToml}" "${cfg.dataDir}/managed/codex-requirements.toml"
            chmod 644 "${cfg.dataDir}/managed/codex-requirements.toml"

            # OpenCode loads /etc/opencode after user and project config.
            cp -f "${opencodeManagedConfigJson}" "${cfg.dataDir}/managed/opencode.json"
            chmod 644 "${cfg.dataDir}/managed/opencode.json"

            # Copy hooks from hooksDir if specified
            ${
              if cfg.hooksDir != null then
                ''
                  cp -f ${cfg.hooksDir}/*.sh "${cfg.dataDir}/hooks/" 2>/dev/null || true
                ''
              else if cfg.package != null then
                ''
                  # Copy default hooks from agentbox package
                  if [ -d "${cfg.package}/share/agentbox/hooks" ]; then
                    cp -f ${cfg.package}/share/agentbox/hooks/*.sh "${cfg.dataDir}/hooks/" 2>/dev/null || true
                  fi
                ''
              else
                ''
                  echo "Note: No hooks configured (set services.agentbox.hooksDir to provide custom hooks)"
                ''
            }
            chmod +x "${cfg.dataDir}/hooks/"*.sh 2>/dev/null || true

            # Write notify.sh — Stop hook. A thin wrapper: it keeps the
            # background-tasks guard (a turn that only paused on backgrounded work
            # is not "done") and then delegates to the shared agent-signal.sh
            # producer, which does the tmux freeze/rename + desktop-notification
            # signal shared with OpenCode and Codex.
            cat > "${cfg.dataDir}/hooks/notify.sh" <<'NOTIFY_EOF'
      #!/bin/bash
      # Stop hook — delegate to the shared agent-signal.sh producer. The turn may have
      # only paused on backgrounded work (.background_tasks non-empty in the payload),
      # which is not "done"; skip the signal in that case.
      hook_input="$(cat)"
      _bg=0
      if command -v jq >/dev/null 2>&1; then
          _bg=$(printf '%s' "$hook_input" | jq '(.background_tasks // []) | length' 2>/dev/null)
      fi
      [ -n "$_bg" ] || _bg=0
      case "$_bg" in *[!0-9]*) _bg=0 ;; esac
      [ "$_bg" -gt 0 ] && exit 0
      export AGENT_NAME="Claude"
      exec bash /home/agent/.local/bin/agent-signal.sh done
      NOTIFY_EOF
            chmod +x "${cfg.dataDir}/hooks/notify.sh"

            # Write claude-waiting.sh — Notification hook: fires when Claude needs the
            # human — a tool-approval prompt or an AskUserQuestion (elicitation) dialog.
            # It freezes the window and renames it to flag that this session is blocked
            # on you, the same freeze trick notify.sh uses. claude-working.sh
            # (UserPromptSubmit) clears it on your next prompt. notification_type is
            # filtered so noise (idle_prompt, auth_success, etc.) leaves the window
            # name alone.
            cat > "${cfg.dataDir}/hooks/claude-waiting.sh" <<'WAITING_EOF'
      #!/bin/bash
      # Notification hook — only events that genuinely need the human flip the window;
      # idle_prompt / auth_success / elicitation lifecycle noise is ignored.
      input="$(cat)"
      case "$input" in
          *permission_prompt*|*elicitation_dialog*) ;;
          *) exit 0 ;;
      esac
      export AGENT_NAME="Claude"
      exec bash /home/agent/.local/bin/agent-signal.sh waiting
      WAITING_EOF
            chmod +x "${cfg.dataDir}/hooks/claude-waiting.sh"

            # Write claude-working.sh — PostToolUse hook: re-enable live title tracking
            # after a permission prompt is approved (there is no UserPromptSubmit in
            # that flow). Exits early if notify.sh (Stop) has already fired this turn
            # so that a stray PostToolUse cannot wipe the "✅ done" window name.
            cat > "${cfg.dataDir}/hooks/claude-working.sh" <<'WORKING_EOF'
      #!/bin/bash
      # PostToolUse hook — re-enable live title tracking after Claude resumes (e.g. an
      # approved permission prompt). agent-signal.sh no-ops if Stop already marked the
      # turn done, so a stray PostToolUse cannot wipe the "done" name.
      exec bash /home/agent/.local/bin/agent-signal.sh working
      WORKING_EOF
            chmod +x "${cfg.dataDir}/hooks/claude-working.sh"

            # Write claude-prompt-start.sh — UserPromptSubmit hook: clear the done flag
            # from notify.sh (Stop) so the window is unfrozen, then re-enable live title
            # tracking while Claude works on the new prompt.
            cat > "${cfg.dataDir}/hooks/claude-prompt-start.sh" <<'PROMPT_EOF'
      #!/bin/bash
      # UserPromptSubmit hook — clear the done/waiting flags and resume live title
      # tracking for the new turn.
      exec bash /home/agent/.local/bin/agent-signal.sh start
      PROMPT_EOF
            chmod +x "${cfg.dataDir}/hooks/claude-prompt-start.sh"

            # Write dangerous-command-blocker.sh — PreToolUse:Bash hook.
            # Reads the Claude Code hook JSON from stdin, extracts the bash command,
            # and exits 2 (blocking) if it matches a known destructive pattern.
            # Non-dangerous commands fall through with exit 0.
            cat > "${cfg.dataDir}/hooks/dangerous-command-blocker.sh" <<'BLOCKER_EOF'
      #!/usr/bin/env bash
      set -u
      payload="$(cat)"

      # Extract the bash command. If jq is missing or yields nothing, FAIL CLOSED by
      # scanning the raw payload instead of silently exiting 0 — a missing jq must not
      # disable the blocker. (These pattern guards are best-effort: a determined agent
      # can still obfuscate via variables/eval/base64. Protected-branch rules in
      # particular should ALSO be enforced server-side.)
      cmd=""
      if command -v jq >/dev/null 2>&1; then
        cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
      fi
      [ -z "$cmd" ] && cmd="$payload"

      # Normalize whitespace (tabs/newlines -> space, collapse runs) so "rm  -rf   /"
      # and similar spacing tricks cannot slip past the substring checks.
      ncmd="$(printf '%s' "$cmd" | tr '\t\n' '  ' | tr -s ' ')"

      block() {
        printf 'BLOCKED: %s\n' "$1" >&2
        exit 2
      }

      case "$ncmd" in
        # Note: deleting the actual root (`rm -rf /`, `rm -rf /*`) is handled by the
        # precise regex below so that legitimate `rm -rf /workspace/...` is not caught
        # by a naive "rm -rf /" substring.
        *"rm -rf ~"*)        block "Attempting to delete home directory" ;;
        *"rm -rf \$HOME"*)   block "Attempting to delete home directory" ;;
        *"> /dev/sda"*)      block "Attempting to overwrite disk" ;;
        *"mkfs"*)            block "Attempting to format filesystem" ;;
        *"chmod -R 777 /"*)  block "Setting dangerous permissions on root" ;;
        *":(){:|:&};:"*)     block "Fork bomb detected" ;;
        *"mv /* /dev/null"*) block "Moving everything to null" ;;
        *"unset PATH"*)      block "Unsetting PATH" ;;
        *"--privileged"*)    block "Privileged container flag" ;;
        *"--cap-add=ALL"*)   block "Adding all capabilities" ;;
        *"-v /:/")           block "Mounting root filesystem" ;;
      esac

      # Recursive delete with combined -r and -f flags in any order/spelling
      # (rm -rf, rm -fr, rm -Rf, rm --recursive --force) aimed at the filesystem root,
      # the home dir, or a mounted credential directory.
      if printf '%s' "$ncmd" \
         | grep -qE 'rm +(-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|--recursive|--force) +.*(/ *$|/\*|~|\$HOME|\.ssh|\.aws|\.config/gcloud|\.kube)'; then
        block "Recursive delete of root / home / credential directory"
      fi

      # Force-push to a protected branch: covers --force, --force-with-lease, the -f
      # short flag, and the +ref refspec, targeting main/master/develop/release in
      # either "origin main" or "HEAD:main"/"+main" form.
      if printf '%s' "$ncmd" | grep -qE 'git +push' \
         && printf '%s' "$ncmd" | grep -qE '(--force|--force-with-lease| -[a-zA-Z]*f| [+])' \
         && printf '%s' "$ncmd" | grep -qE '(^|[ /:+])(main|master|develop|release)([ :]|$)'; then
        block "Force-pushing to a protected branch (main/master/develop/release)"
      fi

      # dd if=/dev/zero of=/dev/*
      if printf '%s' "$ncmd" | grep -qE 'dd +if=/dev/zero +of=/dev/'; then
        block "Attempting to wipe disk"
      fi

      exit 0
      BLOCKER_EOF
            chmod +x "${cfg.dataDir}/hooks/dangerous-command-blocker.sh"

            # Write secret-scanner.sh — PreToolUse hook on git commit* and git push*.
            # Delegates to gitleaks for the push path (commit path uses gitleaks-precommit.sh
            # baked into the image skel). Exits 0 gracefully if gitleaks is absent.
            cat > "${cfg.dataDir}/hooks/secret-scanner.sh" <<'SECRET_EOF'
      #!/usr/bin/env bash
      set -u
      payload="$(cat)"
      cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
      [ -z "$cmd" ] && exit 0

      # Only act on git push
      if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
        exit 0
      fi

      if ! command -v gitleaks >/dev/null 2>&1; then
        # Don't block the push (gitleaks may legitimately be absent), but make the
        # gap LOUD on stderr rather than silently passing — a silent exit 0 reads as
        # "scanned, clean" when nothing was scanned.
        printf 'WARNING: gitleaks not found — push secret scan SKIPPED (not blocked)\n' >&2
        exit 0
      fi

      cwd="$(printf '%s' "$payload" | jq -r '.tool_input.cwd // .cwd // empty' 2>/dev/null)"
      [ -z "$cwd" ] && cwd="$PWD"
      cd "$cwd" 2>/dev/null || exit 0
      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

      if ! gitleaks protect --staged --no-banner 2>/dev/null; then
        printf 'gitleaks: secrets detected in staged changes — push blocked\n' >&2
        exit 2
      fi
      exit 0
      SECRET_EOF
            chmod +x "${cfg.dataDir}/hooks/secret-scanner.sh"

            # Write pre-commit-lint.sh — stub (lint is handled by golangci-lint via
            # the /lint-fix skill and developer workflow; running it on every commit
            # in the hook would be too slow for the interactive loop).
            cat > "${cfg.dataDir}/hooks/pre-commit-lint.sh" <<'LINT_EOF'
      #!/usr/bin/env bash
      exit 0
      LINT_EOF
            chmod +x "${cfg.dataDir}/hooks/pre-commit-lint.sh"

            # Write pre-compile-check.sh — stub (compilation is surfaced via test-runner.sh
            # which runs after every Edit/Write; a separate pre-compile step here would
            # duplicate work and slow the edit loop).
            cat > "${cfg.dataDir}/hooks/pre-compile-check.sh" <<'COMPILE_EOF'
      #!/usr/bin/env bash
      exit 0
      COMPILE_EOF
            chmod +x "${cfg.dataDir}/hooks/pre-compile-check.sh"

            # Write build-validator.sh — stub (build validation is handled by
            # test-runner.sh PostToolUse hook and the make build / cargo build
            # commands invoked explicitly by the agent).
            cat > "${cfg.dataDir}/hooks/build-validator.sh" <<'BUILD_EOF'
      #!/usr/bin/env bash
      exit 0
      BUILD_EOF
            chmod +x "${cfg.dataDir}/hooks/build-validator.sh"

            # Copy OpenCode plugins from package
            ${lib.optionalString (cfg.package != null) ''
              if [ -d "${cfg.package}/share/agentbox/home/.config/opencode/plugins" ]; then
                # Copy single-file .ts plugins
                cp -f ${cfg.package}/share/agentbox/home/.config/opencode/plugins/*.ts \
                  "${cfg.dataDir}/home/.config/opencode/plugins/" 2>/dev/null || true
                # Copy directory-based plugins (e.g. an OpenCode provider plugin)
                for dir in ${cfg.package}/share/agentbox/home/.config/opencode/plugins/*/; do
                  if [ -d "$dir" ]; then
                    dirname=$(basename "$dir")
                    rm -rf "${cfg.dataDir}/home/.config/opencode/plugins/$dirname"
                    cp -r "$dir" "${cfg.dataDir}/home/.config/opencode/plugins/$dirname"
                  fi
                done
              fi
            ''}

            # Copy git config (refreshed every activation so the Nix-declared
            # content stays in sync).
            cp -f "${gitConfigFile}" "${cfg.dataDir}/home/.gitconfig"
            chmod 644 "${cfg.dataDir}/home/.gitconfig"

            # Copy tmux config (refreshed every activation so the Nix-declared
            # content — including allow-rename and automatic-rename-format for
            # Claude Code session window names — stays in sync).
            cp -f "${tmuxConfigFile}" "${cfg.dataDir}/home/.tmux.conf"
            chmod 644 "${cfg.dataDir}/home/.tmux.conf"

            # Install SSH key(s) so the same credential drives both host-side
            # auto-clone (below) and container-side git use via the bind-mounted
            # /home/agent/.ssh.
            ${lib.optionalString (cfg.settings.sshPrivateKeyPath != null) ''
              if [ -f "${cfg.settings.sshPrivateKeyPath}" ]; then
                agentbox_key_tmp="${cfg.dataDir}/home/.ssh/id_ed25519.tmp"
                install -m 0600 "${cfg.settings.sshPrivateKeyPath}" "$agentbox_key_tmp"
                mv -f "$agentbox_key_tmp" "${cfg.dataDir}/home/.ssh/id_ed25519"
              else
                echo "Warning: agentbox SSH private key not found at ${cfg.settings.sshPrivateKeyPath}"
              fi
            ''}
            ${lib.optionalString (sshPublicKeyFile != null) ''
              install -m 0644 ${sshPublicKeyFile} "${cfg.dataDir}/home/.ssh/id_ed25519.pub"
            ''}
            install -m 0644 ${sshKnownHostsFile} "${cfg.dataDir}/home/.ssh/known_hosts"

            # Install cloud credentials (decrypted by sops) into the agent home so
            # they can be bind-mounted read-only into the container. Temp file + atomic
            # mv so an interrupted activation never leaves a half-written credential.
            ${lib.optionalString (cfg.settings.awsCredentialsPath != null) ''
              if [ -f "${cfg.settings.awsCredentialsPath}" ]; then
                mkdir -p "${cfg.dataDir}/home/.aws" && chmod 700 "${cfg.dataDir}/home/.aws"
                install -m 0600 "${cfg.settings.awsCredentialsPath}" "${cfg.dataDir}/home/.aws/credentials.tmp"
                mv -f "${cfg.dataDir}/home/.aws/credentials.tmp" "${cfg.dataDir}/home/.aws/credentials"
              else
                echo "Warning: agentbox AWS credentials not found at ${cfg.settings.awsCredentialsPath}"
              fi
            ''}
            ${lib.optionalString (awsConfigFile != null) ''
              mkdir -p "${cfg.dataDir}/home/.aws" && chmod 700 "${cfg.dataDir}/home/.aws"
              install -m 0644 ${awsConfigFile} "${cfg.dataDir}/home/.aws/config"
            ''}
            ${lib.optionalString (cfg.settings.gcpServiceAccountKeyPath != null) ''
              if [ -f "${cfg.settings.gcpServiceAccountKeyPath}" ]; then
                mkdir -p "${cfg.dataDir}/home/.config/gcloud" && chmod 700 "${cfg.dataDir}/home/.config/gcloud"
                install -m 0600 "${cfg.settings.gcpServiceAccountKeyPath}" "${cfg.dataDir}/home/.config/gcloud/sa-key.json.tmp"
                mv -f "${cfg.dataDir}/home/.config/gcloud/sa-key.json.tmp" "${cfg.dataDir}/home/.config/gcloud/sa-key.json"
              else
                echo "Warning: agentbox GCP key not found at ${cfg.settings.gcpServiceAccountKeyPath}"
              fi
            ''}
            ${lib.optionalString (cfg.settings.kubeConfigPath != null) ''
              if [ -f "${cfg.settings.kubeConfigPath}" ]; then
                mkdir -p "${cfg.dataDir}/home/.kube" && chmod 700 "${cfg.dataDir}/home/.kube"
                install -m 0600 "${cfg.settings.kubeConfigPath}" "${cfg.dataDir}/home/.kube/config.tmp"
                mv -f "${cfg.dataDir}/home/.kube/config.tmp" "${cfg.dataDir}/home/.kube/config"
              else
                echo "Warning: agentbox kubeconfig not found at ${cfg.settings.kubeConfigPath}"
              fi
            ''}

            # Auto-clone repositories into the workspace.
            # Idempotent: skips any destination that already has a `.git` directory.
            # GIT_SSH_COMMAND pins the key and known_hosts; HOME is set so git
            # reads the agent's .gitconfig.
            ${lib.concatStringsSep "\n" (
              lib.mapAttrsToList (name: repo: ''
                agentbox_clone_target="${cfg.dataDir}/workspaces/opencode/${repo.dest}"
                if [ ! -d "$agentbox_clone_target/.git" ]; then
                  echo "Cloning ${repo.url} -> $agentbox_clone_target"
                  mkdir -p "$(dirname "$agentbox_clone_target")"
                  ${pkgs.coreutils}/bin/env \
                    HOME="${cfg.dataDir}/home" \
                    GIT_SSH_COMMAND="/usr/bin/ssh -i ${cfg.dataDir}/home/.ssh/id_ed25519 -o UserKnownHostsFile=${cfg.dataDir}/home/.ssh/known_hosts -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes" \
                    ${pkgs.git}/bin/git clone ${
                      lib.optionalString (repo.branch != null) "--branch ${repo.branch}"
                    } \
                    "${repo.url}" "$agentbox_clone_target" \
                    || echo "Warning: failed to clone ${repo.url} (auto-clone '${name}')"
                fi
              '') cfg.settings.autoCloneRepos
            )}

            # Fix ownership (covers SSH key files, auto-cloned repos, and everything else)
            chown -R ${config.system.primaryUser} "${cfg.dataDir}" 2>/dev/null || true

            # Re-assert root ownership on the managed settings policy file (the
            # recursive chown above just handed it to the primary user). Claude Code
            # ignores a managed-settings.json that is writable by a non-admin user, and
            # root ownership also stops the in-container agent (mapped to the primary
            # user's uid) from being able to tamper with the host file behind the
            # read-only mount. 0644 = world-readable, root-writable only.
            chown root:wheel "${cfg.dataDir}/managed/managed-settings.json" 2>/dev/null || true
            chmod 644 "${cfg.dataDir}/managed/managed-settings.json" 2>/dev/null || true
            chown root:wheel "${cfg.dataDir}/managed/codex-requirements.toml" 2>/dev/null || true
            chmod 644 "${cfg.dataDir}/managed/codex-requirements.toml" 2>/dev/null || true
            chown root:wheel "${cfg.dataDir}/managed/opencode.json" 2>/dev/null || true
            chmod 644 "${cfg.dataDir}/managed/opencode.json" 2>/dev/null || true

            echo "Agentbox setup complete. Run 'agentbox load-image' to load the Docker image."
    '';
  };
}
