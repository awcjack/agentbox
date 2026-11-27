import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { eventCursor } from "./transport.mjs";
import { changesFromTool, createChangeAccumulator, accumulateChange, summarizeFileChanges } from "./file-changes.mjs";

function harness() {
  const ctx = { cursor: 0, streamController: new AbortController(), tools: new Map() };
  const sandbox = {
    active: candidate => candidate === ctx, eventCursor,
    renders: 0, refreshes: 0,
    scheduleRender() { sandbox.renders++; },
    requestRefresh() { sandbox.refreshes++; },
  };
  vm.createContext(sandbox);
  const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("function handleEvent("), source.indexOf("async function runSession(")), sandbox);
  let cursor = 0;
  return { ctx, sandbox, send(event) {
    sandbox.handleEvent(ctx, { event: "pi", id: String(++cursor), data: JSON.stringify(event) });
    return cursor;
  } };
}

for (const name of ["bulk_edit", "bulk_write"]) test(`${name} live child events stay inside the parent without duplicate edit rows`, () => {
  const h = harness();
  const files = ["a.mjs", "b.mjs"].map(path => name === "bulk_edit"
    ? { path, edits: [{ oldText: "old", newText: "new" }] }
    : { path, content: "new" });
  h.send({ type: "tool_execution_start", toolCallId: "batch", toolName: name, args: { files } });
  for (const [index, file] of files.entries()) {
    for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
      h.send({ type, parentToolCallId: "batch", toolCallId: `batch/${index}`, toolName: name === "bulk_edit" ? "edit" : "write", args: file,
        result: { content: [{ type: "text", text: "success" }] } });
      assert.deepEqual([...h.ctx.tools.keys()], ["batch"]);
    }
  }
  h.send({ type: "tool_execution_end", toolCallId: "batch", toolName: name,
    result: { details: { files: files.map(file => ({ path: file.path, status: "completed" })) } } });
  assert.equal(h.ctx.cursor, 8, "ignored child events still advance the reconnect cursor");
  assert.equal(h.sandbox.renders, 2);
  assert.equal(h.sandbox.refreshes, 1, "only the parent completion refreshes history");
  const changes = createChangeAccumulator();
  for (const result of h.ctx.tools.values()) {
    for (const change of changesFromTool({ name: result.toolName, arguments: result.args }, result)) accumulateChange(changes, change);
  }
  const summary = summarizeFileChanges(changes);
  assert.equal(summary.files.length, 2);
  assert.equal(summary.added, 2, "each edited file is counted once before a refresh");
  assert.equal(summary.removed, name === "bulk_edit" ? 2 : 0);
});

test("top-level edits still stream normally; nested failures do not leave orphan rows", () => {
  const h = harness();
  h.send({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "a" } });
  h.send({ type: "tool_execution_update", toolCallId: "edit", partialResult: { content: [{ type: "text", text: "working" }] } });
  assert.equal(h.ctx.tools.get("edit").running, true);
  h.send({ type: "tool_execution_end", parentToolCallId: "batch/0", toolCallId: "batch/0/1", toolName: "edit", isError: true });
  h.send({ type: "tool_execution_end", toolCallId: "edit", isError: true });
  assert.deepEqual([...h.ctx.tools.keys()], ["edit"]);
  assert.equal(h.ctx.tools.get("edit").running, false);
  assert.equal(h.ctx.tools.get("edit").isError, true);
  assert.equal(h.ctx.tools.get("edit").args.path, "a");
});
