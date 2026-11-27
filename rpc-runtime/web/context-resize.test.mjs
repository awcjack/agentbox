import test from "node:test";
import assert from "node:assert/strict";
import { contextWidth, initContextResize } from "./context-resize.mjs";

test("pane widths preserve sidebar and at least 280 pixels for chat", () => {
  assert.equal(contextWidth(800, 1200, 260), 660);
  assert.equal(contextWidth(50, 1200, 260), 240);
  assert.equal(contextWidth(400, 1200, 260), 400);
});

test("divider supports pointer capture, keyboard sizing and cancellation", () => {
  const events = {}, windowEvents = {}, properties = {}, attrs = {}, classes = new Set();
  let capture;
  const separator = {
    addEventListener: (type, fn) => events[type] = fn,
    setAttribute: (key, value) => attrs[key] = value,
    focus() {}, setPointerCapture(id) { capture = id; },
    hasPointerCapture: id => capture === id,
    releasePointerCapture() { capture = null; },
  };
  const workspace = {
    clientWidth: 1200,
    style: { setProperty: (key, value) => properties[key] = value, getPropertyValue: key => properties[key] },
    classList: { add: key => classes.add(key), remove: key => classes.delete(key) },
  };
  const nodes = { workspace, "context-resizer": separator,
    "context-pane": { getBoundingClientRect: () => ({ width: parseInt(properties["--context-width"] || "400") }) },
    sidebar: { getBoundingClientRect: () => ({ width: 260 }) },
  };
  const paneResize = initContextResize({ getElementById: id => nodes[id], defaultView: { addEventListener: (type, fn) => windowEvents[type] = fn } });
  const event = { button: 0, isPrimary: true, pointerId: 1, clientX: 800, preventDefault() {} };
  events.pointerdown(event);
  events.pointermove({ ...event, pointerId: 2, clientX: 600 });
  assert.equal(properties["--context-width"], undefined);
  events.pointermove({ ...event, clientX: 600 });
  assert.equal(properties["--context-width"], "600px");
  assert.equal(attrs["aria-valuenow"], "600");
  windowEvents.blur();
  assert.equal(capture, null); assert.equal(classes.size, 0);
  events.keydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(properties["--context-width"], "590px");
  events.keydown({ key: "End", preventDefault() {} });
  assert.equal(properties["--context-width"], "660px");
  paneResize.setWidth(120);
  assert.equal(paneResize.getWidth(), 240);
  assert.equal(attrs["aria-valuenow"], "240");
});
