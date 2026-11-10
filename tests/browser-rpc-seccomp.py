#!/usr/bin/env python3
"""Offline exact-delta contract for the explicit Bubblewrap container preset."""
import importlib.util
import itertools
import json
import sys
import unittest

spec = importlib.util.spec_from_file_location("browser_policy", sys.argv[3])
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)
RPC_CLONE = 17 | 0x20000 | 0x10000000 | 0x20000000 | 0x8000000 | 0x4000000


def rule(names, args):
    return {"names": names, "args": args, "action": "SCMP_ACT_ALLOW",
            "includes": {"arches": ["amd64", "arm64"]},
            "excludes": {"caps": ["CAP_SYS_ADMIN"]},
            "comment": "Agentbox opt-in RPC Bubblewrap setup; container-wide permission"}


class RpcPolicyTests(unittest.TestCase):
    def test_exact_delta(self):
        self.assertEqual({k: v for k, v in RPC.items() if k != "syscalls"},
                         {k: v for k, v in BASE.items() if k != "syscalls"})
        self.assertEqual(RPC["syscalls"], BASE["syscalls"] + [
            rule(["clone"], [{"index": 0, "value": RPC_CLONE, "op": "SCMP_CMP_EQ"}]),
            rule(["mount", "pivot_root"], []),
            rule(["umount2"], [{"index": 1, "value": 2, "op": "SCMP_CMP_EQ"}])])

    def test_namespace_and_sensitive_syscall_matrix(self):
        before, after = browser.Policy(BASE), browser.Policy(RPC)
        for arch, caps in itertools.product(browser.ARCHES + browser.UNSUPPORTED_ARCHES,
                                           browser.CAP_SETS + (frozenset({"CAP_SYS_ADMIN"}),)):
            scoped = arch in browser.ARCHES and "CAP_SYS_ADMIN" not in caps
            for name in ("clone", "unshare", "clone3", "mount", "pivot_root", "umount2",
                         "setns", "bpf", "mount_setattr", "move_mount", "fsopen"):
                for flags in browser.NAMESPACE_MASKS + (RPC_CLONE, RPC_CLONE | 0x40000000, RPC_CLONE | 0x2000000):
                    args = browser.syscall_args(name, flags, arch)
                    for umount_flags in (0, 1, 2, 3, 4, 8):
                        if name == "umount2":
                            args[1] = umount_flags
                        added = scoped and (name in ("mount", "pivot_root") or
                                            name == "clone" and flags == RPC_CLONE or
                                            name == "umount2" and umount_flags == 2)
                        self.assertEqual(after.evaluate(name, args, arch, caps),
                                         browser.ALLOW if added else before.evaluate(name, args, arch, caps),
                                         (arch, caps, name, args))


if __name__ == "__main__":
    with open(sys.argv[1]) as source:
        BASE = json.load(source)
    with open(sys.argv[2]) as source:
        RPC = json.load(source)
    unittest.main(argv=[sys.argv[0]])
