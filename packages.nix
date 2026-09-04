# The agentbox package set, factored out of flake.nix so it can be consumed two
# ways from the same definition:
#   - `packages.<system>.*`     — `nix build .#agentboxImage`
#   - `overlays.default`        — `pkgs.agentbox`, `pkgs.agentboxImage`, … in a
#                                 NixOS / nix-darwin config, which is what the
#                                 modules default to.
#
# The bundled agents come from the package arguments via callPackage. Any
# further agents are intentionally NOT wired in — they stay `null`; add them at
# the call site with `.override` (see README.md → "Advanced").
{
  pkgs,
  pi-coding-agent ? pkgs.pi-coding-agent,
}:

let
  isLinux = pkgs.stdenv.hostPlatform.isLinux;

  # Pre-configured neovim baked into the image; also exposed on its own.
  agentbox-neovim = pkgs.callPackage ./neovim.nix { };
  pi-agentbox-mcp-runtime = pkgs.callPackage ./runtime { };
  agentbox-pi-rpc-runtime = pkgs.callPackage ./rpc-runtime { inherit pi-coding-agent; };
in
{
  # Host-side CLI that drives the container (status / shell / logs / …).
  agentbox = pkgs.callPackage ./package.nix { };

  inherit
    agentbox-neovim
    agentbox-pi-rpc-runtime
    pi-agentbox-mcp-runtime
    ;

  # The OCI image. Linux-only (docker images are Linux). Codex and OpenCode are
  # auto-filled from nixpkgs; Pi is supplied above so it can track current
  # nixpkgs independently. Any further agents stay null.
  agentboxImage =
    if isLinux then
      pkgs.callPackage ./image.nix {
        inherit
          agentbox-neovim
          agentbox-pi-rpc-runtime
          pi-agentbox-mcp-runtime
          pi-coding-agent
          ;
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
        cp ${./extensions/lsp-client.ts} $out/extensions/lsp-client.ts
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

  pi-workflow-extension-test =
    let
      testSource = pkgs.runCommand "pi-workflow-extension-test-source" { } ''
        mkdir -p $out/tests $out/extensions
        cp ${./tests/pi-workflow.ts} $out/tests/pi-workflow.ts
        cp ${./extensions/pi-workflow.ts} $out/extensions/pi-workflow.ts
      '';
    in
    pkgs.runCommand "pi-workflow-extension-test" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
      node --experimental-strip-types ${testSource}/tests/pi-workflow.ts
      touch $out
    '';

  pi-policy-extension-test =
    let
      testSource = pkgs.runCommand "pi-policy-extension-test-source" { } ''
        mkdir -p $out/tests $out/extensions
        cp ${./tests/pi-policy.ts} $out/tests/pi-policy.ts
        cp ${./extensions/pi-policy.ts} $out/extensions/pi-policy.ts
      '';
    in
    pkgs.runCommand "pi-policy-extension-test" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
      node --experimental-strip-types ${testSource}/tests/pi-policy.ts
      touch $out
    '';

  pi-lsp-client-test =
    let
      testSource = pkgs.runCommand "pi-lsp-client-test-source" { } ''
        mkdir -p $out/tests $out/extensions
        cp ${./tests/lsp-client.ts} $out/tests/lsp-client.ts
        cp ${./extensions/lsp-client.ts} $out/extensions/lsp-client.ts
      '';
    in
    pkgs.runCommand "pi-lsp-client-test" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
      node --experimental-strip-types ${testSource}/tests/lsp-client.ts
      touch $out
    '';

  pi-mcp-runtime-test =
    let
      testSource = pkgs.runCommand "pi-mcp-runtime-test-source" { } ''
        mkdir -p $out/tests
        cp ${./runtime/pi-mcp.mjs} $out/pi-mcp.mjs
        cp ${./runtime/tests/pi-mcp.test.mjs} $out/tests/pi-mcp.test.mjs
      '';
    in
    pkgs.runCommand "pi-mcp-runtime-test" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
      node --test ${testSource}/tests/pi-mcp.test.mjs
      touch $out
    '';

  pi-rpc-runtime-test =
    let
      testSource = pkgs.runCommand "pi-rpc-runtime-test-source" { } ''
        mkdir -p $out/test
        cp ${./rpc-runtime/runtime.mjs} $out/runtime.mjs
        cp ${./rpc-runtime/supervise.sh} $out/supervise.sh
        cp ${./rpc-runtime/test/runtime.test.mjs} $out/test/runtime.test.mjs
      '';
    in
    pkgs.runCommand "pi-rpc-runtime-test" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
      TEST_BASH=${pkgs.bash}/bin/bash node --test ${testSource}/test/runtime.test.mjs
      touch $out
    '';
}
