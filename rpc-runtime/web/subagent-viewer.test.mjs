import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { renderSubagentTranscript, mountSubagentViewer } from "./subagent-viewer.mjs";
import { renderSubagents } from "./subagents.mjs";

const taskId = "pi-workflow-12345678-1234-4123-8123-123456789abc";
const flatten = node => [node, ...node.children.flatMap(flatten)];
const text = node => flatten(node).map(item => item.textContent).join("\n");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function dom(t) {
  const old = globalThis.document;
  const doc = { activeElement: null };
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
      this.textContent = ""; this.scrollTop = 0; this.scrollHeight = 600; this.clientHeight = 300;
      this.ownerDocument = doc; this.inert = false; this.isConnected = true; this.open = false;
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    querySelectorAll(selector) { return flatten(this).slice(1).filter(node => node.tag === selector); }
    focus() { doc.activeElement = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    set innerHTML(_) { throw new Error("Unsafe HTML"); }
  }
  doc.createElement = tag => new Node(tag);
  doc.createTextNode = value => Object.assign(new Node("#text"), { textContent: value });
  globalThis.document = doc;
  t.after(() => { globalThis.document = old; });
  return { doc, Node };
}
function fixture(t, request) {
  const { doc, Node } = dom(t);
  const root = new Node("main"), parent = new Node("section"), focus = new Node("button");
  parent.append(focus); root.append(parent); focus.focus();
  const timers = new Map(), calls = [];
  let closed = 0, viewer;
  const options = {
    sessionId: "parent-runtime", nativeSessionId: "parent-native", taskId, role: "reviewer",
    request: async (url, opts) => { calls.push({ url, ...opts }); return request(url, opts); },
    setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); },
    onClose() { closed++; viewer.dispose(); },
  };
  viewer = mountSubagentViewer(root, options);
  t.after(() => viewer.dispose());
  return { root, parent, focus, doc, timers, calls, viewer, options, closed: () => closed };
}
const reply = messages => ({ nativeSessionId: "parent-native", taskId, messages });

test("child cards expose drill-in only for workflow children and never navigate on render", t => {
  dom(t);
  const jobs = [{ taskId, role: "reviewer", status: "running" }, { taskId: "../../private", role: "bad" }, { role: "queued" }];
  let selected;
  const root = renderSubagents({ name: "task" }, { details: { jobs } }, "tool", { onOpen: job => selected = job });
  const buttons = flatten(root).filter(node => node.tag === "button");
  assert.equal(buttons.length, 1); assert.equal(selected, undefined);
  buttons[0].listeners.click(); assert.equal(selected, jobs[0]);
});

test("full child transcript renders prompts, thinking, calls, results, images and final text safely", t => {
  dom(t);
  const root = renderSubagentTranscript([
    { message: { role: "user", content: "Inspect <script>bad</script>" } },
    { message: { role: "assistant", model: "model", content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "toolCall", name: "read", arguments: { path: "/workspace/file" } },
    ] } },
    { message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "complete output" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }], isError: true } },
    { message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
  ]);
  for (const expected of ["<script>bad</script>", "reasoning", "Tool call · read", "/workspace/file", "complete output", "final answer", "Tool reported an error"]) assert.ok(text(root).includes(expected));
  assert.equal(flatten(root).filter(node => node.tag === "img").length, 1);
  assert.ok(!flatten(root).some(node => ["script", "iframe"].includes(node.tag)));
});

test("viewer uses bound read-only requests, preserves parent DOM and returns focus on Back", async t => {
  const f = fixture(t, () => reply([{ message: { role: "user", content: "task prompt" } }]));
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `/v1/sessions/parent-runtime/subagents/${taskId}`);
  assert.equal(f.calls[0].nativeSessionId, "parent-native");
  assert.equal(f.calls[0].method, undefined);
  assert.equal(f.parent.inert, true);
  assert.match(text(f.root), /task prompt/);
  const back = flatten(f.root).find(node => node.tag === "button" && node.textContent.includes("Back to main"));
  back.listeners.click();
  assert.equal(f.closed(), 1); assert.equal(f.root.children[0], f.parent);
  assert.equal(f.parent.inert, false); assert.equal(f.doc.activeElement, f.focus);
  assert.equal(f.timers.size, 0); assert.equal(f.calls[0].signal.aborted, true);
});

test("late responses after returning to parent cannot render or restart polling", async t => {
  let resolve;
  const f = fixture(t, () => new Promise(done => resolve = done));
  f.viewer.dispose(); resolve(reply([{ message: { role: "assistant", content: "late secret" } }]));
  await flush();
  assert.doesNotMatch(text(f.root), /late secret/);
  assert.equal(f.timers.size, 0); assert.equal(f.root.children.length, 1);
});

test("fresh messages preserve reader scroll and expanded tool details; polling is single-flight", async t => {
  let version = 1;
  const f = fixture(t, () => reply([{ message: { role: "assistant", content: [
    { type: "toolCall", name: "read", arguments: { version } }, { type: "text", text: `update ${version}` },
  ] } }]));
  await flush();
  const body = flatten(f.root).find(node => node.className === "subagent-viewer-body");
  body.scrollTop = 20; body.querySelectorAll("details")[0].open = true;
  version++; await f.viewer.refresh();
  assert.equal(body.scrollTop, 20); assert.equal(body.querySelectorAll("details")[0].open, true);
  assert.match(text(body), /update 2/); assert.equal(f.timers.size, 1);
});

test("stale identity and permissions stop polling with an accessible error and Back", async t => {
  for (const status of [401, 403, 409]) {
    const f = fixture(t, () => { throw Object.assign(new Error("read denied"), { status }); });
    await flush(); assert.match(text(f.root), /read denied/); assert.equal(f.timers.size, 0);
    f.viewer.dispose();
  }
});

test("app drill-in keeps parent selection/draft and restores its conversation position", () => {
  const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
  const ctx = { id: "parent", meta: { nativeSessionId: "native" }, record: { draft: "unsent parent draft" } };
  const conversation = { scrollTop: 123 };
  let options, disposed = 0;
  const h = { current: ctx, followBottom: false, subagentViewer: null,
    active: value => value === ctx, closeContextPane() {},
    $: () => conversation, document: { querySelector: () => ({}) }, api: { request() {} },
    mountSubagentViewer(_root, opts) { options = opts; return { dispose() { disposed++; } }; },
  };
  vm.createContext(h);
  vm.runInContext(source.slice(source.indexOf("function closeSubagentPane("), source.indexOf("function renderTool(")), h);
  h.openSubagentPane(ctx, { taskId, role: "reviewer" });
  assert.equal(h.current, ctx); assert.equal(ctx.record.draft, "unsent parent draft");
  assert.equal(options.nativeSessionId, "native"); assert.equal(options.valid(), true);
  conversation.scrollTop = 999; h.followBottom = true;
  options.onClose();
  assert.equal(conversation.scrollTop, 123); assert.equal(h.followBottom, false);
  assert.equal(disposed, 1); assert.equal(h.subagentViewer, null);
  ctx.meta.nativeSessionId = "replacement"; assert.equal(options.valid(), false);
  const lifecycle = source.slice(source.indexOf("function closeContextPane("), source.indexOf("function openBrowserPane("));
  assert.match(lifecycle, /closeSubagentPane\(\)/);
});

test("incorrect child identity is never displayed", async t => {
  const f = fixture(t, () => ({ ...reply([{ message: { role: "user", content: "wrong child" } }]), taskId: "different" }));
  await flush(); assert.doesNotMatch(text(f.root), /wrong child/); assert.equal(f.timers.size, 0);
});
