{
  lib,
  stdenvNoCC,
  fetchurl,
}:

# Pin upstream pi-agentsmd by hash and force-load it from the immutable Pi
# wrapper. Strip install telemetry so the reviewed extension does not phone
# home; /init only injects a prompt and lets the model write AGENTS.md.
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pi-agentsmd";
  version = "0.2.1";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-agentsmd/-/pi-agentsmd-${finalAttrs.version}.tgz";
    hash = "sha256-e9R1Yt2Vdboqx7O2Dk+FGxw4BkcD7ZgM0Bzsy0NsfY0=";
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-agentsmd
    cp -R extensions prompts src package.json README.md LICENSE THIRD-PARTY-NOTICES $out/share/pi-agentsmd/
    rm -f $out/share/pi-agentsmd/src/install-telemetry.ts
    cat > $out/share/pi-agentsmd/extensions/index.ts <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleInitCommand } from "../src/init.js";

export default function piAgentsMd(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "create an AGENTS.md file with instructions for Pi",
    handler: async (args, ctx) => {
      await handleInitCommand(pi, args, ctx);
    },
  });
}
EOF
    cat > $out/share/pi-agentsmd/src/index.ts <<'EOF'
export { handleInitCommand } from "./init.js";
export { FORCE_INIT_PROMPT, INIT_PROMPT } from "./prompt.js";
EOF
    runHook postInstall
  '';

  passthru.extension = "${finalAttrs.finalPackage}/share/pi-agentsmd/extensions/index.ts";

  meta = {
    description = "Generate AGENTS.md contributor guides for Pi repositories";
    homepage = "https://github.com/jvm/pi-mono/tree/main/packages/pi-agentsmd";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
