#!/usr/bin/env python3
"""Offline policy contract: python3 tests/browser-seccomp.py BASELINE GENERATED.

Only parses JSON and evaluates a deliberately small seccomp model. Never invokes
namespace syscalls, Docker, or the host's active policy. This is not a general
libseccomp emulator: unsupported predicates on a queried syscall are errors.
"""

import hashlib
import itertools
import json
import sys
import unittest


BASELINE_SHA256 = "9da637d2ab0a204fcbd91bd88f1be9e004a3acab61c571a9f5b8870e588a17d2"
ALLOW = ("SCMP_ACT_ALLOW", None)
EPERM = ("SCMP_ACT_ERRNO", 1)
ENOSYS = ("SCMP_ACT_ERRNO", 38)
USER, PID, NET, SIGCHLD = 0x10000000, 0x20000000, 0x40000000, 17
# NEWTIME overlaps clone's exit-signal byte. Include it nonetheless: it must
# never accidentally broaden the exact namespace-clone exceptions.
NAMESPACE_BITS = (0x80, 0x20000, 0x2000000, 0x4000000,
                  0x8000000, USER, PID, NET)
NAMESPACE_MASKS = tuple(sum(bits) for count in range(9)
                        for bits in itertools.combinations(NAMESPACE_BITS, count))
CLONE_FLAGS = (USER | SIGCHLD, USER | PID | SIGCHLD,
               USER | NET | SIGCHLD, USER | PID | NET | SIGCHLD,
               PID | SIGCHLD)
ARCHES = ("amd64", "arm64")
UNSUPPORTED_ARCHES = ("386", "x86", "x32", "arm", "mips", "mips64",
                      "mips64n32", "mipsle", "mips64le", "mips64n32le",
                      "ppc64", "ppc64le", "s390", "s390x", "riscv64",
                      "loong64", "unknown")
DOCKER_CAPS = frozenset("CAP_" + name for name in (
    "CHOWN", "DAC_OVERRIDE", "FSETID", "FOWNER", "MKNOD", "NET_RAW",
    "SETGID", "SETUID", "SETFCAP", "SETPCAP", "NET_BIND_SERVICE",
    "SYS_CHROOT", "KILL", "AUDIT_WRITE"))
RESTRICTED_CAPS = DOCKER_CAPS - {"CAP_NET_RAW", "CAP_NET_ADMIN", "CAP_SYS_ADMIN"}
CAP_SETS = (DOCKER_CAPS, RESTRICTED_CAPS)


def exact_rule(name, flags):
    return {
        "names": [name], "action": "SCMP_ACT_ALLOW",
        "args": [{"index": 0, "value": flags, "op": "SCMP_CMP_EQ"}],
        "includes": {"arches": list(ARCHES)},
        "excludes": {"caps": ["CAP_SYS_ADMIN"]},
        "comment": "Agentbox opt-in Chromium namespace sandbox; exact flags only",
    }


EXPECTED_DELTA = [exact_rule("unshare", USER)] + [
    exact_rule("clone", flags) for flags in CLONE_FLAGS]


def condition_matches(rule, arch, caps):
    """Moby includes require every condition; any exclusion vetoes the rule."""
    for key in ("includes", "excludes"):
        condition = rule.get(key, {})
        if set(condition) - {"arches", "caps"}:
            raise ValueError("unsupported conditional: " + repr(condition))
    includes, excludes = rule.get("includes", {}), rule.get("excludes", {})
    return (
        (not includes.get("arches") or arch in includes["arches"])
        and set(includes.get("caps", ())).issubset(caps)
        and arch not in excludes.get("arches", ())
        and not caps.intersection(excludes.get("caps", ()))
    )


def arguments_match(predicates, args):
    seen = set()
    matches = []
    for predicate in predicates:
        if set(predicate) - {"index", "value", "valueTwo", "op"}:
            raise ValueError("unsupported argument fields")
        index, value, op = (predicate[key] for key in ("index", "value", "op"))
        if type(index) is not int or not 0 <= index < 6 or index in seen:
            raise ValueError("invalid or repeated argument index")
        seen.add(index)
        if type(value) is not int or not 0 <= value < 2**64:
            raise ValueError("invalid argument value")
        if op == "SCMP_CMP_EQ":
            if "valueTwo" in predicate:
                raise ValueError("unexpected second EQ operand")
            matches.append(args[index] == value)
        elif op == "SCMP_CMP_MASKED_EQ":
            second = predicate.get("valueTwo", 0)
            if type(second) is not int or not 0 <= second < 2**64:
                raise ValueError("invalid mask comparison value")
            matches.append(args[index] & value == second)
        else:
            raise ValueError("unsupported comparison: " + op)
    return all(matches)


class Policy:
    def __init__(self, document):
        self.default = self.result(document["defaultAction"],
                                   document.get("defaultErrnoRet"))
        self.rules = {}
        for rule in document["syscalls"]:
            for name in rule["names"]:
                self.rules.setdefault(name, []).append(rule)

    @staticmethod
    def result(action, errno):
        if action == "SCMP_ACT_ALLOW":
            if errno is not None:
                raise ValueError("errno on ALLOW")
            return ALLOW
        if action == "SCMP_ACT_ERRNO" and type(errno) is int:
            return action, errno
        raise ValueError("unsupported action or missing errno")

    def evaluate(self, name, args, arch, caps):
        if len(args) != 6 or any(type(arg) is not int or not 0 <= arg < 2**64
                                 for arg in args):
            raise ValueError("expected six unsigned 64-bit arguments")
        results = set()
        for rule in self.rules.get(name, ()):
            # Validate predicates even when an architecture/capability vetoes
            # the rule: unsupported semantics must never silently pass.
            enabled = condition_matches(rule, arch, caps)
            matched = arguments_match(rule.get("args", ()), args)
            result = self.result(rule["action"], rule.get("errnoRet"))
            if enabled and matched:
                results.add(result)
        if len(results) > 1:
            raise ValueError("conflicting actions are outside this model")
        return next(iter(results)) if results else self.default


def syscall_args(name, flags, arch):
    args = [0] * 6
    # s390 reverses clone's stack and flags parameters.
    args[1 if name == "clone" and arch in ("s390", "s390x") else 0] = flags
    return args


class BrowserSeccompTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_policy = Policy(BASELINE)
        cls.browser_policy = Policy(GENERATED)

    def outcome(self, policy, name, flags, arch, caps):
        return policy.evaluate(name, syscall_args(name, flags, arch), arch, caps)

    def assert_contract_outcome(self, name, flags, arch, caps):
        before = self.outcome(self.base_policy, name, flags, arch, caps)
        exception = (arch in ARCHES and "CAP_SYS_ADMIN" not in caps and
                     ((name == "unshare" and flags == USER) or
                      (name == "clone" and flags in CLONE_FLAGS)))
        expected = ALLOW if exception else before
        actual = self.outcome(self.browser_policy, name, flags, arch, caps)
        self.assertEqual(actual, expected,
                         f"{name} flags={flags:#x} arch={arch} caps={sorted(caps)}")

    def test_baseline_canonical_pin(self):
        canonical = json.dumps(BASELINE, sort_keys=True, separators=(",", ":"))
        self.assertEqual(hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                         BASELINE_SHA256)

    def test_upstream_defaults_and_every_existing_rule_unchanged(self):
        self.assertEqual({k: v for k, v in GENERATED.items() if k != "syscalls"},
                         {k: v for k, v in BASELINE.items() if k != "syscalls"})
        self.assertEqual(GENERATED["syscalls"][:len(BASELINE["syscalls"])],
                         BASELINE["syscalls"])
        self.assertEqual(self.base_policy.default, EPERM)

    def test_exact_six_rule_delta(self):
        # Full equality deliberately catches any extra predicate, name, action,
        # architecture, capability, argument, or rule, not merely sampled flags.
        self.assertEqual(GENERATED["syscalls"][len(BASELINE["syscalls"]):],
                         EXPECTED_DELTA)

    def test_required_namespace_allowances(self):
        for arch, caps in itertools.product(ARCHES, CAP_SETS):
            for name, flags in [("unshare", USER)] + [
                    ("clone", flags) for flags in CLONE_FLAGS]:
                with self.subTest(arch=arch, caps=sorted(caps), name=name, flags=flags):
                    self.assertEqual(self.outcome(self.base_policy, name, flags, arch, caps), EPERM)
                    self.assertEqual(self.outcome(self.browser_policy, name, flags, arch, caps), ALLOW)

    def test_ordinary_threading_and_chromium_filesystem_helper(self):
        # pthread flags: VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|SETTLS|
        # PARENT_SETTID|CHILD_CLEARTID. Chromium's chroot helper: FS|SIGCHLD.
        flags_to_keep = (0, SIGCHLD, 0x3D0F00, 0x200 | SIGCHLD,
                         0x100 | 0x4000 | SIGCHLD)  # vfork-style VM|VFORK
        for arch, caps, flags in itertools.product(ARCHES, CAP_SETS, flags_to_keep):
            with self.subTest(arch=arch, flags=flags, caps=sorted(caps)):
                for policy in (self.base_policy, self.browser_policy):
                    self.assertEqual(self.outcome(policy, "clone", flags, arch, caps), ALLOW)

    def test_exhaustive_namespace_combinations_and_injected_flags(self):
        # All 256 namespace combinations, with/without SIGCHLD, and every
        # individual extra bit across the entire 64-bit seccomp argument.
        # Moby already permits some bits (notably NEWTIME for clone); preserve
        # those decisions rather than claiming a stricter baseline than exists.
        for arch, caps, name, mask in itertools.product(
                ARCHES, CAP_SETS, ("clone", "unshare"), NAMESPACE_MASKS):
            with self.subTest(arch=arch, caps=sorted(caps), name=name, mask=hex(mask)):
                for signal in (0, SIGCHLD):
                    flags = mask | signal
                    self.assert_contract_outcome(name, flags, arch, caps)
                    for bit in range(64):
                        self.assert_contract_outcome(name, flags | (1 << bit), arch, caps)

    def test_every_exit_signal_for_required_clones(self):
        for arch, caps, flags, signal in itertools.product(
                ARCHES, CAP_SETS, CLONE_FLAGS, range(256)):
            self.assert_contract_outcome("clone", (flags & ~0xFF) | signal, arch, caps)

    def test_forbidden_syscalls_remain_eperm(self):
        # ptrace/process_vm_* are intentionally absent: upstream allows them on
        # kernels >= 4.8. Do not misrepresent that baseline as a blanket denial.
        forbidden = (
            "setns", "mount", "umount", "umount2", "mount_setattr", "move_mount",
            "open_tree", "fsopen", "fsconfig", "fsmount", "fspick", "bpf",
            "keyctl", "add_key", "request_key", "perf_event_open", "fanotify_init",
            "open_by_handle_at", "init_module", "finit_module", "delete_module",
            "reboot", "kexec_load", "kexec_file_load", "swapon", "swapoff",
            "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register",
            "sethostname", "setdomainname", "syslog", "pidfd_getfd", "kcmp",
        )
        for arch, caps, name in itertools.product(ARCHES, CAP_SETS, forbidden):
            with self.subTest(arch=arch, caps=sorted(caps), name=name):
                for policy in (self.base_policy, self.browser_policy):
                    for value in (0, USER, 2**64 - 1):
                        self.assertEqual(policy.evaluate(name, [value] * 6, arch, caps), EPERM)

    def test_clone3_enosys_fallback(self):
        for arch, caps in itertools.product(ARCHES + UNSUPPORTED_ARCHES, CAP_SETS):
            for policy in (self.base_policy, self.browser_policy):
                for value in (0, USER, 2**64 - 1):
                    self.assertEqual(policy.evaluate("clone3", [value] * 6, arch, caps), ENOSYS)

    def test_unsupported_architectures_gain_no_exceptions(self):
        for arch, caps, name, mask in itertools.product(
                UNSUPPORTED_ARCHES, CAP_SETS, ("clone", "unshare"), NAMESPACE_MASKS):
            for flags in (mask, mask | SIGCHLD, mask | (1 << 63)):
                self.assert_contract_outcome(name, flags, arch, caps)
        for rule, arch in itertools.product(EXPECTED_DELTA, UNSUPPORTED_ARCHES):
            self.assertFalse(condition_matches(rule, arch, DOCKER_CAPS))

    def test_sys_admin_does_not_activate_delta_or_change_baseline(self):
        caps = DOCKER_CAPS | {"CAP_SYS_ADMIN"}
        for rule, arch in itertools.product(EXPECTED_DELTA, ARCHES):
            self.assertFalse(condition_matches(rule, arch, caps))
        for arch, name, mask in itertools.product(
                ARCHES, ("clone", "unshare", "clone3"), NAMESPACE_MASKS):
            self.assert_contract_outcome(name, mask | SIGCHLD, arch, caps)

    def test_evaluator_predicates_and_fail_closed_behavior(self):
        eq = {"index": 0, "value": 17, "op": "SCMP_CMP_EQ"}
        masked = {"index": 1, "value": 0xF0, "valueTwo": 0x20,
                  "op": "SCMP_CMP_MASKED_EQ"}
        self.assertTrue(arguments_match([eq, masked], [17, 0x123, 0, 0, 0, 0]))
        self.assertFalse(arguments_match([eq, masked], [18, 0x123, 0, 0, 0, 0]))
        self.assertFalse(arguments_match([masked], [17, 0x133, 0, 0, 0, 0]))
        self.assertTrue(arguments_match([{**masked, "valueTwo": 0}], [0] * 6))
        self.assertTrue(arguments_match(
            [{k: v for k, v in masked.items() if k != "valueTwo"}], [0] * 6))
        rule = {"includes": {"arches": ["amd64"], "caps": ["A", "B"]},
                "excludes": {"arches": ["arm64"], "caps": ["C", "D"]}}
        self.assertTrue(condition_matches(rule, "amd64", {"A", "B"}))
        self.assertFalse(condition_matches(rule, "amd64", {"A"}))
        self.assertFalse(condition_matches(rule, "arm64", {"A", "B"}))
        self.assertFalse(condition_matches(rule, "amd64", {"A", "B", "D"}))
        with self.assertRaises(ValueError):
            condition_matches({"includes": {"minKernel": "4.8"}}, "amd64", set())
        for predicates in ([{**eq, "op": "SCMP_CMP_NE"}], [eq, eq],
                           [{**eq, "index": 6}], [{**eq, "valueTwo": 0}]):
            with self.assertRaises(ValueError):
                arguments_match(predicates, [0] * 6)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


def load_document(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique_object)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python3 tests/browser-seccomp.py BASELINE GENERATED")
    BASELINE, GENERATED = (load_document(path) for path in sys.argv[1:])
    unittest.main(argv=[sys.argv[0]], verbosity=2)
