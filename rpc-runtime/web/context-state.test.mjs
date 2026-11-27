import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { isMediaPreviewPath } from "./file-preview.mjs";

const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function harness() {
  const nodes = new Map(), widths = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, dataset: {}, title: "", scrollTop: 0, textContent: "", children: [],
      classList: { add() {}, remove() {} },
      style: { setProperty: (key, value) => widths.set(key, value), getPropertyValue: key => widths.get(key) || "", removeProperty: key => widths.delete(key) },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
      setAttribute() {}, focus() { this.focused = true; },
    });
    return nodes.get(id);
  };
  const h = {
    current: null, contextRevision: 0, contextText: null,
    previewBinding: null, filePreview: null, browserPanel: null, browserBinding: null, paneResize: {},
    token: "fixture", mounts: [], disposed: 0,
    $: node, closeSubagentPane() {},
    contextPane: node("context-pane"), contextReturnFocus: null,
    compactHeader: { matches: false }, document: { activeElement: null, createTextNode: textContent => ({ textContent }) },
    main: { contains: () => false }, syncWorkspaceInert() {},
    active: ctx => h.current === ctx,
    browserViewAvailable: ctx => h.current === ctx && ctx.ready && ctx.online && ctx.readable !== false,
    canDownloadFile: ctx => h.current === ctx && ctx.writable !== false,
    createTransport: () => ({ request() {} }),
    mountBrowserPanel: (_root, options) => {
      h.mounts.push(options);
      return { getViewState: () => options.viewState || { mode: "normal", height: "" }, dispose: () => h.disposed++ };
    },
    visibleMessages: () => [],
    findFilePreview: (_messages, _results, path) => ({ path, text: "Preview text" }),
    isMarkdownPath: () => false, pathBreadcrumb: value => value,
    isMediaPreviewPath, formatDiffCount: String,
    element: (_tag, _class, text) => ({
      textContent: text, children: [],
      append(...children) { this.children.push(...children); },
      addEventListener(name, listener) { this[name] = listener; },
    }),
  };
  vm.createContext(h);
  vm.runInContext(source.slice(source.indexOf("function rememberContextPane("), source.indexOf("function renderFileChangesCard(")), h);
  const session = id => ({ id, meta: { nativeSessionId: `native-${id}` }, record: { messages: [] }, tools: new Map(), ready: true, online: true });
  return { h, node, session, widths };
}

test("switching A → B → A restores each pane independently and disposes browser control", () => {
  const { h, node, session, widths } = harness();
  const a = session("a"), b = session("b");
  h.current = a;
  h.openBrowserPane({ viewState: { mode: "expanded", height: "55vh" } });
  node("context-pane-body").scrollTop = 120;
  widths.set("--context-width", "700px");
  h.closeContextPane({ remember: true });
  assert.equal(h.disposed, 1); assert.equal(h.browserBinding, null);
  assert.equal(a.record.paneState.nativeId, "native-a");
  h.current = b;
  h.openContextPane("/workspace/b.txt");
  node("context-pane-body").scrollTop = 50; widths.set("--context-width", "360px");
  h.closeContextPane({ remember: true });
  h.current = a; a.restorePane = true;
  h.restoreContextPane(a);
  assert.equal(node("context-pane").dataset.mode, "browser");
  assert.equal(node("context-pane-body").scrollTop, 120);
  assert.equal(widths.get("--context-width"), "700px");
  assert.equal(h.mounts.at(-1).viewState.mode, "expanded");
  assert.equal(h.mounts.at(-1).viewState.height, "55vh");
  assert.equal(h.mounts.at(-1).paneResize, h.paneResize);
  assert.equal(node("context-pane-body").focused, true, "only the original explicit open focused the pane");
  h.closeContextPane({ remember: true });
  h.current = b; b.restorePane = true; h.restoreContextPane(b);
  assert.equal(node("context-pane").dataset.mode, "file");
  assert.equal(node("context-pane-path").title, "/workspace/b.txt");
  assert.equal(node("context-pane-body").scrollTop, 50);
  assert.equal(widths.get("--context-width"), "360px");
});

test("Edited files only read workspace media on click in the owning, eligible session", () => {
  const { h, node, session } = harness();
  const a = session("a"); h.current = a;
  const reads = [];
  h.downloadWorkspaceFile = (ctx, path, options) => reads.push([ctx, path, options.preview]);
  const button = path => h.fileChangeRow(a, { path, added: 1, removed: 0 }).children[0];
  const image = button("assets/hero image.PNG");
  const pdf = button("docs/report.pdf");
  const text = button("notes.txt");
  assert.equal(reads.length, 0, "rendering a card does not read files");
  image.click(); pdf.click(); text.click();
  assert.deepEqual(reads, [[a, "assets/hero image.PNG", true], [a, "docs/report.pdf", true]]);
  assert.equal(node("context-pane").dataset.mode, "file");
  assert.equal(node("context-pane-path").title, "notes.txt");
  assert.equal(node("context-pane-body").children[0].textContent, "Preview text");

  a.writable = false;
  image.click();
  assert.equal(node("context-pane").dataset.mode, "file", "read-only sessions keep transcript previews");
  h.current = session("b");
  const revision = h.contextRevision;
  pdf.click();
  assert.equal(h.contextRevision, revision, "a stale row cannot replace the current pane");
  assert.equal(reads.length, 2);
});

test("pending restoration survives rapid switches, waits for readiness, and never retakes control", () => {
  const { h, node, session } = harness();
  const a = session("a"); h.current = a;
  a.record.paneState = { nativeId: "native-a", mode: "browser", browser: { mode: "fullscreen", height: "" }, scrollTop: 10 };
  const saved = a.record.paneState;
  a.restorePane = true; a.ready = false;
  h.restoreContextPane(a); h.closeContextPane({ remember: true });
  assert.equal(a.record.paneState, saved); assert.equal(h.mounts.length, 0);
  a.ready = true; a.restorePane = true; h.restoreContextPane(a);
  assert.equal(h.mounts.length, 1); assert.equal(h.mounts[0].viewState.mode, "fullscreen");
  assert.equal(node("context-pane-body").focused, undefined, "background restore does not steal composer focus");
  assert.equal(a.restorePane, false);
  h.restoreContextPane(a); // Normal controls only invoke restore when restorePane is true.
});

test("explicit close and native replacement discard restoration", () => {
  const { h, session, node } = harness();
  const a = session("a"); h.current = a;
  a.record.paneState = { nativeId: "native-a", mode: "browser" }; a.restorePane = true;
  h.closeContextPane();
  assert.equal(a.record.paneState, undefined); assert.equal(a.restorePane, false);
  a.record.paneState = { nativeId: "old-native", mode: "browser" }; a.restorePane = true;
  h.restoreContextPane(a);
  assert.equal(a.record.paneState, undefined); assert.equal(h.mounts.length, 0);
  assert.equal(node("context-pane").hidden, true);
});

test("workspace files are reread with the selected session and late loads cannot restore stale scroll", async () => {
  const { h, session, node } = harness();
  const a = session("a"); h.current = a; a.restorePane = true;
  a.record.paneState = { nativeId: "native-a", mode: "workspace-file", path: "/workspace/a.md", scrollTop: 88 };
  let finish;
  h.downloadWorkspaceFile = (ctx, path, options) => {
    assert.equal(ctx, a); assert.equal(path, "/workspace/a.md"); assert.equal(options.preview, true);
    h.closeContextPane();
    return new Promise(resolve => { finish = resolve; });
  };
  h.restoreContextPane(a);
  h.closeContextPane(); node("context-pane-body").scrollTop = 5;
  finish(); await Promise.resolve();
  assert.equal(node("context-pane-body").scrollTop, 5);
  assert.equal(node("context-pane").hidden, true);
});

test("workspace-file restoration reapplies scroll after a successful current read", async () => {
  const { h, session, node } = harness();
  const a = session("a"); h.current = a; a.restorePane = true;
  a.record.paneState = { nativeId: "native-a", mode: "workspace-file", path: "/workspace/a.md", scrollTop: 88 };
  h.downloadWorkspaceFile = async () => {
    h.closeContextPane(); node("context-pane").hidden = false;
  };
  h.restoreContextPane(a); await Promise.resolve();
  assert.equal(node("context-pane-body").scrollTop, 88);
});

test("a session with its pane closed stays closed while retaining its own width", () => {
  const { h, session, node, widths } = harness();
  const a = session("a"); h.current = a;
  widths.set("--context-width", "450px");
  h.closeContextPane({ remember: true });
  assert.equal(a.record.paneState.mode, null);
  widths.set("--context-width", "800px"); a.restorePane = true;
  h.restoreContextPane(a);
  assert.equal(widths.get("--context-width"), "450px");
  assert.equal(node("context-pane").hidden, true); assert.equal(h.mounts.length, 0);
});

test("permission loss waits without reading a workspace file", () => {
  const { h, session } = harness();
  const a = session("a"); h.current = a; a.restorePane = true; a.writable = false;
  a.record.paneState = { nativeId: "native-a", mode: "workspace-file", path: "/workspace/a.md" };
  h.downloadWorkspaceFile = () => assert.fail("must not read under revoked permissions");
  h.restoreContextPane(a);
  assert.equal(a.restorePane, true); assert.ok(a.record.paneState);
});

test("switch capture precedes abort/selection change, while logout still clears all records", () => {
  const activate = source.slice(source.indexOf("function activate("), source.indexOf("async function createSession("));
  assert.ok(activate.indexOf("closeContextPane({ remember: true })") < activate.indexOf("current.controller.abort()"));
  assert.ok(activate.indexOf("closeContextPane({ remember: true })") < activate.indexOf("current = ctx"));
  assert.match(activate, /restorePane: true/);
  const logout = source.slice(source.indexOf("function logout("), source.indexOf("async function connectWithToken("));
  assert.match(logout, /records.clear\(\)/);
});
