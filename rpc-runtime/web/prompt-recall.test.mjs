import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { canNavigatePromptHistory, createPromptHistory } from "./prompt-history.mjs";
import { archiveCommand, bangCommand, downloadCommand, commandQuery, commandSuggestions } from "./commands.mjs";
import { attachmentMessage, uploadAttachments } from "./attachments.mjs";

// Execute the app's actual functions and registered listeners, not copies of the
// recall/submit algorithm. Like projects-refresh.test.mjs, deliberately avoid
// booting the full page, transport polling, or a third-party DOM implementation.
const source = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `app extraction boundaries: ${start} … ${end}`);
  return source.slice(from, to);
}
function event(key, overrides = {}) {
  return {
    key, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {}, ...overrides,
  };
}
function node() {
  return {
    _value: "", hidden: false, disabled: false, readOnly: false,
    // Textarea value assignment moves the caret to the end when text changes.
    // In particular, clearing a sent draft must not leave an out-of-range caret.
    get value() { return this._value; },
    set value(text) {
      if (text !== this._value) this.selectionStart = this.selectionEnd = text.length;
      this._value = text;
    },
    selectionStart: 0, selectionEnd: 0, children: [], listeners: {}, attributes: {},
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    dispatch(type, e = event()) { return Promise.all((this.listeners[type] || []).map((fn) => fn(e))); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    scrollIntoView() {},
  };
}
const user = (content, timestamp) => ({ role: "user", content, timestamp });
function context(id = "one", messages = []) {
  return {
    id, controller: new AbortController(), ready: true, online: true,
    meta: { nativeSessionId: `native-${id}`, status: "running", profile: "test" },
    state: { sessionId: `native-${id}` }, commands: [{ name: "status", description: "Status" }],
    record: {
      messages, messagesNativeId: `native-${id}`, draft: { text: "unsent", images: [], version: 0 },
      forbidden: new Set(), sending: false, readingImages: false,
    },
  };
}
function harness(messages = [], request = async () => ({ data: {} })) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const h = {
    $, current: context("one", messages), epoch: 1, token: "test-only", readOnly: false,
    auth: new AbortController(), TextEncoder,
    canNavigatePromptHistory, createPromptHistory,
    archiveCommand, bangCommand, downloadCommand, commandQuery, commandSuggestions,
    attachmentMessage, uploadAttachments,
    commandItems: [], commandIndex: 0, commandKey: "", dismissedCommands: null,
    calls: [], errors: [], notices: [], refreshes: 0, submissions: 0,
    api: { request: async (path, options) => { h.calls.push({ path, ...options }); return request(path, options); } },
    document: { activeElement: $("prompt") },
    element: (_tag, _class, text) => Object.assign(node(), { textContent: text }),
    imageSource: () => "stub-image-preview",
    setComposerCompact() {}, scheduleRender() {},
    showNotice(message) { h.notices.push(message); },
    report(error, ctx, options) { h.errors.push({ error, ctx, options }); },
    requestRefresh() { h.refreshes++; },
    // The complete control renderer is unrelated to recall. Retain its relevant
    // effects: writable/locked input state and real slash-menu rendering.
    updateControls() {
      $("prompt").disabled = !h.canWrite(h.current);
      $("send").disabled = !h.canWrite(h.current) || h.current.record.sending || h.current.record.readingImages;
      h.renderCommandSuggestions();
    },
  };
  $("command-suggestions").hidden = true;
  $("send-mode").value = "followUp";
  $("prompt").focus = () => { h.document.activeElement = $("prompt"); };
  $("composer").requestSubmit = () => { h.submissions++; h.pendingSubmit = $("composer").dispatch("submit"); };
  vm.createContext(h);
  for (const [start, end] of [
    ["function active(ctx)", "function showNotice("],
    ["function canWrite(", "function canChangeConversation("],
    ["function hideCommandSuggestions(", "function drawer("],
    ["function promptHistory(", "function renderApprovals("],
  ]) vm.runInContext(section(start, end), h);
  vm.runInContext(section('$("composer").addEventListener("submit"', '$("stop").addEventListener'), h);
  h.restoreDraft();
  return {
    h, $,
    key: async (key, overrides) => { const e = event(key, overrides); await $("prompt").dispatch("keydown", e); return e; },
    type: async (text) => { $("prompt").value = text; $("prompt").setSelectionRange(text.length, text.length); await $("prompt").dispatch("input"); },
    submit: () => $("composer").dispatch("submit"),
    switchTo: (ctx) => { h.current = ctx; h.dismissedCommands = null; h.restoreDraft(); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pendingHarness(messages = []) {
  const response = deferred(), started = deferred();
  const result = harness(messages, () => { started.resolve(); return response.promise; });
  return { ...result, response, started: started.promise };
}

// These assertions go through the installed keydown listener (including slash
// completion priority), actual restoreDraft, and the imported history helper.
test("arrows recall newest/older user text, restore unsent text, never submit, and leave attachments intact", async () => {
  const { h, $, key, type } = harness([
    user("old", 1), { role: "assistant", content: "not a prompt" },
    user([{ type: "image", data: "ignored" }, { type: "text", text: "new" }], 2),
  ]);
  const attachments = [{ name: "photo.png", data: "image", mimeType: "image/png" }, { type: "file", name: "notes.txt", data: "file" }];
  h.current.record.draft.images = attachments;
  await type("  original unsent  ");
  for (const [arrow, expected] of [["ArrowUp", "new"], ["ArrowUp", "old"], ["ArrowDown", "new"], ["ArrowDown", "  original unsent  "]]) {
    assert.equal((await key(arrow)).defaultPrevented, true);
    assert.equal($("prompt").value, expected);
    assert.equal(h.current.record.draft.text, expected);
    assert.equal($("prompt").selectionStart, arrow === "ArrowUp" ? 0 : expected.length);
    assert.equal(h.current.record.draft.images, attachments);
    assert.equal($("attachments").children.length, 2);
  }
  assert.deepEqual(attachments.map((item) => item.data), ["image", "file"]);
  assert.equal(h.submissions, 0);
  assert.deepEqual(h.calls, []);
});

test("typing abandons browsing and makes the edited text the new unsent draft", async () => {
  const { h, $, key, type } = harness([user("old", 1), user("new", 2)]);
  await key("ArrowUp");
  await type("edited recall");
  assert.equal((await key("ArrowDown")).defaultPrevented, false);
  assert.equal($("prompt").value, "edited recall");
  await key("ArrowUp");
  assert.equal($("prompt").value, "new");
  await key("ArrowDown");
  assert.equal(h.current.record.draft.text, "edited recall");
});

test("record switching isolates navigation/drafts; a new native conversation resets recall", async () => {
  const { h, $, key, switchTo } = harness([user("one old", 1), user("one new", 2)]);
  const first = h.current, second = context("two", [user("two only", 3)]);
  second.record.draft.text = "second draft";
  await key("ArrowUp");
  switchTo(second);
  await key("ArrowUp");
  assert.equal($("prompt").value, "two only");
  await key("ArrowDown");
  assert.equal($("prompt").value, "second draft");
  switchTo(first);
  await key("ArrowUp");
  assert.equal($("prompt").value, "one old");
  await key("ArrowDown"); await key("ArrowDown");
  assert.equal($("prompt").value, "unsent");
  first.meta.nativeSessionId = first.state.sessionId = "replacement";
  first.record.messages = [user("replacement only", 4)];
  first.record.messagesNativeId = "replacement";
  await key("ArrowUp"); await key("ArrowUp");
  assert.equal($("prompt").value, "replacement only");
  const independentTab = harness([user("other tab", 5)]);
  await independentTab.key("ArrowUp");
  assert.equal(independentTab.$("prompt").value, "other tab");
  assert.equal($("prompt").value, "replacement only");
});

test("reactivating a replacement conversation cannot seed recall from cached old-native messages", async () => {
  const { h, $, key } = harness([user("old conversation secret", 1)]);
  const ctx = h.current;
  ctx.meta.nativeSessionId = ctx.state.sessionId = "replacement";
  ctx.ready = false; // Initial activation snapshot has not settled.
  assert.equal((await key("ArrowUp")).defaultPrevented, false);
  assert.equal($('prompt').value, "unsent");
  ctx.ready = true;
  // Even a transient ready state cannot associate old cached data with a new ID.
  assert.equal((await key("ArrowUp")).defaultPrevented, false);
  ctx.record.messages = [user("new conversation only", 2)];
  ctx.record.messagesNativeId = "replacement";
  await key("ArrowUp"); await key("ArrowUp");
  assert.equal($('prompt').value, "new conversation only");
});

test("empty or loading slash suggestions keep arrow priority over prompt recall", async () => {
  for (const loading of [false, true]) {
    const { h, $, key, type } = harness([user("do not recall", 1)]);
    h.current.commands = [];
    h.current.commandLoading = loading;
    await type("/no-such-command");
    assert.equal($('command-suggestions').hidden, false);
    assert.equal(h.commandItems.length, 0);
    for (const arrow of ["ArrowUp", "ArrowDown"]) {
      assert.equal((await key(arrow)).defaultPrevented, false);
      assert.equal($('prompt').value, "/no-such-command");
      assert.equal($('command-suggestions').hidden, false);
    }
    assert.deepEqual(h.calls, []);
  }
});

test("slash suggestions own arrows and Enter; recalled slash text stays editable with its menu dismissed", async () => {
  const { h, $, key, type } = harness([user("/status", 1)]);
  await type("/");
  assert.equal($("command-suggestions").hidden, false);
  const before = h.commandIndex;
  await key("ArrowDown");
  assert.notEqual(h.commandIndex, before);
  await key("ArrowUp");
  assert.equal($("prompt").value, "/");
  await type("/sta");
  await key("Enter");
  assert.equal($("prompt").value, "/status ");
  assert.equal(h.submissions, 0);
  await type("draft");
  await key("ArrowUp");
  assert.equal($("prompt").value, "/status");
  // Put the caret at the end and focus again: suppression, not just caret=0,
  // must prevent automatic menu reopening on recalled command text.
  $("prompt").setSelectionRange(7, 7);
  await $("prompt").dispatch("focus");
  assert.equal($("command-suggestions").hidden, true);
  assert.equal(h.dismissedCommands, `${h.current.id}:/status`);
  assert.deepEqual(h.calls, []);
  await type("/sta");
  assert.equal($("command-suggestions").hidden, false);
});

test("IME, modifiers, selections, multiline interiors and unavailable composer guards leave arrows native", async () => {
  const cases = [
    ...["isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey"].map((flag) => ({ event: { [flag]: true } })),
    { event: { keyCode: 229 } }, { event: { defaultPrevented: true } },
    { input: { selectionStart: 0, selectionEnd: 2 } },
    { input: { disabled: true } }, { input: { readOnly: true } },
    { text: "first\nmiddle\nlast", input: { selectionStart: 8, selectionEnd: 8 } },
    { guard: "sending" }, { guard: "readingImages" }, { guard: "hidden" }, { guard: "no session" },
  ];
  for (const scenario of cases) {
    for (const arrow of ["ArrowUp", "ArrowDown"]) {
      const { h, $, key, type } = harness([user("older", 1), user("newer", 2)]);
      await key("ArrowUp"); // Make Down eligible too, absent the guard.
      if (scenario.text) await type(scenario.text);
      Object.assign($("prompt"), scenario.input);
      if (scenario.guard === "hidden") $("composer").hidden = true;
      else if (scenario.guard === "no session") h.current = null;
      else if (scenario.guard) h.current.record[scenario.guard] = true;
      const value = $("prompt").value, draft = h.current?.record.draft.text;
      const e = await key(arrow, scenario.event);
      assert.equal(e.defaultPrevented, Boolean(scenario.event?.defaultPrevented), JSON.stringify({ scenario, arrow }));
      assert.equal($("prompt").value, value);
      assert.equal(h.current?.record.draft.text, draft);
      assert.equal(h.submissions, 0);
      assert.deepEqual(h.calls, []);
    }
  }
});

test("Enter explicitly resubmits recalled text through the real composer handler", async () => {
  const { h, $, key } = harness([user("repeat this", 1)]);
  await key("ArrowUp");
  assert.equal(h.calls.length, 0);
  await key("Enter", { shiftKey: true });
  await key("Enter", { isComposing: true });
  await key("Enter", { keyCode: 229 });
  assert.equal(h.submissions, 0);
  assert.equal((await key("Enter")).defaultPrevented, true);
  await h.pendingSubmit;
  assert.equal(h.submissions, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/v1/sessions/one/rpc");
  assert.equal(h.calls[0].body.type, "prompt");
  assert.equal(h.calls[0].body.message, "repeat this");
  assert.equal(h.calls[0].body.streamingBehavior, "followUp");
  assert.equal(h.calls[0].nativeSessionId, "native-one");
  assert.equal($("prompt").value, "");
});

test("accepted sends are immediately recallable; later transcript echoes deduplicate", async () => {
  const { h, $, key, type, submit } = harness([user("old", 1)]);
  await type("accepted now");
  await submit();
  assert.equal(h.current.record.messages.length, 1, "no transcript polling has occurred");
  assert.equal($("prompt").value, "");
  await key("ArrowUp");
  assert.equal($("prompt").value, "accepted now");
  await key("ArrowDown");
  h.current.record.messages.push(user("accepted now", 2));
  await key("ArrowUp");
  assert.equal($("prompt").value, "accepted now");
  await key("ArrowUp");
  assert.equal($("prompt").value, "old", "echo must not append a second recall entry");
});

test("an older identical transcript message does not consume a newly accepted prompt", async () => {
  const { h, $, key, type, submit } = harness([user("anchor", 0), user("same", 1)]);
  await type("same"); await submit();
  // Sync the old transcript before a new echo exists.
  h.promptHistory(h.current);
  h.current.record.messages.push(user("same", 2));
  h.promptHistory(h.current);
  const recalled = [];
  for (let i = 0; i < 4; i++) { await key("ArrowUp"); recalled.push($("prompt").value); }
  assert.deepEqual(recalled, ["same", "same", "anchor", "anchor"]);
});

test("file-note expansion is sent but local recall remains clean before and after echo", async () => {
  const { h, $, key, type, submit } = harness([user("old", 1)], async (path) => path.endsWith("/uploads")
    ? { nativeSessionId: "native-one", path: "/workspace/upload/notes.txt" } : { data: {} });
  h.current.record.draft.images = [{ type: "file", name: "notes.txt", data: "fixture" }];
  await type("inspect this"); await submit();
  assert.equal(h.calls.length, 2);
  const expanded = h.calls[1].body.message;
  assert.match(expanded, /^inspect this\n\nAttached file/);
  assert.match(expanded, /\/workspace\/upload\/notes.txt/);
  await key("ArrowUp");
  assert.equal($("prompt").value, "inspect this");
  await key("ArrowDown");
  h.current.record.messages.push(user(expanded, 2));
  await key("ArrowUp");
  assert.equal($("prompt").value, "inspect this");
  await key("ArrowUp");
  assert.equal($("prompt").value, "old");
});

test("failed and ambiguous requests preserve the draft and never recall unconfirmed prompts", async () => {
  for (const status of [403, 500, undefined]) {
    const failure = Object.assign(new Error("request failed"), status ? { status } : {});
    const { h, $, key, type, submit } = harness([user("confirmed", 1)], async () => { throw failure; });
    const attachments = [{ name: "image.png", mimeType: "image/png", data: "fixture" }];
    h.current.record.draft.images = attachments;
    await type("unconfirmed"); await submit();
    assert.equal($("prompt").value, "unconfirmed");
    assert.equal(h.current.record.draft.images, attachments);
    assert.equal(h.current.record.sending, false);
    assert.equal(h.errors[0].error, failure);
    assert.equal(h.errors[0].options.ambiguous, true);
    assert.equal(h.calls.length, 1, "must not retry a potentially accepted write");
    await key("ArrowUp"); await key("ArrowUp");
    assert.equal($("prompt").value, "confirmed");
    await key("ArrowDown");
    assert.equal($("prompt").value, "unconfirmed");
  }
});

test("stale epoch or native-conversation responses cannot seed recall in a new conversation", async () => {
  for (const changed of ["epoch", "native"]) {
    const { h, $, key, type, submit, started, response } = pendingHarness([user("old", 1)]);
    await type("late accepted");
    const pending = submit(); await started;
    if (changed === "epoch") {
      h.epoch++;
      h.current = context("new", [user("new only", 2)]);
    } else {
      h.current.meta.nativeSessionId = h.current.state.sessionId = "new-native";
      h.current.record.messages = [user("new only", 2)];
      h.current.record.messagesNativeId = "new-native";
    }
    response.resolve({ data: {} }); await pending;
    h.restoreDraft();
    await key("ArrowUp"); await key("ArrowUp");
    assert.equal($("prompt").value, "new only", changed);
    assert.equal(h.errors.length, 0);
  }
});

test("editing while send is pending preserves the newer draft with existing version guards", async () => {
  const { h, $, key, type, submit, started, response } = pendingHarness([user("old", 1)]);
  await type("accepted original");
  const pending = submit(); await started;
  assert.equal(h.current.record.sending, true);
  await type("new unsent draft");
  response.resolve({ data: {} }); await pending;
  assert.equal($("prompt").value, "new unsent draft");
  assert.equal(h.current.record.draft.text, "new unsent draft");
  await key("ArrowUp");
  assert.equal($("prompt").value, "accepted original");
  await key("ArrowDown");
  assert.equal($("prompt").value, "new unsent draft");
});
