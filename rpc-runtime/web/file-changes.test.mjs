import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateChange,
  changeFromTool,
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
