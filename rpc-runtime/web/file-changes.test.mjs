import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  accumulateChange,
  changeFromTool,
  changesFromTool,
  isWriteTool,
  createChangeAccumulator,
  formatDiffCount,
  lineCount,
  summarizeFileChanges,
} from "./file-changes.mjs";

test("lineCount treats trailing newlines as one fewer blank line", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("one"), 1);
  assert.equal(lineCount("one\ntwo"), 2);
  assert.equal(lineCount("one\ntwo\n"), 2);
  assert.equal(lineCount("a\n\nb"), 3);
});

test("write tools count content lines as additions", () => {
  assert.deepEqual(
    changeFromTool({ name: "write", arguments: { path: "a.mjs", content: "one\ntwo\n" } }),
    { path: "a.mjs", added: 2, removed: 0, op: "write" },
  );
  assert.deepEqual(
    changeFromTool({ name: "Write", arguments: { file_path: "b.txt", contents: "only" } }),
    { path: "b.txt", added: 1, removed: 0, op: "write" },
  );
});

test("edit tools sum old/new text across edits arrays", () => {
  assert.deepEqual(
    changeFromTool({
      name: "edit",
      arguments: {
        path: "src/app.mjs",
        edits: [
          { oldText: "a\nb", newText: "a\nb\nc\nd" },
          { old_string: "x", new_string: "" },
        ],
      },
    }),
    { path: "src/app.mjs", added: 4, removed: 3, op: "edit" },
  );
});

test("failed write tools are ignored", () => {
  assert.equal(
    changeFromTool(
      { name: "write", arguments: { path: "x", content: "y" } },
      { isError: true, toolName: "write" },
    ),
    null,
  );
  assert.equal(changeFromTool({ name: "read", arguments: { path: "x" } }), null);
  assert.equal(changeFromTool({ name: "edit", arguments: { edits: [] } }), null);
});

test("patch tools count unified diff hunks", () => {
  const patch = [
    "--- a/file",
    "+++ b/file",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "+extra",
  ].join("\n");
  assert.deepEqual(
    changeFromTool({ name: "apply_patch", arguments: { path: "file", patch } }),
    { path: "file", added: 2, removed: 1, op: "apply_patch" },
  );
});

test("accumulator merges repeated edits for the same path", () => {
  const store = createChangeAccumulator();
  accumulateChange(store, { path: "a.ts", added: 2, removed: 1, op: "edit" });
  accumulateChange(store, { path: "b.ts", added: 5, removed: 0, op: "write" });
  accumulateChange(store, { path: "a.ts", added: 3, removed: 4, op: "edit" });
  const summary = summarizeFileChanges(store);
  assert.equal(summary.files.length, 2);
  assert.deepEqual(summary.files[0], { path: "a.ts", added: 5, removed: 5, ops: ["edit"] });
  assert.deepEqual(summary.files[1], { path: "b.ts", added: 5, removed: 0, ops: ["write"] });
  assert.equal(summary.added, 10);
  assert.equal(summary.removed, 5);
  assert.equal(formatDiffCount(1549), "1,549");
});

test("bulk tools count only aligned completed files despite a parent error", () => {
  const call = { name: "bulk_edit", arguments: { files: [
    { path: "a", edits: [{ oldText: "old", newText: "one\ntwo" }, { oldText: "remove", newText: "" }] },
    { path: "b", edits: [{ oldText: "old", newText: "failed" }] },
    { path: "c", edits: [{ oldText: "old", newText: "skipped" }] },
    { path: "d", edits: [{ oldText: "old", newText: "done" }] },
  ] } };
  const result = { isError: true, details: { files: [
    { path: "a", status: "completed" }, { path: "b", status: "failed" },
    { path: "c", status: "skipped" }, { path: "d", status: "completed" },
  ] } };
  assert.deepEqual(changesFromTool(call, result), [
    { path: "a", added: 2, removed: 2, op: "edit" },
    { path: "d", added: 1, removed: 1, op: "edit" },
  ]);
  // The single-change API remains single-file-only.
  assert.equal(changeFromTool(call, result), null);
});

test("bulk writes accept serialized or live arguments and accumulate all completed entries", () => {
  const args = { files: [{ path: "a", content: "one\ntwo\n" }, { path: "b", content: "" }, { path: "a", content: "three" }] };
  const result = { toolName: "bulk_write", args, details: { files: args.files.map(({ path }) => ({ path, status: "completed" })) } };
  const expected = [
    { path: "a", added: 2, removed: 0, op: "write" },
    { path: "b", added: 0, removed: 0, op: "write" },
    { path: "a", added: 1, removed: 0, op: "write" },
  ];
  assert.deepEqual(changesFromTool({}, result), expected);
  assert.deepEqual(changesFromTool({ name: "Bulk_Write", arguments: JSON.stringify(args) }, result), expected);
  const store = createChangeAccumulator();
  for (const change of changesFromTool({}, result)) accumulateChange(store, change);
  assert.deepEqual(summarizeFileChanges(store), { files: [
    { path: "a", added: 3, removed: 0, ops: ["write"] },
    { path: "b", added: 0, removed: 0, ops: ["write"] },
  ], added: 3, removed: 0 });
});

test("bulk changes require completed result details, not assumed success or blocked results", () => {
  for (const name of ["bulk_edit", "bulk_write"]) {
    const call = { name, arguments: { files: [{ path: "a", content: "new", edits: [{ oldText: "old", newText: "new" }] }] } };
    for (const result of [undefined, {}, { isError: false }, { isError: true },
      { isError: true, content: [{ type: "text", text: "Blocked by policy" }] },
      { details: { files: [] } }, { details: { files: [{ path: "a", status: "failed" }] } },
      { details: { files: [{ path: "a", status: "skipped" }] } },
      { details: { files: [{ path: "wrong", status: "completed" }] } },
      { running: true, details: { files: [{ path: "a", status: "completed" }] } },
    ]) assert.deepEqual(changesFromTool(call, result), []);
  }
  assert.deepEqual(changesFromTool({ name: "bulk_write", arguments: "invalid JSON" }, {}), []);
  assert.deepEqual(changesFromTool({ name: "bulk_edit", arguments: { files: [null] } }, { details: { files: [null] } }), []);
});

test("nested tool events in a bulk result do not double-count completed files", () => {
  const call = { name: "bulk_write", arguments: { files: [{ path: "a", content: "one\ntwo" }] } };
  const nested = { type: "tool_execution_end", toolName: "write", args: { path: "a", content: "one\ntwo" }, isError: false };
  const result = { content: [{ type: "text", text: JSON.stringify(nested) }],
    details: { files: [{ path: "a", status: "completed", events: [nested] }], events: [nested] } };
  const store = createChangeAccumulator();
  for (const change of changesFromTool(call, result)) accumulateChange(store, change);
  assert.equal(summarizeFileChanges(store).added, 2);
});

test("array API preserves single-file behavior and recognizes bulk write tools", () => {
  const call = { name: "write", arguments: { path: "a", content: "one" } };
  assert.deepEqual(changesFromTool(call), [changeFromTool(call)]);
  assert.deepEqual(changesFromTool(call, { isError: true }), []);
  assert.deepEqual(changesFromTool({ name: "read" }), []);
  for (const name of ["write", "edit", "bulk_edit", " BULK_WRITE "]) assert.equal(isWriteTool(name), true);
  assert.equal(isWriteTool("read"), false);
});

// Exercise both accumulation sites without booting the browser application.
test("transcript and live result accumulation count the same bulk call only once", () => {
  const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
  const transcript = source.slice(source.indexOf("        shown.add(block.id);"), source.indexOf("      } else renderContent(body, [block]"));
  const live = source.slice(source.indexOf("  for (const [id, result] of results) if (!shown.has(id))"), source.indexOf("  flushFileChanges(ctx, next, turnChanges, turnKey);", source.indexOf("  for (const [id, result] of results) if (!shown.has(id))")));
  const args = { files: [{ path: "a", content: "one\ntwo" }] };
  const result = { toolName: "bulk_write", args, details: { files: [{ path: "a", status: "completed" }] } };
  for (const hasTranscript of [true, false]) {
    const turnChanges = createChangeAccumulator();
    const sandbox = { changesFromTool, accumulateChange, turnChanges,
      block: { id: "batch", name: "bulk_write", arguments: args },
      results: new Map([["batch", result]]), shown: new Set(),
      body: { append() {} }, next: { append() {} }, renderTool() {} };
    vm.createContext(sandbox);
    if (hasTranscript) vm.runInContext(`{${transcript}}`, sandbox);
    vm.runInContext(live, sandbox);
    assert.deepEqual(summarizeFileChanges(turnChanges), {
      files: [{ path: "a", added: 2, removed: 0, ops: ["write"] }], added: 2, removed: 0,
    });
  }
});
