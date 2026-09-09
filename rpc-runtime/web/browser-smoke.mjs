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
let tick = Date.now();
const json = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
const meta = (session) => ({ id: session.id, name: session.name, nativeSessionId: session.nativeSessionId, profile: "default", cwd: "/workspace/project", status: "running", latestEventId: session.cursor, pendingUi: session.pendingUi, createdAt: session.modifiedAt, lastActivityAt: session.modifiedAt });
function emit(session, event) {
  const frame = `id: ${++session.cursor}\nevent: pi\ndata: ${JSON.stringify(event)}\n\n`;
  session.events.push({ id: session.cursor, frame });
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
const staticFiles = new Map([["/", ["index.html", "text/html"]], ...["styles.css", "icon.svg", "app.mjs", "transport.mjs", "markdown.mjs"].map((file) => [`/${file}`, [file, file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml"]])]);
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
    const match = /^\/v1\/sessions\/([^/]+)(?:\/(rpc|ui|events))?$/.exec(url.pathname);
    const session = match && sessions.get(match[1]);
    if (!session) return json(response, 404, { error: { code: "session_not_found", message: "Session not found" } });
    if (request.method === "DELETE") {
      calls.push({ id: session.id, method: "DELETE" });
      disconnect(session); sessions.delete(session.id);
      response.writeHead(204); response.end(); return;
    }
    if (!match[2]) { calls.push({ id: session.id, method: "GET" }); return json(response, 200, { session: meta(session) }); }
    if (match[2] === "events") {
      session.subscriptions++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }); response.flushHeaders();
      for (const event of session.events) if (event.id > Number(url.searchParams.get("after") || 0)) response.write(event.frame);
      session.clients.add(response); response.on("close", () => session.clients.delete(response)); return;
    }
    if (match[2] === "ui") {
      calls.push({ id: session.id, ui: body }); resolveUi(session, body.id);
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
    emit(session, result); json(response, 200, result);
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

      update(session, { type: "thinking_delta", contentIndex: 1, delta: "Check entry points and tests first." });
      const tool = { type: "toolCall", id: `call-${label}`, name: "read", arguments: { path: "src/main.mjs" } };
      update(session, { type: "toolcall_start", contentIndex: 2, id: tool.id, toolName: tool.name });
      update(session, { type: "toolcall_end", contentIndex: 2, toolCall: tool });
      complete(session, { ...session.partial, content: [{ type: "text", text: "Inspecting the repository.\n\n```js\nconst safe = '<script>not HTML</script>';\n```" }, { type: "thinking", thinking: "Check entry points and tests first." }, tool], stopReason: "toolUse" });
      emit(session, { type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.arguments });
      const approvalId = requestUi(session, { method: "confirm", title: "Allow reading the entry point?", message: "Pi wants to inspect src/main.mjs", timeout: 60_000 });
      await page.locator(".approval").waitFor();
      await noOverflow(page);
      await page.screenshot({ path: join(output, `pi-workspace-${label}.png`), fullPage: true });

      // Another browser must clear its approval when the first browser answers.
      const observer = await context.newPage(); watch(observer);
      await observer.goto(origin); await login(observer);
      if (label === "mobile") await observer.locator("#open-drawer").click();
      await observer.locator(".session-item").filter({ hasText: session.name }).click();
      await observer.locator(".approval").waitFor();
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
      const historical = page.locator(".session-item").filter({ hasText: session.name }); await historical.waitFor();
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
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: "" });
      await openSidebar(); await page.locator("#logout").click(); await page.locator("#login-dialog").waitFor();
      assert.equal(await page.locator("#token").inputValue(), "");
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
