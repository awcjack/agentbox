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
  linux-pam,
  nix,
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
  # When true, bake cloud CLIs (awscli2, kubectl, kubernetes-helm, gcloud +
  # gke-gcloud-auth-plugin, docker-client) into the image. Off by default so
  # the base image stays lean. Enable via the NixOS module option
  # `services.agentbox.settings.enableCloudTools = true` (which builds the image
  # with `.override { withCloudTools = true; }`) or directly with
  # `agentboxImage.override { withCloudTools = true; }`.
  withCloudTools ? false,
  # When true (default), bake the `nix` CLI into the image and register the
  # store DB (via dockerTools.buildLayeredImageWithNixDb) so nix actually works
  # inside the container. Paired with a `nix-daemon` started at boot (gated by
  # ENABLE_NIX), this lets the agent install throwaway packages with
  # `nix profile install nixpkgs#<pkg>` / `nix shell nixpkgs#<pkg>` — they live
  # in the container's writable layer and vanish when it is recreated. There is
  # no apt/dpkg in this image, so nix is the in-container package manager.
  # Disable via `services.agentbox.settings.enableNix = false` (NixOS builds the
  # image with `.override { withNix = false; }`) to keep the image lean.
  withNix ? true,
}:

let
  # ---------------------------------------------------------------------------
  # OpenCode Plugins — only plugins using the current API are included.
  # Correct hooks: tool.execute.before / tool.execute.after (not tool.complete).
  # Dead plugins that used the non-existent tool.complete event have been
  # removed: build-validator, dangerous-command-blocker, pre-commit-lint,
  # secret-scanner, static-check. Remaining: test-runner and gitleaks-precommit.
  # ---------------------------------------------------------------------------

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

  # Claude Code Stop hook: run tests for source files changed since the last commit.
  # Fires at the end of each full agent turn (background_tasks guard prevents
  # false runs when the turn merely paused waiting on background work).
  claudeCodeStopTestRunnerHook = writeTextFile {
    name = "stop-test-runner.sh";
    executable = true;
    text = ''
      #!/usr/bin/env bash
      # Stop hook: run tests for source files changed since the last commit.
      set -u
      hook_input="$(cat)"

      # Skip when the agent is still waiting on background work.
      _bg=0
      if command -v jq >/dev/null 2>&1; then
          _bg=$(printf '%s' "$hook_input" | jq '(.background_tasks // []) | length' 2>/dev/null)
      fi
      [ -n "$_bg" ] || _bg=0
      case "$_bg" in *[!0-9]*) _bg=0 ;; esac
      [ "$_bg" -gt 0 ] && exit 0

      # Locate bun (hook env may not have the full PATH from .bashrc).
      BUN_BIN=""
      for _bp in "$HOME/.bun/bin/bun" "/home/agent/.bun/bin/bun"; do
          [ -x "$_bp" ] && BUN_BIN="$_bp" && break
      done
      [ -z "$BUN_BIN" ] && command -v bun >/dev/null 2>&1 && BUN_BIN="$(command -v bun)"
      [ -z "$BUN_BIN" ] && exit 0

      # Find the git repo root from the hook payload cwd or fall back to PWD.
      cwd="$(printf '%s' "$hook_input" | jq -r '.cwd // empty' 2>/dev/null)"
      [ -z "$cwd" ] && cwd="$PWD"
      cd "$cwd" 2>/dev/null || exit 0
      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
      repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

      # Collect unique changed files (staged + unstaged) relative to HEAD.
      changed="$(git diff --name-only HEAD 2>/dev/null)"
      [ -z "$changed" ] && exit 0

      while IFS= read -r rel; do
          [ -z "$rel" ] && continue
          "$BUN_BIN" /home/agent/.local/bin/shared-test-runner.ts "''${repo_root}/''${rel}" 2>&1 || true
      done < <(printf '%s\n' "$changed" | sort -u)
      exit 0
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

  # OpenCode plugin: post-edit test runner. Uses `tool.execute.after` to
  # delegate to the shared test-runner script so the same detection /
  # infra-filter logic is shared with the Claude Code PostToolUse hook.
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
  ]
  # The nix CLI, so the agent can install throwaway packages in-container.
  # The store DB is registered by buildLayeredImageWithNixDb (see the builder
  # selection at the bottom of this file) and a nix-daemon is started at boot.
  ++ lib.optionals withNix [
    nix
  ]
  ++ lib.optionals withCloudTools [
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

    # Claude Code execs ~/.claude/hooks/*.sh directly (from managed-settings.json
    # and ~/.claude/settings.json), so they must stay executable. The skeleton
    # copy below uses --no-preserve=mode to keep home files agent-writable, which
    # strips the +x bit baked into the skel scripts. Re-assert it on every start
    # — placed before the fast-path so homes initialized prior to this fix are
    # repaired too. Cheap idempotent glob; safe to run unconditionally.
    if [ -d "$HOME_DIR/.claude/hooks" ]; then
      chmod +x "$HOME_DIR"/.claude/hooks/*.sh 2>/dev/null || true
    fi

    # Keep baked agent skills available even when ~/.claude, ~/.codex, and
    # ~/.config/opencode are bind-mounted persistent host directories. Host
    # activation creates ~/.bashrc before first start, so the one-shot skeleton
    # copy below may never populate these mounted config dirs.
    if [ -d "$SKEL_DIR" ]; then
      mkdir -p "$HOME_DIR/.claude/commands" "$HOME_DIR/.config/opencode/command" "$HOME_DIR/.codex/skills"
      cp -f "$SKEL_DIR"/.claude/commands/*.md "$HOME_DIR/.claude/commands/" 2>/dev/null || true
      cp -f "$SKEL_DIR"/.config/opencode/command/*.md "$HOME_DIR/.config/opencode/command/" 2>/dev/null || true
      if [ -d "$SKEL_DIR/.codex/skills" ]; then
        cp -rT "$SKEL_DIR/.codex/skills" "$HOME_DIR/.codex/skills" 2>/dev/null || true
      fi
    fi

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
      # Restore +x on hook scripts stripped by --no-preserve=mode (see above), so
      # the very first session after init can run them.
      chmod +x "$HOME_DIR"/.claude/hooks/*.sh 2>/dev/null || true
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
          # Skip when both paths already resolve to the same file. The NixOS
          # module bind-mounts the whole home at /config AND some dotfiles
          # (e.g. .tmux.conf) individually into $HOME_DIR, so the two paths
          # share one inode; `ln` would then fail with "are the same file"
          # and abort the entrypoint under `set -e`.
          if [ "$CONFIG_DIR/$item" -ef "$HOME_DIR/$item" ]; then
            continue
          fi
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

    # Enable in-container `sudo` for the agent user.
    #
    # The Nix store can't hold setuid bits and there's no NixOS
    # `security.wrappers` activation inside the container, so the store-backed
    # `/bin/sudo` can never elevate ("must be owned by uid 0 and have the setuid
    # bit set"). This entrypoint runs as root, so copy the real sudo binary to a
    # writable location and set it setuid-root — the same pattern NixOS uses for
    # /run/wrappers. Its RUNPATH still points at the store, so the sudoers.so
    # plugin, libpam and the PAM modules all resolve from the image. This needs
    # hardening.noNewPrivileges left OFF (the default), which is exactly why this
    # sandbox documents sudo as intentionally allowed. Gated by ENABLE_SUDO
    # (settings.hardening.enableSudo, default true); noNewPrivileges still
    # overrides at the kernel level regardless.
    SUDO_REAL="$(readlink -f /bin/sudo 2>/dev/null || true)"
    if [ "''${ENABLE_SUDO:-true}" != "false" ] && [ -n "$SUDO_REAL" ] && [ -x "$SUDO_REAL" ]; then
      mkdir -p /run/wrappers/bin
      if install -m 4755 -o root -g root "$SUDO_REAL" /run/wrappers/bin/sudo 2>/dev/null; then
        # Repoint the store symlink at the wrapper so `sudo` elevates regardless
        # of PATH ordering (login shells also get /run/wrappers/bin first).
        ln -sf /run/wrappers/bin/sudo /bin/sudo 2>/dev/null || true
      else
        echo "WARNING: could not create setuid sudo wrapper (is the rootfs read-only or noNewPrivileges set?)"
      fi
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

    # Start the nix-daemon so the (unprivileged) agent can install throwaway
    # packages with `nix profile install nixpkgs#<pkg>`. The daemon runs as root
    # and owns the store; the agent reaches it over the socket (NIX_REMOTE=daemon
    # in the profile). The store DB was registered at build time
    # (buildLayeredImageWithNixDb). Gated by ENABLE_NIX (settings.enableNix,
    # default true); no-ops on a `withNix = false` image where nix-daemon is
    # absent. Packages live in the container's writable layer and are lost on
    # recreate — exactly the "temporary package" behaviour.
    if [ "''${ENABLE_NIX:-true}" != "false" ] && command -v nix-daemon >/dev/null 2>&1; then
      echo "Starting nix-daemon..."
      # Per-user profile/gcroot dirs (used by nix-env style installs); new-style
      # `nix profile` keeps its profile under the agent's HOME.
      mkdir -p /nix/var/nix/profiles/per-user/agent /nix/var/nix/gcroots/per-user/agent
      chown agent:agent /nix/var/nix/profiles/per-user/agent /nix/var/nix/gcroots/per-user/agent 2>/dev/null || true
      # NIX_REMOTE=daemon (set image-wide for clients) must NOT reach the daemon
      # itself: nix-daemon honors it when opening its store, so each connection
      # handler would proxy back to its own socket — an infinite fork loop that
      # freezes the container on the first `nix` command.
      env -u NIX_REMOTE nix-daemon > "$AGENT_LOGS/nix-daemon.log" 2>&1 &
    fi

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

  # sudoers: let the agent user run sudo without a password. This box is a
  # single-user dev sandbox — the real trust boundary is the container itself
  # (see the `hardening` options), not in-container privilege separation, so the
  # image ships sudo intending it to work. `secure_path` gives root the wrapper
  # dir + system paths; env_keep preserves locale so tools don't warn.
  sudoersFile = writeTextFile {
    name = "sudoers";
    text = ''
      Defaults secure_path="/run/wrappers/bin:/bin:/usr/bin:/usr/local/bin"
      Defaults env_keep += "LANG LC_ALL LOCALE_ARCHIVE TERM"
      root  ALL=(ALL:ALL) ALL
      agent ALL=(ALL:ALL) NOPASSWD:ALL
    '';
  };

  # PAM policy for sudo. The nixpkgs sudo's `sudoers.so` plugin is linked against
  # libpam and calls pam_acct_mgmt / pam_open_session / pam_setcred even under
  # NOPASSWD, so a valid /etc/pam.d/sudo is required or sudo aborts. Nix has no
  # /lib/security, so modules are referenced by absolute store path. pam_permit
  # unconditionally succeeds — auth is already bypassed by NOPASSWD.
  sudoPamFile = writeTextFile {
    name = "pam-sudo";
    text = ''
      auth       sufficient ${linux-pam}/lib/security/pam_permit.so
      account    sufficient ${linux-pam}/lib/security/pam_permit.so
      password   sufficient ${linux-pam}/lib/security/pam_permit.so
      session    required   ${linux-pam}/lib/security/pam_permit.so
    '';
  };

  # nix.conf for the in-container nix. Multi-user mode: the root nix-daemon owns
  # the store and does the privileged writes, so the unprivileged agent can
  # install packages over the daemon socket. `build-users-group =` (empty) skips
  # the nixbld build accounts (none exist in this image) — the daemon builds as
  # root. Sandboxing is off because the build sandbox needs user namespaces that
  # aren't reliably available inside the container. flakes + nix-command enable
  # `nix profile install nixpkgs#<pkg>`.
  nixConfFile = writeTextFile {
    name = "nix.conf";
    text = ''
      experimental-features = nix-command flakes
      trusted-users = root agent
      build-users-group =
      sandbox = false
      max-jobs = auto
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
      export PATH="/run/wrappers/bin:/bin:/usr/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin"
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

      # Nix: talk to the root nix-daemon and put installed packages on PATH.
      # `nix profile install nixpkgs#<pkg>` links tools into ~/.nix-profile/bin.
      export NIX_REMOTE="daemon"
      export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"

      # Native library paths for Python C-extensions (numpy, manifold3d, etc.)
      # gcc.cc.lib provides libstdc++.so.6; zlib provides libz.so.1
      export LD_LIBRARY_PATH="${gcc.cc.lib}/lib:${zlib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

      # Locale
      export LOCALE_ARCHIVE="${glibcLocales}/lib/locale/locale-archive"
    '';
  };

  # Claude Code settings: auto mode + pre-enabled LSP plugins.
  # enabledPlugins activates the official gopls-lsp and typescript-lsp marketplace
  # plugins (registered in installed_plugins.json below) and the local agentbox-lsp
  # plugin that covers Nix/JSON/HTML/CSS (not in the official marketplace).
  # lspRecommendationDisabled suppresses the "install an LSP plugin?" nag since we
  # pre-seed everything.
  claudeSettingsFile = writeTextFile {
    name = "claude-settings.json";
    text = ''
      {
        "permissions": {
          "defaultMode": "auto"
        },
        "enabledPlugins": {
          "gopls-lsp@claude-plugins-official": true,
          "typescript-lsp@claude-plugins-official": true,
          "agentbox-lsp@local": true
        },
        "lspRecommendationDisabled": true
      }
    '';
  };

  # .lsp.json for the local agentbox-lsp plugin (nil, JSON, HTML, CSS).
  # gopls and typescript-language-server are covered by the official marketplace
  # plugins above; this file adds the servers that have no marketplace entry.
  # Format: record of server-name → { command, args?, extensionToLanguage, diagnostics? }
  claudeAgentboxLspJson = writeTextFile {
    name = "agentbox-lsp.json";
    text = ''
      {
        "nil": {
          "command": "nil",
          "extensionToLanguage": { ".nix": "nix" },
          "diagnostics": true
        },
        "json": {
          "command": "vscode-json-language-server",
          "args": ["--stdio"],
          "extensionToLanguage": { ".json": "json", ".jsonc": "jsonc" },
          "initializationOptions": { "provideFormatter": true },
          "diagnostics": true
        },
        "html": {
          "command": "vscode-html-language-server",
          "args": ["--stdio"],
          "extensionToLanguage": { ".html": "html", ".htm": "html" },
          "diagnostics": false
        },
        "css": {
          "command": "vscode-css-language-server",
          "args": ["--stdio"],
          "extensionToLanguage": { ".css": "css", ".scss": "scss", ".less": "less" },
          "diagnostics": false
        }
      }
    '';
  };

  # Minimal plugin.json for the local agentbox-lsp plugin.
  # Claude Code reads this from the installPath alongside .lsp.json.
  claudeAgentboxLspPluginJson = writeTextFile {
    name = "agentbox-lsp-plugin.json";
    text = ''
      {
        "name": "agentbox-lsp",
        "description": "Agentbox bundled LSP servers: Nix (nil), JSON, HTML, CSS",
        "version": "1.0.0",
        "author": { "name": "agentbox" },
        "category": "development"
      }
    '';
  };

  # installed_plugins.json: pre-registers the official marketplace plugins
  # (gopls-lsp, typescript-lsp) and the local agentbox-lsp plugin.
  # The official plugins are served by the claude-plugins-official marketplace
  # (fetched from GitHub on first run); their lspServers config lives in the
  # remote marketplace.json so only the installPath placeholder dirs are needed.
  # The local agentbox-lsp plugin is read directly from its installPath.
  claudeInstalledPluginsJson = writeTextFile {
    name = "claude-installed-plugins.json";
    text = ''
      {
        "version": 2,
        "plugins": {
          "gopls-lsp@claude-plugins-official": [
            {
              "scope": "user",
              "installPath": "/home/agent/.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0",
              "version": "1.0.0",
              "installedAt": "2026-01-01T00:00:00.000Z",
              "lastUpdated": "2026-01-01T00:00:00.000Z"
            }
          ],
          "typescript-lsp@claude-plugins-official": [
            {
              "scope": "user",
              "installPath": "/home/agent/.claude/plugins/cache/claude-plugins-official/typescript-lsp/1.0.0",
              "version": "1.0.0",
              "installedAt": "2026-01-01T00:00:00.000Z",
              "lastUpdated": "2026-01-01T00:00:00.000Z"
            }
          ],
          "agentbox-lsp@local": [
            {
              "scope": "user",
              "installPath": "/home/agent/.claude/plugins/agentbox-lsp",
              "version": "1.0.0",
              "installedAt": "2026-01-01T00:00:00.000Z",
              "lastUpdated": "2026-01-01T00:00:00.000Z"
            }
          ]
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
    mkdir -p $out/.codex/skills
    mkdir -p $out/.claude/hooks $out/.claude/commands
    mkdir -p $out/.claude/plugins/agentbox-lsp
    mkdir -p $out/.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0
    mkdir -p $out/.claude/plugins/cache/claude-plugins-official/typescript-lsp/1.0.0
    cp ${bashrcFile} $out/.bashrc
    cp ${tmuxConfFile} $out/.tmux.conf
    cp ${claudeSettingsFile} $out/.claude/settings.json
    cp ${claudeInstalledPluginsJson} $out/.claude/plugins/installed_plugins.json
    cp ${claudeAgentboxLspJson} $out/.claude/plugins/agentbox-lsp/.lsp.json
    cp ${claudeAgentboxLspPluginJson} $out/.claude/plugins/agentbox-lsp/plugin.json
    chmod 700 $out/.ssh

    # Working OpenCode plugins (tool.execute.before / tool.execute.after).
    cp ${testRunnerPlugin} $out/.config/opencode/plugins/test-runner.ts
    cp ${gitleaksPrecommitPlugin} $out/.config/opencode/plugins/gitleaks-precommit.ts

    # Shared test-runner script (always invoked via `bun ...`, so no exec bit).
    cp ${sharedTestRunnerScript} $out/.local/bin/shared-test-runner.ts

    # Claude Code PostToolUse wiring
    cp ${claudeCodeTestRunnerHook} $out/.claude/hooks/test-runner.sh
    chmod +x $out/.claude/hooks/test-runner.sh

    # Claude Code Stop hook: run tests for files changed since the last commit.
    cp ${claudeCodeStopTestRunnerHook} $out/.claude/hooks/stop-test-runner.sh
    chmod +x $out/.claude/hooks/stop-test-runner.sh

    # Gitleaks pre-commit guard: shared bash script + Claude Code hook +
    # OpenCode plugin all delegate to the same dd-gitleaks-precommit.sh.
    cp ${ddGitleaksScript} $out/.local/bin/dd-gitleaks-precommit.sh
    chmod +x $out/.local/bin/dd-gitleaks-precommit.sh
    cp ${claudeCodeGitleaksHook} $out/.claude/hooks/gitleaks-precommit.sh
    chmod +x $out/.claude/hooks/gitleaks-precommit.sh

    # Skill commands from the external claude-skills repo. Claude Code and
    # OpenCode use slash-command markdown files. Codex uses directory-based
    # SKILL.md files, generated from the Claude command source so all three
    # agents share the same skill names and instructions.
    ${lib.optionalString (claude-skills-src != null) ''
      cp ${claude-skills-src}/claude/*.md $out/.claude/commands/
      cp ${claude-skills-src}/opencode/*.md $out/.config/opencode/command/

      for src in ${claude-skills-src}/claude/*.md; do
        name="$(basename "$src" .md)"
        dest="$out/.codex/skills/$name"
        mkdir -p "$dest"
        description="$(awk '
          BEGIN { in_fm = 0 }
          NR == 1 && $0 == "---" { in_fm = 1; next }
          in_fm && $0 == "---" { exit }
          in_fm && /^description:[[:space:]]*/ {
            sub(/^description:[[:space:]]*/, "")
            print
            exit
          }
        ' "$src")"
        [ -n "$description" ] || description="$name"
        {
          printf '%s\n' '---'
          printf 'name: %s\n' "$name"
          printf 'description: %s\n' "$description"
          printf '%s\n\n' '---'
          awk '
            NR == 1 && $0 == "---" { in_fm = 1; next }
            in_fm && $0 == "---" { in_fm = 0; next }
            !in_fm { print }
          ' "$src"
        } > "$dest/SKILL.md"
      done
    ''}

    # Writable context directory placeholder — actual writes happen at runtime
    mkdir -p $out/contexts
  '';

  # CA certificate path for use in extraCommands
  caCertPath = cacert;

in
# buildLayeredImageWithNixDb registers the Nix store database for every path in
# the image, which is what makes the in-container `nix` treat those paths as
# valid and able to build/substitute on top of them. Fall back to the plain
# builder (no DB, smaller) when nix isn't baked in.
(if withNix then dockerTools.buildLayeredImageWithNixDb else dockerTools.buildLayeredImage) {
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

    # sudo: sudoers policy + PAM config. The setuid wrapper itself can't live in
    # the store (no setuid bits) — the entrypoint stages it under /run/wrappers
    # at container start.
    mkdir -p etc/pam.d
    cp ${sudoersFile} etc/sudoers
    cp ${sudoPamFile} etc/pam.d/sudo
    ${lib.optionalString withNix ''
      # nix: daemon config (the nix-daemon itself is started by the entrypoint).
      mkdir -p etc/nix
      cp ${nixConfFile} etc/nix/nix.conf
    ''}

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
    chmod 440 etc/sudoers || true
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
      # nix profile dirs are on PATH so packages installed via `nix profile
      # install` are found by non-login `agentbox exec` too (harmless when empty).
      "PATH=/run/wrappers/bin:/home/agent/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/bin:/usr/bin:/usr/local/bin"
      "LANG=en_US.UTF-8"
      "LC_ALL=en_US.UTF-8"
      "TERM=xterm-256color"
      "HOME=/home/agent"
      "USER=agent"
      "SSL_CERT_FILE=${caCertPath}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${caCertPath}/etc/ssl/certs/ca-bundle.crt"
      "LOCALE_ARCHIVE=${glibcLocales}/lib/locale/locale-archive"
    ]
    ++ lib.optionals withNix [
      # Route the agent's nix at the root daemon started by the entrypoint.
      "NIX_REMOTE=daemon"
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
