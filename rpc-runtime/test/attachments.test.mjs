import test from "node:test";
import assert from "node:assert/strict";
import { readAttachments, attachmentMessage, uploadAttachments, MAX_ATTACHMENT_BYTES } from "../web/attachments.mjs";
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
