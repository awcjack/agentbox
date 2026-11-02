import test from "node:test";
import assert from "node:assert/strict";
import { createMermaidPreview, downloadMermaidSvg, mermaidSvgImage, renderMermaidDiagram, resetMermaidLoader, sanitizeMermaidSvg } from "./mermaid-preview.mjs";

function installDocument() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.textContent = "";
      this.attributes = {};
      this.className = "";
      this.handlers = {};
      this.isConnected = false;
      this.parent = null;
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        node.isConnected = true;
        this.children.push(node);
      }
    }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
      this.isConnected = false;
    }
    click() { this.handlers.click?.(); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    set innerHTML(_value) { throw new Error("Unsafe HTML assignment"); }
  }
  const previous = globalThis.document;
  const head = new Node("head");
  const body = new Node("body");
  globalThis.document = {
    head,
    body,
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

function labelCenters(svg) {
  const centers = [];
  const nodePattern = /<g class="node[^"]*"[^>]*id="([^"]+)"[^>]*transform="translate\(([^,]+),\s*([^)]+)\)"[\s\S]*?<g class="label"[^>]*transform="translate\(([^,]+),\s*([^)]+)\)"[\s\S]*?<text([^>]*)>/g;
  for (const match of svg.matchAll(nodePattern)) {
    const textAttrs = match[6];
    const x = Number((/\bx="([^"]+)"/.exec(textAttrs) || [])[1] || 0);
    const y = Number((/\by="([^"]+)"/.exec(textAttrs) || [])[1] || 0);
    centers.push({
      id: match[1],
      x: Number(match[4]) + x,
      y: Number(match[5]) + y,
    });
  }
  return centers;
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

test("foreignObject HTML labels are converted to SVG text instead of dropped", () => {
  const svg = sanitizeMermaidSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><g><foreignObject width="80" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Start</p></span></div></foreignObject></g><script>evil()</script></svg>',
  );
  assert.doesNotMatch(svg, /foreignObject/i);
  assert.doesNotMatch(svg, /<script/i);
  assert.match(svg, /<text[^>]*>Start<\/text>/);
  assert.match(svg, /x="40"/);
  assert.match(svg, /y="20"/);
});

test("foreignObject conversion honors x/y and keeps labels centered in Mermaid label transforms", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" id="t">
  <g class="nodes">
    <g class="node default" id="n-rect" transform="translate(100, 100)">
      <g class="label" transform="translate(-60, -9)">
        <foreignObject width="120" height="18"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Caller</p></span></div></foreignObject>
      </g>
    </g>
    <g class="node default" id="n-cyl" transform="translate(300, 100)">
      <g class="label" transform="translate(-60, 1)">
        <foreignObject width="120" height="18"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>sessions/*.json</p></span></div></foreignObject>
      </g>
    </g>
    <g class="node default" id="n-xy" transform="translate(700, 100)">
      <g class="label" transform="translate(0, 0)">
        <foreignObject x="-40" y="-10" width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>XY</p></span></div></foreignObject>
      </g>
    </g>
  </g>
</svg>`;
  const cleaned = sanitizeMermaidSvg(source);
  assert.doesNotMatch(cleaned, /foreignObject/i);
  const centers = Object.fromEntries(labelCenters(cleaned).map((row) => [row.id, row]));
  assert.ok(centers["n-rect"]);
  assert.ok(Math.abs(centers["n-rect"].x) < 0.01, `rect x ${centers["n-rect"].x}`);
  assert.ok(Math.abs(centers["n-rect"].y) < 0.01, `rect y ${centers["n-rect"].y}`);
  assert.ok(Math.abs(centers["n-cyl"].x) < 0.01, `cylinder x ${centers["n-cyl"].x}`);
  assert.ok(Math.abs(centers["n-cyl"].y - 10) < 0.01, `cylinder y ${centers["n-cyl"].y}`);
  assert.ok(Math.abs(centers["n-xy"].x) < 0.01, `xy x ${centers["n-xy"].x}`);
  assert.ok(Math.abs(centers["n-xy"].y) < 0.01, `xy y ${centers["n-xy"].y}`);
});

test("foreignObject multi-line labels become tspans", () => {
  const svg = sanitizeMermaidSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><g class="node" id="n-multi" transform="translate(0,0)"><g class="label" transform="translate(-80, -9)"><foreignObject width="160" height="36"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Brain MCP<br/>searchBrain</p></span></div></foreignObject></g></g></svg>',
  );
  assert.match(svg, /Brain MCP<\/tspan>/);
  assert.match(svg, /searchBrain<\/tspan>/);
  assert.doesNotMatch(svg, /Brain MCP searchBrain/);
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
    assert.equal(ok.children[0].className, "mermaid-toolbar");
    assert.equal(ok.children[0].children[0].textContent, "Download SVG");
    assert.equal(ok.children[0].children[0].type, "button");
    assert.equal(ok.children[1].tag, "img");
    assert.match(ok.children[1].src, /^data:image\/svg\+xml/);

    const bad = await createMermaidPreview("nope", {
      render: async () => { throw new Error("Parse error"); },
    });
    assert.match(bad.className, /mermaid-error/);
    assert.equal(bad.children[0].textContent, "Mermaid preview failed: Parse error");
    assert.equal(bad.children.some((child) => /Download SVG/.test(child.textContent)), false);
  } finally { restore(); }
});

test("downloadMermaidSvg sanitizes and saves the rendered SVG", () => {
  const restore = installDocument();
  const previous = {
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const blobs = [];
    const urls = [];
    class FakeBlob {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type || "";
        blobs.push(this);
      }
    }
    globalThis.Blob = FakeBlob;
    globalThis.URL = {
      createObjectURL(blob) {
        const url = `blob:mermaid-${urls.length}`;
        urls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) { urls.push({ revoked: url }); },
    };
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    const result = downloadMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script><foreignObject width="40" height="20"><div>Node</div></foreignObject></svg>',
      {
        filename: "diagram.svg",
        createObjectURL: globalThis.URL.createObjectURL,
        revokeObjectURL: globalThis.URL.revokeObjectURL,
        BlobCtor: FakeBlob,
      },
    );
    assert.equal(result.filename, "diagram.svg");
    assert.doesNotMatch(result.svg, /<script/i);
    assert.doesNotMatch(result.svg, /foreignObject/i);
    assert.match(result.svg, /<text[^>]*>Node<\/text>/);
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].type, "image/svg+xml;charset=utf-8");
    assert.equal(blobs[0].parts[0], result.svg);
    assert.equal(document.body.children.length, 0);
    assert.equal(urls[0]?.url, "blob:mermaid-0");
    assert.ok(urls.some((entry) => entry.revoked === "blob:mermaid-0"));
  } finally {
    globalThis.Blob = previous.Blob;
    globalThis.URL = previous.URL;
    globalThis.setTimeout = previous.setTimeout;
    restore();
  }
});

test("createMermaidPreview Download SVG uses the rendered source", async () => {
  const restore = installDocument();
  try {
    const downloaded = [];
    const root = await createMermaidPreview("graph TD; A-->B", {
      render: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>',
      downloadSvg: (svg, options) => {
        downloaded.push({ svg, options });
        return { filename: options.filename, svg };
      },
      filename: "chart.svg",
    });
    const button = root.children[0].children[0];
    assert.equal(button.textContent, "Download SVG");
    button.handlers.click();
    assert.equal(downloaded.length, 1);
    assert.match(downloaded[0].svg, /<text>A<\/text>/);
    assert.equal(downloaded[0].options.filename, "chart.svg");
  } finally { restore();
  }
});
