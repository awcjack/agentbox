#!/usr/bin/env python3
"""Policy behavior and host failure handling; no root or Docker required."""
import importlib.util
import ipaddress
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy_module = load("policy", sys.argv[1])
host = load("host", sys.argv[2])
sys.argv = sys.argv[:1]


def policy(**kwargs):
    result = dict(
        defaultAction="deny",
        allowedNetworks=[],
        deniedNetworks=[],
        dnsServers=["1.1.1.1"],
        publishedPorts=["127.0.0.1:4096:4096"],
        domains=dict(enable=False, defaultAction="deny", allowed=[], denied=[]),
    )
    result.update(kwargs)
    return result


def rule(cidr, protocol="all", ports=None):
    return dict(cidr=cidr, protocol=protocol, ports=ports or [])


def verdict(commands, address, protocol="tcp", port=443, state="NEW"):
    """Evaluate the generated filter/OUTPUT subset for representative packets."""
    version = ipaddress.ip_address(address).version
    tool = "iptables" if version == 4 else "ip6tables"
    for command in commands:
        if command[0] != tool or command[2:4] != ["-A", "OUTPUT"]:
            continue
        args = command[4:]

        def arg(flag):
            return args[args.index(flag) + 1] if flag in args else None

        if arg("-d") and ipaddress.ip_address(address) not in ipaddress.ip_network(
            arg("-d"), strict=False
        ):
            continue
        if arg("-p") and arg("-p") != protocol:
            continue
        if arg("--dport") and int(arg("--dport")) != port:
            continue
        if arg("--dports") and str(port) not in arg("--dports").split(","):
            continue
        if arg("--ctstate") and state not in arg("--ctstate").split(","):
            continue
        if arg("-o") == "lo" and not ipaddress.ip_address(address).is_loopback:
            continue
        return arg("-j")
    return "DROP"


class PolicyTests(unittest.TestCase):
    def test_deny_precedes_allow_for_both_families(self):
        p = policy(
            allowedNetworks=[rule("0.0.0.0/0"), rule("::/0")],
            deniedNetworks=[rule("10.0.0.0/8"), rule("fd00::/8")],
        )
        commands = policy_module.firewall_commands(p, "guardian")
        for ip, expected in (
            ("10.2.3.4", "DROP"),
            ("fd00::12", "DROP"),
            ("8.8.8.8", "ACCEPT"),
            ("2606:4700::1111", "ACCEPT"),
        ):
            self.assertEqual(verdict(commands, ip), expected)

    def test_protocol_and_port_allowlist(self):
        commands = policy_module.firewall_commands(
            policy(allowedNetworks=[rule("203.0.113.0/24", "tcp", [443])]), "guardian"
        )
        self.assertEqual(verdict(commands, "203.0.113.1"), "ACCEPT")
        self.assertEqual(verdict(commands, "203.0.113.1", port=80), "DROP")
        self.assertEqual(verdict(commands, "203.0.113.1", protocol="udp"), "DROP")
        self.assertEqual(verdict(commands, "203.0.114.1"), "DROP")

    def test_blacklist_and_dns_precedence(self):
        commands = policy_module.firewall_commands(
            policy(
                defaultAction="allow",
                deniedNetworks=[rule("10.0.0.0/8"), rule("1.1.1.1", "udp", [53])],
            ),
            "guardian",
        )
        self.assertEqual(verdict(commands, "10.0.0.1"), "DROP")
        self.assertEqual(verdict(commands, "8.8.8.8"), "ACCEPT")
        self.assertEqual(verdict(commands, "1.1.1.1", protocol="udp", port=53), "DROP")

    def test_domain_guardian_blocks_direct_http_dns_and_quic(self):
        p = policy(
            defaultAction="allow",
            domains=dict(
                enable=True, defaultAction="deny", allowed=[".github.com"], denied=[]
            ),
        )
        commands = policy_module.firewall_commands(p, "guardian", "172.20.0.2")
        for ip, protocol, port in (
            ("1.1.1.1", "udp", 53),
            ("8.8.8.8", "tcp", 443),
            ("8.8.8.8", "udp", 443),
            ("2606:4700::1111", "tcp", 443),
        ):
            self.assertEqual(verdict(commands, ip, protocol, port), "DROP")
        self.assertEqual(verdict(commands, "172.20.0.2", port=3128), "ACCEPT")
        self.assertEqual(verdict(commands, "172.20.0.2", port=443), "DROP")

    def test_proxy_obeys_destination_denies_after_resolution(self):
        p = policy(
            deniedNetworks=[rule("10.0.0.0/8"), rule("fd00::/8")],
            domains=dict(
                enable=True,
                defaultAction="deny",
                allowed=[".example.com"],
                denied=["bad.example.com"],
            ),
        )
        commands = policy_module.firewall_commands(p, "proxy")
        self.assertEqual(verdict(commands, "10.1.2.3"), "DROP")
        self.assertEqual(verdict(commands, "fd00::12"), "DROP")
        self.assertEqual(verdict(commands, "8.8.8.8"), "ACCEPT")
        self.assertEqual(verdict(commands, "8.8.8.8", port=22), "DROP")

    def test_embedded_dns_block_is_before_nat(self):
        commands = policy_module.firewall_commands(policy(), "guardian")
        for proto in ("tcp", "udp"):
            self.assertIn(
                [
                    "iptables",
                    "-w",
                    "-t",
                    "raw",
                    "-A",
                    "OUTPUT",
                    "-d",
                    "127.0.0.11",
                    "-p",
                    proto,
                    "--dport",
                    "53",
                    "-j",
                    "DROP",
                ],
                commands,
            )

    def test_return_traffic_and_loopback(self):
        commands = policy_module.firewall_commands(policy(dnsServers=[]), "guardian")
        self.assertEqual(verdict(commands, "127.0.0.1", port=4096), "ACCEPT")
        self.assertEqual(verdict(commands, "::1", port=4096), "ACCEPT")
        self.assertEqual(verdict(commands, "10.0.0.1", state="ESTABLISHED"), "ACCEPT")
        self.assertEqual(verdict(commands, "10.0.0.1"), "DROP")

    def test_squid_domain_denies_win_and_ip_reverse_lookup_disabled(self):
        p = policy(
            domains=dict(
                enable=True,
                defaultAction="deny",
                allowed=[".example.com"],
                denied=["bad.example.com"],
            )
        )
        config = policy_module.squid_config(p)
        self.assertLess(
            config.index("http_access deny blocked_domains"),
            config.index("http_access allow allowed_domains"),
        )
        self.assertIn("dstdomain -n .example.com", config)
        self.assertIn("http_access deny connect !ssl_ports", config)
        self.assertTrue(config.endswith("http_access deny all\n"))

    def test_validation_rejects_injection_bad_addresses_and_bypasses(self):
        cases = [
            policy(deniedNetworks=[rule("10.0.0.0/8\n-j ACCEPT")]),
            policy(allowedNetworks=[rule("0/0", ports=[443])]),
            policy(dnsServers=["127.0.0.11"]),
            policy(publishedPorts=["4096:4096"]),
            policy(publishedPorts=["127.0.0.1:0:4096"]),
        ]
        for name in (
            "example.com\nhttp_access allow all",
            "foo..com",
            "127.0.0.1",
            "-bad.com",
        ):
            cases.append(
                policy(
                    domains=dict(
                        enable=True, defaultAction="deny", allowed=[name], denied=[]
                    )
                )
            )
        cases.append(
            policy(
                allowedNetworks=[rule("0.0.0.0/0")],
                domains=dict(enable=True, defaultAction="deny", allowed=[], denied=[]),
            )
        )
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                policy_module.validate(case)
        policy_module.validate(policy(publishedPorts=["[::1]:4096:4096/tcp"]))


class LifecycleTests(unittest.TestCase):
    def test_policy_change_cannot_replace_live_namespace(self):
        with patch.object(host, "inspect", return_value=None), patch.object(
            host, "running", return_value=True
        ), patch.object(host, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "stop agentbox"):
                host.start(SimpleNamespace(fingerprint="new"), policy())
            docker.assert_not_called()

    def test_failure_removes_companions_and_never_reports_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "image.tar"
            image.touch()
            source = Path(directory) / "policy-source.json"
            source.write_text("{}")
            args = SimpleNamespace(
                image=image,
                policy=source,
                fingerprint="new",
                environment_file=Path(directory) / "network.env",
            )
            with patch.object(host, "inspect", return_value=None), patch.object(
                host, "running", return_value=False
            ), patch.object(host, "docker"), patch.object(
                host, "remove"
            ) as remove, patch.object(
                host, "wait_ready", side_effect=RuntimeError("firewall failed")
            ), patch.object(
                host, "write_environment"
            ) as write:
                with self.assertRaisesRegex(RuntimeError, "firewall failed"):
                    host.start(args, policy())
                self.assertEqual(
                    remove.call_args_list[-2:],
                    [unittest.mock.call(name) for name in host.NAMES],
                )
                write.assert_not_called()

    def test_environment_has_both_proxy_cases_and_explicit_resolvers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "network.env"
            p = policy(
                domains=dict(enable=True, defaultAction="deny", allowed=[], denied=[])
            )
            with patch.object(
                host,
                "inspect",
                return_value={
                    "NetworkSettings": {
                        "Networks": {"agentbox-egress": {"IPAddress": "172.20.0.2"}}
                    }
                },
            ):
                host.write_environment(SimpleNamespace(environment_file=path), p)
            self.assertIn("HTTPS_PROXY=http://172.20.0.2:3128\n", path.read_text())
            self.assertIn("https_proxy=http://172.20.0.2:3128\n", path.read_text())
            self.assertEqual(
                Path(str(path) + ".resolv").read_text(), "nameserver 1.1.1.1\n"
            )


unittest.main()
