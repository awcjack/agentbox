{
  lib,
  rustPlatform,
  fetchFromGitHub,
  python3,
  runCommand,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "agent-browser";
  version = "0.41.2";

  src = fetchFromGitHub {
    owner = "vercel-labs";
    repo = "agent-browser";
    rev = "71850a021c5cb694513d720d61c156dd317d63cf";
    hash = "sha256-oK+D7R+jxR2gZ9CvwqiGJB5rUDA1sDON1AzpdCbi9ho=";
  };
  cargoRoot = "cli";
  buildAndTestSubdir = "cli";
  cargoHash = "sha256-6dErTb3vmByBMtKb0CrK8aCWZZOMMD/Nx+EJedJVqQY=";

  patches = [
    ./patches/agent-browser-preserve-sandbox.patch
    ./patches/agent-browser-no-auto-stream.patch
    ./patches/agent-browser-implicit-launch-policy.patch
  ];

  nativeBuildInputs = [ python3 ];
  postPatch = ''
    python3 ${./tests/agent-browser-safety.py} --source .
  '';

  # Cargo writes cache/lock metadata even for offline, vendored builds. The
  # in-container daemon builds unsandboxed as root, so its default HOME would
  # create /homeless-shelter and block all subsequent Nix builds. Keep Cargo's
  # writable state inside this build's temporary directory instead.
  preConfigure = ''
    export CARGO_HOME="$TMPDIR/cargo-home"
    mkdir -p "$CARGO_HOME"
  '';

  # Phase 1 is the native Rust CLI/daemon only: no Node/npm runtime, browser
  # download, or dashboard build. Upstream build.rs embeds its "Dashboard not
  # built" placeholder. Dashboard/stream exposure is not part of this package's
  # managed headless integration. The wrapper must set AGENT_BROWSER_NO_STREAM=1.
  # Keep upstream's filesystem-discovered skills and references in the immutable
  # package root, where the CLI finds them relative to its executable.
  postInstall = ''
    cp -r skill-data skills "$out/"
    install -Dm644 LICENSE "$out/share/licenses/agent-browser/LICENSE"
    mkdir -p "$out/share/doc/agent-browser"
    printf '%s\n' \
      'Native CLI build; dashboard assets are intentionally absent (placeholder only).' \
      'Skills and references are bundled; no npm installation is needed.' \
      'Managed headless callers must set AGENT_BROWSER_NO_STREAM=1.' \
      > "$out/share/doc/agent-browser/agentbox-packaging.txt"
  '';

  # Upstream's full suite includes live browser/network tests. Use focused
  # offline source checks above and installed CLI/daemon smoke tests instead.
  doCheck = false;
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$CARGO_HOME" = "$TMPDIR/cargo-home"
    test -d "$CARGO_HOME"
    python3 ${./tests/agent-browser-safety.py} --binary "$out/bin/agent-browser"
    runHook postInstallCheck
  '';

  passthru.tests.safety =
    runCommand "agent-browser-safety-test" { nativeBuildInputs = [ python3 ]; }
      ''
        python3 ${./tests/agent-browser-safety.py} --binary ${finalAttrs.finalPackage}/bin/agent-browser
        touch "$out"
      '';

  meta = {
    description = "Pinned native browser automation CLI with sandbox-preserving Agentbox patches (no dashboard)";
    homepage = "https://github.com/vercel-labs/agent-browser";
    license = lib.licenses.asl20;
    mainProgram = "agent-browser";
    platforms = lib.platforms.linux;
  };
})
