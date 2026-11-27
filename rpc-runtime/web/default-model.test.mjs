import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function harness() {
  const nodes = new Map();
  const sandbox = {
    settingsTarget: null, calls: [], updateControls() {},
    runSettingsCommand: (...args) => sandbox.calls.push(args),
    element: () => ({ value: "" }),
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", children: [],
        replaceChildren(...children) { this.children = children; this.firstChild = children[0]; },
        append(child) { this.children.push(child); },
        addEventListener(_, handler) { this.handler = handler; },
      });
      return nodes.get(id);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function renderDefaultModels("), source.indexOf('$("settings").addEventListener'))
    + source.slice(source.indexOf('$("default-model").addEventListener'), source.indexOf('$("save-default-model").addEventListener')), sandbox);
  return sandbox;
}
test("Settings picker includes provider identity and saves directly without set_model", () => {
  const h = harness();
  const ctx = { record: { models: [
    { provider: "openai-codex", id: "Target" },
    { provider: "codex-work", id: "Org/Target" },
  ] }, meta: { defaultModel: { scope: "global", model: { provider: "codex-work", id: "Org/Target" } } } };
  h.settingsTarget = { ctx };
  h.renderDefaultModels(ctx);
  assert.equal(h.$("default-model").value, "codex-work/Org/Target");
  assert.deepEqual(Array.from(h.$("default-model").children, option => option.value), ["", "openai-codex/Target", "codex-work/Org/Target"]);
  h.$("save-selected-default-model").handler();
  assert.deepEqual(h.calls, [["agentbox-defaults", "model codex-work/Org/Target"]]);
  for (const value of ["", "missing/model", "codex-work/Org/Target extra"]) {
    h.$("default-model").value = value;
    h.$("save-selected-default-model").handler();
  }
  assert.equal(h.calls.length, 1, "only a catalog selection can be dispatched");
});
test("unknown saved default never falls back to the session's active model", () => {
  const h = harness();
  h.renderDefaultModels({ record: { models: [{ provider: "p", id: "m" }] }, meta: {}, state: { model: { provider: "p", id: "m" } } });
  assert.equal(h.$("default-model").value, "");
});
