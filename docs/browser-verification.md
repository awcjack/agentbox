# Browser implementation — local verification

Scope: local `agentbox/` checkout only. No `nix-config` change, pinned-consumer
verification, host activation, deployment, or container recreation was performed.
Native agent-browser is pinned to `71850a021c5cb694513d720d61c156dd317d63cf`
(v0.41.2). Direct Node tests used v22.23.2; Nix checks use pinned Node 22.

## Opt-in browser seccomp profile — built and policy-tested

The operator subsequently ran the extended smoke with the production wrapper.
Chromium exited during `owner open` with `No usable sandbox!`, before Phase 2
assertions. Their ordinary non-root host user could create a user namespace;
the container's non-root agent could not. Docker reported no explicit security
options, no AppArmor profile, no added capabilities and no privileged mode. This
is consistent with the default Docker seccomp restriction, not evidence of a
browser-tool failure or a need to disable Chromium's sandbox.

Implemented in `agentbox/` only:

- Explicit `settings.hardening.seccompProfile = "browser"` on NixOS/Darwin;
  the default remains `"default"`, including when browser tools are enabled.
- Pinned Moby seccomp/v0.2.3 baseline plus six exact-argument rules; source hash
  and semantic equality against upstream were verified. Full provenance and
  capability/architecture assumptions: [security/seccomp](../security/seccomp/README.md).
- Package `agentbox-browser-seccomp`, explicit SYS_ADMIN drop, privileged-mode
  and non-Docker-backend rejection, and CI triggers/tests for policy-only changes.

Focused checks executed from `agentbox/`:

```sh
nix build path:.#agentbox-browser-seccomp path:.#browser-seccomp-test \
  path:.#network-policy-test path:.#agentbox-browser.tests.wrapper \
  --no-link --no-update-lock-file --print-build-logs
nix-instantiate --eval --strict --json tests/browser-module.nix \
  --arg nixpkgs /nix/store/vlq3lnsh2xij0d9blab16pq0sr09z4nl-source
nix-instantiate --eval --strict --json tests/network-modules.nix \
  --arg nixpkgs /nix/store/vlq3lnsh2xij0d9blab16pq0sr09z4nl-source
nix flake check path:. --no-build --no-update-lock-file
nix fmt --no-update-lock-file -- --check browser-seccomp.nix \
  security/seccomp/browser.nix packages.nix modules/common-options.nix \
  modules/nixos.nix modules/darwin.nix tests/browser-module.nix
git diff --check
```

Passed: **12 seccomp policy tests**, **80 browser/module/image assertions**,
**18 network-module assertions**, **12 network policy tests**, the Chromium
wrapper target, flake evaluation and formatting. The seccomp tests exhaustively
exercise namespace-bit combinations, added flags and exit signals against a
strict offline policy model; they also prove the existing baseline and all other
rules are unchanged. They do not execute the permitted syscalls or validate a
running Docker filter. Independent review caught missing CI path triggers; these
were added for both push and pull-request workflows.

The profile package's derivation also evaluated for aarch64-linux,
x86_64-darwin and aarch64-darwin; only x86_64-linux was built locally.
Generated JSON file:
`/nix/store/x70g5ljfvknxf4avswj3s15jqq7gmp8g-agentbox-browser-seccomp.json`.

No consuming `nix-config` changes, container recreation, Docker execution, host
sysctl/LSM changes, or live security-policy replacement were performed. The
running container still has its original policy. **Sandboxed Chromium and Phase 2
live acceptance remain outstanding** until an authorized rollout applies the
profile and the full smoke/UI tests pass. The preset intentionally does not allow
combined user+network `unshare` or bubblewrap mount namespaces.

## Phase 2 first increment — implemented and package-verified

Main-tab JPEG/ref preview, expiring explicit human takeover, private fd3 transport,
HTTP authorization/profile/native-session checks, delegated-family arbitration,
and UI lifecycle cleanup are implemented. This section supersedes the historical
Phase 1 counts below; it does **not** claim live Phase 2 or sandboxed acceptance.

Executed successfully from `agentbox/`:

```sh
node --experimental-strip-types --test tests/pi-browser.ts
nix build path:.#pi-browser-extension-test path:.#pi-browser-native-test \
  path:.#pi-workflow-extension-test path:.#pi-policy-extension-test \
  path:.#pi-codex-wrapper-test path:.#pi-mcp-runtime-test \
  path:.#pi-rpc-runtime-test path:.#pi-rpc-workspace-test \
  --no-link --no-update-lock-file --max-jobs 2 --cores 2 --print-build-logs
nix build path:.#agent-browser.tests.safety path:.#agentbox-browser \
  path:.#agentbox-browser.tests.wrapper --no-link --no-update-lock-file \
  --max-jobs 2 --cores 2 --print-build-logs
nix-instantiate --eval --strict --json tests/browser-module.nix \
  --arg nixpkgs /nix/store/vlq3lnsh2xij0d9blab16pq0sr09z4nl-source
nix flake check path:. --no-build --no-update-lock-file
```

- **69 extension tests passed**, plus actual installed-Pi loading/schema checks.
- **307 full RPC tests passed, 4 skipped**: two opt-in installed-Pi compatibility
  fixtures, a non-Linux refusal assertion on Linux, and real bubblewrap integration
  because this container denies its user namespaces. Real Node child duplex fd3
  and EOF cancellation tests passed; this is not a successful bubblewrap run.
- **141 workspace tests plus 4 focused session/folder checks passed**.
- **51 Linux/Darwin/image module assertions passed**, including new browser scopes.
- Workflow/approval, policy/defaults, immutable wrappers, MCP and native safety
  package targets passed (unchanged targets may reuse verified Nix outputs).
- Formatting, source syntax checks and `git diff --check` passed. Flake evaluation
  was on x86_64-linux; incompatible system outputs were not built. LSP diagnostics
  timed out, so executable tests/builds—not LSP—provide the verification above.

Review found and corrected several non-mock assumptions:

1. Upstream policy omitted `launch` for implicit startup. The new actual-CLI
   regression failed against the old binary, then passed after the narrow
   `agent-browser-implicit-launch-policy.patch`. Tests cover local and CDP startup
   denial under control policy and restoring the model policy.
2. Killing the CLI does not cancel daemon-side work. The extension journals
   commands under the family lock and quarantines survivors until exact daemon/
   tab cleanup succeeds, including simulated process-loss and cleanup-failure tests.
3. Lease expiry is rechecked after awaited inventory. New snapshots invalidate
   older frames to prevent stale @eN references addressing newly rebound elements.
4. Presentation-only preview failures preserve a healthy browser. Permanent
   channel timeout instead stops UI polling with explicit process-restart guidance.

Updated native CLI:
`/nix/store/yssvasp4mhvim8sbzdgdfb48j011mwrl-agent-browser-0.41.2`.

The browser-enabled image was rebuilt with the command in the image section:
`/nix/store/2vy190bslp2bh8rvzjzwkwsz51vls3ls-agentbox.tar.gz`.
It includes the updated CLI, extension/channel and packaged RPC frontend/runtime.
It was **not loaded, deployed or activated**. `/homeless-shelter` remained absent.

`tests/pi-browser-smoke.ts` now also exercises real-daemon preview, takeover,
ref-based input/replay rejection, family blocking and release. The newly extended
smoke has been syntax-checked but **not run successfully**. A follow-up attempt
using the new CLI and production wrapper (with output redirected to a temporary
log) was blocked before execution by the managed shell guard:
`Agentbox policy blocks shell access to managed Pi integration files`.
This is a command-guard denial, not a new Chromium startup result; it was not
bypassed. The earlier known Chromium sandbox blocker remains unresolved. The
operator-run unsandboxed success was for Phase 1, not these new assertions. No
additional unsandboxed run was performed.

For live Phase 2 acceptance in a compatible container: run the extended smoke,
then use the RPC Browser pane with read-only/control tokens; verify takeover,
input, release, session switching, hidden pane/logout cleanup, and expiry. Do not
relax Chromium sandboxing or publish CDP to pass acceptance.

## Historical Phase 1 packaged checks — passed

The combined run before the follow-up browser corrections, from `agentbox/`,
completed successfully:

```sh
nix build path:.#pi-browser-extension-test path:.#pi-browser-native-test \
  path:.#pi-workflow-extension-test path:.#pi-policy-extension-test \
  path:.#pi-codex-wrapper-test path:.#agent-browser.tests.safety \
  path:.#agentbox-browser path:.#agentbox-browser.tests.wrapper \
  path:.#pi-mcp-runtime-test path:.#pi-rpc-runtime-test \
  path:.#pi-rpc-workspace-test --no-link --no-update-lock-file \
  --max-jobs 2 --cores 2 --print-build-logs
```

Results include:

- Browser extension: **26 passed** in the combined run; **31 passed** in the latest
  focused rerun after the fixture and allowlist-startup corrections below. Both
  runs also passed actual installed-Pi extension loading, tool registration, and
  argument validation. Tests cover ownership, killed-child
  cleanup, interrupted attachment, kernel-lock release after SIGKILL, expiry,
  private subprocess environments, screenshot bounds, and safe sandbox-error
  classification without reflecting sensitive output or unsafe upstream advice.
- Native CLI: actual config parsing, exact wire-action policy, literal fill data,
  and denied actions passed. This deliberately uses a nonexistent Chromium binary
  and does not claim real rendering coverage.
- Native safety: version, bundled skills/references, and no-stream daemon checks
  passed. CLI install checks also verified the build-local Cargo cache location.
- Chromium wrapper: **36 sandbox-bypass flag variants rejected**; intended flags,
  argv, and font configuration preserved.
- Workflow, approval, policy, persistent-default, Auto-session, and immutable Pi
  wrapper checks passed.
- MCP: **22 passed**.
- Full RPC runtime: **239 passed, 2 skipped**. The two existing installed-Pi
  compatibility tests are not enabled by this package recipe. The browser config
  checks are explicitly included in both full-runtime and workspace selections.
- Portable RPC workspace: **123 passed**, plus **4** focused session/folder tests.

Built outputs:

- Native CLI: `/nix/store/11pydh8nrgc65clrnkq4vzjim34mxj4a-agent-browser-0.41.2`
- Chromium/fonts wrapper: `/nix/store/fn3z5xw8gl8lrs9ca5dyi33h002v36mi-agentbox-browser`

## Browser-enabled image — built, not deployed

```sh
nix build --impure --expr \
  '(builtins.getFlake ("path:" + toString ./.)).packages.${builtins.currentSystem}.agentboxImage.override { withBrowser = true; }' \
  --no-link --no-update-lock-file --max-jobs 2 --cores 2 --print-out-paths
```

The image archive built at that point was:

`/nix/store/39pww3n70qnrk5kyy2l2v61b63p0b4k0-agentbox.tar.gz`

It was not loaded into Docker or used to replace the running container. It
predates the allowlist-startup correction below and has not been rebuilt in that
iteration. Building this archive does not prove runtime sandbox compatibility.

## Nix build-home failure — resolved

Earlier builds stopped because `/homeless-shelter` existed. Metadata inspection
found Cargo cache/lock files beneath `.cargo`, consistent with Cargo creating its
default home during the unsandboxed root build. The operator cleared the path.

`agent-browser.nix` now exports `CARGO_HOME="$TMPDIR/cargo-home"` before configure/
build, keeping offline Cargo metadata inside the build directory. The CLI was
rebuilt from source successfully; subsequent package and image builds completed.
`test ! -e /homeless-shelter` passed after both the Rust rebuild and final image
build. No live Nix configuration or Chromium sandbox settings were weakened.

## Live Chromium acceptance — still blocked

As the ordinary agent user in the existing container, this was attempted:

```sh
node --experimental-strip-types tests/pi-browser-smoke.ts \
  /nix/store/11pydh8nrgc65clrnkq4vzjim34mxj4a-agent-browser-0.41.2/bin/agent-browser \
  /nix/store/fn3z5xw8gl8lrs9ca5dyi33h002v36mi-agentbox-browser/bin/agentbox-browser-chromium
```

It failed during Chromium sandbox startup. The runner recognizes fixed upstream
sandbox/namespace failure diagnostics and reports:

```
Chromium sandbox startup was denied; the container needs compatible namespace/seccomp permissions.
Do not disable the browser sandbox. Use browser close before retrying.
```

The precise blocking kernel/container policy has not been established. Separate
shell probes were blocked by the managed privilege/managed-file policy; these
restrictions were not bypassed. That managed run used no privileged mode,
sandbox-disabling flag, host sysctl change, or seccomp/AppArmor change. A later,
explicitly authorized operator-run unsandboxed diagnostic is recorded below.

Before rollout, review the host/container namespace and security-policy settings
and run the full smoke test in a compatible browser-enabled container. Full
**sandboxed acceptance remains unverified**; the later unsandboxed diagnostic
progress below is not a substitute. See [browser.md](browser.md).

## Operator-run unsandboxed diagnostic — passed after corrections

At the user's explicit request, the operator ran the same local-fixture smoke
with a temporary launcher passing `--no-sandbox`. This was not a production
wrapper change or sandboxed acceptance run. Chromium launched, navigation and
snapshots worked, but the first `saved Alice` assertion failed: body text still
contained `initial`.

The smoke test's whole-response regex was reproduced selecting the textbox's
`@e1` instead of the button's `@e2`. Upstream emits the `refs` object before the
`snapshot` string; matching `button` in the metadata allowed the regex to consume
the first snapshot line's textbox ref. A click on that textbox does not invoke
Save. The `executable-path` ignored notice is expected for a CDP-attached tab and
was not the cause of this wrong-ref selection.

`tests/browser-smoke-helpers.ts` now parses the JSON and selects an unambiguous ref
by exact role and accessible name. The smoke test uses this helper. Two
regressions cover the upstream field ordering and rejection of missing,
ambiguous, malformed, or truncated refs; the helper is included in the packaged
test source.

The operator's next run failed with the production runner's generic command/
timeout error. That output does not identify a stage, exit status, or underlying
CLI error, so it does not establish which assertions passed. The fixture harness
now prints stage markers and uses a **test-only** runner that reports the failed
command name, elapsed time, exit code/signal, and bounded stdout/error and stderr.
It never prints `execFile`'s argv-bearing error message or replays a failed
command. Production error redaction is unchanged. These diagnostics are only
appropriate for the trusted local fixture, not real accounts or arbitrary pages.
Two more regressions check diagnostic bounds/argv handling and preserved timeout,
cancellation, success, and response-size behavior.

Verification after these changes:

```sh
node --experimental-strip-types --test tests/pi-browser.ts
node --experimental-strip-types --check tests/pi-browser-smoke.ts
node --experimental-strip-types --check tests/browser-smoke-helpers.ts
nix build path:.#pi-browser-extension-test --no-link --no-update-lock-file \
  --max-jobs 1 --cores 2 --print-build-logs
```

Both direct and packaged suites passed **30 tests** at this stage, and
installed-Pi loading and schema checks passed.

### Allowlist startup failure identified and corrected

The next operator run confirmed all preceding assertions: form fill/click and
saved text, JPEG screenshot, console capture, distinct delegated tab with shared
cookie state, child shutdown preserving the parent, and unrelated-conversation
cookie isolation. It then failed at `allowlist: start isolated browser and open
allowed fixture`, with the native error `No hostname in URL: about:blank`.

Call path: `BrowserSession.ensure` → CLI `open about:blank` → native `navigate`
→ `DomainFilter.check_url`. The startup navigation itself violated the hostname
allowlist before the requested HTTP URL could be opened.

Startup now uses bare `open`, the pinned CLI's launch-only operation. It creates
the browser's initial blank page without issuing a hostname-checked navigation;
containment is active from launch, and only the requested HTTP(S) URL is then
navigated to. No domains were added, no filter was disabled, and no caller-facing
URL validation was relaxed. The shared owner's startup uses the same operation.

The mock now models the hostname rejection. Two focused checks reproduced the
failure before the fix; the full suite passes **31 tests** afterward. The new
regression checks launch-only startup, viewport setup, exactly one requested
navigation, unchanged domains, and no CDP attachment. The native CLI contract
also checks bare `open` with and without `--allowed-domains`. The smoke test now
requires the specific `localhost` domain-denial error, not just any failure.

Latest focused verification, from `agentbox/`:

```sh
node --experimental-strip-types --test tests/pi-browser.ts
node --experimental-strip-types tests/pi-browser-native.ts \
  /nix/store/11pydh8nrgc65clrnkq4vzjim34mxj4a-agent-browser-0.41.2/bin/agent-browser
nix build path:.#pi-browser-extension-test path:.#pi-browser-native-test \
  --no-link --no-update-lock-file --max-jobs 1 --cores 2 --print-build-logs
node --experimental-strip-types --check tests/pi-browser-smoke.ts
git diff --check
```

These checks passed, including actual installed-Pi loading/schema validation.
The operator then reran the same terminal block against the changed checkout,
without rebuilding the CLI or image.

### Final operator rerun — passed

The operator supplied the complete stage trace through allowlisted startup,
expected forbidden navigation, and cleanup, ending with:

```text
Real browser form/screenshot/console, shared-tab login, conversation isolation, and allowlist smoke passed
```

All local-fixture assertions passed in that **unsandboxed diagnostic**:

- Form fill/click and the resulting saved text.
- Inline JPEG screenshot and fixture console output.
- Distinct delegated tabs sharing the fixture cookie, without moving the parent.
- Child shutdown preserving the parent, and unrelated-conversation cookie isolation.
- Allowed-host navigation, the specific forbidden-host rejection, and zero
  forbidden fixture requests.
- Cleanup completing without a reported failure.

No further unsandboxed rerun is pending. This was an operator-run diagnostic,
not acceptance inside a rebuilt browser-enabled image with sandboxing enabled.
Production sandbox enforcement and host security policy are unchanged. Before
rollout, rebuild the image with the startup fix, resolve the host/container
sandbox compatibility issue, and pass the same test with the sandbox-preserving
wrapper.

## Additional direct checks — passed

From `agentbox/`:

- `node --experimental-strip-types --test tests/pi-browser.ts`
- `node --experimental-strip-types tests/pi-workflow.ts`
- `node --experimental-strip-types tests/pi-policy.ts`
- `node --experimental-strip-types tests/pi-approval.ts`
- `node --test runtime/tests/*.test.mjs`
- `(cd rpc-runtime && node --test)`
- `node --experimental-strip-types --check tests/pi-browser-smoke.ts`
- `nix-instantiate --eval --strict --json tests/browser-module.nix --arg nixpkgs /nix/store/vlq3lnsh2xij0d9blab16pq0sr09z4nl-source`
  — **49** Linux/Darwin/image assertions against the pinned nixpkgs input.
- `nix flake check path:. --no-build --no-update-lock-file` — x86_64-linux
  evaluation passed; Nix omitted other architectures.
- `nix fmt -- agent-browser.nix packages.nix`
- `git diff --check`

The workflow skill-loader compatibility branch also passed with the installed Pi
root supplied as its final argument. Installed-Pi browser loading is now covered
by the successful packaged browser test above. LSP diagnostics timed out; actual
Pi loading, Node tests, and Nix builds were used for verification instead.
