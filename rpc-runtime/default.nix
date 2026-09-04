{
  lib,
  stdenvNoCC,
  makeWrapper,
  bash,
  coreutils,
  nodejs_22,
  pi-coding-agent ? null,
}:

stdenvNoCC.mkDerivation {
  pname = "agentbox-pi-rpc-runtime";
  version = "1.0.0";
  src = ./.;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  doCheck = true;

  checkPhase = ''
    runHook preCheck
    TEST_BASH=${bash}/bin/bash ${nodejs_22}/bin/node --test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/agentbox-pi-rpc-runtime $out/bin
    cp main.mjs runtime.mjs package.json supervise.sh $out/libexec/agentbox-pi-rpc-runtime/
    makeWrapper ${nodejs_22}/bin/node $out/bin/pi-rpc-runtime \
      --add-flags $out/libexec/agentbox-pi-rpc-runtime/main.mjs
    ${lib.optionalString (pi-coding-agent != null) ''
      wrapProgram $out/bin/pi-rpc-runtime \
        --prefix PATH : ${lib.makeBinPath [ pi-coding-agent ]}
    ''}
    makeWrapper ${bash}/bin/bash $out/bin/pi-rpc-runtime-supervise \
      --add-flags $out/libexec/agentbox-pi-rpc-runtime/supervise.sh \
      --set PI_RPC_RUNTIME_EXECUTABLE $out/bin/pi-rpc-runtime \
      --prefix PATH : ${lib.makeBinPath [ coreutils ]}
    runHook postInstall
  '';

  meta = {
    description = "Authenticated HTTP/SSE supervisor for Pi RPC sessions";
    license = lib.licenses.mit;
    mainProgram = "pi-rpc-runtime";
    platforms = lib.platforms.unix;
  };
}
