// Optional: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node web/browser-smoke.mjs
// Real browser + fake same-origin HTTP/SSE. No backend process, credentials, or LLM.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.SMOKE_OUTPUT_DIR || tmpdir();
assert.ok((await stat(output)).isDirectory(), "Screenshot output directory must already exist");
const models = [
  { provider: "fixture", id: "pi-fast", name: "Pi Fast", input: ["text", "image"] },
  { provider: "fixture", id: "pi-reasoning", name: "Pi Reasoning", input: ["text", "image"] },
];
const sessions = new Map(), saved = new Map(), calls = [], serverErrors = [];
const entryIds = new WeakMap();
function conversationSnapshot(session) {
  let parentId = null;
  const messages = session.messages.map((message) => {
    if (!entryIds.has(message)) entryIds.set(message, randomUUID());
    const entry = { entryId: entryIds.get(message), parentId, message };
    parentId = entry.entryId; return entry;
  });
  return { nativeSessionId: session.nativeSessionId, leafId: parentId, messages };
}
let tick = Date.now();
const json = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
const meta = (session) => ({ id: session.id, name: session.name, nativeSessionId: session.nativeSessionId, conversationReplacing: Boolean(session.conversationReplacing), profile: "default", cwd: "/workspace/project", status: "running", activity: session.pendingUi.some((item) => ["confirm", "select"].includes(item.method)) ? "waiting_action" : session.pendingUi.length ? "waiting_reply" : session.streaming ? "running" : "idle", latestEventId: session.cursor, settledEventId: session.settledEventId ?? null, autoMode: session.autoMode || { available: true, enabled: false }, pendingUi: session.pendingUi, createdAt: session.modifiedAt, lastActivityAt: session.modifiedAt });
function emit(session, event) {
  const frame = `id: ${++session.cursor}\nevent: pi\ndata: ${JSON.stringify(event)}\n\n`;
  session.events.push({ id: session.cursor, frame });
  if (event.type === "agent_settled") session.settledEventId = session.cursor;
  for (const response of session.clients) response.write(frame);
}
function complete(session, message) {
  session.messages.push(message);
  emit(session, { type: "message_end", message });
}
function update(session, delta) {
  emit(session, { type: "message_update", assistantMessageEvent: delta });
}
function requestUi(session, request) {
  const entry = { type: "extension_ui_request", id: randomUUID(), ...request };
  session.pendingUi.push(entry); emit(session, entry); return entry.id;
}
function resolveUi(session, id, event = "extension_ui_resolved") {
  session.pendingUi = session.pendingUi.filter((request) => request.id !== id);
  emit(session, { type: "supervisor", event, id });
}
function disconnect(session, reset = false) {
  for (const response of session.clients) {
    if (reset) response.write('event: reset\ndata: {"oldestEventId":1}\n\n');
    response.end();
  }
}
const staticFiles = new Map([["/", ["index.html", "text/html"]], ...["styles.css", "icon.svg", "app.mjs", "transport.mjs", "markdown.mjs", "subagents.mjs", "sidebar.mjs", "attention.mjs", "tool-display.mjs"].map((file) => [`/${file}`, [file, file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml"]])]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture.invalid");
    if (staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(await readFile(new URL(file, import.meta.url))); return;
    }
    if (request.headers.authorization !== "Bearer smoke-token") return json(response, 401, { error: { code: "unauthorized", message: "Invalid smoke token" } });
    let body;
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (url.pathname === "/v1/profiles") return json(response, 200, { profiles: ["default"] });
    if (url.pathname === "/v1/history") return json(response, 200, { sessions: [...saved.values()].map((session) => ({ id: session.nativeSessionId, name: session.name, profile: "default", cwd: "/workspace/project", modifiedAt: session.modifiedAt })) });
    if (url.pathname === "/v1/sessions") {
      if (request.method === "GET") return json(response, 200, { sessions: [...sessions.values()].map(meta) });
      calls.push({ method: "POST", path: url.pathname, body });
      const previous = saved.get(body.resume);
      const session = { id: randomUUID(), nativeSessionId: body.resume || randomUUID(), name: previous?.name || body.name || "Untitled session", modifiedAt: new Date().toISOString(), cursor: 0, pendingUi: [], messages: structuredClone(previous?.messages || []), events: [], clients: new Set(), model: models[0], streaming: false, queued: [], subscriptions: 0 };
      session.holdInitialSnapshot = !body.resume && session.name.includes("[slow snapshot]");
      sessions.set(session.id, session); saved.set(session.nativeSessionId, session);
      return json(response, 201, { session: meta(session) });
    }
    const match = /^\/v1\/sessions\/([^/]+)(?:\/(rpc|ui|events|conversation|auto))?$/.exec(url.pathname);
    const session = match && sessions.get(match[1]);
    if (!session) return json(response, 404, { error: { code: "session_not_found", message: "Session not found" } });
    if (match[2] === "conversation") {
      const snapshot = conversationSnapshot(session);
      calls.push({ id: session.id, conversation: request.method, body });
      if (request.method === "GET") return json(response, 200, snapshot);
      assert.equal(request.method, "POST");
      assert.deepEqual(Object.keys(body).sort(), ["action", "entryId", "expectedLeafId", "expectedNativeSessionId"]);
      if (body.expectedNativeSessionId !== snapshot.nativeSessionId || body.expectedLeafId !== snapshot.leafId) return json(response, 409, { error: { code: "conversation_stale", message: "Conversation changed; refresh before trying again." } });
      if (session.streaming || session.queued.length || session.pendingUi.length || session.conversationReplacing) return json(response, 409, { error: { code: "conversation_locked", message: "Conversation is busy." } });
      if (session.failConversation) return json(response, 503, { error: { code: "fixture_failure", message: "Fixture replacement failed." } });
      const index = snapshot.messages.findIndex((entry) => entry.entryId === body.entryId && entry.message.role === "user");
      assert.ok(index >= 0); assert.ok(["fork", "revert"].includes(body.action));
      const content = snapshot.messages[index].message.content;
      const draft = { text: typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), images: typeof content === "string" ? [] : content.filter((block) => block.type === "image") };
      if (session.holdConversation) await new Promise((resolve) => { session.releaseConversation = resolve; });
      let destination;
      if (body.action === "fork") {
        destination = { ...session, id: randomUUID(), nativeSessionId: randomUUID(), name: `${session.name} fork`, cursor: 0, events: [], clients: new Set(), subscriptions: 0, messages: structuredClone(session.messages.slice(0, index)), pendingUi: [], queued: [], holdConversation: false, releaseConversation: null };
        sessions.set(destination.id, destination);
      } else {
        session.conversationReplacing = true;
        emit(session, { type: "supervisor", event: "conversation_replacing" });
        emit(session, { type: "supervisor", event: "conversation_source_exited" });
        disconnect(session);
        await new Promise((resolve) => { session.finishReplacement = resolve; });
        saved.set(session.nativeSessionId, { ...session, messages: structuredClone(session.messages) });
        session.nativeSessionId = randomUUID(); session.messages = session.messages.slice(0, index);
        session.events = []; session.conversationReplacing = false;
        emit(session, { type: "supervisor", event: "conversation_changed", nativeSessionId: session.nativeSessionId });
        destination = session;
      }
      saved.set(destination.nativeSessionId, destination);
      return json(response, 200, { session: meta(destination), draft });
    }
    if (request.method === "POST" && (match[2] === "auto" || match[2] === "ui" || (match[2] === "rpc" && !["get_state", "get_messages", "get_available_models"].includes(body.type)))) {
      assert.equal(request.headers["x-pi-session-id"], session.nativeSessionId, "web writes carry the current native session ID");
    }
    if (match[2] === "auto" && request.method === "POST") {
      assert.deepEqual(Object.keys(body), ["enabled"]); assert.equal(typeof body.enabled, "boolean");
      calls.push({ id: session.id, auto: body });
      session.autoMode = { available: true, enabled: body.enabled };
      emit(session, { type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-auto", statusText: JSON.stringify(session.autoMode) });
      return json(response, 200, { autoMode: session.autoMode });
    }
    if (request.method === "DELETE") {
      calls.push({ id: session.id, method: "DELETE" });
      disconnect(session); sessions.delete(session.id);
      response.writeHead(204); response.end(); return;
    }
    if (!match[2]) { calls.push({ id: session.id, method: "GET" }); return json(response, 200, { session: meta(session) }); }
    if (match[2] === "events") {
      session.subscriptions++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }); response.flushHeaders();
      response.write(": connected\n\n");
      for (const event of session.events) if (event.id > Number(url.searchParams.get("after") || 0)) response.write(event.frame);
      session.clients.add(response); response.on("close", () => session.clients.delete(response)); return;
    }
    if (match[2] === "ui") {
      const pending = session.pendingUi.find((request) => request.id === body.id);
      calls.push({ id: session.id, ui: body }); resolveUi(session, body.id);
      if (pending?.method === "select" && body.value === "2. Other (type an answer)") requestUi(session, { method: "input", title: pending.title, placeholder: "Type your answer" });
      return json(response, 202, { accepted: true });
    }
    calls.push({ id: session.id, command: body });
    let data;
    if (body.type === "get_state") data = { sessionId: session.nativeSessionId, sessionName: session.name, model: session.model, isStreaming: session.streaming, pendingMessageCount: session.queued.length };
    else if (body.type === "get_messages") {
      if (session.holdInitialSnapshot && !session.initialSnapshotResponse) {
        session.initialSnapshotResponse = response;
        await new Promise((resolve) => { session.releaseSnapshot = resolve; });
      }
      data = { messages: session.messages };
    }
    else if (body.type === "get_available_models") data = { models };
    else if (body.type === "set_model") { session.model = models.find((model) => model.id === body.modelId); data = session.model; }
    else if (body.type === "abort") { session.streaming = false; emit(session, { type: "agent_end" }); }
    else if (body.type === "prompt") {
      if (session.streaming) {
        session.queued.push(body.message);
        emit(session, { type: "queue_update", steering: [], followUp: session.queued });
      } else {
        session.streaming = true;
        complete(session, { role: "user", content: [{ type: "text", text: body.message }, ...(body.images || [])], timestamp: ++tick });
        emit(session, { type: "agent_start" });
        session.partial = { role: "assistant", content: [], timestamp: ++tick };
        emit(session, { type: "message_start", message: session.partial });
      }
      if (body.message === "ambiguous acceptance") {
        // Break the response after headers, not an empty socket that Chromium
        // may transparently retry before exposing the response to fetch.
        response.writeHead(200, { "Content-Type": "application/json" }); response.write("{");
        setTimeout(() => response.destroy(), 30); return;
      }
      if (body.message === "delayed acceptance") await new Promise((resolve) => { session.releasePrompt = resolve; });
    } else throw new Error(`Unhandled fixture command ${body.type}`);
    const result = { type: "response", command: body.type, success: true, ...(data === undefined ? {} : { data }) };
    // Match the supervisor: read snapshots are HTTP-only, not SSE replay data.
    if (!["get_state", "get_messages", "get_available_models"].includes(body.type)) emit(session, result);
    json(response, 200, result);
  } catch (error) { serverErrors.push(error.stack); if (!response.headersSent) json(response, 500, { error: { message: error.message } }); else response.destroy(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });

async function until(check, label) {
  const deadline = Date.now() + 12_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function login(page, token = "smoke-token") {
  await page.locator("#token").fill(token); await page.locator("#login-submit").click();
  if (token === "smoke-token") await page.locator("#login-dialog").waitFor({ state: "hidden" });
  else await page.locator("#login-error").waitFor({ state: "visible" });
}
async function noOverflow(page) {
  assert.deepEqual(await page.evaluate(() => {
    const main = document.querySelector(".main");
    return { document: document.documentElement.scrollWidth <= innerWidth, workspace: main.scrollWidth <= main.clientWidth };
  }), { document: true, workspace: true });
}

try {
  for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: label === "mobile", hasTouch: label === "mobile", deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    const errors = [];
    const watch = (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    };
    watch(page);
    const openSidebar = async () => { if (label === "mobile") await page.locator("#open-drawer").click(); };
    const drawerClosed = async () => assert.deepEqual(await page.evaluate(() => ({
      open: document.querySelector("#sidebar").classList.contains("open"),
      expanded: document.querySelector("#open-drawer").getAttribute("aria-expanded"),
      shade: document.querySelector("#drawer-shade").hidden,
      inert: document.querySelector(".main").inert,
    })), { open: false, expanded: "false", shade: true, inert: false }, "selection closes drawer and restores composer interaction");
    const creations = () => calls.filter((call) => call.method === "POST" && call.path === "/v1/sessions").length;
    const traffic = (session) => ({
      subscriptions: session.subscriptions,
      metadata: calls.filter((call) => call.id === session.id && call.method === "GET").length,
      rpc: calls.filter((call) => call.id === session.id && call.command).map((call) => call.command.type),
      creations: creations(),
    });
    try {
      await page.goto(origin); await login(page, "wrong-token");
      assert.equal(await page.locator("#token").inputValue(), "");
      await login(page); await noOverflow(page);
      if (label === "desktop") {
        const handle = page.locator("#sidebar-resizer"), box = await handle.boundingBox();
        const before = await page.locator("#sidebar").evaluate((node) => node.getBoundingClientRect().width);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2); await page.mouse.up();
        assert.equal(await page.locator("#sidebar").evaluate((node) => node.getBoundingClientRect().width), before + 60);
        await handle.press("ArrowLeft");
        assert.equal(await handle.getAttribute("aria-valuenow"), String(before + 50));
        await noOverflow(page);
      } else assert.equal(await page.locator("#sidebar-resizer").isVisible(), false);
      await openSidebar(); await page.locator("#new-session").click();
      const sessionName = `${label} coding session [slow snapshot]`;
      await page.locator("#new-name").fill(sessionName);
      await page.locator("#create-session").click();
      await until(() => [...sessions.values()].some((session) => session.name === sessionName && session.releaseSnapshot), "initial get_messages reached fixture gate");
      const session = [...sessions.values()].find((session) => session.name === sessionName);
      assert.ok(session);
      await until(() => calls.some((call) => call.id === session.id && call.command?.type === "get_state") && calls.some((call) => call.id === session.id && call.command?.type === "get_available_models"), "other initial RPCs arrived");
      const initialTraffic = traffic(session);
      await page.locator("#prompt").fill("Draft while syncing");
      for (let click = 0; click < 3; click++) {
        await openSidebar(); await page.locator(".session-item").filter({ hasText: session.name }).click();
        await drawerClosed();
        assert.equal(await page.locator("#prompt").inputValue(), "Draft while syncing");
      }
      // Give accidental restarts time to reach the fixture before releasing the original read.
      await page.waitForTimeout(250);
      assert.deepEqual(traffic(session), initialTraffic, "same-session clicks during initial snapshot do not restart any requests");
      assert.equal(session.initialSnapshotResponse.destroyed, false, "initial get_messages was not aborted");
      assert.equal(session.subscriptions, 0, "SSE waits for the original snapshot");
      assert.equal(await page.locator("#session-status").textContent(), "SYNCING");
      session.releaseSnapshot();
      await until(() => session.clients.size === 1 && page.locator("#connection-label").textContent().then((text) => text === "Connected"), "initial stream connected");
      await until(() => page.locator("#session-status").textContent().then((text) => text === "READY"), "session ready");
      assert.equal(session.subscriptions, 1);
      assert.equal(await page.locator("#auto-mode").getAttribute("aria-pressed"), "false");
      await page.locator("#auto-mode").click();
      await until(() => page.locator("#auto-mode").getAttribute("aria-pressed").then((value) => value === "true"), "auto on confirmed");
      await until(() => page.locator("#auto-mode").isEnabled(), "auto toggle ready");
      await page.locator("#auto-mode").click();
      await until(() => page.locator("#auto-mode").getAttribute("aria-pressed").then((value) => value === "false"), "auto off confirmed");
      assert.deepEqual(calls.filter((call) => call.id === session.id && call.auto).map((call) => call.auto.enabled), [true, false]);
      await page.locator("#model").selectOption(JSON.stringify(["fixture", "pi-reasoning"]));
      await until(() => page.locator("#model").inputValue().then((value) => value.includes("pi-reasoning")), "model switched");
      await until(() => session.model.id === "pi-reasoning", "model RPC");

      // Let the model-change snapshot settle before measuring click-only traffic.
      await page.waitForTimeout(250);
      const healthyTraffic = traffic(session), healthyStream = [...session.clients][0];
      await page.locator("#prompt").fill("Keep this selected-session draft");
      for (let click = 0; click < 3; click++) {
        await openSidebar(); await page.locator(".session-item").filter({ hasText: session.name }).click();
        await drawerClosed();
        assert.equal(await page.locator("#model").inputValue(), JSON.stringify(["fixture", "pi-reasoning"]), "same-session click preserves model");
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this selected-session draft");
        assert.equal(await page.locator("#session-status").textContent(), "READY");
      }
      await page.waitForTimeout(250);
      assert.deepEqual(traffic(session), healthyTraffic, "healthy same-session clicks send no snapshot/model RPCs, metadata reads, SSE connections, or creation POSTs");
      assert.deepEqual([...session.clients], [healthyStream], "same-session clicks keep the original stream open");

      session.messages.push({ role: "user", content: [{ type: "text", text: "Snapshot-only fixture message" }], timestamp: ++tick });
      await openSidebar(); await page.locator("#refresh-sessions").click();
      await until(() => page.locator("#messages").textContent().then((text) => text.includes("Snapshot-only fixture message")), "healthy Refresh fetches new snapshot without an SSE event");
      await page.waitForTimeout(250);
      assert.deepEqual(traffic(session), { ...healthyTraffic, metadata: healthyTraffic.metadata + 1, rpc: [...healthyTraffic.rpc, "get_messages", "get_state"] }, "healthy Refresh fetches exactly one snapshot, not models or a new stream");
      assert.deepEqual([...session.clients], [healthyStream], "Refresh keeps the original stream open");
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this selected-session draft");
      assert.equal(await page.locator("#model").inputValue(), JSON.stringify(["fixture", "pi-reasoning"]));
      if (label === "mobile") await page.locator("#close-drawer").click();

      // Paste a real raster File through the browser's clipboard event path.
      await page.locator("#prompt").evaluate((input) => {
        const data = new DataTransfer();
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
        data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.locator(".attachment img").waitFor();
      await page.locator("#prompt").fill("Inspect the project");
      await page.locator("#prompt").press("Shift+Enter"); await page.locator("#prompt").press("a");
      assert.equal(await page.locator("#prompt").inputValue(), "Inspect the project\na");
      await page.locator("#prompt").press("Enter");
      await until(() => session.streaming, "prompt accepted");
      await until(() => page.locator("#prompt").inputValue().then((value) => value === ""), "accepted draft cleared");
      assert.equal(await page.locator("#notice").isVisible(), false, "successful prompts do not show an acceptance bar");
      assert.equal(calls.find((call) => call.id === session.id && call.command?.type === "prompt").command.images[0].mimeType, "image/png");
      update(session, { type: "text_delta", contentIndex: 0, delta: "Inspecting " });
      await until(() => page.locator("#messages").textContent().then((text) => text.includes("Inspecting")), "first streaming delta");
      // A snapshot during a stream contains no partial; later deltas must still render.
      await until(() => calls.some((call) => call.id === session.id && call.command?.type === "get_messages"), "message snapshot");
      update(session, { type: "text_delta", contentIndex: 0, delta: "the repository." });
      await until(() => page.locator("#messages").textContent().then((text) => text.includes("Inspecting the repository.")), "continued streaming delta");
      assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
      await page.locator("#send-mode").selectOption("followUp");
      await page.locator("#prompt").fill("Then check tests"); await page.locator("#prompt").press("Enter");
      await until(() => session.queued.length === 1, "follow-up queued");

      update(session, { type: "thinking_delta", contentIndex: 1, delta: "  " });
      await page.waitForTimeout(100);
      assert.equal(await page.locator(".thinking").count(), 0, "empty thinking is hidden");
      update(session, { type: "thinking_delta", contentIndex: 1, delta: "Check entry points and tests first." });
      await page.locator(".thinking").waitFor();
      const tool = { type: "toolCall", id: `call-${label}`, name: "read", arguments: { path: "src/main.mjs" } };
      update(session, { type: "toolcall_start", contentIndex: 2, id: tool.id, toolName: tool.name });
      update(session, { type: "toolcall_end", contentIndex: 2, toolCall: tool });
      complete(session, { ...session.partial, content: [{ type: "text", text: "Inspecting the repository.\n\n```js\nconst safe = '<script>not HTML</script>';\n```" }, { type: "thinking", thinking: "Check entry points and tests first." }, tool], stopReason: "toolUse" });
      emit(session, { type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.arguments });
      const approvalId = requestUi(session, { method: "confirm", title: "Allow reading the entry point?", message: "Pi wants to inspect src/main.mjs", timeout: 60_000 });
      await page.locator(".approval").waitFor();
      assert.equal(await page.locator(".tool-preview").first().textContent(), "src/main.mjs");
      assert.equal(await page.locator(".tool-detail").first().getAttribute("open"), null, "path is visible without expanding");
      assert.equal(await page.locator("#composer").isVisible(), false);
      assert.equal(await page.locator(".activity").isVisible(), false);
      await noOverflow(page);
      await page.screenshot({ path: join(output, `pi-workspace-${label}.png`), fullPage: true });

      // Another browser must clear its approval when the first browser answers.
      const observer = await context.newPage(); watch(observer);
      await observer.goto(origin); await login(observer);
      if (label === "mobile") await observer.locator("#open-drawer").click();
      await observer.locator(".session-item").filter({ hasText: session.name }).click();
      await observer.locator(".approval").waitFor();
      await page.locator("#auto-mode").click();
      await until(() => observer.locator("#auto-mode").getAttribute("aria-pressed").then((value) => value === "true"), "auto mode synchronized across tabs");
      assert.equal(await observer.locator(".approval").count(), 1, "toggling auto does not answer an existing approval");
      await noOverflow(page);
      await page.locator(".approval .approve").click();
      await observer.locator(".approval").waitFor({ state: "hidden" });
      assert.ok(calls.some((call) => call.ui?.id === approvalId && call.ui.confirmed));
      await observer.close();
      for (const [method, value] of [["select", "Allow once"], ["input", "test input"], ["editor", "edited approval\nsecond line"]]) {
        const id = requestUi(session, { method, title: `Approval ${method}`, options: ["Deny", "Allow once"], prefill: method === "editor" ? "original" : undefined });
        const card = page.locator(`.approval[data-id="${id}"]`); await card.waitFor();
        if (method === "select") await card.locator("select").selectOption(value);
        else await card.locator("input, textarea").fill(value);
        if (method === "editor") {
          const before = session.subscriptions; disconnect(session, true);
          await until(() => session.subscriptions > before, "SSE reset resubscription");
          await until(() => page.locator("#connection-label").textContent().then((text) => text === "Connected"), "reconnect ready");
          assert.equal(await card.locator("textarea").inputValue(), value);
        }
        await card.locator(".approve").click(); await card.waitFor({ state: "hidden" });
        assert.ok(calls.some((call) => call.ui?.id === id && call.ui.value === value));
      }
      await page.locator("#prompt").fill("Keep my chat draft");
      const otherId = requestUi(session, { method: "select", title: "What next?", options: ["1. Review", "2. Other (type an answer)"] });
      await page.locator(".approval select").selectOption("2. Other (type an answer)");
      await page.locator('.approval input[placeholder="Type your answer"]').fill("Run the integration tests instead");
      assert.equal(await page.locator("#composer").isVisible(), false);
      await noOverflow(page);
      await page.screenshot({ path: join(output, `pi-question-${label}.png`), fullPage: true });
      await page.locator(".approval .approve").click();
      await page.locator(".approval").waitFor({ state: "hidden" });
      assert.ok(calls.some((call) => call.ui?.id === otherId && call.ui.value === "2. Other (type an answer)"));
      assert.ok(calls.some((call) => call.id === session.id && call.ui?.value === "Run the integration tests instead"));
      assert.equal(await page.locator("#prompt").inputValue(), "Keep my chat draft");
      assert.equal(await page.locator("#composer").isVisible(), true);

      const delegated = { type: "toolCall", id: `delegated-${label}`, name: "task", arguments: { jobs: [{ role: "explore", prompt: "Inspect sources" }, { role: "explore", prompt: "Inspect tests" }] } };
      emit(session, { type: "tool_execution_start", toolCallId: delegated.id, toolName: "task", args: delegated.arguments });
      emit(session, { type: "tool_execution_update", toolCallId: delegated.id, toolName: "task", partialResult: { details: { jobs: [
        { role: "explore", prompt: "Inspect sources", status: "running", taskId: "child-one", steps: 1, output: "Reading sources" },
        { role: "explore", prompt: "Inspect tests", status: "completed", taskId: "child-two", steps: 2, output: "Tests inspected" },
      ] } } });
      await until(() => page.locator(".subagents").textContent().then((text) => text.includes("Tests inspected")), "child progress inline");
      assert.deepEqual(await page.locator(".subagents summary").allTextContents(), ["1. explorerunning", "2. explorecompleted"]);
      await page.locator(".subagents summary").first().click();
      await page.locator(".subagents summary").last().click();
      assert.equal(await page.locator("#session-title").textContent(), session.name);
      await noOverflow(page);
      const expired = requestUi(session, { method: "confirm", title: "Expiring request", timeout: 100 });
      await page.locator(".approval").waitFor(); resolveUi(session, expired, "extension_ui_expired");
      await page.locator(".approval").waitFor({ state: "hidden" });
      const cancelled = requestUi(session, { method: "input", title: "Cancel this request" });
      await page.locator(".approval").waitFor(); await page.locator(".approval button").filter({ hasText: "Cancel" }).click();
      await until(() => calls.some((call) => call.ui?.id === cancelled && call.ui.cancelled), "approval cancellation");
      const result = { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "export function main() { return true; }" }], timestamp: ++tick };
      emit(session, { type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result }); complete(session, result);
      await page.locator("#stop").click();
      await until(() => !session.streaming, "abort command");
      await until(() => page.locator("#session-status").textContent().then((text) => text === "READY"), "idle after stop");
      assert.equal(await page.locator("article.assistant").count(), 1);
      assert.equal(await page.locator("#messages script").count(), 0);
      const before = session.subscriptions; disconnect(session);
      await until(() => session.subscriptions > before, "EOF reconnect");
      await until(() => page.locator("#connection-label").textContent().then((text) => text === "Connected"), "EOF ready");
      assert.equal(await page.locator("article.assistant").count(), 1);

      // An ambiguous accepted write must keep its draft and must not be retried.
      await page.locator("#prompt").fill("ambiguous acceptance"); await page.locator("#prompt").press("Enter");
      await until(() => page.locator("#notice-text").textContent().then((text) => text.includes("Nothing was retried")), "ambiguous write warning");
      assert.equal(await page.locator("#prompt").inputValue(), "ambiguous acceptance");
      assert.equal(calls.filter((call) => call.id === session.id && call.command?.message === "ambiguous acceptance").length, 1);

      await page.locator("#end-session").click(); await page.locator("#cancel-end").click();
      assert.ok(sessions.has(session.id), "cancelling confirmation keeps process");
      await page.locator("#end-session").click(); await page.locator("#end-form button[type=submit]").click();
      await until(() => !sessions.has(session.id), "DELETE frees runtime session");
      await until(() => page.locator("#session-title").textContent().then((text) => text === "Pi coding workspace"), "ended selection cleared");
      await openSidebar();
      const historical = page.locator(".session-item").filter({ hasText: session.name });
      await page.locator("#refresh-sessions").click();
      await new Promise((resolve) => setTimeout(resolve, 1700));
      assert.equal(await historical.count(), 0, "ended session stays removed after history refresh and polling");
      assert.ok(saved.has(session.nativeSessionId), "ending does not delete saved history");
      await page.locator("#logout").click();
      await page.locator("#token").fill("smoke-token"); await page.locator("#login-submit").click();
      await openSidebar(); await historical.waitFor();
      await historical.click();
      await until(() => page.locator("#session-status").textContent().then((text) => text === "READY"), "history resumed");
      const resumed = [...sessions.values()].find((entry) => entry.nativeSessionId === session.nativeSessionId);
      assert.ok(resumed && resumed.id !== session.id);
      assert.equal(await page.locator("article.assistant").count(), 1);
      await noOverflow(page);
      if (label === "mobile") {
        await page.setViewportSize({ width: 360, height: 780 }); await noOverflow(page);
        await page.setViewportSize(viewport);
      }
      // Resolve an old session's write only after a different session has a draft.
      await page.locator("#prompt").fill("delayed acceptance"); await page.locator("#prompt").press("Enter");
      await until(() => Boolean(resumed.releasePrompt), "delayed write arrived");
      await openSidebar(); await page.locator("#new-session").click();
      await page.locator("#new-name").fill(`${label} other session`); await page.locator("#create-session").click();
      await until(() => page.locator("#session-title").textContent().then((text) => text === `${label} other session`), "other session selected");
      await page.locator("#prompt").fill("Keep this other draft");
      assert.equal(await page.locator("#auto-mode").getAttribute("aria-pressed"), "false", "another session starts with auto off");
      await openSidebar();
      const backgroundRow = page.locator(".session-item").filter({ hasText: resumed.name });
      resumed.streaming = true;
      await until(() => backgroundRow.textContent().then((text) => text.includes("Running")), "background running status");
      const backgroundUi = requestUi(resumed, { method: "input", title: "Background question" });
      await until(() => backgroundRow.textContent().then((text) => text.includes("Waiting for user reply")), "background reply status");
      assert.equal(await page.title(), "1! | Pi Agent | Agentbox", "text questions count as required user action");
      resolveUi(resumed, backgroundUi);
      const backgroundApproval = requestUi(resumed, { method: "confirm", title: "Background approval" });
      await until(() => backgroundRow.textContent().then((text) => text.includes("Waiting for user action")), "background action status");
      assert.equal(await page.title(), "1! | Pi Agent | Agentbox");
      resolveUi(resumed, backgroundApproval); resumed.streaming = false;
      emit(resumed, { type: "agent_settled" });
      await until(() => backgroundRow.textContent().then((text) => text.includes("Idle (finished)")), "background finished status");
      assert.equal(await page.title(), "1 | Pi Agent | Agentbox", "unread background completion updates the tab");
      assert.equal(resumed.clients.size, 0, "background progress does not consume SSE connections");
      if (label === "mobile") await page.locator("#close-drawer").click();
      resumed.releasePrompt();
      await until(() => calls.some((call) => call.id !== resumed.id && call.command?.type === "get_state"), "other session snapshot");
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this other draft");
      assert.equal(await page.locator("#session-title").textContent(), `${label} other session`);
      const other = [...sessions.values()].find((entry) => entry.name === `${label} other session`);
      await until(() => other.clients.size === 1 && resumed.clients.size === 0, "creating another session closes prior stream");
      const creationCount = creations(), runtimeIds = [...sessions.keys()].sort();
      const resumedSubscriptions = resumed.subscriptions, otherSubscriptions = other.subscriptions;
      await openSidebar(); await page.locator(".session-item").filter({ hasText: session.name }).click();
      await drawerClosed();
      await until(() => resumed.clients.size === 1 && other.clients.size === 0, "switch subscribes to existing session and closes other stream");
      assert.equal(resumed.subscriptions, resumedSubscriptions + 1);
      assert.equal(await page.title(), "Pi Agent | Agentbox", "entering a session clears its counter");
      assert.equal(other.subscriptions, otherSubscriptions);
      assert.equal(creations(), creationCount, "switching to a running session sends no creation/resume POST");
      assert.deepEqual([...sessions.keys()].sort(), runtimeIds, "switching does not create a duplicate runtime process");
      await until(() => page.locator("#prompt").inputValue().then((text) => text === ""), "accepted original draft cleared on return");
      await openSidebar(); await page.locator(".session-item").filter({ hasText: `${label} other session` }).click();
      await drawerClosed();
      await until(() => other.clients.size === 1 && resumed.clients.size === 0, "return switches subscription and closes prior stream");
      assert.equal(other.subscriptions, otherSubscriptions + 1);
      assert.equal(resumed.subscriptions, resumedSubscriptions + 1);
      assert.equal(creations(), creationCount, "return sends no creation/resume POST");
      assert.deepEqual([...sessions.keys()].sort(), runtimeIds, "return does not create a duplicate runtime process");
      assert.equal(await page.locator("#prompt").inputValue(), "Keep this other draft");
      // Exercise history actions separately from the original streaming/history fixtures.
      const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" };
      const raw = "Raw **markdown** and `code`\n\n```js\nconst copied = true;\n```";
      complete(other, { role: "user", content: "Retained prefix", timestamp: ++tick });
      complete(other, { role: "assistant", model: "pi-reasoning", provider: "historical-provider", responseModel: "actual-response-model", content: [{ type: "text", text: raw }, { type: "thinking", thinking: "SECRET THINKING" }, { type: "toolCall", id: `copy-${label}`, name: "read", arguments: { path: "SECRET TOOL" } }], timestamp: ++tick });
      complete(other, { role: "user", content: [{ type: "text", text: "Restore this **raw** draft" }, image], timestamp: ++tick });
      complete(other, { role: "assistant", content: [{ type: "text", text: "Discarded old response" }], timestamp: ++tick });
      const target = page.locator("article.user").filter({ hasText: "Restore this" });
      const action = (kind) => target.locator(`[data-conversation-action="${kind}"]`);
      const ready = async (tab = page) => until(async () => await tab.locator("#session-status").textContent() === "READY" && await tab.locator("#connection-label").textContent() === "Connected", "conversation ready");
      const mutations = () => calls.filter((call) => call.id === other.id && call.conversation === "POST");
      await target.waitFor(); await ready();
      assert.equal(await page.locator(".message-model").textContent(), "pi-reasoning / historical-provider");
      assert.equal(await page.locator(".message-model").getAttribute("title"), "Response model: actual-response-model");
      assert.equal(await page.locator("#model").inputValue(), JSON.stringify(["fixture", "pi-fast"]), "historical label differs from selected model");
      // Actual legacy copy with the secure-context Clipboard API unavailable.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        const exec = document.execCommand.bind(document);
        document.execCommand = (command) => {
          const input = document.activeElement;
          const text = input.value.slice(input.selectionStart, input.selectionEnd);
          const copied = exec(command);
          if (copied) window.legacyCopied = text;
          return copied;
        };
      });
      const responseCopy = page.getByRole("button", { name: "Copy response", exact: true }).first();
      await responseCopy.click();
      await until(() => page.evaluate(() => window.legacyCopied).then((text) => text === raw), "message copied without Clipboard API");
      assert.equal(await page.locator("#copy-dialog").isVisible(), false);
      assert.equal(await responseCopy.evaluate((button) => document.activeElement === button), true, "copy restores focus");
      assert.equal(await page.locator(".clipboard-copy").count(), 0, "temporary text is removed");
      const codeCopy = page.locator(".code-heading button").first();
      await codeCopy.click();
      await until(() => page.evaluate(() => window.legacyCopied).then((text) => text === "const copied = true;"), "code copied without Clipboard API");
      await page.evaluate(() => {
        document.execCommand = () => false;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedText = text; } } });
      });
      await page.getByRole("button", { name: "Copy response", exact: true }).first().click();
      await until(() => page.evaluate(() => window.copiedText === undefined ? false : true), "clipboard write");
      assert.equal(await page.evaluate(() => window.copiedText), raw, "copy contains raw markdown, not thinking or tools");
      await target.getByRole("button", { name: "Copy message", exact: true }).click();
      await until(() => page.evaluate(() => window.copiedText).then((text) => text === "Restore this **raw** draft"), "user text copied without image");
      await codeCopy.click();
      await until(() => page.evaluate(() => window.copiedText).then((text) => text === "const copied = true;"), "modern code copy fallback");
      await page.evaluate(() => {
        document.execCommand = () => { throw new Error("Legacy copy unavailable"); };
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Clipboard denied"); } } });
      });
      await page.getByRole("button", { name: "Copy response", exact: true }).first().click();
      await page.locator("#copy-dialog").waitFor();
      assert.equal(await page.locator("#copy-text").inputValue(), raw);
      assert.equal(await page.locator("#copy-text").evaluate((node) => node.value.slice(node.selectionStart, node.selectionEnd)), raw);
      await noOverflow(page); await page.locator("#close-copy").click();
      await codeCopy.click();
      await until(() => codeCopy.textContent().then((text) => text === "Selected: copy manually"), "manual code copy fallback");
      assert.equal(await page.evaluate(() => window.getSelection().toString()), "const copied = true;");
      assert.equal(await page.locator(".clipboard-copy").count(), 0);
      for (const kind of ["fork", "revert"]) {
        await action(kind).click(); await page.locator("#conversation-action-dialog").waitFor();
        assert.equal(await page.locator("#conversation-action-preview").textContent(), "Restore this **raw** draft");
        await page.locator("#cancel-conversation-action").click();
        assert.equal(mutations().length, 0, "cancel never mutates");
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this other draft");
      }
      other.streaming = true; emit(other, { type: "agent_start" });
      await until(() => action("fork").isDisabled(), "streaming disables history actions");
      assert.equal(await action("revert").isDisabled(), true);
      other.streaming = false; emit(other, { type: "agent_end" });
      await until(() => action("fork").isEnabled(), "idle enables history actions");
      await page.locator("#image-files").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from(image.data, "base64") });
      await page.locator(".attachment img").waitFor();
      const preservedDraft = async () => {
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this other draft");
        assert.equal(await page.locator(".attachment img").getAttribute("src"), `data:image/png;base64,${image.data}`);
      };
      await action("fork").click(); await page.locator("#conversation-action-dialog").waitFor();
      other.messages.push({ role: "assistant", content: "Concurrent leaf", timestamp: ++tick });
      await page.locator("#confirm-conversation-action").click();
      await until(() => page.locator("#notice-text").textContent().then((text) => text.includes("Conversation changed")), "stale mutation rejected");
      await ready(); await page.waitForTimeout(300);
      assert.equal(mutations().length, 1, "stale mutations are never automatically retried");
      await preservedDraft();
      for (const kind of ["fork", "revert"]) {
        other.failConversation = true;
        await action(kind).click(); await page.locator("#confirm-conversation-action").click();
        await until(() => page.locator("#notice-text").textContent().then((text) => text.includes("Fixture replacement failed")), `${kind} failure shown`);
        await until(() => action(kind).isEnabled(), "failure releases busy controls");
        await preservedDraft(); other.failConversation = false;
        await page.locator("#dismiss-notice").click();
      }
      const originalNative = other.nativeSessionId, originalMessages = structuredClone(other.messages), originalCursor = other.cursor;
      other.holdConversation = true;
      await action("fork").click(); await page.locator("#confirm-conversation-action").click();
      await until(() => Boolean(other.releaseConversation), "fork request gated");
      assert.equal(await action("fork").isDisabled(), true); assert.equal(await action("revert").isDisabled(), true);
      assert.equal(await page.locator("#send").isDisabled(), true);
      other.releaseConversation(); other.holdConversation = false;
      await until(() => page.locator("#session-title").textContent().then((text) => text === `${other.name} fork`), "fork selected");
      await ready();
      const fork = [...sessions.values()].find((entry) => entry.name === `${other.name} fork`);
      assert.ok(fork && fork.id !== other.id && fork.nativeSessionId !== originalNative);
      assert.equal(other.nativeSessionId, originalNative); assert.deepEqual(other.messages, originalMessages); assert.equal(other.cursor, originalCursor);
      assert.deepEqual(fork.messages, originalMessages.slice(0, 2), "fork branches before selected user");
      assert.equal(await page.locator("#prompt").inputValue(), "Restore this **raw** draft");
      assert.equal(await page.locator(".attachment img").getAttribute("src"), `data:image/png;base64,${image.data}`);
      await openSidebar();
      assert.equal(await page.locator(".session-item.active").textContent().then((text) => text.includes(fork.name)), true);
      await page.locator(".session-item").filter({ hasText: other.name }).filter({ hasNotText: " fork" }).click();
      await ready(); await preservedDraft();
      const replacementObserver = await context.newPage(); watch(replacementObserver);
      await replacementObserver.goto(origin); await login(replacementObserver);
      if (label === "mobile") await replacementObserver.locator("#open-drawer").click();
      await replacementObserver.locator(".session-item").filter({ hasText: other.name }).filter({ hasNotText: " fork" }).click();
      await ready(replacementObserver);
      await until(() => other.clients.size === 2, "observer subscribed");
      assert.ok((await replacementObserver.locator("#messages").textContent()).includes("Discarded old response"));
      await replacementObserver.locator("#prompt").fill("Observer keeps its own draft");
      const subscriptionsBeforeReplace = other.subscriptions;
      await action("revert").click(); await page.locator("#confirm-conversation-action").click();
      await until(() => Boolean(other.finishReplacement), "replacement source exited");
      await until(() => replacementObserver.locator('[data-conversation-action="revert"]').first().isDisabled(), "observer locked during replacement");
      await page.waitForTimeout(200);
      assert.equal(other.conversationReplacing, true);
      assert.equal(await page.locator("#send").isDisabled(), true);
      other.finishReplacement();
      await ready(); await ready(replacementObserver);
      await until(() => other.subscriptions >= subscriptionsBeforeReplace + 2, "both browsers reconnect after replacement");
      assert.ok(sessions.has(other.id)); assert.notEqual(other.nativeSessionId, originalNative);
      assert.deepEqual(other.messages, originalMessages.slice(0, 2));
      assert.equal(other.events.length, 1); assert.ok(other.events[0].id > originalCursor + 2, "new event ring retains monotonic cursor");
      assert.equal(await page.locator("#session-title").textContent(), other.name);
      assert.equal(await page.locator("#prompt").inputValue(), "Restore this **raw** draft");
      assert.equal(await page.locator(".attachment img").getAttribute("src"), `data:image/png;base64,${image.data}`);
      for (const tab of [page, replacementObserver]) {
        await until(() => tab.locator("article.message").count().then((count) => count === 2), "replacement clears old transcript");
        assert.equal((await tab.locator("#messages").textContent()).includes("Discarded old response"), false);
        assert.equal((await tab.locator("#messages").textContent()).includes("Concurrent leaf"), false);
        await noOverflow(tab);
      }
      assert.equal(await replacementObserver.locator("#prompt").inputValue(), "Observer keeps its own draft");
      await page.locator("#model").selectOption(JSON.stringify(["fixture", "pi-reasoning"]));
      await until(() => other.model.id === "pi-reasoning", "post-revert write uses replacement native ID");
      await replacementObserver.close();
      assert.equal(mutations().length, 5, "cancel, stale and failure paths never silently retry");
      console.log(`${label}: PASS raw copy, clipboard fallback, historical model/title, action cancel, busy controls, stale/no retry, failure drafts, fork identity/draft/images, revert identity/draft/images, observer replacement reconnect`);
      // Consecutive action-only messages share one header, with useful collapsed inputs.
      const commands = [
        ["read", { path: "src/config.mjs" }, "src/config.mjs"],
        ["bash", { command: "npm test\n && echo '<script>unsafe</script>' " + "x".repeat(200) }, "npm test"],
        ["write", { path: "src/output.mjs", content: "hidden file body" }, "src/output.mjs"],
        ["edit", { path: "src/output.mjs", edits: [] }, "src/output.mjs"],
      ];
      for (const [index, [name, args]] of commands.entries()) {
        const id = `compact-${label}-${index}`;
        complete(other, { role: "assistant", model: "pi-fast", provider: "fixture", content: [{ type: "thinking", thinking: "Plan this operation" }, { type: "toolCall", id, name, arguments: args }], timestamp: ++tick });
        complete(other, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "Done" }], timestamp: ++tick });
      }
      emit(other, { type: "agent_end" });
      const group = page.locator(".action-group");
      await until(() => group.locator(".tool-detail").count().then((count) => count === 4), "compact action group");
      assert.equal(await group.locator(".message-header").count(), 1);
      for (const [index, [, , preview]] of commands.entries()) assert.ok((await group.locator(".tool-preview").nth(index).textContent()).startsWith(preview));
      assert.ok((await group.locator(".tool-preview").nth(1).textContent()).endsWith("…"));
      assert.equal(await group.locator("script").count(), 0, "command previews are text, never HTML");
      await group.locator(".tool-summary").nth(1).click();
      assert.ok((await group.locator(".tool-detail[open] pre").first().textContent()).includes("x".repeat(200)), "expanded input retains the full command");
      await noOverflow(page);
      await openSidebar(); await page.locator("#refresh-sessions").click();
      if (label === "mobile") await page.locator("#close-drawer").click();
      await drawerClosed();
      await until(() => group.locator(".tool-detail[open]").count().then((count) => count === 1), "expanded action survives refresh");
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: "" });
      await openSidebar(); await page.locator("#logout").click(); await page.locator("#login-dialog").waitFor();
      assert.equal(await page.locator("#token").inputValue(), "");
      assert.equal(await page.title(), "Pi Agent | Agentbox", "logout clears tab counters");
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(await page.locator("#messages").textContent(), "");
      assert.deepEqual(errors, [], "No browser JS or CSP errors");
      console.log(`${label}: PASS login, session, initial snapshot click race, same-session no-op/model/draft/drawer, healthy Refresh, model, image paste, deltas, queue, tool, all approvals, reset/EOF, no retry, stop, DELETE/cancel, history, overflow, session-switch write race, switch/return stream cleanup/no creation, logout`);
    } catch (error) {
      await page.screenshot({ path: join(output, `pi-workspace-${label}-failure.png`), fullPage: true }).catch(() => {});
      console.error("Browser errors:", errors); throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(serverErrors, []);
  console.log(`Screenshots: ${join(output, "pi-workspace-desktop.png")} and ${join(output, "pi-workspace-mobile.png")}`);
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
