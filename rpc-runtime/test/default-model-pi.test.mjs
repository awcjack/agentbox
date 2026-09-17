import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../runtime.mjs";

// Real RPC processes, isolated settings and fake auth; never prompts an LLM.
const executable = process.env.PI_DEFAULT_MODEL_TEST_EXECUTABLE;
test("saved default survives live selections and restores in new web sessions", { skip: !executable, timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-default-model-"));
  const agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await mkdir(agentDir);
  await mkdir(sessionDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini", theme: "light" }));
  // Auto availability must not gate model defaults.
  const policy = join(root, "policy.json");
  await writeFile(policy, JSON.stringify({ version: 1, defaultDecision: "ask", rules: [], auto: { enable: false } }));
  const token = randomUUID();
  const profile = {
    cwd: root, sessionDir,
    args: ["--offline", "--no-extensions", "-e", new URL("../../extensions/pi-policy.ts", import.meta.url).pathname,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools"],
    env: { PI_CODING_AGENT_DIR: agentDir, PI_POLICY_CONFIG: policy, PI_TELEMETRY: "0", OPENAI_API_KEY: "unused-offline-test", ANTHROPIC_API_KEY: "unused-offline-test" },
  };
  const runtime = createRuntime({ piRpcApi: {
    executable, host: "127.0.0.1", port: 0,
    auth: { tokens: [{ sha256: createHash("sha256").update(token).digest("hex"), scopes: ["*"] }] },
    profiles: { test: profile, explicit: { ...profile, sessionDir: join(root, "explicit-sessions"), args: [...profile.args, "--provider", "openai", "--model", "gpt-4o-mini"] } },
    limits: { commandTimeoutMs: 15_000, shutdownGraceMs: 1000, killGraceMs: 1000 },
  } }, { spawn });
  t.after(() => runtime.close());
  const address = await runtime.listen();
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const create = async (body = {}) => (await request("/v1/sessions", { profile: "test", ...body })).session;
  const rpc = async (session, body) => {
    const value = await request(`/v1/sessions/${session.id}/rpc`, body);
    assert.equal(value.success, true, JSON.stringify(value));
    return value.data;
  };
  const model = async session => {
    const { model } = await rpc(session, { type: "get_state" });
    return { provider: model.provider, model: model.id };
  };
  const saved = { provider: "anthropic", model: "claude-sonnet-4-6" };
  const temporary = { provider: "openai", model: "gpt-4o-mini" };
  const first = await create();
  assert.deepEqual(await model(first), temporary);
  await rpc(first, { type: "set_model", provider: saved.provider, modelId: saved.model });
  // Exactly the command sent by web Settings / Save current model.
  await rpc(first, { type: "prompt", message: "/agentbox-defaults model current" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath)).agentboxDefaultModel, saved);
  await rpc(first, { type: "set_model", provider: temporary.provider, modelId: temporary.model });
  assert.deepEqual(await model(first), temporary);
  const fresh = await create();
  assert.deepEqual(await model(fresh), saved);
  assert.deepEqual(await model(first), temporary); // no mutation of other live sessions
  assert.deepEqual(await model(await create({ profile: "explicit" })), temporary);

  // Resume a conversation: its model must survive regardless of the default.
  const nativeId = randomUUID(), timestamp = new Date().toISOString();
  await writeFile(join(sessionDir, `restore_${nativeId}.jsonl`), [
    { type: "session", version: 3, id: nativeId, cwd: root, timestamp },
    { type: "model_change", id: "00000001", parentId: null, timestamp, provider: temporary.provider, modelId: temporary.model },
    { type: "message", id: "00000002", parentId: "00000001", timestamp, message: { role: "user", content: "saved conversation", timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const restored = await create({ resume: nativeId });
  assert.deepEqual(await model(restored), temporary);
  // Supervisor fork/revert restores call set_model, even for an empty prefix.
  const route = `/v1/sessions/${restored.id}/conversation`;
  const snapshot = await request(route);
  const fork = await request(route, { action: "fork", entryId: "00000002",
    expectedNativeSessionId: snapshot.nativeSessionId, expectedLeafId: snapshot.leafId });
  assert.deepEqual(await model(fork.session), temporary);
  assert.deepEqual(await model(await create()), saved);
  const settings = JSON.parse(await readFile(settingsPath));
  assert.deepEqual(settings.agentboxDefaultModel, saved);
  assert.equal(settings.theme, "light");
});
