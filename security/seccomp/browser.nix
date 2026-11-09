# Docker seccomp JSON, not an OCI profile: keep Moby's conditional capability
# and architecture rules. See README.md for provenance and maintenance policy.
let
  base = builtins.fromJSON (builtins.readFile ./vendor/moby-default-v0.2.3.json);
  arches = [
    "amd64"
    "arm64"
  ];
  # Chromium 149.0.7827.53: CanCreateProcessInNewUserNS, LaunchProcessWithOptions
  # and ForkInNewPidNamespace. Namespace clones use SIGCHLD (17), no other flags.
  # Decimal constants are intentional: Nix integer literals are not hexadecimal.
  user = 268435456; # CLONE_NEWUSER (0x10000000)
  pid = 536870912; # CLONE_NEWPID (0x20000000)
  net = 1073741824; # CLONE_NEWNET (0x40000000)
  allow = name: flags: {
    names = [ name ];
    action = "SCMP_ACT_ALLOW";
    args = [
      {
        index = 0;
        value = flags;
        op = "SCMP_CMP_EQ";
      }
    ];
    includes.arches = arches;
    excludes.caps = [ "CAP_SYS_ADMIN" ];
    comment = "Agentbox opt-in Chromium namespace sandbox; exact flags only";
  };
in
base
// {
  # Add rules rather than loosening Moby's ordinary clone mask. No new setns,
  # mount, ptrace, bpf or clone3 permissions; clone3's ENOSYS fallback stays put.
  syscalls =
    base.syscalls
    ++ [ (allow "unshare" user) ]
    ++ builtins.map (flags: allow "clone" (flags + 17)) [
      user
      (user + pid)
      (user + net)
      (user + pid + net)
      pid
    ];
}
