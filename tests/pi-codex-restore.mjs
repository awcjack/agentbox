// Offline real-process regression: model resolution happens BEFORE session_start.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert.ok(root, "usage: node tests/pi-codex-restore.mjs <pi package directory>");
const { FileModelsStore } = await import(pathToFileURL(`${root}/dist/core/models-store.js`));
const { openaiCodexProvider } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`));
const extension = new URL("../extensions/pi-codex-accounts.ts", import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), "pi-codex-restore-"));
async function state(args) {
  const child = spawn(process.execPath, [`${root}/dist/cli.js`, "--mode", "rpc", "--offline",
    "--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-tools", ...args], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory,
      PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", stderr = "", timer;
  const events = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`RPC timeout: ${stderr}`)), 15_000);
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`RPC exited ${code}: ${stderr}`)));
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const lines = output.split("\n"); output = lines.pop();
        for (const line of lines) {
          let record;
          try { record = JSON.parse(line); } catch { events.push(line); continue; }
          if (record.type === "extension_error") events.push(record);
          if (record.id === "state") resolve({ ...record, diagnostics: { stderr, events, args } });
        }
      });
      child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      // Let Pi finish file-lock cleanup before the next independent process.
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(kill); }
    }
  }
}
const expect = (result, provider, id) => {
  assert.deepEqual(result.diagnostics.events, [], JSON.stringify(result.diagnostics));
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(result.data.model?.provider, provider, `real RPC state for ${id}: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.data.model.id, id);
};
try {
  const native = openaiCodexProvider();
  const remote = { ...native.getModels()[0], id: "remote-codex-fixture", name: "Remote fixture" };
  await new FileModelsStore(join(directory, "models-store.json")).write(native.id, {
    models: [remote], checkedAt: Date.now(), lastModified: Date.now() + 86_400_000,
  });
  await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
    [native.id]: { models: [{ id: "configured-codex", reasoning: true }] },
  } }));
  const credential = (account) => ({ type: "oauth", access: `fake.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  })).toString("base64url")}.test`, refresh: "unused", expires: Date.now() + 3_600_000 });
  await writeFile(join(directory, "auth.json"), JSON.stringify({
    "codex-work": credential("work"), "openai-codex": credential("personal"),
  }));
  // Deterministic regression for the Pi package patch. Startup must batch both
  // registration APIs before its one awaited refresh, not launch background
  // refreshes which may invalidate that refresh's auth-availability publication.
  const { ModelRuntime, SettingsManager, createAgentSessionServices } = await import(pathToFileURL(`${root}/dist/index.js`));
  const { InMemoryCredentialStore } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/index.js`));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("codex-work", async () => credential("work"));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const refresh = runtime.refresh.bind(runtime);
  let refreshCalls = 0;
  runtime.refresh = (...args) => { refreshCalls++; return refresh(...args); };
  await createAgentSessionServices({
    cwd: directory, agentDir: directory, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.registerProvider({ ...native, id: "codex-work",
          getModels: () => native.getModels().map((model) => ({ ...model, provider: "codex-work" })) });
        pi.registerProvider("startup-legacy", {
          baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "unused-offline-fixture",
          models: [{ ...remote, id: "legacy-fixture" }],
        });
      }],
    },
  });
  assert.equal(refreshCalls, 1, "startup must have exactly one awaited refresh, no detached registration refreshes");
  assert.equal(runtime.hasConfiguredAuth("codex-work"), true);
  assert.equal(runtime.hasConfiguredAuth("startup-legacy"), true);
  assert.ok(runtime.getModel("codex-work", "gpt-5.4"));
  assert.ok(runtime.getModel("startup-legacy", "legacy-fixture"));
  const settings = (provider, model) => writeFile(join(directory, "settings.json"), JSON.stringify({
    defaultProvider: provider, defaultModel: model,
  }));
  await settings(native.id, "gpt-5.4");
  await mkdir(join(directory, "history"));
  const sessionPath = join(directory, "history", "resume.jsonl");
  const timestamp = new Date().toISOString();
  for (const modelId of ["gpt-5.4", remote.id, "configured-codex"]) {
    await writeFile(sessionPath, [
      { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd: directory, timestamp },
      { type: "model_change", id: "00000001", parentId: null, timestamp, provider: "codex-work", modelId },
      { type: "thinking_level_change", id: "00000002", parentId: "00000001", timestamp, thinkingLevel: "high" },
      { type: "message", id: "00000003", parentId: "00000002", timestamp,
        message: { role: "user", content: "Offline restoration fixture", timestamp: Date.now() } },
      { type: "message", id: "00000004", parentId: "00000003", timestamp,
        message: { role: "assistant", provider: "codex-work", model: modelId, api: "openai-codex-responses",
          content: [{ type: "text", text: "Fixture answer" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    // Two independent restarts must both restore the alias rather than the default account.
    for (let restart = 0; restart < 2; restart++) {
      const result = await state(["--session", sessionPath]);
      expect(result, "codex-work", modelId);
      assert.equal(result.data.sessionId, "11111111-1111-4111-8111-111111111111");
      assert.equal(result.data.messageCount, 2);
      assert.equal(result.data.thinkingLevel, "high");
    }
  }
  expect(await state(["--session", sessionPath, "--provider", native.id, "--model", "gpt-5.4"]), native.id, "gpt-5.4");
  expect(await state(["--no-session", "--provider", "codex-work", "--model", remote.id]), "codex-work", remote.id);
  await settings("codex-work", remote.id);
  expect(await state(["--no-session"]), "codex-work", remote.id);
  console.log("Codex real RPC: bundled/cached/configured alias restoration, repeated restart, thinking, explicit override, fresh defaults and deterministic startup refresh barrier passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
