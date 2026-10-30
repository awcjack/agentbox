import test from "node:test";
import assert from "node:assert/strict";
import { readAttachments, attachmentMessage, uploadAttachments, MAX_ATTACHMENT_BYTES, hasFileDrag, initComposerFileDrop } from "../web/attachments.mjs";
const file = (name, type, bytes) => ({ name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test("arbitrary bytes are files, images remain native, and combined drafts are bounded", async () => {
  const files = await readAttachments([file("a.pdf", "application/pdf", [0, 255]), file("image.png", "image/png", [1, 2])]);
  assert.equal(files[0].type, "file"); assert.equal(files[0].data, "AP8=");
  assert.equal(files[1].mimeType, "image/png");
  assert.throws(() => attachmentMessage("", files), /not been uploaded/);
  await assert.rejects(readAttachments([file("x", "", [1])], [{ size: MAX_ATTACHMENT_BYTES }]), /5 MiB/);
  const calls = [];
  await uploadAttachments(files, "native", async (data) => { calls.push(data); return { path: "/tmp/generated/file", nativeSessionId: "native" }; }, () => true);
  assert.deepEqual(calls, ["AP8="]);
  assert.match(attachmentMessage("inspect", files), /saved at "\/tmp\/generated\/file"/);
  await uploadAttachments(files, "native", () => assert.fail("retry must reuse file"), () => true);
  await uploadAttachments([], "native", () => assert.fail("removed file must not upload"), () => true);
});

test("upload failures preserve drafts and switches never proceed to send", async () => {
  const draft = await readAttachments([file("audio", "audio/wav", [0])]);
  await assert.rejects(uploadAttachments(draft, "one", async () => { throw Error("failed"); }, () => true), /failed/);
  assert.equal(draft[0].data, "AA=="); assert.equal(draft[0].path, undefined);
  let current = true;
  await assert.rejects(uploadAttachments(draft, "one", async () => { current = false; return { nativeSessionId: "one", path: "/tmp/one" }; }, () => current), /changed/);
  await uploadAttachments(draft, "two", async () => ({ nativeSessionId: "two", path: "/tmp/two" }), () => true);
  assert.equal(draft[0].path, "/tmp/two");
});

function zone(id) {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    id,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name); else classes.delete(name);
      },
      has: (name) => classes.has(name),
    },
    contains(other) { return other === node || other?.parent === node; },
    addEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).concat(handler));
    },
    fire(type, event) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
  return node;
}

test("file drag detection ignores session markers and accepts Files", () => {
  assert.equal(hasFileDrag({ dataTransfer: { types: ["text/plain", "application/x-agentbox-session"] } }), false);
  assert.equal(hasFileDrag({ dataTransfer: { types: ["Files"] } }), true);
  assert.equal(hasFileDrag({}), false);
});

test("composer drop zones highlight and attach only while writable", () => {
  const conversation = zone("conversation");
  const compose = zone("compose");
  const child = { parent: compose };
  const drops = [];
  let accept = true;
  const controller = initComposerFileDrop([conversation, compose], {
    canAccept: () => accept,
    onDrop: (files) => drops.push(files.map((file) => file.name)),
  });
  const transfer = { types: ["Files"], dropEffect: "none", files: [{ name: "shot.png" }] };
  const event = (target, relatedTarget) => {
    let prevented = false;
    return {
      target, relatedTarget, dataTransfer: transfer,
      preventDefault() { prevented = true; },
      get defaultPrevented() { return prevented; },
    };
  };
  const enter = event(child);
  compose.fire("dragenter", enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(compose.classList.has("file-drop"), true);
  assert.equal(conversation.classList.has("file-drop"), true);
  assert.equal(controller.isActive(), true);
  const leave = event(compose, conversation);
  compose.fire("dragleave", leave);
  assert.equal(controller.isActive(), true, "moving between drop zones keeps highlight");
  const leaveAll = event(conversation, null);
  conversation.fire("dragleave", leaveAll);
  assert.equal(controller.isActive(), false);
  compose.fire("dragenter", event(compose));
  const over = event(compose);
  compose.fire("dragover", over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(transfer.dropEffect, "copy");
  const drop = event(compose);
  compose.fire("drop", drop);
  assert.equal(drop.defaultPrevented, true);
  assert.deepEqual(drops, [["shot.png"]]);
  assert.equal(controller.isActive(), false);
  accept = false;
  const blocked = event(compose);
  compose.fire("dragenter", blocked);
  assert.equal(blocked.defaultPrevented, false);
  assert.equal(controller.isActive(), false);
});
