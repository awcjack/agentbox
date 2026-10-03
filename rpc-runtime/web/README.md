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
  The transcript and composer resize with it. Drag below 180px (or press Home)
  to collapse to a 64px conversation-bubble rail; drag right or press Right to
  expand. Bubbles have status-colored auras and title/status previews on hover
  or keyboard focus, displayed outside the scrolling rail.
- Use a row's **↳ Move to folder** button to create or assign nested folders such
  as `Work/Agentbox`; an empty path ungroups it. Folder membership is saved on
  the server, keyed by profile and native conversation ID, so it follows
  resume/archive and runtime restarts across browsers and devices. Other devices
  refresh assignments every 15 seconds, or immediately with Refresh. Changes
  require `sessions:write` and a persisted session in the profile's `sessionDir`.
  Existing browser-saved folders are imported at login when no server assignment
  exists; failed imports are retained locally for retry. Server assignments win.
  Folders group each lifecycle section; sessions without an assignment appear
  under **Ungrouped**. Click a folder heading (or press Enter/Space when focused)
  to collapse or expand it; this state survives sidebar refreshes. Closed folders
  still expose session bubbles when the sidebar itself is collapsed.
- On desktop, drag a session onto a folder heading or its contents to move it.
  Drop onto **Ungrouped** to remove its folder assignment; this target remains
  available even when empty. Closed folder headings accept drops, and the target
  highlights while dragging. Moves use the same server persistence as the **↳**
  button, which remains available for touch and keyboard users.
- Use **✎ Rename session** on a running runtime row to persist its name through
  Pi's `set_session_name` RPC (write access required). Reopen historical or
  archived conversations first to rename them. Cancel leaves the name unchanged.
- Unread completed runs show **Finished (unread)** in blue, distinct from neutral
  **Idle** after viewing the conversation in a focused tab or restarting Agentbox.
  Running is green, reply-needed yellow, and action-needed peach.
- Bearer token/password input, held only in memory and cleared on logout or
  page exit. Credentials never enter cookies, local/session storage, IndexedDB,
  or a service worker. Display preferences use local storage; session folder
  assignments are server-side (legacy local assignments are removed after import).
- Model selection, Enter to send, Shift+Enter for a newline, IME-safe input,
  streaming steering/follow-up selection, queue counts, and stop-current-run.
- End & archive with confirmation uses `DELETE /v1/sessions/:id` to stop the
  process and persistently hide saved history without deleting it. Delete-scope denial disables this
  control independently of write access. Successful empty `204` responses work.
- **Archived conversations** in the sidebar lists saved archives for the selected
  profiles, including after logout/restart, ordered by creation date (newest first).
  Rows show that creation date, which does not change when a conversation is renamed
  or resumed. Expand it and click a conversation to reopen it for reading or
  continuing, then End & archive again when done.
  Reopening uses runtime capacity and requires session-creation access; it is not
  an offline viewer. Truncated server history listings produce a visible warning.
- **Export JSON** downloads the entire selected conversation tree, not the rendered
  transcript or compacted model context. Includes all branches, pre-compaction
  entries, thinking, tool calls/results, metadata, and inline image data. Reopen
  archived conversations first. Export requires read access and an idle running
  session; it neither prompts the model nor changes the conversation. Runtime
  record-size limits still apply; failures are shown without downloading partial
  history. Referenced external files are not bundled. Exports can contain secrets.
- Raster image attachments from file selection or clipboard paste, up to 5 MiB combined before base64 encoding, with
  previews, removal, and a 7.5 MiB serialized-command guard for an 8 MiB backend.
- Single-line prompt box with an accessible expand/collapse button. Scrolling
  into older messages reduces the composer to a compact row; clicking or typing
  in the prompt, or returning to the latest messages, restores its previous size.
  Drafts are preserved, Send/Stop remain available, and agent requests stay visible.
- Safe Markdown subset: headings, paragraphs, lists, quotes, rules, emphasis,
  links, pipe tables (including column alignment), and fenced code with copy/select fallback. `md`/`markdown` fences offer a
  Preview/Source toggle using the same safe renderer (nested fences stay source).
  Raw HTML is never interpreted.
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
  payloads. Message and code copying try synchronous `execCommand("copy")` first
  for HTTP compatibility, then the modern Clipboard API. Manual selection is
  available if both automatic methods fail.
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

- `GET /v1/history?profile=...&includeArchived=true` returns `{sessions:[{id,name,cwd,createdAt,modifiedAt,profile,archived}],truncated}`.
- `GET /v1/sessions/:id/export` returns a versioned JSON document with the complete
  `entries` tree, `leafId`, native identity, name, profile, cwd and export time.
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

Settings also includes **Session subagent concurrency**: set a positive integer cap,
reset to the managed default, or show current status/managed ceiling in session
notifications. Changes apply to the current session branch, persist with it, and
require an idle session. Pi enforces the managed ceiling. Controls are disabled
unless `/agentbox-subagents` is registered; no draft or attachments are sent.
These actions share the defaults command's write lock and native-session guard.

Settings includes browser-local display preferences (no credentials are stored):
- **Models shown in selector:** search and uncheck models to hide them by provider
  and model ID. The current model remains visible; **Show all models** clears the
  hidden list. New models are visible by default. This does not change model access,
  Pi defaults, or other browsers.
- **Hide Profile section:** hides the sidebar filter and resets it to All profiles.
  The new-session profile picker remains available.
Preferences persist across page reloads when local storage is available; if storage
is blocked, the UI reports that changes apply only to the current page.

Model discovery runs after the initial/reconnect snapshot and on explicit Refresh,
without another SSE connection. Routine transcript snapshots do not poll models.
Transient network/timeouts and HTTP 408/429/500/502/503/504 failures get at most two
retries (250 ms, then 1 s); auth/command denials are not retried. Successful catalogs,
including empty or incomplete lists, are accepted without retries. Selection changes,
native conversation replacement and newer refreshes cancel obsolete catalog reads
and retry delays. Deploy the current Agentbox image to include its Pi startup
provider-registration patch; browser refresh alone cannot fix an older Pi build.

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

Set `SETTINGS_ONLY=1` for the desktop/mobile Settings regression path (including
subagent cap/status/reset, validation, notifications, draft preservation, idle and
native-replacement guards, and unsupported-command handling).

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
  clipboard APIs. Copy buttons use the legacy click-triggered copy method on
  these origins; browsers that block both copy methods fall back to selection.
- Oversized snapshot responses (HTTP 413) stop automatic reconnect attempts;
  the session can still be ended. Transcript pagination is not provided by Pi's
  `get_messages` command. Read snapshots are not duplicated in SSE replay.
- Markdown is deliberately a small safe subset, not full CommonMark: no
  nested-list parsing, syntax highlighting, or raw HTML. No external fonts/CDNs.
- The runtime does not expose token capabilities up front. Read-only and command
  restrictions are learned from explicit scope/allowlist errors, then controls
  are disabled. Profiles/history can be unavailable to a restricted token.
- Stop uses `abort`; existing queued follow-ups are not discarded and may run.
  Approval deadlines are enforced by the supervisor; the frontend does not
  invent a new deadline when restoring a request with only a relative timeout.
- Exited children cannot answer snapshot RPCs. Cached messages and bounded
  stderr remain inspectable in this tab; resume persisted history to reload the
  conversation in a running child. End & archive releases the supervised process
  and moves the persisted conversation into Archived conversations across restarts.
  Drafts are not saved into that history.
- When first joining a delta-only stream mid-message, text before the captured
  cursor is unavailable from `get_messages`. New deltas are displayed immediately;
  completion reconciles the full message from the authoritative snapshot.
- Message history is fully rendered, not virtualized. Extremely large
  conversations or tool outputs can be expensive to display.
- This directory does not configure static hosting or modify the backend.

### Session Auto permissions

The toolbar's Auto toggle saves an explicit on/off choice with the native
conversation through the policy extension. Restarting Pi and resuming it from
**PICK UP WHERE YOU LEFT OFF** restores that choice; the UI displays the restored
`autoMode` metadata rather than persisting permission in browser storage.
Other sessions, forks, and workflow children do not inherit it. Managed policy
must still permit Auto, and managed denials remain enforced. Conversations with
no saved choice resume off. This is separate from Settings' global defaults for
future fresh sessions. `/auto review` also restores its saved review choice,
but the Auto button remains off because review is not automatic approval.

### OpenAI fast mode

The active-session toolbar beside Auto offers an opt-in **OpenAI fast mode** toggle
with an extra-cost warning, not a global Settings preference. Switching sessions
shows the selected session’s confirmed mode; enabling A does not enable B.
It starts off for each parent Pi process and is not persisted as a browser or
future-session default. Managed subagents inherit the parent's live mode at spawn,
including resumed jobs; existing children are not changed retroactively. A child
using an unsupported provider does not send the premium tier. The control sends `/fast on` or `/fast off` through the native-conversation-bound
prompt RPC without sending the draft or attachments. It requires an idle, writable
session and confirmed available `session.fastMode` metadata (which establishes
extension support without opening Settings or loading the command catalog).
Unknown or unsupported sessions cannot enable it. Prompt acceptance never optimistically
enables fast mode: the UI waits for refreshed metadata, including refreshes triggered
by `agentbox-fast` status events.
