import test from "node:test";
import assert from "node:assert/strict";
import { inlineTokens, renderMarkdown } from "./markdown.mjs";

class Node {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.handlers = {};
    this.classList = { add() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  set innerHTML(_value) { throw new Error("Unsafe HTML assignment"); }
}
const all = node => [node, ...node.children.flatMap(all)];
function fixture(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: tag => new Node(tag),
    createTextNode: text => Object.assign(new Node("#text"), { textContent: text }),
  };
  try { run(); } finally { globalThis.document = previous; }
}

test("table document labels download their own file in place, without a six-file cap", () => fixture(() => {
  const clicked = [];
  const source = "| Document | Contents |\n|---|---|\n" + Array.from({ length: 12 }, (_, i) =>
    `| [${i === 0 ? "Audit" : `Document ${i}`}](docs/report-${i}.md) | Findings |`).join("\n");
  const nodes = all(renderMarkdown(source, { onFileDownload: path => clicked.push(path) }));
  const buttons = nodes.filter(node => node.className === "file-download");
  assert.equal(buttons.length, 12);
  assert.deepEqual(clicked, [], "rendering must not fetch or download anything");
  assert.equal(buttons[0].textContent, "Audit");
  assert.equal(buttons[0].attributes["aria-label"], "Download Audit");
  assert.equal(buttons[0].href, undefined, "local file paths must not navigate the web app");
  buttons[0].handlers.click(); buttons[11].handlers.click();
  assert.deepEqual(clicked, ["docs/report-0.md", "docs/report-11.md"]);
}));

test("encoded spaces, angle paths, escaped spaces, parentheses and line anchors target the correct file", () => fixture(() => {
  const clicked = [];
  const source = '[CSV](reports/final%20draft.csv#L42) [PDF](<reports/annual report.pdf> "title") [zip](out/report(1).zip) [escaped](out/my\\ file.txt) [quote](out/a.zip \'title\')';
  const buttons = all(renderMarkdown(source, { onFileDownload: path => clicked.push(path) })).filter(node => node.className === "file-download");
  assert.deepEqual(buttons.map(node => node.textContent), ["CSV", "PDF", "zip", "escaped", "quote"]);
  buttons.forEach(node => node.handlers.click());
  assert.deepEqual(clicked, ["reports/final draft.csv", "reports/annual report.pdf", "out/report(1).zip", "out/my file.txt", "out/a.zip"]);
}));

test("ordinary URLs and anchors stay links, unsafe schemes stay text", () => fixture(() => {
  const clicked = [];
  const source = '[Web](https://host/docs/file.zip) [CDN](//host/file.zip) [Email](mailto:user@example.com) [Section](#part) [bad](javascript:alert(1)) [bad](file:///etc/passwd) [bad](data:text/html,evil)';
  const nodes = all(renderMarkdown(source, { onFileDownload: path => clicked.push(path) }));
  assert.deepEqual(nodes.filter(node => node.tag === "a").map(node => node.href), ["https://host/docs/file.zip", "//host/file.zip", "mailto:user@example.com", "#part"]);
  assert.equal(nodes.filter(node => node.className === "file-download").length, 0);
  assert.deepEqual(clicked, []);
  for (const node of nodes.filter(node => node.tag === "a")) assert.equal(node.rel, "noopener noreferrer");
}));

test("inline-code file paths become inline download controls; fenced source stays untouched", () => fixture(() => {
  const clicked = [];
  const source = 'Saved `/workspace/out/final draft.pdf` and `README.md`; use `npm install`.\n\n```sh\ncat /workspace/example.txt\n```';
  const nodes = all(renderMarkdown(source, { onFileDownload: path => clicked.push(path) }));
  const buttons = nodes.filter(node => node.className === "file-download");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].children[0].tag, "code");
  buttons.forEach(node => node.handlers.click());
  assert.deepEqual(clicked, ["/workspace/out/final draft.pdf", "README.md"]);
  assert.ok(nodes.some(node => node.tag === "code" && node.textContent === "npm install"));
  assert.ok(nodes.some(node => node.tag === "code" && node.textContent === "cat /workspace/example.txt"));
}));

test("download rendering is opt-in and Markdown previews inherit the callback", () => fixture(() => {
  const ordinary = all(renderMarkdown('[Audit](docs/audit.md) `README.md`'));
  assert.equal(ordinary.filter(node => node.className === "file-download").length, 0);
  assert.equal(ordinary.find(node => node.tag === "a").href, "docs/audit.md");
  const clicked = [];
  const root = renderMarkdown('```md\n[Audit](docs/audit.md)\n```', { onFileDownload: path => clicked.push(path) });
  all(root).find(node => node.textContent === "Preview").handlers.click();
  all(root).find(node => node.className === "file-download").handlers.click();
  assert.deepEqual(clicked, ["docs/audit.md"]);
}));

test("balanced destinations preserve external URLs and incomplete links remain visible", () => {
  assert.deepEqual(inlineTokens('[Web](https://host/report(1).zip)'), [{ type: "a", text: "Web", href: "https://host/report(1).zip" }]);
  assert.deepEqual(inlineTokens('[still streaming](docs/report'), [{ type: "text", text: "[still streaming](docs/report" }]);
  assert.deepEqual(inlineTokens('[bad](javascript:alert(1))'), [{ type: "text", text: "[bad](javascript:alert(1))" }]);
});
