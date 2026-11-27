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
test("Pi 1.5.2 retains selections across fork, revert and idle reopen", { skip: !executable, timeout: 60_000 }, async (t) => {
  assert.equal(execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(), "1.5.2");
  const root = await mkdtemp(join(tmpdir(), "pi-conversation-contract-"));
  const sessionDir = join(root, "sessions"), agentDir = join(root, "agent");
  await mkdir(sessionDir);
  await mkdir(agentDir);
  const policy = join(root, "policy.json");
  await writeFile(policy, JSON.stringify({ version: 1, defaultDecision: "ask", rules: [], auto: { enable: true } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini", defaultThinkingLevel: "off" }));
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
  records.push(
    entry("00000005", "00000004", "message", { message: { ...records[2].message, content: [{ type: "text", text: "selected reply" }] } }),
    entry("00000006", "00000005", "message", { message: user("later") }),
  );
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
  let now = Date.now();
  const runtime = createRuntime({ piRpcApi: {
    executable, host: "127.0.0.1", port: 0,
    auth: { tokens: [{ sha256: createHash("sha256").update(token).digest("hex"), scopes: ["*"] }] },
    profiles: { test: { cwd: root, sessionDir,
      args: ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
        "-e", new URL("../../extensions/pi-openai-fast.ts", import.meta.url).pathname,
        "--extension", new URL("../../extensions/pi-policy.ts", import.meta.url).pathname],
      env: { PI_CODING_AGENT_DIR: agentDir, PI_POLICY_CONFIG: policy, PI_TELEMETRY: "0", OPENAI_API_KEY: "unused-offline-contract-test" } } },
    limits: { commandTimeoutMs: 10_000, shutdownGraceMs: 1000, killGraceMs: 1000, idleTimeoutMs: 100, cleanupIntervalMs: 50 },
  } }, { spawn: spawnPi, now: () => now });
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
  const commands = (await request(rpc, { type: "get_commands" })).data.commands;
  assert.ok(commands.some(command => command.name === "auto"), JSON.stringify(commands));
  for (const command of [
    { type: "set_model", provider: "openai", modelId: "gpt-5" },
    { type: "cycle_thinking_level" },
    { type: "set_auto_compaction", enabled: false },
    { type: "set_steering_mode", mode: "all" },
    { type: "set_follow_up_mode", mode: "all" },
    { type: "prompt", message: "/auto on" },
    { type: "prompt", message: "/fast on" },
  ]) assert.equal((await request(rpc, command)).success, true);
  const settings = (state) => ({ model: { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel,
    autoCompactionEnabled: state.autoCompactionEnabled, steeringMode: state.steeringMode, followUpMode: state.followUpMode });
  const expected = settings((await request(rpc, { type: "get_state" })).data);
  assert.equal(expected.model.id, "gpt-5");
  assert.notEqual(expected.thinkingLevel, "off");
  const source = runtime.sessions.get(session.id), stop = source.stop;
  assert.deepEqual(source.autoMode, { available: true, enabled: true }, source.stderr.text());
  assert.deepEqual(source.fastMode, { available: true, enabled: true }, source.stderr.text());
  source.stop = function () {
    // The real child's readback must match before the source receives abort/EOF.
    assert.deepEqual(settings(observed.at(-1).state), expected);
    return stop.call(this);
  };
  const snapshot = await request(route);
  const before = await readFile(sourcePath, "utf8");
  const fork = await request(route, { action: "fork", entryId: "00000005", expectedNativeSessionId: snapshot.nativeSessionId, expectedLeafId: snapshot.leafId });
  assert.notEqual(fork.session.id, session.id);
  assert.deepEqual(fork.draft, { text: "", images: [] });
  assert.deepEqual(settings((await request(`/v1/sessions/${fork.session.id}/rpc`, { type: "get_state" })).data), expected);
  const context = await request(`/v1/sessions/${fork.session.id}/rpc`, { type: "get_messages" });
  assert.equal(context.data.messages.some((message) => message.role === "compactionSummary"), true);
  assert.equal(context.data.messages.some((message) => message.content?.some?.((block) => block.text === "selected reply")), true);
  assert.equal(context.data.messages.some((message) => message.content?.some?.((block) => block.text === "later")), false);
  const forkSnapshot = await request(`/v1/sessions/${fork.session.id}/conversation`);
  assert.equal(forkSnapshot.messages.at(-1).entryId, "00000005"); // Settings metadata may follow the last message.
  assert.deepEqual(forkSnapshot.messages.at(-1).message, snapshot.messages.find((entry) => entry.entryId === "00000005").message);
  assert.deepEqual(fork.session.autoMode, { available: true, enabled: true });
  assert.deepEqual(fork.session.fastMode, { available: true, enabled: true });
  assert.equal(await readFile(sourcePath, "utf8"), before);
  assert.equal((await request(rpc, { type: "prompt", message: "/auto review" })).success, true);
  const updated = await request(route);
  const beforeRevert = await readFile(sourcePath, "utf8");
  const reverted = await request(route, { action: "revert", entryId: "00000001", expectedNativeSessionId: updated.nativeSessionId, expectedLeafId: updated.leafId });
  assert.equal(reverted.session.id, session.id);
  assert.notEqual(reverted.session.nativeSessionId, nativeId);
  assert.deepEqual(reverted.draft, { text: "first", images: [] });
  assert.deepEqual(settings((await request(rpc, { type: "get_state" })).data), expected);
  const empty = await request(`/v1/sessions/${session.id}/rpc`, { type: "get_messages" });
  assert.deepEqual(empty.data.messages, []);
  assert.equal(await readFile(sourcePath, "utf8"), beforeRevert);
  assert.deepEqual(reverted.session.autoMode, { available: true, enabled: false, review: true });
  assert.deepEqual(reverted.session.fastMode, { available: true, enabled: true });
  // The new file is already persisted, even before its first assistant turn.
  const renamed = await request(`/v1/sessions/${session.id}/rpc`, { type: "set_session_name", name: "reverted" });
  assert.equal(renamed.success, true);
  const history = await request("/v1/history?profile=test");
  assert.equal(history.sessions.find((item) => item.id === reverted.session.nativeSessionId).name, "reverted");

  const expire = async () => {
    now += 1000;
    const deadline = Date.now() + 5000;
    while (runtime.sessions.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runtime.sessions.size, 0, "idle cleanup stops the processes before reopening");
  };
  const reopen = async (previous) => {
    const { session: reopened } = await request("/v1/sessions", { profile: "test", resume: previous.nativeSessionId });
    const { data } = await request(`/v1/sessions/${reopened.id}/rpc`, { type: "get_state" });
    assert.deepEqual(settings(data).model, expected.model);
    assert.equal(data.thinkingLevel, expected.thinkingLevel);
    const { session: meta } = await request(`/v1/sessions/${reopened.id}`);
    assert.deepEqual(meta.autoMode, previous.autoMode);
    assert.deepEqual(meta.fastMode, previous.fastMode);
    return meta;
  };
  await expire();
  await reopen(reverted.session);
  const originalAfterReopen = await reopen({ nativeSessionId: nativeId, autoMode: reverted.session.autoMode, fastMode: reverted.session.fastMode });
  const originalRpc = `/v1/sessions/${originalAfterReopen.id}/rpc`;
  for (const modelId of ["gpt-4o-mini", expected.model.id]) {
    assert.equal((await request(originalRpc, { type: "set_model", provider: "openai", modelId })).success, true);
  }
  assert.equal((await request(originalRpc, { type: "set_thinking_level", level: expected.thinkingLevel })).success, true);
  const reopenedFork = await reopen(fork.session);
  const forkRpc = `/v1/sessions/${reopenedFork.id}/rpc`;
  assert.equal((await request(forkRpc, { type: "prompt", message: "/auto off" })).data.disposition, "handled");
  assert.equal((await request(forkRpc, { type: "prompt", message: "/fast off" })).data.disposition, "handled");
  await expire();
  const off = { available: true, enabled: false };
  await reopen({ ...fork.session, autoMode: off, fastMode: off });
  await reopen({ ...originalAfterReopen, fastMode: off }); // Returning to the old model does not reactivate Fast.
  await reopen(reverted.session); // Turning the modes off in a fork leaves other sessions unchanged.
});
