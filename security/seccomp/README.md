# Opt-in Chromium namespace seccomp profile

`security/seccomp/browser.nix` appends six argument-filtered rules to a **pinned
complete Moby default**, rather than starting from an allow-all profile or
unconditionally allowing namespace syscalls. `browser-seccomp.nix` packages the
result as a JSON file for Docker's host-side CLI. No live policy is loaded by the
build or tests.

## Provenance

The vendored baseline is `moby/profiles` **seccomp/v0.2.3**, commit
[`836ae4d37ef2ec995c77c99fc55f5b5f3af3a897`](https://github.com/moby/profiles/tree/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897).
This is the seccomp module used by Moby `docker-v29.5.2`, the Docker 29 version in
this checkout's pinned nixpkgs. It is not a claim about the operator's running
Docker version.

- Source: [seccomp/default.json](https://raw.githubusercontent.com/moby/profiles/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/default.json)
- Upstream file SHA256: `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`
- Vendored JSON is reformatted only; semantic equality was checked against that
  pinned source. SHA256 of Python `json.dumps(value, sort_keys=True,
  separators=(',', ':')).encode()`:
  `9da637d2ab0a204fcbd91bd88f1be9e004a3acab61c571a9f5b8870e588a17d2`.
- Apache-2.0 license is retained in `vendor/LICENSE.moby`.

A complete custom profile **does not inherit later Docker default-profile
updates**. On Docker, Chromium or profile upgrades, review upstream changes,
update the vendored baseline/provenance/hash assertion together, and repeat
policy/module checks and live sandboxed acceptance. The baseline is vendored so
module evaluation and tests need no network or import-from-derivation.

## Exact delta and evidence

For amd64/arm64 Docker hosts, without container `CAP_SYS_ADMIN`:

| Syscall | Exactly permitted argument 0 |
| --- | --- |
| `unshare` | `CLONE_NEWUSER` |
| `clone` | `CLONE_NEWUSER | SIGCHLD` |
| `clone` | `CLONE_NEWUSER | CLONE_NEWPID | SIGCHLD` |
| `clone` | `CLONE_NEWUSER | CLONE_NEWNET | SIGCHLD` |
| `clone` | `CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | SIGCHLD` |
| `clone` | `CLONE_NEWPID | SIGCHLD` |

`SIGCHLD` is 17 on these architectures. Exact equality rejects combinations
with mount/IPC/UTS/cgroup namespaces or unrelated clone flags. Ordinary thread/
process creation, including Chromium's `CLONE_FS` filesystem helper, remains
covered by the unmodified baseline. No added rules apply to other host ABIs.

Source inspection used the packaged Chromium version **149.0.7827.53**:

- [`namespace_sandbox.cc`](https://github.com/chromium/chromium/blob/149.0.7827.53/sandbox/linux/services/namespace_sandbox.cc): `LaunchProcessWithOptions` always includes NEWUSER, optionally PID/NET; `ForkInNewPidNamespace` uses PID alone.
- [`credentials.cc`](https://github.com/chromium/chromium/blob/149.0.7827.53/sandbox/linux/services/credentials.cc): user-namespace probe and `MoveToNewUserNS` use `unshare(CLONE_NEWUSER)`; `CanCreateProcessInNewUserNS` uses a USER clone.
- [`launch_posix.cc`](https://github.com/chromium/chromium/blob/149.0.7827.53/base/process/launch_posix.cc): launch adds `SIGCHLD` to the clone flags.
- [`baseline_policy.cc`](https://github.com/chromium/chromium/blob/149.0.7827.53/sandbox/linux/seccomp-bpf-helpers/baseline_policy.cc): clone3 arguments are behind a pointer; returning ENOSYS allows fallback to filterable clone.

The preset leaves `clone3`'s **ENOSYS** response intact and adds no `setns`, mount,
BPF, ptrace, keyring or other syscall permissions. Moby's capability-conditional
rules are preserved; therefore the modules explicitly drop `SYS_ADMIN` and reject
privileged `settings.enableDocker` when this preset is selected. NixOS also
rejects non-Docker backends: these Moby conditional fields are not a portable OCI
seccomp contract. Do not add that capability when consuming the JSON directly.
This is **not** a profile for
bubblewrap's mount-namespace setup.

## RPC Bubblewrap preset

`hardening.seccompProfile = "browser-rpc"` explicitly selects
`security/seccomp/browser-rpc.nix`, packaged by `browser-rpc-seccomp.nix`. It
preserves the narrow browser preset and adds exactly three rules for amd64/arm64
containers without `CAP_SYS_ADMIN`:

- `clone` argument 0 exactly `0x3c020011`: `SIGCHLD | CLONE_NEWNS |
  CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS`.
- `mount` and `pivot_root`, required for the private filesystem tree.
- `umount2` argument 1 exactly `MNT_DETACH` (2), to discard the old root.

Evidence: the pinned Bubblewrap **0.11.2**
[`bubblewrap.c`](https://github.com/containers/bubblewrap/blob/v0.11.2/bubblewrap.c)
(`main`, `privileged_op`) and
[`bind-mount.c`](https://github.com/containers/bubblewrap/blob/v0.11.2/bind-mount.c)
(`bind_mount`), with the flags in `rpc-runtime/sandbox.mjs`. The later
`unshare(CLONE_NEWUSER)` is already covered by the browser preset. No `setns`,
network/cgroup namespace clone, modern mount API or `clone3` grant is added.

**This increases container-wide kernel attack surface.** Seccomp cannot scope
mount paths, filesystem types (pointer arguments), or grants to the Bubblewrap
executable. All container code gains these mount syscall permissions, subject to
kernel capability checks; namespace-local capabilities do not grant host
capabilities. Keep `enableDocker = false`, the explicit `SYS_ADMIN` drop and
`no-new-privileges`; do not use privileged mode or `seccomp=unconfined`.
The original `browser` preset remains unchanged for operators who do not accept
this broader surface. Neither preset is selected implicitly.

Recreate the container to apply the policy. Seccomp permission alone does not
make Docker compatible with nested procfs: Docker's masked/read-only `/proc`
submounts can cause the kernel's `mount_too_revealing` check to reject Bubblewrap's
fresh procfs (`Can't mount proc on /newroot/proc: Operation not permitted`).

For deployments accepting the additional risk, explicitly set
`hardening.allowNestedProcMount = true` together with
`hardening.noNewPrivileges = true`. This emits Docker's
`--security-opt systempaths=unconfined` and removes **all default masked and
read-only system-path protections container-wide**, including paths under
`/proc` and `/sys`. It is not limited to procfs or to Bubblewrap. The option is
false by default, never inferred from a preset, and requires `browser-rpc` and
an enabled RPC filesystem sandbox. That preset continues to require unprivileged
Docker and drop `SYS_ADMIN`; no-new-privileges also disables in-container sudo.
No seccomp or AppArmor bypass is added, and the private PID namespace and fresh
procfs are retained. Never substitute a bind of the outer `/proc`: sibling
`/proc/<pid>/root` paths would undermine the filesystem isolation boundary.

AppArmor's Docker default profile can independently deny mounts, and host
LSM/user-namespace restrictions remain separate blockers; these options do not
disable them. Consumers must first pin
an Agentbox revision containing this preset. Do not change a pinned consumer to
`browser-rpc` while it still uses an older module.

`browser-seccomp-test` checks both profiles' exact deltas and architecture,
capability, namespace and sensitive-syscall matrices. Module tests check both
platforms' selection and hardening. These are offline checks, not live acceptance.
After an authorized rollout, run the Bubblewrap integration test from
`rpc-runtime/test/sandbox.test.mjs` as the agent user inside the recreated
container (with `TEST_BWRAP` pointing to its packaged Bubblewrap); a skipped test
is not acceptance. Then start a fresh RPC session and exercise its file tools,
and run browser acceptance if browser tools are enabled.

## Security boundary and acceptance

This is opt-in **container-wide** permission, not a Chromium-only exemption.
All agent commands gain the same namespace access, exposing additional kernel
code. New namespace-local capabilities do not grant host capabilities, but the
change still expands kernel attack surface. Chromium must retain its namespace
and seccomp-BPF sandboxes. The profile does not change host sysctls, LSM policy,
container network mode, devices, mounts, or credentials.

Kernel support, UID/GID map access and AppArmor/other LSM permissions are separate
requirements. A positive `unshare --user --map-root-user true` is a useful probe,
but `unshare --user --map-root-user --net true` is **intentionally denied** by this
narrow profile: Chromium creates its network namespace with clone instead.
Likewise shell `unshare --pid` is not an acceptance test for Chromium's PID clone.

Build-time tests inspect policy semantics only; they never create namespaces or
modify a running process's seccomp policy. A successful build does not establish
browser compatibility. See [the browser guide](../../docs/browser.md) for explicit
configuration and the real acceptance test to run after an authorized rollout.
