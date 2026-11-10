{ writeText }:
# Host-side Docker policy, not an image layer or a Pi sandbox bypass.
writeText "agentbox-browser-rpc-seccomp.json" (
  builtins.toJSON (import ./security/seccomp/browser-rpc.nix)
)
