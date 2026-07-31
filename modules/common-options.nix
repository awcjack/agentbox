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

  # Shared secret-path vocabulary translated into each harness's matcher
  # syntax below. Keep templates out so .env.example/.sample/.template remain
  # usable.
  secretPathPatterns = [
    ".env"
    ".env.local"
    ".env*local*"
    ".env*dev*"
    ".env*prod*"
    ".env*stag*"
    ".env*test*"
    "values*dev*"
    "values*prod*"
    "values*stag*"
    "values*test*"
    "*secret*.yaml"
    "*secret*.yml"
    "*.pem"
    "*.key"
    "id_rsa*"
    "id_ed25519*"
    "id_ecdsa*"
    ".ssh/*"
    ".aws/*"
    ".config/gcloud/*"
    ".kube/*"
    ".netrc"
    ".npmrc"
    ".pypirc"
    ".git-credentials"
    "credentials.json"
    "service-account*.json"
    "gcp-key*.json"
    "*.gpg"
    "*.asc"
    "secrets/*"
  ];
  opencodeSecretPatterns = map (pattern: "*${pattern}") secretPathPatterns;
  opencodeSecretRules = lib.genAttrs opencodeSecretPatterns (_: "deny");
  opencodeTemplateRules = {
    "*.env.example" = "allow";
    "*.env.sample" = "allow";
    "*.env.template" = "allow";
  };
  opencodeReadRules = opencodeSecretRules // opencodeTemplateRules // { "*.pub" = "allow"; };
  opencodeEditRules = opencodeSecretRules // opencodeTemplateRules;

  # OpenCode shell permissions match command strings, so mirror Claude's
  # reader/filter/editor/copy matrix in addition to native read/edit denies.
  secretExfilCommands = [
    "cat"
    "head"
    "tail"
    "base64"
    "sed"
    "awk"
    "grep"
    "egrep"
    "fgrep"
    "rg"
    "ag"
    "nl"
    "tac"
    "rev"
    "cut"
    "tr"
    "fold"
    "expand"
    "paste"
    "column"
    "col"
    "less"
    "more"
    "most"
    "pg"
    "xxd"
    "od"
    "hexdump"
    "strings"
    "base32"
    "uuencode"
    "vi"
    "vim"
    "nvim"
    "nano"
    "ex"
    "view"
    "emacs"
    "dd"
    "cp"
    "mv"
    "install"
    "rsync"
    "ln"
  ];
  opencodeSecretBashRules = lib.listToAttrs (
    lib.concatMap (
      command: map (pattern: lib.nameValuePair "${command} ${pattern}" "deny") opencodeSecretPatterns
    ) secretExfilCommands
  );
  codexDenyRead =
    map (pattern: "/workspace/**/${pattern}") secretPathPatterns
    ++ map (pattern: "/home/agent/**/${pattern}") secretPathPatterns;
  codexRiskPolicy = ''
    Never approve credential disclosure, attempts to read denied secret paths,
    destructive operations outside the user's stated intent, or bypasses of
    configured safety controls. Treat production deployments, migrations,
    infrastructure mutations, force pushes, and uploads of private workspace
    data as high risk unless the user explicitly authorized the exact action.
  '';
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

      pidsLimit = lib.mkOption {
        type = lib.types.int;
        default = 2048;
        description = ''
          PID limit for the container (docker --pids-limit). Caps runaway
          process spawning (e.g. a daemon fork loop) so it can't exhaust the
          host/VM's PIDs and freeze everything outside the container.
        '';
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

      enableCloudTools = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Include cloud CLIs in the image: awscli2, kubectl, kubernetes-helm,
          google-cloud-sdk (with gke-gcloud-auth-plugin), and docker-client.
          Disabled by default to keep the base image lean. When true, the NixOS
          module builds the image with `.override { withCloudTools = true; }`.
          On Darwin, rebuild the image on a Linux host with the same flag.
        '';
      };

      enableNix = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Bake the `nix` CLI into the image and start a `nix-daemon` at boot so
          the agent can install throwaway packages in-container with
          `nix profile install nixpkgs#<pkg>` or `nix shell nixpkgs#<pkg>`.
          There is no apt/dpkg in this image, so nix is the package manager.
          Installed packages live in the container's writable layer and are lost
          when it is recreated. On by default; when false the NixOS module builds
          the image with `.override { withNix = false; }` to keep it lean (and
          ENABLE_NIX is set false so the daemon does not start). On Darwin,
          rebuild the image on a Linux host with the matching flag.
        '';
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

      historyArchive = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = ''
            Enable explicit, user-requested conversation archive intents. This
            only exposes a host-visible request inbox; it does not give the
            container object-storage credentials or upload transcripts.
          '';
        };

        hostId = lib.mkOption {
          type = lib.types.either (lib.types.enum [ "" ]) (
            lib.types.strMatching "[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
          );
          default = "";
          example = "home-macbook";
          description = "Opaque producer host ID included in archive requests.";
        };

        requestTtlSeconds = lib.mkOption {
          type = lib.types.ints.between 60 3600;
          default = 900;
          description = "Time allowed for a completion event to resolve an archive intent.";
        };
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

        enableSudo = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Set up a working setuid `sudo` for the agent user at container
            start (passwordless). Because Nix store paths can't carry setuid
            bits and there is no `security.wrappers` activation inside the
            container, the entrypoint stages a setuid-root copy of sudo under
            /run/wrappers/bin — this option gates that step (maps to
            ENABLE_SUDO). On by default, matching this sandbox's intent to keep
            the in-container dev workflow (sudo, installs) intact; the real
            trust boundary is the container itself. Note `noNewPrivileges = true`
            disables sudo at the kernel level regardless of this flag.
          '';
        };
      };

      claudeCodeVersion = lib.mkOption {
        type = lib.types.str;
        default = "latest";
        example = "2.1.92";
        description = "Claude Code version to install via the official native installer (CLAUDE_CODE_VERSION). Use 'latest' or 'stable' for a release channel, or an exact version like '2.1.92'. After install, Claude Code's native self-updater keeps it current.";
      };

      # Codex CLI configuration
      codexConfig = {
        settings = lib.mkOption {
          type = (pkgs.formats.toml { }).type;
          default = {
            approval_policy = "on-request";
            approvals_reviewer = "auto_review";
            sandbox_mode = "workspace-write";
            auto_review.policy = codexRiskPolicy;
          };
          example = {
            model_reasoning_effort = "high";
          };
          description = ''
            Declarative settings deep-merged into ~/.codex/config.toml on each
            activation. Codex-owned keys not declared here are preserved.
            Agentbox reserves the root notify key for its notification bridge.
          '';
        };

        requirements = lib.mkOption {
          type = (pkgs.formats.toml { }).type;
          default = {
            allowed_approval_policies = [ "on-request" ];
            allowed_approvals_reviewers = [ "auto_review" ];
            # Codex requires read-only to remain available when permission
            # profiles are constrained; danger-full-access stays prohibited.
            allowed_sandbox_modes = [
              "read-only"
              "workspace-write"
            ];
            guardian_policy_config = codexRiskPolicy;
            permissions.filesystem.deny_read = codexDenyRead;
            rules.prefix_rules = [
              {
                pattern = [ { token = "sudo"; } ];
                decision = "forbidden";
                justification = "Agentbox does not allow Codex to invoke sudo.";
              }
              {
                pattern = [ { token = "su"; } ];
                decision = "forbidden";
                justification = "Agentbox does not allow Codex to switch users.";
              }
              {
                pattern = [
                  { token = "rm"; }
                  {
                    any_of = [
                      "-rf"
                      "-fr"
                    ];
                  }
                  {
                    any_of = [
                      "/"
                      "/*"
                    ];
                  }
                ];
                decision = "forbidden";
                justification = "Deleting the filesystem root is prohibited.";
              }
              {
                pattern = [
                  { token = "chmod"; }
                  { token = "777"; }
                ];
                decision = "forbidden";
                justification = "World-writable permissions are prohibited.";
              }
            ];
          };
          description = ''
            Managed Codex policy written root-owned to /etc/codex/requirements.toml.
            It enforces the automatic reviewer, excludes danger-full-access, and
            applies the Claude-equivalent credential deny list at sandbox level.
          '';
        };
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
                    command = "/home/agent/.claude/hooks/archive-request-cancel.sh";
                  }
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
                  # Run tests for files changed since the last commit. Fires once
                  # per agent turn rather than after every individual file edit,
                  # reducing noise. Background-tasks guard prevents false runs when
                  # the turn merely paused waiting on background work.
                  {
                    type = "command";
                    command = "/home/agent/.claude/hooks/stop-test-runner.sh";
                  }
                  {
                    type = "command";
                    command = "/home/agent/.claude/hooks/archive-request-resolver.sh";
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
          default =
            let
              # Files whose contents are secrets (or secret-bearing). Enumerated
              # once so the read-vector deny matrix below cannot drift out of sync
              # with the hand-written cat/head/tail/base64 entries. NB: uses
              # concrete variants (never a blanket .env.*) so templates like
              # .env.example stay readable.
              secretFileGlobs = [
                "**/.env"
                "**/.env.local"
                "**/.env**local"
                "**/.env**dev**"
                "**/.env**prod**"
                "**/.env**stag**"
                "**/.env**test**"
                "**/values**dev**"
                "**/values**prod**"
                "**/values**stag**"
                "**/values**test**"
                "**/*secret*.yaml"
                "**/*secret*.yml"
                "**/*.pem"
                "**/*.key"
                "**/id_rsa*"
                "**/id_ed25519*"
                "**/.ssh/**"
                "**/.aws/**"
                "**/.config/gcloud/**"
                "**/.kube/**"
                "**/.netrc"
                "**/.npmrc"
                "**/.git-credentials"
                "**/credentials.json"
                "**/service-account*.json"
                "**/secrets/**"
              ];
              # Commands that reveal or relocate a file's contents. The old deny
              # list only enumerated cat/head/tail/base64, so sed/awk/grep (and
              # editors/pagers/copy) bypassed it — e.g. `sed -E '...' .env` read a
              # secret straight through. Generating cmd x glob keeps it exhaustive
              # and self-maintaining. Deny beats allow, so these are authoritative
              # even against the blanket Bash(cat *)/Bash(grep *) allows.
              secretExfilCmds = [
                # content readers / filters
                "sed"
                "awk"
                "grep"
                "egrep"
                "fgrep"
                "rg"
                "ag"
                "nl"
                "tac"
                "rev"
                "cut"
                "tr"
                "fold"
                "expand"
                "paste"
                "column"
                "col"
                # pagers
                "less"
                "more"
                "most"
                "pg"
                # binary / encoded dumps
                "xxd"
                "od"
                "hexdump"
                "strings"
                "base32"
                "uuencode"
                # editors (open == read)
                "vi"
                "vim"
                "nvim"
                "nano"
                "ex"
                "view"
                "emacs"
                # raw copy / relocate vectors (exfil by making a readable copy)
                "dd"
                "cp"
                "mv"
                "install"
                "rsync"
                "ln"
              ];
              secretExfilDeny = lib.concatMap (
                cmd: map (glob: "Bash(${cmd} ${glob})") secretFileGlobs
              ) secretExfilCmds;
            in
            {
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
                # Explicitly permit harmless template / public files. Because
                # deny ALWAYS beats allow (regardless of specificity), an allow
                # entry can never rescue a path that a deny also matches. So the
                # secret denylist below is deliberately enumerated to concrete
                # env/values variants (.env, .env.local, .env*dev*, values*prod*,
                # ...) and never uses a blanket .env.* — that is what leaves
                # .env.example / .sample / .template un-denied. These allow
                # entries then make the templates readable/writable per tool
                # (the blanket Bash(cat *) / Bash(grep *) allows above cannot
                # distinguish a template from a secret on their own).
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
                # Allow writing / editing template files. The Edit deny above is
                # enumerated to concrete secret variants (never a blanket .env.*),
                # so templates fall through; these explicit Edit allows make that
                # intent clear, just like Read/Grep/Bash above. Edit(path) rules
                # cover ALL file-editing tools (Write/MultiEdit/NotebookEdit) —
                # Write(path) rules are not matched by the permission checks at
                # all, so only Edit entries are listed.
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
                # Read(path) rules cover ALL file-reading tools (Read, Glob, and
                # friends) — Glob(path) rules are not matched by the permission
                # checks at all, so only Read entries are listed. Grep and
                # Bash-via-cat are NOT covered by Read denies and keep their own
                # explicit entries below.
                "Read(**/.env)"
                "Read(**/.env.local)"
                "Read(**/.env**local)"
                "Read(**/.env**dev**)"
                "Read(**/.env**prod**)"
                "Read(**/.env**stag**)"
                "Read(**/.env**test**)"
                "Read(**/values**dev**)"
                "Read(**/values**prod**)"
                "Read(**/values**stag**)"
                "Read(**/values**test**)"
                "Read(**/*secret*.yaml)"
                "Read(**/*secret*.yml)"
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
                "Edit(**/.env.local)"
                "Edit(**/.env**local)"
                "Edit(**/.env**dev**)"
                "Edit(**/.env**prod**)"
                "Edit(**/.env**stag**)"
                "Edit(**/.env**test**)"
                "Edit(**/values**dev**)"
                "Edit(**/values**prod**)"
                "Edit(**/values**stag**)"
                "Edit(**/values**test**)"
                "Edit(**/*secret*.yaml)"
                "Edit(**/*secret*.yml)"
                "Edit(**/*.pem)"
                "Edit(**/*.key)"
                "Edit(**/id_rsa*)"
                "Edit(**/id_ed25519*)"
                "Edit(**/.ssh/**)"
                "Edit(**/.aws/credentials)"
                "Edit(**/.config/gcloud/**)"
                "Edit(**/.kube/config)"
                "Edit(**/secrets/**)"
                "Grep(**/.env)"
                "Grep(**/.env.local)"
                "Grep(**/.env**local)"
                "Grep(**/.env**dev**)"
                "Grep(**/.env**prod**)"
                "Grep(**/.env**stag**)"
                "Grep(**/.env**test**)"
                "Grep(**/values**dev**)"
                "Grep(**/values**prod**)"
                "Grep(**/values**stag**)"
                "Grep(**/values**test**)"
                "Grep(**/*secret*.yaml)"
                "Grep(**/*secret*.yml)"
                "Grep(**/*.pem)"
                "Grep(**/*.key)"
                "Grep(**/.ssh/**)"
                "Grep(**/secrets/**)"
                "Bash(cat **/.env)"
                "Bash(cat **/.env.local)"
                "Bash(cat **/.env**local)"
                "Bash(cat **/.env**dev**)"
                "Bash(cat **/.env**prod**)"
                "Bash(cat **/.env**stag**)"
                "Bash(cat **/.env**test**)"
                "Bash(cat **/values**dev**)"
                "Bash(cat **/values**prod**)"
                "Bash(cat **/values**stag**)"
                "Bash(cat **/values**test**)"
                "Bash(cat **/*secret*.yaml)"
                "Bash(cat **/*secret*.yml)"
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
                "Bash(head **/.env)"
                "Bash(head **/.env.local)"
                "Bash(head **/.env**local)"
                "Bash(head **/.env**dev**)"
                "Bash(head **/.env**prod**)"
                "Bash(head **/.env**stag**)"
                "Bash(head **/.env**test**)"
                "Bash(head **/values**dev**)"
                "Bash(head **/values**prod**)"
                "Bash(head **/values**stag**)"
                "Bash(head **/values**test**)"
                "Bash(head **/*secret*.yaml)"
                "Bash(head **/*secret*.yml)"
                "Bash(tail **/.env)"
                "Bash(tail **/.env.local)"
                "Bash(tail **/.env**local)"
                "Bash(tail **/.env**dev**)"
                "Bash(tail **/.env**prod**)"
                "Bash(tail **/.env**stag**)"
                "Bash(tail **/.env**test**)"
                "Bash(tail **/values**dev**)"
                "Bash(tail **/values**prod**)"
                "Bash(tail **/values**stag**)"
                "Bash(tail **/values**test**)"
                "Bash(tail **/*secret*.yaml)"
                "Bash(tail **/*secret*.yml)"
                # Extra read-vector denials — block exfiltration of secret files by
                # encoding/dumping (base64/xxd/od/hexdump/strings) or copying them
                # out (cp), plus git-credentials.
                "Bash(base64 **/.ssh/**)"
                "Bash(base64 **/*.pem)"
                "Bash(base64 **/*.key)"
                "Bash(base64 **/.env)"
                "Bash(base64 **/.env.local)"
                "Bash(base64 **/.env**local)"
                "Bash(base64 **/.env**dev**)"
                "Bash(base64 **/.env**prod**)"
                "Bash(base64 **/.env**stag**)"
                "Bash(base64 **/.env**test**)"
                "Bash(base64 **/values**dev**)"
                "Bash(base64 **/values**prod**)"
                "Bash(base64 **/values**stag**)"
                "Bash(base64 **/values**test**)"
                "Bash(base64 **/*secret*.yaml)"
                "Bash(base64 **/*secret*.yml)"
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
              ]
              ++ secretExfilDeny;
            };
          description = "Permission configuration for Claude Code.";
          # NB: deny extras above are unconditional (applied on both platforms).
        };

        extraAllow = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [ "Read(**/internal-notes/**)" ];
          description = ''
            Per-host allow rules appended to permissions.allow in both
            settings.json and managed-settings.json. Lets a consumer extend the
            curated default without restating the whole list — the plain
            `default` attrset does not deep-merge, so a partial override of
            `permissions` would drop the rest of it.
          '';
        };

        extraDeny = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [ "Read(**/private/**)" ];
          description = ''
            Per-host deny rules appended to permissions.deny in both
            settings.json and managed-settings.json. Since Claude Code evaluates
            deny before allow, an entry here is authoritative.
          '';
        };
      };

      # OpenCode configuration
      opencodeConfig = {
        settings = lib.mkOption {
          type = (pkgs.formats.json { }).type;
          default = { };
          example = {
            instructions = [ "/workspace/AGENTS.md" ];
          };
          description = ''
            Additional declarative OpenCode configuration. It is deep-merged
            into the persistent global opencode.json; undeclared live keys are
            preserved and the typed options below remain authoritative.
          '';
        };

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
            # Post-edit test runner: uses tool.execute.after (the correct hook).
            # Delegates to shared-test-runner.ts and surfaces real failures back
            # to the agent while filtering infrastructure-only errors.
            "file:///home/agent/.config/opencode/plugins/test-runner.ts"
            # Gitleaks pre-commit guard — aborts `git commit` bash calls when
            # staged content matches a secret pattern (uses tool.execute.before).
            "file:///home/agent/.config/opencode/plugins/gitleaks-precommit.ts"
            # Notification / tmux-title bridge — waits for all todos before a
            # completion alert, flags permission/question prompts that need the
            # user, and includes the OpenCode session title.
            "file:///home/agent/.config/opencode/plugins/notify.ts"
            # Resolves an explicitly invoked archive command against the exact
            # OpenCode session ID at the next idle boundary.
            "file:///home/agent/.config/opencode/plugins/archive-request.ts"
          ];
          description = "List of OpenCode plugins. Uses the current OpenCode hook API — tool.execute.before / tool.execute.after (test-runner, gitleaks) and the event bus (notify).";
        };

        permission = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = {
            bash = opencodeSecretBashRules // {
              "sudo *" = "deny";
              "su *" = "deny";
              "rm -rf /" = "deny";
              "rm -rf /*" = "deny";
              "chmod 777 *" = "deny";
            };
            # Secret-file denylist for OpenCode. OpenCode's wildcard matcher
            # (packages/opencode/src/util/wildcard.ts) supports only `*` and
            # `?` — no `**` — but `*` is greedy across `/`, so a single `*`
            # already matches arbitrary directory prefixes.
            # Last match wins via length-asc sort, so longer allow rules
            # below correctly override shorter deny rules above.
            read = opencodeReadRules;
            edit = opencodeEditRules;
            glob = opencodeReadRules;
            grep = opencodeReadRules;
          };
          description = "Permission configuration for OpenCode.";
        };

        extraPermission = lib.mkOption {
          type = lib.types.attrsOf lib.types.anything;
          default = { };
          example = {
            read = {
              "*/private/*" = "deny";
            };
          };
          description = ''
            Per-host OpenCode permission rules deep-merged (lib.recursiveUpdate)
            over opencodeConfig.permission. Use the same category/pattern shape
            ({ read = { "*/x" = "deny"; }; }); later definitions win, matching
            OpenCode's own last-match-wins semantics.
          '';
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
