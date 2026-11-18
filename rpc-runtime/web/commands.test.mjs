import assert from "node:assert/strict";
import test from "node:test";
import { archiveCommand, bangCommand, downloadCommand, commandQuery, commandSuggestions } from "./commands.mjs";

test("bangCommand parses OpenCode-style ! and !! prefixes", () => {
  assert.deepEqual(bangCommand("!ls -la"), { command: "ls -la", excludeFromContext: false });
  assert.deepEqual(bangCommand("!  pwd"), { command: "pwd", excludeFromContext: false });
  assert.deepEqual(bangCommand("!!git status"), { command: "git status", excludeFromContext: true });
  assert.deepEqual(bangCommand("!!!echo"), { command: "!echo", excludeFromContext: true });
  assert.deepEqual(bangCommand("!"), { command: "", excludeFromContext: false });
  assert.equal(bangCommand("ls"), null);
  assert.equal(bangCommand("/bash ls"), null);
  assert.equal(bangCommand(" !ls"), null, "leading space is not a bang after trim happens upstream");
});

const commands = [
  { name: "auto", description: "Toggle auto mode", source: "extension" },
  { name: "skill:commit", description: "Commit and push", source: "skill" },
  { name: "review", description: "Review changes", source: "prompt" },
];

test("archiveCommand matches exact /archive only", () => {
  assert.equal(archiveCommand("/archive"), true);
  assert.equal(archiveCommand("/archive "), true);
  assert.equal(archiveCommand("/archive\t"), true);
  assert.equal(archiveCommand("/archive now"), false);
  assert.equal(archiveCommand("/archive-conversation"), false);
  assert.equal(archiveCommand("/skill:archive-conversation"), false);
  assert.equal(archiveCommand("archive"), false);
  assert.equal(archiveCommand(" /archive"), false);
  assert.equal(archiveCommand(null), false);
});

test("downloadCommand handles one absolute literal path without shell expansion", () => {
  assert.deepEqual(downloadCommand("/download /workspace/brian/use-brian/apps/app-web/AGENTS.md"),
    { path: "/workspace/brian/use-brian/apps/app-web/AGENTS.md" });
  for (const text of [
    '/download /workspace/reports/final draft.pdf',
    '/download "/workspace/reports/final draft.pdf"',
    "/download '/workspace/reports/final draft.pdf'",
  ]) assert.deepEqual(downloadCommand(text), { path: "/workspace/reports/final draft.pdf" });
  assert.deepEqual(downloadCommand('/download /workspace/$(touch example).txt'), { path: '/workspace/$(touch example).txt' });
  assert.deepEqual(downloadCommand('/download /workspace/100%20.txt'), { path: '/workspace/100%20.txt' }, "command paths are literal, not URL decoded");
});

test("invalid local download commands return usage instead of becoming model prompts", () => {
  for (const text of ["/download", "/download ", "/download report.md", "/download ~/report.md", "/download https://example.com/file", "/download //host/file", "/download /", "/download /workspace/dir/", '/download "/workspace/unclosed', "/download\n/workspace/file", "/download /workspace/bad\0file", `/download /${"x".repeat(4096)}`]) {
    assert.match(downloadCommand(text)?.error || "", /Usage: \/download/, text);
  }
  for (const text of [null, "download", "please /download /workspace/file", "/downloaded /workspace/file", "/skill:download /workspace/file", " /download /workspace/file"]) {
    assert.equal(downloadCommand(text), null, text);
  }
});

test("slash suggestions come from the current Pi command catalog plus local actions", () => {
  assert.deepEqual(commandSuggestions("/sk", commands).map((item) => item.name), ["skill:commit"]);
  assert.deepEqual(commandSuggestions("/rev", commands), [{ name: "review", description: "Review changes" }]);
  assert.equal(commandSuggestions("/model", commands).length, 0, "do not advertise TUI-only built-ins");
  assert.equal(commandSuggestions("/auto", [{ name: "review" }]).length, 0, "old agents do not gain a fictional auto command");
  assert.deepEqual(commandSuggestions("/", undefined).map((item) => item.name), ["archive", "download"]);
  assert.deepEqual(commandSuggestions("/ar", []).map((item) => item.name), ["archive"]);
  assert.ok(commandSuggestions("/", commands).some((item) => item.name === "archive"));
  assert.deepEqual(commandSuggestions("/down", []).map((item) => item.name), ["download"]);
  assert.equal(commandQuery("/download /workspace/file"), null, "never complete path arguments");
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
    { name: "review", description: "x".repeat(400) }, { name: "review", description: "duplicate" },
    { name: "archive", description: "catalog must not replace local archive" },
    { name: "download", description: "catalog must not replace local download" }]);
  assert.equal(items.length, 3);
  assert.match(items.find((item) => item.name === "download")?.description || "", /no model prompt or shell command/);
  assert.equal(items.find((item) => item.name === "archive")?.description,
    "End and archive this session (stops Pi; keeps history under Archived).");
  assert.equal(items.find((item) => item.name === "review")?.description.length, 300);
  assert.equal(commandSuggestions("/", Array.from({ length: 100 }, (_, index) => ({ name: `command-${index}` }))).length, 12);
});
