# NixOS module for Agentbox - AI Coding Agent Sandbox
# Uses virtualisation.oci-containers with Nix-built Docker image.
#
# Benefits over docker-compose approach:
# - Native systemd integration (proper service management)
# - No image building on every start (uses pre-built Nix image)
# - Better secret handling via environmentFiles
# - Declarative container configuration
#
# Usage in configuration.nix:
#   imports = [ agentbox.nixosModules.agentbox ];
#   services.agentbox = {
#     enable = true;
#     user = "you";
#     environmentFile = config.sops.templates."agentbox.env".path;
#     settings = {
#       enableClaudeCode = true;
#       enableCodex = true;
#       # ... more sandbox settings (see common-options.nix)
#     };
#   };
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
  piSettingsJson = pkgs.writeText "pi-settings.json" (builtins.toJSON cfg.settings.piConfig.settings);
  piModelsJson = pkgs.writeText "pi-models.json" (builtins.toJSON cfg.settings.piConfig.models);

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
  containerEnv = {
    DISPLAY = ":10";
    TERM = "xterm-256color";
    GOPRIVATE = cfg.settings.goprivate;
    PUID = "1000";
    PGID = "1000";
    TZ = cfg.settings.timezone;
    # OpenCode services
    ENABLE_OPENCODE = lib.boolToString cfg.settings.enableOpencode;
    ENABLE_PI = lib.boolToString cfg.settings.enablePi;
    ENABLE_PI_WEB = lib.boolToString cfg.settings.enablePiWeb;
    PI_WEB_BIND_ADDRESS = "127.0.0.1";
    PI_WEB_PORT = "4097";
    ENABLE_CHAT_BRIDGE = "false";
    # Claude Code services
    ENABLE_CLAUDE_CODE = lib.boolToString cfg.settings.enableClaudeCode;
    ENABLE_CODEX = lib.boolToString cfg.settings.enableCodex;
    # Docker-in-Docker
    ENABLE_DOCKER = lib.boolToString cfg.settings.enableDocker;
    # In-container sudo (setuid wrapper staged at boot)
    ENABLE_SUDO = lib.boolToString cfg.settings.hardening.enableSudo;
    # In-container nix daemon (throwaway `nix profile install`)
    ENABLE_NIX = lib.boolToString cfg.settings.enableNix;
    # OpenCode server settings (for an external bridge to connect to OpenCode)
    OPENCODE_SERVER_URL = "http://127.0.0.1:4096";
    # Session settings
    SESSION_WORKING_DIRECTORY = cfg.settings.sessionWorkingDirectory;
    # Claude Code version to install
    CLAUDE_CODE_VERSION = cfg.settings.claudeCodeVersion;
    CLAUDE_CWD = "/workspace";
    CLAUDE_PROVIDER_MAX_TURNS = "500";
    AGENT_HISTORY_REQUESTS_ENABLED = lib.boolToString cfg.settings.historyArchive.enable;
    AGENT_HISTORY_REQUEST_DIR = "/home/agent/.agent-history/requests";
    AGENT_HISTORY_PRODUCER_ID = cfg.settings.historyArchive.hostId;
    AGENT_HISTORY_REQUEST_TTL_SECONDS = toString cfg.settings.historyArchive.requestTtlSeconds;
  }
  # Point Application Default Credentials at the bind-mounted service-account
  # key so client libraries and the GKE auth plugin can mint tokens. The path
  # is not sensitive; the key file itself is mounted read-only (see volumes).
  // lib.optionalAttrs (cfg.settings.gcpServiceAccountKeyPath != null) {
    GOOGLE_APPLICATION_CREDENTIALS = "/home/agent/.config/gcloud/sa-key.json";
    CLOUDSDK_CORE_PROJECT = cfg.settings.gcpProject;
  }
  # Point the in-container docker CLI at the restricted socket proxy instead of
  # the raw daemon socket (which is never mounted into agentbox). The proxy
  # only permits read-only routes (logs/inspect/list); container create/exec
  # are rejected by the daemon-side allowlist.
  // lib.optionalAttrs cfg.settings.dockerProxy.enable {
    DOCKER_HOST = "tcp://127.0.0.1:2375";
  }
  # Env contributed via the generic extension surface
  # (services.agentbox.extraEnvironment) — used by any add-on module you import.
  // cfg.extraEnvironment;

in
{
  imports = [ ./common-options.nix ];

  options.services.agentbox = {
    enable = lib.mkEnableOption "Agentbox AI Coding Agent Sandbox";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.agentbox;
      defaultText = lib.literalExpression "pkgs.agentbox";
      description = "The agentbox package to use (for hooks and plugins).";
    };

    image = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression ''
        pkgs.agentboxImage
        # or pkgs.agentboxImage.override { withCloudTools = true; }
        # when settings.enableCloudTools = true
      '';
      description = "The Nix-built agentbox Docker image. Defaults to the base image, or the cloud-tools variant when settings.enableCloudTools = true. Override to supply a fully custom image.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "agentbox";
      description = "User account under which the service runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "docker";
      description = "Group under which the service runs.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/agentbox";
      description = "Directory for storing agentbox data and configuration.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to an environment file containing secrets.
        Can be used with sops-nix for secure secret management.

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

    backend = lib.mkOption {
      type = lib.types.enum [
        "docker"
        "podman"
      ];
      default = "docker";
      description = "Container backend to use.";
    };

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether the container starts automatically at boot and on
        `nixos-rebuild switch`. When false, the container (and its docker-proxy
        sidecar) is not pulled into any systemd target — start it on demand with
        `systemctl start docker-agentbox` (or podman-agentbox). The service is
        still defined and its dependencies (proxy, secrets) are honoured on
        manual start.
      '';
    };
    # All sandbox settings live in ./common-options.nix (shared with darwin).
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.settings.historyArchive.enable || cfg.settings.historyArchive.hostId != "";
        message = "services.agentbox.settings.historyArchive.hostId must be set when archive requests are enabled";
      }
    ];

    # Default image: base image, with build-time variants toggled by settings —
    # the cloud-tools bundle (enableCloudTools) and the nix CLI (enableNix, on by
    # default; only overridden off here). lib.mkDefault lets an explicit
    # `services.agentbox.image = …` assignment override this without conflict.
    services.agentbox.image = lib.mkDefault (
      pkgs.agentboxImage.override (
        (lib.optionalAttrs cfg.settings.enableCloudTools { withCloudTools = true; })
        // (lib.optionalAttrs (!cfg.settings.enableNix) { withNix = false; })
      )
    );

    # Enable container backend
    virtualisation.docker = lib.mkIf (cfg.backend == "docker") {
      enable = lib.mkDefault true;
      rootless = {
        enable = lib.mkDefault true;
        setSocketVariable = lib.mkDefault true;
      };
      autoPrune.enable = lib.mkDefault true;
    };

    virtualisation.podman = lib.mkIf (cfg.backend == "podman") {
      enable = lib.mkDefault true;
      dockerSocket.enable = lib.mkDefault true;
      autoPrune.enable = lib.mkDefault true;
    };

    # Set oci-containers backend
    virtualisation.oci-containers.backend = cfg.backend;

    # Enable linger for the user so services start at boot
    users.users.${cfg.user}.linger = lib.mkDefault true;

    # Create data directories via tmpfiles
    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.local 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.ssh 0700 ${cfg.user} ${cfg.group} -"
      # Cloud credential dirs (files installed by the activation script when the
      # corresponding *Path options are set; harmless to pre-create otherwise).
      "d ${cfg.dataDir}/home/.aws 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.config/gcloud 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.kube 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.claude 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.codex 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.codex/skills 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.cache 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.bun 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.cargo 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.rustup 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.config 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.config/opencode 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.config/opencode/plugins 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.pi 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.pi/agent 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/home/.pi/agent/skills 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/workspaces 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/workspaces/opencode 0755 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/hooks 0755 ${cfg.user} ${cfg.group} -"
      # Enterprise managed-settings policy dir. Kept root-owned: Claude Code only
      # honors managed settings that are not user-writable.
      "d ${cfg.dataDir}/managed 0755 root root -"
    ]
    ++ lib.optional cfg.settings.historyArchive.enable "d ${cfg.dataDir}/history-sync/requests 0700 ${cfg.user} ${cfg.group} -"
    # Notification signal dir: the in-container hooks write here; the host
    # watcher (below) reads it and pops a desktop notification.
    ++ lib.optional cfg.settings.enableNotification "d ${cfg.dataDir}/signals 0755 ${cfg.user} ${cfg.group} -";

    # Desktop notifications (Linux). A per-user path unit watches the signal
    # file the in-container hooks write and pops a notify-send alert. Requires a
    # graphical user session (DBUS) — a no-op on headless hosts. macOS uses an
    # osascript LaunchAgent for the same purpose (see darwin.nix).
    systemd.user.paths.agentbox-notify = lib.mkIf cfg.settings.enableNotification {
      wantedBy = [ "default.target" ];
      pathConfig.PathModified = "${cfg.dataDir}/signals/claude-notify";
    };
    systemd.user.services.agentbox-notify = lib.mkIf cfg.settings.enableNotification {
      serviceConfig.Type = "oneshot";
      script = ''
        f="${cfg.dataDir}/signals/claude-notify"
        [ -f "$f" ] || exit 0
        IFS=$'\t' read -r msg _target title < "$f"
        [ -n "$msg" ] || msg="Claude"
        [ -n "$title" ] || title="Agentbox"
        msg=$(printf '%s' "$msg" | ${pkgs.coreutils}/bin/tr -d '\000-\037')
        title=$(printf '%s' "$title" | ${pkgs.coreutils}/bin/tr -d '\000-\037')
        ${pkgs.libnotify}/bin/notify-send "$title" "$msg" || true
      '';
    };

    # Restricted Docker socket proxy sidecar (read-only routes only). Holds the
    # only mount of the real socket and re-serves a default-deny TCP endpoint on
    # 127.0.0.1:2375 that agentbox reaches via DOCKER_HOST.
    virtualisation.oci-containers.containers.agentbox-docker-proxy =
      lib.mkIf cfg.settings.dockerProxy.enable
        {
          image = cfg.settings.dockerProxy.image;
          autoStart = cfg.autoStart;
          extraOptions = [
            "--network=host"
            "--read-only"
            "--security-opt=no-new-privileges"
            "--user=${cfg.settings.dockerProxy.user}"
          ];
          volumes = [
            "${cfg.settings.dockerProxy.socketPath}:/var/run/docker.sock:ro"
          ];
          # Flags consumed by wollomatic/socket-proxy. Listens on loopback:2375;
          # everything not matched by allow{GET,HEAD} (and all writes) is denied.
          cmd = [
            "-loglevel=info"
            "-listenip=127.0.0.1"
            "-allowfrom=${cfg.settings.dockerProxy.allowFrom}"
            "-allowGET=${cfg.settings.dockerProxy.allowGET}"
            "-allowHEAD=${cfg.settings.dockerProxy.allowHEAD}"
          ]
          ++ cfg.settings.dockerProxy.extraArgs;
        };

    # OCI container definition
    virtualisation.oci-containers.containers.agentbox = {
      # Use Nix-built image (loaded via activation script)
      image = "agentbox:latest";
      autoStart = cfg.autoStart;

      # Network mode: host for simplicity (exposes ports directly)
      extraOptions = [
        "--network=host"
        "--hostname=agentbox"
        # Resource limits
        "--cpus=${toString cfg.settings.cpuLimits}"
        "--memory=${cfg.settings.memoryLimits}"
        "--pids-limit=${toString cfg.settings.pidsLimit}"
      ]
      # Container hardening (shared options). "default" => omit the flag so
      # Docker applies its built-in default seccomp profile.
      ++ lib.optional (
        cfg.settings.hardening.seccompProfile != "default"
      ) "--security-opt=seccomp=${cfg.settings.hardening.seccompProfile}"
      ++ lib.optional cfg.settings.hardening.noNewPrivileges "--security-opt=no-new-privileges"
      ++ lib.optionals cfg.settings.enableDocker [
        "--privileged"
      ];

      # Environment variables (non-secret)
      environment = containerEnv;

      # Secret environment file
      environmentFiles = lib.optional (cfg.environmentFile != null) cfg.environmentFile;

      # Volume mounts. Cloud credentials are mounted as individual read-only
      # files (only the secret file, never the whole config dir) so the CLIs'
      # own writable state under ~/.aws, ~/.config/gcloud, ~/.kube is unaffected.
      volumes = [
        "${cfg.dataDir}/home:/config"
        "${cfg.dataDir}/home/.local:/home/agent/.local"
        "${cfg.dataDir}/home/.ssh:/home/agent/.ssh"
        "${cfg.dataDir}/home/.cache:/home/agent/.cache"
        "${cfg.dataDir}/home/.bun:/home/agent/.bun"
        "${cfg.dataDir}/home/.cargo:/home/agent/.cargo"
        "${cfg.dataDir}/home/.rustup:/home/agent/.rustup"
        "${cfg.dataDir}/home/.bashrc:/home/agent/.bashrc"
        "${cfg.dataDir}/home/.gitconfig:/home/agent/.gitconfig"
        "${cfg.dataDir}/home/.tmux.conf:/home/agent/.tmux.conf"
        "${cfg.dataDir}/home/.claude.json:/home/agent/.claude.json"
        # Enterprise policy file, READ-ONLY: pins the permission deny list and the
        # safety hooks above the agent-writable settings.json (see managedSettingsJson).
        "${cfg.dataDir}/managed/managed-settings.json:/etc/claude-code/managed-settings.json:ro"
        # Codex requirements are the equivalent managed layer: user config can
        # add preferences but cannot disable the reviewer or secret-path denies.
        "${cfg.dataDir}/managed/codex-requirements.toml:/etc/codex/requirements.toml:ro"
        "${cfg.dataDir}/managed/opencode.json:/etc/opencode/opencode.json:ro"
        "${cfg.dataDir}/home/.claude:/home/agent/.claude"
        "${cfg.dataDir}/home/.codex:/home/agent/.codex"
        "${cfg.dataDir}/home/.config/opencode:/home/agent/.config/opencode"
        "${cfg.dataDir}/home/.pi:/home/agent/.pi"
        "${cfg.dataDir}/workspaces/opencode:/workspace"
        "${cfg.dataDir}/hooks:/home/agent/.hooks:ro"
      ]
      # Notification signals: hooks write here; the host watcher reads them.
      ++ lib.optional cfg.settings.enableNotification "${cfg.dataDir}/signals:/home/agent/.signals"
      ++ lib.optional cfg.settings.historyArchive.enable "${cfg.dataDir}/history-sync/requests:/home/agent/.agent-history/requests"
      ++ lib.optional (
        cfg.settings.awsCredentialsPath != null
      ) "${cfg.dataDir}/home/.aws/credentials:/home/agent/.aws/credentials:ro"
      ++ lib.optional (
        cfg.settings.awsConfig != ""
      ) "${cfg.dataDir}/home/.aws/config:/home/agent/.aws/config:ro"
      ++ lib.optional (
        cfg.settings.gcpServiceAccountKeyPath != null
      ) "${cfg.dataDir}/home/.config/gcloud/sa-key.json:/home/agent/.config/gcloud/sa-key.json:ro"
      ++ lib.optional (
        cfg.settings.kubeConfigPath != null
      ) "${cfg.dataDir}/home/.kube/config:/home/agent/.kube/config:ro"
      # Volumes contributed by optional integration add-ons.
      ++ cfg.extraVolumes;
    };

    # Load the Nix-built image into the backend. This is a unit rather than an
    # activation script because the daemon has to be running: switch-to-
    # configuration stops ${cfg.backend}.service before activation and only
    # restarts it afterwards, so an activation-time `load` always ran against a
    # dead socket and failed the whole activation.
    systemd.services.agentbox-image-load =
      let
        dockerBin =
          if cfg.backend == "docker" then "${pkgs.docker}/bin/docker" else "${pkgs.podman}/bin/podman";
        # Store the image path as a string to avoid forcing evaluation during build
        imagePath = toString cfg.image;
        # Only docker has a daemon unit to order against; podman is socket-activated.
        daemonUnit = lib.optional (cfg.backend == "docker") "docker.service";
      in
      {
        description = "Load the agentbox image into ${cfg.backend}";
        after = daemonUnit;
        requires = daemonUnit;
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          # Load the Nix-built agentbox image into Docker/Podman
          if [ -f "${imagePath}" ]; then
            echo "Loading agentbox image from ${imagePath}..."
            ${dockerBin} load < "${imagePath}"
          else
            echo "Warning: Agentbox image not found at ${imagePath}"
            echo "Build it with: nix build .#agentboxImage"
          fi
        '';
      };

    # Setup configuration files before container starts
    system.activationScripts.agentbox-config = {
      text = ''
                        # The tmpfiles rules above own these directories, but they are
                        # applied by systemd-tmpfiles-resetup.service, which runs after
                        # activation — so on the switch that first introduces a rule the
                        # directory does not exist yet and every write below fails.
                        # Create them here; tmpfiles still reconciles mode and ownership.
                        mkdir -p "${cfg.dataDir}/managed" \
                                 "${cfg.dataDir}/home/.claude" \
                                 "${cfg.dataDir}/home/.codex" \
                                 "${cfg.dataDir}/home/.config/opencode" \
                                 "${cfg.dataDir}/home/.pi/agent/skills"
                        ${lib.optionalString cfg.settings.historyArchive.enable ''
                          mkdir -p "${cfg.dataDir}/history-sync/requests"
                          chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/history-sync/requests"
                          chmod 700 "${cfg.dataDir}/history-sync/requests"
                        ''}
                        chown ${cfg.user}:${cfg.group} \
                          "${cfg.dataDir}/home/.claude" \
                          "${cfg.dataDir}/home/.codex" \
                          "${cfg.dataDir}/home/.config/opencode" \
                          "${cfg.dataDir}/home/.pi"

                        # Create .bashrc marker file to prevent container from overwriting mounted volumes
                        # The container's entrypoint checks for .bashrc to detect "initialized" home directory
                        # Without this, it copies skeleton over mounted .claude directory, wiping credentials
                        if [ ! -f "${cfg.dataDir}/home/.bashrc" ]; then
                          cat > "${cfg.dataDir}/home/.bashrc" <<'BASHRC'
        case $- in *i*) ;; *) return;; esac
        HISTCONTROL=ignoreboth
        shopt -s histappend
        HISTSIZE=1000
        HISTFILESIZE=2000
        shopt -s checkwinsize
        [ -x /usr/bin/lesspipe ] && eval "$(SHELL=/bin/sh lesspipe)"
        PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
        if [ -x /usr/bin/dircolors ]; then
            test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
            alias ls='ls --color=auto'
            alias grep='grep --color=auto'
        fi
        alias ll='ls -alF'
        alias la='ls -A'
        alias l='ls -CF'
        # Homebrew (go, node, rust, typescript, etc.)
        [ -d /home/linuxbrew/.linuxbrew ] && eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
        # Go workspace
        [ -d "$HOME/go/bin" ] && export PATH="$HOME/go/bin:$PATH"
        # Rust/Cargo
        [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
        # UV/Python
        [ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
        [ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
        # Bun
        [ -d "$HOME/.bun" ] && export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"
        if [ -d "$HOME/.ssh" ] && [ -z "$SSH_AUTH_SOCK" ]; then
            eval "$(ssh-agent -s)" >/dev/null
        fi
        BASHRC
                          chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.bashrc"
                          chmod 644 "${cfg.dataDir}/home/.bashrc"
                        fi

                        # Merge Claude Code configuration (MCP servers) into ~/.claude.json only
                        # when the Nix config changed. The store path is content-addressed, so it
                        # only differs when mcpServers actually changed — no extra hashing needed.
                        _nix_claude_cfg=${claudeConfigJson}
                        _marker_claude="${cfg.dataDir}/home/.claude.json.nix-store-path"
                        if [ ! -f "$_marker_claude" ] || [ "$(cat "$_marker_claude" 2>/dev/null)" != "$_nix_claude_cfg" ]; then
                          if [ -f "${cfg.dataDir}/home/.claude.json" ]; then
                            _merged="$(${pkgs.jq}/bin/jq -s \
                              '.[0] + {mcpServers: .[1].mcpServers}' \
                              "${cfg.dataDir}/home/.claude.json" \
                              "$_nix_claude_cfg" 2>/dev/null)" \
                            && printf '%s\n' "$_merged" > "${cfg.dataDir}/home/.claude.json" \
                            && chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.claude.json" \
                            || true
                          else
                            cp -f "$_nix_claude_cfg" "${cfg.dataDir}/home/.claude.json"
                            chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.claude.json"
                          fi
                          chmod 644 "${cfg.dataDir}/home/.claude.json"
                          printf '%s' "$_nix_claude_cfg" > "$_marker_claude"
                        fi

                        # Re-assert the Nix-owned keys ($schema, hooks, permissions) into
                        # ~/.claude/settings.json by MERGING them over whatever is on disk,
                        # rather than a marker-gated full overwrite.
                        #
                        # Why merge instead of overwrite-when-changed: settings.json is a
                        # SHARED file. Claude Code writes its own runtime state there (e.g.
                        # `model`, and `permissions.defaultMode` when you switch permission
                        # mode) and, when it rewrites the file, it does NOT preserve our
                        # `hooks` block — so the hooks and the secret-file deny list silently
                        # vanish mid-session. The previous logic only rewrote when the *Nix*
                        # store path changed, so it never noticed Claude had clobbered the
                        # file: a rebuild was a no-op and the hooks stayed gone. Merging on
                        # the live file (and writing only when the result actually differs)
                        # self-heals that on every activation while preserving Claude's own
                        # keys like `model`.
                        _nix_settings=${settingsJson}
                        _live_settings="${cfg.dataDir}/home/.claude/settings.json"
                        _merged_settings=""
                        if [ -f "$_live_settings" ]; then
                          _merged_settings="$(${pkgs.jq}/bin/jq -s \
                            '.[0] + {"$schema": .[1]["$schema"], hooks: .[1].hooks, permissions: .[1].permissions}' \
                            "$_live_settings" "$_nix_settings" 2>/dev/null)"
                        fi
                        # Fall back to the raw Nix file when there is no live file yet or the
                        # merge failed (e.g. Claude wrote invalid JSON).
                        [ -n "$_merged_settings" ] || _merged_settings="$(cat "$_nix_settings")"
                        # Write only when the on-disk content differs, to avoid signaling
                        # Claude Code to reload settings on every activation.
                        if [ ! -f "$_live_settings" ] || [ "$(cat "$_live_settings" 2>/dev/null)" != "$_merged_settings" ]; then
                          printf '%s\n' "$_merged_settings" > "$_live_settings"
                          chown ${cfg.user}:${cfg.group} "$_live_settings"
                          chmod 644 "$_live_settings"
                        fi

                        # Write the enterprise "managed settings" policy file. Bind-mounted
                        # read-only into the container at /etc/claude-code/managed-settings.json,
                        # it outranks the agent-writable settings.json (authoritative deny +
                        # managed hooks). Kept ROOT-owned (not chowned to the agent) — Claude
                        # Code only honors managed settings that are not user-writable.
                        # Docker creates a directory at a missing bind source. Repair that
                        # exact legacy shape so an earlier failed start can self-heal.
                        _managed_settings="${cfg.dataDir}/managed/managed-settings.json"
                        if [ -d "$_managed_settings" ]; then
                          ${pkgs.coreutils}/bin/rm -rf -- "$_managed_settings"
                        fi
                        cp -f ${managedSettingsJson} "${cfg.dataDir}/managed/managed-settings.json"
                        chown root:root "${cfg.dataDir}/managed/managed-settings.json"
                        chmod 644 "${cfg.dataDir}/managed/managed-settings.json"

                        # Codex's user config is shared with CLI-persisted state. Merge
                        # Nix-owned settings over it while preserving unknown keys.
                        _nix_codex=${codexConfigToml}
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
                          chown ${cfg.user}:${cfg.group} "$_live_codex"
                          chmod 644 "$_live_codex"
                        fi

                        # Managed Codex requirements are root-owned and mounted
                        # read-only, analogous to Claude Code managed settings.
                        cp -f ${codexRequirementsToml} "${cfg.dataDir}/managed/codex-requirements.toml"
                        chown root:root "${cfg.dataDir}/managed/codex-requirements.toml"
                        chmod 644 "${cfg.dataDir}/managed/codex-requirements.toml"

                        # OpenCode loads /etc/opencode after user and project config,
                        # making these deny rules authoritative inside the container.
                        cp -f ${opencodeManagedConfigJson} "${cfg.dataDir}/managed/opencode.json"
                        chown root:root "${cfg.dataDir}/managed/opencode.json"
                        chmod 644 "${cfg.dataDir}/managed/opencode.json"

                        # Preserve OpenCode-owned/global keys while reasserting all
                        # declarative settings and permission denies.
                        _nix_opencode=${opencodeConfigJson}
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
                          chown ${cfg.user}:${cfg.group} "$_live_opencode"
                          chmod 644 "$_live_opencode"
                        fi

                        # Pi settings are shared with CLI-persisted preferences.
                        # Merge declarative values over live settings while preserving
                        # Pi-owned keys, and refresh custom model definitions.
                        _live_pi_settings="${cfg.dataDir}/home/.pi/agent/settings.json"
                        _merged_pi_settings=""
                        if [ -f "$_live_pi_settings" ]; then
                          _merged_pi_settings="$(${pkgs.jq}/bin/jq -s '.[0] * .[1]' \
                            "$_live_pi_settings" ${piSettingsJson} 2>/dev/null)"
                        fi
                        [ -n "$_merged_pi_settings" ] || _merged_pi_settings="$(cat ${piSettingsJson})"
                        printf '%s\n' "$_merged_pi_settings" > "$_live_pi_settings.tmp"
                        mv -f "$_live_pi_settings.tmp" "$_live_pi_settings"
                        cp -f ${piModelsJson} "${cfg.dataDir}/home/.pi/agent/models.json"
                        chown -R ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.pi"
                        chmod 644 "$_live_pi_settings" "${cfg.dataDir}/home/.pi/agent/models.json"

                        # Copy git config
                        cp -f ${gitConfigFile} "${cfg.dataDir}/home/.gitconfig"
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.gitconfig"
                        chmod 644 "${cfg.dataDir}/home/.gitconfig"

                        # Copy tmux config
                        cp -f ${tmuxConfigFile} "${cfg.dataDir}/home/.tmux.conf"
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.tmux.conf"
                        chmod 644 "${cfg.dataDir}/home/.tmux.conf"

                        # Copy hooks from package or custom directory
                        ${
                          if cfg.hooksDir != null then
                            ''
                              cp -f ${cfg.hooksDir}/*.sh "${cfg.dataDir}/hooks/" 2>/dev/null || true
                            ''
                          else
                            ''
                              # Copy default hooks from agentbox package
                              if [ -d "${cfg.package}/share/agentbox/hooks" ]; then
                                cp -f ${cfg.package}/share/agentbox/hooks/*.sh "${cfg.dataDir}/hooks/" 2>/dev/null || true
                              fi
                            ''
                        }
                        chmod +x "${cfg.dataDir}/hooks/"*.sh 2>/dev/null || true
                        chown -R ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks" 2>/dev/null || true

                        # Write notify.sh — Stop hook: rings a terminal bell and renames the
                        # tmux window to mark task completion.
                        #
                        # Two subtleties handled here:
                        #   - Hooks run non-interactively, so .bashrc PATH additions (brew/nix)
                        #     are absent; resolve the tmux binary explicitly.
                        #   - The tmux config mirrors the window name from #{pane_title}, which
                        #     Claude Code keeps re-setting via OSC. To stop it reverting our
                        #     name, freeze the window (automatic-rename/allow-rename off) before
                        #     renaming. claude-working.sh (UserPromptSubmit) re-enables tracking.
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
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/notify.sh"

                        # Write claude-waiting.sh — Notification hook: fires when Claude
                        # needs the human (a permission prompt or an idle wait for input).
                        # It freezes the window and renames it to flag that this session is
                        # blocked on you, the same freeze trick notify.sh uses.
                        # claude-working.sh (UserPromptSubmit) clears it on your next
                        # prompt. notification_type is filtered so unrelated notifications
                        # (auth_success, etc.) leave the window name alone.
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
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/claude-waiting.sh"

                        # Write claude-working.sh — PostToolUse hook: re-enable live title
                        # tracking after a permission prompt is approved (there is no
                        # UserPromptSubmit in that flow). Exits early if notify.sh (Stop) has
                        # already fired this turn so that a stray PostToolUse cannot wipe the
                        # "✅ done" window name. See also claude-prompt-start.sh which handles
                        # UserPromptSubmit and clears the done flag.
                        cat > "${cfg.dataDir}/hooks/claude-working.sh" <<'WORKING_EOF'
        #!/bin/bash
        # PostToolUse hook — re-enable live title tracking after Claude resumes (e.g. an
        # approved permission prompt). agent-signal.sh no-ops if Stop already marked the
        # turn done, so a stray PostToolUse cannot wipe the "done" name.
        exec bash /home/agent/.local/bin/agent-signal.sh working
        WORKING_EOF
                        chmod +x "${cfg.dataDir}/hooks/claude-working.sh"
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/claude-working.sh"

                        # Write claude-prompt-start.sh — UserPromptSubmit hook: clear the done
                        # flag from notify.sh (Stop) so the window is unfrozen, then re-enable
                        # live title tracking while Claude works on the new prompt.
                        cat > "${cfg.dataDir}/hooks/claude-prompt-start.sh" <<'PROMPT_EOF'
        #!/bin/bash
        # UserPromptSubmit hook — clear the done/waiting flags and resume live title
        # tracking for the new turn.
        exec bash /home/agent/.local/bin/agent-signal.sh start
        PROMPT_EOF
                        chmod +x "${cfg.dataDir}/hooks/claude-prompt-start.sh"
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/claude-prompt-start.sh"

                        # Write dangerous-command-blocker.sh — PreToolUse:Bash hook.
                        # Reads the Claude Code hook JSON from stdin, extracts the bash command,
                        # and exits 2 (blocking) if it matches a known destructive pattern.
                        cat > "${cfg.dataDir}/hooks/dangerous-command-blocker.sh" <<'BLOCKER_EOF'
        #!/usr/bin/env bash
        set -u
        payload="$(cat)"
        cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
        [ -z "$cmd" ] && exit 0

        block() {
          printf 'BLOCKED: %s\n' "$1" >&2
          exit 2
        }

        case "$cmd" in
          *"rm -rf /"*)      block "Attempting to delete root filesystem" ;;
          *"rm -rf /*"*)     block "Attempting to delete root filesystem" ;;
          *"rm -rf ~"*)      block "Attempting to delete home directory" ;;
          *"rm -rf \$HOME"*) block "Attempting to delete home directory" ;;
          *"> /dev/sda"*)    block "Attempting to overwrite disk" ;;
          *"mkfs"*)          block "Attempting to format filesystem" ;;
          *"git push --force origin main"*)   block "Force pushing to main branch" ;;
          *"git push --force origin master"*) block "Force pushing to master branch" ;;
          *"git push -f origin main"*)        block "Force pushing to main branch" ;;
          *"git push -f origin master"*)      block "Force pushing to master branch" ;;
          *"chmod -R 777 /"*)  block "Setting dangerous permissions on root" ;;
          *":(){:|:&};:"*)     block "Fork bomb detected" ;;
          *"mv /* /dev/null"*) block "Moving everything to null" ;;
          *"unset PATH"*)      block "Unsetting PATH" ;;
          *"--privileged"*)    block "Privileged container flag" ;;
          *"--cap-add=ALL"*)   block "Adding all capabilities" ;;
          *"-v /:/")           block "Mounting root filesystem" ;;
        esac

        if printf '%s' "$cmd" | grep -qE 'dd[[:space:]]+if=/dev/zero[[:space:]]+of=/dev/'; then
          block "Attempting to wipe disk"
        fi

        exit 0
        BLOCKER_EOF
                        chmod +x "${cfg.dataDir}/hooks/dangerous-command-blocker.sh"
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/dangerous-command-blocker.sh"

                        # Write secret-scanner.sh — PreToolUse hook on git push*.
                        # Delegates to gitleaks; exits 0 gracefully if gitleaks is absent.
                        cat > "${cfg.dataDir}/hooks/secret-scanner.sh" <<'SECRET_EOF'
        #!/usr/bin/env bash
        set -u
        payload="$(cat)"
        cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
        [ -z "$cmd" ] && exit 0

        if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
          exit 0
        fi

        if ! command -v gitleaks >/dev/null 2>&1; then
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
                        chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/secret-scanner.sh"

                        # Write pre-commit-lint.sh, pre-compile-check.sh, build-validator.sh
                        # as stubs — their functionality is covered by test-runner.sh and
                        # the explicit lint/build commands the agent runs on demand.
                        for stub_hook in pre-commit-lint.sh pre-compile-check.sh build-validator.sh; do
                          printf '#!/usr/bin/env bash\nexit 0\n' > "${cfg.dataDir}/hooks/$stub_hook"
                          chmod +x "${cfg.dataDir}/hooks/$stub_hook"
                          chown ${cfg.user}:${cfg.group} "${cfg.dataDir}/hooks/$stub_hook"
                        done

                        # Copy OpenCode plugins from package
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
                          chown -R ${cfg.user}:${cfg.group} "${cfg.dataDir}/home/.config/opencode/plugins" 2>/dev/null || true
                        fi

                        # Activation contributed via the generic extension
                        # surface (services.agentbox.extraActivation).
                        ${cfg.extraActivation}

                        # Install SSH key(s) so the same credential drives both
                        # host-side auto-clone (below) and container-side git use
                        # via the bind-mounted /home/agent/.ssh.
                        ${lib.optionalString (cfg.settings.sshPrivateKeyPath != null) ''
                          if [ -f "${cfg.settings.sshPrivateKeyPath}" ]; then
                            agentbox_key_tmp="${cfg.dataDir}/home/.ssh/id_ed25519.tmp"
                            install -m 0600 -o ${cfg.user} -g ${cfg.group} \
                              "${cfg.settings.sshPrivateKeyPath}" "$agentbox_key_tmp"
                            mv -f "$agentbox_key_tmp" "${cfg.dataDir}/home/.ssh/id_ed25519"
                          else
                            echo "Warning: agentbox SSH private key not found at ${cfg.settings.sshPrivateKeyPath}"
                          fi
                        ''}
                        ${lib.optionalString (sshPublicKeyFile != null) ''
                          install -m 0644 -o ${cfg.user} -g ${cfg.group} \
                            ${sshPublicKeyFile} "${cfg.dataDir}/home/.ssh/id_ed25519.pub"
                        ''}
                        install -m 0644 -o ${cfg.user} -g ${cfg.group} \
                          ${sshKnownHostsFile} "${cfg.dataDir}/home/.ssh/known_hosts"

                        # Install cloud credentials (decrypted by sops) into the agent
                        # home so they can be bind-mounted read-only into the container.
                        # Each is installed via a temp file + atomic mv so an interrupted
                        # activation never leaves a half-written credential. Mode 0600.
                        ${lib.optionalString (cfg.settings.awsCredentialsPath != null) ''
                          if [ -f "${cfg.settings.awsCredentialsPath}" ]; then
                            install -d -m 0700 -o ${cfg.user} -g ${cfg.group} "${cfg.dataDir}/home/.aws"
                            install -m 0600 -o ${cfg.user} -g ${cfg.group} \
                              "${cfg.settings.awsCredentialsPath}" "${cfg.dataDir}/home/.aws/credentials.tmp"
                            mv -f "${cfg.dataDir}/home/.aws/credentials.tmp" "${cfg.dataDir}/home/.aws/credentials"
                          else
                            echo "Warning: agentbox AWS credentials not found at ${cfg.settings.awsCredentialsPath}"
                          fi
                        ''}
                        ${lib.optionalString (awsConfigFile != null) ''
                          install -d -m 0700 -o ${cfg.user} -g ${cfg.group} "${cfg.dataDir}/home/.aws"
                          install -m 0644 -o ${cfg.user} -g ${cfg.group} \
                            ${awsConfigFile} "${cfg.dataDir}/home/.aws/config"
                        ''}
                        ${lib.optionalString (cfg.settings.gcpServiceAccountKeyPath != null) ''
                          if [ -f "${cfg.settings.gcpServiceAccountKeyPath}" ]; then
                            install -d -m 0700 -o ${cfg.user} -g ${cfg.group} "${cfg.dataDir}/home/.config/gcloud"
                            install -m 0600 -o ${cfg.user} -g ${cfg.group} \
                              "${cfg.settings.gcpServiceAccountKeyPath}" "${cfg.dataDir}/home/.config/gcloud/sa-key.json.tmp"
                            mv -f "${cfg.dataDir}/home/.config/gcloud/sa-key.json.tmp" "${cfg.dataDir}/home/.config/gcloud/sa-key.json"
                          else
                            echo "Warning: agentbox GCP key not found at ${cfg.settings.gcpServiceAccountKeyPath}"
                          fi
                        ''}
                        ${lib.optionalString (cfg.settings.kubeConfigPath != null) ''
                          if [ -f "${cfg.settings.kubeConfigPath}" ]; then
                            install -d -m 0700 -o ${cfg.user} -g ${cfg.group} "${cfg.dataDir}/home/.kube"
                            install -m 0600 -o ${cfg.user} -g ${cfg.group} \
                              "${cfg.settings.kubeConfigPath}" "${cfg.dataDir}/home/.kube/config.tmp"
                            mv -f "${cfg.dataDir}/home/.kube/config.tmp" "${cfg.dataDir}/home/.kube/config"
                          else
                            echo "Warning: agentbox kubeconfig not found at ${cfg.settings.kubeConfigPath}"
                          fi
                        ''}

                        # Auto-clone repositories into the workspace.
                        # Idempotent: skips any destination that already has a `.git` directory.
                        # GIT_SSH_COMMAND pins the key and known_hosts; HOME is set so
                        # git reads the agent's .gitconfig.
                        ${lib.concatStringsSep "\n" (
                          lib.mapAttrsToList (name: repo: ''
                            agentbox_clone_target="${cfg.dataDir}/workspaces/opencode/${repo.dest}"
                            if [ ! -d "$agentbox_clone_target/.git" ]; then
                              echo "Cloning ${repo.url} -> $agentbox_clone_target"
                              install -d -o ${cfg.user} -g ${cfg.group} "$(dirname "$agentbox_clone_target")"
                              ${pkgs.util-linux}/bin/runuser -u ${cfg.user} -- \
                                ${pkgs.coreutils}/bin/env \
                                  HOME="${cfg.dataDir}/home" \
                                  GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i ${cfg.dataDir}/home/.ssh/id_ed25519 -o UserKnownHostsFile=${cfg.dataDir}/home/.ssh/known_hosts -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes" \
                                ${pkgs.git}/bin/git clone ${
                                  lib.optionalString (repo.branch != null) "--branch ${repo.branch}"
                                } \
                                "${repo.url}" "$agentbox_clone_target" \
                                || echo "Warning: failed to clone ${repo.url} (auto-clone '${name}')"
                            fi
                          '') cfg.settings.autoCloneRepos
                        )}
      '';
      deps = [
        "setupSecrets"
      ];
    };

    # Ensure the container service depends on configuration being ready
    systemd.services."${cfg.backend}-agentbox" = {
      # Start after the socket proxy (when enabled) so DOCKER_HOST is reachable.
      after = [
        "network-online.target"
        "agentbox-image-load.service"
      ]
      ++ lib.optional cfg.settings.dockerProxy.enable "${cfg.backend}-agentbox-docker-proxy.service";
      wants = [
        "network-online.target"
        "agentbox-image-load.service"
      ]
      ++ lib.optional cfg.settings.dockerProxy.enable "${cfg.backend}-agentbox-docker-proxy.service";
      # Restart policy
      serviceConfig = {
        Restart = lib.mkForce "always";
        RestartSec = "10s";
      };
    };

    # Tie the socket proxy's lifecycle to the main container. The proxy exists
    # solely to serve agentbox, so an explicit stop/restart of docker-agentbox
    # should tear it down too rather than leaving it listening on
    # 127.0.0.1:2375 with no consumer. `PartOf` propagates stop/restart only;
    # the main unit's `wants`+`after` still start-orders the proxy first, and a
    # crash-loop auto-restart of agentbox won't needlessly bounce the proxy.
    systemd.services."${cfg.backend}-agentbox-docker-proxy" = lib.mkIf cfg.settings.dockerProxy.enable {
      partOf = [ "${cfg.backend}-agentbox.service" ];
    };
  };
}
