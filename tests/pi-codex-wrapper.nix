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
      agentbox-pi-goal-runtime = pkgs.callPackage ../goal-runtime { };
      dockerTools.buildLayeredImageWithNixDb = args: args;
      buildEnv = args: lib.findFirst (path: lib.isDerivation path && path.name == "pi") null args.paths;
      writeShellScriptBin =
        name: text: if name == "pi" then pkgs.writeShellScriptBin name text else "/unused";
    }
  );
  wrapper = builtins.head image.contents;
in
pkgs.runCommand "pi-codex-wrapper-test" { } ''
  unset PI_WORKFLOW_CHILD PI_WORKFLOW_APPROVAL_VERSION
  mapfile -t args < <(${wrapper}/bin/pi --mode rpc)
  test "''${args[0]}" = --no-extensions
  test "''${args[7]}" = -e
  test "''${args[8]##*/}" = pi-codex-accounts.ts
  test -f "''${args[8]}"
  test "''${args[9]}" = -e
  test "''${args[10]##*/}" = pi-openai-fast.ts
  test -f "''${args[10]}"
  test "''${args[11]}" = -e
  case "''${args[12]}" in
    /nix/store/*/lib/agentbox-pi-goal-runtime/node_modules/@narumitw/pi-goal/dist/index.ts) ;;
    *) exit 1 ;;
  esac
  test -f "''${args[12]}"
  test "''${args[13]}" = -e
  test "''${args[14]##*/}" = pi-policy.ts
  test "''${args[15]}" = --mode
  test "''${args[16]}" = rpc
  # A child must never register Goal or widen its role's active tool set.
  for childEnv in PI_WORKFLOW_CHILD=1 PI_WORKFLOW_APPROVAL_VERSION=1 PI_WORKFLOW_APPROVAL_VERSION=; do
    mapfile -t childArgs < <(env "$childEnv" ${wrapper}/bin/pi --mode json)
    test "''${#childArgs[@]}" = 15
    test "''${childArgs[10]##*/}" = pi-openai-fast.ts
    test "''${childArgs[12]##*/}" = pi-policy.ts
    test "''${childArgs[13]}" = --mode
    test "''${childArgs[14]}" = json
  done
  for flag in -e -e/tmp/untrusted.ts --extension --extension=/tmp/untrusted.ts; do
    status=0
    ${wrapper}/bin/pi "$flag" >/dev/null 2>&1 || status=$?
    test "$status" = 2
  done
  test "$(${wrapper}/bin/pi auth)" = auth
  touch $out
''
