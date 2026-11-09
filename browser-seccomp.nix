{ writeText }:
# Host-side Docker CLI input; this is not an image layer or a Chromium flag.
writeText "agentbox-browser-seccomp.json" (builtins.toJSON (import ./security/seccomp/browser.nix))
