# Shared host-side lifecycle for NixOS and Darwin. The helper image always runs
# on the Docker Linux host/VM, so firewall behavior is independent of macOS PF.
{
  cfg,
  pkgs,
  lib,
}:
let
  net = cfg.settings.network;
  policy = pkgs.writeText "agentbox-network-policy.json" (
    builtins.toJSON (
      builtins.removeAttrs net [
        "image"
        "enable"
      ]
    )
  );
  fingerprint = builtins.hashString "sha256" (
    builtins.toJSON {
      policy = toString policy;
      image = toString net.image;
      runtime = builtins.readFile ../scripts/network-host.py;
    }
  );
in
pkgs.writeShellScript "agentbox-network" ''
  export PATH=${lib.makeBinPath [ pkgs.docker-client ]}:$PATH
  exec ${pkgs.python3}/bin/python3 ${../scripts/network-host.py} \
    --policy ${policy} --image ${net.image} --fingerprint ${fingerprint} \
    --validator ${../scripts/network-policy.py} \
    --environment-file ${lib.escapeShellArg "${cfg.dataDir}/network.env"} "$@"
''
