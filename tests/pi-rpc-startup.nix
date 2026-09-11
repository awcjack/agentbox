{ nixpkgs }:
let
  lib = import (nixpkgs + "/lib");
  pkgs = import nixpkgs {
    system = "x86_64-linux";
    overlays = [
      (_: prev: {
        agentbox = prev.emptyDirectory;
        agentboxImage.override = _: prev.emptyDirectory;
        writeShellScriptBin = name: text: (prev.writeShellScriptBin name text) // { inherit text; };
      })
    ];
  };
  evaluate =
    platform: rpc:
    let
      settings = {
        services.agentbox = {
          enable = true;
          image = pkgs.emptyDirectory;
          dataDir = "/var/lib/agentbox";
          environmentFile = "/test/secrets";
          settings.piRpcApi = {
            auth.tokens = [ { tokenEnv = "TEST_TOKEN"; } ];
          }
          // rpc;
        };
      };
    in
    if platform == "linux" then
      (import (nixpkgs + "/nixos/lib/eval-config.nix") {
        modules = [
          ../modules/nixos.nix
          settings
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
          settings
          {
            config.system.primaryUser = "test";
            options = {
              assertions = lib.mkOption { type = lib.types.listOf lib.types.raw; };
              environment.systemPackages = lib.mkOption { type = lib.types.listOf lib.types.raw; };
              launchd = lib.mkOption { type = lib.types.raw; };
              system.primaryUser = lib.mkOption { type = lib.types.str; };
              system.activationScripts = lib.mkOption { type = lib.types.attrsOf lib.types.raw; };
            };
          }
        ];
      }).config;
  checksFor =
    platform:
    let
      boot = evaluate platform { enable = true; };
      demand = evaluate platform {
        enable = true;
        autoStart = false;
      };
      disabled = evaluate platform {
        enable = false;
        autoStart = false;
      };
      cfg = demand.services.agentbox;
      cli = config: (builtins.head config.environment.systemPackages).text;
      env = config: config.virtualisation.oci-containers.containers.agentbox.environment;
      health =
        config:
        builtins.head (
          lib.splitString "\n" (builtins.elemAt (lib.splitString "--health-cmd " (cli config)) 1)
        );
      activation =
        config:
        if platform == "linux" then
          config.system.activationScripts.agentbox-config.text
        else
          config.system.activationScripts.postActivation.text;
      runtime =
        config:
        lib.filter (lib.hasSuffix "-pi-runtime.json.drv") (
          builtins.attrNames (builtins.getContext (activation config))
        );
    in
    {
      defaultBoot =
        boot.services.agentbox.settings.piRpcApi.autoStart && boot.services.agentbox.onDemandScripts == { };
      disabledNoLauncher = disabled.services.agentbox.onDemandScripts == { };
      onDemandOnly = builtins.attrNames cfg.onDemandScripts == [ "pi-rpc" ] && cfg.bootScripts == { };
      launcherEnvironment = lib.all (text: lib.hasInfix text cfg.onDemandScripts.pi-rpc) [
        "export HOME=/home/agent"
        "export XDG_CONFIG_HOME=/home/agent/.config"
        "export PI_AGENTBOX_RUNTIME_CONFIG=/etc/agentbox/pi-runtime.json"
        "export PI_RPC_LOG_FILE=/home/agent/.agentbox-logs/pi-rpc-runtime.log"
        "exec /bin/pi-rpc-runtime-supervise"
      ];
      authUnchanged = cfg.settings.piRpcApi.auth == boot.services.agentbox.settings.piRpcApi.auth;
      runtimeUnchanged = runtime demand != [ ] && runtime demand == runtime boot;
      activation = lib.hasInfix "/on-demand.d/pi-rpc.sh" cfg.extraActivation;
      mount = builtins.elem "/var/lib/agentbox/on-demand.d:/home/agent/.agentbox/on-demand.d:ro" cfg.extraVolumes;
    }
    // (
      if platform == "linux" then
        {
          environment =
            (env demand).ENABLE_PI_RPC_API == "true"
            && (env demand).PI_RPC_API_AUTO_START == "false"
            && (env boot).PI_RPC_API_AUTO_START == "true";
          otherEnvironmentUnchanged =
            builtins.removeAttrs (env demand) [ "PI_RPC_API_AUTO_START" ]
            == builtins.removeAttrs (env boot) [ "PI_RPC_API_AUTO_START" ];
        }
      else
        {
          environment =
            lib.hasInfix "PI_RPC_API_AUTO_START=\"false\"" (cli demand)
            && lib.hasInfix "ENABLE_PI_RPC_API=\"true\"" (cli demand)
            && lib.hasInfix "PI_RPC_API_AUTO_START=\"true\"" (cli boot);
          healthGated =
            lib.hasInfix "/health/ready" (health boot)
            && !lib.hasInfix "/health/ready" (health demand)
            && !lib.hasInfix "/health/ready" (health disabled);
          stoppedHint = lib.hasInfix "Start it with: agentbox service start pi-rpc" (cli demand);
        }
    );
  imageExpression = import ../image.nix;
  image = imageExpression (
    (lib.mapAttrs (_: _: "/unused") (
      lib.filterAttrs (_: default: !default) (builtins.functionArgs imageExpression)
    ))
    // {
      inherit lib;
      dockerTools.buildLayeredImageWithNixDb = args: args;
      writeShellScriptBin =
        name: text: if name == "entrypoint" then pkgs.writeShellScriptBin name text else "/unused";
    }
  );
in
{
  checks =
    lib.genAttrs [ "linux" "darwin" ] (
      platform:
      lib.mapAttrs (name: passed: if passed then true else throw "${platform}: ${name}") (
        checksFor platform
      )
    )
    // {
      imageDefaultCommand =
        if image.config.Cmd == [ ] then true else throw "Image default Cmd must be empty";
    };
  shell =
    pkgs.runCommand "pi-rpc-startup-shell-test"
      {
        nativeBuildInputs = [
          pkgs.bash
          pkgs.gnused
          pkgs.coreutils
        ];
      }
      ''
        bash ${./pi-rpc-startup.sh} ${builtins.head image.config.Entrypoint} \
          ${pkgs.callPackage ../package.nix { }}/bin/agentbox \
          ${
            builtins.head
              (evaluate "darwin" {
                enable = true;
                autoStart = false;
              }).environment.systemPackages
          }/bin/agentbox ${lib.escapeShellArgs image.config.Cmd}
        touch "$out"
      '';
}
