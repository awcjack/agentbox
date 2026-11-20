import test from "node:test";
import assert from "node:assert/strict";
import { createFilePreview } from "./file-preview.mjs";

function fixtures() {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this._text = ""; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set innerHTML(_value) { throw new Error("Unsafe HTML assignment"); }
  }
  const created = [], revoked = [];
  const document = { createElement: tag => new Node(tag) };
  const URL = {
    createObjectURL(blob) { created.push(blob); return `blob:test-${created.length}`; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  return { document, URL, created, revoked };
}

for (const [name, type] of [
  ["evil.svg", "image/png"], ["evil.HTML", "application/pdf"],
  ["evil.xhtml", "text/html"], ["unknown", "image/svg+xml"],
]) {
  test(`${name} (${type}) stays inert source despite conflicting MIME`, async () => {
    const f = fixtures();
    const source = '<svg onload="evil()"><script>evil()</script><img src="https://evil.invalid/x"></svg>';
    const preview = await createFilePreview(new Blob([source], { type }), name, {
      ...f, renderMarkdown() { throw new Error("Source passed to Markdown"); },
    });
    assert.equal(preview.node.children[0].tag, "pre");
    assert.equal(preview.node.textContent, source);
    assert.equal(f.created.length, 0);
    preview.dispose();
  });
}

test("UTF-8 text uses textContent even when it contains HTML", async () => {
  const f = fixtures();
  const text = '<script>alert("你好")</script>';
  const { node } = await createFilePreview(new Blob([text]), "notes.txt", f);
  assert.equal(node.children[0].tag, "pre");
  assert.equal(node.textContent, text);
});

for (const extension of ["md", "markdown"]) {
  test(`${extension} calls safe Markdown with text only and no callbacks`, async () => {
    const f = fixtures();
    const content = f.document.createElement("section");
    let args;
    const preview = await createFilePreview(new Blob(["# heading"]), `notes.${extension}`, {
      ...f, renderMarkdown(...values) { args = values; return content; },
    });
    assert.deepEqual(args, ["# heading"]);
    assert.equal(preview.node.children[0], content);
    assert.equal(preview.text, "# heading", "copy uses Markdown source rather than rendered text");
    assert.equal(preview.truncated, false);
  });
}

for (const bytes of [[0xff, 0xfe], [65, 0, 66], [65, 27, 66], [0xc3, 0x28], [0xc2, 0x85]]) {
  test(`rejects binary bytes ${bytes}`, async () => {
    const f = fixtures();
    const { node } = await createFilePreview(new Blob([new Uint8Array(bytes)]), "unknown.bin", f);
    assert.match(node.textContent, /unsupported binary/);
    assert.match(node.textContent, /Download/);
    assert.equal(node.children[0].tag, "p");
    assert.equal(f.created.length, 0);
  });
}

test("text reads are bounded to 1 MiB and explicitly truncated, including split UTF-8", async () => {
  const f = fixtures();
  const limit = 1024 * 1024;
  const blob = new Blob(["a".repeat(limit - 1), "€", "rest"]);
  const reads = [];
  const bounded = {
    size: blob.size, type: "",
    slice(start, end) { reads.push([start, end]); return blob.slice(start, end); },
  };
  const { node } = await createFilePreview(bounded, "large.txt", f);
  assert.deepEqual(reads, [[0, limit]]);
  assert.equal(node.children[0].textContent, "a".repeat(limit - 1));
  assert.match(node.children[1].textContent, /truncated at 1 MiB/);
});

test("exact limit is not truncated; incomplete UTF-8 in a complete file is rejected", async () => {
  const f = fixtures();
  const { node } = await createFilePreview(new Blob(["a".repeat(1024 * 1024)]), "exact.txt", f);
  assert.equal(node.children.length, 1);
  const invalid = await createFilePreview(new Blob([new Uint8Array([0xe2, 0x82])]), "bad.txt", f);
  assert.match(invalid.node.textContent, /unsupported binary/);
});

for (const [extension, type] of Object.entries({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif", pdf: "application/pdf",
})) {
  test(`${extension} uses a MIME-typed URL, safe attributes, and idempotent disposal`, async () => {
    const f = fixtures();
    const preview = await createFilePreview(new Blob(["data"], { type: "application/octet-stream" }), `file.${extension}`, f);
    const media = preview.node.children[0];
    assert.equal(media.tag, extension === "pdf" ? "iframe" : "img");
    assert.equal(media.src, "blob:test-1");
    assert.equal(f.created[0].type, type);
    assert.equal(await f.created[0].text(), "data");
    assert.equal(media.attributes.referrerpolicy, "no-referrer");
    if (extension === "pdf") {
      assert.equal(media.attributes.sandbox, "");
      assert.match(preview.node.textContent, /cannot display this sandboxed PDF.*Download file/);
    }
    preview.dispose();
    preview.dispose();
    assert.deepEqual(f.revoked, ["blob:test-1"]);
    assert.equal(preview.node.children.length, 0);
  });
}

test("recognized raster MIME works for extensionless files", async () => {
  const f = fixtures();
  const { node } = await createFilePreview(new Blob(["data"], { type: "image/png" }), "image", f);
  assert.equal(node.children[0].tag, "img");
});

test("initially stale preview does not read or allocate URLs", async () => {
  const f = fixtures();
  const { node } = await createFilePreview({ get type() { throw new Error("Must not inspect stale file"); } }, "x.png", { ...f, valid: () => false });
  assert.equal(node.children.length, 0);
  assert.equal(f.created.length, 0);
});

test("read completing after invalidation does not render or call Markdown", async () => {
  const f = fixtures();
  let finish, valid = true;
  const blob = { size: 4, type: "", slice: () => ({ arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }) };
  const pending = createFilePreview(blob, "note.md", {
    ...f, valid: () => valid, renderMarkdown() { throw new Error("Stale Markdown"); },
  });
  valid = false;
  finish(new TextEncoder().encode("text").buffer);
  const { node } = await pending;
  assert.equal(node.children.length, 0);
  assert.equal(f.created.length, 0);
});

test("async Markdown finishing after invalidation is not shown", async () => {
  const f = fixtures();
  let finish, started, valid = true;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = createFilePreview(new Blob(["# hi"]), "note.md", {
    ...f, valid: () => valid,
    renderMarkdown: () => new Promise(resolve => { finish = resolve; started(); }),
  });
  await ready;
  valid = false;
  finish(f.document.createElement("section"));
  const { node } = await pending;
  assert.equal(node.children.length, 0);
});

test("failed stale reads do not show error text", async () => {
  const f = fixtures();
  let valid = true;
  const blob = { size: 1, type: "", slice: () => ({ async arrayBuffer() { valid = false; throw new Error("read failure"); } }) };
  const { node } = await createFilePreview(blob, "x.txt", { ...f, valid: () => valid });
  assert.equal(node.children.length, 0);
});
