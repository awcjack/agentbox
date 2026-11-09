# Phase 2 — first increment implementation contract

Status: first increment implemented and locally package-tested. Phase 1's
operator-run unsandboxed functional smoke passed; Phase 2 live operator acceptance
and sandboxed rollout acceptance are still outstanding. No production
sandbox relaxation, deployment, or consumer pin update is part of this work.

## Scope

Authenticated RPC live preview and explicit human takeover of the **top-level
conversation's browser tab**. Takeover pauses structured browser actions across
its delegated family, using a common private-root kernel lock and expiring lease.
Human interactions initially use accessibility refs (click/fill), bounded key/
scroll input, and navigation. Delegated-tab selection, pixel input, full streaming,
artifact downloads and persistent login remain follow-up work.

No new TCP listener, public CDP endpoint, WebSocket upgrade, raw JavaScript,
client-chosen filesystem path or browser endpoint. Preview uses bounded JPEG JSON
responses via the existing authenticated HTTP listener; frames/leases never enter
Pi history or SSE replay. This does not constrain arbitrary shell programs.

## Private bridge

Canonical Node-only transport: `rpc-runtime/browser-channel.mjs`. Extension-side
imports are through `extensions/browser-channel.mjs` (a source-tree re-export;
Nix installs the canonical module beside the extension).

Supervisor owns inherited duplex fd 3, sets `PI_BROWSER_RPC_FD=3` **after** profile
environment merging and only when root `browser.enable === true`. Bubblewrap
preserves exactly this additional fd. Workflow children remove that environment
marker (their fd 3 can serve other purposes); they never inherit bridge authority.

Exports:

- `createBrowserClient(stream, {timeoutMs=10000, maxPending=4}={})` returns
  `{ request(nativeSessionId, operation, payload={}, principal=""), close(), pendingCount, closed }`.
- `serveBrowserChannel(stream, handler)` returns `{close()}`. Handler receives
  `({nativeSessionId, operation, payload, principal}, signal)` and returns data.
- Version 1 JSONL, LF-only framing, maximum record 1 MiB, bounded requests and
  write backlog. Correlated opaque request IDs, request deadline, fail closed on
  malformed/oversized protocol, reject on EOF. No stdout or filesystem discovery.
  Client and server deadlines are at most 10 seconds. Timeout closes the bridge
  permanently and aborts handlers; the HTTP layer reports `browser_bridge_closed`
  and the UI stops polling with process-restart guidance. This intentionally
  avoids reuse of an ambiguous mutation transport.
- Request `{version:1,type:"request",id,nativeSessionId,operation,payload,principal}`;
  response `{version:1,type:"response",id,ok:true,data}` or
  `{version:1,type:"response",id,ok:false,error:{code,message}}`.
- Public error codes: `browser_unavailable`, `browser_busy`, `browser_control_held`,
  `browser_lease_invalid`, `browser_frame_stale`, `invalid_browser_request`,
  `browser_session_changed`, `browser_failed`. Unexpected errors become fixed,
  non-sensitive `browser_failed`; no paths/argv/native stderr may cross the bridge.
- Operations: `status`, `frame`, `acquire`, `renew`, `release`, `input`.
- Current Pi native-session ID is checked in the extension before dispatch; the
  supervisor checks the child/session object and required header before and after
  awaits. Replacements/exits must not leave a usable bridge or lease.

## HTTP routes and authorization

All routes require bearer authentication, `sessions:read` AND the **new explicit**
`browser:read` scope (wildcard remains full authority), and mandatory
`X-Pi-Session-Id`. Session must be current/running/not conversation-locked.
Existing exact allowed-Origin checking applies; control POST additionally requires
Origin (same-origin GET may legitimately omit it). IDs are freshness bindings,
not credentials. Existing tokens are global operator tokens, not per-user session
ownership; routes are bound to the authenticated live session object's fd only.

Profile must permit `get_state` for browser reads. Control additionally requires
`sessions:write`, `browser:control`, and profile `prompt` permission. This prevents
an auxiliary route silently circumventing a profile command restriction. Native
UI schema accepts the additional scope strings. Human requests are explicit
operator actions, not model tool calls; they do not claim Pi tool approval.

- GET `/v1/sessions/:id/browser`: bridge `status`, supervisor adds permissions.
- GET `/v1/sessions/:id/browser/frame`: bridge `frame`.
- POST `/v1/sessions/:id/browser/control`: bounded JSON body, strict known fields:
  - `{operation:"acquire",browserSessionId}`
  - `{operation:"renew"|"release",browserSessionId,leaseId}`
  - `{operation:"input",browserSessionId,leaseId,frameId,request:{action,...}}`

Supervisor injects `principal` derived from the authenticated token identity; it
must never accept this field from the HTTP body or expose it in results. Leases
are random, bound to principal/native/browser incarnation, TTL 30 seconds,
renewed explicitly (UI every 10 seconds). No automatic mutation retries. Frame
polls do not renew leases. All replies are no-store. No generic arbitrary proxy.

Status data:
```
{version:1,nativeSessionId,browserSessionId,available:true,ready:boolean,
 ownership:"tab"|"browser",capabilities:{liveView:true,takeover:true},
 control:{mode:"agent"|"human",expiresAt?:number},
 permissions:{view:true,control:boolean}} // permissions added by supervisor
```
When extension/bridge is absent, fail unavailable; when browser has never opened,
status remains lazy and ready=false, frame/acquire must not start it.

Frame data:
```
{version:1,nativeSessionId,browserSessionId,frameId,createdAt,
 width:1280,height:720,mimeType:"image/jpeg",data:"<base64>",
 refs:[{ref:"@eN",role:"textbox",name:"..."}],
 control:{mode:"agent"|"human",expiresAt?:number}}
```
JPEG maximum 600 KiB decoded, canonical base64 and JPEG signature validation.
At most 100 refs, names at most 512 characters; page-sourced names use textContent.
Frame IDs have a 5-second lifetime. Retain only the latest frame: every snapshot
may rebind @eN references and therefore invalidates all preceding frames. Also
clear on takeover, renewal, release or mutation.
Input requires a matching, unexpired frame and lease; consume frames before an
attempt so ambiguous mutations cannot be replayed. Allowed input actions are
`open`, `click`, `fill`, `press`, `scroll`, `back`, `forward`, `reload`, validated
through the existing strict browser argument schema. Ref-based actions must use
refs from that frame. No raw flags/JS/CDP/uploads/state/cookie access.

Acquire/renew result `{version:1,nativeSessionId,browserSessionId,leaseId,expiresAt}`.
Release/input result `{version:1,nativeSessionId,browserSessionId,accepted:true}`.
Public status/frame never include lease IDs or principal. Live capability metadata
is true only when the private RPC bridge is enabled; old Phase 1 results stay valid.

## Extension arbitration

Private-root `control.lock` held around each actual structured agent operation and
human operation; status stays lazy. Acquire acknowledges only after earlier work
finishes. Check ownership **when dequeued**, including delegated processes. Human
ownership refuses agent operations without marking an untouched browser uncertain.
Shutdown always remains possible. Use existing `launch.lock` only beneath this
outer lock (never reverse the lock order). Lease expiry/bridge disconnect releases
control; failure/expiry never silently relaunches a browser or rebinds a target.

Preview/human calls use a managed action policy without `launch` permission,
separate from the model's launch-capable policy. Together with runtime inventory
checks this prevents an expired browser auto-launching from a preview/input race.
The pinned upstream CLI needed an additional patch: implicit startup/reattachment
must check the `launch` action too. Native offline regressions verify the actual
policy switch, denial for local/CDP startup, and restoration of model policy.
Do not add domain allowlist exceptions or expose this policy as a model argument.

Journal each non-inventory native command before dispatch under the control lock.
Delete the journal only once the CLI returns successfully: CLI cancellation or
SIGKILL does not cancel daemon-side work. A surviving journal blocks the family
(including acquisition) until explicit close successfully reclaims its daemon/tab.
Failed cleanup retains the journal. This is conservative quarantine, not rollback
of website effects. Leases are checked again after awaited inventory calls.
Presentation-only frame errors clear frames without poisoning browser usability.

## UI

Browser context pane, opened explicitly for selected live session; authenticated
JSON requests only, never bearer URL parameters. One preview request at a time,
~1 fps while visible, bounded backoff, generation guards and disposal on session
switch/close/native replacement/logout. Read-only users may view but cannot
acquire. Input disabled until lease acknowledged and a fresh frame arrives.
Ref selector plus explicit Click/Fill, key/scroll/navigation controls; no global
keyboard interception. Keep drafts/leases/images in memory only. Release best
effort on close/hidden/logout; expiry is the fallback. No failed input retries.

## Verification and remaining acceptance

Transport framing/limits/EOF/deadline tests; HTTP auth/scopes/profile/origin and
replacement/exit race tests; extension lazy preview, cross-process lease ordering,
stale/foreign lease and frame rejection, expiry/cleanup/no-launch tests; UI
single-flight, stale selection, read-only and lease lifecycle tests; fd preservation
through sandbox launch. Packaged extension/native/RPC/workspace checks pass;
see [verification results](browser-verification.md). Real bubblewrap integration
is skipped where the kernel denies user namespaces. Live Phase 2 operator testing
remains distinct from sandbox-enabled deployment acceptance.
