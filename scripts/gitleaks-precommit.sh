#!/usr/bin/env bash
# Shared gitleaks pre-commit guard — invoked from the Claude Code
# PreToolUse hook and the OpenCode tool.execute.before plugin.
set -u

cwd="${1:-$PWD}"
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
