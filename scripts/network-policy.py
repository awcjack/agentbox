#!/usr/bin/env python3
"""Helper-container firewall and Squid config. No agent-writable inputs."""
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys


def validate(policy):
    for key in ("defaultAction",):
        if policy[key] not in ("allow", "deny"):
            raise ValueError(f"invalid {key}")
    domains = policy["domains"]
    if domains["defaultAction"] not in ("allow", "deny"):
        raise ValueError("invalid domain defaultAction")
    for name in domains["allowed"] + domains["denied"]:
        if not re.fullmatch(r"\.?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", name):
            raise ValueError(f"invalid domain: {name}")
        labels = name.lstrip(".").split(".")
        if (
            any(
                len(label) > 63 or label.startswith("-") or label.endswith("-")
                for label in labels
            )
            or "" in labels
        ):
            raise ValueError(f"invalid domain: {name}")
        try:
            ipaddress.ip_address(name.lstrip("."))
        except ValueError:
            pass
        else:
            raise ValueError("domain rules must not contain literal IPs")
    if domains["enable"] and policy["allowedNetworks"]:
        raise ValueError("direct network exceptions bypass domain filtering")
    for rule in policy["allowedNetworks"] + policy["deniedNetworks"]:
        ipaddress.ip_network(rule["cidr"], strict=False)
        if rule["protocol"] not in ("all", "tcp", "udp"):
            raise ValueError("invalid protocol")
        if rule["ports"] and rule["protocol"] == "all":
            raise ValueError("ports require tcp or udp")
        if any(
            type(port) is not int or not 1 <= port <= 65535 for port in rule["ports"]
        ):
            raise ValueError("invalid port")
    for server in policy["dnsServers"]:
        address = ipaddress.ip_address(server)
        if address.is_loopback or address.is_unspecified:
            raise ValueError("DNS servers must be non-loopback literal addresses")
    for publish in policy["publishedPorts"]:
        # Keep host bindings explicit; never silently publish to every interface.
        if not re.fullmatch(
            r"(?:\[[0-9a-fA-F:]+\]|[0-9.]+):[0-9]+:[0-9]+(?:/(?:tcp|udp))?", publish
        ):
            raise ValueError(
                f"invalid publish specification (explicit IP required): {publish}"
            )
        host, host_port, container_port = publish.rsplit(":", 2)
        ipaddress.ip_address(host.strip("[]"))
        if not all(
            1 <= int(p.split("/")[0]) <= 65535 for p in (host_port, container_port)
        ):
            raise ValueError("invalid published port")


def firewall_commands(policy, role, proxy_address=None):
    """Only this companion has NET_ADMIN; agentbox shares its namespace."""
    commands = []
    for version, tool, loopback in (
        (4, "iptables", "127.0.0.0/8"),
        (6, "ip6tables", "::1/128"),
    ):

        def add(*args):
            commands.append([tool, "-w", *args])

        # Start closed. Failure at any subsequent step prevents readiness.
        add("-P", "OUTPUT", "DROP")
        add("-P", "FORWARD", "DROP")
        add("-F", "OUTPUT")
        # Docker's embedded DNS is DNATed before filter/OUTPUT and could relay
        # arbitrary DNS externally. Block it before NAT, even on loopback.
        if version == 4:
            for protocol in ("udp", "tcp"):
                add(
                    "-t",
                    "raw",
                    "-A",
                    "OUTPUT",
                    "-d",
                    "127.0.0.11",
                    "-p",
                    protocol,
                    "--dport",
                    "53",
                    "-j",
                    "DROP",
                )
        add(
            "-A",
            "OUTPUT",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        )
        add("-A", "OUTPUT", "-o", "lo", "-d", loopback, "-j", "ACCEPT")
        if version == 6:
            # IPv6 needs neighbor discovery even when application egress is
            # denied. The agent has no NET_RAW capability to forge these.
            for kind in ("135", "136"):
                add(
                    "-A",
                    "OUTPUT",
                    "-p",
                    "ipv6-icmp",
                    "--icmpv6-type",
                    kind,
                    "-m",
                    "hl",
                    "--hl-eq",
                    "255",
                    "-j",
                    "ACCEPT",
                )
        # The proxy is a transport endpoint, not a destination exception. Its
        # own firewall applies the destination rules again after resolution.
        if role == "guardian" and proxy_address:
            if ipaddress.ip_address(proxy_address).version == version:
                add(
                    "-A",
                    "OUTPUT",
                    "-d",
                    proxy_address,
                    "-p",
                    "tcp",
                    "--dport",
                    "3128",
                    "-j",
                    "ACCEPT",
                )
        for action, rules in (
            ("DROP", policy["deniedNetworks"]),
            ("ACCEPT", policy["allowedNetworks"]),
        ):
            for rule in rules:
                network = ipaddress.ip_network(rule["cidr"], strict=False)
                if network.version != version:
                    continue
                prefix = ["-A", "OUTPUT", "-d", str(network)]
                if rule["protocol"] != "all":
                    prefix += ["-p", rule["protocol"]]
                for port in rule["ports"] or [None]:
                    add(
                        *prefix, *(["--dport", str(port)] if port else []), "-j", action
                    )
        domain_guardian = role == "guardian" and policy["domains"]["enable"]
        if not domain_guardian:
            for server in policy["dnsServers"]:
                if ipaddress.ip_address(server).version == version:
                    for protocol in ("udp", "tcp"):
                        add(
                            "-A",
                            "OUTPUT",
                            "-d",
                            server,
                            "-p",
                            protocol,
                            "--dport",
                            "53",
                            "-j",
                            "ACCEPT",
                        )
            if policy["defaultAction"] == "allow":
                add("-A", "OUTPUT", "-j", "ACCEPT")
            elif role == "proxy":
                # Domain allowlists supply the allow decision for HTTP/HTTPS;
                # the proxy still obeys every deniedNetworks rule above.
                add(
                    "-A",
                    "OUTPUT",
                    "-p",
                    "tcp",
                    "-m",
                    "multiport",
                    "--dports",
                    "80,443",
                    "-j",
                    "ACCEPT",
                )
    return commands


def squid_config(policy):
    domains = policy["domains"]
    lines = [
        "http_port 3128",
        "visible_hostname agentbox-egress",
        "pid_filename none",
        "cache_effective_user nobody",
        "cache_effective_group nobody",
        "cache_log /tmp/cache.log",
        "access_log none",
        "cache_store_log none",
        "cache deny all",
        "cache_mem 16 MB",
        "max_filedescriptors 1024",
        "shutdown_lifetime 0 seconds",
        "pinger_enable off",
        "netdb_filename none",
        "acl manager proto cache_object",
        "http_access deny manager",
        "acl safe_ports port 80 443",
        "acl ssl_ports port 443",
        "acl connect method CONNECT",
        "http_access deny !safe_ports",
        "http_access deny connect !ssl_ports",
        # Never proxy back into this namespace (where loopback is exempt from
        # the firewall). Do not reverse-resolve IP literals into domain allows.
        "acl local_destination dst 127.0.0.0/8 ::1/128 0.0.0.0/32 ::/128",
        "http_access deny local_destination",
    ]
    if policy["dnsServers"]:
        lines.append("dns_nameservers " + " ".join(policy["dnsServers"]))
    for label, values, action in (
        ("blocked_domains", domains["denied"], "deny"),
        ("allowed_domains", domains["allowed"], "allow"),
    ):
        if values:
            lines += [
                f"acl {label} dstdomain -n " + " ".join(values),
                f"http_access {action} {label}",
            ]
    lines.append("http_access " + domains["defaultAction"] + " all")
    return "\n".join(lines) + "\n"


def main():
    role, path, *extra = sys.argv[1:]
    policy = json.loads(Path(path).read_text())
    validate(policy)
    if role == "validate":
        return
    if role not in ("guardian", "proxy"):
        raise ValueError("invalid role")
    for command in firewall_commands(policy, role, extra[0] if extra else None):
        subprocess.run(command, check=True)
    if role == "proxy":
        Path("/run/squid.conf").write_text(squid_config(policy))
        # Parse first so an invalid policy never reports healthy.
        subprocess.run(["squid", "-k", "parse", "-f", "/run/squid.conf"], check=True)
        os.execvp("squid", ["squid", "-N", "-f", "/run/squid.conf"])
    Path("/run/ready").touch()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True:
        signal.pause()


if __name__ == "__main__":
    main()
