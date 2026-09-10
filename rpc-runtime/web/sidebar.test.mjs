import test from "node:test";
import assert from "node:assert/strict";
import { initSidebarResize } from "./sidebar.mjs";

function setup(viewport = 1200) {
  const win = new EventTarget();
  win.innerWidth = viewport;
  const mobile = new EventTarget();
  mobile.matches = viewport <= 720;
  win.matchMedia = () => mobile;
  const classes = new Set();
  const properties = new Map();
  const workspace = { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, style: { setProperty: (name, value) => properties.set(name, value) } };
  const sidebar = { getBoundingClientRect: () => ({ width: Math.min(Math.max(220, parseFloat(properties.get("--sidebar-width")) || (win.innerWidth >= 1500 ? 285 : win.innerWidth <= 1000 ? 225 : 260)), Math.min(480, win.innerWidth - 420)) }) };
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
    assert.equal(attrs.get("aria-valuenow"), "220");
    fire(ending, { pointerId: 1 }, ending === "blur" ? win : undefined);
    assert.equal(captured.size, 0);
    assert.equal(classes.size, 0);
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
