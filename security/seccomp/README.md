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
