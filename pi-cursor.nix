{
  lib,
  stdenvNoCC,
  fetchurl,
}:

let
  # The published extension already contains its compiled JS. Its only runtime
  # dependency has no dependencies of its own; fetch both archives explicitly
  # instead of resolving or installing npm packages at container startup.
  protobufSrc = fetchurl {
    url = "https://registry.npmjs.org/@bufbuild/protobuf/-/protobuf-2.13.0.tgz";
    hash = "sha256-TrmWgBq8TBBa0uKTLaXxE0CRSPgLciF+Wcec2oDrux4=";
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pi-cursor";
  version = "1.4.39";

  src = fetchurl {
    url = "https://registry.npmjs.org/@rahularya01/pi-cursor/-/pi-cursor-${finalAttrs.version}.tgz";
    hash = "sha256-lSplVj8sIvOz5zsRRMRGZWDXRNZM3o1voSbZ4UW51ak=";
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-cursor/node_modules/@bufbuild/protobuf
    cp -R dist package.json LICENSE README.md $out/share/pi-cursor/
    tar -xzf ${protobufSrc} --strip-components=1 \
      -C $out/share/pi-cursor/node_modules/@bufbuild/protobuf
    runHook postInstall
  '';

  # Pi supplies peer imports through its own extension loader, keeping the
  # provider on the same Pi runtime and API registry as the other extensions.
  passthru.extension = "${finalAttrs.finalPackage}/share/pi-cursor/dist/index.js";

  meta = {
    description = "Unofficial Cursor subscription provider for Pi Coding Agent";
    homepage = "https://github.com/Rahularya01/pi-cursor";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
