import test from "node:test";
import assert from "node:assert/strict";
import { imageSource, inlineTokens, markdownBlocks, renderMarkdown, safeHref } from "./markdown.mjs";

test("markdown recognizes headings, paragraphs, lists, quotes, and rules", () => {
  assert.deepEqual(markdownBlocks("# Hello\n\nA paragraph\nwith a second line\n\n- one\n- two\n\n3. three\n4. four\n\n> quoted\n> again\n\n---"), [
    { type: "h1", text: "Hello" }, { type: "p", text: "A paragraph\nwith a second line" },
    { type: "ul", start: undefined, items: ["one", "two"] }, { type: "ol", start: 3, items: ["three", "four"] },
    { type: "blockquote", text: "quoted\nagain" }, { type: "hr" },
  ]);
});

test("fenced code preserves raw code and incomplete streaming fences", () => {
  assert.deepEqual(markdownBlocks('```html\n<script>alert("x")</script>\n```'), [{ type: "code", language: "html", text: '<script>alert("x")</script>' }]);
  assert.deepEqual(markdownBlocks("~~~~js\nconst x = 1;\n~~~\nstill code"), [{ type: "code", language: "js", text: "const x = 1;\n~~~\nstill code" }]);
  assert.deepEqual(markdownBlocks("```js\nconst unfinished ="), [{ type: "code", language: "js", text: "const unfinished =" }]);
  assert.deepEqual(markdownBlocks("````md\n```\n````\nDone"), [{ type: "code", language: "md", text: "```" }, { type: "p", text: "Done" }]);
});

test("inline formatting is limited to explicit safe token types", () => {
  assert.deepEqual(inlineTokens("a **bold** _italic_ `code` [docs](https://example.com)"), [
    { type: "text", text: "a " }, { type: "strong", text: "bold" }, { type: "text", text: " " },
    { type: "em", text: "italic" }, { type: "text", text: " " }, { type: "code", text: "code" },
    { type: "text", text: " " }, { type: "a", text: "docs", href: "https://example.com" },
  ]);
  assert.deepEqual(inlineTokens("<img src=x onerror=alert(1)>"), [{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  assert.deepEqual(inlineTokens("`[x](javascript:alert)`"), [{ type: "code", text: "[x](javascript:alert)" }]);
  assert.deepEqual(inlineTokens(null), []);
});

test("untrusted links reject executable schemes and control-character obfuscation", () => {
  for (const value of ["javascript:alert(1)", "JaVaScRiPt:evil", "data:text/html,evil", "vbscript:evil", "file:///etc/passwd", "blob:https://example.com/x", "java\nscript:evil", "\tjavascript:evil", "https://example.com/ bad", "https://example.com/\0bad"]) assert.equal(safeHref(value), null, value);
  for (const value of ["https://example.com/a?b=c&d=e", "http://100.64.1.2", "/docs", "./file", "#heading", "mailto:user@example.com"]) assert.equal(safeHref(value), value);
  assert.equal(inlineTokens("[bad](javascript:evil)")[0].type, "text");
});

test("image sources allow base64 raster data only, not SVG or arbitrary URLs", () => {
  assert.equal(imageSource({ mimeType: "image/png", data: "aGVsbG8=" }), "data:image/png;base64,aGVsbG8=");
  for (const image of [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }, { mimeType: "text/html", data: "aGVsbG8=" }, { mimeType: "image/png", data: "https://evil.invalid/image" }, { mimeType: "image/png", data: '\" onerror=evil' }, null]) assert.equal(imageSource(image), null);
});

test("markdown treats HTML, entities, and image markup as text, never raw DOM", () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener() {}
    set innerHTML(_value) { throw new Error("Unsafe HTML assignment"); }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (text) => Object.assign(new Node("#text"), { textContent: text }) };
  try {
    const root = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=evil>\n\n&amp; [bad](javascript:evil)\n\n[docs](https://example.com)\n\n```html\n<iframe src=evil>\n```');
    const nodes = [];
    function visit(node) { nodes.push(node); node.children.forEach(visit); }
    visit(root);
    assert.ok(nodes.some((node) => node.textContent === "<script>alert(1)</script>"));
    assert.ok(nodes.some((node) => node.textContent === "<iframe src=evil>"));
    assert.ok(!nodes.some((node) => ["script", "iframe", "img"].includes(node.tag)));
    const links = nodes.filter((node) => node.tag === "a");
    assert.equal(links.length, 1);
    assert.equal(links[0].href, "https://example.com");
    assert.equal(links[0].rel, "noopener noreferrer");
    assert.equal(links[0].target, "_blank");
  } finally { globalThis.document = previous; }
});

test("unclosed emphasis and CRLF snapshots render without dropping text", () => {
  assert.deepEqual(markdownBlocks("hello\r\nworld\r\n\r\n**still streaming"), [{ type: "p", text: "hello\nworld" }, { type: "p", text: "**still streaming" }]);
  assert.deepEqual(inlineTokens("**still streaming"), [{ type: "text", text: "**still streaming" }]);
});
