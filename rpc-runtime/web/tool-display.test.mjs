import assert from "node:assert/strict";
import test from "node:test";
import { toolPreview, canGroupActions } from "./tool-display.mjs";

test("collapsed tools summarize commands, file paths, searches and URLs", () => {
  for (const [name, args, expected] of [
    ["bash", { command: "  cd src\n\t&& npm test  " }, "cd src && npm test"],
    ["read", { path: "src/main.mjs", offset: 42 }, "src/main.mjs"],
    ["write", { path: "out.mjs", content: "do not preview the whole file" }, "out.mjs"],
    ["edit", { file_path: "out.mjs", edits: [] }, "out.mjs"],
    ["web_search", { query: "build123d examples" }, "build123d examples"],
    ["web_fetch", { url: "https://example.com" }, "https://example.com"],
  ]) assert.equal(toolPreview({ name, arguments: args }), expected);
  assert.equal(toolPreview({ arguments: '{"command":"npm test"}' }), "npm test");
  assert.equal(toolPreview({ arguments: "raw input" }), "raw input");
  assert.equal(toolPreview({}, { args: { command: "live command" } }), "live command");
  assert.equal(toolPreview({ arguments: { unknown: "secret value" } }), "");
  assert.equal(toolPreview({}), "");
  assert.equal(toolPreview({ arguments: null }), "");
});

test("previews are bounded and whitespace normalized without changing full arguments", () => {
  const command = "printf '<script>not markup</script>'\n" + "x".repeat(200);
  const call = { arguments: { command } };
  const preview = toolPreview(call);
  assert.equal(preview.length, 140);
  assert.ok(preview.endsWith("…"));
  assert.ok(!preview.includes("\n"));
  assert.equal(call.arguments.command, command);
  assert.equal(toolPreview({ arguments: { command: "a\u0000b\u007fc" } }), "a b c");
});

const action = (extra = {}) => ({ role: "assistant", model: "model", provider: "provider", content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", name: "bash" }], ...extra });

test("group consecutive thinking/tools from the same model without merging prose or turns", () => {
  assert.equal(canGroupActions(action(), action()), true);
  assert.equal(canGroupActions(action({ content: [{ type: "thinking", thinking: "plan" }] }), action()), true);
  assert.equal(canGroupActions(null, action()), false);
  for (const boundary of [
    action({ role: "user" }), action({ role: "custom" }),
    action({ content: [{ type: "text", text: "Here are the results" }] }),
    action({ content: [{ type: "image" }] }), action({ content: [] }),
    action({ errorMessage: "failed" }), action({ stopReason: "aborted" }),
    action({ stopReason: "error" }), action({ summary: "Compacted" }),
    action({ model: "different" }), action({ provider: "different" }),
  ]) {
    assert.equal(canGroupActions(action(), boundary), false);
    assert.equal(canGroupActions(boundary, action()), false);
  }
});

test("bulk previews show bounded file counts and paths without content or edits", () => {
  const files = [
    { path: "src/a", content: "PRIVATE CONTENT", edits: [{ oldText: "PRIVATE OLD", newText: "PRIVATE NEW" }] },
    { path: "src/b", content: "PRIVATE CONTENT" },
  ];
  for (const name of ["bulk_write", "bulk_edit"]) {
    assert.equal(toolPreview({ name, arguments: { files } }), "2 files: src/a, src/b");
    assert.equal(toolPreview({ name, arguments: JSON.stringify({ files }) }), "2 files: src/a, src/b");
    assert.equal(toolPreview({}, { toolName: name, args: { files } }), "2 files: src/a, src/b");
    assert.equal(toolPreview({ name, arguments: { files: [files[0]] } }), "1 file: src/a");
    assert.equal(toolPreview({ name, arguments: { files: [] } }), "0 files");
    assert.equal(toolPreview({ name, arguments: { files: [null, {}] } }), "2 files");
    const preview = toolPreview({ name, arguments: { files: [{ path: "a\nb" }, { path: "x".repeat(200) }] } });
    assert.equal(preview.length, 140);
    assert.ok(preview.startsWith("2 files: a b, "));
    assert.ok(preview.endsWith("…"));
  }
});
