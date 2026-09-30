import assert from "node:assert/strict";
import test from "node:test";
import { fastModeControl } from "./commands.mjs";

const ready = { supported: true, writable: true };
const off = { available: true, enabled: false };
test("fast mode requires explicit metadata and command support", () => {
  for (const mode of [undefined, null, {}, { available: true }, { available: false, enabled: false }]) {
    assert.equal(fastModeControl(mode, ready).disabled, true);
    assert.equal(fastModeControl(mode, ready).pressed, false);
  }
  assert.equal(fastModeControl(null, ready).text, "Fast: unknown");
  assert.equal(fastModeControl(off, { writable: true }).disabled, true);
  assert.equal(fastModeControl(off, ready).disabled, false);
});
test("busy/read-only and refreshing controls cannot toggle", () => {
  assert.equal(fastModeControl(off, { supported: true, writable: false }).disabled, true);
  const pending = fastModeControl(off, { ...ready, refreshing: true });
  assert.equal(pending.disabled, true);
  assert.equal(pending.pressed, false, "waiting does not optimistically enable billing");
  assert.equal(pending.text, "Fast: refreshing...");
});
test("only confirmed metadata changes the displayed mode", () => {
  assert.equal(fastModeControl(off, ready).text, "Fast: off");
  const on = fastModeControl({ available: true, enabled: true }, ready);
  assert.equal(on.text, "Fast: on");
  assert.equal(on.pressed, true);
  assert.equal(on.disabled, false);
  assert.match(on.help, /new processes start off/);
});

// Exercise the actual click/dispatch guards without a browser dependency.
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function harness() {
  const nodes = new Map();
  const sandbox = {
    current: null, epoch: 1, readOnly: false, settingsTarget: null,
    active: (ctx) => sandbox.current === ctx,
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, { close() {}, addEventListener(_, fn) { this.click = fn; } });
      return nodes.get(id);
    },
    updateControls() {}, requestRefresh() {}, report(error) { throw error; },
    calls: [], rpc: async (ctx, body, write, nativeId) => { sandbox.calls.push({ ctx, body, write, nativeId }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function canWrite('), source.indexOf('function canExportConversation('))
    + source.slice(source.indexOf('async function runSettingsCommand('), source.indexOf('$("save-default-model").addEventListener')), sandbox);
  sandbox.click = () => nodes.get('fast-mode').click();
  return sandbox;
}
function session(id) {
  return { meta: { nativeSessionId: id, status: "running", fastMode: { available: true, enabled: false } },
    ready: true, online: true, state: {}, record: { forbidden: new Set(), draft: { text: "keep", images: ["image"] } } };
}
test("active-session click needs no Settings/catalog, excludes draft/images, and keeps A/B isolated", async () => {
  const h = harness(), a = session("a"), b = session("b");
  h.current = a;
  await h.click();
  assert.equal(h.calls[0].ctx, a);
  assert.equal(h.calls[0].nativeId, "a");
  assert.equal(h.calls[0].write, true);
  assert.equal(JSON.stringify(h.calls[0].body), '{"type":"prompt","message":"/fast on"}');
  assert.equal(a.meta.fastMode.enabled, false, "acceptance is not confirmation");
  a.meta.fastMode.enabled = true; a.fastModeRefresh = null; // confirmed metadata
  h.current = b;
  assert.equal(fastModeControl(h.current.meta.fastMode, ready).pressed, false);
  h.current = a;
  assert.equal(fastModeControl(h.current.meta.fastMode, ready).pressed, true);
  await h.click();
  assert.equal(h.calls[1].body.message, "/fast off");
  assert.deepEqual(a.record.draft, { text: "keep", images: ["image"] });
});
test("actual fast click rejects busy, read-only, unknown, unavailable and refreshing sessions", async () => {
  const guards = [
    (h, a) => { h.readOnly = true; },
    (h, a) => { a.state.isStreaming = true; },
    (h, a) => { a.record.readingImages = true; },
    (h, a) => { a.record.settingsBusy = true; },
    (h, a) => { a.meta.fastMode = null; },
    (h, a) => { a.meta.fastMode.available = false; },
    (h, a) => { a.fastModeRefresh = {}; },
    (h, a) => { a.record.forbidden.add("prompt"); },
  ];
  for (const guard of guards) {
    const h = harness(), a = session("a"); h.current = a; guard(h, a);
    await h.click(); assert.equal(h.calls.length, 0);
  }
});
