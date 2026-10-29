#!/usr/bin/env python3
"""Live Docker enforcement test. Uses only agentbox-network:latest, no internet.

Load/build the helper image first, then run: python3 tests/network-integration.py
All fixtures use unique names; existing Agentbox containers are untouched.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

IMAGE = "agentbox-network:latest"
PREFIX = "agentbox-test-" + uuid.uuid4().hex[:10]
NETWORK = PREFIX + "-net"
containers = []


def docker(*args, check=True):
    return subprocess.run(
        ["docker", *args], check=check, text=True, capture_output=True
    )


def run(name, *args):
    full_name = PREFIX + "-" + name
    containers.append(full_name)
    docker("run", "-d", "--name", full_name, *args)
    return full_name


def address(name, ipv6=False):
    data = json.loads(docker("inspect", name).stdout)[0]
    return data["NetworkSettings"]["Networks"][NETWORK][
        "GlobalIPv6Address" if ipv6 else "IPAddress"
    ]


def client(guardian, code):
    result = docker(
        "run",
        "--rm",
        "--network=container:" + guardian,
        "--cap-drop=NET_ADMIN",
        "--cap-drop=NET_RAW",
        "--cap-drop=SYS_ADMIN",
        "--entrypoint=python3",
        IMAGE,
        "-c",
        code,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)


def wait(name, proxy=False):
    code = (
        "import socket; socket.create_connection(('127.0.0.1',3128),1).close()"
        if proxy
        else "from pathlib import Path; assert Path('/run/ready').exists()"
    )
    for _ in range(60):
        if docker("exec", name, "python3", "-c", code, check=False).returncode == 0:
            return
        if not json.loads(docker("inspect", name).stdout)[0]["State"]["Running"]:
            break
        time.sleep(0.5)
    raise AssertionError(docker("logs", name, check=False).stderr)


def main():
    docker("info")
    docker("image", "inspect", IMAGE)
    docker("network", "create", "--ipv6", NETWORK)
    server = """
import http.server, socket, threading, signal
class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()
for port in (80, 443):
    threading.Thread(target=Server(('::', port), http.server.SimpleHTTPRequestHandler).serve_forever, daemon=True).start()
signal.pause()
"""
    fixture = run(
        "fixture", "--network=" + NETWORK, "--entrypoint=python3", IMAGE, "-c", server
    )
    blocked = run(
        "blocked", "--network=" + NETWORK, "--entrypoint=python3", IMAGE, "-c", server
    )
    ipv4, ipv6 = address(fixture), address(fixture, True)
    blocked4, blocked6 = address(blocked), address(blocked, True)
    for _ in range(60):
        if (
            docker(
                "exec",
                fixture,
                "python3",
                "-c",
                "import socket; socket.create_connection(('127.0.0.1',80),1).close()",
                check=False,
            ).returncode
            == 0
        ):
            break
        time.sleep(0.5)
    with tempfile.TemporaryDirectory(prefix="agentbox-network-test-") as directory:
        path = Path(directory) / "policy.json"
        common = [
            "--network=" + NETWORK,
            "--cap-drop=ALL",
            "--cap-add=NET_ADMIN",
            "--cap-add=NET_RAW",
            "--cap-add=SETUID",
            "--cap-add=SETGID",
            "--read-only",
            "--security-opt=no-new-privileges",
            "--tmpfs=/run",
            "--tmpfs=/tmp:mode=1777",
            "-v",
            str(path) + ":/policy.json:ro",
        ]
        policy = dict(
            defaultAction="deny",
            allowedNetworks=[
                dict(cidr=ip, protocol="tcp", ports=[80]) for ip in (ipv4, ipv6)
            ],
            deniedNetworks=[
                dict(cidr=ip, protocol="all", ports=[]) for ip in (blocked4, blocked6)
            ],
            dnsServers=[],
            publishedPorts=[],
            domains=dict(enable=False, defaultAction="deny", allowed=[], denied=[]),
        )
        path.write_text(json.dumps(policy))
        guardian = run("direct", *common, IMAGE, "guardian", "/policy.json")
        wait(guardian)
        client(
            guardian,
            f"""
import socket
for address in {[(ipv4, 80), (ipv6, 80)]!r}:
    socket.create_connection(address, 3).close()
for address in {[(blocked4, 80), (blocked6, 80), (ipv4, 443)]!r}:
    try:
        socket.create_connection(address, 1).close()
    except OSError:
        pass
    else:
        raise AssertionError(('unexpected direct access', address))
""",
        )
        docker("rm", "-f", guardian)
        policy["allowedNetworks"] = []
        policy["domains"].update(
            enable=True, allowed=["allowed.test", "rebind.test"], denied=["denied.test"]
        )
        path.write_text(json.dumps(policy))
        proxy = run(
            "proxy",
            *common,
            "--add-host=allowed.test:" + ipv4,
            "--add-host=denied.test:" + ipv4,
            "--add-host=rebind.test:" + blocked4,
            IMAGE,
            "proxy",
            "/policy.json",
        )
        wait(proxy, True)
        proxy_ip = address(proxy)
        guardian = run("domain", *common, IMAGE, "guardian", "/policy.json", proxy_ip)
        wait(guardian)
        client(
            guardian,
            f"""
import socket, subprocess, urllib.request, urllib.error
proxy = 'http://{proxy_ip}:3128'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({{'http': proxy}}))
assert opener.open('http://allowed.test/', timeout=3).status == 200
for name in ('denied.test', 'rebind.test'):
    try:
        opener.open('http://' + name + '/', timeout=3)
    except (OSError, urllib.error.URLError):
        pass
    else:
        raise AssertionError(('proxy bypass', name))
for address in {[(ipv4, 80), (ipv6, 80), ('127.0.0.11', 53)]!r}:
    try:
        socket.create_connection(address, 1).close()
    except OSError:
        pass
    else:
        raise AssertionError(('direct bypass', address))
with socket.create_connection(('{proxy_ip}', 3128), 3) as tunnel:
    tunnel.sendall(b'CONNECT allowed.test:443 HTTP/1.1\\r\\nHost: allowed.test:443\\r\\n\\r\\n')
    assert b'200' in tunnel.recv(4096).split(b'\\r\\n')[0]
assert subprocess.run(['iptables', '-F'], capture_output=True).returncode != 0
try:
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
except PermissionError:
    pass
else:
    raise AssertionError('root retained NET_RAW')
""",
        )
        docker("rm", "-f", proxy)
        client(
            guardian,
            f"""
import socket
for address in [('{proxy_ip}', 3128), ('{ipv4}', 80)]:
    try:
        socket.create_connection(address, 1).close()
    except OSError:
        pass
    else:
        raise AssertionError('access remained after proxy failure')
""",
        )
    print(
        "Live IPv4/IPv6 allow/deny, HTTP proxy, CONNECT, direct/DNS bypass, root capabilities, and proxy failure checks passed."
    )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.stderr)
    finally:
        for name in reversed(containers):
            docker("rm", "-f", name, check=False)
        docker("network", "rm", NETWORK, check=False)
