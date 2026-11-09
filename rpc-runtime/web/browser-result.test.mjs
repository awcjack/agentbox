import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { element, imageSource, renderMarkdown } from "./markdown.mjs";
import { renderSubagents } from "./subagents.mjs";
import { toolPreview } from "./tool-display.mjs";

// Exercise the existing generic app renderer, not a browser-specific frontend.
const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function renderer() {
  const sandbox = { element, imageSource, renderMarkdown, renderSubagents, toolPreview };
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(source.indexOf("function renderContent("), source.indexOf("function rememberRecent("))
    + source.slice(source.indexOf("function renderTool("), source.indexOf("let bashElapsedTimer")), sandbox);
  return sandbox.renderTool;
}

test("generic RPC tool rendering preserves inline browser screenshots and versioned metadata", () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    set innerHTML(_) { throw new Error("Unsafe HTML"); }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag) };
  const flatten = (node) => [node, ...node.children.flatMap(flatten)];
  const details = {
    browser: { version: 1, nativeSessionId: "conversation-a", ownerSessionId: "conversation-a",
      browserSessionId: "agent-a", ownership: "tab", delegated: false, status: "ready",
      capabilities: { liveView: false, takeover: false, screenshots: "inline", persistentLogin: false } },
    artifact: { version: 1, id: "screenshot-a", kind: "screenshot", mimeType: "image/jpeg", bytes: 3, delivery: "inline" },
  };
  const result = { toolName: "browser", content: [
    { type: "text", text: "Untrusted browser screenshot. <script>not HTML</script>" },
    { type: "image", mimeType: "image/jpeg", data: "/9j/" },
    { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
  ], details };
  try {
    const renderTool = renderer();
    for (const call of [{ name: "browser", arguments: { action: "screenshot" } }, {}]) {
      const root = renderTool(call, result, "browser-call");
      const nodes = flatten(root);
      assert.equal(root.dataset.detailKey, "tool:browser-call");
      const images = nodes.filter((node) => node.tag === "img");
      assert.equal(images.length, 1);
      assert.equal(images[0].src, "data:image/jpeg;base64,/9j/");
      assert.equal(images[0].loading, "lazy");
      assert.ok(nodes.some((node) => node.tag === "pre" && node.textContent === JSON.stringify(details, null, 2)));
      assert.ok(nodes.some((node) => node.tag === "pre" && node.textContent === result.content[0].text));
      assert.ok(!nodes.some((node) => ["script", "iframe", "a", "button"].includes(node.tag)));
    }
  } finally { globalThis.document = previous; }
});
