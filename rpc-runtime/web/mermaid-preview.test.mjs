import test from "node:test";
import assert from "node:assert/strict";
import { createMermaidPreview, mermaidSvgImage, renderMermaidDiagram, resetMermaidLoader } from "./mermaid-preview.mjs";

function installDocument() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.textContent = "";
      this.attributes = {};
      this.className = "";
      this.handlers = {};
    }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    set innerHTML(_value) { throw new Error("Unsafe HTML assignment"); }
  }
  const previous = globalThis.document;
  const head = new Node("head");
  globalThis.document = {
    head,
    createElement: (tag) => {
      const node = new Node(tag);
      Object.defineProperty(node, "className", {
        get() { return this._className || ""; },
        set(value) { this._className = String(value || ""); },
        configurable: true,
      });
      node.classList = {
        add: (...names) => {
          const current = new Set((node.className || "").split(/\s+/).filter(Boolean));
          for (const name of names) current.add(name);
          node.className = [...current].join(" ");
        },
      };
      return node;
    },
    createTextNode: (text) => Object.assign(new Node("#text"), { textContent: text }),
  };
  return () => { globalThis.document = previous; };
}

test("mermaid SVG becomes a data-image without scripts or handlers", () => {
  const restore = installDocument();
  try {
    const img = mermaidSvgImage('<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script><rect onclick="evil()" /><text>ok</text></svg>');
    assert.equal(img.tag, "img");
    assert.equal(img.alt, "Mermaid diagram");
    assert.match(img.src, /^data:image\/svg\+xml;charset=utf-8,/);
    const decoded = decodeURIComponent(img.src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
    assert.match(decoded, /<svg/);
    assert.doesNotMatch(decoded, /<script/i);
    assert.doesNotMatch(decoded, /onclick/i);
    assert.match(decoded, />ok</);
  } finally { restore(); }
});

test("mermaidSvgImage rejects non-SVG payloads", () => {
  const restore = installDocument();
  try {
    assert.throws(() => mermaidSvgImage('<div>not svg</div>'), /did not return SVG/);
  } finally { restore(); }
});

test("renderMermaidDiagram uses strict-initialized loader and unique ids", async () => {
  resetMermaidLoader();
  const calls = [];
  const fake = {
    async parse(text) { calls.push(["parse", text]); },
    async render(id, text) {
      calls.push(["render", id, text]);
      return { svg: `<svg id="${id}"><text>${text}</text></svg>` };
    },
  };
  const svg = await renderMermaidDiagram("graph TD; A-->B", { load: async () => fake });
  assert.match(svg, /<svg id="mermaid-preview-1">/);
  const again = await renderMermaidDiagram("graph TD; A-->C", { load: async () => fake });
  assert.match(again, /<svg id="mermaid-preview-2">/);
  assert.deepEqual(calls.map(call => call[0]), ["parse", "render", "parse", "render"]);
});

test("createMermaidPreview renders images and surfaces failures as text", async () => {
  const restore = installDocument();
  try {
    const ok = await createMermaidPreview("graph TD; A-->B", {
      render: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>',
    });
    assert.equal(ok.children[0].tag, "img");
    assert.match(ok.children[0].src, /^data:image\/svg\+xml/);

    const bad = await createMermaidPreview("nope", {
      render: async () => { throw new Error("Parse error"); },
    });
    assert.match(bad.className, /mermaid-error/);
    assert.equal(bad.children[0].textContent, "Mermaid preview failed: Parse error");
  } finally { restore(); }
});
