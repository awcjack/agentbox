# Shared agentbox option schema, imported by BOTH the NixOS and nix-darwin
# modules. Defines the full `services.agentbox.settings` sandbox schema plus the
# generic extension surface (extraEnvironment / extraVolumes / extraActivation)
# that optional add-on modules can hook into. Platform modules add only their
# OS-specific top-level options + config.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.agentbox;
in
{
  options.services.agentbox = {
    # ── Generic extension surface ──────────────────────────────────────────
    # Optional add-on modules contribute to the container through these instead
    # of editing the platform config bodies. Both the NixOS and darwin config
    # bodies fold them into the running container.
    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        EXTRA_FLAG = "1";
      };
      description = "Extra non-secret environment variables merged into the container environment.";
    };

    extraVolumes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/var/lib/agentbox/extra:/home/agent/extra" ];
      description = "Extra volume mounts ('src:dst[:opts]') appended to the container.";
    };

    extraActivation = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Extra shell run during host activation (after the agentbox data dirs/config are set up). Used by add-on modules to create dirs or stage files.";
    };

    bootScripts = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      default = { };
      example = {
        my-service = "exec my-daemon --port 1234";
      };
      description = ''
        Shell snippets to run as the agent user in the background at container
        boot, keyed by name. Each is written to a boot.d script the entrypoint
        launches — use this to start an extra agent/service baked in via
        `extraPackages` (the image bundles no agent-specific startup of its own).
        The container is kept alive while any boot script runs.
      '';
    };

    settings = {
      timezone = lib.mkOption {
        type = lib.types.str;
        default = "UTC";
        example = "Asia/Hong_Kong";
        description = "Timezone for the container.";
      };

      cpuLimits = lib.mkOption {
        type = lib.types.int;
        default = 4;
        description = "CPU limit for the container.";
      };

      memoryLimits = lib.mkOption {
        type = lib.types.str;
        default = "4G";
        description = "Memory limit for the container.";
      };

      enableOpencode = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Enable OpenCode service.";
      };

      enableClaudeCode = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Enable standalone Claude Code (installed at runtime via the native installer; sets ENABLE_CLAUDE_CODE).";
      };

      enableCodex = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Enable the Codex CLI (bundled in the image from nixpkgs; sets ENABLE_CODEX). Provide auth (e.g. OPENAI_API_KEY) via the secret environmentFile.";
      };

      enableDocker = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Enable Docker daemon inside the container (Docker-in-Docker). On NixOS this runs the container --privileged; on macOS it is wired the same way against the host Docker runtime.";
      };

      enableNotification = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Surface "Claude task done" / "Claude needs attention" alerts on the host.
          The in-container hooks write signal files; the host watches them and
          notifies natively — osascript on macOS, notify-send (libnotify) on Linux.
        '';
      };

      # Container→host isolation knobs. The agent is autonomous and may be
      # prompt-injected, so the goal is to keep a kernel-level escape hard while
      # leaving the in-container dev workflow (sudo, installs) intact.
      hardening = {
        seccompProfile = lib.mkOption {
          type = lib.types.str;
          default = "default";
          example = "unconfined";
          description = ''
            Seccomp profile for the agentbox container (maps to `docker run
            --security-opt seccomp=`).
              "default"    — Docker's built-in default profile (recommended).
                             Blocks the ~44 most dangerous syscalls while still
                             permitting normal dev work, sudo, and compilers.
              "unconfined" — disable syscall filtering entirely. Widest kernel
                             attack surface; only use if a specific tool needs a
                             syscall the default profile blocks.
              <path>       — path to a custom seccomp JSON profile on the host.
          '';
        };

        noNewPrivileges = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Add `--security-opt no-new-privileges`, which blocks privilege
            escalation through setuid binaries. Left OFF by default because it
            also disables in-container `sudo`, which this sandbox intentionally
            allows. Turn it on for a stronger escape boundary when the box does
            not need sudo.
          '';
        };
      };

      claudeCodeVersion = lib.mkOption {
        type = lib.types.str;
        default = "latest";
        example = "2.1.92";
        description = "Claude Code version to install via the official native installer (CLAUDE_CODE_VERSION). Use 'latest' or 'stable' for a release channel, or an exact version like '2.1.92'. After install, Claude Code's native self-updater keeps it current.";
      };
      sessionWorkingDirectory = lib.mkOption {
        type = lib.types.str;
        default = "/workspace";
        description = "Working directory for Claude Code sessions.";
      };

      goprivate = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "github.com/myorg/*";
        description = "GOPRIVATE environment variable for private Go modules.";
      };

      # Claude Code configuration
      claudeConfig = {
        mcpServers = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = { };
          description = "MCP servers configuration for Claude Code.";
        };

        hooks = lib.mkOption {
          type = lib.types.attrsOf (lib.types.listOf lib.types.anything);
          # Each hook must be an object { type = "command"; command = "..."; } —
          # Claude Code does not accept bare command strings.
          default = {
            PreToolUse = [
              {
                matcher = "Bash";
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/dangerous-command-blocker.sh";
                  }
                ];
              }
              {
                matcher = "Bash(git commit*)";
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/pre-commit-lint.sh";
                  }
                  {
                    type = "command";
                    command = "/home/agent/.hooks/secret-scanner.sh";
                  }
                  # Gitleaks pre-commit guard (baked into the agentbox skel-dir).
                  # Blocks `git commit` when staged content matches a secret pattern.
                  {
                    type = "command";
                    command = "/home/agent/.claude/hooks/gitleaks-precommit.sh";
                  }
                ];
              }
              {
                matcher = "Bash(git push*)";
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/secret-scanner.sh";
                  }
                ];
              }
            ];
            PostToolUse = [
              {
                matcher = "Edit|Write|MultiEdit";
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/pre-compile-check.sh";
                  }
                  {
                    type = "command";
                    command = "/home/agent/.hooks/build-validator.sh";
                  }
                  # Baked into the agentbox image skel-dir; runs language-aware
                  # tests after every file edit and surfaces real failures back
                  # to Claude (infrastructure-only failures are filtered).
                  {
                    type = "command";
                    command = "/home/agent/.claude/hooks/test-runner.sh";
                  }
                ];
              }
              # Matcher-less (every tool): once any tool runs, Claude has resumed
              # work, so undo the freeze a permission/idle Notification may have
              # set. This flips the window off "🔔 needs you" back to live title
              # tracking after you approve a permission — there is no
              # UserPromptSubmit in that flow to do it.
              {
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/claude-working.sh";
                  }
                ];
              }
            ];
            UserPromptSubmit = [
              {
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/claude-prompt-start.sh";
                  }
                ];
              }
            ];
            Stop = [
              {
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/notify.sh";
                  }
                ];
              }
            ];
            # Fires on permission_prompt only (idle_prompt is suppressed in the
            # script — it fires after Stop and on new sessions, which would
            # override "✅ done" or leave a fresh window stuck on "🔔 needs you").
            Notification = [
              {
                hooks = [
                  {
                    type = "command";
                    command = "/home/agent/.hooks/claude-waiting.sh";
                  }
                ];
              }
            ];
          };
          description = "Hook configuration for Claude Code.";
        };

        permissions = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = {
            defaultMode = "auto";
            allow = [
              "Bash(npm *)"
              "Bash(npx *)"
              "Bash(bun *)"
              "Bash(go *)"
              "Bash(make *)"
              "Bash(git *)"
              "Bash(gh *)"
              "Bash(docker *)"
              "Bash(docker-compose *)"
              "Bash(ls *)"
              "Bash(pwd)"
              "Bash(mkdir *)"
              "Bash(rm *)"
              "Bash(cp *)"
              "Bash(mv *)"
              "Bash(chmod *)"
              "Bash(cat *)"
              "Bash(head *)"
              "Bash(tail *)"
              "Bash(grep *)"
              "Bash(find *)"
              "Bash(wc *)"
              "Bash(sort *)"
              "Bash(uniq *)"
              "Bash(diff *)"
              "Bash(curl *)"
              "Bash(wget *)"
              "Bash(python *)"
              "Bash(python3 *)"
              "Bash(pip *)"
              "Bash(pip3 *)"
              "Bash(cargo *)"
              "Bash(rustc *)"
              "Bash(swift *)"
              "Bash(swiftc *)"
              # Re-allow harmless template / public files that the deny
              # patterns below would otherwise capture. Each tool that has a
              # broad deny (Grep, Bash cat/head/tail) needs its own specific
              # allow entry here — the deny is more specific than the blanket
              # Bash(cat *) / Bash(grep *) allows, so those blanket entries
              # cannot rescue .env.example on their own.
              "Read(**/.env.example)"
              "Read(**/.env.sample)"
              "Read(**/.env.template)"
              "Grep(**/.env.example)"
              "Grep(**/.env.sample)"
              "Grep(**/.env.template)"
              "Bash(cat **/.env.example)"
              "Bash(cat **/.env.sample)"
              "Bash(cat **/.env.template)"
              "Bash(head **/.env.example)"
              "Bash(head **/.env.sample)"
              "Bash(head **/.env.template)"
              "Bash(tail **/.env.example)"
              "Bash(tail **/.env.sample)"
              "Bash(tail **/.env.template)"
              # Allow writing / editing template files — the Edit deny above
              # covers .env.* broadly, so Write and Edit need explicit rescues
              # just like Read/Grep/Bash do.
              "Write(**/.env.example)"
              "Write(**/.env.sample)"
              "Write(**/.env.template)"
              "Edit(**/.env.example)"
              "Edit(**/.env.sample)"
              "Edit(**/.env.template)"
              "Bash(tee **/.env.example)"
              "Bash(tee **/.env.sample)"
              "Bash(tee **/.env.template)"
              "Read(**/*.pub)"
            ];
            deny = [
              "Bash(sudo *)"
              "Bash(su *)"
              "Bash(rm -rf /)"
              "Bash(rm -rf /*)"
              "Bash(chmod 777 *)"
              # Secret-file denylist (defense-in-depth at the harness layer).
              # Each tool is denied separately — Claude Code does not propagate
              # a Read deny to Grep / Glob / Bash-via-cat.
              "Read(**/.env)"
              "Read(**/.env.*)"
              "Read(**/*.pem)"
              "Read(**/*.key)"
              "Read(**/id_rsa)"
              "Read(**/id_rsa.*)"
              "Read(**/id_ed25519)"
              "Read(**/id_ed25519.*)"
              "Read(**/.ssh/**)"
              "Read(**/.aws/credentials)"
              "Read(**/.aws/**)"
              "Read(**/.netrc)"
              "Read(**/.npmrc)"
              "Read(**/.kube/config)"
              "Read(**/.kube/**)"
              "Read(**/.config/gcloud/**)"
              "Read(**/secrets/**)"
              "Read(**/credentials.json)"
              "Read(**/service-account*.json)"
              "Edit(**/.env)"
              "Edit(**/.env.*)"
              "Edit(**/*.pem)"
              "Edit(**/*.key)"
              "Edit(**/id_rsa*)"
              "Edit(**/id_ed25519*)"
              "Edit(**/.ssh/**)"
              "Edit(**/.aws/credentials)"
              "Edit(**/.config/gcloud/**)"
              "Edit(**/.kube/config)"
              "Edit(**/secrets/**)"
              "Glob(**/.env)"
              "Glob(**/.env.*)"
              "Glob(**/*.pem)"
              "Glob(**/*.key)"
              "Glob(**/.ssh/**)"
              "Glob(**/secrets/**)"
              "Grep(**/.env)"
              "Grep(**/.env.*)"
              "Grep(**/*.pem)"
              "Grep(**/*.key)"
              "Grep(**/.ssh/**)"
              "Grep(**/secrets/**)"
              "Bash(cat *.env*)"
              "Bash(cat **/.env*)"
              "Bash(cat *.pem)"
              "Bash(cat **/*.pem)"
              "Bash(cat *.key)"
              "Bash(cat **/*.key)"
              "Bash(cat **/id_rsa*)"
              "Bash(cat **/id_ed25519*)"
              "Bash(cat **/.ssh/**)"
              "Bash(cat **/.aws/credentials)"
              "Bash(cat **/.config/gcloud/**)"
              "Bash(cat **/.kube/config)"
              "Bash(cat **/.netrc)"
              "Bash(head **/.env*)"
              "Bash(tail **/.env*)"
              # Extra read-vector denials — block exfiltration of secret files by
              # encoding/dumping (base64/xxd/od/hexdump/strings) or copying them
              # out (cp), plus git-credentials.
              "Bash(base64 **/.ssh/**)"
              "Bash(base64 **/*.pem)"
              "Bash(base64 **/*.key)"
              "Bash(base64 **/.env*)"
              "Bash(base64 **/.aws/**)"
              "Bash(base64 **/.config/gcloud/**)"
              "Bash(base64 **/.kube/**)"
              "Bash(xxd **/.ssh/**)"
              "Bash(xxd **/*.key)"
              "Bash(xxd **/*.pem)"
              "Bash(od **/.ssh/**)"
              "Bash(hexdump **/.ssh/**)"
              "Bash(strings **/.ssh/**)"
              "Bash(strings **/*.key)"
              "Bash(less **/.ssh/**)"
              "Bash(more **/.ssh/**)"
              "Bash(nl **/.ssh/**)"
              "Bash(tac **/.ssh/**)"
              "Bash(cp **/.ssh/**)"
              "Bash(cp **/.aws/**)"
              "Bash(cp **/.config/gcloud/**)"
              "Bash(cp **/.kube/**)"
              "Bash(cat **/.git-credentials)"
              "Read(**/.git-credentials)"
            ];
          };
          description = "Permission configuration for Claude Code.";
          # NB: deny extras above are unconditional (applied on both platforms).
        };
      };

      # OpenCode configuration
      opencodeConfig = {
        defaultAgent = lib.mkOption {
          type = lib.types.str;
          default = "Orchestrator";
          description = "Default agent for OpenCode.";
        };

        defaultModel = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "provider/model-name";
          description = "Default model for OpenCode (provider/model format).";
        };

        plugins = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [
            "opencode-gemini-auth"
            # Use absolute paths for file:// plugins
            "file:///home/agent/.config/opencode/plugins/static-check.ts"
            "file:///home/agent/.config/opencode/plugins/pre-commit-lint.ts"
            "file:///home/agent/.config/opencode/plugins/secret-scanner.ts"
            "file:///home/agent/.config/opencode/plugins/dangerous-command-blocker.ts"
            "file:///home/agent/.config/opencode/plugins/build-validator.ts"
            # Gitleaks pre-commit guard — aborts `git commit` bash calls when
            # staged content matches a secret pattern (uses tool.execute.before).
            "file:///home/agent/.config/opencode/plugins/gitleaks-precommit.ts"
          ];
          description = "List of OpenCode plugins.";
        };

        permission = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = {
            bash = {
              "sudo *" = "deny";
            };
            # Secret-file denylist for OpenCode. OpenCode's wildcard matcher
            # (packages/opencode/src/util/wildcard.ts) supports only `*` and
            # `?` — no `**` — but `*` is greedy across `/`, so a single `*`
            # already matches arbitrary directory prefixes.
            # Last match wins via length-asc sort, so longer allow rules
            # below correctly override shorter deny rules above.
            read = {
              "*/.env" = "deny";
              "*/.env.*" = "deny";
              "*/.env.example" = "allow";
              "*/.env.sample" = "allow";
              "*/.env.template" = "allow";
              "*/*.pem" = "deny";
              "*/*.pub" = "allow";
              "*/*.key" = "deny";
              "*/id_rsa" = "deny";
              "*/id_rsa.*" = "deny";
              "*/id_ed25519" = "deny";
              "*/id_ed25519.*" = "deny";
              "*/id_ecdsa" = "deny";
              "*/id_ecdsa.*" = "deny";
              "*/.ssh/*" = "deny";
              "*/.aws/credentials" = "deny";
              "*/.aws/*" = "deny";
              "*/.netrc" = "deny";
              "*/.npmrc" = "deny";
              "*/.pypirc" = "deny";
              "*/.kube/config" = "deny";
              "*/.kube/*" = "deny";
              "*/.config/gcloud/*" = "deny";
              "*/secrets/*" = "deny";
              "*/credentials.json" = "deny";
              "*/service-account*.json" = "deny";
              "*/gcp-key*.json" = "deny";
              "*/*.gpg" = "deny";
              "*/*.asc" = "deny";
            };
            edit = {
              "*/.env" = "deny";
              "*/.env.*" = "deny";
              "*/.env.example" = "allow";
              "*/.env.sample" = "allow";
              "*/.env.template" = "allow";
              "*/*.pem" = "deny";
              "*/*.key" = "deny";
              "*/id_rsa*" = "deny";
              "*/id_ed25519*" = "deny";
              "*/.ssh/*" = "deny";
              "*/.aws/credentials" = "deny";
              "*/.config/gcloud/*" = "deny";
              "*/.kube/config" = "deny";
              "*/secrets/*" = "deny";
            };
          };
          description = "Permission configuration for OpenCode.";
        };

        agents = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = { };
          description = "Agent configuration for OpenCode.";
        };

        smallModel = lib.mkOption {
          type = lib.types.str;
          default = "zai-coding-plan/glm-4.7";
          description = "Small model for OpenCode.";
        };

        providers = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = { };
          example = {
            my-provider = {
              npm = "@ai-sdk/openai-compatible";
              options = {
                baseURL = "http://localhost:8000/v1";
              };
              models = {
                "my-provider/model-a" = {
                  name = "Model A";
                };
              };
            };
          };
          description = "Provider configuration for OpenCode (for custom OpenAI-compatible LLM providers).";
        };
      };

      # Git configuration
      gitConfig = lib.mkOption {
        type = lib.types.lines;
        default = ''
          [user]
              name = Agent
              email = agent@localhost
        '';
        description = "Git configuration content.";
      };

      # Tmux configuration. Defaults enable the escape sequences Claude Code
      # relies on inside tmux: `allow-passthrough` lets desktop notification
      # and progress-bar escapes reach the outer terminal, and the
      # extended-keys settings let tmux distinguish Shift+Enter from Enter.
      tmuxConfig = lib.mkOption {
        type = lib.types.lines;
        default = ''
          set -g allow-passthrough on
          set -g allow-rename on
          setw -g automatic-rename on
          # Track Claude Code's OSC 2 title (the conversation summary) but cap the
          # window name so a long summary — e.g. what you see when resuming a
          # session without typing a new prompt — does not crowd the status bar.
          # The trailing … marks truncation (tmux >= 3.4). Hook-set names like
          # "✅ done" / "🔔 needs you" bypass this format (automatic-rename off).
          setw -g automatic-rename-format "#{=/15/…:pane_title}"
          set -s extended-keys on
          set -as terminal-features 'xterm*:extkeys'
          # Pin a stable window title (useful on macOS native terminals; harmless
          # elsewhere). Hook-set names still override via automatic-rename off.
          set -g set-titles on
          set -g set-titles-string "agentbox ❯ #{window_name}"
        '';
        description = "Tmux configuration content (~/.tmux.conf inside the container).";
      };

      # SSH key for git auth. Written into ${"\${cfg.dataDir}"}/home/.ssh/
      # which is bind-mounted to /home/agent/.ssh inside the container, so
      # the same key drives both host-side auto-clone and container-side
      # clone/push.
      sshPrivateKeyPath = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."ssh_private_key".path'';
        description = ''
          Path to a file containing the private SSH key used for git over
          SSH. Typically a sops-nix secret path. Installed to
          ${"\${cfg.dataDir}"}/home/.ssh/id_ed25519 with mode 0600 owned by
          the agent user.
        '';
      };

      sshPublicKey = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "ssh-ed25519 AAAA... agent@host";
        description = ''
          Optional plain-text public key. When set, written to
          ${"\${cfg.dataDir}"}/home/.ssh/id_ed25519.pub. Not sensitive — a
          regular Nix string is fine, no sops needed.
        '';
      };

      sshKnownHosts = lib.mkOption {
        type = lib.types.lines;
        default = ''
          github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
        '';
        description = ''
          Content written to ${"\${cfg.dataDir}"}/home/.ssh/known_hosts so
          non-interactive clones succeed without host-key prompts. Defaults
          to GitHub's ed25519 host key.
        '';
      };

      # ──────────────────────────────────────────────────────────────────────
      # Cloud credentials (AWS / GCP / Kubernetes)
      #
      # All three follow the same pattern as sshPrivateKeyPath: point each
      # option at a sops-decrypted file, and the activation script installs it
      # under ${"\${cfg.dataDir}"}/home with mode 0600 and bind-mounts the
      # single file read-only into the container. Defaults are null, so leaving
      # them unset is a no-op (no mounts, no behaviour change).
      #
      # Safety guidance (see also docs/agentbox-cloud-credentials.md):
      #   - Use DEDICATED, READ-ONLY scoped credentials (e.g. GCP
      #     roles/logging.viewer, an AWS read-only IAM policy). The agent runs
      #     autonomously, so the blast radius is whatever these creds can do.
      #   - Prefer short-lived credentials where practical (AWS STS session
      #     tokens, federated GCP identity) and rotate the static keys.
      #   - The files are mounted read-only and the agent harness denylist
      #     blocks the model from reading ~/.aws, ~/.config/gcloud, ~/.kube.
      # ──────────────────────────────────────────────────────────────────────

      awsCredentialsPath = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."agentbox_aws_credentials".path'';
        description = ''
          Path to a file in AWS shared-credentials INI format. Installed to
          ${"\${cfg.dataDir}"}/home/.aws/credentials (mode 0600) and
          bind-mounted read-only at /home/agent/.aws/credentials, where the
          aws CLI reads it natively.
        '';
      };

      awsConfig = lib.mkOption {
        type = lib.types.lines;
        default = "";
        example = ''
          [default]
          region = ap-east-1
          output = json
        '';
        description = ''
          Non-secret AWS CLI config (region / output / profiles). When
          non-empty, written to ${"\${cfg.dataDir}"}/home/.aws/config and
          bind-mounted read-only. A plain Nix string is fine — no sops needed.
        '';
      };

      gcpServiceAccountKeyPath = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."agentbox_gcp_sa_key".path'';
        description = ''
          Path to a GCP service-account key JSON. Installed to
          ${"\${cfg.dataDir}"}/home/.config/gcloud/sa-key.json (mode 0600) and
          bind-mounted read-only. When set, GOOGLE_APPLICATION_CREDENTIALS is
          exported to that path so client libraries and the GKE auth plugin
          use it. For `gcloud` CLI commands, run once inside the box:
          `gcloud auth activate-service-account --key-file=$GOOGLE_APPLICATION_CREDENTIALS`.
          Only the single key file is mounted (not the whole gcloud dir), so
          gcloud's own writable state under ~/.config/gcloud is unaffected.
        '';
      };

      gcpProject = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "my-gcp-project";
        description = ''
          Default GCP project (CLOUDSDK_CORE_PROJECT). Non-secret. Only applied
          when gcpServiceAccountKeyPath is set.
        '';
      };

      kubeConfigPath = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = lib.literalExpression ''config.sops.secrets."agentbox_kubeconfig".path'';
        description = ''
          Path to a kubeconfig file. Installed to
          ${"\${cfg.dataDir}"}/home/.kube/config (mode 0600) and bind-mounted
          read-only at /home/agent/.kube/config. For GKE clusters, the
          kubeconfig's exec auth plugin (gke-gcloud-auth-plugin) is baked into
          the image and uses the GCP credentials above.
        '';
      };

      # ──────────────────────────────────────────────────────────────────────
      # Docker socket proxy (read-only / "logs but not create")
      #
      # The raw Docker socket is NEVER mounted into agentbox — that would be
      # equivalent to host root (the Engine API has no per-verb authz). Instead,
      # when enabled, a wollomatic/socket-proxy sidecar holds the only mount of
      # the real socket and re-serves a TCP endpoint on 127.0.0.1:2375 that only
      # matches an explicit route allowlist. agentbox is pointed at it via
      # DOCKER_HOST. Default-deny: any method/route not in allow{GET,HEAD} (and
      # all POST/PUT/DELETE) is rejected, so `docker logs`/`ps`/inspect work but
      # `docker run`/`exec`/`build` do not. See docs/agentbox-cloud-credentials.md.
      # ──────────────────────────────────────────────────────────────────────
      dockerProxy = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Run the restricted docker-socket proxy sidecar and point agentbox at it.";
        };

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/wollomatic/socket-proxy:1";
          description = "Container image for the socket proxy (route-level allowlist, default-deny).";
        };

        socketPath = lib.mkOption {
          type = lib.types.str;
          default = "/var/run/docker.sock";
          example = "/run/user/1000/docker.sock";
          description = ''
            Host path of the real Docker socket, mounted read-only into the
            proxy at /var/run/docker.sock. NOTE: this module enables rootless
            Docker, whose socket is usually at /run/user/<uid>/docker.sock — set
            this accordingly on rootless hosts.
          '';
        };

        allowFrom = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1/32";
          description = "CIDR allowed to connect to the proxy (-allowfrom). Keep it loopback-only.";
        };

        user = lib.mkOption {
          type = lib.types.str;
          default = "0:0";
          description = ''
            User the proxy container runs as (--user). Defaults to root because
            wollomatic/socket-proxy's image runs as non-root (65534) and the
            Docker socket is typically root-owned, giving "connect: permission
            denied". The proxy already has full socket access by design — the
            route allowlist, not the container UID, is the boundary. Set to a
            non-root "uid:gid" in the socket's group where that gid is known
            (e.g. on a rootless host pointing at /run/user/<uid>/docker.sock).
          '';
        };

        allowGET = lib.mkOption {
          type = lib.types.str;
          # RE2 (Go regexp) matched against the request URI path. Allows:
          #   /_ping, /version                      (CLI API negotiation)
          #   /containers/json                      (docker ps)
          #   /containers/<id>/{json,logs,top,stats}(inspect / logs / top / stats)
          # The optional /v1.NN prefix and trailing query string are tolerated.
          # Deliberately EXCLUDES /containers/<id>/{archive,export} (file
          # exfiltration) and everything under images/exec/build/etc.
          default = ''^(/v[0-9.]+)?/(_ping|version)$|^(/v[0-9.]+)?/containers/json(\?.*)?$|^(/v[0-9.]+)?/containers/[a-zA-Z0-9_.-]+/(json|logs|top|stats)(\?.*)?$'';
          description = "Regexp (-allowGET) of permitted GET routes. Default = list/inspect/logs only.";
        };

        allowHEAD = lib.mkOption {
          type = lib.types.str;
          default = "^(/v[0-9.]+)?/_ping$";
          description = "Regexp (-allowHEAD) of permitted HEAD routes (the docker CLI HEADs /_ping).";
        };

        extraArgs = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [ "-allowPOST=^(/v[0-9.]+)?/containers/[a-z0-9]+/(start|stop)$" ];
          description = "Extra flags appended to the socket-proxy command (e.g. to allow more routes).";
        };
      };

      # Auto-clone repositories into the workspace on activation.
      autoCloneRepos = lib.mkOption {
        type = lib.types.attrsOf (
          lib.types.submodule {
            options = {
              url = lib.mkOption {
                type = lib.types.str;
                example = "git@github.com:org/repo.git";
                description = ''
                  Git remote URL to clone. Prefer `git@…` SSH URLs so the
                  configured SSH private key is used; HTTPS URLs still
                  work but require a separate credential helper.
                '';
              };
              dest = lib.mkOption {
                type = lib.types.str;
                example = "work/repo";
                description = ''
                  Destination relative to the workspace directory
                  (mounted at /workspace inside the container).
                '';
              };
              branch = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Branch to check out (defaults to remote HEAD).";
              };
            };
          }
        );
        default = { };
        example = {
          repo = {
            url = "git@github.com:org/repo.git";
            dest = "work/repo";
          };
        };
        description = ''
          Repositories to auto-clone into the workspace on activation. Empty by
          default. A repo is cloned only when its destination has no `.git`
          directory, so existing local work is never overwritten.
        '';
      };
    };
  };

  # `bootScripts` is sugar over the extension surface: write each snippet to a
  # boot.d script under dataDir and mount it read-only into the container, where
  # the entrypoint launches it as the agent user at boot. Works on both
  # platforms because the platform config bodies already fold extraVolumes /
  # extraActivation into the container.
  config = lib.mkIf (cfg.bootScripts != { }) {
    services.agentbox.extraVolumes = [
      "${cfg.dataDir}/boot.d:/home/agent/.agentbox/boot.d:ro"
    ];
    services.agentbox.extraActivation = ''
      mkdir -p "${cfg.dataDir}/boot.d"
      rm -f "${cfg.dataDir}/boot.d"/*.sh
      ${lib.concatStringsSep "\n" (
        lib.mapAttrsToList (
          name: text:
          ''cp -f ${pkgs.writeShellScript "agentbox-boot-${name}" text} "${cfg.dataDir}/boot.d/${name}.sh"''
        ) cfg.bootScripts
      )}
      chmod 755 "${cfg.dataDir}/boot.d"/*.sh 2>/dev/null || true
    '';
  };
}
