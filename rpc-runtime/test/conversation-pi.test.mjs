import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../runtime.mjs";

// Opt-in, offline contract test against the deployed immutable Pi executable.
const executable = process.env.PI_CONVERSATION_TEST_EXECUTABLE;
test("Pi 0.84.2 loads supervisor fork/revert prefixes, compaction and empty context", { skip: !executable, timeout: 60_000 }, async (t) => {
  assert.equal(execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(), "0.84.2");
  const root = await mkdtemp(join(tmpdir(), "pi-conversation-contract-"));
  const sessionDir = join(root, "sessions"), agentDir = join(root, "agent");
  await mkdir(sessionDir);
  await mkdir(agentDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeId = randomUUID(), token = randomUUID(), timestamp = new Date().toISOString();
  const entry = (id, parentId, type, fields) => ({ id, parentId, type, timestamp, ...fields });
  const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const records = [
    { type: "session", version: 3, id: nativeId, cwd: root, timestamp },
    entry("00000001", null, "message", { message: user("first") }),
    entry("00000002", "00000001", "message", { message: { role: "assistant", content: [{ type: "text", text: "answer" }], api: "openai-completions", provider: "openai", model: "gpt-4o-mini", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    entry("00000003", "00000002", "compaction", { summary: "Earlier work", firstKeptEntryId: "00000001", tokensBefore: 20 }),
    entry("00000004", "00000003", "message", { message: user("selected") }),
  ];
  const sourcePath = join(sessionDir, `source_${nativeId}.jsonl`);
  await writeFile(sourcePath, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const observed = [];
  const spawnPi = (...args) => {
    const child = spawn(...args), observation = { state: null };
    observed.push(observation);
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record.command === "get_state" && record.success) observation.state = record.data;
      }
    });
    return child;
  };
  const runtime = createRuntime({ piRpcApi: {
    executable, host: "127.0.0.1", port: 0,
    auth: { tokens: [{ sha256: createHash("sha256").update(token).digest("hex"), scopes: ["*"] }] },
    profiles: { test: { cwd: root, sessionDir,
      args: ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools"],
      env: { PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", OPENAI_API_KEY: "unused-offline-contract-test" } } },
    limits: { commandTimeoutMs: 10_000, shutdownGraceMs: 1000, killGraceMs: 1000 },
  } }, { spawn: spawnPi });
  t.after(() => runtime.close());
  const address = await runtime.listen();
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const { session } = await request("/v1/sessions", { profile: "test", resume: nativeId });
  const route = `/v1/sessions/${session.id}/conversation`;
  const rpc = `/v1/sessions/${session.id}/rpc`;
  for (const command of [
    { type: "set_model", provider: "openai", modelId: "gpt-5" },
    { type: "cycle_thinking_level" },
    { type: "set_auto_compaction", enabled: false },
    { type: "set_steering_mode", mode: "all" },
    { type: "set_follow_up_mode", mode: "all" },
  ]) assert.equal((await request(rpc, command)).success, true);
  const settings = (state) => ({ model: { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel,
    autoCompactionEnabled: state.autoCompactionEnabled, steeringMode: state.steeringMode, followUpMode: state.followUpMode });
  const expected = settings((await request(rpc, { type: "get_state" })).data);
  assert.equal(expected.model.id, "gpt-5");
  assert.notEqual(expected.thinkingLevel, "off");
  const source = runtime.sessions.get(session.id), stop = source.stop;
  source.stop = function () {
    // The real child's readback must match before the source receives abort/EOF.
    assert.deepEqual(settings(observed.at(-1).state), expected);
    return stop.call(this);
  };
  const snapshot = await request(route);
  const before = await readFile(sourcePath, "utf8");
  const fork = await request(route, { action: "fork", entryId: "00000004", expectedNativeSessionId: snapshot.nativeSessionId, expectedLeafId: snapshot.leafId });
  assert.notEqual(fork.session.id, session.id);
  assert.deepEqual(fork.draft, { text: "selected", images: [] });
  assert.deepEqual(settings((await request(`/v1/sessions/${fork.session.id}/rpc`, { type: "get_state" })).data), expected);
  const context = await request(`/v1/sessions/${fork.session.id}/rpc`, { type: "get_messages" });
  assert.equal(context.data.messages.some((message) => message.role === "compactionSummary"), true);
  assert.equal(context.data.messages.some((message) => message.content?.some?.((block) => block.text === "selected")), false);
  assert.equal(await readFile(sourcePath, "utf8"), before);
  const reverted = await request(route, { action: "revert", entryId: "00000001", expectedNativeSessionId: snapshot.nativeSessionId, expectedLeafId: snapshot.leafId });
  assert.equal(reverted.session.id, session.id);
  assert.notEqual(reverted.session.nativeSessionId, nativeId);
  assert.deepEqual(reverted.draft, { text: "first", images: [] });
  assert.deepEqual(settings((await request(rpc, { type: "get_state" })).data), expected);
  const empty = await request(`/v1/sessions/${session.id}/rpc`, { type: "get_messages" });
  assert.deepEqual(empty.data.messages, []);
  assert.equal(await readFile(sourcePath, "utf8"), before);
  // The new file is already persisted, even before its first assistant turn.
  const renamed = await request(`/v1/sessions/${session.id}/rpc`, { type: "set_session_name", name: "reverted" });
  assert.equal(renamed.success, true);
  const history = await request("/v1/history?profile=test");
  assert.equal(history.sessions.find((item) => item.id === reverted.session.nativeSessionId).name, "reverted");
});
