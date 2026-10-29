# nix-instantiate --eval --strict --json tests/network-modules.nix --arg nixpkgs /path/to/nixpkgs
{
  nixpkgs,
  scriptsOnly ? false,
}:
let
  lib = import (nixpkgs + "/lib");
  linuxPkgs = import nixpkgs { system = "aarch64-linux"; };
  darwinPkgs = import nixpkgs { system = "aarch64-darwin"; };
  linuxWithBackend =
    backend: settings:
    (import (nixpkgs + "/nixos/lib/eval-config.nix") {
      system = "aarch64-linux";
      modules = [
        ../modules/nixos.nix
        {
          nixpkgs.pkgs = linuxPkgs;
          system.stateVersion = "26.05";
          services.agentbox = {
            inherit backend;
            enable = true;
            image = linuxPkgs.hello;
            package = linuxPkgs.hello;
            user = "agent";
            settings = lib.recursiveUpdate {
              network.image = "/tmp/helper.tar";
              dockerProxy.enable = true;
            } settings;
          };
        }
      ];
    }).config;
  linux = linuxWithBackend "docker";
  darwin =
    settings:
    (lib.evalModules {
      specialArgs.pkgs = darwinPkgs;
      modules = [
        ../modules/darwin.nix
        ({ lib, ... }: {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.attrs;
              default = [ ];
            };
            environment = lib.mkOption { type = lib.types.attrs; };
            launchd = lib.mkOption { type = lib.types.attrs; };
            system = lib.mkOption { type = lib.types.attrs; };
          };
          config = {
            system.primaryUser = "agent";
            services.agentbox = {
              enable = true;
              image = "/tmp/agentbox.tar";
              settings = lib.recursiveUpdate {
                network.image = "/tmp/helper.tar";
                dockerProxy.enable = true;
              } settings;
            };
          };
        })
      ];
    }).config;
  openLinux = linux { };
  closedLinux = linux { network.enable = true; };
  closedDarwin = darwin { network.enable = true; };
  openDarwin = darwin { };
  linuxOptions = closedLinux.virtualisation.oci-containers.containers.agentbox.extraOptions;
  darwinScript = (builtins.head closedDarwin.environment.systemPackages).text;
  failed = config: builtins.filter (a: !a.assertion) config.assertions;
  contains = lib.hasInfix;
  checks = {
    linuxDefault = builtins.elem "--network=host" openLinux.virtualisation.oci-containers.containers.agentbox.extraOptions;
    linuxRestricted = builtins.elem "--network=container:agentbox-network" linuxOptions;
    linuxDropsRaw = builtins.elem "--cap-drop=NET_RAW" linuxOptions;
    linuxNoHostname = !(builtins.elem "--hostname=agentbox" linuxOptions);
    linuxResolver = builtins.elem "/var/lib/agentbox/network.env.resolv:/etc/resolv.conf:ro" closedLinux.virtualisation.oci-containers.containers.agentbox.volumes;
    linuxProxyLocal = builtins.elem "--network=container:agentbox-network" closedLinux.virtualisation.oci-containers.containers.agentbox-docker-proxy.extraOptions;
    linuxBindsNetwork = builtins.elem "agentbox-network.service" closedLinux.systemd.services.docker-agentbox.bindsTo;
    linuxProxyDependency = builtins.elem "agentbox-network.service" closedLinux.systemd.services.docker-agentbox-docker-proxy.requires;
    linuxServiceStarts = contains "start" closedLinux.systemd.services.agentbox-network.serviceConfig.ExecStart;
    darwinDefault = contains "--network=host" (builtins.head openDarwin.environment.systemPackages)
    .text;
    darwinRestricted =
      contains "--network=container:agentbox-network" darwinScript
      && !(contains "--network=host" darwinScript);
    darwinStopsNetwork =
      contains "agentbox-network" darwinScript && contains "--restart no" darwinScript;
    darwinDropsRaw = contains "--cap-drop=NET_RAW" darwinScript;
    darwinValid = failed closedDarwin == [ ];
    rejectsPrivileged =
      failed (darwin {
        network.enable = true;
        enableDocker = true;
      }) != [ ];
    rejectsDomainBypass =
      failed (darwin {
        network = {
          enable = true;
          domains.enable = true;
          allowedNetworks = [ { cidr = "0.0.0.0/0"; } ];
        };
      }) != [ ];
    rejectsMissingImage =
      failed (darwin {
        network = {
          enable = true;
          image = null;
        };
      }) != [ ];
    rejectsPodman =
      builtins.any (a: !a.assertion && contains "Docker backend" a.message)
        (linuxWithBackend "podman" { network.enable = true; }).assertions;
  };
in
assert lib.assertMsg (builtins.all (value: value) (builtins.attrValues checks)) (
  builtins.toJSON checks
);
if scriptsOnly then
  {
    darwinRestricted = darwinScript;
    darwinDefault = (builtins.head openDarwin.environment.systemPackages).text;
    linuxRestricted = closedLinux.systemd.services.docker-agentbox.script;
    networkRuntime =
      (import ../modules/network-runtime.nix {
        cfg = closedDarwin.services.agentbox;
        pkgs = darwinPkgs;
        inherit lib;
      }).text;
  }
else
  checks
