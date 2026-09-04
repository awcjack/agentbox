{
  lib,
  buildNpmPackage,
  nodejs_22,
}:

buildNpmPackage {
  pname = "pi-agentbox-mcp-runtime";
  version = "1.0.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: _type: baseNameOf path != "node_modules";
  };
  nodejs = nodejs_22;
  npmDepsHash = "sha256-7jnFnlxOnb/21ARb0lavJybJ5EYtVM28bdk60dIjdTQ=";

  dontNpmBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/pi-agentbox-mcp-runtime
    cp pi-mcp.mjs package.json package-lock.json $out/lib/pi-agentbox-mcp-runtime/
    cp -r node_modules $out/lib/pi-agentbox-mcp-runtime/
    runHook postInstall
  '';

  meta = {
    description = "Managed MCP client runtime extension for Pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
