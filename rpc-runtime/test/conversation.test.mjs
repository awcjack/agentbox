import assert from "node:assert/strict";
import test from "node:test";
import { conversationBranch, conversationDraft } from "../history.mjs";

test("conversation follows parent links, not file order or message text", () => {
  const entries = [
    { id: "root", parentId: null, type: "model_change" },
    { id: "u1", parentId: "root", type: "message", message: { role: "user", content: "same" } },
    { id: "old", parentId: "u1", type: "message", message: { role: "user", content: "same" } },
    { id: "u2", parentId: "u1", type: "message", message: { role: "user", content: "same" } },
    { id: "label", parentId: "u2", type: "label" },
  ];
  assert.deepEqual(conversationBranch({ entries, leafId: "label" }).map((e) => e.id), ["root", "u1", "u2", "label"]);
  assert.deepEqual(conversationBranch({ entries, leafId: null }), []);
});

test("conversation rejects malformed, duplicate, missing and cyclic entry chains", () => {
  for (const data of [null, {}, { entries: [], leafId: "absent" },
    { entries: [{ id: "a", parentId: "a", type: "custom" }], leafId: "a" },
    { entries: [{ id: "a", parentId: null, type: "custom" }, { id: "a", parentId: null, type: "custom" }], leafId: "a" },
    { entries: [{ id: "a", type: "custom" }], leafId: "a" },
    { entries: [{ id: "a", parentId: null, type: "session" }], leafId: "a" }]) {
    assert.throws(() => conversationBranch(data));
  }
});

test("draft preserves text and native image payloads and rejects unsupported content", () => {
  const image = { type: "image", data: "YWJj", mimeType: "image/png" };
  assert.deepEqual(conversationDraft({ content: "hello" }), { text: "hello", images: [] });
  assert.deepEqual(conversationDraft({ content: [{ type: "text", text: "one" }, image, { type: "text", text: "two" }] }), { text: "one\ntwo", images: [image] });
  assert.deepEqual(conversationDraft({ content: [image] }), { text: "", images: [image] });
  for (const content of [null, [{ type: "file", path: "/secret" }], [{ type: "image", url: "https://example.com" }]]) {
    assert.throws(() => conversationDraft({ content }));
  }
});
