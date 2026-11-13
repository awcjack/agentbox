{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  nodejs_22,
}:

# Keep messaging available offline, with the same reviewed source in every
# session. Pi resolves the extension's peer imports through its own loader.
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pi-post";
  version = "0.8.1";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-post/-/pi-post-${finalAttrs.version}.tgz";
    hash = "sha256-QHSW/xAHE1hMOpw2i3K3MBTRvTWfHFaJdAgW4ieFvkY=";
  };

  nativeBuildInputs = [ makeWrapper ];
  patches = [
    ./patches/pi-post-session-roots.patch
    ./patches/pi-post-archived-sessions.patch
    ./patches/pi-post-message-rate-limit.patch
    ./patches/pi-post-broker.patch
  ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-post $out/bin
    cp -R extensions src bin package.json LICENSE $out/share/pi-post/
    mkdir -p $out/share/pi-post/rpc-runtime
    cp ${./extensions/pi-post-broker.ts} $out/share/pi-post/extensions/pi-post-broker.ts
    cp ${./rpc-runtime/post-client.mjs} $out/share/pi-post/rpc-runtime/post-client.mjs
    cp ${./rpc-runtime/post-cli.mjs} $out/share/pi-post/rpc-runtime/post-cli.mjs
    makeWrapper ${nodejs_22}/bin/node $out/bin/pi-post \
      --add-flags $out/share/pi-post/bin/pi-post.mjs
    runHook postInstall
  '';

  passthru.extension = "${finalAttrs.finalPackage}/share/pi-post/extensions/pi-post.ts";

  meta = {
    description = "Messages between Pi sessions, delivered live or queued until resume";
    homepage = "https://github.com/vieko/pi-post";
    license = lib.licenses.mit;
    mainProgram = "pi-post";
    platforms = lib.platforms.unix;
  };
})
