# Agentbox Docker Image - Built with Nix
# Minimal image for AI coding agents
#
# Build: nix build .#agentboxImage
# Load:  docker load < result
# Run:   docker run -it agentbox:latest
{
  lib,
  stdenv,
  dockerTools,
  buildEnv,
  writeShellScriptBin,
  writeTextFile,
  runCommand,
  # Core utilities
  coreutils,
  bashInteractive,
  gnugrep,
  gnused,
  gawk,
  findutils,
  diffutils,
  gnutar,
  gzip,
  less,
  which,
  file,
  ncurses,
  # FHS compat for pre-compiled binaries (e.g., the claude-code native binary)
  glibc,
  # System utilities
  shadow,
  util-linux,
  procps,
  iproute2,
  cacert,
  tzdata,
  glibcLocales,
  sudo,
  # Development tools
  git,
  tmux,
  htop,
  tree,
  ripgrep,
  fd,
  fzf,
  jq,
  yq-go,
  curl,
  wget,
  unzip,
  gnumake,
  pkg-config,
  gcc,
  zlib,
  # Languages & runtimes
  go,
  nodejs_22,
  bun,
  python312,
  uv,
  # AI coding CLIs bundled from nixpkgs (Codex + OpenCode). Claude Code is NOT a
  # Nix package — the entrypoint installs it at runtime via Anthropic's native
  # installer (CLAUDE_CODE_VERSION) so its self-updater keeps it current.
  codex,
  opencode,
  # Language servers (LSPs)
  gopls,
  nil, # Nix LSP
  # Formatters & linters. On the image's 26.05 base, pkgs.nixfmt IS the
  # RFC-style formatter (nixfmt-rfc-style is now just an alias for it).
  nixfmt,
  # SSH & networking
  openssh,
  # GitHub CLI
  gh,
  # Gitleaks
  gitleaks,
  # Cloud CLIs (see packages list below). The whole image is built from a 26.05
  # base (pkgs/default.nix → imagePkgs), recent enough that google-cloud-sdk's
  # gke-gcloud-auth-plugin component archive still resolves; gcloud is wrapped
  # with that plugin for GKE kubectl auth.
  awscli2,
  kubectl,
  kubernetes-helm,
  google-cloud-sdk,
  # Docker CLI only (no daemon). Talks to a restricted socket proxy over
  # DOCKER_HOST=tcp://… when services.agentbox.settings.dockerProxy.enable is
  # set — used for read-only access (e.g. `docker logs`), never the raw socket.
  docker-client,
  # LSPs / formatters. Formerly under nodePackages.*, which was removed in
  # nixpkgs 26.05 — these now live at the top level.
  typescript-language-server,
  prettier,
  vscode-langservers-extracted,
  # Pre-configured neovim (from pkgs/agentbox-neovim)
  # Falls back to plain neovim if not provided
  neovim,
  agentbox-neovim ? null,
  # Generic escape hatch for baking extra packages (e.g. additional agents)
  # into the image via `.override { extraPackages = [ … ]; }`. Each is appended
  # to the package set; configure and launch them through the modules' extension
  # surface (services.agentbox.extraEnvironment / extraVolumes / extraActivation).
  extraPackages ? [ ],
  # Slash-command source copied into the image when provided.
  claude-skills-src ? null,
}:

let
  # ---------------------------------------------------------------------------
  # OpenCode Plugins (embedded directly - no external fetch needed)
  # These plugins provide safety checks and validation for AI coding agents
  # ---------------------------------------------------------------------------

  # Build validator - ensures builds succeed after code changes
  buildValidatorPlugin = writeTextFile {
    name = "build-validator.ts";
    text = ''
      /**
       * Build validator plugin for OpenCode
       * Ensures builds succeed after code changes
       */
      import { execSync } from "child_process"
      import { existsSync } from "fs"
      import { join } from "path"

      interface BuildResult {
        language: string
        success: boolean
        output?: string
      }

      function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
        try {
          const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
          return { success: true, output }
        } catch (err: any) {
          return { success: false, output: err.stderr || err.stdout || err.message }
        }
      }

      function hasCommand(cmd: string): boolean {
        try {
          execSync(`command -v ''${cmd}`, { stdio: ["pipe", "pipe", "pipe"] })
          return true
        } catch {
          return false
        }
      }

      function runBuildCheck(cwd: string): BuildResult[] {
        const results: BuildResult[] = []

        // Go
        if (existsSync(join(cwd, "go.mod")) && hasCommand("go")) {
          console.log("  → Go: building...")
          const { success, output } = runCommand("go build ./...", cwd)
          results.push({ language: "Go", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Go build succeeded" : "    ❌ Go build failed")
        }

        // Rust
        if (existsSync(join(cwd, "Cargo.toml")) && hasCommand("cargo")) {
          console.log("  → Rust: building...")
          const { success, output } = runCommand("cargo build 2>&1", cwd)
          results.push({ language: "Rust", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Rust build succeeded" : "    ❌ Rust build failed")
        }

        // TypeScript
        if (existsSync(join(cwd, "tsconfig.json"))) {
          const hasTsc = existsSync(join(cwd, "node_modules/.bin/tsc")) || hasCommand("tsc")
          if (hasTsc) {
            console.log("  → TypeScript: compiling...")
            const cmd = existsSync(join(cwd, "node_modules/.bin/tsc")) ? "npx tsc --noEmit" : "tsc --noEmit"
            const { success, output } = runCommand(cmd, cwd)
            results.push({ language: "TypeScript", success, output: success ? undefined : output })
            console.log(success ? "    ✅ TypeScript compilation succeeded" : "    ❌ TypeScript compilation failed")
          }
        }

        // Python
        if ((existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) && hasCommand("python3")) {
          console.log("  → Python: checking syntax...")
          const { success, output } = runCommand("python3 -m py_compile $(find . -name '*.py' -not -path './venv/*' -not -path './.venv/*' | head -50) 2>&1", cwd)
          results.push({ language: "Python", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Python syntax check passed" : "    ❌ Python syntax check failed")
        }

        // Maven
        if (existsSync(join(cwd, "pom.xml")) && hasCommand("mvn")) {
          console.log("  → Maven: compiling...")
          const { success, output } = runCommand("mvn compile -q 2>&1", cwd)
          results.push({ language: "Java (Maven)", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Maven compilation succeeded" : "    ❌ Maven compilation failed")
        }

        // Gradle
        if ((existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) && hasCommand("gradle")) {
          console.log("  → Gradle: compiling...")
          const { success, output } = runCommand("gradle compileJava -q 2>&1", cwd)
          results.push({ language: "Java/Kotlin (Gradle)", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Gradle compilation succeeded" : "    ❌ Gradle compilation failed")
        }

        // Zig
        if (existsSync(join(cwd, "build.zig")) && hasCommand("zig")) {
          console.log("  → Zig: building...")
          const { success, output } = runCommand("zig build 2>&1", cwd)
          results.push({ language: "Zig", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Zig build succeeded" : "    ❌ Zig build failed")
        }

        // Elixir
        if (existsSync(join(cwd, "mix.exs")) && hasCommand("mix")) {
          console.log("  → Elixir: compiling...")
          const { success, output } = runCommand("mix compile 2>&1", cwd)
          results.push({ language: "Elixir", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Elixir compilation succeeded" : "    ❌ Elixir compilation failed")
        }

        // Swift
        if (existsSync(join(cwd, "Package.swift")) && hasCommand("swift")) {
          console.log("  → Swift: building...")
          const { success, output } = runCommand("swift build 2>&1", cwd)
          results.push({ language: "Swift", success, output: success ? undefined : output })
          console.log(success ? "    ✅ Swift build succeeded" : "    ❌ Swift build failed")
        }

        return results
      }

      const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "edit_file", "write_file"])

      export const BuildValidatorPlugin = async (_input: any) => {
        return {
          "tool.complete": async (incoming: any, output: any) => {
            if (!FILE_MODIFYING_TOOLS.has(incoming.tool.name)) return

            const workspace = incoming.workspace || process.cwd()
            console.log("🔨 Validating build...")

            const results = runBuildCheck(workspace)
            if (results.length === 0) {
              console.log("ℹ️  No recognized build system found")
              return
            }

            const failures = results.filter(r => !r.success)
            if (failures.length > 0) {
              console.log("❌ Build validation failed")
              const errorDetails = failures.map(f => `''${f.language}:\n''${f.output || "Unknown error"}`).join("\n\n")
              console.warn(`Build errors:\n''${errorDetails}`)
              // Optionally block: output.blocked = true
              output.message = `Build validation failed:\n\n''${errorDetails}`
            } else {
              console.log("✅ Build validation passed")
            }
          }
        }
      }

      export default BuildValidatorPlugin
    '';
  };

  # Dangerous command blocker - prevents destructive operations
  dangerousCommandBlockerPlugin = writeTextFile {
    name = "dangerous-command-blocker.ts";
    text = ''
      /**
       * Dangerous command blocker plugin for OpenCode
       * Prevents destructive operations
       */

      // Dangerous patterns that should be blocked
      const DANGEROUS_PATTERNS: Array<{ pattern: RegExp | string; reason: string }> = [
        // Destructive file operations
        { pattern: "rm -rf /", reason: "Attempting to delete root filesystem" },
        { pattern: "rm -rf /*", reason: "Attempting to delete root filesystem" },
        { pattern: "rm -rf ~", reason: "Attempting to delete home directory" },
        { pattern: "rm -rf $HOME", reason: "Attempting to delete home directory" },
        { pattern: "rm -rf .", reason: "Attempting to delete current directory" },
        { pattern: "> /dev/sda", reason: "Attempting to overwrite disk" },
        { pattern: /dd if=\/dev\/zero of=\/dev/, reason: "Attempting to wipe disk" },
        { pattern: "mkfs", reason: "Attempting to format filesystem" },

        // Git dangerous operations
        { pattern: "git push --force origin main", reason: "Force pushing to main branch" },
        { pattern: "git push --force origin master", reason: "Force pushing to master branch" },
        { pattern: "git push -f origin main", reason: "Force pushing to main branch" },
        { pattern: "git push -f origin master", reason: "Force pushing to master branch" },
        { pattern: "git reset --hard origin", reason: "Hard reset can lose uncommitted changes" },
        { pattern: "git clean -fdx", reason: "Cleaning all untracked files including ignored" },

        // System destruction
        { pattern: "chmod -R 777 /", reason: "Setting dangerous permissions on root" },
        { pattern: ":(){:|:&};:", reason: "Fork bomb detected" },
        { pattern: "mv /* /dev/null", reason: "Moving everything to null" },

        // Network dangers - curl/wget piped to shell
        { pattern: /(curl|wget)\s+[^\|]+\|\s*(bash|sh|zsh)/, reason: "Piping download directly to shell" },

        // Eval with variables
        { pattern: /eval\s+\$/, reason: "Eval with variable expansion is dangerous" },

        // Environment destruction
        { pattern: "unset PATH", reason: "Unsetting PATH" },
        { pattern: /export PATH=["']?["']?$/, reason: "Clearing PATH" },

        // Container escapes
        { pattern: "--privileged", reason: "Privileged container flag" },
        { pattern: "--cap-add=ALL", reason: "Adding all capabilities" },
        { pattern: "-v /:/", reason: "Mounting root filesystem" },
      ]

      // Warning patterns (logged but not blocked)
      const WARNING_PATTERNS: Array<{ pattern: RegExp | string; reason: string }> = [
        { pattern: "rm -rf", reason: "Recursive force delete - verify target path" },
        { pattern: "git push --force", reason: "Force push - verify branch name" },
        { pattern: "git rebase", reason: "Rebasing can rewrite history" },
        { pattern: "chmod -R", reason: "Recursive permission change" },
        { pattern: "sudo", reason: "Elevated privileges" },
        { pattern: "docker run", reason: "Running container - verify image source" },
      ]

      function matchesPattern(command: string, pattern: RegExp | string): boolean {
        if (typeof pattern === "string") {
          return command.includes(pattern)
        }
        return pattern.test(command)
      }

      export const DangerousCommandBlockerPlugin = async (_input: any) => {
        return {
          "tool.execute.before": async (incoming: any, output: any) => {
            // Only intercept Bash commands
            if (incoming.tool.name !== "Bash") return

            const command = incoming.tool.input?.command || ""
            if (!command) return

            console.log("🛡️ Checking command safety...")

            // Check for dangerous patterns
            for (const { pattern, reason } of DANGEROUS_PATTERNS) {
              if (matchesPattern(command, pattern)) {
                console.log(`❌ BLOCKED: ''${reason}`)
                console.log(`   Command: ''${command}`)

                output.blocked = true
                output.message = `🛑 COMMAND BLOCKED FOR SAFETY\n\nReason: ''${reason}\nCommand: ''${command}\n\nThis command could cause irreversible damage.`
                return
              }
            }

            // Check for warning patterns (log but don't block)
            for (const { pattern, reason } of WARNING_PATTERNS) {
              if (matchesPattern(command, pattern)) {
                console.log(`⚠️  WARNING: ''${reason}`)
              }
            }

            console.log("✅ Command safety check passed")
          }
        }
      }

      export default DangerousCommandBlockerPlugin
    '';
  };

  # Pre-commit lint - runs formatters and linters before git commits
  preCommitLintPlugin = writeTextFile {
    name = "pre-commit-lint.ts";
    text = ''
      /**
       * Pre-commit lint plugin for OpenCode
       * Runs formatters and linters before git commits
       */
      import { execSync } from "child_process"
      import { existsSync } from "fs"
      import { join } from "path"

      function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
        try {
          const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
          return { success: true, output }
        } catch (err: any) {
          return { success: false, output: err.stderr || err.stdout || err.message }
        }
      }

      function hasCommand(cmd: string): boolean {
        try {
          execSync(`command -v ''${cmd}`, { stdio: ["pipe", "pipe", "pipe"] })
          return true
        } catch {
          return false
        }
      }

      export const PreCommitLintPlugin = async (_input: any) => {
        return {
          "tool.execute.before": async (incoming: any, output: any) => {
            // Only intercept Bash commands
            if (incoming.tool.name !== "Bash") return

            const command = incoming.tool.input?.command || ""

            // Only run on git commit commands
            if (!command.includes("git commit")) return

            const cwd = incoming.workspace || process.cwd()
            console.log("🔍 Running pre-commit lint checks...")

            const results: string[] = []
            let hasErrors = false

            // Go
            if (existsSync(join(cwd, "go.mod"))) {
              console.log("  → Go: gofmt check")
              if (hasCommand("gofmt")) {
                const { output: unformatted } = runCommand("gofmt -l .", cwd)
                if (unformatted.trim()) {
                  results.push(`Go: unformatted files:\n''${unformatted}`)
                  hasErrors = true
                }
              }
              if (hasCommand("golangci-lint")) {
                const { success, output: lintOutput } = runCommand("golangci-lint run --fast ./...", cwd)
                if (!success) {
                  results.push(`Go lint errors:\n''${lintOutput}`)
                  hasErrors = true
                }
              }
            }

            // Rust
            if (existsSync(join(cwd, "Cargo.toml")) && hasCommand("cargo")) {
              console.log("  → Rust: cargo fmt & clippy")
              const { success: fmtOk } = runCommand("cargo fmt --check", cwd)
              if (!fmtOk) {
                results.push("Rust: code not formatted (run cargo fmt)")
                hasErrors = true
              }
              const { success: clippyOk, output: clippyOutput } = runCommand("cargo clippy --quiet 2>&1", cwd)
              if (!clippyOk) {
                results.push(`Rust clippy warnings:\n''${clippyOutput}`)
                hasErrors = true
              }
            }

            // TypeScript/JavaScript
            if (existsSync(join(cwd, "package.json"))) {
              console.log("  → JS/TS: eslint & prettier")
              const eslintPath = existsSync(join(cwd, "node_modules/.bin/eslint")) ? "npx eslint" : hasCommand("eslint") ? "eslint" : null
              const prettierPath = existsSync(join(cwd, "node_modules/.bin/prettier")) ? "npx prettier" : hasCommand("prettier") ? "prettier" : null

              if (eslintPath) {
                const { success, output: eslintOutput } = runCommand(`''${eslintPath} . --max-warnings=0`, cwd)
                if (!success) {
                  results.push(`ESLint errors:\n''${eslintOutput}`)
                  hasErrors = true
                }
              }

              if (prettierPath) {
                const { success } = runCommand(`''${prettierPath} --check .`, cwd)
                if (!success) {
                  results.push("Prettier: code not formatted")
                  hasErrors = true
                }
              }
            }

            // Python
            if ((existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) && hasCommand("ruff")) {
              console.log("  → Python: ruff")
              const { success: checkOk, output: checkOutput } = runCommand("ruff check .", cwd)
              const { success: fmtOk } = runCommand("ruff format --check .", cwd)
              if (!checkOk || !fmtOk) {
                results.push(`Ruff errors:\n''${checkOutput}`)
                hasErrors = true
              }
            }

            if (hasErrors) {
              console.log("❌ Lint checks failed")
              results.forEach(r => console.log(r))
              output.blocked = true
              output.message = `Pre-commit lint failed:\n''${results.join("\n\n")}`
            } else {
              console.log("✅ Lint checks passed")
            }
          }
        }
      }

      export default PreCommitLintPlugin
    '';
  };

  # Secret scanner - blocks commits containing secrets/credentials
  secretScannerPlugin = writeTextFile {
    name = "secret-scanner.ts";
    text = ''
      /**
       * Secret scanner plugin for OpenCode
       * Blocks commits containing secrets/credentials
       */
      import { execSync } from "child_process"
      import { readFileSync, existsSync } from "fs"
      import { join } from "path"

      // Secret patterns to detect
      const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
        // AWS
        { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
        { name: "AWS Secret Key", pattern: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/ },

        // GitHub
        { name: "GitHub PAT", pattern: /ghp_[a-zA-Z0-9]{36}/ },
        { name: "GitHub OAuth", pattern: /gho_[a-zA-Z0-9]{36}/ },
        { name: "GitHub App Token", pattern: /ghu_[a-zA-Z0-9]{36}/ },
        { name: "GitHub Server Token", pattern: /ghs_[a-zA-Z0-9]{36}/ },
        { name: "GitHub Refresh Token", pattern: /ghr_[a-zA-Z0-9]{36}/ },
        { name: "GitHub Fine-grained PAT", pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/ },

        // GitLab
        { name: "GitLab PAT", pattern: /glpat-[a-zA-Z0-9\-]{20}/ },

        // Google
        { name: "Google API Key", pattern: /AIza[0-9A-Za-z\-_]{35}/ },

        // Slack
        { name: "Slack Token", pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/ },

        // Stripe
        { name: "Stripe Live Key", pattern: /sk_live_[0-9a-zA-Z]{24}/ },
        { name: "Stripe Test Key", pattern: /sk_test_[0-9a-zA-Z]{24}/ },

        // Private keys
        { name: "Private Key", pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/ },

        // AI APIs
        { name: "Anthropic API Key", pattern: /sk-ant-[a-zA-Z0-9\-]{40,}/ },
        { name: "OpenAI API Key", pattern: /sk-[a-zA-Z0-9]{48}/ },

        // Generic
        { name: "Generic API Key", pattern: /api[_-]?key\s*[=:]\s*["'][a-zA-Z0-9]{20,}["']/ },
        { name: "Generic Secret", pattern: /secret\s*[=:]\s*["'][a-zA-Z0-9]{20,}["']/ },
        { name: "Generic Token", pattern: /token\s*[=:]\s*["'][a-zA-Z0-9]{20,}["']/ },

        // Database URLs
        { name: "Database URL with password", pattern: /(mysql|postgres|postgresql|mongodb|redis):\/\/[^:]+:[^@]+@/ },

        // JWT
        { name: "JWT Token", pattern: /eyJ[a-zA-Z0-9]{10,}\.eyJ[a-zA-Z0-9]{10,}\.[a-zA-Z0-9_-]{10,}/ },

        // SendGrid
        { name: "SendGrid API Key", pattern: /SG\.[a-zA-Z0-9]{22}\.[a-zA-Z0-9]{43}/ },

        // Twilio
        { name: "Twilio API Key", pattern: /SK[a-f0-9]{32}/ },
      ]

      // Files to ignore
      const IGNORE_PATTERNS = [
        /\.lock$/,
        /package-lock\.json$/,
        /yarn\.lock$/,
        /go\.sum$/,
        /\.min\.js$/,
        /\.min\.css$/,
        /node_modules\//,
        /vendor\//,
        /\.git\//,
      ]

      function shouldIgnoreFile(filepath: string): boolean {
        return IGNORE_PATTERNS.some(pattern => pattern.test(filepath))
      }

      function getStagedFiles(cwd: string): string[] {
        try {
          const output = execSync("git diff --cached --name-only --diff-filter=ACM", {
            cwd,
            encoding: "utf-8"
          })
          return output.trim().split("\n").filter(f => f.length > 0)
        } catch {
          return []
        }
      }

      export const SecretScannerPlugin = async (_input: any) => {
        return {
          "tool.execute.before": async (incoming: any, output: any) => {
            // Only intercept Bash commands
            if (incoming.tool.name !== "Bash") return

            const command = incoming.tool.input?.command || ""

            // Only run on git commands that could commit/push
            if (!command.includes("git commit") && !command.includes("git push") && !command.includes("git add")) {
              return
            }

            const cwd = incoming.workspace || process.cwd()
            console.log("🔐 Scanning for secrets...")

            const stagedFiles = getStagedFiles(cwd)
            const findings: Array<{ file: string; secret: string; line: number }> = []

            for (const file of stagedFiles) {
              if (shouldIgnoreFile(file)) continue

              const filepath = join(cwd, file)
              if (!existsSync(filepath)) continue

              try {
                const content = readFileSync(filepath, "utf-8")
                const lines = content.split("\n")

                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i]
                  for (const { name, pattern } of SECRET_PATTERNS) {
                    if (pattern.test(line)) {
                      findings.push({ file, secret: name, line: i + 1 })
                    }
                  }
                }
              } catch {
                // Ignore read errors
              }
            }

            if (findings.length > 0) {
              console.log("❌ SECRET SCAN FAILED")
              const message = findings.map(f => `  • ''${f.file}:''${f.line} - ''${f.secret}`).join("\n")
              console.log(message)

              output.blocked = true
              output.message = `Secrets detected in staged files:\n''${message}\n\nPlease remove secrets before committing.`
            } else {
              console.log(`✅ Secret scan passed (''${stagedFiles.length} files checked)`)
            }
          }
        }
      }

      export default SecretScannerPlugin
    '';
  };

  # Static check - runs language-specific static checks after file edits
  staticCheckPlugin = writeTextFile {
    name = "static-check.ts";
    text = ''
      /**
       * OpenCode plugin: Static analysis / compile check
       * Runs language-specific static checks after file edits.
       *
       * Installation:
       *   Add to opencode.json:
       *     { "plugin": ["file://.config/opencode/plugins/static-check.ts"] }
       */

      import { execSync } from "child_process"
      import { existsSync } from "fs"
      import { join } from "path"

      // Inline types for OpenCode plugin system
      type ToolCompleteHook = (
        incoming: {
          sessionID: string
          tool: { name: string; input: Record<string, any>; output?: string }
          workspace: string
        },
        output: { blocked?: boolean; message?: string }
      ) => Promise<void>

      type PluginHooks = {
        "tool.complete"?: ToolCompleteHook
      }

      type PluginFn = (input: any) => Promise<PluginHooks>

      interface CheckResult {
        ran: boolean
        passed: boolean
        output: string
      }

      const COLORS = {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        reset: "\x1b[0m",
      }

      function log(level: "info" | "warn" | "error", msg: string): void {
        const color = level === "info" ? COLORS.green : level === "warn" ? COLORS.yellow : COLORS.red
        console.log(`''${color}[static-check]''${COLORS.reset} ''${msg}`)
      }

      function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
        try {
          const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
          return { success: true, output }
        } catch (err: any) {
          return { success: false, output: err.stderr || err.stdout || err.message }
        }
      }

      function hasCommand(cmd: string): boolean {
        try {
          execSync(`command -v ''${cmd}`, { stdio: ["pipe", "pipe", "pipe"] })
          return true
        } catch {
          return false
        }
      }

      function runStaticChecks(workspace: string): CheckResult {
        const results: string[] = []
        let checkRan = false
        let allPassed = true

        // Go
        if (existsSync(join(workspace, "go.mod"))) {
          if (hasCommand("go")) {
            log("info", "Running Go static check...")
            const { success, output } = runCommand("go vet ./...", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`go vet failed:\n''${output}`)
            }
          }
        }

        // Rust
        if (existsSync(join(workspace, "Cargo.toml"))) {
          if (hasCommand("cargo")) {
            log("info", "Running Rust compile check...")
            const { success, output } = runCommand("cargo check 2>&1", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`cargo check failed:\n''${output}`)
            }
          }
        }

        // TypeScript
        if (existsSync(join(workspace, "tsconfig.json"))) {
          const hasTsc = existsSync(join(workspace, "node_modules/.bin/tsc")) || hasCommand("tsc")
          if (hasTsc) {
            log("info", "Running TypeScript compile check...")
            const cmd = existsSync(join(workspace, "node_modules/.bin/tsc"))
              ? "npx tsc --noEmit"
              : "tsc --noEmit"
            const { success, output } = runCommand(cmd, workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`tsc failed:\n''${output}`)
            }
          }
        }

        // Python
        if (
          existsSync(join(workspace, "pyproject.toml")) ||
          existsSync(join(workspace, "setup.py"))
        ) {
          if (hasCommand("ruff")) {
            log("info", "Running Python ruff check...")
            const { success, output } = runCommand("ruff check .", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`ruff check failed:\n''${output}`)
            }
          } else if (hasCommand("mypy")) {
            log("info", "Running Python mypy check...")
            const { success, output } = runCommand("mypy .", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`mypy failed:\n''${output}`)
            }
          }
        }

        // Java - Maven
        if (existsSync(join(workspace, "pom.xml"))) {
          if (hasCommand("mvn")) {
            log("info", "Running Maven compile check...")
            const { success, output } = runCommand("mvn compile -q", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`mvn compile failed:\n''${output}`)
            }
          }
        }

        // Java/Kotlin - Gradle
        if (existsSync(join(workspace, "build.gradle")) || existsSync(join(workspace, "build.gradle.kts"))) {
          if (hasCommand("gradle")) {
            log("info", "Running Gradle compile check...")
            const { success, output } = runCommand("gradle compileJava compileKotlin -q 2>/dev/null || gradle compileJava -q", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`gradle compile failed:\n''${output}`)
            }
          }
        }

        // Zig
        if (existsSync(join(workspace, "build.zig"))) {
          if (hasCommand("zig")) {
            log("info", "Running Zig check...")
            const { success, output } = runCommand("zig build --summary none", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`zig build failed:\n''${output}`)
            }
          }
        }

        // Elixir
        if (existsSync(join(workspace, "mix.exs"))) {
          if (hasCommand("mix")) {
            log("info", "Running Elixir compile check...")
            const { success, output } = runCommand("mix compile --warnings-as-errors", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`mix compile failed:\n''${output}`)
            }
          }
        }

        // Swift
        if (existsSync(join(workspace, "Package.swift"))) {
          if (hasCommand("swift")) {
            log("info", "Running Swift build check...")
            const { success, output } = runCommand("swift build", workspace)
            checkRan = true
            if (!success) {
              allPassed = false
              results.push(`swift build failed:\n''${output}`)
            }
          }
        }

        if (checkRan && allPassed) {
          log("info", "Static checks passed ✓")
        } else if (!checkRan) {
          log("warn", "No supported language detected or tools not available")
        }

        return {
          ran: checkRan,
          passed: allPassed,
          output: results.join("\n\n"),
        }
      }

      // Tools that modify files and should trigger static checks
      const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "edit_file", "write_file"])

      export const StaticCheckPlugin: PluginFn = async (_input) => {
        return {
          "tool.complete": async (incoming, output) => {
            // Only run after file-modifying tools
            if (!FILE_MODIFYING_TOOLS.has(incoming.tool.name)) {
              return
            }

            const workspace = incoming.workspace || process.cwd()
            const result = runStaticChecks(workspace)

            if (result.ran && !result.passed) {
              log("error", "Static checks failed!")
              // Optionally block or just warn
              // output.blocked = true
              output.message = `Static check errors:\n''${result.output}`
            }
          },
        }
      }

      export default StaticCheckPlugin
    '';
  };

  # Shared test-runner script invoked by both the OpenCode plugin and the
  # Claude Code PostToolUse hook. Detects the language of the changed file,
  # runs the appropriate test suite, and filters out infrastructure failures
  # (e.g. a database/service the tests expect not being reachable) so only real
  # regressions surface back to the agent.
  #
  # Contract:
  #   argv[1] = absolute path of the changed file
  #   stdout  = human-readable log (kept short)
  #   stderr  = if exit==2, a structured failure block to feed the agent
  #   exit    = 0 on pass / no-tests / infra-only, 2 on real test failure
  sharedTestRunnerScript = writeTextFile {
    name = "shared-test-runner.ts";
    text = ''
      // Shared test-runner — invoked as `bun shared-test-runner.ts <file_path>`
      // by both the OpenCode `tool.execute.after` plugin and the Claude Code
      // PostToolUse hook. No shebang: always run via bun.
      import { execSync } from "child_process"
      import { existsSync } from "fs"
      import { dirname, extname, join } from "path"

      const TIMEOUT_SEC = 90
      const SOURCE_EXTS = new Set([
        ".go", ".rs", ".ts", ".tsx", ".js", ".jsx",
        ".py", ".java", ".kt", ".swift", ".ex", ".exs",
      ])
      const SKIP_SEGMENTS = [
        "/vendor/", "/node_modules/", "/.git/", "/dist/",
        "/build/", "/target/", "/.venv/", "/venv/",
      ]

      // Infrastructure-related failure patterns. If every failing line in the
      // test output matches one of these, the run is treated as an infra
      // skip rather than a code regression. Keep this list tight — anything
      // overly broad will hide real bugs. Extend it for the services your own
      // test suites depend on.
      const INFRA_PATTERNS: RegExp[] = [
        /connection\s+refused.*:5432\b/i,                 // postgres
        /dial\s+tcp\s+\S*:5432/i,
        /pq:\s+(could\s+not\s+connect|the\s+database\s+system\s+is)/i,
        /connection\s+refused.*:6379\b/i,                 // redis
        /redis(.|\n)*?(connection\s+(refused|reset)|i\/o\s+timeout)/i,
        /no\s+such\s+host/i,
        /network\s+is\s+unreachable/i,
        /socket:\s+connection\s+refused/i,
        /docker:\s+Cannot\s+connect\s+to\s+the\s+Docker\s+daemon/i,
        /127\.0\.0\.1:(5432|6379)/i,
      ]

      const file = process.argv[2]
      if (!file) {
        console.error("usage: shared-test-runner.ts <file_path>")
        process.exit(0)
      }

      function isSourceFile(p: string): boolean {
        if (SKIP_SEGMENTS.some(seg => p.includes(seg))) return false
        return SOURCE_EXTS.has(extname(p))
      }

      function findUp(start: string, marker: string): string | null {
        let dir = existsSync(start) ? start : dirname(start)
        while (true) {
          if (existsSync(join(dir, marker))) return dir
          const parent = dirname(dir)
          if (parent === dir) return null
          dir = parent
        }
      }

      function hasCommand(cmd: string): boolean {
        try {
          execSync(`command -v ''${cmd}`, { stdio: ["pipe", "pipe", "pipe"] })
          return true
        } catch { return false }
      }

      type RunResult = { code: number; output: string }
      function run(cmd: string, cwd: string): RunResult {
        try {
          const stdout = execSync(
            `timeout --kill-after=5 ''${TIMEOUT_SEC} ''${cmd}`,
            { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          )
          return { code: 0, output: stdout }
        } catch (e: any) {
          const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")
          return { code: e.status ?? 1, output: out || (e.message ?? "") }
        }
      }

      // Splits test output into individual failure blocks (one per failing
      // test) and returns true only if every block is dominated by an
      // infrastructure pattern. A single non-infra failure means the run is
      // a real regression.
      //
      // Recognised block delimiters:
      //   - go test:  "--- FAIL: TestName"  ... until next "--- " / "FAIL\t"
      //   - ginkgo:   "[FAIL] ..."          ... until next "•" / "Ran "
      //   - jest:     "● ..."               ... until next "●" / "Tests:"
      //   - rust:     "thread '...' panicked ..." ... until next "thread '"
      function splitFailureBlocks(output: string): string[] {
        const lines = output.split("\n")
        const blocks: string[] = []
        let cur: string[] | null = null

        const startRe = /^(---\s+FAIL:\s+\S+|\[FAIL(ED)?\]|●\s+\S|thread\s+'.*'\s+panicked)/
        const endRe = /^(---\s+(PASS|SKIP):|FAIL\s+\S+\s+[\d\.]+s|ok\s+\S+\s+[\d\.]+s|Tests:\s+|Ran\s+\d+\s+of\s+\d+|test\s+result:)/

        for (const line of lines) {
          if (startRe.test(line)) {
            if (cur) blocks.push(cur.join("\n"))
            cur = [line]
            continue
          }
          if (endRe.test(line)) {
            if (cur) { blocks.push(cur.join("\n")); cur = null }
            continue
          }
          if (cur) cur.push(line)
        }
        if (cur) blocks.push(cur.join("\n"))
        return blocks
      }

      function isInfraOnly(output: string): boolean {
        if (!INFRA_PATTERNS.some(p => p.test(output))) return false
        const blocks = splitFailureBlocks(output)
        if (blocks.length === 0) {
          // No structured failure blocks (e.g. compile-time error before any
          // test ran). Treat as infra-only iff the whole output matches infra.
          return INFRA_PATTERNS.some(p => p.test(output))
        }
        return blocks.every(b => INFRA_PATTERNS.some(p => p.test(b)))
      }

      type Outcome = {
        language: string
        ran: boolean
        passed: boolean
        infraOnly: boolean
        output: string
      }

      function testGo(file: string): Outcome | null {
        const pkgDir = dirname(file)
        const modRoot = findUp(pkgDir, "go.mod")
        if (!modRoot) return null
        if (!hasCommand("go")) return null
        // Test only the package containing the changed file.
        const r = run(`go test -short -count=1 -timeout 60s .`, pkgDir)
        return {
          language: "Go",
          ran: true,
          passed: r.code === 0,
          infraOnly: r.code !== 0 && isInfraOnly(r.output),
          output: r.output,
        }
      }

      function testRust(file: string): Outcome | null {
        const root = findUp(dirname(file), "Cargo.toml")
        if (!root || !hasCommand("cargo")) return null
        const r = run(`cargo test --quiet --no-fail-fast`, root)
        return {
          language: "Rust",
          ran: true,
          passed: r.code === 0,
          infraOnly: r.code !== 0 && isInfraOnly(r.output),
          output: r.output,
        }
      }

      function testTypeScript(file: string): Outcome | null {
        const root = findUp(dirname(file), "package.json")
        if (!root) return null
        const pkg = JSON.parse(
          execSync(`cat ''${join(root, "package.json")}`, { encoding: "utf-8" }),
        )
        if (!pkg?.scripts?.test) return null
        const hasJest = existsSync(join(root, "node_modules/.bin/jest"))
        const cmd = hasJest
          ? `npx jest --testPathPattern=''${file.replace(/\//g, "\\/")} --passWithNoTests`
          : `npm test --silent`
        const r = run(cmd, root)
        return {
          language: "TypeScript",
          ran: true,
          passed: r.code === 0,
          infraOnly: r.code !== 0 && isInfraOnly(r.output),
          output: r.output,
        }
      }

      function main(): void {
        if (!isSourceFile(file)) process.exit(0)

        const tests = [
          () => testGo(file),
          () => testRust(file),
          () => testTypeScript(file),
        ]

        const outcomes: Outcome[] = []
        for (const t of tests) {
          const o = t()
          if (o) outcomes.push(o)
        }

        if (outcomes.length === 0) {
          console.log(`[test-runner] no test runner detected for ''${file}`)
          process.exit(0)
        }

        const realFailures = outcomes.filter(o => !o.passed && !o.infraOnly)
        const infraSkips = outcomes.filter(o => !o.passed && o.infraOnly)

        if (realFailures.length === 0) {
          for (const s of infraSkips) {
            console.log(`[test-runner] ''${s.language}: infra-only failure, skipped`)
          }
          for (const o of outcomes.filter(x => x.passed)) {
            console.log(`[test-runner] ''${o.language}: ✓`)
          }
          process.exit(0)
        }

        // Real failure — emit a structured block on stderr so the agent sees it.
        const detail = realFailures
          .map(f => `--- ''${f.language} ---\n''${f.output.trim()}`)
          .join("\n\n")
          .slice(0, 8000)

        const infraNote = infraSkips.length
          ? `\n\nNote: ''${infraSkips.map(s => s.language).join(", ")} reported infrastructure errors (a required service was not reachable). Those were filtered out — fix only the failures above.`
          : ""

        process.stderr.write(
          `<test_failure>\n` +
          `Tests failed after editing: ''${file}\n\n` +
          `''${detail}''${infraNote}\n` +
          `</test_failure>\n`,
        )
        process.exit(2)
      }

      main()
    '';
  };

  # Claude Code PostToolUse hook script. Reads the hook JSON event from
  # stdin, extracts the touched file path, and delegates to dd-test-runner.
  # The runner's stderr is propagated; exit 2 is what surfaces back into
  # Claude's reasoning loop per the PostToolUse hook contract.
  claudeCodeTestRunnerHook = writeTextFile {
    name = "claude-test-runner.sh";
    executable = true;
    text = ''
      #!/usr/bin/env bash
      set -u
      payload="$(cat)"
      file="$(printf '%s' "$payload" | jq -r '
        .tool_input.file_path
        // .tool_input.notebook_path
        // (.tool_input.edits[0].file_path // empty)
        // empty
      ')"
      if [ -z "$file" ]; then
        exit 0
      fi
      bun /home/agent/.local/bin/shared-test-runner.ts "$file"
    '';
  };

  # OpenCode plugin: same behavior as the Claude Code hook, but wired into
  # the OpenCode plugin runtime via `tool.execute.after`. Note: existing
  # plugins in this file use the legacy `tool.complete` event, which does
  # not exist in the current OpenCode plugin API
  # (see /workspace/personal/opencode/packages/opencode/src/session/prompt.ts:430)
  # — those plugins load but never fire. This plugin uses the correct hook.
  testRunnerPlugin = writeTextFile {
    name = "test-runner.ts";
    text = ''
      /**
       * OpenCode plugin: post-edit test runner.
       * Delegates to /home/agent/.local/bin/shared-test-runner.ts so the same
       * detection / infra-filter logic is shared with the Claude Code hook.
       */
      import { execSync } from "child_process"

      const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

      function pickFile(args: any): string | undefined {
        if (!args) return undefined
        if (typeof args.file_path === "string") return args.file_path
        if (typeof args.filePath === "string") return args.filePath
        if (typeof args.notebook_path === "string") return args.notebook_path
        if (Array.isArray(args.edits) && args.edits[0]?.file_path) return args.edits[0].file_path
        return undefined
      }

      export const TestRunnerPlugin = async (_input: any) => {
        return {
          "tool.execute.after": async (
            input: { tool: string; sessionID: string; callID: string; args: any },
            output: { title: string; output: string; metadata: any },
          ) => {
            if (!FILE_TOOLS.has(input.tool)) return
            const file = pickFile(input.args)
            if (!file) return

            try {
              execSync(`bun /home/agent/.local/bin/shared-test-runner.ts ''${JSON.stringify(file)}`, {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              })
              // Exit 0: pass / infra-only / no test runner — say nothing.
            } catch (e: any) {
              // Exit 2 from runner means a real failure; stderr holds the
              // <test_failure> block. Append it so Claude sees it next turn.
              const stderr = e.stderr?.toString() ?? ""
              if (e.status === 2 && stderr.trim()) {
                output.output = `''${output.output}\n\n''${stderr.trim()}`
              }
            }
          },
        }
      }

      export default TestRunnerPlugin
    '';
  };

  # Shared gitleaks pre-commit script. Runs `gitleaks protect --staged` in
  # the target repo. Exits 2 with a structured <gitleaks_failure> block on
  # stderr when secrets are detected so Claude / OpenCode surface the
  # finding into the agent's reasoning loop. Skips silently when gitleaks
  # is unavailable or the cwd is not a git work-tree.
  #
  # Contract:
  #   argv[1] = optional repo cwd (defaults to PWD)
  #   stdout  = short status line
  #   stderr  = on exit 2, a <gitleaks_failure>...</gitleaks_failure> block
  #   exit    = 0 on clean / skipped, 2 on leak detected
  ddGitleaksScript = writeTextFile {
    name = "dd-gitleaks-precommit.sh";
    executable = true;
    text = ''
      #!/usr/bin/env bash
      # Shared gitleaks pre-commit guard — invoked from the Claude Code
      # PreToolUse hook and the OpenCode tool.execute.before plugin.
      set -u

      cwd="''${1:-$PWD}"
      cd "$cwd" 2>/dev/null || exit 0

      # Skip if not a git work-tree
      if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        exit 0
      fi

      # Skip if gitleaks is missing — better to warn than to wedge the agent.
      if ! command -v gitleaks >/dev/null 2>&1; then
        echo "[gitleaks] tool missing on PATH, skipping pre-commit scan" >&2
        exit 0
      fi

      # Run gitleaks against staged content. --redact masks the secret value
      # in the report; --no-banner trims noise. Honors any .gitleaksignore /
      # .gitleaks.toml present in the repo automatically.
      tmpout="$(mktemp)"
      trap 'rm -f "$tmpout"' EXIT
      gitleaks protect --staged --redact --no-banner --verbose >"$tmpout" 2>&1
      rc=$?

      if [ "$rc" -eq 0 ]; then
        exit 0
      fi

      # gitleaks exit 1 = leaks found; anything else (>1) = tool error — let
      # the commit proceed rather than blocking on a tool malfunction.
      if [ "$rc" -ne 1 ]; then
        echo "[gitleaks] scan errored (rc=$rc), allowing commit" >&2
        cat "$tmpout" >&2
        exit 0
      fi

      report="$(head -c 8000 "$tmpout")"
      printf '<gitleaks_failure>\n%s\n%s\n%s\n</gitleaks_failure>\n' \
        "Gitleaks detected staged secrets in $cwd. The commit was blocked." \
        "Remove the secret, rotate the credential, and re-stage before retrying." \
        "$report" >&2
      exit 2
    '';
  };

  # Claude Code PreToolUse hook for gitleaks. Reads the hook JSON event,
  # confirms the bash command is a `git commit`, then delegates to the
  # shared dd-gitleaks-precommit script in the resolved cwd.
  claudeCodeGitleaksHook = writeTextFile {
    name = "claude-gitleaks-precommit.sh";
    executable = true;
    text = ''
      #!/usr/bin/env bash
      set -u
      payload="$(cat)"

      # Match only `git commit ...` invocations (incl. pipelines / && chains)
      cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
      if [ -z "$cmd" ]; then
        exit 0
      fi
      if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit([[:space:]]|$)'; then
        exit 0
      fi

      # Prefer the explicit cwd from the tool input; fall back to PWD.
      cwd="$(printf '%s' "$payload" | jq -r '.tool_input.cwd // .cwd // empty')"
      if [ -z "$cwd" ]; then
        cwd="$PWD"
      fi

      bash /home/agent/.local/bin/dd-gitleaks-precommit.sh "$cwd"
    '';
  };

  # OpenCode plugin: pre-commit gitleaks guard. Uses `tool.execute.before`
  # to intercept bash invocations and throws on leak detection so the
  # tool-call is aborted before the commit happens.
  gitleaksPrecommitPlugin = writeTextFile {
    name = "gitleaks-precommit.ts";
    text = ''
      /**
       * OpenCode plugin: gitleaks pre-commit guard.
       * Intercepts `bash` tool calls that run `git commit` and delegates to
       * /home/agent/.local/bin/dd-gitleaks-precommit.sh in the tool cwd.
       */
      import { execFileSync } from "child_process"

      const COMMIT_RE = /(^|[;&|\s])git\s+commit(\s|$)/

      export const GitleaksPrecommitPlugin = async (_input: any) => {
        return {
          "tool.execute.before": async (
            input: { tool: string; sessionID: string; callID: string },
            output: { args: any },
          ) => {
            if (input.tool !== "bash") return
            const cmd: string = output.args?.command ?? ""
            if (!cmd || !COMMIT_RE.test(cmd)) return

            const cwd: string = output.args?.cwd ?? process.cwd()
            try {
              execFileSync(
                "bash",
                ["/home/agent/.local/bin/dd-gitleaks-precommit.sh", cwd],
                { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
              )
              // Exit 0: clean / skipped — say nothing.
            } catch (e: any) {
              if (e.status === 2) {
                const stderr = (e.stderr?.toString() ?? "").trim()
                throw new Error(stderr || "gitleaks blocked the commit")
              }
              // Any other failure: log but do not block.
              console.error("[gitleaks-precommit] non-blocking error:", e.message)
            }
          },
        }
      }

      export default GitleaksPrecommitPlugin
    '';
  };

  # All packages to include in the image (minimal set for AI coding agents).
  #
  # The list is split into three tiers so the closure can be reasoned about:
  #   REQUIRED   — the image (entrypoint, FHS shims, TUIs, TLS) breaks without it.
  #   CONVENIENCE— never invoked by the image machinery, but a coding agent (or a
  #                human in `agentbox shell`) routinely reaches for it. Safe to
  #                trim if you want a smaller closure.
  # Extra packages passed via `.override { extraPackages = [ … ]; }` are appended
  # at the very end (empty by default) — see `extraPackages` above.
  packages = [
    # ── Core utilities — REQUIRED ──────────────────────────────────────────
    coreutils # ls/cat/cp/chmod/… — fundamental
    bashInteractive # entrypoint, hooks and the login shell are all bash
    gnugrep # entrypoint version-parsing, agentbox CLI, hooks
    gnused
    findutils # `find` in the build/test plugins
    gnutar # the claude-code native install.sh unpacks archives
    gzip
    ncurses # terminfo — the Claude Code TUI, tmux and neovim need it
    # ── Core utilities — CONVENIENCE ───────────────────────────────────────
    gawk # not used by the machinery; standard agent/dev expectation
    diffutils
    less # git's default pager (interactive `agentbox shell`)
    which
    file
    # NB: `readline` was dropped — bashInteractive already bundles libreadline,
    # so a standalone readline in the env was redundant.
    # ── System utilities — REQUIRED ────────────────────────────────────────
    shadow # useradd/usermod/chpasswd in the entrypoint user-init
    util-linux # `setpriv` — the load-bearing privilege-drop to the agent user
    cacert # TLS CA bundle (SSL_CERT_FILE; git/curl/node over https)
    tzdata # zoneinfo (TZ + the /usr/share/zoneinfo symlink)
    glibcLocales # LOCALE_ARCHIVE / LANG=en_US.UTF-8
    sudo # intentionally available in-container (see darwin `hardening` opts)
    # ── System utilities — CONVENIENCE ─────────────────────────────────────
    procps # ps/top for the agent
    iproute2 # `ip` for in-container network debugging
    # ── Development tools ──────────────────────────────────────────────────
    git
    (if agentbox-neovim != null then agentbox-neovim else neovim) # Pre-configured neovim
    tmux
    htop
    tree
    ripgrep
    fd
    fzf
    jq
    yq-go
    curl
    wget
    unzip
    gnumake
    pkg-config
    gcc
    # Languages & runtimes
    go
    nodejs_22
    bun
    python312
    uv
    # AI coding CLIs (Codex + OpenCode bundled here; Claude Code at runtime).
    codex
    opencode
    # Language servers
    gopls
    nil # Nix LSP
    typescript-language-server
    vscode-langservers-extracted
    # Formatters
    nixfmt
    prettier
    # SSH & networking
    openssh
    # GitHub CLI
    gh
    # Secret scanning (used by the pre-commit hook + OpenCode plugin)
    gitleaks
    # Cloud CLIs. Credentials are NOT baked into the image — they are
    # bind-mounted read-only at runtime from sops-decrypted files (see the
    # aws/gcp/kube credential options in modules/{services,darwin}/agentbox.nix).
    awscli2
    kubectl
    kubernetes-helm
    # gcloud + GKE auth plugin so `kubectl` can authenticate to GKE clusters
    # via the exec credential plugin a GKE kubeconfig references.
    #
    # gke-gcloud-auth-plugin is a prebuilt component archive Google deletes
    # from its CDN once the corresponding SDK version ages out (the 24.11-
    # pinned version's archive is already gone: "path …-gke-gcloud-auth-
    # plugin… is not valid"). The image is therefore built from a 26.05 base
    # (pkgs/default.nix → imagePkgs), whose gcloud is recent enough that the
    # component still resolves. If it breaks again later, bump nixpkgs-2605.
    (google-cloud-sdk.withExtraComponents [
      google-cloud-sdk.components.gke-gcloud-auth-plugin
    ])
    # Docker CLI (client only) for talking to the restricted socket proxy.
    docker-client
  ]
  # Extra packages baked in via `.override` (additional agents, tools, …).
  ++ extraPackages;

  # Create a merged environment with all packages
  packageEnv = buildEnv {
    name = "agentbox-packages";
    paths = packages;
    pathsToLink = [
      "/bin"
      "/lib"
      "/libexec" # For sftp-server from openssh
      "/share"
      "/include"
    ];
    # Note: /etc excluded - we manage etc files manually in extraCommands
  };

  # User initialization script (called on container start)
  entrypointUserScript = writeShellScriptBin "entrypoint-user" ''
    #!/bin/bash
    set -e

    PUID=''${PUID:-1000}
    PGID=''${PGID:-1000}
    HOME_DIR="/home/agent"
    SKEL_DIR="/etc/skel.agent"

    # Fast-path: check if already initialized with same UID:GID
    MARKER_FILE="$HOME_DIR/.container_initialized"
    if [ -f "$MARKER_FILE" ]; then
      STORED_IDS=$(cat "$MARKER_FILE" 2>/dev/null || echo "")
      if [ "$STORED_IDS" = "$PUID:$PGID" ]; then
        exit 0
      fi
    fi

    # Initialize home directory if needed
    if [ ! -f "$HOME_DIR/.bashrc" ] && [ -d "$SKEL_DIR" ]; then
      echo "Initializing home directory from skeleton..."
      cp -rT --no-preserve=mode "$SKEL_DIR" "$HOME_DIR"
    fi

    # Adjust UID/GID if different from container defaults
    CURRENT_UID=$(id -u agent 2>/dev/null || echo "1000")
    CURRENT_GID=$(id -g agent 2>/dev/null || echo "1000")

    if [ "$CURRENT_GID" != "$PGID" ]; then
      echo "Updating agent group GID from $CURRENT_GID to $PGID..."
      groupmod -g "$PGID" agent 2>/dev/null || true
    fi

    if [ "$CURRENT_UID" != "$PUID" ]; then
      echo "Updating agent user UID from $CURRENT_UID to $PUID..."
      usermod -u "$PUID" agent 2>/dev/null || true
    fi

    # Fix ownership
    chown -R agent:agent "$HOME_DIR" 2>/dev/null || true

    # Fix workspace ownership if requested
    if [ "''${FIX_WORKSPACE_OWNERSHIP:-false}" = "true" ] && [ -d /workspace ]; then
      echo "Fixing /workspace ownership..."
      chown -R agent:agent /workspace 2>/dev/null || true
    fi

    # Create config symlinks
    CONFIG_DIR="/config"
    if [ -d "$CONFIG_DIR" ]; then
      for item in .pi .vibe .gemini .copilot .opencode .vimrc .tmux.conf; do
        if [ -e "$CONFIG_DIR/$item" ] && [ ! -L "$HOME_DIR/$item" ]; then
          rm -rf "$HOME_DIR/$item" 2>/dev/null || true
          ln -sf "$CONFIG_DIR/$item" "$HOME_DIR/$item"
        fi
      done
      if [ -d "$CONFIG_DIR/nvim" ] && [ ! -L "$HOME_DIR/.config/nvim" ]; then
        mkdir -p "$HOME_DIR/.config"
        rm -rf "$HOME_DIR/.config/nvim" 2>/dev/null || true
        ln -sf "$CONFIG_DIR/nvim" "$HOME_DIR/.config/nvim"
      fi
    fi

    # Store marker for fast-path
    echo "$PUID:$PGID" > "$MARKER_FILE"
  '';

  # Main entrypoint script
  entrypointScript = writeShellScriptBin "entrypoint" ''
    #!/bin/bash
    set -e

    # Run user initialization
    ${entrypointUserScript}/bin/entrypoint-user

    # Set password if provided
    if [ -n "''${AGENT_PASSWORD:-}" ]; then
      echo "agent:$AGENT_PASSWORD" | chpasswd 2>/dev/null || true
    fi

    # Install AI coding tools if not present (bun global packages)
    # These are installed at runtime because they're not in nixpkgs
    export BUN_INSTALL="/home/agent/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    mkdir -p "$BUN_INSTALL"
    chown agent:agent "$BUN_INSTALL" 2>/dev/null || true

    install_as_agent() {
      setpriv --reuid=agent --regid=agent --init-groups -- bash -lc "$1"
    }

    # OpenCode is installed via Nix (from anomalyco/opencode flake)

    # Install Claude Code via the official native installer (Anthropic's
    # recommended path). The native binary self-updates in-place by
    # downloading the new binary directly — it does NOT go through an
    # npm/bun postinstall, so it sidesteps the bun-global breakage where
    # `bun add -g` skips the lifecycle script and leaves the wrapper
    # without its platform-native binary on every background auto-update
    # (anthropics/claude-code#50203). The FHS glibc interpreter symlinks
    # created below in extraCommands are what let the precompiled ELF run
    # inside the Nix container.
    #
    # CLAUDE_CODE_VERSION pins the install: "latest" (default) or "stable"
    # select a release channel; an exact version like "2.1.89" pins that
    # build. Once installed, Claude Code's own updater keeps it current —
    # we only (re)install on a fresh volume or when an exact pin changes.
    CLAUDE_CODE_CHANNEL="''${CLAUDE_CODE_VERSION:-latest}"
    CURRENT_VERSION=$(install_as_agent "claude --version 2>/dev/null" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
    NEED_INSTALL=false
    if [ -z "$CURRENT_VERSION" ]; then
      NEED_INSTALL=true
    elif [ "$CLAUDE_CODE_CHANNEL" != "latest" ] && [ "$CLAUDE_CODE_CHANNEL" != "stable" ] \
      && [ "$CURRENT_VERSION" != "$CLAUDE_CODE_CHANNEL" ]; then
      NEED_INSTALL=true
    fi
    if [ "$NEED_INSTALL" = true ]; then
      echo "Installing Claude Code (native installer, channel/version: $CLAUDE_CODE_CHANNEL)..."
      if [ "$CLAUDE_CODE_CHANNEL" = "latest" ]; then
        install_as_agent "curl -fsSL https://claude.ai/install.sh | bash" 2>/dev/null \
          || echo "WARNING: Failed to install claude-code via native installer"
      else
        install_as_agent "curl -fsSL https://claude.ai/install.sh | bash -s $CLAUDE_CODE_CHANNEL" 2>/dev/null \
          || echo "WARNING: Failed to install claude-code via native installer"
      fi
    fi

    # Start Docker daemon if enabled
    if [ "''${ENABLE_DOCKER:-false}" = "true" ]; then
      echo "Starting Docker daemon..."
      dockerd &
      sleep 2
    fi

    # Start SSH server if enabled
    if [ "''${ENABLE_SSH:-false}" = "true" ]; then
      echo "Starting SSH server..."
      mkdir -p /run/sshd /etc/ssh
      # Generate host keys if they don't exist
      if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
        ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_rsa_key -N "" -q
      fi
      if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
        ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q
      fi
      /bin/sshd -D &
    fi

    # Use explicit path since entrypoint runs as root but services should use agent's home
    AGENT_HOME=/home/agent
    AGENT_LOGS="$AGENT_HOME/.agentbox-logs"
    mkdir -p "$AGENT_LOGS"
    chown agent:agent "$AGENT_LOGS"

    # Start OpenCode server if enabled
    # Uses 'opencode serve' to start HTTP API server on port 4096
    # OpenCode is installed via Nix from anomalyco/opencode flake
    # Run as agent user so .cache and other files are owned by agent
    if [ "''${ENABLE_OPENCODE:-false}" = "true" ]; then
      if command -v opencode >/dev/null 2>&1; then
        echo "Starting OpenCode server..."
        # Enable plugin debug logging to see plugin loading
        # Pass OPENCODE_SERVER_PASSWORD for HTTP Basic Auth (if set)
        # Set HOME to agent's home so OpenCode finds config in the right place
        HOME=/home/agent \
        XDG_CONFIG_HOME=/home/agent/.config \
        CLAUDE_PROVIDER_DEBUG=1 \
        OPENCODE_SERVER_PASSWORD="''${OPENCODE_SERVER_PASSWORD:-}" \
          opencode serve --port 4096 --hostname "''${OPENCODE_BIND_ADDRESS:-127.0.0.1}" > "$AGENT_LOGS/opencode.log" 2>&1 &
        # Fix opencode directory ownership to agent (opencode serve runs as root and
        # creates files with root ownership, which breaks session persistence)
        sleep 1
        chown -R agent:agent /home/agent/.cache/opencode 2>/dev/null || true
        chown -R agent:agent /home/agent/.local/share/opencode 2>/dev/null || true
        chown -R agent:agent /home/agent/.local/state/opencode 2>/dev/null || true
      else
        echo "WARNING: ENABLE_OPENCODE=true but 'opencode' not found in PATH"
      fi
    fi

    # Start Claude Code if enabled
    if [ "''${ENABLE_CLAUDE_CODE:-false}" = "true" ]; then
      if command -v claude >/dev/null 2>&1; then
        echo "Starting Claude Code..."
        claude --dangerously-skip-permissions > "$AGENT_LOGS/claude-code.log" 2>&1 &
      else
        echo "WARNING: ENABLE_CLAUDE_CODE=true but 'claude' not found in PATH"
      fi
    fi

    # Codex CLI is bundled in the image (nixpkgs). ENABLE_CODEX just confirms
    # availability at startup; it is invoked interactively as `codex`, not run
    # as a daemon. Auth via env (e.g. OPENAI_API_KEY) from the secret env file.
    if [ "''${ENABLE_CODEX:-false}" = "true" ]; then
      if command -v codex >/dev/null 2>&1; then
        echo "Codex CLI available: $(codex --version 2>/dev/null || echo present)"
      else
        echo "WARNING: ENABLE_CODEX=true but 'codex' not found in PATH"
      fi
    fi

    # Run user-provided boot commands/scripts (generic extension hook). Anything
    # wired in via the `bootScripts` module option (or mounted into the boot.d
    # dir) is launched as the agent user in the background here — use it to
    # start extra agents/services the image does not bundle. The container is
    # kept alive (below) whenever a boot command/script runs.
    AGENTBOX_BOOT_STARTED=false
    if [ -n "''${AGENTBOX_BOOT_CMD:-}" ]; then
      echo "Running AGENTBOX_BOOT_CMD..."
      setpriv --reuid=agent --regid=agent --init-groups -- bash -lc "''${AGENTBOX_BOOT_CMD}" \
        > "$AGENT_LOGS/boot-cmd.log" 2>&1 &
      AGENTBOX_BOOT_STARTED=true
    fi
    BOOT_DIR="$AGENT_HOME/.agentbox/boot.d"
    if [ -d "$BOOT_DIR" ]; then
      for _bs in "$BOOT_DIR"/*; do
        [ -f "$_bs" ] || continue
        echo "Running boot script: $_bs"
        setpriv --reuid=agent --regid=agent --init-groups -- bash -l "$_bs" \
          > "$AGENT_LOGS/boot-$(basename "$_bs").log" 2>&1 &
        AGENTBOX_BOOT_STARTED=true
      done
    fi

    # Execute command or default to bash
    # Use setpriv to drop privileges (su requires PAM/setuid which doesn't work in Nix containers)
    cd /home/agent

    # If services were started in background, wait for them instead of starting a shell
    # This keeps the container alive when running as a systemd service
    if [ "''${ENABLE_OPENCODE:-false}" = "true" ] || \
       [ "''${ENABLE_CLAUDE_CODE:-false}" = "true" ] || \
       [ "$AGENTBOX_BOOT_STARTED" = "true" ]; then
      # If a specific command was passed, run it then wait
      if [ $# -gt 0 ]; then
        setpriv --reuid=agent --regid=agent --init-groups --reset-env -- bash -lc "$*"
      fi
      # Wait for all background processes - this keeps the container alive
      echo "Container running in service mode. Waiting for background processes..."
      wait
    else
      # No services enabled - run interactive shell or command
      if [ $# -gt 0 ]; then
        exec setpriv --reuid=agent --regid=agent --init-groups --reset-env -- bash -lc "$*"
      else
        exec setpriv --reuid=agent --regid=agent --init-groups --reset-env -- bash -l
      fi
    fi
  '';

  # Passwd and group files for the container
  passwdFile = writeTextFile {
    name = "passwd";
    text = ''
      root:x:0:0:root:/root:/bin/bash
      agent:x:1000:1000:Agent User:/home/agent:/bin/bash
      sshd:x:74:74:sshd:/var/empty/sshd:/bin/false
      nobody:x:65534:65534:Nobody:/:/bin/false
    '';
  };

  groupFile = writeTextFile {
    name = "group";
    text = ''
      root:x:0:
      agent:x:1000:agent
      docker:x:999:agent
      sshd:x:74:
      nobody:x:65534:
    '';
  };

  shadowFile = writeTextFile {
    name = "shadow";
    text = ''
      root:!:1::::::
      agent:!:1::::::
      sshd:!:1::::::
      nobody:!:1::::::
    '';
  };

  # Nsswitch.conf for name service switch
  nsswitchFile = writeTextFile {
    name = "nsswitch.conf";
    text = ''
      passwd:    files
      group:     files
      shadow:    files
      hosts:     files dns
      networks:  files
      protocols: files
      services:  files
    '';
  };

  # SSH configuration
  sshdConfig = writeTextFile {
    name = "sshd_config";
    text = ''
      Port 22
      PermitRootLogin no
      PasswordAuthentication yes
      ChallengeResponseAuthentication no
      UsePAM no
      Subsystem sftp /libexec/sftp-server
      AcceptEnv LANG LC_*
      HostKey /etc/ssh/ssh_host_rsa_key
      HostKey /etc/ssh/ssh_host_ed25519_key
    '';
  };

  # Profile for environment setup
  profileFile = writeTextFile {
    name = "profile";
    text = ''
      export PATH="/bin:/usr/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin"
      export LANG="en_US.UTF-8"
      export LC_ALL="en_US.UTF-8"
      export TERM="xterm-256color"
      export EDITOR="nvim"
      export VISUAL="nvim"

      # Go
      export GOPATH="$HOME/go"
      export PATH="$GOPATH/bin:$PATH"

      # Rust
      export CARGO_HOME="$HOME/.cargo"
      export RUSTUP_HOME="$HOME/.rustup"

      # Node/Bun
      export BUN_INSTALL="$HOME/.bun"

      # Python/UV
      export UV_TOOL_BIN_DIR="$HOME/.local/bin"

      # Native library paths for Python C-extensions (numpy, manifold3d, etc.)
      # gcc.cc.lib provides libstdc++.so.6; zlib provides libz.so.1
      export LD_LIBRARY_PATH="${gcc.cc.lib}/lib:${zlib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

      # Locale
      export LOCALE_ARCHIVE="${glibcLocales}/lib/locale/locale-archive"
    '';
  };

  # Claude Code settings: default to auto mode so agents don't get permission prompts
  claudeSettingsFile = writeTextFile {
    name = "claude-settings.json";
    text = ''
      {
        "permissions": {
          "defaultMode": "auto"
        }
      }
    '';
  };

  # Default tmux config for the container skeleton.
  # Enables clipboard and terminal-protocol passthrough so that:
  #   - OSC 52 clipboard sequences reach the outer macOS terminal (set-clipboard on)
  #   - Image-paste protocols (iTerm2 OSC 1337, Kitty APC) pass through tmux
  #     untouched to the outer terminal (allow-passthrough on, tmux ≥ 3.3)
  # The user can override this by placing a .tmux.conf in the /config volume;
  # the entrypoint will symlink /config/.tmux.conf → ~/.tmux.conf when present.
  tmuxConfFile = writeTextFile {
    name = "tmux.conf";
    text = ''
      # ── Terminal ──────────────────────────────────────────────────────────────
      set -g default-terminal "tmux-256color"
      set -as terminal-features ",xterm-256color:RGB"

      # ── Clipboard & image-paste passthrough ───────────────────────────────────
      # set-clipboard on   → forward OSC 52 clipboard R/W to the outer terminal
      # allow-passthrough  → let DCS/APC/OSC sequences (Kitty, iTerm2 images) pass
      #                      through to the outer terminal unmodified (tmux ≥ 3.3)
      set-option -g set-clipboard on
      set-option -g allow-passthrough on

      # ── Window naming ─────────────────────────────────────────────────────────
      # allow-rename on       → let programs rename the window via the tmux
      #                         rename escape (\033k…\033\\)
      # automatic-rename on   → keep the window name in sync with the running
      #                         program; format uses pane_title so the OSC 2
      #                         title set by Claude Code (conversation summary)
      #                         becomes the tmux window name automatically. The
      #                         name is capped so a long summary — e.g. when
      #                         resuming a session — does not crowd the status
      #                         bar; the trailing … marks truncation (tmux ≥ 3.4).
      set -g allow-rename on
      setw -g automatic-rename on
      setw -g automatic-rename-format "#{=/15/…:pane_title}"

      # ── Sensible defaults ─────────────────────────────────────────────────────
      set -sg escape-time 0
      set -g history-limit 50000
      set -g mouse on
      set -g focus-events on
      set -g base-index 1
      setw -g pane-base-index 1
    '';
  };

  # Bashrc for interactive shells
  bashrcFile = writeTextFile {
    name = "bashrc";
    text = ''
      [ -f /etc/profile ] && source /etc/profile

      # Aliases
      alias ls='ls --color=auto'
      alias ll='ls -la'
      alias grep='grep --color=auto'
      alias vim='nvim'
      alias vi='nvim'

      # Prompt
      PS1='\[\033[01;32m\]\u@agentbox\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

      # History
      HISTSIZE=10000
      HISTFILESIZE=20000
      HISTCONTROL=ignoreboth:erasedups

      # FZF
      [ -f ~/.fzf.bash ] && source ~/.fzf.bash
    '';
  };

  # Skeleton directory for new users (includes OpenCode plugins)
  skelDir = runCommand "skel-agent" { } ''
    mkdir -p $out/.config/opencode/plugins $out/.config/opencode/command $out/.local/bin $out/.ssh $out/.agentbox-logs $out/.cache
    mkdir -p $out/.claude/hooks $out/.claude/commands
    cp ${bashrcFile} $out/.bashrc
    cp ${tmuxConfFile} $out/.tmux.conf
    cp ${claudeSettingsFile} $out/.claude/settings.json
    chmod 700 $out/.ssh

    # Copy embedded single-file plugins
    cp ${buildValidatorPlugin} $out/.config/opencode/plugins/build-validator.ts
    cp ${dangerousCommandBlockerPlugin} $out/.config/opencode/plugins/dangerous-command-blocker.ts
    cp ${preCommitLintPlugin} $out/.config/opencode/plugins/pre-commit-lint.ts
    cp ${secretScannerPlugin} $out/.config/opencode/plugins/secret-scanner.ts
    cp ${staticCheckPlugin} $out/.config/opencode/plugins/static-check.ts
    cp ${testRunnerPlugin} $out/.config/opencode/plugins/test-runner.ts

    # Shared test-runner script (always invoked via `bun ...`, so no exec bit).
    cp ${sharedTestRunnerScript} $out/.local/bin/shared-test-runner.ts

    # Claude Code PostToolUse wiring
    cp ${claudeCodeTestRunnerHook} $out/.claude/hooks/test-runner.sh
    chmod +x $out/.claude/hooks/test-runner.sh

    # Gitleaks pre-commit guard: shared bash script + Claude Code hook +
    # OpenCode plugin all delegate to the same dd-gitleaks-precommit.sh.
    cp ${ddGitleaksScript} $out/.local/bin/dd-gitleaks-precommit.sh
    chmod +x $out/.local/bin/dd-gitleaks-precommit.sh
    cp ${claudeCodeGitleaksHook} $out/.claude/hooks/gitleaks-precommit.sh
    chmod +x $out/.claude/hooks/gitleaks-precommit.sh
    cp ${gitleaksPrecommitPlugin} $out/.config/opencode/plugins/gitleaks-precommit.ts

    # Skill commands from the external claude-skills repo (Claude Code + OpenCode)
    ${lib.optionalString (claude-skills-src != null) ''
      cp ${claude-skills-src}/claude/*.md $out/.claude/commands/
      cp ${claude-skills-src}/opencode/*.md $out/.config/opencode/command/
    ''}

    # Writable context directory placeholder — actual writes happen at runtime
    mkdir -p $out/contexts
  '';

  # CA certificate path for use in extraCommands
  caCertPath = cacert;

in
dockerTools.buildLayeredImage {
  name = "agentbox";
  tag = "latest";

  # Maximum layers for better caching
  maxLayers = 125;

  contents = [
    packageEnv
    entrypointScript
    entrypointUserScript
  ];

  # Extra commands to set up the filesystem
  extraCommands = ''
    # Create directory structure
    mkdir -p etc run tmp var/tmp var/empty/sshd var/log
    mkdir -p home/agent workspace config
    mkdir -p etc/skel.agent
    mkdir -p root

    # Install config files
    cp ${passwdFile} etc/passwd
    cp ${groupFile} etc/group
    cp ${shadowFile} etc/shadow
    cp ${nsswitchFile} etc/nsswitch.conf
    cp ${profileFile} etc/profile
    mkdir -p etc/ssh
    cp ${sshdConfig} etc/ssh/sshd_config

    # Copy skeleton (use cp -rT to copy contents, not the directory itself)
    cp -rT ${skelDir} etc/skel.agent/

    # OpenCode plugins are now included directly in skelDir

    # Set up CA certificates
    mkdir -p etc/ssl/certs
    ln -sf ${caCertPath}/etc/ssl/certs/ca-bundle.crt etc/ssl/certs/ca-certificates.crt
    ln -sf ${caCertPath}/etc/ssl/certs/ca-bundle.crt etc/ssl/certs/ca-bundle.crt

    # Timezone
    mkdir -p usr/share/zoneinfo
    ln -sf ${tzdata}/share/zoneinfo/UTC usr/share/zoneinfo/UTC
    ln -sf usr/share/zoneinfo/UTC etc/localtime
    echo "UTC" > etc/timezone

    # Locale archive
    mkdir -p usr/lib/locale
    ln -sf ${glibcLocales}/lib/locale/locale-archive usr/lib/locale/locale-archive

    # Create /usr/bin/env symlink for scripts with #!/usr/bin/env shebang
    # Many npm/bun packages use this shebang
    mkdir -p usr/bin
    ln -sf /bin/env usr/bin/env

    # FHS compat for pre-compiled binaries (e.g., the claude-code native binary
    # fetched by the official native installer, https://claude.ai/install.sh).
    # These binaries embed a standard ELF interpreter path that doesn't exist in Nix containers.
    mkdir -p lib64
    ${lib.optionalString stdenv.hostPlatform.isx86_64 ''
      ln -sf ${glibc}/lib/ld-linux-x86-64.so.2 lib64/ld-linux-x86-64.so.2
    ''}
    ${lib.optionalString stdenv.hostPlatform.isAarch64 ''
      ln -sf ${glibc}/lib/ld-linux-aarch64.so.1 lib/ld-linux-aarch64.so.1
    ''}

    # Permissions (note: these may not persist in OCI image, handled at runtime)
    chmod 755 tmp var/tmp || true
    chmod 1777 tmp var/tmp || true
    chmod 644 etc/passwd etc/group || true
    chmod 640 etc/shadow || true
  '';

  config = {
    Entrypoint = [ "${entrypointScript}/bin/entrypoint" ];
    Cmd = [ "bash" ];
    WorkingDir = "/workspace";
    ExposedPorts = {
      "22/tcp" = { }; # SSH
      "4096/tcp" = { }; # OpenCode server
    };
    Env = [
      "PATH=/bin:/usr/bin:/usr/local/bin"
      "LANG=en_US.UTF-8"
      "LC_ALL=en_US.UTF-8"
      "TERM=xterm-256color"
      "HOME=/home/agent"
      "USER=agent"
      "SSL_CERT_FILE=${caCertPath}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${caCertPath}/etc/ssl/certs/ca-bundle.crt"
      "LOCALE_ARCHIVE=${glibcLocales}/lib/locale/locale-archive"
    ];
    User = "root"; # Entrypoint runs as root, then switches to agent
    Volumes = {
      "/home/agent" = { };
      "/workspace" = { };
      "/config" = { };
      "/var/run/docker.sock" = { };
    };
    Labels = {
      "org.opencontainers.image.title" = "Agentbox";
      "org.opencontainers.image.description" = "Nix-based AI coding agent sandbox";
    };
  };
}
