# Pi 1.5.2 upgrade verification

Run these commands from `agentbox/`, with Nix's `nix-command` and `flakes`
features enabled. They build/evaluate only; none activates a host or starts a
container. `path:.` includes untracked local source files, unlike a Git-backed
flake reference.

Only the Pi-specific `nixpkgs-unstable` input changed, to
`04906337b6d53e8bb0eaf0470ae9f070a4d4eb55`. The base nixpkgs and OpenCode pins
are unchanged. Since unstable has dropped Intel macOS, `x86_64-darwin` builds
that same upstream Pi recipe with Agentbox's existing 26.05 package set. Other
platforms use unstable's Pi package directly. Pi keeps Agentbox's startup
registration barrier and RPC model refresh patches; the upstream model catalogs
replace the old OpenAI backport.

## Evaluate and build Pi

The full-flake check is for Linux. On macOS, skip that line: the unrelated host
CLI currently declares Linux-only platform metadata. The Pi derivation evaluates
on all four advertised systems, including Intel macOS through the fallback above.

```sh
nix eval --raw 'path:.#pi-coding-agent.version' --no-update-lock-file
# Expected: 1.5.2
nix flake check path:. --no-build --no-update-lock-file  # Linux

nix build 'path:.#pi-coding-agent' --out-link result-pi-1.5.2 \
  --print-build-logs --no-update-lock-file
./result-pi-1.5.2/bin/pi --version
```

## Extension and runtime checks

These use the packaged, patched Pi where the test needs upstream integration.
The Codex check includes the deterministic startup-refresh barrier and real,
offline RPC restoration/catalog-refresh regressions. No live credentials or
model calls are needed.

```sh
nix build \
  'path:.#pi-codex-accounts-test' \
  'path:.#pi-policy-extension-test' \
  'path:.#pi-workflow-extension-test' \
  'path:.#pi-agentbox-extension-test' \
  'path:.#pi-browser-extension-test' \
  'path:.#pi-post-test' \
  'path:.#pi-cursor-test' \
  'path:.#pi-goal-extension-test' \
  'path:.#pi-agentsmd-test' \
  'path:.#pi-codex-wrapper-test' \
  'path:.#pi-lsp-client-test' \
  'path:.#pi-mcp-runtime-test' \
  'path:.#pi-agentbox-mcp-runtime' \
  'path:.#pi-rpc-runtime-test' \
  'path:.#pi-rpc-workspace-test' \
  'path:.#agentbox-pi-rpc-runtime' \
  --no-link --print-build-logs --no-update-lock-file
```

The ordinary RPC runtime suite skips its two opt-in real-Pi tests. Run them
explicitly from the repository, using the immutable executable built above and
Node 22 from the pinned base nixpkgs:

```sh
pi_package="$(nix build 'path:.#pi-coding-agent' --no-link --print-out-paths --no-update-lock-file)"
nix shell --inputs-from path:. nixpkgs#nodejs_22 --command env \
  PI_CONVERSATION_TEST_EXECUTABLE="$pi_package/bin/pi" \
  PI_DEFAULT_MODEL_TEST_EXECUTABLE="$pi_package/bin/pi" \
  node --test \
    rpc-runtime/test/conversation-pi.test.mjs \
    rpc-runtime/test/default-model-pi.test.mjs
```

These tests create isolated settings, fake credentials and session fixtures.
Both real-Pi tests should run, not be reported as skipped. They cover conversation
fork/revert, compaction, empty context and saved model defaults. A temporary npm
executable cannot substitute here: the supervisor requires an immutable Nix-store
executable.

## Build the image (Linux only)

```sh
nix build 'path:.#agentboxImage' --out-link result-pi-upgrade-image \
  --print-build-logs --no-update-lock-file
```

On macOS, run the portable checks locally and build the image on a Linux machine
or configured Linux builder. Build success does not load, deploy or activate the
image. Existing Pi processes still use their old executable until restarted.

`nix-config/` consumes a separately pinned GitHub Agentbox input, not this sibling
checkout. These commands verify local Agentbox only; updating/deploying that
consumer is a separate step.
