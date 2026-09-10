import test from "node:test";
import assert from "node:assert/strict";
import { renderSubagents } from "./subagents.mjs";

test("inline child cards preserve ordering, keys, states, and safe output", () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener() {}
    set innerHTML(_) { throw new Error("Unsafe HTML"); }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (text) => Object.assign(new Node("#text"), { textContent: text }) };
  const flatten = (node) => [node, ...node.children.flatMap(flatten)];
  const text = (node) => flatten(node).map((item) => item.textContent).join("\n");
  try {
    const call = { name: "task", arguments: { jobs: [{ role: "scout", prompt: "first" }, { role: "scout", prompt: "second" }] } };
    const requested = renderSubagents(call, undefined, "parent-tool");
    assert.match(text(requested), /requested/);
    const jobs = [
      { role: "scout", prompt: "first", status: "running", taskId: "child-a", steps: 1 },
      { role: "scout", prompt: "second", status: "completed", taskId: "child-b", output: "<script>evil</script>", resumed: true, stderr: "diagnostic", outputTruncated: true },
    ];
    const live = renderSubagents(call, { running: true, details: { jobs, results: [jobs[1]] } }, "parent-tool");
    const cards = live.children.slice(1);
    assert.deepEqual(cards.map((card) => card.dataset.detailKey), requested.children.slice(1).map((card) => card.dataset.detailKey));
    assert.match(text(cards[0]), /first/);
    assert.doesNotMatch(text(cards[0]), /second/);
    assert.match(text(cards[1]), /RESUMED CHILD: child-b/);
    assert.match(text(cards[1]), /diagnostic/);
    assert.match(text(cards[1]), /Captured output truncated/);
    assert.ok(!flatten(live).some((node) => ["script", "iframe", "button", "a"].includes(node.tag)));
    for (const status of ["failed", "cancelled", "step_limit"]) {
      const failed = renderSubagents(call, { details: { jobs: [{ role: "scout", status }] } }, "parent-tool");
      assert.match(failed.children[1].className, /error/);
      assert.match(text(failed), new RegExp(status.replaceAll("_", " ")));
    }
    const historical = renderSubagents({}, { toolName: "task", details: { results: [jobs[1]] } }, "old");
    assert.match(text(historical), /child-b/);
    assert.equal(historical.children.length, 2);
    assert.ok(renderSubagents({ name: "task", arguments: JSON.stringify({ role: "scout", prompt: "inspect", resume: "child-a" }) }, undefined, "resume"));
    assert.equal(renderSubagents({ name: "read" }, {}, "other"), null);
    assert.equal(renderSubagents(call, { isError: true, content: "Invalid config", details: { results: [] } }, "bad"), null);
    assert.equal(renderSubagents({ name: "task", arguments: "{" }, undefined, "partial"), null);
    assert.equal(renderSubagents({ name: "task" }, { details: { jobs: [null], results: [42] } }, "malformed"), null);
  } finally { globalThis.document = previous; }
});
