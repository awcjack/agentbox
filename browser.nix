{
  lib,
  buildEnv,
  writeShellScriptBin,
  runCommand,
  python3,
  chromium,
  fontconfig,
  makeFontsConf,
  dejavu_fonts,
  liberation_ttf,
  noto-fonts-color-emoji,
}:
let
  fonts = [
    dejavu_fonts
    liberation_ttf
    noto-fonts-color-emoji
  ];
  fontConfig = makeFontsConf { fontDirectories = fonts; };
  # No X server, desktop session, VNC, or privileged sandbox helper. Chromium
  # must create its namespace sandbox or fail; never retry with --no-sandbox.
  mkLauncher =
    browser:
    writeShellScriptBin "agentbox-browser-chromium" ''
      for arg in "$@"; do
        case "$arg" in
          --*) switch="''${arg#--}" ;;
          -*) switch="''${arg#-}" ;;
          *) continue ;;
        esac
        case "''${switch%%=*}" in
          no-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox|disable-gpu-sandbox|single-process|no-zygote)
            printf '%s\n' "agentbox-browser-chromium: refusing sandbox-disabling argument: $arg" >&2
            exit 64
            ;;
        esac
      done
      export FONTCONFIG_FILE=${fontConfig}
      exec ${browser}/bin/chromium --headless=new --disable-setuid-sandbox "$@"
    '';
  launcher = mkLauncher chromium;
  # Use the identical launcher with a fake Chromium to test argument handling
  # without needing user namespaces or an actual browser in the Nix builder.
  fakeChromium = writeShellScriptBin "chromium" ''
    exec ${python3}/bin/python3 -c 'import json, os, sys; print(json.dumps({"args": sys.argv[1:], "fontconfig": os.environ["FONTCONFIG_FILE"]}))' "$@"
  '';
in
buildEnv {
  name = "agentbox-browser";
  paths = [
    launcher
    fontconfig
  ]
  ++ fonts;
  passthru.tests.wrapper =
    runCommand "agentbox-browser-wrapper-test" { nativeBuildInputs = [ python3 ]; }
      ''
        python3 ${./tests/agent-browser-wrapper.py} ${mkLauncher fakeChromium}/bin/agentbox-browser-chromium
        touch "$out"
      '';
  meta = {
    description = "Headless Chromium with fonts and mandatory namespace sandbox, independent of the desktop";
    platforms = lib.platforms.linux;
    mainProgram = "agentbox-browser-chromium";
  };
}
