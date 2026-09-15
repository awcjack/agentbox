import assert from "node:assert/strict";
import test from "node:test";
import { commandQuery, commandSuggestions } from "./commands.mjs";

const commands = [
  { name: "auto", description: "Toggle auto mode", source: "extension" },
  { name: "skill:commit", description: "Commit and push", source: "skill" },
  { name: "review", description: "Review changes", source: "prompt" },
];

test("slash suggestions come from the current Pi command catalog", () => {
  assert.deepEqual(commandSuggestions("/sk", commands).map((item) => item.name), ["skill:commit"]);
  assert.deepEqual(commandSuggestions("/rev", commands), [{ name: "review", description: "Review changes" }]);
  assert.equal(commandSuggestions("/model", commands).length, 0, "do not advertise TUI-only built-ins");
  assert.equal(commandSuggestions("/auto", [{ name: "review" }]).length, 0, "old agents do not gain a fictional auto command");
  assert.equal(commandSuggestions("/", undefined).length, 0);
});

test("registered auto commands offer explicit on/off/status arguments", () => {
  assert.deepEqual(commandSuggestions("/auto ", commands).map((item) => item.name), ["auto off", "auto on", "auto status"]);
  assert.deepEqual(commandSuggestions("/auto o", commands).map((item) => item.name), ["auto off", "auto on"]);
  assert.deepEqual(commandSuggestions("/auto sta", commands).map((item) => item.name), ["auto status"]);
  assert.deepEqual(commandSuggestions("/auto off ", commands), [], "completed commands leave the menu before sending");
});

test("suggestions do not intercept prose, arguments, multiline input, or selection", () => {
  for (const text of ["", "read /file", " /review", "/review changes", "/review\n", "/auto on\n", "/auto on "]) {
    assert.equal(commandQuery(text), null, text);
    assert.deepEqual(commandSuggestions(text, commands), []);
  }
  assert.equal(commandQuery("/review", 3), null);
  assert.equal(commandQuery("/review", 0, 7), null);
  assert.equal(commandQuery("/"), "");
  assert.equal(commandQuery("/SKILL:"), "skill:");
});

test("catalog entries are bounded, deduplicated, and malformed entries ignored", () => {
  const items = commandSuggestions("/", [null, {}, { name: "bad\ncommand" }, { name: "<script>" }, { name: "x".repeat(201) },
    { name: "review", description: "x".repeat(400) }, { name: "review", description: "duplicate" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].description.length, 300);
  assert.equal(commandSuggestions("/", Array.from({ length: 100 }, (_, index) => ({ name: `command-${index}` }))).length, 12);
});
