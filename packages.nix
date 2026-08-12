# The agentbox package set, factored out of flake.nix so it can be consumed two
# ways from the same definition:
#   - `packages.<system>.*`     — `nix build .#agentboxImage`
#   - `overlays.default`        — `pkgs.agentbox`, `pkgs.agentboxImage`, … in a
#                                 NixOS / nix-darwin config, which is what the
#                                 modules default to.
#
# The bundled agents (Codex + OpenCode + Pi) come straight from nixpkgs via
# callPackage. Any further agents are intentionally NOT wired in — they stay
# `null`; add them at the call site with `.override` (see README.md →
# "Advanced").
{ pkgs }:

let
  isLinux = pkgs.stdenv.hostPlatform.isLinux;

  # Pre-configured neovim baked into the image; also exposed on its own.
  agentbox-neovim = pkgs.callPackage ./neovim.nix { };
in
{
  # Host-side CLI that drives the container (status / shell / logs / …).
  agentbox = pkgs.callPackage ./package.nix { };

  inherit agentbox-neovim;

  # The OCI image. Linux-only (docker images are Linux). codex + opencode + pi are
  # auto-filled from nixpkgs by callPackage; any further agents stay null.
  agentboxImage =
    if isLinux then
      pkgs.callPackage ./image.nix {
        inherit agentbox-neovim;
        # The extra-agent args default to null inside image.nix; override here
        # to bake one in.
      }
    else
      null;

  agent-archive-request-test =
    pkgs.runCommand "agent-archive-request-test"
      {
        nativeBuildInputs = [
          pkgs.bash
          pkgs.coreutils
          pkgs.findutils
          pkgs.jq
          pkgs.util-linux
        ];
      }
      ''
        bash ${./tests/agent-archive-request.sh} ${./scripts/agent-archive-request.sh}
        touch $out
      '';

  pi-agentbox-extension-test =
    let
      testSource = pkgs.runCommand "pi-agentbox-extension-test-source" { } ''
        mkdir -p $out/tests $out/extensions
        cp ${./tests/pi-agentbox.ts} $out/tests/pi-agentbox.ts
        cp ${./extensions/pi-agentbox.ts} $out/extensions/pi-agentbox.ts
      '';
    in
    pkgs.runCommand "pi-agentbox-extension-test"
      {
        nativeBuildInputs = [ pkgs.nodejs_22 ];
      }
      ''
        node --experimental-strip-types ${testSource}/tests/pi-agentbox.ts
        touch $out
      '';
}
