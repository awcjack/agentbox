import assert from "node:assert/strict";
import test from "node:test";
import { findFilePreview, isMarkdownPath, pathBreadcrumb, pathBasename } from "./context-pane.mjs";

test("path helpers", () => {
  assert.equal(isMarkdownPath("docs/architecture.md"), true);
  assert.equal(isMarkdownPath("src/app.mjs"), false);
  assert.equal(pathBasename("docs/a/b.md"), "b.md");
  assert.equal(pathBreadcrumb("docs/architecture.md"), "docs › architecture.md");
});

test("findFilePreview prefers the latest matching write/edit/read", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "docs/a.md", content: "# Old" } }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "docs/a.md", edits: [{ oldText: "# Old", newText: "# New\n\nBody" }] } }],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "other.ts" } }],
    },
  ];
  const results = new Map([
    ["r1", { toolName: "read", content: [{ type: "text", text: "export {}" }] }],
  ]);
  const preview = findFilePreview(messages, results, "docs/a.md");
  assert.equal(preview.source, "edit");
  assert.match(preview.text, /# New/);
  assert.equal(findFilePreview(messages, results, "other.ts").text, "export {}");
  assert.equal(findFilePreview(messages, results, "missing"), null);
});
