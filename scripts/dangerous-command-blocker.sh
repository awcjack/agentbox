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
