// Offline integration contract: the exact published runtime through Pi's Jiti
// loader (including lazy TUI chunks), plus Agentbox's unchanged policy gate.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiPolicyExtension } from "../extensions/pi-policy.ts";

const [piRoot, runtimeRoot] = process.argv.slice(2);
assert.ok(piRoot && runtimeRoot, "usage: pi-goal.mjs <Pi package> <Goal runtime>");
const home = await mkdtemp(join(tmpdir(), "agentbox-goal-test-"));
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_OFFLINE = "1";
const load = (path) => import(pathToFileURL(`${piRoot}/${path}`));
const { loadExtensions } = await load("dist/core/extensions/loader.js");
const { createEventBus } = await load("dist/core/event-bus.js");
const goalRoot = `${runtimeRoot}/node_modules/@narumitw/pi-goal`;
assert.equal(JSON.parse(await readFile(`${piRoot}/package.json`)).version, "0.84.2");
assert.equal(JSON.parse(await readFile(`${goalRoot}/package.json`)).version, "0.53.1");
assert.equal(JSON.parse(await readFile(`${runtimeRoot}/node_modules/@narumitw/pi-tui-kit/package.json`)).version, "0.57.0");

async function harness(entries = []) {
  const bus = createEventBus();
  const loaded = await loadExtensions([`${goalRoot}/dist/index.ts`], home, bus);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  assert.deepEqual([...ext.tools.keys()].sort(), ["goal_blocked", "goal_complete", "goal_wait"]);
  let active = ["read", "bash", "task", ...ext.tools.keys()];
  const prompts = [], notices = [];
  let aborts = 0;
  Object.assign(loaded.runtime, {
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendUserMessage: (text) => { prompts.push(text); },
  });
  const ctx = {
    cwd: home, mode: "rpc", hasUI: true,
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
    isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborts++; },
    ui: { notify: (message, type) => notices.push({ message, type }), setStatus() {}, confirm: async () => false },
  };
  const emit = async (name, data = {}) => {
    for (const handler of ext.handlers.get(name) ?? []) {
      const result = await handler({ type: name, ...data }, ctx);
      if (result?.block) return result;
    }
  };
  const command = (args) => ext.commands.get("goal").handler(args, ctx);
  const state = () => entries.filter(e => e.customType === "goal-state").at(-1)?.data.goal;
  await emit("session_start", { reason: "startup" });
  return { bus, ext, ctx, emit, command, state, entries, prompts, notices,
    active: () => active, aborts: () => aborts,
    close: async () => { await emit("session_shutdown"); loaded.runtime.invalidate(); } };
}

let h;
try {
  h = await harness();
  assert.deepEqual(h.active(), ["read", "bash", "task"], "fresh runtime hides only its own tools");
  await h.command(""); // lazy manager chunk: RPC status, not custom UI
  assert.match(h.notices.at(-1).message, /No goal/);
  let reply;
  const unsubscribe = h.bus.on("pi-goal:event:test-run", event => { reply = event; });
  h.bus.emit("pi-goal:start", { runId: "test-run", objective: "test" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply?.error?.code, "RPC_DISABLED", "managed event-bus starts are opt-in");
  unsubscribe();

  // First-use TUI menu must load Kit and its transitive dependencies, not just
  // register successfully. Cancellation must neither start work nor save settings.
  h.ctx.mode = "tui";
  let customCalls = 0;
  h.ctx.ui.custom = async () => { customCalls++; return undefined; };
  await h.command("");
  assert.equal(customCalls, 1, "lazy TUI dependencies load through Pi Jiti");
  assert.equal(h.prompts.length, 0);
  h.ctx.mode = "rpc";
  await h.command("--tokens 100k verify the fixture");
  assert.equal(h.state().status, "active");
  assert.equal(h.state().tokenBudget, 100000);
  assert.equal(h.prompts.length, 1);
  assert.ok(h.active().includes("goal_complete"));
  assert.match(h.notices.at(-1).message, /25 responses/);

  // Actual upstream tool_call handlers run before policy; no Goal API changes
  // auto mode or grants permission to execute the work it schedules.
  const policyHandlers = new Map();
  let approvals = 0;
  let allow = false;
  const config = { version: 1, defaultDecision: "ask", timeout: 1000, rules: [
    { tools: ["bash"], patterns: ["forbidden-operation"], decision: "deny" },
  ] };
  createPiPolicyExtension({
    env: { HOME: home }, argv: [], signal() {},
    realpath: async path => path,
    readFile: async () => JSON.stringify(config),
  })({
    events: h.bus, registerCommand() {},
    on: (name, handler) => policyHandlers.set(name, handler),
  });
  const policyContext = { ...h.ctx, ui: { ...h.ctx.ui,
    select: async () => { approvals++; return allow ? "Allow once" : "Deny"; },
  } };
  await policyHandlers.get("session_start")({ reason: "reload" }, policyContext);
  async function preflight(toolName, input) {
    const event = { toolName, input, toolCallId: "test-call" };
    return await h.emit("tool_call", event) ?? await policyHandlers.get("tool_call")(event, policyContext);
  }
  assert.equal((await preflight("bash", { command: "forbidden-operation" })).block, true);
  assert.equal(approvals, 0, "deny cannot become an ask");
  assert.equal((await preflight("bash", { command: "echo fixture" })).block, true);
  assert.equal(approvals, 1, "Goal work retains human approval");
  allow = true;
  assert.equal(await preflight("bash", { command: "echo fixture" }), undefined);
  assert.equal(approvals, 2);
  assert.equal(await preflight("goal_wait", { goal_id: h.state().id, reason: "fixture" }), undefined);
  assert.equal(approvals, 3, "Goal's own tools also pass managed policy");
  await policyHandlers.get("session_shutdown")({}, policyContext);

  const oldId = h.state().id;
  await h.command("pause");
  assert.equal(h.state().status, "paused");
  assert.ok(h.aborts() > 0);
  assert.equal((await h.emit("tool_call", { toolName: "bash", input: {} })).block, true);
  await h.command("resume");
  assert.notEqual(h.state().id, oldId);
  const stale = await h.ext.tools.get("goal_complete").definition.execute("stale", {
    goal_id: oldId, summary: "Verified the fixture with passing tests.",
  }, undefined, undefined, h.ctx);
  assert.notEqual(h.state().status, "complete");
  assert.match(JSON.stringify(stale), /stale|match/i);

  // Replace confirmation is fail-closed; clearing cancels continuation.
  const currentId = h.state().id;
  await h.command("replacement objective");
  assert.equal(h.state().id, currentId);
  await h.command("clear");
  assert.equal(h.state(), null);
  const sent = h.prompts.length;
  await h.emit("agent_settled");
  assert.equal(h.prompts.length, sent);
  await h.close(); h = undefined;

  // Budget is cumulative assistant usage, enforced after a finished message;
  // no further summary/provider request may be scheduled after exhaustion.
  h = await harness();
  await h.command("--tokens 10 budget fixture");
  const kickoff = h.prompts.at(-1);
  await h.emit("before_agent_start", { prompt: kickoff });
  h.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 11 } } });
  await h.emit("tool_execution_end");
  assert.equal(h.state().status, "budget_limited");
  assert.equal(h.state().tokensUsed, 11);
  const budgetSent = h.prompts.length;
  await h.emit("agent_settled");
  await h.command("resume");
  assert.equal(h.prompts.length, budgetSent);
  await h.close(); h = undefined;

  // Continuation is single-flight at settled idle, never merely agent_end;
  // three identical tool-free automatic runs trigger the default guard.
  h = await harness();
  await h.command("continuation fixture");
  const assistant = { role: "assistant", content: [{ type: "text", text: "Still checking" }], stopReason: "stop" };
  await h.emit("before_agent_start", { prompt: h.prompts.at(-1) });
  await h.emit("agent_end", { messages: [assistant] });
  assert.equal(h.prompts.length, 1);
  for (let i = 0; i < 3; i++) {
    const before = h.prompts.length;
    await h.emit("agent_settled");
    assert.equal(h.prompts.length, before + 1);
    await h.emit("agent_settled");
    assert.equal(h.prompts.length, before + 1, "duplicate settlement cannot dispatch twice");
    await h.emit("before_agent_start", { prompt: h.prompts.at(-1) });
    await h.emit("turn_end", { message: assistant });
    await h.emit("agent_end", { messages: [assistant] });
  }
  assert.equal(h.state().status, "paused");
  assert.equal(h.state().safetyPauseCause, "no_progress");
  assert.equal(h.state().automaticModelTurns, 3);
  await h.close(); h = undefined;

  // Restore at the response cap is paused before a model request.
  h = await harness([{ type: "custom", customType: "goal-state", data: { goal: {
    id: "restored-goal", text: "fixture", status: "active", startedAt: 1, updatedAt: 1,
    iteration: 25, tokensUsed: 20, timeUsedSeconds: 1, baselineTokens: 0,
    automaticModelTurns: 25, toolFreeRepeatCount: 0,
  } } }]);
  assert.equal(h.state().status, "paused");
  assert.equal(h.state().safetyPauseCause, "continuation_limit");
  await h.emit("agent_settled");
  assert.equal(h.prompts.length, 0);
  await h.close(); h = undefined;

  // Settings are user configuration, not project files. Invalid files are kept.
  await writeFile(join(home, "pi-goal.json"), "{invalid");
  h = await harness();
  assert.ok(h.notices.some(n => /settings ignored/.test(n.message)));
  assert.equal(await readFile(join(home, "pi-goal.json"), "utf8"), "{invalid");
  await h.close(); h = undefined;
  console.log("pi-goal: loader, lazy TUI/RPC, default-off bus RPC, policy approvals, pause/resume/clear, stale IDs, budget and restore limits passed");
} finally {
  await h?.close();
  await rm(home, { recursive: true, force: true });
}
