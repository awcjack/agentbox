# Agentbox Web Workspace

Dependency-free frontend for the Pi RPC runtime. Serve this directory at `/`
or a subdirectory such as `/web/`, with `/v1/*` routed to the runtime on the
**same origin**. `index.html`, `styles.css`, `icon.svg`, and the five application
ES modules are the only deployed assets required. Serve `.mjs` as JavaScript.
There is no package installation, build step, SSH client, or external resource.

The static server must permit this page's scripts and styles. Do not apply the
API's `default-src 'none'` CSP to the HTML page. The HTML includes its own
restrictive CSP; the server should also send `frame-ancestors 'none'` and
`Cache-Control: no-store` for HTML. Keep the runtime's origin allowlist aligned
with the browser's actual origin. Use HTTPS or a trusted private VPN.

## Features

- Warm charcoal, responsive chat workspace with a mobile session drawer,
  profile filtering, named sessions, and persisted-history resume.
- Drag the desktop sidebar's right edge to resize it. The focused separator also
  supports Left/Right arrows, Shift for larger steps, and Home/End for limits.
- Bearer token/password input, held only in memory and cleared on logout or
  page exit. No cookies, local/session storage, IndexedDB, or service worker.
- Model selection, Enter to send, Shift+Enter for a newline, IME-safe input,
  streaming steering/follow-up selection, queue counts, and stop-current-run.
- End session with confirmation uses `DELETE /v1/sessions/:id` to free runtime
  capacity without deleting saved history. Delete-scope denial disables this
  control independently of write access. Successful empty `204` responses work.
- Raster image attachments from file selection or clipboard paste, up to 5 MiB combined before base64 encoding, with
  previews, removal, and a 7.5 MiB serialized-command guard for an 8 MiB backend.
- Safe Markdown subset: headings, paragraphs, lists, quotes, rules, emphasis,
  links, and fenced code with copy/select fallback. Raw HTML is never interpreted.
  Remote Markdown images are not fetched; only validated inline raster data is
  displayed. Tool input/output/details and nonempty thinking are collapsible.
- Confirm, select, input, and editor approvals, including cancellation and
  supervisor-driven expiry/resolution across browsers. Approval edits and message
  drafts survive session switches within the current tab, not reload/logout.
- Pending requests replace the chat composer without losing its draft. Choosing
  the workflow question's "Other (type an answer)" opens its text input directly;
  submitting that field answers the question, not the chat queue.
- Subagent task cards show ordered child status and output inside the parent
  conversation. Children keep isolated sessions; no session switch is needed.
- Subagent tools that require manual approval open an "Approve subagent" request
  in the parent's composer area, identifying the role, child ID, and operation.
  Allow once authorizes only that call. Denial, cancellation, timeout or a lost
  connection to the parent blocks it. Parallel children queue their approval dialogs.
- Successful prompts clear the accepted draft without showing a success bar.
- Each assistant reply shows its recorded model/provider, with a routed response
  model in the tooltip when available. Historical replies never inherit the
  currently selected model.
- Copy message/response copies raw text and Markdown, not thinking, tools or image
  payloads. A selectable text dialog is available if clipboard access fails.
- Revert and Fork on user messages branch from before the selected message and
  restore its text/images as an unsent draft after confirmation. Fork opens a
  separate session; Revert replaces the current session's process/native history
  while keeping its supervisor ID and original history available to resume.
  Neither action undoes files or external side effects. Both require an idle
  agent, persisted history, and capacity for an additional process during setup.
- Visible network/auth/scope errors, disabled unavailable controls, bounded
  reconnect backoff, and snapshot reconciliation without prompt retries.

## Contract And Reconciliation

Uses the existing runtime README/RPC contract and these supervisor additions:

- `GET /v1/history?profile=...` returns `{sessions:[{id,name,cwd,modifiedAt,profile}]}`.
- Session metadata includes `name`, nullable `nativeSessionId`, `latestEventId`,
  and the current `pendingUi` requests.
- Accepted UI answers publish a `supervisor` event named `extension_ui_resolved`
  with `id`, like `extension_ui_expired`.
- `get_messages` returns `data.messages`, `get_state` returns `data.model`,
  `data.isStreaming`, `data.sessionName`, etc., and `get_available_models`
  returns `data.models`.
- SSE `event: pi` contains the raw Pi event. Full `message_update.message`
  snapshots and Pi 0.84 delta-only `assistantMessageEvent` records are supported.
  Text, thinking, and tool calls are assembled by `contentIndex`; full snapshots
  replace rather than append to the partial.

Verified against the project's locked nixpkgs revision
`ffb3c9b700e759be2ef13237c9d8f953b32a1e46`, which packages Pi **0.84.2**:

- [RPC get_messages](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
  returns `session.messages`; the AgentSession getter returns `agent.state.messages`.
- [Agent processEvents](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent.ts)
  keeps `message_start`/`message_update` in `streamingMessage` and pushes into
  `state.messages` only at `message_end`. Snapshots contain completed messages,
  so they correctly take precedence over replayed partials with the same key.
- [RPC wire transformation](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/json-event.ts)
  strips cumulative partials from `message_update`, requiring delta assembly.

On selection/reconnect/reset, metadata is fetched **before** snapshot RPCs and
its `latestEventId` is used for the subscription. Completed messages are always
reconciled via `get_messages`, never appended from replayed `message_end` events.
Committed snapshots take precedence over replayed partials with the same role
and timestamp. Live tool results are correlated by `toolCallId`. Pending dialogs
come from metadata, so historical requests cannot resurrect resolved approvals.
Concurrent metadata reads are guarded against newer UI resolution events.

Reads and subscriptions are cancelled on selection changes.
Repeated clicks on the selected session keep the current stream and in-flight
snapshot intact. Refresh reconciles a healthy session without replacing its
stream; unavailable connections and browser network recovery explicitly reconnect.
Selecting a different session changes the browser subscription, not the running
Pi process.

Writes retain their original session identity, and only clear an unchanged draft
after acceptance.
An ambiguous network failure preserves the draft and warns that acceptance is
unknown. The application never retries writes, prompts, or creation requests.
Browsers/proxies can transparently retry a connection failure before response
headers arrive; strict at-most-once delivery requires server-side idempotency.

Conversation actions obtain entry IDs and the current leaf from
`GET /v1/sessions/:id/conversation` and refuse ambiguous message matches. The
mutation endpoint validates both native identity and leaf. Browser RPC/UI writes
also include `X-Pi-Session-Id` so an old tab cannot write into a replaced branch.
Replacement events reconnect other tabs through metadata polling without
replaying abandoned transcript events or discarding their unsent drafts.

## Verification

Run from `rpc-runtime/`:

```sh
node --test web/*.test.mjs
node --check web/app.mjs
node --check web/transport.mjs
node --check web/markdown.mjs
```

### Optional Real-Browser Smoke

`browser-smoke.mjs` is deliberately outside the default `*.test.mjs` suite. It
serves the real frontend and a fake HTTP/SSE API on loopback; no LLM or real token
is used. Install Playwright outside the repository, for example:

```sh
ls /tmp/opencode-work/opencode
npm install --prefix /tmp/opencode-work/opencode --no-save --no-audit --no-fund playwright
/tmp/opencode-work/opencode/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/opencode-work/opencode/node_modules/playwright/index.mjs \
SMOKE_OUTPUT_DIR=/tmp/opencode-work/opencode node web/browser-smoke.mjs
```

The output directory must already exist. Chromium needs its usual OS libraries
and fonts; on Nix-based hosts provide a browser environment (`LD_LIBRARY_PATH`
and `FONTCONFIG_FILE`) or set `CHROMIUM_EXECUTABLE` to a compatible installed
Chromium. The app itself has no Playwright dependency.

The smoke runs desktop (1440x1000) and mobile (390x844, plus a 360px overflow
check): wrong/right login, new session, model change, pasted image, Enter vs
Shift+Enter, streaming deltas, follow-up queue, tools/thinking, all approval
methods, cancellation/expiry, cross-browser resolution, SSE reset and EOF
reconnect, ambiguous post-header network failure without application retries,
stop, session-end cancellation/DELETE, history resume, a late write during a
session switch, no horizontal overflow, memory-only auth, and logout. It fails
on JS/CSP errors and saves `pi-workspace-desktop.png` and
`pi-workspace-mobile.png`, plus a failure screenshot when applicable.

## Limits

- Requires native ES modules, fetch/ReadableStream, AbortController, and HTML
  dialogs. HTTP on Tailscale works without `crypto.randomUUID` or secure-context
  clipboard APIs; copying code falls back to text selection on such origins.
- Oversized snapshot responses (HTTP 413) stop automatic reconnect attempts;
  the session can still be ended. Transcript pagination is not provided by Pi's
  `get_messages` command. Read snapshots are not duplicated in SSE replay.
- Markdown is deliberately a small safe subset, not full CommonMark: no tables,
  nested-list parsing, syntax highlighting, or raw HTML. No external fonts/CDNs.
- The runtime does not expose token capabilities up front. Read-only and command
  restrictions are learned from explicit scope/allowlist errors, then controls
  are disabled. Profiles/history can be unavailable to a restricted token.
- Stop uses `abort`; existing queued follow-ups are not discarded and may run.
  Approval deadlines are enforced by the supervisor; the frontend does not
  invent a new deadline when restoring a request with only a relative timeout.
- Exited children cannot answer snapshot RPCs. Cached messages and bounded
  stderr remain inspectable in this tab; resume persisted history to reload the
  conversation in a running child. End session releases the supervised process,
  not the persisted conversation. Drafts are not saved into that history.
- When first joining a delta-only stream mid-message, text before the captured
  cursor is unavailable from `get_messages`. New deltas are displayed immediately;
  completion reconciles the full message from the authoritative snapshot.
- Message history is fully rendered, not virtualized. Extremely large
  conversations or tool outputs can be expensive to display.
- This directory does not configure static hosting or modify the backend.
