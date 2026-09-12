import assert from "node:assert/strict";
import test from "node:test";
import { attentionTitle, createAttentionTracker } from "./attention.mjs";

const session = (id, extra = {}) => ({ id, nativeSessionId: `native-${id}`, status: "running", activity: "idle", settledEventId: null, pendingUi: [], ...extra });
const dialog = (id, method = "confirm") => ({ id, method });

test("tab title counts sessions needing action and finished sessions, not dialogs", () => {
  const tracker = createAttentionTracker();
  const sessions = [session("a", { pendingUi: [dialog("1"), dialog("2", "input")] }), session("b", { settledEventId: 10 }), session("c", { settledEventId: 20 }), session("fresh")];
  assert.deepEqual(tracker.update(sessions), { action: 1, finished: 2 });
  assert.equal(attentionTitle(tracker.update(sessions), "Pi Agent | Agentbox"), "1! 2 | Pi Agent | Agentbox");
  assert.equal(attentionTitle({ action: 1, finished: 0 }, "Pi"), "1! | Pi");
  assert.equal(attentionTitle({ action: 0, finished: 2 }, "Pi"), "2 | Pi");
  assert.equal(attentionTitle({ action: 0, finished: 0 }, "Pi"), "Pi");
});

test("entering a session acknowledges only that session and repeated polls do not recount it", () => {
  const tracker = createAttentionTracker();
  const sessions = [session("a", { pendingUi: [dialog("1"), dialog("2")] }), session("b", { settledEventId: 10 })];
  assert.deepEqual(tracker.update(sessions, "a"), { action: 0, finished: 1 });
  assert.deepEqual(tracker.update(sessions), { action: 0, finished: 1 });
  sessions[0].pendingUi.shift();
  assert.deepEqual(tracker.update(sessions), { action: 0, finished: 1 }, "resolving one dialog does not resurrect another");
  sessions[0].pendingUi.push(dialog("3", "editor"));
  assert.deepEqual(tracker.update(sessions), { action: 1, finished: 1 }, "a new dialog counts again");
  assert.deepEqual(tracker.update(sessions, "b"), { action: 1, finished: 0 });
  assert.deepEqual(tracker.update(sessions), { action: 1, finished: 0 });
  sessions[1].settledEventId = 11;
  assert.deepEqual(tracker.update(sessions), { action: 1, finished: 1 }, "a run completed between polls still counts");
});

test("viewed sessions stay acknowledged, but hidden or unfocused sessions notify", () => {
  const tracker = createAttentionTracker();
  const sessions = [session("a", { settledEventId: 5 })];
  assert.deepEqual(tracker.update(sessions, "a"), { action: 0, finished: 0 });
  sessions[0].settledEventId++;
  assert.deepEqual(tracker.update(sessions, null), { action: 0, finished: 1 });
  assert.deepEqual(tracker.update(sessions, "a"), { action: 0, finished: 0 });
  sessions[0].pendingUi = [dialog("input", "input")];
  assert.deepEqual(tracker.update(sessions, null), { action: 1, finished: 0 });
  assert.deepEqual(tracker.update(sessions, "a"), { action: 0, finished: 0 });
});

test("new idle sessions, running sessions and notifications are not unread completions", () => {
  const tracker = createAttentionTracker();
  assert.deepEqual(tracker.update([session("fresh"), session("running", { activity: "running", settledEventId: 2 }), session("notify", { pendingUi: [dialog("n", "notify")] })]), { action: 0, finished: 0 });
  const waiting = session("waiting", { settledEventId: 2, pendingUi: [dialog("approval")] });
  assert.deepEqual(tracker.update([waiting]), { action: 1, finished: 0 }, "action takes priority over completion");
});

test("ending, conversation replacement and logout clean up acknowledgement state", () => {
  const tracker = createAttentionTracker();
  const item = session("a", { settledEventId: 2 });
  tracker.update([item], "a");
  assert.deepEqual(tracker.update([{ ...item, nativeSessionId: "fork" }]), { action: 0, finished: 1 });
  assert.deepEqual(tracker.update([{ ...item, status: "exited" }]), { action: 0, finished: 0 });
  assert.deepEqual(tracker.update([]), { action: 0, finished: 0 });
  tracker.update([item], "a"); tracker.clear();
  assert.deepEqual(tracker.update([item]), { action: 0, finished: 1 });
});
