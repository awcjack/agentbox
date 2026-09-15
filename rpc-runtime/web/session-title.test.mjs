import assert from "node:assert/strict";
import test from "node:test";
import { messageTitle, sessionTitle } from "./session-title.mjs";

test("titles share the first textual user message fallback, never image data or assistant text", () => {
  const messages = [
    { role: "assistant", content: "Not the title" },
    { role: "user", content: [{ type: "image", data: "private-image" }] },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "text", text: "this project" }] },
    { role: "user", content: "Later message" },
  ];
  assert.equal(messageTitle(messages), "Inspect this project");
  assert.equal(sessionTitle({ name: null }, {}, messages), "Inspect this project");
  assert.equal(messageTitle([{ role: "user", content: "x".repeat(300) }]).length, 200);
  assert.equal(sessionTitle({}), "Untitled session");
});

test("resume keeps the saved label while snapshots load; explicit names take precedence", () => {
  const saved = { name: "Original request" };
  assert.equal(sessionTitle({ name: null }, {}, [], saved), "Original request");
  assert.equal(sessionTitle({ name: "Native name" }, {}, [], saved), "Native name");
  assert.equal(sessionTitle({ name: "Old name" }, { sessionName: "Renamed" }, [], saved), "Renamed");
  assert.equal(sessionTitle({ name: " " }, { sessionName: "" }, [], saved), "Original request");
});
