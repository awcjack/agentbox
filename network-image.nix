{ pkgs }:
let
  entrypoint = pkgs.writeScript "agentbox-network-entrypoint" ''
    #!${pkgs.python3}/bin/python3
    ${builtins.readFile ./scripts/network-policy.py}
  '';
in
pkgs.dockerTools.buildLayeredImage {
  name = "agentbox-network";
  tag = "latest";
  contents = [
    pkgs.python3
    pkgs.iptables
    pkgs.squid
    pkgs.coreutils
    pkgs.bash
  ];
  extraCommands = ''
    mkdir -p etc tmp run var/log var/cache
    chmod 1777 tmp
    echo 'root:x:0:0:root:/root:/bin/false' > etc/passwd
    echo 'nobody:x:65534:65534:nobody:/tmp:/bin/false' >> etc/passwd
    echo 'root:x:0:' > etc/group
    echo 'nobody:x:65534:' >> etc/group
  '';
  config = {
    Entrypoint = [ "${entrypoint}" ];
    Env = [ "PATH=/bin:/sbin" ];
  };
}
