import { element, imageSource, renderMarkdown } from "./markdown.mjs";

// Render the persisted child conversation, not the task's capped stdout summary.
export function renderSubagentTranscript(entries) {
  const root = element("div", "messages subagent-messages");
  for (const entry of entries) {
    const message = entry?.message;
    if (!message || typeof message.role !== "string") continue;
    const article = element("article", `message ${message.role === "user" ? "user" : "assistant"}`);
    const header = element("header", "message-header");
    header.append(element("strong", "", message.role === "toolResult" ? `Tool result · ${message.toolName || "tool"}` : message.role));
    if (message.model) header.append(element("span", "message-model", `${message.provider || ""} / ${message.model}`));
    if (message.timestamp) {
      const date = new Date(message.timestamp);
      if (!Number.isNaN(date.getTime())) header.append(element("time", "", date.toLocaleString()));
    }
    const body = element("div", "message-content");
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [{ type: "text", text: message.summary || JSON.stringify(message, null, 2) }];
    for (const block of content) {
      if (block?.type === "text") body.append(renderMarkdown(block.text || ""));
      else if (block?.type === "image") {
        const src = imageSource(block);
        if (src) { const image = element("img", "message-image"); image.src = src; image.alt = "Child conversation image"; body.append(image); }
      } else if (block?.type === "thinking" || block?.type === "toolCall") {
        const details = element("details", block.type === "thinking" ? "thinking" : "tool-detail");
        details.append(element("summary", "", block.type === "thinking" ? "Thinking" : `Tool call · ${block.name || "tool"}`));
        details.append(element("pre", "", block.type === "thinking" ? block.thinking || "" : JSON.stringify(block.arguments ?? {}, null, 2)));
        body.append(details);
      } else body.append(element("pre", "", JSON.stringify(block, null, 2)));
    }
    if (message.isError) body.append(element("p", "message-error", "Tool reported an error."));
    article.append(header, body); root.append(article);
  }
  return root;
}

export function mountSubagentViewer(root, options) {
  const doc = root.ownerDocument;
  const view = element("section", "subagent-viewer");
  view.setAttribute("aria-label", `Subagent conversation: ${options.role || "child"}`);
  const header = element("header", "subagent-viewer-header");
  const back = element("button", "text-button", "← Back to main session"); back.type = "button";
  back.addEventListener("click", options.onClose);
  const title = element("div", "subagent-viewer-title");
  title.append(element("strong", "", options.role || "Subagent"), element("span", "field-note", options.taskId));
  const refresh = element("button", "text-button", "Refresh"); refresh.type = "button";
  header.append(back, title, refresh);
  const note = element("p", "subagent-viewer-note", "Read-only child conversation · main session continues in the background. No child process is started or resumed.");
  const status = element("p", "subagent-viewer-status", "Loading child conversation…"); status.setAttribute("role", "status");
  const body = element("div", "subagent-viewer-body"); body.tabIndex = 0;
  view.append(header, note, status, body);
  // Keep the parent mounted, including its composer, drafts and scroll position.
  const siblings = [...root.children].map(node => [node, node.inert]);
  for (const [node] of siblings) node.inert = true;
  const previousFocus = doc.activeElement;
  root.append(view); back.focus();
  const abort = new AbortController();
  const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  let disposed = false, pending = false, timer = null, signature = null;
  const valid = () => !disposed && (options.valid?.() ?? true);
  function dispose() {
    if (disposed) return;
    disposed = true; cancel(timer); abort.abort(); view.remove();
    for (const [node, inert] of siblings) node.inert = inert;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  async function load() {
    if (!valid()) { if (!disposed) options.onClose(); return; }
    if (pending) return;
    cancel(timer); pending = true; refresh.disabled = true;
    let keepPolling = true;
    try {
      const result = await options.request(`/v1/sessions/${encodeURIComponent(options.sessionId)}/subagents/${encodeURIComponent(options.taskId)}`, {
        signal: abort.signal, nativeSessionId: options.nativeSessionId,
      });
      if (!valid()) return;
      if (result.nativeSessionId !== options.nativeSessionId || result.taskId !== options.taskId || !Array.isArray(result.messages)) {
        throw Object.assign(new Error("Child conversation identity changed. Return to the main session and reopen it."), { status: 409 });
      }
      const next = JSON.stringify(result.messages);
      if (next !== signature) {
        const top = body.scrollTop;
        const atBottom = signature === null || body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        const open = [...body.querySelectorAll("details")].map(node => node.open);
        body.replaceChildren(renderSubagentTranscript(result.messages));
        [...body.querySelectorAll("details")].forEach((node, index) => { node.open = open[index] || false; });
        body.scrollTop = atBottom ? body.scrollHeight : top;
        signature = next;
      }
      status.textContent = result.messages.length ? "Viewing saved messages · updates every 2 seconds" : "Waiting for the child's first saved message…";
    } catch (error) {
      if (!valid() || abort.signal.aborted) return;
      status.textContent = error.message || "Child conversation unavailable. You can still return to the main session.";
      keepPolling = ![401, 403, 409].includes(error.status);
    } finally {
      pending = false;
      if (valid()) { refresh.disabled = false; if (keepPolling) timer = later(() => void load(), 2000); }
      else if (!disposed) options.onClose();
    }
  }
  refresh.addEventListener("click", () => void load());
  view.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); options.onClose(); }
  });
  void load();
  return { dispose, refresh: load };
}
