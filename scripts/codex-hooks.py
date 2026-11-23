#!/usr/bin/env python3
"""Adapt Agentbox's shared guards and tests to Codex lifecycle events."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


ROOT = Path(__file__).resolve().parent


def git(cwd, *args):
    result = subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, check=False
    )
    return result.stdout if result.returncode == 0 else b""


def commit_directories(command, cwd):
    """Recognize git commit, including git -C and simple cd command chains."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError:
        return
    for i, token in enumerate(tokens):
        if token == "cd" and i + 1 < len(tokens):
            directory = Path(tokens[i + 1]).expanduser()
            cwd = directory if directory.is_absolute() else cwd / directory
        if Path(token).name != "git":
            continue
        directory = cwd
        j = i + 1
        while j < len(tokens):
            option = tokens[j]
            if option == "-C" and j + 1 < len(tokens):
                path = Path(tokens[j + 1]).expanduser()
                directory = path if path.is_absolute() else directory / path
                j += 2
            elif option == "-c" and j + 1 < len(tokens):
                j += 2
            else:
                break
        if j < len(tokens) and tokens[j] == "commit":
            yield directory


def guard(payload):
    tool_input = payload.get("tool_input", {})
    command = tool_input.get("command", "")
    if not isinstance(command, str):
        return 0
    # Shared Bash hooks consume the Claude-compatible command input.
    result = subprocess.run(
        ["bash", str(ROOT / "dangerous-command-blocker.sh")],
        input=json.dumps(payload), text=True, capture_output=True, check=False,
    )
    if result.returncode:
        sys.stderr.write(result.stderr)
        return result.returncode
    cwd = Path(tool_input.get("cwd") or tool_input.get("workdir") or payload["cwd"])
    for directory in dict.fromkeys(commit_directories(command, cwd)):
        result = subprocess.run(
            ["bash", str(ROOT / "gitleaks-precommit.sh"), str(directory)],
            text=True, capture_output=True, check=False,
        )
        sys.stderr.write(result.stderr)
        if result.returncode:
            return result.returncode
    return 0


def test_scope(file, root):
    """Run each package's suite once even when several files changed."""
    extension = file.suffix
    if extension == ".go":
        return file.parent
    marker = "Cargo.toml" if extension == ".rs" else "package.json"
    for directory in (file.parent, *file.parent.parents):
        if (directory / marker).is_file():
            return directory
        if directory == root:
            break
    return file.parent


def tests(payload):
    # A failure requests one repair pass; never create an endless Stop loop.
    if payload.get("stop_hook_active"):
        return 0
    cwd = Path(payload["cwd"])
    root_bytes = git(cwd, "rev-parse", "--show-toplevel").rstrip(b"\n")
    if not root_bytes:
        return 0
    root = Path(os.fsdecode(root_bytes))
    paths = git(root, "diff", "--name-only", "-z", "HEAD")
    paths += git(root, "ls-files", "--others", "--exclude-standard", "-z")
    extensions = {".go", ".rs", ".ts", ".tsx", ".js", ".jsx"}
    skip = {"vendor", "node_modules", ".git", "dist", "build", "target", ".venv", "venv"}
    scopes = set()
    failures = []
    for relative in paths.split(b"\0"):
        if not relative:
            continue
        file = root / os.fsdecode(relative)
        if not file.is_file() or file.suffix not in extensions or skip.intersection(file.relative_to(root).parts):
            continue
        scope = (file.suffix == ".go", file.suffix == ".rs", test_scope(file, root))
        if scope in scopes:
            continue
        scopes.add(scope)
        result = subprocess.run(
            ["bun", str(ROOT / "shared-test-runner.ts"), str(file)],
            cwd=root, text=True, capture_output=True, check=False,
        )
        if result.returncode:
            failures.append(result.stderr or result.stdout or "Test runner failed")
    if failures:
        sys.stderr.write("Fix the failing tests before finishing:\n" + "\n".join(failures)[:8000])
        return 2
    return 0


def main():
    runtime = json.loads((ROOT / "runtime.json").read_text())
    os.environ["PATH"] = runtime["path"] + os.pathsep + os.environ.get("PATH", "")
    payload = json.load(sys.stdin)
    if sys.argv[1] == "guard":
        return guard(payload)
    if sys.argv[1] == "tests":
        return tests(payload)
    raise ValueError("unknown hook action")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        # Exit 1 reports a hook error without misrepresenting it as a policy denial.
        print(f"Agentbox hook error: {error}", file=sys.stderr)
        sys.exit(1)
