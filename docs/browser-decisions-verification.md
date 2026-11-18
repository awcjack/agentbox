# Bounded browser Decisions: local verification

This change is in the **local `agentbox` repository only**. It does not update
`nix-config`'s pinned Agentbox input, configure a real API key, deploy an image,
recreate a container, or activate a host.

The request/response contract was checked against OpenAI's public
[Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and
[create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create):
`POST /v1/decisions`, `gpt-6-luna`, a named `choice` question, typed answers,
confidence, refusals, and token/cache usage. All HTTP tests use synthetic keys
and mocked responses. No live OpenAI request or latency benchmark was performed.

## Passed

From `agentbox/`, with Node 22.23.2:

```sh
node --experimental-strip-types --test tests/pi-browser.ts tests/browser-decisions.ts
# 118 tests passed

node --experimental-strip-types tests/pi-policy.ts
# Policy script passed, including nested authorization/Auto/review/cancellation.

node tests/pi-browser-loader.mjs \
  /nix/store/40anlx9m0sza9m1r41hapwc1qh43qvs7-pi-coding-agent-0.87.1/lib/node_modules/pi-monorepo
# Actual installed-Pi loader and tool-schema validation passed.

node --test rpc-runtime/browser-config.test.mjs \
  rpc-runtime/test/browser-channel.test.mjs rpc-runtime/web/browser-result.test.mjs
# 22 tests passed

node --test rpc-runtime/test/runtime.test.mjs
# 114 tests passed

nix --extra-experimental-features 'nix-command flakes' flake check path:. \
  --no-build --no-update-lock-file
# Evaluation passed for x86_64-linux; incompatible systems omitted.

nixfmt --check modules/common-options.nix modules/nixos.nix modules/darwin.nix \
  tests/browser-module.nix packages.nix image.nix

git diff --check
```

The config implementation job also passed the standalone module expression for
Linux/Darwin and both browser presets:

```sh
nix-instantiate --eval --strict --json tests/browser-module.nix \
  --arg nixpkgs /nix/store/vlq3lnsh2xij0d9blab16pq0sr09z4nl-source
```

That run preceded the final alignment of the environment-variable-name limit to
128 characters. The parent rerun was blocked by managed policy; it is not claimed
as a complete final module assertion run. Final flake evaluation and formatting
checks did pass.

## Blocked / not established

```sh
nix --extra-experimental-features 'nix-command flakes' build \
  path:.#pi-browser-extension-test path:.#pi-policy-extension-test \
  --no-link --no-update-lock-file --print-build-logs
```

The local Nix builder could not execute its required store Bash
(`/nix/store/gik3rh1vz2jlgnifb9dh6vc6sxwwz9jj-bash-5.3p9/bin/bash` was unavailable).
These package builds are **not** reported as passing. The source suites above
were run directly instead. An earlier standalone policy package attempt hit the
same builder problem. `nix fmt` was also blocked in the config job by unavailable
private mount namespaces; the installed `nixfmt --check` succeeded afterward.

The following real Chromium fixture test was extended with an offline decision
chooser but could not be executed: managed policy blocked the invocation of the
managed executables. No sandbox restriction was weakened or bypassed.

```sh
node --experimental-strip-types tests/pi-browser-smoke.ts \
  /bin/agent-browser /bin/agentbox-browser-chromium
```

Consequently, native rendering/snapshot stability for the new loop, live API
access, account/model availability, cost and speedup remain unverified.
TypeScript LSP diagnostics also timed out; installed-Pi loading and Node execution
passed but are not a static type-check claim.
