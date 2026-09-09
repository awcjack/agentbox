import { ApiError, createTransport, eventCursor, messageKey, updatePartial, visibleMessages } from "./transport.mjs";
import { element, imageSource, renderMarkdown } from "./markdown.mjs";

const $ = (id) => document.getElementById(id);
const api = createTransport(() => token);
let token = "", auth = new AbortController(), epoch = 0, selection = 0, listVersion = 0;
let current = null, sessions = [], profiles = [], history = [], readOnly = false, createDenied = false, createBusy = false;
let endTarget = null, deleteDenied = false;
const records = new Map();
const dialogMethods = new Set(["confirm", "select", "input", "editor"]);
const conversation = $("conversation");
let followBottom = true, renderPending = false;

function record(id) {
  if (!records.has(id)) records.set(id, { draft: { text: "", images: [], version: 0 }, messages: [], models: [], uiDrafts: new Map(), forbidden: new Set(), sending: false, notice: null });
  return records.get(id);
}
function active(ctx) { return current === ctx && !ctx.controller.signal.aborted && Boolean(token); }
function path(ctx, suffix = "") { return `/v1/sessions/${encodeURIComponent(ctx.id)}${suffix}`; }
async function rpc(ctx, command, write = false) {
  const value = await api.request(path(ctx, "/rpc"), { body: command, signal: write ? auth.signal : ctx.controller.signal });
  return value.data;
}
function showNotice(message, error = false) {
  $("notice-text").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
function report(error, ctx, { write = false, command, ambiguous = false } = {}) {
  if (ctx && !active(ctx)) return;
  if (error.status === 401) { logout("Your access token was rejected. Log in again to reconnect."); return; }
  if (write && error.code === "insufficient_scope") readOnly = true;
  if (ctx && error.code === "command_forbidden" && command) ctx.record.forbidden.add(command);
  const uncertain = ambiguous && (!error.status || error.status >= 500);
  const message = `${error.message || "Something went wrong."}${uncertain ? " It may already have been accepted. Nothing was retried; check the conversation and queue before sending again." : ""}${readOnly && write ? " This token is read-only; writing controls are disabled." : ""}`;
  if (ctx) ctx.record.notice = { message, error: true };
  showNotice(message, true);
  updateControls();
}
function setNetwork(status, label) {
  $("connection-dot").className = `connection-dot ${status}`;
  $("connection-label").textContent = label;
}
function canWrite(ctx, command = "prompt") {
  return Boolean(ctx && active(ctx) && ctx.ready && ctx.online && ctx.meta?.status === "running" && !ctx.record.ending && !readOnly && !ctx.record.forbidden.has(command));
}
function updateControls() {
  const ctx = current;
  const streaming = Boolean(ctx?.state.isStreaming);
  const draft = ctx?.record.draft;
  $("new-session").disabled = !token || !profiles.length || createDenied || createBusy;
  $("refresh-sessions").disabled = !token;
  $("profile-filter").disabled = !token || !profiles.length;
  $("logout").disabled = !token;
  $("end-session").disabled = !ctx || !token || deleteDenied || ctx.record.ending;
  $("end-session").textContent = ctx?.record.ending ? "Ending..." : "End session";
  $("prompt").disabled = !ctx || readOnly;
  $("attach").disabled = !ctx || readOnly || ctx.record.sending;
  $("send").disabled = !canWrite(ctx) || ctx.record.sending || ctx.record.readingImages || !(draft.text.trim() || draft.images.length);
  $("send").firstChild.textContent = ctx?.record.sending ? "Sending " : streaming ? "Queue " : "Send ";
  $("send-mode").hidden = !streaming;
  $("send-mode").disabled = !canWrite(ctx);
  $("stop").hidden = !streaming;
  $("stop").disabled = !canWrite(ctx, "abort") || ctx?.stopping;
  $("stop").textContent = ctx?.stopping ? "Stopping..." : "Stop";
  $("model").disabled = !canWrite(ctx, "set_model") || streaming || ctx?.modelBusy || !ctx?.record.models.length;
  $("session-title").textContent = ctx ? ctx.state.sessionName || ctx.meta?.name || "Untitled session" : "Pi coding workspace";
  $("session-subtitle").textContent = ctx ? `${ctx.meta?.profile || "workspace"} / ${ctx.meta?.cwd || ctx.state.sessionId || ctx.id}` : "Code, tools, and persistent conversations.";
  $("session-status").textContent = !ctx ? "WORKSPACE" : !ctx.ready ? "SYNCING" : readOnly ? "READ ONLY" : ctx.meta?.status !== "running" ? (ctx.meta?.status || "OFFLINE").toUpperCase() : !ctx.online ? "OFFLINE" : streaming ? "WORKING" : "READY";
  $("session-status").classList.toggle("working", streaming);
  $("activity-text").textContent = !ctx ? "Choose a session to start" : readOnly ? "Read-only access" : ctx.meta?.status !== "running" ? "This process has ended. Resume from history to continue." : !ctx.online ? "Reconnecting safely. Your draft stays here." : ctx.stopping ? "Waiting for the agent to stop..." : ctx.state.isCompacting ? "Compacting conversation..." : streaming ? "Agent is working. You can steer or queue a follow-up." : "Ready when you are";
  document.querySelector(".activity").classList.toggle("busy", streaming && ctx?.online);
  const pending = ctx?.state.pendingMessageCount || 0;
  $("queue-count").textContent = pending ? `${pending} queued` : "";
  $("welcome-foot").textContent = !token ? "Connect to your runtime to get started." : ctx ? "Your session is ready. Make the first move." : "Create a new session or pick up where you left off.";
  for (const button of document.querySelectorAll(".starter")) button.disabled = readOnly || (!ctx && (!profiles.length || createDenied));
  for (const input of $("approvals").querySelectorAll("input, textarea, select, button")) {
    const card = input.closest(".approval");
    input.disabled = !canWrite(ctx, "ui") || card.dataset.busy === "true";
  }
}

function drawer(open) {
  $("sidebar").classList.toggle("open", open);
  $("drawer-shade").hidden = !open;
  $("open-drawer").setAttribute("aria-expanded", String(open));
  document.querySelector(".main").inert = open;
  if (open) $("close-drawer").focus();
}
function renderSessions() {
  const root = $("sessions"); root.replaceChildren();
  const filter = $("profile-filter").value;
  const live = sessions.filter((session) => !filter || session.profile === filter);
  function row(session, historical) {
    const button = element("button", `session-item${!historical && current?.id === session.id ? " active" : ""}`);
    if (!historical && current?.id === session.id) button.setAttribute("aria-current", "page");
    button.title = historical ? `Resume ${session.name || session.id}\n${session.cwd || session.profile}` : `${session.name || session.id}\n${session.profile}`;
    button.append(element("span", "session-symbol", historical ? "/" : ">"));
    const copy = element("span", "session-copy");
    copy.append(element("strong", "", session.name || "Untitled session"));
    const date = session.modifiedAt || session.lastActivityAt || session.createdAt;
    const parsed = new Date(date);
    const when = Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    copy.append(element("small", "", `${session.profile} / ${historical ? "resume" : session.status}${when ? ` / ${when}` : ""}`));
    button.append(copy);
    button.addEventListener("click", () => historical ? resume(session) : activate(session));
    button.disabled = historical ? createDenied || createBusy : Boolean(records.get(session.id)?.ending);
    root.append(button);
  }
  if (live.length) root.append(element("div", "list-heading", "IN THIS RUNTIME"));
  for (const session of live.slice().sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)))) row(session, false);
  const activeNative = new Set(sessions.filter((session) => ["running", "stopping"].includes(session.status)).map((session) => `${session.profile}:${session.nativeSessionId}`));
  const past = history.filter((session) => (!filter || session.profile === filter) && !activeNative.has(`${session.profile}:${session.id}`));
  if (past.length) root.append(element("div", "list-heading", "PICK UP WHERE YOU LEFT OFF"));
  for (const session of past.slice().sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))) row(session, true);
  if (!live.length && !past.length) root.append(element("p", "sidebar-empty", token ? "A clean slate. Create a session to start building." : "Connect to find your sessions."));
}
async function refreshSessions() {
  const version = ++listVersion, ownEpoch = epoch;
  try {
    const result = await api.request("/v1/sessions", { signal: auth.signal });
    if (ownEpoch !== epoch || version !== listVersion) return;
    sessions = result.sessions || []; renderSessions();
    const names = $("profile-filter").value ? [$("profile-filter").value] : profiles;
    const results = await Promise.allSettled(names.map((profile) => api.request(`/v1/history?profile=${encodeURIComponent(profile)}`, { signal: auth.signal })));
    if (ownEpoch !== epoch || version !== listVersion) return;
    history = results.flatMap((result) => result.status === "fulfilled" ? result.value.sessions || [] : []);
    renderSessions();
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      if (failed.reason.status === 401) report(failed.reason);
      else showNotice(`Historical sessions could not be loaded: ${failed.reason.message}`, true);
    }
  } catch (error) { if (ownEpoch === epoch && version === listVersion) report(error); }
}
function renderModels(ctx) {
  if (!active(ctx)) return;
  const root = $("model"); root.replaceChildren();
  const model = ctx.state.model;
  const models = ctx.record.models.slice();
  if (model && !models.some((item) => item.id === model.id && item.provider === model.provider)) models.unshift(model);
  if (!models.length) root.append(element("option", "", "No model available"));
  for (const item of models) {
    const option = element("option", "", `${item.name || item.id} / ${item.provider}`);
    option.value = JSON.stringify([item.provider, item.id]);
    option.selected = model?.id === item.id && model?.provider === item.provider;
    root.append(option);
  }
  updateControls();
}

function renderContent(parent, content) {
  if (typeof content === "string") { parent.append(renderMarkdown(content)); return; }
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === "text") parent.append(renderMarkdown(block.text || ""));
    if (block.type === "image") {
      const src = imageSource(block);
      if (src) { const img = element("img", "message-image"); img.src = src; img.alt = "Conversation attachment"; img.loading = "lazy"; parent.append(img); }
    }
  }
}
function renderTool(call, result, key) {
  const detail = element("details", `tool-detail${result?.isError ? " error" : ""}`);
  detail.dataset.detailKey = `tool:${key}`;
  const summary = element("summary", "", call.name || result?.toolName || "Tool");
  summary.append(element("span", "tool-state", result ? result.running ? "running" : result.isError ? "error" : "complete" : "requested"));
  detail.append(summary);
  if (call.arguments !== undefined) detail.append(element("div", "tool-label", "INPUT"), element("pre", "", typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2)));
  if (result) {
    detail.append(element("div", "tool-label", "OUTPUT"));
    for (const block of typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content || []) {
      if (block.type === "text") detail.append(element("pre", "", block.text));
      else renderContent(detail, [block]);
    }
    if (result.details != null) detail.append(element("div", "tool-label", "DETAILS"), element("pre", "", JSON.stringify(result.details, null, 2)));
  }
  return detail;
}
function renderMessages() {
  const ctx = current, root = $("messages");
  const open = new Set([...root.querySelectorAll("details[open]")].map((node) => node.dataset.detailKey));
  const previousTop = conversation.scrollTop;
  root.replaceChildren();
  if (!ctx) { $("welcome").hidden = false; return; }
  const messages = visibleMessages(ctx.record.messages, ctx.partial);
  const results = new Map(ctx.tools);
  for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  const shown = new Set();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "toolResult") continue;
    const article = element("article", `message ${message.role === "user" ? "user" : "assistant"}`);
    const header = element("div", "message-header");
    header.append(element("span", "avatar", message.role === "user" ? "u" : "pi"), element("span", "", message.role === "user" ? "You" : message.role === "assistant" ? "Pi agent" : message.role || "Context"));
    if (message.timestamp) {
      const date = new Date(message.timestamp);
      if (!Number.isNaN(date.getTime())) { const time = element("time", "", date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })); time.dateTime = date.toISOString(); header.append(time); }
    }
    const body = element("div", "message-content");
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const block = content[blockIndex];
      if (block.type === "thinking") {
        const detail = element("details", "thinking"); detail.dataset.detailKey = `thinking:${messageKey(message) || index}:${blockIndex}`;
        detail.append(element("summary", "", "Thinking"), renderMarkdown(block.thinking || "")); body.append(detail);
      } else if (block.type === "toolCall") {
        shown.add(block.id); body.append(renderTool(block, results.get(block.id), block.id));
      } else renderContent(body, [block]);
    }
    if (message.summary) body.append(renderMarkdown(message.summary));
    if (message.role === "bashExecution") body.append(element("pre", "", `${message.command || ""}\n${message.output || ""}`));
    if (message.errorMessage || ["error", "aborted"].includes(message.stopReason)) body.append(element("div", "message-error", message.errorMessage || (message.stopReason === "aborted" ? "Response stopped." : "The agent could not complete this response.")));
    article.append(header, body); root.append(article);
  }
  for (const [id, result] of results) if (!shown.has(id)) root.append(renderTool({ name: result.toolName, arguments: result.args }, result, id));
  if (ctx.meta?.status !== "running" && ctx.meta?.stderr) {
    const detail = element("details", "tool-detail"); detail.dataset.detailKey = "stderr";
    detail.append(element("summary", "", "Process diagnostics"), element("pre", "", ctx.meta.stderr)); root.append(detail);
  }
  for (const node of root.querySelectorAll("details")) node.open = open.has(node.dataset.detailKey);
  $("welcome").hidden = Boolean(root.childElementCount);
  if (followBottom) conversation.scrollTop = conversation.scrollHeight;
  else conversation.scrollTop = previousTop;
  $("jump-latest").hidden = followBottom || !root.childElementCount;
}
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderMessages(); updateControls(); });
}
function restoreDraft() {
  $("prompt").value = current?.record.draft.text || "";
  $("attachments").replaceChildren();
  for (const image of current?.record.draft.images || []) {
    const attachment = element("div", "attachment");
    const preview = element("img"); preview.src = imageSource(image); preview.alt = image.name;
    const remove = element("button", "icon-button", "\u00d7"); remove.type = "button"; remove.setAttribute("aria-label", `Remove ${image.name}`);
    const ctx = current;
    remove.addEventListener("click", () => {
      if (!active(ctx)) return;
      ctx.record.draft.images = ctx.record.draft.images.filter((item) => item !== image); ctx.record.draft.version++; restoreDraft();
    });
    attachment.append(preview, element("span", "", image.name), remove); $("attachments").append(attachment);
  }
  updateControls();
}

function renderApprovals(ctx) {
  if (!active(ctx)) return;
  const root = $("approvals");
  const pending = new Map((ctx.meta.pendingUi || []).filter((request) => dialogMethods.has(request.method)).map((request) => [request.id, request]));
  for (const card of [...root.children]) if (!pending.has(card.dataset.id)) card.remove();
  for (const [id, request] of pending) {
    if ([...root.children].some((card) => card.dataset.id === id)) continue;
    const card = element("form", "approval"); card.dataset.id = id;
    card.append(element("span", "approval-type", `AGENT REQUEST / ${request.method.toUpperCase()}`), element("h3", "", request.title || "Your input is needed"));
    if (request.message) card.append(element("p", "", request.message));
    let input;
    if (request.method !== "confirm") {
      input = element(request.method === "select" ? "select" : request.method === "editor" ? "textarea" : "input");
      input.setAttribute("aria-label", request.title || "Your response");
      if (request.method === "select") for (const value of request.options || []) { const option = element("option", "", value); option.value = value; input.append(option); }
      input.value = ctx.record.uiDrafts.get(id) ?? request.prefill ?? (request.method === "select" ? request.options?.[0] || "" : "");
      if (request.placeholder) input.placeholder = request.placeholder;
      input.addEventListener("input", () => ctx.record.uiDrafts.set(id, input.value)); card.append(input);
    }
    const actions = element("div", "approval-actions");
    if (request.timeout) actions.append(element("span", "approval-expiry", "Time-limited request"));
    const cancel = element("button", "", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", () => answer({ id, cancelled: true })); actions.append(cancel);
    if (request.method === "confirm") {
      const deny = element("button", "", "Decline"); deny.type = "button";
      deny.addEventListener("click", () => answer({ id, confirmed: false })); actions.append(deny);
    }
    const accept = element("button", "approve", request.method === "confirm" ? "Confirm" : "Submit"); accept.type = "submit"; actions.append(accept);
    card.append(actions); root.append(card);
    card.addEventListener("submit", (event) => { event.preventDefault(); answer(request.method === "confirm" ? { id, confirmed: true } : { id, value: input.value }); });
    async function answer(body) {
      if (!canWrite(ctx, "ui") || card.dataset.busy === "true") return;
      card.dataset.busy = "true"; updateControls();
      try {
        await api.request(path(ctx, "/ui"), { body, signal: auth.signal });
        if (!active(ctx)) return;
        ctx.uiRevision++;
        ctx.record.uiDrafts.delete(id);
        ctx.meta.pendingUi = ctx.meta.pendingUi.filter((item) => item.id !== id); renderApprovals(ctx);
      } catch (error) { report(error, ctx, { write: true, ambiguous: true }); }
      finally {
        if (active(ctx)) { card.dataset.busy = "false"; updateControls(); requestRefresh(ctx); }
      }
    }
  }
  updateControls();
}

function applyMeta(ctx, meta) {
  ctx.meta = meta;
  const index = sessions.findIndex((session) => session.id === ctx.id);
  if (index >= 0) sessions[index] = meta;
  renderApprovals(ctx); renderSessions();
}
async function snapshot(ctx, initial = false) {
  // Capture the cursor BEFORE snapshot RPCs. Anything racing them is replayed.
  const uiRevision = ctx.uiRevision;
  const { session: meta } = await api.request(path(ctx), { signal: ctx.controller.signal });
  if (!active(ctx)) return null;
  const cursor = eventCursor(meta.latestEventId);
  if (cursor === null) throw new ApiError("The runtime must expose latestEventId in session metadata for safe streaming.", 409, "missing_cursor");
  if (uiRevision !== ctx.uiRevision) {
    meta.pendingUi = ctx.meta.pendingUi;
    ctx.refreshAgain = true;
  }
  applyMeta(ctx, meta);
  if (meta.status !== "running") { ctx.ready = true; ctx.state.isStreaming = false; renderMessages(); updateControls(); return cursor; }
  const revision = ctx.stateRevision;
  const [messages, state] = await Promise.all([rpc(ctx, { type: "get_messages" }), rpc(ctx, { type: "get_state" })]);
  if (!active(ctx)) return null;
  ctx.record.messages = messages?.messages || [];
  if (initial || revision === ctx.stateRevision) ctx.state = state || {};
  if (ctx.partial && ctx.record.messages.some((message) => messageKey(message) && messageKey(message) === messageKey(ctx.partial))) ctx.partial = null;
  for (const message of ctx.record.messages) if (message.role === "toolResult") ctx.tools.delete(message.toolCallId);
  ctx.ready = true;
  renderModels(ctx); scheduleRender();
  return cursor;
}
function requestRefresh(ctx) {
  if (!active(ctx)) return;
  ctx.refreshAgain = true;
  if (ctx.refreshTimer || ctx.refreshing || ctx.connecting) return;
  ctx.refreshTimer = setTimeout(async () => {
    ctx.refreshTimer = null;
    if (!active(ctx)) return;
    ctx.refreshAgain = false; ctx.refreshing = true;
    try { await snapshot(ctx); }
    catch (error) {
      if (active(ctx)) { report(error, ctx); ctx.online = false; ctx.streamController?.abort(); }
    } finally {
      ctx.refreshing = false;
      if (ctx.refreshAgain && active(ctx)) requestRefresh(ctx);
    }
  }, 100);
}
function handleEvent(ctx, frame) {
  if (!active(ctx) || ctx.reset || ctx.streamController.signal.aborted) return;
  if (frame.event === "reset") { ctx.reset = true; ctx.streamController.abort(); return; }
  if (frame.event !== "pi") return;
  const cursor = eventCursor(frame.id);
  if (cursor === null) throw new ApiError("The event stream contained an invalid cursor.");
  if (cursor <= ctx.cursor) return;
  ctx.cursor = cursor;
  let event;
  try { event = JSON.parse(frame.data); } catch { throw new ApiError("The event stream contained invalid JSON."); }
  if (!event || typeof event !== "object") throw new ApiError("The event stream contained an invalid event.");
  const type = event.type;
  if (type === "message_start" || type === "message_update") {
    ctx.partial = updatePartial(ctx.partial, event);
    ctx.state.isStreaming = true; ctx.stateRevision++;
    scheduleRender();
  } else if (type === "message_end") {
    if (event.message?.role === "assistant") ctx.partial = null;
    requestRefresh(ctx);
  } else if (type === "agent_start") {
    ctx.state.isStreaming = true; ctx.stateRevision++; updateControls();
  } else if (["agent_end", "agent_settled", "turn_end"].includes(type)) {
    requestRefresh(ctx);
  } else if (type?.startsWith("tool_execution_")) {
    const previous = ctx.tools.get(event.toolCallId) || {};
    const result = event.result || event.partialResult || {};
    ctx.tools.set(event.toolCallId, { ...previous, ...result, toolName: event.toolName || previous.toolName, args: event.args || previous.args, running: type !== "tool_execution_end", isError: event.isError || false });
    if (type === "tool_execution_end") requestRefresh(ctx);
    scheduleRender();
  } else if (type === "queue_update") {
    ctx.state.pendingMessageCount = (event.steering?.length || 0) + (event.followUp?.length || 0); ctx.stateRevision++; updateControls();
  } else if (type === "extension_ui_request") {
    // Metadata, not replay, decides which dialogs are still pending.
    if (dialogMethods.has(event.method)) { ctx.uiRevision++; requestRefresh(ctx); }
    else if (event.method === "notify") showNotice(event.message || "Agent notification", event.notifyType === "error");
  } else if (type === "supervisor") {
    if (["extension_ui_expired", "extension_ui_resolved"].includes(event.event)) {
      ctx.uiRevision++;
      ctx.meta.pendingUi = (ctx.meta.pendingUi || []).filter((item) => item.id !== event.id);
      ctx.record.uiDrafts.delete(event.id); renderApprovals(ctx); requestRefresh(ctx);
      if (event.event === "extension_ui_expired") showNotice("An agent request expired before it was answered.");
    } else if (["child_exit", "protocol_error"].includes(event.event)) {
      ctx.ready = false; ctx.online = false; ctx.state.isStreaming = false; ctx.stateRevision++;
      showNotice(event.error || "The agent process has ended. Resume a saved session to continue.", true);
      ctx.streamController.abort(); updateControls();
    }
  } else if (type === "response" && ["set_model", "set_session_name", "abort", "prompt", "steer", "follow_up", "clear_queue"].includes(event.command)) {
    requestRefresh(ctx);
  } else if (["extension_error", "auto_retry_start"].includes(type)) {
    showNotice(event.error || event.errorMessage || "The agent is retrying a provider request.", true);
  } else if (type === "auto_retry_end" && event.success === false) {
    showNotice(event.finalError || "The provider request failed.", true); requestRefresh(ctx);
  } else if (type?.includes("compaction")) requestRefresh(ctx);
}

async function runSession(ctx) {
  let failures = 0;
  while (active(ctx)) {
    clearTimeout(ctx.refreshTimer); ctx.refreshTimer = null;
    ctx.connecting = true; ctx.online = false; ctx.ready = false; ctx.partial = null; ctx.tools.clear();
    setNetwork("reconnecting", failures ? "Reconnecting" : "Connecting"); updateControls();
    try {
      // Do not overlap a reconnect snapshot with a snapshot started by the old stream.
      while (ctx.refreshing && active(ctx)) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!active(ctx)) return;
      ctx.cursor = await snapshot(ctx, true);
      if (!active(ctx)) return;
      if (ctx.meta.status !== "running") { ctx.online = true; setNetwork("online", "Connected"); updateControls(); return; }
      ctx.connecting = false;
      ctx.streamController = new AbortController();
      let openedAt = 0;
      const abortStream = () => ctx.streamController.abort();
      ctx.controller.signal.addEventListener("abort", abortStream, { once: true });
      try {
        await api.events(`${path(ctx, "/events")}?after=${ctx.cursor}`, {
          signal: ctx.streamController.signal,
          onOpen: () => { if (active(ctx)) { ctx.online = true; openedAt = Date.now(); setNetwork("online", "Connected"); updateControls(); } },
          onEvent: (frame) => handleEvent(ctx, frame),
        });
      } finally {
        ctx.controller.signal.removeEventListener("abort", abortStream);
        if (openedAt && Date.now() - openedAt > 10_000) failures = 0;
      }
    } catch (error) {
      if (!active(ctx)) return;
      if ([401, 403, 404, 409, 413].includes(error.status)) {
        ctx.online = false; report(error, ctx); setNetwork("", "Access unavailable"); updateControls(); return;
      }
      if (!ctx.reset && error.name !== "AbortError") showNotice(`${error.message || "The connection was interrupted."} Reconnecting without resending prompts.`, true);
    } finally { ctx.connecting = false; }
    if (!active(ctx)) return;
    ctx.online = false; updateControls();
    if (ctx.reset) { ctx.reset = false; continue; }
    setNetwork("reconnecting", navigator.onLine ? "Reconnecting" : "Offline");
    const delay = Math.min(15_000, 750 * 2 ** Math.min(failures++, 5));
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); ctx.controller.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delay); ctx.controller.signal.addEventListener("abort", done, { once: true });
    });
  }
}
function activate(meta, { reconnect = false } = {}) {
  if (records.get(meta.id)?.ending) return;
  // Selecting the current conversation is navigation, not a reconnect request.
  if (!reconnect && current?.id === meta.id && active(current)) { drawer(false); return; }
  selection++;
  if (current) { current.controller.abort(); clearTimeout(current.refreshTimer); }
  const ctx = { id: meta.id, meta, record: record(meta.id), controller: new AbortController(), state: {}, stateRevision: 0, uiRevision: 0, tools: new Map(), partial: null, ready: false, online: false, cursor: 0 };
  current = ctx; followBottom = true;
  $("approvals").replaceChildren(); restoreDraft(); renderMessages(); renderSessions(); renderModels(ctx); drawer(false);
  showNotice(ctx.record.notice?.message || "", ctx.record.notice?.error);
  runSession(ctx);
  rpc(ctx, { type: "get_available_models" }).then((data) => {
    if (!active(ctx)) return;
    ctx.record.models = data?.models || []; renderModels(ctx);
  }).catch((error) => { if (active(ctx) && meta.status === "running") report(error, ctx, { command: "get_available_models" }); });
}

async function createSession(body) {
  if (createBusy || createDenied || !token) return;
  createBusy = true; const ownEpoch = epoch, ownSelection = selection;
  $("create-session").disabled = true; $("new-error").hidden = true; updateControls(); renderSessions();
  try {
    const { session } = await api.request("/v1/sessions", { body, signal: auth.signal });
    if (ownEpoch !== epoch) return;
    sessions.push(session); $("new-dialog").close();
    if (ownSelection === selection) activate(session);
    else renderSessions();
    refreshSessions();
  } catch (error) {
    if (ownEpoch !== epoch) return;
    if (error.code === "insufficient_scope") createDenied = true;
    const message = `${error.message}${!error.status || error.status >= 500 ? " Creation may have succeeded. Refresh the session list before trying again." : ""}`;
    $("new-error").textContent = message; $("new-error").hidden = false;
    report(new ApiError(message, error.status, error.code));
  } finally { if (ownEpoch === epoch) { createBusy = false; $("create-session").disabled = createDenied; updateControls(); renderSessions(); } }
}
async function resume(session) {
  const existing = sessions.find((item) => item.profile === session.profile && item.nativeSessionId === session.id && item.status === "running");
  if (existing) activate(existing);
  else await createSession({ profile: session.profile, resume: session.id });
}
function openNew() {
  if (!token || !profiles.length || createDenied || createBusy) return;
  drawer(false);
  $("new-error").hidden = true;
  $("new-profile").value = $("profile-filter").value || current?.meta.profile || profiles[0];
  $("new-dialog").showModal(); $("new-name").focus();
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ctx = current;
  if (!canWrite(ctx) || ctx.record.sending || ctx.record.readingImages) return;
  const draft = ctx.record.draft, text = draft.text.trim(), images = draft.images.slice(), version = draft.version, ownEpoch = epoch;
  if (!text && !images.length) return;
  if (images.length && ctx.state.model?.input && !ctx.state.model.input.includes("image")) { showNotice("The selected model does not accept images. Choose a vision-capable model or remove the attachments.", true); return; }
  const command = { type: "prompt", message: text, streamingBehavior: $("send-mode").value };
  if (images.length) command.images = images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  if (new TextEncoder().encode(JSON.stringify(command)).length > 7.5 * 1024 * 1024) { showNotice("This message is too large. Keep text and encoded attachments below 7.5 MiB.", true); return; }
  ctx.record.sending = true; updateControls();
  try {
    await rpc(ctx, command, true);
    if (ownEpoch !== epoch) return;
    if (draft.version === version) { draft.text = ""; draft.images = []; draft.version++; }
    ctx.record.notice = null;
    if (current?.record === ctx.record) { restoreDraft(); showNotice(current.state.isStreaming ? "Message accepted. The agent will pick it up according to your queue mode." : "Message accepted."); requestRefresh(current); }
  } catch (error) {
    if (ownEpoch !== epoch) return;
    if (current?.record === ctx.record) report(error, current, { write: true, command: "prompt", ambiguous: true });
    else ctx.record.notice = { message: `${error.message} Your draft was kept. The message may have been accepted; inspect this session before resending.`, error: true };
  } finally { if (ownEpoch === epoch) { ctx.record.sending = false; if (current?.record === ctx.record) { updateControls(); requestRefresh(current); } } }
});
$("prompt").addEventListener("input", () => { if (current) { current.record.draft.text = $("prompt").value; current.record.draft.version++; updateControls(); } });
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); if (!$("send").disabled) $("composer").requestSubmit();
  }
});
$("stop").addEventListener("click", async () => {
  const ctx = current;
  if (!canWrite(ctx, "abort") || ctx.stopping) return;
  ctx.stopping = true; updateControls();
  try {
    await rpc(ctx, { type: "abort" }, true);
    if (active(ctx)) { showNotice("Stop requested. Any queued follow-ups remain in the agent queue."); requestRefresh(ctx); }
  } catch (error) { report(error, ctx, { write: true, command: "abort", ambiguous: true }); }
  finally { if (active(ctx)) { ctx.stopping = false; updateControls(); } }
});
$("model").addEventListener("change", async () => {
  const ctx = current;
  if (!canWrite(ctx, "set_model") || ctx.modelBusy || ctx.state.isStreaming) return;
  const [provider, modelId] = JSON.parse($("model").value);
  ctx.modelBusy = true; updateControls();
  try { await rpc(ctx, { type: "set_model", provider, modelId }, true); if (active(ctx)) requestRefresh(ctx); }
  catch (error) { report(error, ctx, { write: true, command: "set_model", ambiguous: true }); }
  finally { if (active(ctx)) { ctx.modelBusy = false; renderModels(ctx); } }
});

$("end-session").addEventListener("click", () => {
  if (!current || deleteDenied || current.record.ending) return;
  endTarget = current;
  $("end-description").textContent = current.state.sessionName || current.meta.name || "Untitled session";
  $("end-dialog").showModal(); $("cancel-end").focus();
});
$("cancel-end").addEventListener("click", () => { $("end-dialog").close(); endTarget = null; });
$("end-dialog").addEventListener("cancel", () => { endTarget = null; });
$("end-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ctx = endTarget, ownEpoch = epoch;
  if (!ctx || !token || deleteDenied || ctx.record.ending) return;
  endTarget = null; $("end-dialog").close(); ctx.record.ending = true;
  if (current?.id === ctx.id) { current.controller.abort(); clearTimeout(current.refreshTimer); }
  updateControls(); renderSessions();
  try {
    try { await api.request(path(ctx), { method: "DELETE", signal: auth.signal }); }
    catch (error) { if (error.code !== "session_not_found") throw error; }
    if (ownEpoch !== epoch) return;
    sessions = sessions.filter((session) => session.id !== ctx.id);
    if (current?.id === ctx.id) {
      selection++; current = null; $("approvals").replaceChildren();
      $("model").replaceChildren(element("option", "", "No model selected"));
      restoreDraft(); renderMessages(); setNetwork("online", "Connected");
    }
    showNotice("Session ended. Runtime capacity released; saved conversations remain in history.");
    await refreshSessions();
  } catch (error) {
    if (ownEpoch !== epoch) return;
    if (error.code === "insufficient_scope") deleteDenied = true;
    ctx.record.ending = false;
    if (current?.id === ctx.id) activate(current.meta);
    report(new ApiError(`${error.message} The end request was not retried. Refresh sessions to check its outcome.`, error.status, error.code));
  } finally { if (ownEpoch === epoch) { ctx.record.ending = false; updateControls(); renderSessions(); } }
});

$("attach").addEventListener("click", () => $("image-files").click());
$("image-files").addEventListener("change", () => {
  const files = [...$("image-files").files]; $("image-files").value = ""; attachImages(files);
});
$("prompt").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  // Leave ordinary text paste alone, including text accompanying an image.
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  attachImages(files);
});
async function attachImages(files) {
  const ctx = current, ownEpoch = epoch;
  if (!files.length || !ctx || readOnly || ctx.record.ending || ctx.record.sending) return;
  if (ctx.record.readingImages) { showNotice("Wait for the current images to finish loading before adding more."); return; }
  ctx.record.readingImages = true; updateControls();
  try {
    const existing = ctx.record.draft.images.reduce((total, image) => total + image.size, 0);
    if (files.some((file) => !/^image\/(png|jpeg|webp|gif)$/.test(file.type))) throw new Error("Attach PNG, JPEG, WebP, or GIF images only.");
    if (existing + files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024) throw new Error("Keep image attachments below 5 MiB total (before base64 encoding).");
    const images = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onload = () => resolve({ name: file.name, size: file.size, mimeType: file.type, data: String(reader.result).split(",")[1] });
      reader.readAsDataURL(file);
    })));
    if (ownEpoch !== epoch) return;
    ctx.record.draft.images.push(...images); ctx.record.draft.version++;
    if (current?.record === ctx.record) restoreDraft();
  } catch (error) { if (ownEpoch === epoch) report(error, ctx); }
  finally { ctx.record.readingImages = false; if (current?.record === ctx.record) updateControls(); }
}

function logout(message = "") {
  epoch++; selection++; listVersion++;
  token = ""; auth.abort(); auth = new AbortController();
  if (current) { current.controller.abort(); clearTimeout(current.refreshTimer); }
  current = null; records.clear(); sessions = []; profiles = []; history = []; readOnly = false; createDenied = false; createBusy = false;
  deleteDenied = false; endTarget = null; $("end-dialog").close();
  $("create-session").disabled = false; $("end-description").textContent = "";
  $("token").value = ""; $("prompt").value = ""; $("image-files").value = ""; $("new-name").value = "";
  $("approvals").replaceChildren(); $("attachments").replaceChildren(); $("model").replaceChildren(element("option", "", "No model selected"));
  $("profile-filter").replaceChildren(element("option", "", "All profiles")); $("profile-filter").firstChild.value = "";
  $("new-profile").replaceChildren(); $("new-dialog").close(); drawer(false); showNotice("");
  renderMessages(); renderSessions(); updateControls(); setNetwork("", "Not connected");
  $("login-error").textContent = message; $("login-error").hidden = !message; $("login-submit").disabled = false;
  if (!$("login-dialog").open) $("login-dialog").showModal();
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if ($("login-submit").disabled) return;
  token = $("token").value.trim(); $("token").value = "";
  if (!token || /\s/.test(token)) { logout("Enter a bearer token without whitespace."); return; }
  const ownEpoch = ++epoch; $("login-submit").disabled = true; $("login-error").hidden = true;
  try {
    const result = await api.request("/v1/sessions", { signal: auth.signal });
    if (ownEpoch !== epoch) return;
    sessions = result.sessions || [];
    try { const result = await api.request("/v1/profiles", { signal: auth.signal }); if (ownEpoch === epoch) profiles = result.profiles || []; }
    catch (error) { if (error.status === 401) throw error; if (ownEpoch === epoch) showNotice(`Profiles unavailable: ${error.message} Existing sessions can still be opened.`, true); }
    if (ownEpoch !== epoch) return;
    for (const profile of profiles) {
      const option = element("option", "", profile); option.value = profile;
      $("profile-filter").append(option); $("new-profile").append(option.cloneNode(true));
    }
    $("login-dialog").close(); setNetwork("online", "Connected"); updateControls(); renderSessions(); refreshSessions();
  } catch (error) { if (ownEpoch === epoch) logout(error.message); }
  finally { if (ownEpoch === epoch) $("login-submit").disabled = false; }
});
$("login-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("logout").addEventListener("click", () => logout());
$("new-session").addEventListener("click", openNew);
$("cancel-new").addEventListener("click", () => $("new-dialog").close());
$("new-form").addEventListener("submit", (event) => { event.preventDefault(); const name = $("new-name").value.trim(); createSession({ profile: $("new-profile").value, ...(name ? { name } : {}) }); });
$("refresh-sessions").addEventListener("click", () => {
  refreshSessions();
  if (current?.online && current.ready) requestRefresh(current);
  else if (current) activate(current.meta, { reconnect: true });
});
$("profile-filter").addEventListener("change", () => { renderSessions(); refreshSessions(); });
$("dismiss-notice").addEventListener("click", () => { showNotice(""); if (current) current.record.notice = null; });
$("open-drawer").addEventListener("click", () => drawer(true));
$("close-drawer").addEventListener("click", () => { drawer(false); $("open-drawer").focus(); });
$("drawer-shade").addEventListener("click", () => drawer(false));
conversation.addEventListener("scroll", () => { followBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100; $("jump-latest").hidden = followBottom || !$("messages").childElementCount; }, { passive: true });
$("jump-latest").addEventListener("click", () => { followBottom = true; conversation.scrollTop = conversation.scrollHeight; $("jump-latest").hidden = true; });
for (const button of document.querySelectorAll(".starter")) button.addEventListener("click", () => {
  if (!current) { openNew(); return; }
  current.record.draft.text = button.dataset.prompt; current.record.draft.version++; restoreDraft(); $("prompt").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("sidebar").classList.contains("open")) { drawer(false); $("open-drawer").focus(); }
  if (event.key === "Tab" && $("sidebar").classList.contains("open")) {
    const controls = [...$("sidebar").querySelectorAll("button:not(:disabled), select:not(:disabled)")];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
  }
  if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.target.closest("input, textarea, select, [contenteditable], dialog")) openNew();
});
window.addEventListener("offline", () => { if (current) { current.online = false; current.streamController?.abort(); updateControls(); } setNetwork("reconnecting", "Offline"); });
window.addEventListener("online", () => { if (token) { if (current) activate(current.meta, { reconnect: true }); else setNetwork("online", "Connected"); refreshSessions(); } });
window.addEventListener("pagehide", () => logout());
logout();
