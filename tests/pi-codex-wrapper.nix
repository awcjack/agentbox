{ pkgs }:
let
  inherit (pkgs) lib;
  fakePi = pkgs.writeShellScriptBin "pi" ''
    printf '%s\n' "$@"
  '';
  expression = import ../image.nix;
  # Evaluate/build only the actual image wrapper and its immutable extensions.
  image = expression (
    lib.mapAttrs (_: _: "/unused") (
      lib.filterAttrs (_: default: !default) (builtins.functionArgs expression)
    )
    // {
      inherit lib;
      inherit (pkgs) coreutils runCommand;
      pi-coding-agent = fakePi;
      dockerTools.buildLayeredImageWithNixDb = args: args;
      buildEnv = args: lib.findFirst (path: lib.isDerivation path && path.name == "pi") null args.paths;
      writeShellScriptBin =
        name: text: if name == "pi" then pkgs.writeShellScriptBin name text else "/unused";
    }
  );
  wrapper = builtins.head image.contents;
in
pkgs.runCommand "pi-codex-wrapper-test" { } ''
  mapfile -t args < <(${wrapper}/bin/pi --mode rpc)
  test "''${args[0]}" = --no-extensions
  test "''${args[7]}" = -e
  test "''${args[8]##*/}" = pi-codex-accounts.ts
  test -f "''${args[8]}"
  test "''${args[10]##*/}" = pi-policy.ts
  test "''${args[11]}" = --mode
  test "''${args[12]}" = rpc
  for flag in -e -e/tmp/untrusted.ts --extension --extension=/tmp/untrusted.ts; do
    status=0
    ${wrapper}/bin/pi "$flag" >/dev/null 2>&1 || status=$?
    test "$status" = 2
  done
  test "$(${wrapper}/bin/pi auth)" = auth
  touch $out
''
