#!/usr/bin/env python3
"""Trusted host lifecycle. Never mount the Docker socket into the agent."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

NAMES = ("agentbox-network", "agentbox-egress-proxy")
LABEL = "org.agentbox.network-policy"


def docker(*args, check=True, **kwargs):
    return subprocess.run(
        ["docker", *args], check=check, text=True, stdout=subprocess.PIPE, **kwargs
    )


def inspect(name):
    result = docker("inspect", name, check=False, stderr=subprocess.DEVNULL)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def running(name):
    info = inspect(name)
    return bool(info and info["State"]["Running"])


def remove(name):
    if inspect(name):
        docker("rm", "-f", name)


def wait_ready(name, proxy=False):
    for _ in range(60):
        info = inspect(name)
        if not info or not info["State"]["Running"]:
            raise RuntimeError(f"{name} exited; inspect docker logs {name}")
        if proxy:
            # A TCP listener only opens after firewall installation and parsing.
            ready = (
                docker(
                    "exec",
                    name,
                    "python3",
                    "-c",
                    "import socket; socket.create_connection(('127.0.0.1',3128),1).close()",
                    check=False,
                    stderr=subprocess.DEVNULL,
                ).returncode
                == 0
            )
        else:
            ready = info["State"].get("Health", {}).get("Status") == "healthy"
        if ready:
            return
        time.sleep(0.5)
    raise RuntimeError(f"{name} did not become ready")


def start(args, policy):
    expected = list(NAMES if policy["domains"]["enable"] else NAMES[:1])
    current = [inspect(name) for name in expected]
    matching = all(
        info
        and info["State"]["Running"]
        and info["Config"].get("Labels", {}).get(LABEL) == args.fingerprint
        for info in current
    )
    if matching:
        for name in expected:
            wait_ready(name, name == NAMES[1])
        write_environment(args, policy)
        return
    if running("agentbox") or running("agentbox-docker-proxy"):
        raise RuntimeError(
            "network policy changed or companion stopped; stop agentbox before restarting its network"
        )
    # A stopped agent retains the old namespace reference. Recreate it too.
    remove("agentbox")
    remove("agentbox-docker-proxy")
    for name in NAMES:
        remove(name)
    if (
        docker(
            "network",
            "inspect",
            "agentbox-egress",
            check=False,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    ):
        docker("network", "create", "--ipv6", "agentbox-egress")
    # Loading is intentionally unconditional on policy recreation: tags alone
    # cannot prove which immutable Nix image was loaded by a previous rebuild.
    with open(args.image) as archive:
        docker("load", stdin=archive)
    # macOS runtimes generally share the user's home, but not /nix/store.
    staged_policy = Path(args.environment_file).parent / "network-policy.json"
    staged_policy.parent.mkdir(parents=True, exist_ok=True)
    staged_policy.write_bytes(Path(args.policy).read_bytes())
    os.chmod(staged_policy, 0o644)
    common = [
        "--network=agentbox-egress",
        "--read-only",
        "--memory=256m",
        "--pids-limit=128",
        "--cpus=1",
        "--cap-drop=ALL",
        "--cap-add=NET_ADMIN",
        "--cap-add=NET_RAW",
        "--cap-add=SETUID",
        "--cap-add=SETGID",
        "--security-opt=no-new-privileges",
        "--tmpfs=/run",
        "--tmpfs=/tmp:mode=1777",
        "--label",
        f"{LABEL}={args.fingerprint}",
        "--mount",
        f"type=bind,src={staged_policy},dst=/policy.json,readonly",
    ]
    try:
        proxy_ip = None
        if policy["domains"]["enable"]:
            docker(
                "run",
                "-d",
                "--name",
                NAMES[1],
                *common,
                "agentbox-network:latest",
                "proxy",
                "/policy.json",
            )
            wait_ready(NAMES[1], True)
            proxy_ip = inspect(NAMES[1])["NetworkSettings"]["Networks"][
                "agentbox-egress"
            ]["IPAddress"]
        publish = [
            arg for spec in policy["publishedPorts"] for arg in ("--publish", spec)
        ]
        docker(
            "run",
            "-d",
            "--name",
            NAMES[0],
            *common,
            *publish,
            "--health-cmd=test -f /run/ready",
            "--health-interval=1s",
            "--health-retries=30",
            "agentbox-network:latest",
            "guardian",
            "/policy.json",
            *([proxy_ip] if proxy_ip else []),
        )
        wait_ready(NAMES[0])
        write_environment(args, policy)
    except Exception:
        for name in NAMES:
            remove(name)
        raise


def write_environment(args, policy):
    path = Path(args.environment_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = ""
    if policy["domains"]["enable"]:
        address = inspect(NAMES[1])["NetworkSettings"]["Networks"]["agentbox-egress"][
            "IPAddress"
        ]
        content = "".join(
            f"{key}=http://{address}:3128\n"
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
        )
        content += (
            "NO_PROXY=localhost,127.0.0.1,::1\nno_proxy=localhost,127.0.0.1,::1\n"
        )
    # These files are outside every agent bind mount. Replace atomically.
    for target, value in (
        (path, content),
        (
            Path(str(path) + ".resolv"),
            "".join(f"nameserver {ip}\n" for ip in policy["dnsServers"]),
        ),
    ):
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(value)
        os.chmod(temporary, 0o644)
        temporary.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--validator", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--environment-file", required=True)
    parser.add_argument("action", choices=("start", "stop"))
    args = parser.parse_args()
    if args.action == "stop":
        if running("agentbox") or running("agentbox-docker-proxy"):
            raise RuntimeError(
                "stop agentbox and its Docker socket proxy before stopping the network"
            )
        for name in NAMES:
            remove(name)
        return
    subprocess.run(
        [sys.executable, args.validator, "validate", args.policy], check=True
    )
    start(args, json.loads(Path(args.policy).read_text()))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
