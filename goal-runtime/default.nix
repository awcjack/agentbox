{
  lib,
  buildNpmPackage,
  nodejs_22,
}:

buildNpmPackage {
  pname = "agentbox-pi-goal-runtime";
  version = "1.0.0";
  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: _type: baseNameOf path != "node_modules";
  };
  nodejs = nodejs_22;
  npmDepsHash = "sha256-ccT5bpqIaD5rNobSuF7G+5GEbJjILM/XzivJbPEtgBQ=";
  # Pi's Jiti loader supplies the Pi/typebox peers. Do not install another Pi
  # or execute dependency lifecycle scripts. Published dist/ is authoritative.
  npmFlags = [
    "--legacy-peer-deps"
    "--ignore-scripts"
  ];
  dontNpmBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/agentbox-pi-goal-runtime
    cp package.json package-lock.json $out/lib/agentbox-pi-goal-runtime/
    cp -r node_modules $out/lib/agentbox-pi-goal-runtime/
    runHook postInstall
  '';
  meta = {
    description = "Pinned upstream pi-goal and TUI dependencies for managed Pi";
    homepage = "https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
