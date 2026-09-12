# nix-instantiate --eval --strict --json tests/desktop-module.nix --arg nixpkgs /path/to/nixpkgs
{ nixpkgs }:
let
  lib = import (nixpkgs + "/lib");
  pkgs = import nixpkgs {
    system = "x86_64-linux";
    overlays = [
      (final: _: {
        agentbox = final.emptyDirectory;
        agentboxImage.override = args: final.emptyDirectory // { desktopTestArgs = args; };
      })
    ];
  };
  evaluate =
    settings:
    (import (nixpkgs + "/nixos/lib/eval-config.nix") {
      system = "x86_64-linux";
      modules = [
        ../modules/nixos.nix
        {
          nixpkgs.pkgs = pkgs;
          system.stateVersion = "26.05";
          services.agentbox.enable = true;
        }
        { services.agentbox = settings; }
      ];
    }).config;
  disabled = evaluate { };
  enabled = evaluate { settings.desktop.enable = true; };
  custom = evaluate {
    settings.desktop = {
      enable = true;
      vncPort = 15900;
      webPort = 16080;
      resolution = "1920x1080x32";
      shmSize = "2g";
    };
    settings.enableCloudTools = true;
    settings.enableNix = false;
    onDemandScripts.existing = "exec existing-daemon";
    bootScripts.existingBoot = "exec boot-daemon";
    extraEnvironment.EXISTING = "preserved";
  };
  explicitImage = evaluate {
    settings.desktop.enable = true;
    image = pkgs.emptyDirectory;
  };
  off = disabled.virtualisation.oci-containers.containers.agentbox;
  on = enabled.virtualisation.oci-containers.containers.agentbox;
  customized = custom.virtualisation.oci-containers.containers.agentbox;
  desktopEnv = {
    AGENTBOX_DESKTOP_VNC_PORT = "5900";
    AGENTBOX_DESKTOP_WEB_PORT = "6080";
    AGENTBOX_DESKTOP_RESOLUTION = "1440x900x24";
  };
  sharedDarwin =
    (lib.evalModules {
      specialArgs.pkgs = import nixpkgs { system = "aarch64-darwin"; };
      modules = [
        ../modules/common-options.nix
        {
          options.services.agentbox.dataDir = lib.mkOption { type = lib.types.path; };
          config.services.agentbox = {
            dataDir = "/Users/test/.agentbox";
            settings.desktop.enable = true;
            onDemandScripts.existing = "exec existing-daemon";
          };
        }
      ];
    }).config.services.agentbox;

  # Exercise the actual image package list, not a duplicated conditional.
  # Stub builders and unrelated packages so no image closure is evaluated.
  imageExpression = import ../image.nix;
  imageArgs =
    lib.mapAttrs (_: _: "/unused-package") (
      lib.filterAttrs (_: hasDefault: !hasDefault) (builtins.functionArgs imageExpression)
    )
    // {
      inherit lib;
      dockerTools.buildLayeredImageWithNixDb = args: (builtins.head args.contents).paths;
      buildEnv = args: args;
      writeShellScriptBin = _: _: "/unused-wrapper";
      callPackage = _: _: throw "desktop package forced";
    };
  basePackages = imageExpression imageArgs;
  desktopPackages = imageExpression (
    imageArgs
    // {
      withDesktop = true;
      callPackage =
        path: args:
        assert path == ../desktop.nix && args == { };
        "desktop-package-sentinel";
    }
  );
  forcedDesktop = builtins.tryEval (
    builtins.deepSeq (imageExpression (
      imageArgs
      // {
        withDesktop = true;
      }
    )) true
  );
  checks = {
    disabledByDefault = !disabled.services.agentbox.settings.desktop.enable;
    disabledNoService =
      disabled.services.agentbox.onDemandScripts == { } && disabled.services.agentbox.bootScripts == { };
    disabledNoShm = !lib.any (lib.hasPrefix "--shm-size") off.extraOptions;
    disabledNoImageFlag = disabled.services.agentbox.image.desktopTestArgs == { };
    disabledNoDesktopEnv =
      !(off.environment ? XAUTHORITY)
      && !(off.environment ? DBUS_SESSION_BUS_ADDRESS)
      && lib.all (name: !(builtins.hasAttr name off.environment)) (builtins.attrNames desktopEnv);
    enabledOnDemandOnly =
      enabled.services.agentbox.onDemandScripts == {
        desktop = "exec agentbox-desktop";
      }
      && enabled.services.agentbox.bootScripts == { };
    enabledEnvironment =
      lib.all (name: on.environment.${name} == desktopEnv.${name}) (builtins.attrNames desktopEnv)
      && on.environment.DISPLAY == ":10"
      && on.environment.XAUTHORITY == "/tmp/agentbox-desktop-1000/Xauthority"
      && on.environment.DBUS_SESSION_BUS_ADDRESS == "unix:path=/tmp/agentbox-desktop-1000/bus";
    enabledShm = builtins.elem "--shm-size=1g" on.extraOptions;
    enabledImageFlag = enabled.services.agentbox.image.desktopTestArgs == { withDesktop = true; };
    enabledMount =
      builtins.elem "/var/lib/agentbox/on-demand.d:/home/agent/.agentbox/on-demand.d:ro" on.volumes
      && !lib.any (lib.hasInfix "/boot.d") on.volumes;
    enabledActivation =
      lib.hasInfix "/on-demand.d/desktop.sh" enabled.services.agentbox.extraActivation
      && !lib.hasInfix "/boot.d/desktop.sh" enabled.services.agentbox.extraActivation;
    customEnvironment =
      customized.environment.AGENTBOX_DESKTOP_VNC_PORT == "15900"
      && customized.environment.AGENTBOX_DESKTOP_WEB_PORT == "16080"
      && customized.environment.AGENTBOX_DESKTOP_RESOLUTION == "1920x1080x32"
      && customized.environment.EXISTING == "preserved";
    customShm = lib.filter (lib.hasPrefix "--shm-size") customized.extraOptions == [ "--shm-size=2g" ];
    customImageFlags =
      custom.services.agentbox.image.desktopTestArgs == {
        withDesktop = true;
        withCloudTools = true;
        withNix = false;
      };
    existingScriptsPreserved =
      custom.services.agentbox.onDemandScripts == {
        desktop = "exec agentbox-desktop";
        existing = "exec existing-daemon";
      }
      && custom.services.agentbox.bootScripts == { existingBoot = "exec boot-daemon"; };
    explicitImagePreserved =
      !(explicitImage.services.agentbox.image ? desktopTestArgs)
      && toString explicitImage.services.agentbox.image == toString pkgs.emptyDirectory;
    sharedDarwinOnDemand =
      sharedDarwin.onDemandScripts == {
        desktop = "exec agentbox-desktop";
        existing = "exec existing-daemon";
      }
      && sharedDarwin.bootScripts == { }
      && sharedDarwin.extraEnvironment == desktopEnv;
    sharedDarwinActivation =
      lib.hasInfix "/on-demand.d/desktop.sh" sharedDarwin.extraActivation
      && builtins.elem "/Users/test/.agentbox/on-demand.d:/home/agent/.agentbox/on-demand.d:ro" sharedDarwin.extraVolumes;
    imageDisabledLazy = builtins.deepSeq basePackages true;
    imageEnabledIncludesDesktop = desktopPackages == basePackages ++ [ "desktop-package-sentinel" ];
    imageEnabledForcesDesktop = !forcedDesktop.success;
  };
in
lib.mapAttrs (
  name: passed: if passed then true else throw "Desktop evaluation failed: ${name}"
) checks
