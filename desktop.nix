{
  lib,
  buildEnv,
  writeShellScriptBin,
  bashInteractive,
  coreutils,
  util-linux,
  chromium,
  xorg-server,
  xauth,
  xdpyinfo,
  openbox,
  xdotool,
  scrot,
  dbus,
  x11vnc,
  novnc,
  python3Packages,
  fontconfig,
  makeFontsConf,
  dejavu_fonts,
  liberation_ttf,
  noto-fonts-color-emoji,
}:
let
  websockify = python3Packages.websockify;
  fonts = [
    dejavu_fonts
    liberation_ttf
    noto-fonts-color-emoji
  ];
  fontConfig = makeFontsConf { fontDirectories = fonts; };
  tools = [
    bashInteractive
    coreutils
    util-linux
    xorg-server
    xauth
    xdpyinfo
    openbox
    xdotool
    scrot
    dbus
    x11vnc
    websockify
    fontconfig
  ];
  launcher = writeShellScriptBin "agentbox-desktop" ''
    export PATH=${lib.makeBinPath tools}:"$PATH"
    export AGENTBOX_DESKTOP_NOVNC=${novnc}/share/webapps/novnc
    export AGENTBOX_DESKTOP_DBUS_CONFIG=${dbus}/share/dbus-1/session.conf
    export FONTCONFIG_FILE=${fontConfig}
    ${builtins.readFile ./scripts/agentbox-desktop.sh}
  '';
  browser = writeShellScriptBin "chromium" ''
    export FONTCONFIG_FILE=${fontConfig}
    # Require the namespace sandbox, not a privileged helper in the Nix store.
    # This leaves seccomp enabled and fails closed if user namespaces are denied.
    exec ${chromium}/bin/chromium --disable-setuid-sandbox "$@"
  '';
in
buildEnv {
  name = "agentbox-desktop";
  paths =
    tools
    ++ fonts
    ++ [
      launcher
      browser
      novnc
    ];
  meta.platforms = lib.platforms.linux;
}
