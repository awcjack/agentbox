# Explicit container-wide opt-in for Chromium AND the RPC Bubblewrap launcher.
# Keep browser.nix narrow; mount permissions cannot be scoped to a pathname or
# executable with seccomp. The kernel still enforces user-namespace capabilities.
let
  base = import ./browser.nix;
  scope = {
    includes.arches = [
      "amd64"
      "arm64"
    ];
    excludes.caps = [ "CAP_SYS_ADMIN" ];
  };
  exact = index: value: {
    inherit index value;
    op = "SCMP_CMP_EQ";
  };
  allow =
    names: args:
    scope
    // {
      inherit names args;
      action = "SCMP_ACT_ALLOW";
      comment = "Agentbox opt-in RPC Bubblewrap setup; container-wide permission";
    };
  # Bubblewrap 0.11.2: SIGCHLD | NEWNS | NEWUSER | NEWPID | NEWIPC | NEWUTS.
  # Matches rpc-runtime/sandbox.mjs; no network/cgroup namespace or clone3 grant.
  rpcClone = 17 + 131072 + 268435456 + 536870912 + 134217728 + 67108864;
in
base
// {
  syscalls = base.syscalls ++ [
    (allow [ "clone" ] [ (exact 0 rpcClone) ])
    (allow [ "mount" "pivot_root" ] [ ])
    (allow [ "umount2" ] [ (exact 1 2) ]) # MNT_DETACH only
  ];
}
