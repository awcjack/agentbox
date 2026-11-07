# nix-instantiate --eval --strict --json tests/pi-rpc-sandbox-module.nix --arg nixpkgs /path/to/nixpkgs
{ nixpkgs }:
let
  lib = import (nixpkgs + "/lib");
  evaluate =
    platform: sandbox:
    let
      pkgs = import nixpkgs {
        system = if platform == "linux" then "x86_64-linux" else "aarch64-darwin";
        overlays = [
          (_: prev: {
            agentbox = prev.emptyDirectory;
            agentboxImage.override = _: prev.emptyDirectory;
            writeText =
              name: text:
              if name == "pi-runtime.json" then
                "/runtime-json/${text}/end-runtime-json"
              else
                prev.writeText name text;
          })
        ];
      };
      base.services.agentbox = {
        enable = true;
        environmentFile = "/tmp/test-agentbox-env";
        settings.piRpcApi = {
          enable = true;
          auth.tokens = [ { tokenEnv = "TEST_TOKEN"; } ];
          inherit sandbox;
          profiles.project = {
            cwd = "/workspace/project";
            sessionDir = "/home/agent/.pi/agent/sessions/--project--";
          };
        };
      };
      config =
        if platform == "linux" then
          (import (nixpkgs + "/nixos/lib/eval-config.nix") {
            system = "x86_64-linux";
            modules = [
              ../modules/nixos.nix
              base
              {
                nixpkgs.pkgs = pkgs;
                system.stateVersion = "26.05";
              }
            ];
          }).config
        else
          (lib.evalModules {
            specialArgs = { inherit pkgs; };
            modules = [
              ../modules/darwin.nix
              base
              {
                options = {
                  assertions = lib.mkOption {
                    type = lib.types.listOf lib.types.attrs;
                    default = [ ];
                  };
                  environment = lib.mkOption { type = lib.types.attrs; };
                  launchd = lib.mkOption { type = lib.types.attrs; };
                  system = lib.mkOption { type = lib.types.attrs; };
                };
                config.system.primaryUser = "test";
                config.services.agentbox.image = lib.mkDefault "/tmp/prebuilt.tar";
              }
            ];
          }).config;
      activation =
        if platform == "linux" then
          config.system.activationScripts.agentbox-config.text
        else
          config.system.activationScripts.postActivation.text;
      json = builtins.head (
        lib.splitString "/end-runtime-json" (
          builtins.elemAt (lib.splitString "/runtime-json/" activation) 1
        )
      );
    in
    (builtins.fromJSON (builtins.unsafeDiscardStringContext json)).piRpcApi;
  checks =
    platform:
    let
      defaults = evaluate platform { };
      off = evaluate platform { enable = false; };
      custom = evaluate platform {
        readOnlyPaths = [ "/opt/project-reference" ];
        readWritePaths = [ "/var/cache/project" ];
      };
    in
    assert
      defaults.sandbox == {
        enable = true;
        readOnlyPaths = [ ];
        readWritePaths = [ ];
      };
    assert off.sandbox.enable == false;
    assert custom.sandbox.readOnlyPaths == [ "/opt/project-reference" ];
    assert custom.sandbox.readWritePaths == [ "/var/cache/project" ];
    assert custom.executable == "/bin/pi";
    assert custom.profiles.project.cwd == "/workspace/project";
    assert custom.profiles.project.sessionDir == "/home/agent/.pi/agent/sessions/--project--";
    true;
in
{
  linux = checks "linux";
  darwin = checks "darwin";
}
