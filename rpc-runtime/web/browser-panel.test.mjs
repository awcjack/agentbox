import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createBrowserController, validateFrame, validateInput, mountBrowserPanel, FRAME_TTL, RENEW_INTERVAL } from "./browser-panel.mjs";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() {
  let time = 100_000, serial = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async tick(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      time = end; await flush();
    },
    get size() { return timers.size; },
  };
}
const binding = { version: 1, nativeSessionId: "native-old", browserSessionId: "browser-old" };
function frame(now = 100_000, frameId = "frame-1") {
  return { ...binding, frameId, createdAt: now, width: 1280, height: 720, mimeType: "image/jpeg", data: "/9j/AA==", refs: [{ ref: "@e1", role: "textbox", name: "Page name" }], control: { mode: "agent" } };
}
function fixture(options = {}) {
  const time = clock(), calls = [], changes = [];
  let mode = "agent", seq = 0;
  const request = async (path, opts) => {
    calls.push({ path, ...opts });
    if (options.handle) {
      const result = options.handle(path, opts, time);
      if (result !== undefined) return result;
    }
    if (opts.body) {
      const op = opts.body.operation;
      if (["acquire", "renew"].includes(op)) {
        mode = "human";
        return { ...binding, leaseId: "lease-old", expiresAt: time.now() + 30_000 };
      }
      if (op === "release") mode = "agent";
      return { ...binding, accepted: true };
    }
    if (path.endsWith("/frame")) return { ...frame(time.now(), `frame-${++seq}`), control: { mode } };
    return { ...binding, available: true, ready: true, ownership: "tab", capabilities: { liveView: true, takeover: true }, control: { mode }, permissions: { view: true, control: true }, ...options.status };
  };
  const controller = createBrowserController({ sessionId: "session/old", nativeSessionId: "native-old", request, onChange: (state) => changes.push(state), ...time });
  return { controller, time, calls, changes, request, start: async () => { controller.start(); await flush(); }, mutations: (op) => calls.filter((c) => c.body?.operation === op) };
}

test("explicit start, exact routes/native header, single-flight preview at <=1fps", async () => {
  const pending = deferred(); let block = false;
  const f = fixture({ handle: (path) => block && path.endsWith("/frame") ? pending.promise : undefined });
  assert.equal(f.calls.length, 0);
  await f.start();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].path, "/v1/sessions/session%2Fold/browser");
  assert.ok(f.calls.every((c) => c.nativeSessionId === "native-old" && !c.path.includes("token")));
  await f.time.tick(999); assert.equal(f.calls.length, 2);
  block = true;
  await f.time.tick(1); assert.equal(f.calls.length, 4);
  await f.time.tick(20_000); assert.equal(f.calls.length, 4);
  assert.equal(f.controller.getState().canInput, false);
  pending.resolve(frame(f.time.now())); await flush();
  await f.time.tick(999); assert.equal(f.calls.length, 4);
  f.controller.dispose(); assert.equal(f.time.size, 0);
});

test("permanently closed private bridge stops polling and instructs process restart", async () => {
  const f = fixture({ handle() { throw Object.assign(new Error("closed"), { status: 503, code: "browser_bridge_closed" }); } });
  await f.start();
  assert.equal(f.controller.getState().disposed, true);
  assert.equal(f.controller.getState().canInput, false);
  assert.match(f.controller.getState().message, /Restart the conversation process/);
  await f.time.tick(60000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.time.size, 0);
});

test("explicit server control permission required; unavailable browser stays lazy", async () => {
  for (const status of [
    { permissions: { view: true, control: false } },
    { permissions: { view: true } },
    { permissions: { view: false, control: true } },
    { capabilities: { liveView: true, takeover: false } },
    { ready: false },
    { control: { mode: "human" } },
  ]) {
    const f = fixture({ status }); await f.start();
    assert.equal(await f.controller.acquire(), false);
    assert.equal(await f.controller.input({ action: "reload" }), false);
    assert.equal(f.mutations("acquire").length, 0);
    if (status.ready === false) assert.equal(f.calls.length, 1);
    f.controller.dispose();
  }
});

test("acknowledged lease plus post-acquire frame, renew at 10s, release stops renewal", async () => {
  const f = fixture(); await f.start();
  assert.equal(f.controller.getState().canAcquire, true);
  assert.equal(await f.controller.acquire(), true);
  assert.deepEqual(f.mutations("acquire")[0].body, { operation: "acquire", browserSessionId: "browser-old" });
  assert.equal(f.controller.getState().canInput, false);
  await f.time.tick(1000); assert.equal(f.controller.getState().canInput, true);
  await f.time.tick(RENEW_INTERVAL - 1001); assert.equal(f.mutations("renew").length, 0);
  await f.time.tick(1); assert.equal(f.mutations("renew").length, 1);
  await f.controller.release();
  assert.equal(f.controller.getState().held, false);
  await f.time.tick(20_000); assert.equal(f.mutations("renew").length, 1);
  assert.equal(f.mutations("release").length, 1);
  f.controller.dispose();
});

test("single-flight inputs consume frame before await and are never retried", async () => {
  const pending = deferred();
  const f = fixture({ handle: (_path, opts) => opts.body?.operation === "input" ? pending.promise : undefined });
  await f.start(); await f.controller.acquire(); await f.time.tick(1000);
  const frameId = f.controller.getState().frame.frameId;
  const input = f.controller.input({ action: "fill", ref: "@e1", text: "draft" });
  assert.equal(await f.controller.input({ action: "reload" }), false);
  assert.equal(f.controller.getState().frame, null);
  assert.deepEqual(f.mutations("input")[0].body, { operation: "input", browserSessionId: "browser-old", leaseId: "lease-old", frameId, request: { action: "fill", ref: "@e1", text: "draft" } });
  pending.reject(new Error("Connection interrupted")); assert.equal(await input, false);
  await f.time.tick(20_000);
  assert.equal(f.mutations("input").length, 1);
  assert.equal(f.mutations("acquire").length, 1);
  assert.equal(f.controller.getState().held, false);
  assert.equal(f.mutations("release").length, 1);
  assert.ok(f.changes.some((s) => s.message.includes("Nothing was retried")));
  f.controller.dispose();
});

test("failed acquisition/release is not retried, including concurrent disposal", async () => {
  const f = fixture({ handle: (_path, opts) => opts.body?.operation === "acquire" ? Promise.reject(new Error("unknown outcome")) : undefined });
  await f.start(); assert.equal(await f.controller.acquire(), false); await f.time.tick(40_000);
  assert.equal(f.mutations("acquire").length, 1);
  assert.equal(f.controller.getState().held, false);
  assert.match(f.controller.getState().message, /expires within 30 seconds/);
  f.controller.dispose();
  for (const dispose of [false, true]) {
    const pending = deferred();
    const g = fixture({ handle: (_path, opts) => opts.body?.operation === "release" ? pending.promise : undefined });
    await g.start(); await g.controller.acquire(); const release = g.controller.release();
    if (dispose) g.controller.dispose();
    pending.reject(new Error("unknown outcome")); assert.equal(await release, false);
    await g.time.tick(40_000); g.controller.dispose();
    assert.equal(g.mutations("release").length, 1);
    assert.equal(g.mutations("renew").length, 0);
  }
});

test("successful input also needs a newly fetched frame", async () => {
  const f = fixture(); await f.start(); await f.controller.acquire(); await f.time.tick(1000);
  assert.equal(await f.controller.input({ action: "click", ref: "@e99" }), false);
  assert.equal(f.mutations("input").length, 0);
  assert.equal(await f.controller.input({ action: "click", ref: "@e1" }), true);
  assert.equal(f.controller.getState().canInput, false);
  await f.time.tick(1000); assert.equal(f.controller.getState().canInput, true);
  f.controller.dispose();
});

test("five-second freshness disables controls even while next poll is hung", async () => {
  const pending = deferred(); let block = false;
  const f = fixture({ handle: (path) => block && path.endsWith("/frame") ? pending.promise : undefined });
  await f.start(); await f.controller.acquire(); await f.time.tick(1000); block = true;
  await f.time.tick(FRAME_TTL - 1); assert.equal(f.controller.getState().canInput, true);
  await f.time.tick(1); assert.equal(f.controller.getState().canInput, false);
  assert.equal(f.changes.at(-1).fresh, false);
  assert.equal(await f.controller.input({ action: "back" }), false);
  f.controller.dispose(); pending.resolve(frame()); await flush();
});

test("failed renewal drops authority without retry; expiry disables hung renewal", async () => {
  for (const hang of [false, true]) {
    const pending = deferred();
    const f = fixture({ handle: (_path, opts) => opts.body?.operation === "renew" ? (hang ? pending.promise : Promise.reject(new Error("renew failed"))) : undefined });
    await f.start(); await f.controller.acquire(); await f.time.tick(30_000);
    assert.equal(f.mutations("renew").length, 1);
    assert.equal(f.controller.getState().held, false);
    assert.equal(f.controller.getState().canInput, false);
    f.controller.dispose();
    if (hang) { pending.resolve({ ...binding, leaseId: "lease-old", expiresAt: f.time.now() + 30_000 }); await flush(); }
  }
});

test("dispose captures old identity, clears all timers, aborts reads and releases once", async () => {
  const f = fixture(); await f.start(); await f.controller.acquire();
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.time.size, 0);
  const release = f.mutations("release"); assert.equal(release.length, 1);
  assert.equal(release[0].nativeSessionId, "native-old");
  assert.equal(release[0].path, "/v1/sessions/session%2Fold/browser/control");
  assert.deepEqual(release[0].body, { operation: "release", browserSessionId: "browser-old", leaseId: "lease-old" });
  assert.equal(release[0].signal, undefined);
  await f.time.tick(60_000); assert.equal(f.mutations("renew").length, 0);
});

test("late acquire after selection/logout releases old lease without rendering", async () => {
  const pending = deferred();
  const f = fixture({ handle: (_path, opts) => opts.body?.operation === "acquire" ? pending.promise : undefined });
  await f.start(); const acquire = f.controller.acquire(); f.controller.dispose();
  const count = f.changes.length;
  pending.resolve({ ...binding, leaseId: "late-lease", expiresAt: f.time.now() + 30_000 });
  assert.equal(await acquire, false);
  assert.equal(f.changes.length, count);
  assert.equal(f.mutations("release")[0].body.leaseId, "late-lease");
  assert.equal(f.time.size, 0);
});

test("late previews cannot render after disposal or restore pre-acquire frame", async () => {
  const pending = deferred(); let block = false;
  const f = fixture({ handle: (path) => block && path.endsWith("/frame") ? pending.promise : undefined });
  await f.start(); block = true; await f.time.tick(1000);
  await f.controller.acquire();
  pending.resolve(frame(f.time.now(), "pre-acquire")); await flush();
  assert.equal(f.controller.getState().frame, null);
  f.controller.dispose();
  const g = fixture({ handle: (path) => path.endsWith("/frame") ? Promise.resolve(frame()) : undefined });
  g.controller.start(); g.controller.dispose(); await flush();
  assert.equal(g.calls.length, 1);
  assert.equal(g.controller.getState().frame, null);
});

test("replacement identity fails closed; permissions revoked release old lease", async () => {
  let replace = false;
  const f = fixture({ handle: (path) => replace && !path.endsWith("/control") ? Promise.resolve({ ...binding, nativeSessionId: "native-new" }) : undefined });
  await f.start(); await f.controller.acquire(); replace = true; await f.time.tick(1000);
  assert.equal(f.controller.getState().disposed, true);
  assert.equal(f.mutations("release")[0].nativeSessionId, "native-old");
  const status = {};
  const g = fixture({ status }); await g.start(); await g.controller.acquire();
  status.permissions = { view: true, control: false }; await g.time.tick(1000);
  assert.equal(g.controller.getState().held, false);
  assert.equal(g.mutations("release").length, 1); g.controller.dispose();
});

test("read errors use bounded backoff; authorization errors stop polling", async () => {
  const f = fixture({ handle: () => Promise.reject(new Error("offline")) });
  await f.start(); await f.time.tick(30_000);
  assert.equal(f.calls.length, 6); // 0, 2s, 6s, 14s, 22s, 30s
  f.controller.dispose();
  const g = fixture({ handle: () => Promise.reject(Object.assign(new Error("forbidden"), { status: 403 })) });
  await g.start(); await g.time.tick(30_000); assert.equal(g.calls.length, 1);
  assert.equal(g.controller.getState().canAcquire, false);
});

test("bounded canonical JPEG frames, identities, freshness and refs validated", () => {
  assert.equal(validateFrame(frame(), "native-old", "browser-old", 100_000).frameId, "frame-1");
  const bad = [
    { data: "PHN2Zz4=" }, { data: "/9j/AB==" }, { data: "/9j/AA==\n" }, { data: "A".repeat(819204) },
    { mimeType: "image/svg+xml" }, { width: 1 }, { nativeSessionId: "new" }, { browserSessionId: "new" },
    { createdAt: 95_000 }, { createdAt: 100_001 }, { createdAt: NaN }, { frameId: "" },
    { refs: Array.from({ length: 101 }, () => ({ ref: "@e1", role: "button", name: "x" })) },
    { refs: [{ ref: "@e1", role: "button", name: "x".repeat(513) }] },
    { refs: [{ ref: "#selector", role: "button", name: "x" }] },
  ];
  for (const patch of bad) assert.throws(() => validateFrame({ ...frame(), ...patch }, "native-old", "browser-old", 100_000));
  const bytes = Buffer.alloc(600 * 1024); bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  assert.doesNotThrow(() => validateFrame({ ...frame(), data: bytes.toString("base64") }, "native-old", "browser-old", 100_000));
});

test("human input allows only strict ref/key/scroll/navigation shapes", () => {
  const refs = frame().refs;
  for (const input of [{ action: "click", ref: "@e1" }, { action: "fill", ref: "@e1", text: "" }, { action: "press", key: "Control+a" }, { action: "scroll", direction: "down", amount: 2000 }, { action: "open", url: "https://example.org" }, { action: "reload" }]) assert.deepEqual(validateInput(input, refs), input);
  for (const input of [{ action: "click", x: 1, y: 2 }, { action: "click", ref: "@e2" }, { action: "fill", ref: "@e1", text: "\0" }, { action: "press", key: "--flag" }, { action: "scroll", direction: "down", amount: 2001 }, { action: "open", url: "javascript:alert(1)" }, { action: "open", url: "https://user:password@example.org" }, { action: "eval", script: "1" }, { action: "reload", principal: "operator" }]) assert.throws(() => validateInput(input, refs));
});

class FakeElement {
  constructor(tag, ownerDocument) { this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.attributes = {}; this.value = ""; this.textContent = ""; this.listeners = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === "src") this.src = ""; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  set innerHTML(_) { throw new Error("HTML interpolation forbidden"); }
}
test("DOM adapter renders page labels as text only and clears in-memory images/drafts", async () => {
  const doc = { createElement: (tag) => new FakeElement(tag, doc) }, root = new FakeElement("div", doc);
  const f = fixture({ handle: (path, _opts, time) => path.endsWith("/frame") ? Promise.resolve({ ...frame(time.now()), refs: [{ ref: "@e1", role: "button", name: "<img src=x onerror=alert(1)>" }] }) : undefined });
  const mounted = mountBrowserPanel(root, { sessionId: "session/old", nativeSessionId: "native-old", request: f.request, ...f.time });
  await flush();
  const all = (el) => [el, ...el.children.flatMap(all)];
  const nodes = all(root), image = nodes.find((n) => n.tag === "img");
  assert.equal(image.src, "data:image/jpeg;base64,/9j/AA==");
  assert.ok(nodes.some((n) => n.tag === "option" && n.textContent.includes("<img src=x onerror=alert(1)>")));
  const text = nodes.find((n) => n.tag === "textarea"); text.value = "not persisted";
  mounted.dispose(); assert.equal(root.children.length, 0); assert.equal(image.src, ""); assert.equal(text.value, "");
});

test("app lifecycle seams dispose browser before auth reset and preserve file mode", async () => {
  const app = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
  assert.match(app, /function logout[^]*?closeContextPane\(\)[^]*?token = ""/);
  assert.match(app, /function closeTab[^]*?if \(current\?\.id === id\) \{\s*closeContextPane\(\)/);
  assert.match(app, /function openContextPane\(path\)[^]*?closeContextPane\(\)[^]*?pane.dataset.mode = "file"/);
  assert.match(app, /visibilitychange[^]*?document.hidden && browserPanel\) closeContextPane\(\)/);
  assert.match(app, /browserBinding\?\.ctx === ctx\) closeContextPane\(\)/);
  assert.match(app, /createTransport\(\(\) => ownToken\)/);
  assert.match(app, /if \(block.type === "image"\)/);
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /id="open-browser"/);
  assert.match(html, /img-src[^;]*data:/);
});
