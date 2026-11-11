import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewInput, previewPoint, previewWheel } from "./browser-input.mjs";
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("preview coordinates scale to the screenshot and reject letterboxing/outside clicks", () => {
  const frame = { width: 1280, height: 720 }, rect = { left: 50, top: 100, width: 640, height: 360 };
  assert.deepEqual(previewPoint(frame, rect, 370, 280), { x: 640, y: 360 });
  assert.deepEqual(previewPoint(frame, rect, 50, 100), { x: 0, y: 0 });
  for (const [x, y] of [[49, 100], [690, 100], [50, 460], [NaN, 120]]) assert.equal(previewPoint(frame, rect, x, y), null);
  assert.equal(previewPoint(frame, { ...rect, height: 640 }, 370, 110), null);
  assert.equal(previewPoint(frame, { ...rect, width: 0 }, 50, 100), null);
});

function fixture() {
  const state = { canInput: true, held: true }, calls = [], notices = [];
  const input = createPreviewInput({ getState: () => state, send: async (request) => { calls.push(request); state.canInput = false; return true; }, onStatus: (message) => notices.push(message) });
  return { state, calls, input, notices, fresh: async () => { state.canInput = true; input.update(state); await flush(); } };
}
test("click then fast typing, paste, and editing keys retain order across fresh frames", async () => {
  const f = fixture();
  assert.equal(f.input.click(320, 220), true); await flush();
  f.input.type("He"); f.input.type("llo"); f.input.press("Backspace"); f.input.type("世界 --config 'literal'\n");
  assert.deepEqual(f.calls, [{ action: "pointer", x: 320, y: 220 }]);
  assert.equal(f.input.click(2, 3), false, "a pending input cannot be redirected to a different field");
  await f.fresh(); await f.fresh(); await f.fresh();
  assert.deepEqual(f.calls, [{ action: "pointer", x: 320, y: 220 }, { action: "type", text: "Hello" }, { action: "press", key: "Backspace" }, { action: "type", text: "世界 --config 'literal'\n" }]);
  f.input.dispose();
});
test("lost control, failed input, disposal and buffer overflow discard unsent typing without retries", async () => {
  for (const reason of ["release", "dispose", "overflow"]) {
    const f = fixture(); f.input.click(2, 3); await flush(); f.input.type("secret");
    if (reason === "release") { f.state.held = false; f.input.update(f.state); }
    if (reason === "dispose") f.input.dispose();
    if (reason === "overflow") f.input.type("x".repeat(10000));
    await f.fresh(); assert.equal(f.calls.length, 1, reason); f.input.dispose();
  }
  const state = { canInput: true, held: true }, calls = [];
  const input = createPreviewInput({ getState: () => state, send: async (request) => { calls.push(request); return false; } });
  input.click(2, 3); input.type("discard"); await flush(); input.update(state); await flush();
  assert.equal(calls.length, 1); input.dispose();
});
test("renewal before dispatch waits for a fresh frame without sending or dropping input", async () => {
  const f = fixture();
  f.input.click(2, 3); f.state.canInput = false; await flush();
  assert.equal(f.calls.length, 0);
  await f.fresh(); assert.deepEqual(f.calls, [{ action: "pointer", x: 2, y: 3 }]);
  f.input.dispose();
});
test("typing older than five seconds is discarded and disposal before dispatch sends nothing", async () => {
  let now = 1000;
  const state = { held: true, canInput: true }, calls = [];
  const input = createPreviewInput({ now: () => now, getState: () => state, send: async (request) => { calls.push(request); state.canInput = false; return true; } });
  input.click(1, 1); await flush(); input.type("old"); now += 5000; state.canInput = true; input.update(state); await flush();
  assert.equal(calls.length, 1); input.dispose();
  const stopped = createPreviewInput({ getState: () => state, send: async (r) => { calls.push(r); return true; } });
  stopped.click(1, 1); stopped.dispose(); await flush(); assert.equal(calls.length, 1);
});

test("wheel normalizes pixels, lines, pages, diagonal movement and letterboxing without intercepting pinch zoom", () => {
  const frame = { width: 1280, height: 720 }, rect = { left: 0, top: 0, width: 640, height: 360 };
  const event = { clientX: 200, clientY: 100, deltaX: 2, deltaY: 12, deltaMode: 0 };
  assert.deepEqual(previewWheel(event, frame, rect), { x: 400, y: 200, deltaX: 4, deltaY: 24 });
  assert.equal(previewWheel({ ...event, deltaMode: 1 }, frame, rect).deltaY, 384);
  assert.equal(previewWheel({ ...event, deltaX: 0, deltaY: -1, deltaMode: 2 }, frame, rect).deltaY, -720);
  assert.equal(previewWheel({ ...event, deltaY: 99999 }, frame, rect).deltaY, 2000);
  assert.equal(previewWheel({ ...event, ctrlKey: true }, frame, rect), null);
  assert.equal(previewWheel({ ...event, clientX: -1 }, frame, rect), null);
  assert.equal(previewWheel({ ...event, deltaY: NaN }, frame, rect), null);
  assert.equal(previewWheel({ ...event, clientY: 1 }, frame, { ...rect, height: 640 }).y, 360);
});
test("wheel works without clicking first, coalesces a gesture, preserves direction changes and clears on resolution change", async () => {
  const f = fixture(); f.state.canInput = false;
  f.input.wheel(100, 100, 2, 10); f.input.wheel(100, 100, 3, 20); f.input.wheel(100, 100, 0, -12);
  await f.fresh(); await f.fresh();
  assert.deepEqual(f.calls, [{ action: "wheel", x: 100, y: 100, deltaX: 5, deltaY: 30 }, { action: "wheel", x: 100, y: 100, deltaX: 0, deltaY: -12 }]);
  f.input.update({ ...f.state, frame: { width: 1280, height: 720 } });
  f.input.wheel(100, 100, 0, 10);
  f.input.update({ ...f.state, frame: { width: 390, height: 844 } });
  await f.fresh(); assert.equal(f.calls.length, 2);
  f.input.dispose();
});
