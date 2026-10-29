{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.agentbox;
  net = cfg.settings.network;
  rule = lib.types.submodule {
    options = {
      cidr = lib.mkOption {
        type = lib.types.str;
        example = "10.0.0.0/8";
        description = "IPv4 or IPv6 address/subnet. Validated before any container starts.";
      };
      protocol = lib.mkOption {
        type = lib.types.enum [
          "all"
          "tcp"
          "udp"
        ];
        default = "all";
      };
      ports = lib.mkOption {
        type = lib.types.listOf lib.types.port;
        default = [ ];
        description = "Destination ports; empty means all ports. Requires tcp or udp.";
      };
    };
  };
  domain = lib.types.strMatching "\\.?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?";
in
{
  options.services.agentbox.settings.network = {
    enable = lib.mkEnableOption "externally enforced agentbox outbound network policy";
    image = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if pkgs.stdenv.hostPlatform.isLinux then pkgs.agentboxNetworkImage else null;
      defaultText = lib.literalExpression "pkgs.agentboxNetworkImage";
      description = "Linux-built helper image tarball. Set explicitly on Darwin.";
    };
    defaultAction = lib.mkOption {
      type = lib.types.enum [
        "allow"
        "deny"
      ];
      default = "allow";
      description = "Action for outbound traffic unmatched by a rule. Denies take precedence.";
    };
    allowedNetworks = lib.mkOption {
      type = lib.types.listOf rule;
      default = [ ];
    };
    deniedNetworks = lib.mkOption {
      type = lib.types.listOf rule;
      default = [ ];
    };
    dnsServers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "1.1.1.1" ];
      description = "Literal resolver IPs. DNS TCP/UDP 53 is allowed unless denied by a network rule. With domain filtering only the proxy can reach DNS.";
    };
    publishedPorts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "127.0.0.1:4096:4096"
        "127.0.0.1:4097:4097"
      ];
      description = "Docker publish specifications for ingress. Restricted mode publishes these on the network companion instead of using host networking.";
    };
    domains = {
      enable = lib.mkEnableOption "mandatory HTTP/HTTPS proxy with domain filtering";
      defaultAction = lib.mkOption {
        type = lib.types.enum [
          "allow"
          "deny"
        ];
        default = "deny";
      };
      allowed = lib.mkOption {
        type = lib.types.listOf domain;
        default = [ ];
        example = [
          ".github.com"
          "registry.npmjs.org"
        ];
        description = "Exact domains, or a leading dot for the domain and all subdomains. Denies take precedence.";
      };
      denied = lib.mkOption {
        type = lib.types.listOf domain;
        default = [ ];
      };
    };
  };

  config = lib.mkIf (cfg.enable && net.enable) {
    assertions = [
      {
        assertion = net.image != null;
        message = "Agentbox network policies require a Linux-built settings.network.image tarball (build .#agentboxNetworkImage).";
      }
      {
        assertion = !cfg.settings.enableDocker;
        message = "Agentbox network policies are incompatible with privileged enableDocker.";
      }
      {
        assertion = !net.domains.enable || net.allowedNetworks == [ ];
        message = "Agentbox domain filtering cannot be combined with direct allowedNetworks (which would bypass the proxy).";
      }
      {
        assertion = builtins.all (r: r.ports == [ ] || r.protocol != "all") (
          net.allowedNetworks ++ net.deniedNetworks
        );
        message = "Agentbox network rules with ports must specify tcp or udp.";
      }
      {
        assertion =
          !net.domains.enable
          || builtins.all (name: !(builtins.hasAttr name cfg.extraEnvironment)) [
            "HTTP_PROXY"
            "HTTPS_PROXY"
            "http_proxy"
            "https_proxy"
            "NO_PROXY"
            "no_proxy"
          ];
        message = "Agentbox domain filtering owns proxy variables; remove them from extraEnvironment.";
      }
    ];
  };
}
