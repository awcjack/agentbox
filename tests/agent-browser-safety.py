#!/usr/bin/env python3
"""Offline source-policy and packaged CLI checks; never launches a browser.

Usage: agent-browser-safety.py [--source PATCHED_SOURCE_ROOT] [--binary CLI]
The CLI check uses an isolated HOME/socket directory and terminates its daemons.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def check_source(root):
    chrome = (root / "cli/src/native/cdp/chrome.rs").read_text()
    # An unconditional false is deliberately stronger than environment-specific
    # tests: CI/root/Docker/Podman/cgroup detection cannot turn the sandbox off.
    assert re.search(
        r"fn should_disable_sandbox\(_existing_args: &\[String\]\) -> bool\s*\{\s*false\s*\}",
        chrome,
    ), "sandbox auto-disable policy changed"
    daemon = (root / "cli/src/native/daemon.rs").read_text()
    assert 'if env::var("AGENT_BROWSER_NO_STREAM").as_deref() != Ok("1") {' in daemon
    assert daemon.count("StreamServer::start_without_client(") == 1
    actions = (root / "cli/src/native/actions.rs").read_text()
    implicit = actions.split("} else if !skip_launch_action(action) && needs_implicit_launch {", 1)[1]
    assert implicit.index('actions.push("launch".to_string());') < implicit.index("let plugins ="), "implicit launch must pass launch policy before any target early return"
    print("PASS: sandbox preservation, no-stream and implicit-launch source policy")


def listening_tcp_sockets(pid):
    """Find this daemon's TCP LISTEN sockets, not unrelated system listeners."""
    owned = set()
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        if target.startswith("socket:["):
            owned.add(target[8:-1])
    listeners = set()
    for name in ("tcp", "tcp6"):
        path = Path(f"/proc/{pid}/net/{name}")
        if path.exists():
            for line in path.read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == "0A" and fields[9] in owned:
                    listeners.add(fields[9])
    return listeners


def check_binary(binary):
    binary = str(Path(binary).resolve())
    with tempfile.TemporaryDirectory(prefix="ab-") as tmp:
        # Do not inherit user configuration, provider credentials, or browser
        # variables. The installed CLI must find skill-data without an override.
        env = {
            "HOME": tmp,
            "PATH": os.environ.get("PATH", ""),
            "AGENT_BROWSER_SOCKET_DIR": tmp,
            "AGENT_BROWSER_IDLE_TIMEOUT_MS": "0",
            "CI": "1",
        }
        version = subprocess.check_output([binary, "--version"], env=env, text=True)
        assert "0.41.2" in version, version
        skills = subprocess.check_output([binary, "skills", "get", "core"], env=env, text=True)
        assert "agent-browser" in skills and len(skills) > 100, "packaged skill-data missing"
        # Also check a reference file, not only SKILL.md.
        reference = subprocess.check_output(
            [binary, "skills", "get", "core", "--ref", "commands"], env=env, text=True
        )
        assert len(reference) > 100, "packaged skill references missing"
        for disabled in (True, False):
            session = "nostream" if disabled else "stream"
            daemon_env = dict(env, AGENT_BROWSER_DAEMON="1", AGENT_BROWSER_SESSION=session)
            if disabled:
                daemon_env["AGENT_BROWSER_NO_STREAM"] = "1"
            with subprocess.Popen(
                [binary], env=daemon_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            ) as daemon:
                try:
                    socket = Path(tmp) / f"{session}.sock"
                    stream = Path(tmp) / f"{session}.stream"
                    deadline = time.monotonic() + 20
                    while not socket.exists():
                        assert daemon.poll() is None, "daemon exited before creating socket"
                        assert time.monotonic() < deadline, "daemon startup timed out"
                        time.sleep(0.05)
                    assert stream.exists() is not disabled, "unexpected automatic stream state"
                    listeners = listening_tcp_sockets(daemon.pid)
                    assert bool(listeners) is not disabled, "unexpected TCP listener state"
                finally:
                    daemon.terminate()
                    try:
                        stdout, stderr = daemon.communicate(timeout=10)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        stdout, stderr = daemon.communicate()
                    if stderr:
                        print(stderr.decode(errors="replace"))
        print("PASS: version, bundled skills/references, no-stream daemon has no TCP listeners")
        print("PASS: default upstream stream startup remains available for explicit future opt-in")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--binary")
    args = parser.parse_args()
    if not (args.source or args.binary):
        parser.error("provide --source and/or --binary")
    if args.source:
        check_source(args.source)
    if args.binary:
        check_binary(args.binary)


if __name__ == "__main__":
    main()
