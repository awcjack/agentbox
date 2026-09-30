import assert from "node:assert/strict";
import test from "node:test";
import { fastModeControl } from "./commands.mjs";

const ready = { supported: true, writable: true };
const off = { available: true, enabled: false };
test("fast mode requires explicit metadata and command support", () => {
  for (const mode of [undefined, null, {}, { available: true }, { available: false, enabled: false }]) {
    assert.equal(fastModeControl(mode, ready).disabled, true);
    assert.equal(fastModeControl(mode, ready).pressed, false);
  }
  assert.equal(fastModeControl(null, ready).text, "Fast: unknown");
  assert.equal(fastModeControl(off, { writable: true }).disabled, true);
  assert.equal(fastModeControl(off, ready).disabled, false);
});
test("busy/read-only and refreshing controls cannot toggle", () => {
  assert.equal(fastModeControl(off, { supported: true, writable: false }).disabled, true);
  const pending = fastModeControl(off, { ...ready, refreshing: true });
  assert.equal(pending.disabled, true);
  assert.equal(pending.pressed, false, "waiting does not optimistically enable billing");
  assert.equal(pending.text, "Fast: refreshing...");
});
test("only confirmed metadata changes the displayed mode", () => {
  assert.equal(fastModeControl(off, ready).text, "Fast: off");
  const on = fastModeControl({ available: true, enabled: true }, ready);
  assert.equal(on.text, "Fast: on");
  assert.equal(on.pressed, true);
  assert.equal(on.disabled, false);
  assert.match(on.help, /new processes start off/);
});
