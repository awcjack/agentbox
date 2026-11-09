# nix-instantiate --eval --strict --json tests/browser-module.nix --arg nixpkgs /path/to/nixpkgs
{ nixpkgs }:
let
  lib = import (nixpkgs + "/lib");
  pkgsFor =
    system:
    import nixpkgs {
      inherit system;
      overlays = [
        (_: prev: {
          agentbox = prev.emptyDirectory;
          agentboxImage.override = args: prev.emptyDirectory // { browserTestArgs = args; };
          # Capture the actual generated runtime JSON without building/activating.
          writeText =
            name: text:
            if name == "pi-runtime.json" then
              "/runtime-json/${text}/end-runtime-json"
            else
              prev.writeText name text;
        })
      ];
    };
  evaluate =
    platform: settings:
    let
      pkgs = pkgsFor (if platform == "linux" then "x86_64-linux" else "aarch64-darwin");
      base = {
        services.agentbox = {
          enable = true;
        }
        // settings;
      };
    in
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
            config.services.agentbox.image = lib.mkDefault "/tmp/prebuilt-browser.tar";
          }
        ];
      }).config;
  defaults = {
    enable = false;
    delegation = "tabs";
    allowedDomains = [ ];
    maxOutputChars = 16000;
    commandTimeoutMs = 30000;
    idleTimeoutMs = 300000;
  };
  customBrowser = {
    enable = true;
    delegation = "isolated";
    allowedDomains = [
      "example.org"
      "*.example.net"
    ];
    maxOutputChars = 50000;
    commandTimeoutMs = 120000;
    idleTimeoutMs = 3600000;
  };
  checksFor =
    platform:
    let
      off = evaluate platform { };
      on = evaluate platform { settings.browser.enable = true; };
      preset = evaluate platform { settings.hardening.seccompProfile = "browser"; };
      presetWithBrowser = evaluate platform {
        settings.browser.enable = true;
        settings.hardening.seccompProfile = "browser";
        settings.hardening.noNewPrivileges = true;
      };
      presetNetwork = evaluate platform {
        settings.hardening.seccompProfile = "browser";
        settings.network = {
          enable = true;
          image = "/tmp/prebuilt-network.tar";
        };
      };
      presetPrivileged = evaluate platform {
        settings.hardening.seccompProfile = "browser";
        settings.enableDocker = true;
      };
      customProfile = evaluate platform {
        settings.hardening.seccompProfile = "/tmp/custom profile.json";
      };
      unconfined = evaluate platform { settings.hardening.seccompProfile = "unconfined"; };
      profilePath = builtins.unsafeDiscardStringContext (
        toString (
          (pkgsFor (if platform == "linux" then "x86_64-linux" else "aarch64-darwin")).callPackage
            ../browser-seccomp.nix
            { }
        )
      );
      custom = evaluate platform {
        settings.browser = customBrowser // {
          shmSize = "2g";
        };
        settings.piRpcApi.enable = true;
        settings.piRpcApi.auth.tokens = [
          {
            tokenEnv = "TEST_TOKEN";
            scopes = [
              "sessions:read"
              "sessions:write"
              "browser:read"
              "browser:control"
            ];
          }
        ];
      };
      both = evaluate platform {
        settings.browser = {
          enable = true;
          shmSize = "2g";
        };
        settings.desktop = {
          enable = true;
          shmSize = "3g";
        };
      };
      runtime =
        config:
        let
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
        builtins.fromJSON (builtins.unsafeDiscardStringContext json);
      options =
        config:
        if platform == "linux" then
          lib.concatStringsSep " " config.virtualisation.oci-containers.containers.agentbox.extraOptions
        else
          (builtins.head config.environment.systemPackages).text;
      rejected =
        browser:
        !(builtins.tryEval (
          builtins.deepSeq
            (evaluate platform { settings.browser = browser; }).services.agentbox.settings.browser
            true
        )).success;
    in
    {
      seccompDefault = off.services.agentbox.settings.hardening.seccompProfile == "default";
      seccompNotImplicit = !lib.hasInfix "seccomp=" (options on);
      seccompExplicit = lib.hasInfix "seccomp=${profilePath}" (options preset);
      seccompWithBrowser = lib.hasInfix "seccomp=${profilePath}" (options presetWithBrowser);
      seccompHostOnly = (runtime presetWithBrowser).browser == defaults // { enable = true; };
      seccompRetainsNoNewPrivileges = lib.hasInfix "no-new-privileges" (options presetWithBrowser);
      seccompDropsSysAdmin = lib.hasInfix "--cap-drop=SYS_ADMIN" (options preset);
      seccompRestrictedNetwork =
        lib.hasInfix "seccomp=${profilePath}" (options presetNetwork)
        && lib.hasInfix "--cap-drop=SYS_ADMIN" (options presetNetwork)
        && lib.hasInfix "--network=container:agentbox-network" (options presetNetwork);
      seccompNoAddedCapabilities = !lib.hasInfix "--cap-add=SYS_ADMIN" (options preset);
      seccompRejectsPrivileged = lib.any (
        a: !a.assertion && lib.hasPrefix "Agentbox browser seccomp requires" a.message
      ) presetPrivileged.assertions;
      # NixOS assertion messages may refer to absent settings when the assertion
      # is true (e.g. Podman while using Docker). Only force failure messages.
      seccompAcceptsUnprivileged =
        !lib.any (a: !a.assertion && lib.hasPrefix "Agentbox browser seccomp" a.message) preset.assertions;
      seccompCustomPreserved = lib.hasInfix "seccomp=/tmp/custom profile.json" (options customProfile);
      seccompCustomQuoted =
        platform == "linux"
        || lib.hasInfix "--security-opt 'seccomp=/tmp/custom profile.json'" (options customProfile);
      seccompUnconfinedPreserved = lib.hasInfix "seccomp=unconfined" (options unconfined);
      defaults = off.services.agentbox.settings.browser == defaults // { shmSize = "1g"; };
      runtimeDefaults = (runtime off).browser == defaults;
      runtimeEnabled = (runtime on).browser == defaults // { enable = true; };
      runtimeCustom = (runtime custom).browser == customBrowser;
      runtimeBrowserScopes =
        (builtins.head (runtime custom).piRpcApi.auth.tokens).scopes == [
          "sessions:read"
          "sessions:write"
          "browser:read"
          "browser:control"
        ];
      runtimeOtherFields =
        (runtime custom).version == 1
        && (runtime custom) ? defaults
        && (runtime custom) ? servers
        && (runtime custom) ? piRpcApi;
      disabledNoShm = !lib.hasInfix "--shm-size=" (options off);
      enabledShm = lib.hasInfix "--shm-size=1g" (options on);
      customShm = lib.hasInfix "--shm-size=2g" (options custom);
      desktopShmPrecedence =
        lib.hasInfix "--shm-size=3g" (options both) && !lib.hasInfix "--shm-size=2g" (options both);
      noDesktopDependency =
        !on.services.agentbox.settings.desktop.enable && on.services.agentbox.onDemandScripts == { };
      rejectsDelegation = rejected { delegation = "shared"; };
      rejectsDomainUrl = rejected { allowedDomains = [ "https://example.com" ]; };
      rejectsDomainType = rejected { allowedDomains = [ 1 ]; };
      rejectsDomainCount = rejected { allowedDomains = lib.replicate 129 "example.com"; };
      rejectsOutputLow = rejected { maxOutputChars = 999; };
      rejectsOutputHigh = rejected { maxOutputChars = 50001; };
      rejectsCommandLow = rejected { commandTimeoutMs = 999; };
      rejectsCommandHigh = rejected { commandTimeoutMs = 120001; };
      rejectsIdleLow = rejected { idleTimeoutMs = 9999; };
      rejectsIdleHigh = rejected { idleTimeoutMs = 3600001; };
      rejectsShm = rejected { shmSize = "1g --ipc=host"; };
    }
    // lib.optionalAttrs (platform == "linux") {
      seccompRejectsPodman =
        let
          podman = evaluate platform {
            backend = "podman";
            settings.hardening.seccompProfile = "browser";
          };
        in
        lib.any (
          a: !a.assertion && a.message == "Agentbox browser seccomp preset requires the Docker backend."
        ) podman.assertions;
      disabledImage = off.services.agentbox.image.browserTestArgs == { };
      enabledImage = on.services.agentbox.image.browserTestArgs == { withBrowser = true; };
      bothImage =
        both.services.agentbox.image.browserTestArgs == {
          withBrowser = true;
          withDesktop = true;
        };
      explicitImagePreserved =
        toString
          (evaluate platform {
            settings.browser.enable = true;
            image = (pkgsFor "x86_64-linux").emptyDirectory;
          }).services.agentbox.image == toString (pkgsFor "x86_64-linux").emptyDirectory;
    };
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
      callPackage = _: _: throw "optional package forced";
    };
  basePackages = imageExpression imageArgs;
  browserPackages = imageExpression (
    imageArgs
    // {
      withBrowser = true;
      agent-browser = "agent-browser-sentinel";
      agentbox-browser = "chromium-sentinel";
    }
  );
  verify = name: passed: if passed then true else throw "Browser evaluation failed: ${name}";
in
(lib.genAttrs [ "linux" "darwin" ] (platform: lib.mapAttrs verify (checksFor platform)))
// {
  image = lib.mapAttrs verify {
    disabledLazy = builtins.deepSeq basePackages true;
    enabledPackages =
      browserPackages == basePackages
      ++ [
        "agent-browser-sentinel"
        "chromium-sentinel"
      ];
    enabledForcesPackages =
      !(builtins.tryEval (builtins.deepSeq (imageExpression (imageArgs // { withBrowser = true; })) true))
      .success;
  };
}
