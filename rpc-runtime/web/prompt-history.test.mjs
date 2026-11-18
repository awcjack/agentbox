import test from "node:test";
import assert from "node:assert/strict";
import { createPromptHistory, canNavigatePromptHistory } from "./prompt-history.mjs";

const user = (content, timestamp) => ({ role: "user", content, ...(timestamp === undefined ? {} : { timestamp }) });
const textBlock = (text) => ({ type: "text", text });
const image = { type: "image", data: "not-recall-text" };
function recalled(history, count) {
  history.resetNavigation();
  return Array.from({ length: count }, () => history.navigate("older", "draft"));
}

test("sync recalls only user text in order, preserves whitespace, and does not mutate messages", () => {
  const messages = [
    user(" first ", 1),
    { role: "assistant", content: "assistant", timestamp: 2 },
    { role: "system", content: "system" },
    { role: "toolResult", content: "tool" },
    { role: "tool", content: "tool" },
    user([image], 3), user("", 4), user([textBlock("  ")], 5),
    user([textBlock("one"), image, textBlock("two")], 6),
    user("last\nline", 7),
  ];
  const original = structuredClone(messages);
  const history = createPromptHistory();
  history.sync(messages);
  assert.deepEqual(recalled(history, 4), ["last\nline", "one\ntwo", " first ", " first "]);
  assert.deepEqual(messages, original);
});

test("repeated polling and stale shorter snapshots never duplicate confirmed sends", () => {
  const history = createPromptHistory();
  const messages = [user("first", 1), user("second", 2)];
  history.sync(messages);
  history.sync(structuredClone(messages));
  history.sync(messages.slice(0, 1));
  history.sync([...messages, user("third", 3)]);
  assert.deepEqual(recalled(history, 4), ["third", "second", "first", "first"]);
});

test("identical prompts are separate sends with distinct or colliding timestamps and without timestamps", () => {
  for (const timestamps of [[1, 2], [1, 1], [undefined, undefined]]) {
    const history = createPromptHistory();
    const messages = timestamps.map((timestamp) => user("same", timestamp));
    history.sync([user("start", 0), ...messages]);
    history.sync(structuredClone([user("start", 0), ...messages]));
    assert.deepEqual(recalled(history, 4), ["same", "same", "start", "start"]);
  }
});

test("timestamp collisions do not hide different contents; timestamp-free identity ignores nonuser insertions", () => {
  const history = createPromptHistory();
  history.sync([user("first", 1), user("second", 1), user("no timestamp")]);
  history.sync([user("first", 1), { role: "assistant", content: "new" }, user("second", 1), user("no timestamp")]);
  assert.deepEqual(recalled(history, 4), ["no timestamp", "second", "first", "first"]);
});

test("remember recalls clean text immediately and reconciles expanded string or block content", () => {
  for (const content of ["clean\nUploaded file: file.txt", [textBlock("clean"), image, textBlock("Uploaded file: file.txt")]]) {
    const history = createPromptHistory();
    history.sync([user("old", 1)]);
    history.remember("clean", content);
    assert.deepEqual(recalled(history, 2), ["clean", "old"]);
    history.sync([user("old", 1)]); // Poll before the accepted send appears.
    history.sync([user("old", 1), user(content, 2)]);
    history.sync([user("old", 1), user(content, 2)]);
    assert.deepEqual(recalled(history, 3), ["clean", "old", "old"]);
  }
});

test("two identical accepted sends reconcile one-for-one with incremental transcript echoes", () => {
  for (const timestamp of [2, undefined]) {
    const history = createPromptHistory();
    const initial = [user("old", 1)];
    history.sync(initial);
    history.remember("clean", "expanded");
    history.remember("clean", "expanded");
    assert.deepEqual(recalled(history, 3), ["clean", "clean", "old"]);
    const first = [...initial, user("expanded", timestamp)];
    history.sync(first);
    history.sync(structuredClone(first));
    assert.deepEqual(recalled(history, 3), ["clean", "clean", "old"]);
    history.sync([...first, user("expanded", timestamp)]);
    assert.deepEqual(recalled(history, 4), ["clean", "clean", "old", "old"]);
  }
});

test("a single sync reconciles multiple pending sends in FIFO order and preserves each clean text", () => {
  const history = createPromptHistory();
  history.remember("first clean", "same expanded content");
  history.remember("second clean", "same expanded content");
  const messages = [user("same expanded content", 5), user("same expanded content", 5)];
  history.sync(messages);
  history.sync(structuredClone(messages));
  assert.deepEqual(recalled(history, 3), ["second clean", "first clean", "first clean"]);
});

test("an older equal prompt cannot consume a new pending send; unrelated new messages retain order", () => {
  const history = createPromptHistory();
  const initial = [user("same", 1)];
  history.sync(initial);
  history.remember("same");
  history.sync(initial);
  assert.deepEqual(recalled(history, 2), ["same", "same"]);
  history.sync([...initial, user("external", 2), user("same", 3)]);
  assert.deepEqual(recalled(history, 4), ["external", "same", "same", "same"]);
});

test("an accepted command without a transcript echo stays older than later confirmed prompts", () => {
  const history = createPromptHistory();
  history.remember("/extension-command");
  history.remember("new prompt");
  history.sync([user("new prompt", 1)]);
  history.sync([user("new prompt", 1)]);
  assert.deepEqual(recalled(history, 3), ["new prompt", "/extension-command", "/extension-command"]);
  history.remember("latest clean", "latest expanded");
  history.sync([user("new prompt", 1), user("latest expanded", 2)]);
  assert.deepEqual(recalled(history, 4), ["latest clean", "new prompt", "/extension-command", "/extension-command"]);
});

test("pending entries are actually evicted: a late echo appends as unmatched transcript text", () => {
  const history = createPromptHistory({ limit: 2 });
  history.remember("evicted clean", "evicted expanded");
  history.remember("kept clean", "kept expanded");
  history.remember("latest clean", "latest expanded");
  history.sync([user("evicted expanded", 1)]);
  assert.deepEqual(recalled(history, 3), ["evicted expanded", "latest clean", "latest clean"]);
  history.sync([user("evicted expanded", 1), user("latest expanded", 2)]);
  assert.deepEqual(recalled(history, 3), ["evicted expanded", "latest clean", "latest clean"]);
});

test("seen identity uses extracted text, not image payloads or string/block representation", () => {
  const history = createPromptHistory();
  history.sync([user([textBlock("same"), image], 1)]);
  history.sync([user([textBlock("same"), { ...image, data: "different image payload" }], 1)]);
  history.sync([user("same", 1)]);
  history.sync([user("same", 1), user("new", 2)]);
  assert.deepEqual(recalled(history, 3), ["new", "same", "same"]);
  history.sync([user("same", 1), user("new", 2), user([textBlock("same"), image], 1)]);
  assert.deepEqual(recalled(history, 4), ["same", "new", "same", "same"]);
});

test("navigation handles empty history, bounds, invalid directions, and exact unsent draft recovery", () => {
  const history = createPromptHistory();
  assert.equal(history.navigate("older", "draft"), null);
  assert.equal(history.navigate("newer", "draft"), null);
  history.sync([user("first"), user("last")]);
  assert.equal(history.navigate("newer", "draft"), null);
  assert.equal(history.navigate("sideways", "draft"), null);
  assert.equal(history.navigate("older", "  unsent\ndraft  "), "last");
  assert.equal(history.navigate("older", "last"), "first");
  assert.equal(history.navigate("older", "first"), "first");
  assert.equal(history.navigate("newer", "first"), "last");
  assert.equal(history.navigate("newer", "last"), "  unsent\ndraft  ");
  assert.equal(history.navigate("newer", "  unsent\ndraft  "), null);
  assert.equal(history.navigate("older", ""), "last");
  assert.equal(history.navigate("newer", "last"), "");
});

test("reset abandons browsing so edits become the next draft; remember resets after successful submission", () => {
  const history = createPromptHistory();
  history.sync([user("old")]);
  assert.equal(history.navigate("older", "original"), "old");
  history.resetNavigation();
  assert.equal(history.navigate("newer", "edited"), null);
  assert.equal(history.navigate("older", "edited"), "old");
  assert.equal(history.navigate("newer", "old"), "edited");
  history.navigate("older", "should not return");
  history.remember("accepted");
  assert.equal(history.navigate("newer", ""), null);
  assert.equal(history.navigate("older", "new draft"), "accepted");
  assert.equal(history.navigate("newer", "accepted"), "new draft");
});

test("polling and reconciliation do not change the active navigation snapshot", () => {
  const history = createPromptHistory({ limit: 2 });
  history.sync([user("first", 1), user("second", 2)]);
  history.remember("clean", "expanded");
  assert.equal(history.navigate("older", "draft"), "clean");
  history.sync([user("first", 1), user("second", 2), user("expanded", 3), user("new", 4)]);
  assert.equal(history.navigate("older", "clean"), "second");
  assert.equal(history.navigate("older", "second"), "second");
  assert.equal(history.navigate("newer", "second"), "clean");
  assert.equal(history.navigate("newer", "clean"), "draft");
  assert.deepEqual(recalled(history, 3), ["new", "clean", "clean"]);
});

test("limits apply to confirmed and pending recall, including evicted pending echoes", () => {
  const history = createPromptHistory({ limit: 2 });
  history.sync([user("old", 0)]);
  history.remember("one", "expanded one");
  history.remember("two");
  history.remember("three");
  assert.deepEqual(recalled(history, 3), ["three", "two", "two"]);
  const messages = [user("old", 0), user("expanded one", 1), user("two", 2), user("three", 3)];
  history.sync(messages);
  history.sync(messages);
  assert.deepEqual(recalled(history, 3), ["three", "two", "two"]);
  const disabled = createPromptHistory({ limit: 0 });
  disabled.sync(messages);
  disabled.remember("invisible");
  assert.equal(disabled.navigate("older", "draft"), null);
  for (const limit of [-1, 1.5, Infinity, NaN]) assert.throws(() => createPromptHistory({ limit }), RangeError);
});

test("default cap is 100, blank accepted text is ignored, and controllers are isolated", () => {
  const first = createPromptHistory(), second = createPromptHistory();
  first.sync(Array.from({ length: 105 }, (_, i) => user(String(i), i)));
  first.remember(" \n");
  const values = recalled(first, 101);
  assert.equal(values[0], "104");
  assert.equal(values[99], "5");
  assert.equal(values[100], "5");
  assert.equal(second.navigate("older", "draft"), null);
  second.remember("other");
  assert.deepEqual(recalled(second, 2), ["other", "other"]);
  assert.equal(first.navigate("newer", "5"), "6");
});

const input = (value = "single line", caret = 0, overrides = {}) => ({ value, selectionStart: caret, selectionEnd: caret, ...overrides });
const event = (key, overrides = {}) => ({ key, ...overrides });

test("plain arrows can recall anywhere on a single logical line, including empty input", () => {
  for (const value of ["", "single line"]) {
    for (const caret of [0, Math.floor(value.length / 2), value.length]) {
      for (const key of ["ArrowUp", "ArrowDown"]) assert.equal(canNavigatePromptHistory(event(key), input(value, caret)), true);
    }
  }
});

test("multiline arrows preserve native cursor editing and handle caret zero/newline edges", () => {
  const value = "ab\ncd\nef";
  for (let caret = 0; caret <= value.length; caret++) {
    assert.equal(canNavigatePromptHistory(event("ArrowUp"), input(value, caret)), caret <= 2, `Up at ${caret}`);
    assert.equal(canNavigatePromptHistory(event("ArrowDown"), input(value, caret)), caret >= 6, `Down at ${caret}`);
  }
  assert.equal(canNavigatePromptHistory(event("ArrowUp"), input("\n", 0)), true);
  assert.equal(canNavigatePromptHistory(event("ArrowDown"), input("\n", 0)), false);
  assert.equal(canNavigatePromptHistory(event("ArrowUp"), input("\n", 1)), false);
  assert.equal(canNavigatePromptHistory(event("ArrowDown"), input("\n", 1)), true);
});

test("modifiers, IME, prevented events, nonarrows, selection, and unavailable inputs are ineligible", () => {
  for (const key of ["ArrowUp", "ArrowDown"]) {
    for (const flag of ["altKey", "ctrlKey", "metaKey", "shiftKey", "isComposing", "defaultPrevented"]) {
      assert.equal(canNavigatePromptHistory(event(key, { [flag]: true }), input()), false, flag);
    }
    assert.equal(canNavigatePromptHistory(event(key, { keyCode: 229 }), input()), false);
    for (const overrides of [{ disabled: true }, { readOnly: true }, { selectionEnd: 1 }, { selectionStart: null, selectionEnd: null }, { selectionStart: -1, selectionEnd: -1 }, { selectionStart: 99, selectionEnd: 99 }]) {
      assert.equal(canNavigatePromptHistory(event(key), input("text", 0, overrides)), false);
    }
  }
  for (const key of ["Up", "Down", "Enter", "ArrowLeft", "ArrowRight", ""]) assert.equal(canNavigatePromptHistory(event(key), input()), false);
  assert.equal(canNavigatePromptHistory(null, input()), false);
  assert.equal(canNavigatePromptHistory(event("ArrowUp"), null), false);
});
