// Offline contracts against the pinned Pi Jiti loader, not a TS transpilation mock.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiPolicyExtension } from "../extensions/pi-policy.ts";

const piRoot = process.argv[2];
assert.ok(piRoot, "usage: pi-bulk.mjs <Pi package root>");
const home = await mkdtemp(join(tmpdir(), "agentbox-bulk-test-"));
const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_OFFLINE = "1";
const load = path => import(pathToFileURL(join(piRoot, path)).href);
let loaded, session;
// Pi 1.5.2 NestedToolCallRunner.execute returns a ToolCallOutcome envelope,
// not the inner AgentToolResult. Keep mocks faithful to that public contract.
const ok = (text = "fixture feedback") => ({
  result: { content: [{ type: "text", text }], details: {} }, isError: false,
});
const files = kind => ["one", "two", "three"].map(path => kind === "edit"
  ? { path, edits: [{ oldText: "old", newText: "new" }, { oldText: "other", newText: "" }] }
  : { path, content: path === "two" ? "" : `content ${path}` });
const statuses = result => result.details.files.map(file => file.status);
const text = result => result.content.map(block => block.text ?? "").join("\n");
let checks = 0;
const failures = [];
async function check(name, fn) {
  checks++;
  try {
    await fn(); console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok ${checks} - ${name}\n${error.stack ?? error}`);
  }
}
try {
  assert.equal(JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")).version, "1.5.2");
  const { loadExtensions, loadExtensionFromFactory } = await load("dist/core/extensions/loader.js");
  const { createEventBus } = await load("dist/core/event-bus.js");
  const bus = createEventBus();
  loaded = await loadExtensions([fileURLToPath(new URL("../extensions/pi-bulk.ts", import.meta.url))], home, bus);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tools = loaded.extensions[0].tools;
  const invoke = (kind, input, executeTool, signal) => tools.get(`bulk_${kind}`).definition.execute(
    "bulk-fixture", input, signal, undefined, { cwd: home, executeTool });

  await check("model-only sequential metadata and exact nested reachability", async () => {
    assert.deepEqual([...tools.keys()].sort(), ["bulk_edit", "bulk_write"]);
    for (const kind of ["edit", "write"]) {
      const def = tools.get(`bulk_${kind}`).definition;
      assert.equal(def.exposure, "model-only");
      assert.equal(def.executionMode, "sequential");
      assert.deepEqual(await def.reachesTools({ files: files(kind) }), [kind]);
      assert.equal(def.parameters.additionalProperties, false);
      assert.equal(def.parameters.properties.files.maxItems, 100);
      assert.equal(def.parameters.properties.files.items.additionalProperties, false);
    }
  });

  for (const kind of ["edit", "write"]) {
    await check(`${kind}: all files/replacements forwarded in order, awaited, signal preserved, arguments snapshotted`, async () => {
      const input = { files: files(kind) }, expected = structuredClone(input.files), calls = [];
      const controller = new AbortController();
      let running = false;
      const result = await invoke(kind, input, async (name, args, options) => {
        assert.equal(running, false, "children must not overlap"); running = true;
        assert.equal(name, kind); assert.equal(options.signal, controller.signal);
        calls.push(structuredClone(args));
        if (calls.length === 1) {
          input.files[1].path = "mutated-after-validation";
          if (kind === "edit") input.files[1].edits[0].newText = "mutated";
          else input.files[1].content = "mutated";
        }
        await new Promise(resolve => setImmediate(resolve)); running = false;
        return ok(kind === "edit" ? `Successfully replaced 2 block(s) in ${args.path}.` : `Successfully wrote 10 bytes to ${args.path}`);
      }, controller.signal);
      assert.deepEqual(calls, expected);
      assert.deepEqual(result.details.files, expected.map(({ path }) => ({ path, status: "completed" })));
      assert.equal(result.isError, false);
      assert.doesNotMatch(text(result), /Successfully/);
    });

    await check(`${kind}: whole-shape prevalidation rejects invalid second file before any child call`, async () => {
      const valid = files(kind)[0];
      const badFiles = [null, [], {}, { ...valid, path: " " }, { ...valid, path: "a\0b" },
        { ...valid, path: "x".repeat(4097) }, { ...valid, extra: true },
        ...(kind === "write" ? [{ path: "two", content: 1 }, { path: "two" }]
          : [{ path: "two", edits: [] }, { path: "two", edits: Array(1001).fill({ oldText: "a", newText: "b" }) },
            { path: "two", edits: [{ oldText: "", newText: "b" }] },
            { path: "two", edits: [{ oldText: "a", newText: 1 }] },
            { path: "two", edits: [{ oldText: "a", newText: "b", extra: true }] }])];
      let calls = 0;
      const child = async () => { calls++; return ok(); };
      for (const bad of badFiles) await assert.rejects(invoke(kind, { files: [valid, bad] }, child));
      for (const bad of [null, [], {}, { files: [] }, { files: [valid], extra: true }, { files: Array(101).fill(valid) }]) {
        await assert.rejects(invoke(kind, bad, child));
      }
      assert.equal(calls, 0);
    });

    await check(`${kind}: stop first child error; exact completed/failed/skipped details and feedback`, async () => {
      let calls = 0;
      const result = await invoke(kind, { files: files(kind) }, async () => ++calls === 1 ? ok("diagnostic: first changed")
        : { ...ok("policy denied second"), isError: true });
      assert.equal(calls, 2); assert.equal(result.isError, true);
      assert.deepEqual(result.details.files, ["completed", "failed", "skipped"].map((status, i) => ({ path: files(kind)[i].path, status })));
      assert.match(text(result), /diagnostic: first changed/);
      assert.match(text(result), /policy denied second/);
      assert.match(text(result), /NOT rolled back/);
      assert.match(text(result), /failed file may have changed/);
    });

    await check(`${kind}: cancellation before and between files`, async () => {
      for (const before of [true, false]) {
        const controller = new AbortController(); let calls = 0;
        if (before) controller.abort();
        const result = await invoke(kind, { files: files(kind) }, async (_name, _args, options) => {
          calls++; assert.equal(options.signal, controller.signal); controller.abort(); return ok();
        }, controller.signal);
        assert.equal(calls, before ? 0 : 1); assert.equal(result.isError, true);
        assert.deepEqual(statuses(result), before ? ["skipped", "skipped", "skipped"] : ["completed", "skipped", "skipped"]);
        assert.match(text(result), /Cancelled/);
      }
      const controller = new AbortController(); let calls = 0;
      const result = await invoke(kind, { files: files(kind) }, async () => {
        calls++; controller.abort(); throw new Error("AbortError fixture");
      }, controller.signal);
      assert.equal(calls, 1); assert.deepEqual(statuses(result), ["failed", "skipped", "skipped"]);
      assert.equal(result.isError, true);
    });

    await check(`${kind}: unexpected rejection preserves earlier completion`, async () => {
      for (const error of [new Error("runtime rejection"), "runtime rejection"]) {
        let calls = 0;
        const result = await invoke(kind, { files: files(kind) }, async () => {
          if (++calls === 2) throw error;
          return ok("earlier feedback");
        });
        assert.equal(calls, 2); assert.equal(result.isError, true);
        assert.deepEqual(statuses(result), ["completed", "failed", "skipped"]);
        assert.match(text(result), /runtime rejection/); assert.match(text(result), /earlier feedback/);
      }
    });
  }

  await check("diagnostics/hook feedback retained; only exact stock acknowledgements removed; output bounded", async () => {
    const feedback = "Successfully wrote 1 bytes to one\nHook diagnostic: inspect this";
    const result = await invoke("write", { files: files("write").slice(0, 1) }, async () => ({
      result: { content: [{ type: "text", text: feedback }, { type: "image", data: "ignored", mimeType: "image/png" },
        { type: "text", text: "compiler: fixture error" }], details: { diagnostics: "not a text block" } }, isError: false,
    }));
    assert.ok(text(result).includes(feedback)); assert.match(text(result), /compiler: fixture error/);
    assert.doesNotMatch(text(result), /ignored/);
    for (const big of ["x".repeat(50000), "line\n".repeat(5000)]) {
      const bounded = await invoke("edit", { files: files("edit") }, async () => ok(big));
      assert.match(text(bounded), /Bulk output truncated/);
      assert.ok(text(bounded).length < 12100);
      assert.ok(text(bounded).split("\n").length <= 1801);
      assert.deepEqual(statuses(bounded), ["completed", "completed", "completed"]);
    }
  });

  await check("long paths cannot hide batch statuses or failures behind truncation", async () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({ path: `${i}-${"x".repeat(4000)}`, content: "fixture" }));
    let calls = 0;
    const result = await invoke("write", { files: batch }, async () => {
      calls++;
      return calls === 99 ? { ...ok("last failure reason"), isError: true } : ok("x".repeat(200));
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /NOT rolled back/);
    assert.match(text(result), /99\. failed:/);
    assert.match(text(result), /100\. skipped:/);
    assert.match(text(result), /last failure reason/);
    assert.equal(result.details.files[99].path, batch[99].path);
  });

  await check("offline AgentSession: real nested edit/write pipeline, managed policy denial, tool_result feedback", async () => {
    // No provider turn is requested. Invoke the session-wrapped model tool with a
    // synthetic assistant message; its ctx.executeTool uses Pi's real nested runner.
    // This tests nested hooks, not outer model streaming/outer tool_call dispatch.
    const events = [], hookErrors = [];
    const config = { version: 1, defaultDecision: "allow", rules: [
      { tools: ["write", "edit"], patterns: ["**/denied-fixture.txt"], decision: "deny" },
    ] };
    const policy = await loadExtensionFromFactory(createPiPolicyExtension({
      env: { HOME: home }, argv: [], signal() {}, realpath: async path => path,
      readFile: async () => JSON.stringify(config),
    }), home, bus, loaded.runtime, "<bulk-policy-fixture>");
    const observer = await loadExtensionFromFactory(pi => {
      pi.on("tool_call", event => { events.push({ type: "call", name: event.toolName, input: structuredClone(event.input) }); });
      pi.on("tool_result", event => {
        events.push({ type: "result", name: event.toolName, isError: event.isError });
        return { content: [...event.content, { type: "text", text: `hook feedback ${event.toolName}` }] };
      });
    }, home, bus, loaded.runtime, "<bulk-feedback-fixture>");
    loaded.extensions.push(observer, policy);
    const resourceLoader = {
      getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Offline fixture",
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources() {}, async reload() {},
    };
    const { ModelRuntime } = await load("dist/core/model-runtime.js");
    const { SettingsManager } = await load("dist/core/settings-manager.js");
    const { SessionManager } = await load("dist/core/session-manager.js");
    const { createAgentSession } = await load("dist/core/sdk.js");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(home, "auth.json"), modelsPath: join(home, "models.json"),
      modelsStorePath: join(home, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd: home, agentDir: home, modelRuntime, resourceLoader,
      settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(home),
      tools: ["edit", "write", "bulk_edit", "bulk_write"],
    }));
    await session.bindExtensions({ mode: "rpc", onError: error => hookErrors.push(error) });
    const execute = async (kind, batch) => {
      const tool = session.agent.state.tools.find(tool => tool.name === `bulk_${kind}`);
      assert.ok(tool, `session exposes bulk_${kind}`);
      session.agent.state.messages = [{ role: "assistant", content: [{ type: "toolCall", id: "bulk-session", name: tool.name, arguments: { files: batch } }],
        api: "offline-fixture", provider: "offline-fixture", model: "offline-fixture", stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
      return tool.execute("bulk-session", { files: batch }, new AbortController().signal);
    };
    const a = join(home, "a.txt"), b = join(home, "b.txt");
    let result = await execute("write", [{ path: a, content: "alpha beta" }, { path: b, content: "gamma delta" }]);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(text(result), /hook feedback write/);
    assert.equal(await readFile(a, "utf8"), "alpha beta");
    assert.equal(await readFile(b, "utf8"), "gamma delta");
    result = await execute("edit", [
      { path: a, edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "beta", newText: "BETA" }] },
      { path: b, edits: [{ oldText: "gamma", newText: "GAMMA" }] },
    ]);
    assert.equal(result.isError, false); assert.match(text(result), /hook feedback edit/);
    assert.equal(await readFile(a, "utf8"), "ALPHA BETA"); assert.equal(await readFile(b, "utf8"), "GAMMA delta");
    const denied = join(home, "denied-fixture.txt"), skipped = join(home, "skipped.txt");
    result = await execute("write", [{ path: a, content: "completed" }, { path: denied, content: "never" }, { path: skipped, content: "never" }]);
    assert.equal(result.isError, true); assert.deepEqual(statuses(result), ["completed", "failed", "skipped"]);
    assert.equal(await readFile(a, "utf8"), "completed");
    await assert.rejects(access(denied)); await assert.rejects(access(skipped));
    assert.ok(events.some(event => event.type === "call" && event.input.path === denied), "denied nested call passes hook dispatch");
    assert.ok(!events.some(event => event.type === "call" && event.input.path === skipped));
    assert.equal(events.filter(event => event.type === "result" && event.name === "edit").length, 2);
    assert.equal(events.filter(event => event.type === "result" && event.name === "write" && !event.isError).length, 3);
    result = await execute("edit", [
      { path: a, edits: [{ oldText: "completed", newText: "changed before mismatch" }] },
      { path: b, edits: [{ oldText: "does not match", newText: "never" }] },
      { path: skipped, edits: [{ oldText: "never", newText: "never" }] },
    ]);
    assert.equal(result.isError, true);
    assert.deepEqual(statuses(result), ["completed", "failed", "skipped"]);
    assert.equal(await readFile(a, "utf8"), "changed before mismatch");
    assert.equal(await readFile(b, "utf8"), "GAMMA delta");
    await assert.rejects(access(skipped));
    assert.deepEqual(hookErrors, []);
    session.dispose(); session = undefined;
  });
  console.log(`pi-bulk: ${checks - failures.length}/${checks} contracts passed (Pi 1.5.2; offline, temporary files only)`);
  if (failures.length) process.exitCode = 1;
} finally {
  session?.dispose();
  loaded?.runtime.invalidate();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
}
