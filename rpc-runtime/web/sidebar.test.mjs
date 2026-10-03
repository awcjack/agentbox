import test from "node:test";
import assert from "node:assert/strict";
import {
  compareArchivedSessions, initSidebarResize, initSessionDragDrop, sessionActivitySymbol,
  sessionFolderKey, normalizeFolder, readSessionFolders, saveSessionFolders,
} from "./sidebar.mjs";

test("session icons distinguish every activity and retain history and unknown fallbacks", () => {
  const expected = {
    starting: "◷", running: "▶", waiting_reply: "?", waiting_action: "!",
    finished: "✓", idle: "○", stopping: "■", exited: "×", history: "/",
  };
  for (const [activity, symbol] of Object.entries(expected)) {
    assert.equal(sessionActivitySymbol(activity), symbol);
  }
  assert.equal(new Set(Object.values(expected)).size, Object.keys(expected).length);
  assert.equal(sessionActivitySymbol("unknown"), ">");
  assert.equal(sessionActivitySymbol(undefined), ">");
});

test("session icons follow transitions into and out of waiting states", () => {
  assert.deepEqual(
    ["starting", "running", "waiting_action", "running", "waiting_reply", "idle", "exited"].map(sessionActivitySymbol),
    ["◷", "▶", "!", "▶", "?", "○", "×"],
  );
});

test("archives sort newest creation first, regardless of title, modification time or profile", () => {
  const oldest = { id: "old", name: "A session", profile: "work", createdAt: "2026-01-01T00:00:00.000Z", modifiedAt: "2026-05-01T00:00:00.000Z" };
  const middle = { id: "middle", name: "Z session", profile: "personal", createdAt: "2026-02-01T00:00:00.000Z", modifiedAt: "2026-04-01T00:00:00.000Z" };
  const newest = { id: "new", name: "M session", profile: "work", createdAt: "2026-03-01T00:00:00.000Z", modifiedAt: "2026-03-01T00:00:00.000Z" };
  assert.deepEqual([middle, oldest, newest].sort(compareArchivedSessions).map((session) => session.id), ["new", "middle", "old"]);
  oldest.name = "ZZ renamed";
  oldest.modifiedAt = "2026-06-01T00:00:00.000Z";
  assert.deepEqual([oldest, newest, middle].sort(compareArchivedSessions).map((session) => session.id), ["new", "middle", "old"]);
});

test("archive sorting supports older servers and keeps equal creation dates stable", () => {
  const first = { name: "Z", createdAt: "2026-02-01T00:00:00.000Z", modifiedAt: "2026-03-01T00:00:00.000Z" };
  const second = { name: "A", createdAt: first.createdAt, modifiedAt: "2026-04-01T00:00:00.000Z" };
  const legacy = { modifiedAt: "2026-01-01T00:00:00.000Z" };
  const unknown = { name: "Unknown date" };
  assert.deepEqual([unknown, legacy, first, second].sort(compareArchivedSessions), [first, second, legacy, unknown]);
});

test("folder keys follow native identity across runtime restarts and history", () => {
  const live = { profile: "work", id: "runtime-one", nativeSessionId: "native-one" };
  const key = sessionFolderKey(live);
  assert.equal(key, JSON.stringify(["work", "native-one"]));
  assert.equal(sessionFolderKey({ ...live, id: "runtime-two" }), key);
  assert.equal(sessionFolderKey({ profile: "work", id: "native-one", nativeSessionId: "ignored" }, true), key);
  assert.notEqual(sessionFolderKey({ ...live, nativeSessionId: "native-two" }), key);
});

test("folder keys separate profiles, runtime fallbacks, and delimiter-like identities", () => {
  const keys = [];
  for (const profile of ["work", "personal"]) {
    const runtime = { profile, id: "same" };
    const native = { ...runtime, nativeSessionId: "same" };
    const runtimeKey = sessionFolderKey(runtime);
    const nativeKey = sessionFolderKey(native);
    assert.equal(runtimeKey, JSON.stringify([profile, "runtime:same"]));
    assert.equal(sessionFolderKey({ ...runtime, nativeSessionId: "" }), runtimeKey);
    assert.equal(sessionFolderKey(runtime, true), nativeKey);
    assert.notEqual(sessionFolderKey({ ...runtime, id: "other" }), runtimeKey);
    keys.push(runtimeKey, nativeKey);
  }
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(
    sessionFolderKey({ profile: "a:b", nativeSessionId: "c" }),
    sessionFolderKey({ profile: "a", nativeSessionId: "b:c" }),
  );
  const escaped = { profile: 'work/"team"', nativeSessionId: 'id\\with,delimiters' };
  assert.deepEqual(JSON.parse(sessionFolderKey(escaped)), [escaped.profile, escaped.nativeSessionId]);
});

test("folder normalization trims nested levels, drops empty levels, and is idempotent", () => {
  for (const [input, expected] of [
    [" / Projects // Client A / Design / ", "Projects/Client A/Design"],
    ["\tWork /\n Notes\t/", "Work/Notes"],
    ["", ""], [" / // \t ", ""],
    [" .hidden / release..notes / 日本語 ", ".hidden/release..notes/日本語"],
    [Array(12).fill("level").join("/"), Array(12).fill("level").join("/")],
    [` ${"x".repeat(80)} `, "x".repeat(80)],
  ]) {
    assert.equal(normalizeFolder(input), expected);
    assert.equal(normalizeFolder(expected), expected);
  }
});

test("folder normalization rejects traversal, excessive depth, and oversized names", () => {
  for (const input of [
    ".", "..", "Work/./Notes", "Work/ ../Notes", "../Work", "Work/..",
    Array(13).fill("level").join("/"), `Work/${"x".repeat(81)}`,
  ]) {
    assert.throws(() => normalizeFolder(input), /Use up to 12 folder levels/, input);
  }
});

const folderStorageKey = "agentbox.pi.session-folders.v1";

function folderStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[folderStorageKey, initial]]);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("folder storage roundtrips profile-scoped identities and replaces saved assignments", () => {
  const storage = folderStorage();
  assert.deepEqual(readSessionFolders(storage), new Map());
  const folders = new Map([
    [sessionFolderKey({ profile: "work", id: "one", nativeSessionId: "shared" }), "Projects/Client A"],
    [sessionFolderKey({ profile: "personal", id: "shared" }, true), "Personal/Notes"],
    [sessionFolderKey({ profile: "work", id: "one" }), ""],
  ]);
  assert.equal(saveSessionFolders(storage, folders), true);
  assert.deepEqual([...storage.values.keys()], [folderStorageKey]);
  assert.deepEqual(JSON.parse(storage.values.get(folderStorageKey)), [...folders]);
  const restored = readSessionFolders(storage);
  assert.deepEqual(restored, folders);
  assert.notEqual(restored, folders);
  assert.equal(saveSessionFolders(storage, new Map()), true);
  assert.equal(storage.values.get(folderStorageKey), "[]");
  assert.deepEqual(readSessionFolders(storage), new Map());
});

test("folder storage filters malformed entries and normalizes nested assignments", () => {
  const storage = folderStorage(JSON.stringify([
    ["valid", " / Projects // Notes / "], ["root", " / "],
    null, 42, "bad", {}, [], ["missing"], ["extra", "folder", "value"],
    [7, "folder"], ["null", null], ["object", {}], ["number", 5],
    ["duplicate", "Old"], ["duplicate", " New / Child "],
  ]));
  assert.deepEqual(readSessionFolders(storage), new Map([
    ["valid", "Projects/Notes"], ["root", ""], ["duplicate", "New/Child"],
  ]));
});

test("folder storage safely discards corrupt JSON, invalid containers, and invalid paths", () => {
  for (const raw of [
    "{broken", "null", "{}", '"text"', "42", "true", "",
    ...["Work/../Notes", Array(13).fill("level").join("/"), "x".repeat(81)]
      .map((path) => JSON.stringify([["valid", "Work"], ["invalid", path]])),
  ]) {
    assert.deepEqual(readSessionFolders(folderStorage(raw)), new Map(), raw);
  }
});

test("folder storage tolerates unavailable APIs and read or write failures", () => {
  const folders = new Map([["key", "Work/Notes"]]);
  for (const storage of [undefined, null, {}, {
    getItem() { throw new Error("Storage access denied"); },
    setItem() { throw new Error("Storage quota exceeded"); },
  }]) {
    assert.deepEqual(readSessionFolders(storage), new Map());
    assert.equal(saveSessionFolders(storage, folders), false);
  }
  assert.deepEqual(folders, new Map([["key", "Work/Notes"]]));
});

function setup(viewport = 1200) {
  const win = new EventTarget();
  win.innerWidth = viewport;
  const mobile = new EventTarget();
  mobile.matches = viewport <= 720;
  win.matchMedia = () => mobile;
  const classes = new Set();
  const properties = new Map();
  const workspace = { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, style: { setProperty: (name, value) => properties.set(name, value) } };
  const sidebar = { getBoundingClientRect: () => ({ width: Math.min(Math.max(64, parseFloat(properties.get("--sidebar-width")) || (win.innerWidth >= 1500 ? 285 : win.innerWidth <= 1000 ? 225 : 260)), Math.min(480, win.innerWidth - 420)) }) };
  const separator = new EventTarget();
  const attrs = new Map();
  const captured = new Set();
  separator.setAttribute = (name, value) => attrs.set(name, value);
  separator.focus = () => {};
  separator.setPointerCapture = (id) => captured.add(id);
  separator.hasPointerCapture = (id) => captured.has(id);
  separator.releasePointerCapture = (id) => captured.delete(id);
  initSidebarResize({ defaultView: win, getElementById: (id) => ({ workspace, sidebar, "sidebar-resizer": separator })[id] });
  function fire(type, values = {}, target = separator) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, values);
    target.dispatchEvent(event);
    return event;
  }
  function resize(width) {
    win.innerWidth = width;
    mobile.matches = width <= 720;
    fire("resize", {}, win);
  }
  return { win, separator, attrs, classes, captured, properties, fire, resize };
}

test("keyboard resizing exposes pixel values and clamps to viewport bounds", () => {
  const { attrs, fire, resize } = setup();
  assert.equal(attrs.get("aria-valuenow"), "260");
  assert.equal(fire("keydown", { key: "ArrowRight" }).defaultPrevented, true);
  assert.equal(attrs.get("aria-valuenow"), "270");
  fire("keydown", { key: "ArrowLeft", shiftKey: true });
  assert.equal(attrs.get("aria-valuenow"), "230");
  fire("keydown", { key: "Home" });
  fire("keydown", { key: "ArrowLeft" });
  assert.equal(attrs.get("aria-valuenow"), "64");
  assert.equal(attrs.get("aria-valuetext"), "Collapsed conversation rail");
  fire("keydown", { key: "ArrowRight" });
  assert.equal(attrs.get("aria-valuenow"), "220");
  fire("keydown", { key: "End" });
  assert.equal(attrs.get("aria-valuetext"), "480 pixels");
  resize(721);
  assert.equal(attrs.get("aria-valuemax"), "301");
  assert.equal(attrs.get("aria-valuenow"), "301");
  resize(1200);
  assert.equal(attrs.get("aria-valuenow"), "480");
  assert.equal(fire("keydown", { key: "Tab" }).defaultPrevented, false);
  assert.equal(fire("keydown", { key: "Home", ctrlKey: true }).defaultPrevented, false);
});

test("pointer capture resizes by delta, ignores other pointers, and cleans up", () => {
  const { fire, attrs, classes, captured, win } = setup();
  for (const ending of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
    fire("pointerdown", { button: 0, isPrimary: true, pointerId: 1, clientX: 260 });
    assert.equal(captured.has(1), true);
    assert.equal(classes.has("sidebar-resizing"), true);
    fire("pointermove", { pointerId: 2, clientX: 900 });
    assert.notEqual(attrs.get("aria-valuenow"), "480");
    fire("pointermove", { pointerId: 1, clientX: 900 });
    assert.equal(attrs.get("aria-valuenow"), "480");
    fire("pointermove", { pointerId: 1, clientX: -900 });
    assert.equal(attrs.get("aria-valuenow"), "64");
    assert.equal(classes.has("sidebar-collapsed"), true);
    fire(ending, { pointerId: 1 }, ending === "blur" ? win : undefined);
    assert.equal(captured.size, 0);
    assert.equal(classes.has("sidebar-resizing"), false);
    fire("keydown", { key: "ArrowRight" });
    assert.equal(classes.has("sidebar-collapsed"), false);
  }
});

test("mobile disables resizing and cancels drag without changing desktop preference", () => {
  const { separator, properties, captured, fire, resize, attrs } = setup();
  fire("keydown", { key: "End" });
  fire("pointerdown", { button: 0, isPrimary: true, pointerId: 1, clientX: 480 });
  resize(720);
  assert.equal(separator.hidden, true);
  assert.equal(captured.size, 0);
  fire("keydown", { key: "Home" });
  fire("pointerdown", { button: 0, isPrimary: true, pointerId: 1, clientX: 280 });
  fire("pointermove", { pointerId: 1, clientX: 900 });
  assert.equal(captured.size, 0);
  assert.equal(properties.get("--sidebar-width"), "480px");
  resize(1200);
  assert.equal(separator.hidden, false);
  assert.equal(attrs.get("aria-valuenow"), "480");
  assert.equal(setup(390).separator.hidden, true);
});

test("untouched defaults follow breakpoints and non-primary buttons do not drag", () => {
  const { attrs, resize, fire, captured, properties } = setup(900);
  assert.equal(attrs.get("aria-valuenow"), "225");
  resize(1600);
  assert.equal(attrs.get("aria-valuenow"), "285");
  assert.equal(properties.size, 0);
  for (const values of [{ button: 2, isPrimary: true }, { button: 0, isPrimary: false }]) {
    fire("pointerdown", { ...values, pointerId: 1, clientX: 285 });
    assert.equal(captured.size, 0);
  }
});

function dragSetup() {
  class Element extends EventTarget {
    constructor(parent, dataset = {}, sessionItem = false) {
      super();
      this.parent = parent;
      this.dataset = dataset;
      this.sessionItem = sessionItem;
      this.draggable = sessionItem;
      this.classes = new Set();
      this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
    }
    contains(node) {
      for (; node; node = node.parent) if (node === this) return true;
      return false;
    }
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (selector === ".session-item" ? node.sessionItem : Object.hasOwn(node.dataset, "folderPath")) return node;
      }
      return null;
    }
  }
  const outside = new Element(null, { folderPath: "Outside" });
  const root = new Element(outside);
  root.ownerDocument = new EventTarget();
  const button = new Element(root, { sessionKey: "test-key" }, true);
  const icon = new Element(button);
  const folder = new Element(root, { folderPath: "Work" });
  const nested = new Element(folder, { folderPath: "Work/Notes" });
  const label = new Element(nested);
  const ungrouped = new Element(root, { folderPath: "" });
  const source = { session: { id: "test-id" }, historical: true };
  const moves = [];
  let allowed = true;
  let ends = 0;
  const controller = initSessionDragDrop(root, {
    getSource: (key) => key === "test-key" ? source : undefined,
    canMove: (candidate) => { assert.equal(candidate, source); return allowed; },
    move: (...args) => {
      assert.equal(controller.isDragging(), false);
      for (const target of [folder, nested, ungrouped]) assert.equal(target.classes.has("drag-over"), false);
      moves.push(args);
    },
    onEnd: () => { assert.equal(controller.isDragging(), false); ends++; },
  });
  const payload = new Map();
  const transfer = { setData: (type, value) => payload.set(type, value) };
  function fire(type, target = icon, values = {}, dispatcher = root) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, { dataTransfer: transfer, ...values });
    dispatcher.dispatchEvent(event);
    return event;
  }
  return { root, outside, button, icon, folder, nested, label, ungrouped, source, moves, controller, transfer, payload, fire,
    setAllowed: (value) => { allowed = value; }, ends: () => ends };
}

test("session drag moves to the closest nested folder, clears before move, and ends once", () => {
  const s = dragSetup();
  s.fire("dragstart");
  assert.equal(s.controller.isDragging(), true);
  assert.equal(s.transfer.effectAllowed, "move");
  assert.deepEqual([...s.payload], [["application/x-agentbox-session", "session"], ["text/plain", "session"]]);
  assert.equal(s.fire("dragover", s.folder).defaultPrevented, true);
  assert.equal(s.folder.classes.has("drag-over"), true);
  assert.equal(s.fire("dragover", s.label).defaultPrevented, true);
  assert.equal(s.transfer.dropEffect, "move");
  assert.equal(s.folder.classes.has("drag-over"), false);
  assert.equal(s.nested.classes.has("drag-over"), true);
  assert.equal(s.fire("drop", s.label).defaultPrevented, true);
  s.fire("drop", s.label);
  s.fire("dragend");
  assert.deepEqual(s.moves, [[s.source, "Work/Notes"]]);
  assert.equal(s.ends(), 1);
});

test("session drag supports empty Ungrouped folder paths", () => {
  const s = dragSetup();
  s.fire("dragstart");
  s.fire("dragover", s.ungrouped);
  s.fire("drop", s.ungrouped);
  assert.deepEqual(s.moves, [[s.source, ""]]);
});

test("external transfer payloads and targets outside the root cannot authorize moves", () => {
  const s = dragSetup();
  s.payload.set("application/x-agentbox-session", "session");
  s.payload.set("text/plain", "test-key");
  assert.equal(s.fire("dragover", s.folder).defaultPrevented, false);
  assert.equal(s.fire("drop", s.folder).defaultPrevented, false);
  assert.equal(s.ends(), 0);
  s.fire("dragstart", s.outside);
  assert.equal(s.controller.isDragging(), false);
  s.fire("dragstart");
  for (const target of [s.root, s.outside]) {
    assert.equal(s.fire("dragover", target).defaultPrevented, false);
  }
  s.fire("drop", s.root);
  assert.equal(s.controller.isDragging(), false);
  assert.deepEqual(s.moves, []);
  assert.equal(s.ends(), 1);
});

test("read-only, non-draggable, and missing sessions cannot start a drag", () => {
  for (const mode of ["read-only", "non-draggable", "missing"]) {
    const s = dragSetup();
    if (mode === "read-only") s.setAllowed(false);
    if (mode === "non-draggable") s.button.draggable = false;
    if (mode === "missing") s.button.dataset.sessionKey = "unknown";
    assert.equal(s.fire("dragstart").defaultPrevented, true);
    assert.equal(s.controller.isDragging(), false);
    assert.equal(s.fire("dragover", s.folder).defaultPrevented, false);
    s.fire("drop", s.folder);
    assert.deepEqual(s.moves, []);
    assert.equal(s.ends(), 0);
  }
});

test("permission is checked again at dragover and drop", () => {
  for (const overAfterRevocation of [true, false]) {
    const s = dragSetup();
    s.fire("dragstart");
    s.fire("dragover", s.folder);
    s.setAllowed(false);
    if (overAfterRevocation) {
      assert.equal(s.fire("dragover", s.folder).defaultPrevented, false);
      assert.equal(s.folder.classes.has("drag-over"), false);
    }
    assert.equal(s.fire("drop", s.folder).defaultPrevented, false);
    assert.equal(s.folder.classes.has("drag-over"), false);
    assert.equal(s.controller.isDragging(), false);
    assert.deepEqual(s.moves, []);
    assert.equal(s.ends(), 1);
  }
});

test("dragleave keeps the highlight within a target and clears it on exit", () => {
  const s = dragSetup();
  s.fire("dragstart");
  s.fire("dragover", s.label);
  s.fire("dragleave", s.label, { relatedTarget: s.nested });
  assert.equal(s.nested.classes.has("drag-over"), true);
  s.fire("dragleave", s.label, { relatedTarget: s.folder });
  assert.equal(s.nested.classes.has("drag-over"), false);
  s.fire("dragover", s.label);
  s.fire("dragleave", s.nested, { relatedTarget: null });
  assert.equal(s.nested.classes.has("drag-over"), false);
  assert.equal(s.controller.isDragging(), true);
});

test("cancel, dragend, and document Escape clean up once and allow later drags", () => {
  for (const ending of ["cancel", "dragend", "Escape"]) {
    const s = dragSetup();
    s.fire("dragstart");
    s.fire("dragover", s.folder);
    s.fire("keydown", s.root, { key: "Enter" }, s.root.ownerDocument);
    assert.equal(s.controller.isDragging(), true);
    if (ending === "cancel") s.controller.cancel();
    else if (ending === "Escape") s.fire("keydown", s.root, { key: "Escape" }, s.root.ownerDocument);
    else s.fire("dragend");
    assert.equal(s.controller.isDragging(), false);
    assert.equal(s.folder.classes.has("drag-over"), false);
    s.controller.cancel();
    s.fire("drop", s.folder);
    s.fire("dragend");
    assert.deepEqual(s.moves, []);
    assert.equal(s.ends(), 1);
    s.fire("dragstart");
    s.fire("drop", s.folder);
    assert.deepEqual(s.moves, [[s.source, "Work"]]);
    assert.equal(s.ends(), 2);
  }
});
