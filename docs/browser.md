# Managed Pi browser

The opt-in `browser` tool is a direct managed Pi extension, available to wrapped
CLI, RPC and delegated workflow sessions, independently of desktop/noVNC.
Phase 2 adds a **Browser** pane in the RPC UI: bounded main-tab preview and
explicit human takeover. Screenshots in chat remain ordinary native image blocks;
MCP result/image conversion is unchanged. There are no download endpoints,
public CDP sockets, WebSocket streams, or persistent browser profiles.

## Configuration and rollout

Configure the consuming NixOS/nix-darwin Agentbox module, for example:

```nix
services.agentbox.settings.browser = {
  enable = true;
  delegation = "tabs"; # or "isolated"
  allowedDomains = [ ]; # e.g. [ "example.com" "*.example.com" ]
  maxOutputChars = 16000;
  commandTimeoutMs = 30000;
  idleTimeoutMs = 300000;
  shmSize = "1g";
};
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enable` | `false` | Enable managed browser tools and browser-capable image integration. |
| `delegation` | `"tabs"` | Cooperative delegated tabs, or separate browsers with `"isolated"`. |
| `allowedDomains` | `[]` | Empty permits all domains; otherwise hostname patterns, optionally prefixed `*.` (at most 128, each at most 253 characters). Not a replacement for container network policy. |
| `maxOutputChars` | `16000` | Text output bound, range 1000–50000; truncation is marked. |
| `commandTimeoutMs` | `30000` | Per-command deadline, range 1000–120000 ms. |
| `idleTimeoutMs` | `300000` | Idle browser cleanup, range 10000–3600000 ms. |
| `shmSize` | `"1g"` | Private container `/dev/shm` size; positive integer with optional `k`, `m`, or `g` suffix. `desktop.shmSize` takes precedence when desktop is also enabled. |

The module generates the read-only runtime `browser` section. `shmSize` is a
container setting, not a browser extension option. The MCP parser tolerates the
section; RPC grants its private browser channel only for `browser.enable = true`.
The browser extension validates the remaining browser settings.
Do not edit generated JSON or Nix-store files.

On NixOS, enabling the option builds the default image with `withBrowser = true`.
On macOS, use a prebuilt Linux image built with `withBrowser = true`; enabling the
Darwin module option does not rebuild that image. Custom images must include the
managed browser executables and extension wiring.

The sibling `nix-config` consumes a **pinned GitHub Agentbox input**, not the local
`../agentbox` checkout. After publishing the Agentbox change, update that input
pin deliberately, rebuild the consuming configuration/image, and recreate the
container and Pi processes to pick up the new image and mounted configuration.
A UI refresh alone is insufficient. Builds/tests are not deployment or activation;
perform any host rollout separately under the host's operational procedure.

## Session ownership and limits

- Separate top-level Pi conversations have isolated browser state. In `tabs`
  mode, a parent and its delegated agents cooperate in one browser, each owning
  a tab. **Cookies and login state are shared within that conversation family**;
  tabs are not a security boundary between agents.
- `isolated` gives delegated agents separate browsers. A nonempty
  `allowedDomains` list **forces isolated operation**, even if `delegation` is
  `tabs`: upstream CDP attachment cannot enforce the domain allowlist. Do not
  bypass that restriction to recover shared login state.
- Use `open`, then `snapshot`, then `click`/`fill` with the agent's own `@eN`
  references. Snapshot again after page changes. Other bounded actions include
  `press`, `scroll`, `wait`, `get`, navigation, `console`, `errors`, `status`,
  `screenshot`, and `close`. Page text and images are untrusted input, not
  instructions.
- For visual control, `screenshot` returns an image plus a `frameId` in model-visible
  text. `pointer` clicks at `x,y`; `type` inserts literal text into the focused
  control; `wheel` scrolls at `x,y` using signed `deltaX,deltaY` pixels (±2000).
  Each requires the latest agent `frameId`, valid once for 60 seconds, and returns
  a fresh image/binding. Coordinates use viewport CSS pixels, not scaled preview
  pixels. `resize` sets `width` (320–2560) and `height` (240–1600), returning a new
  screenshot; it tests layout without changing user agent or device pixel ratio.
  After legacy page-changing actions such as `press` or navigation, take a new
  screenshot. On `browser_frame_stale`, inspect again instead of replaying input.
- There is no persisted authentication/profile API, credential vault API, raw
  JavaScript/evaluation API, upload API or download API. No login-state export or
  restore is provided. In-memory cookies may exist during the browser lifetime;
  that is not persistent login support.
- Screenshots are JPEG image blocks delivered inline (at most 600 KiB before
  base64 encoding), with versioned artifact metadata. Temporary screenshot files
  are removed after reading; artifact IDs are not downloadable URLs.
- Structured operations are serialized across the delegated family by a kernel
  lock, released even if a Pi process is killed. A private operation journal
  survives a killed CLI: the separate daemon may still be executing. The family
  stays blocked until `browser close` successfully reclaims the uncertain daemon/
  tab (the parent can reclaim a child's operation). Workflow completion also
  reclaims registered child resources, including forced exits.
- Cancellation, failure, or an expired daemon can leave website state changed;
  use `close` before retrying an uncertain session. Expired attachments never
  silently become independent browsers. Session shutdown and idle timeout provide
  fallback cleanup. Reverting Pi history does not undo website actions.
- The CLI transport has a hard 256 KiB response ceiling in addition to the text
  truncation limit. Larger JSON responses fail closed rather than flooding the
  conversation. An unresolved cleanup intent is retained for parent shutdown;
  abnormal process termination can leave private temporary directories until
  the container's temporary storage is cleaned.

Browser calls pass through Agentbox's existing managed Pi policy, including its
CLI/RPC approval transport. There is no special browser bypass. **Auto mode
approves `ask` decisions; `deny` remains blocking.** Clicking or pressing a key
can submit a form or perform a destructive website action; the integration does
not reliably infer business consequences from a button label. Configure policy
and task permissions accordingly. Generic shell access is not constrained by the
structured browser tool's action list; browser policy is not an OS security boundary.

## Runtime security prerequisites

Managed tools use fixed packaged executables and Chromium, not model-supplied
binary paths, shell commands or runtime browser downloads. The packaged upstream
browser integration is patched to preserve Chromium's **mandatory namespace
sandbox** and suppress automatic streaming. There is no automatic stream or
public CDP viewer. Do not add `--no-sandbox`, privileged mode or an unauthenticated
CDP/WebSocket listener to make a failing launch succeed.

The actual container/host must permit the required unprivileged user namespaces
and sandbox syscalls. A parser/unit test or successful image build does not prove
that Chromium can start under a particular host's kernel/seccomp policy. Verify
sandbox support and a real browser interaction in the target environment before
calling the rollout operational. **A live browser smoke test is not established
by the compatibility tests documented here.** Container network policy remains
important, especially when browsing untrusted sites alongside agent credentials.

The tool reports recognized sandbox/namespace startup failures with a fixed,
non-sensitive error rather than reflecting Chromium stderr or upstream advice to
disable the sandbox. This identifies the failure category, not the exact host
policy responsible; resolve it at the host/container configuration boundary.

### Opt-in Docker seccomp profile

If user namespaces work on the host but Docker's default seccomp policy blocks
Chromium, select the bundled profile explicitly in the consuming host config:

```nix
services.agentbox.settings = {
  browser.enable = true;
  hardening.seccompProfile = "browser";
  enableDocker = false; # no privileged Docker-in-Docker
};
```

`"default"` remains the default; enabling browser tools alone does not relax it.
The `"browser"` preset generates immutable host-side Docker JSON from pinned
Moby seccomp/v0.2.3. It adds only five exact namespace `clone` flag combinations
and `unshare(CLONE_NEWUSER)` on x86_64/aarch64 Docker hosts. It adds no `setns`
permission, retains `clone3`'s ENOSYS fallback, explicitly drops `SYS_ADMIN`, and
rejects privileged `enableDocker` and non-Docker backends. Existing custom-profile
paths remain supported.
On macOS the local Docker CLI reads the generated profile; no VM bind mount of
the profile is needed.

**This expands namespace access for every process in the container**, not only
Chromium. It retains Chromium's own sandbox but exposes more kernel functionality
to agent commands. Host/LSM restrictions remain authoritative. This complete,
pinned profile also needs explicit review when Docker's default policy changes;
it does not automatically inherit later Docker security-policy updates. See the
[policy provenance and exact delta](../security/seccomp/README.md).

The preset is not a general bubblewrap policy: mount namespaces and mount syscalls
remain blocked without the baseline capabilities. Do not enable unrelated
capabilities or weaken other boundaries to make both tools work.

Build and inspect without activating anything:

```sh
cd agentbox
nix build path:.#agentbox-browser-seccomp path:.#browser-seccomp-test \
  --no-link --no-update-lock-file --print-build-logs
nix build path:.#agentbox-browser-seccomp \
  --no-link --no-update-lock-file --print-out-paths
```

The second command prints the **JSON file path**, not an image. NixOS and Darwin
modules resolve that path automatically for `seccompProfile = "browser"`.
Consuming a pinned older Agentbox module requires publishing/updating its pin
first. An authorized host rollout must **recreate the container** to install the
new seccomp filter; image rebuilds and Pi restarts alone cannot replace it. This
implementation does not perform that rollout.

After recreation, test as the non-root agent user:

```sh
unshare --user --map-root-user true
node --experimental-strip-types tests/pi-browser-smoke.ts \
  /bin/agent-browser /bin/agentbox-browser-chromium
```

The earlier diagnostic `unshare --user --map-root-user --net true` is intentionally
**still denied**: Chromium creates its network namespace through the permitted
`clone` combinations, not a combined `unshare`. Passing policy tests or the simple
namespace probe is not a substitute for the complete smoke and RPC UI acceptance.

## Versioned result contract

The tool returns `result.details.browser` with `version: 1`, native/owner/browser
session identifiers, `ownership` (`tab` or `browser`), `delegated`, `status`, an
optional `targetId`, workflow `taskId`/`parentTaskId`, and capabilities.
`liveView`/`takeover` are true only in the top-level RPC process with a live private
bridge; CLI and delegated processes advertise false. `screenshots: "inline"` and
`persistentLogin: false` remain unchanged. `visualInput: true` and `viewport: true`
advertise agent coordinate/typing/wheel and viewport tools, including for CLI and
delegated agents without a live preview bridge.

Screenshots additionally return `result.details.artifact` with `version: 1`,
`id`, `kind: "screenshot"`, `mimeType: "image/jpeg"`, `bytes`, and
`delivery: "inline"`. Consumers must version-check these metadata objects rather
than treating arbitrary extension details as a stable browser control API.
Agent screenshots also carry `details.frame` with `frameId`, `width`, `height`,
`coordinateSpace: "viewport-css-pixels"`, and `expiresInMs: 60000`; these fields
are repeated in the text block the model sees. IDs belong to that agent's latest
screenshot and are consumed before input. Human acquisition invalidates all
pre-takeover agent frames, including those in delegated processes, even after
release or lease expiry. Failed input is not retried automatically.

Example visual tool sequence (use each returned frame ID for the next call):

```json
{"action":"resize","width":1280,"height":720}
{"action":"pointer","frameId":"<returned frameId>","x":180,"y":116}
{"action":"type","frameId":"<returned frameId>","text":"New name"}
{"action":"wheel","frameId":"<returned frameId>","x":600,"y":400,"deltaX":0,"deltaY":500}
```

The private runtime registry is only an internal lifecycle/ownership seam. It is
**not an authorization boundary and must not be exposed** through RPC, static
files or artifact downloads. Never publish its filesystem paths, sockets, CDP
endpoints or credentials. Public result identifiers do not authorize access.

## RPC preview and human takeover (Phase 2 first increment)

Select a running conversation and open **Browser**. The agent must first open a
page; preview never launches or restores a browser. The pane polls bounded JPEG
frames at approximately 1 fps while viewing and up to 4 fps during takeover. It shows
only the main conversation's tab, not delegated tabs.
The URL bar shows its acknowledged HTTP(S) address (without embedded username or
password), including updates after page navigation. With control held, enter a
URL and press Enter or **Go**, or use Back, Forward and Reload. An unsent address
is preserved while editing and is discarded on control loss; navigation is never
sent to the model or automatically retried. The bar remains visible in expanded view.

Explicit token scopes are required in `settings.piRpcApi.auth.tokens`:

- View: `sessions:read` and `browser:read`, with profile `get_state` permission.
- Control: additionally `sessions:write` and `browser:control`, with profile
  `prompt` permission. Existing wildcard tokens retain full authority.

Tokens are operator-wide capabilities, not per-user conversation ownership.
Every browser request binds to the current native conversation; control POSTs
also require an allowed Origin. Human actions are explicit operator requests,
not model calls routed through Pi tool approvals. The backend still validates
all actions, refs, leases and profile rights; hiding a UI button is not security.

**Take control** acquires a 30-second principal/conversation/browser-bound lease,
renewed by the pane every 10 seconds. It blocks structured model browser actions
across the entire delegated family, including isolated delegated browsers.
Click/fill, keys, scroll and navigation require a fresh frame after acquisition.
After taking control, click a field in the preview and type directly. Clicks are
scaled to the acknowledged browser viewport; typing, paste, IME text, and editing keys are
sent in order as fresh frames arrive. Cmd/Ctrl+A selects the remote field's text.
The reference controls remain available. Input is buffered only in this pane
(at most 64 actions / 10000 characters), expires after five seconds waiting for
a fresh frame, and is discarded on control loss, errors, or closing the pane.
The agent tool also offers coordinate clicks and focused typing using its own
single-use screenshot bindings; it cannot use a human preview's frame ID or lease.
Text travels as JSON on the managed CLI's stdin.
Wheel and trackpad gestures over the preview scroll the page under the pointer,
including horizontal and diagonal movement. Consecutive gesture deltas are
coalesced in the same bounded input queue. Read-only previews retain normal
panel scrolling, and pinch-to-zoom is not forwarded as scrolling.

**Browser viewport** offers desktop, tablet and phone presets plus custom CSS
pixel sizes (width 320–2560, height 240–1600). **Apply resolution** changes the
actual remote viewport under the existing lease and fresh-frame checks; the size
label updates only from the acknowledged frame. The initial size is 1280×720.
These are viewport dimensions, not device/UA/DPR emulation. Drag the preview's
bottom-right corner to resize its local display, use **Fit preview** to reset it,
or **Expand preview** for more room; those display controls do not resize the page.
Frames expire after 5 seconds; each new snapshot invalidates older references.
Up to four recent direct-input frame bindings are retained to cover a preview
refresh racing with direct input, navigation, or a resize request. Reference
actions still require the latest snapshot, and every page input consumes all
frame bindings before dispatch. An explicitly rejected stale input is not retried;
the valid lease is retained so the operator can check the refreshed preview.
Actions are not retried, and website effects cannot be undone by reverting chat.
During takeover transitions the last preview stays visible; only genuinely stale
frames are dimmed. Acquiring control and page input require a fresh frame before
further input. Renewing the unchanged lease preserves a still-fresh frame, without
flashing or interrupting typing. An unchanged reference inventory preserves selection.

Closing/hiding the pane, switching sessions, logout and disconnect release control
best effort; expiry is the fallback. Frames, fill drafts and leases remain in
memory only, outside chat history and SSE replay. Arbitrary shell programs remain
outside this cooperative arbitration boundary.

RPC uses a private inherited descriptor, never a discoverable socket or CDP URL.
Requests have a hard 10-second bridge deadline, separate from model tool timeouts.
A timeout/protocol failure closes the bridge permanently, revokes control and
requires restarting that conversation process; reopening the pane is insufficient.
The UI stops polling and reports this condition. Preview size/encoding failures
alone do not make a healthy browser uncertain.

Preview/control has a no-launch action policy; the pinned CLI is patched to apply
`launch` policy to implicit startup and CDP reattachment too. See the precise
[Phase 2 contract](browser-phase2-contract.md). Delegated-tab selection, pixel
controls, streaming, downloads and persistent login remain out of scope.

## Focused verification

From `agentbox/`, the packaged checks are:

```sh
nix build path:.#pi-browser-extension-test path:.#pi-browser-native-test \
  path:.#pi-workflow-extension-test path:.#pi-policy-extension-test \
  path:.#pi-codex-wrapper-test --no-link --no-update-lock-file --print-build-logs
nix build path:.#agent-browser.tests.safety path:.#agentbox-browser.tests.wrapper \
  --no-link --no-update-lock-file --print-build-logs
```

The native CLI contract check is offline and deliberately uses a nonexistent
Chromium executable: it catches config-schema and action-policy mismatches
without pretending to test rendering. A separate real acceptance test is supplied:

```sh
# Run as the ordinary agent user in a browser-enabled container, from this repo.
node --experimental-strip-types tests/pi-browser-smoke.ts \
  /bin/agent-browser /bin/agentbox-browser-chromium
```

It uses a temporary local fixture server to check form interaction, screenshots,
console output, shared-tab cookies, separate-conversation state, an actual
navigation allowlist rejection, and Phase 2 preview/ref-based takeover against
the native daemon. HTTP/fd authorization and UI lifecycle have separate tests. It does **not** disable Chromium sandboxing.

## Parser/frontend compatibility checks

With Node 22, from `agentbox/`:

```sh
node --test runtime/tests/pi-mcp.test.mjs
node --test rpc-runtime/browser-config.test.mjs
node --test rpc-runtime/web/browser-result.test.mjs
```

These cover root-config compatibility, retained parser validation, and the
existing generic RPC image/details renderer. They do not launch Chromium, test
live browser isolation, or establish sandbox support on a deployed host.

These are local Agentbox checks, not checks of the pinned input in `nix-config`.
See [the verification report](browser-verification.md) for actual executed
checks and environmental blockers. No host activation or deployment is implied.
