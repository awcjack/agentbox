import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRuntime, internals, normalizeConfig } from "../runtime.mjs";

const TOKEN = "correct-horse-battery-staple";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const ALL_SCOPES = ["profiles:read", "sessions:create", "sessions:read", "sessions:write", "sessions:delete"];
const RESUME_ID = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";

function config(overrides = {}) {
  const base = {
    piRpcApi: {
      host: "127.0.0.1",
      port: 0,
      executable: "/bin/pi",
      allowedOrigins: ["https://client.example"],
      auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ALL_SCOPES }] },
      allowedCommands: ["prompt", "get_state", "abort"],
      profiles: {
        default: {
          cwd: "/workspace",
          sessionDir: "/sessions",
          args: ["--approve"],
          env: { PROFILE_VALUE: "yes" },
        },
      },
      limits: {
        maxSessions: 4,
        maxSseClients: 2,
        maxBodyBytes: 1024,
        maxRecordBytes: 1024,
        maxEvents: 10,
        maxEventBytes: 4096,
        maxStderrBytes: 1024,
        maxPendingCommands: 2,
        maxPendingUi: 2,
        commandTimeoutMs: 500,
        idleTimeoutMs: 10_000,
        cleanupIntervalMs: 1_000,
        sseHeartbeatMs: 1_000,
        shutdownGraceMs: 10,
        killGraceMs: 10,
        requestTimeoutMs: 2_000,
      },
    },
  };
  const api = base.piRpcApi;
  for (const [key, value] of Object.entries(overrides)) {
    api[key] = value && typeof value === "object" && !Array.isArray(value) && typeof api[key] === "object"
      ? { ...api[key], ...value }
      : value;
  }
  return base;
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.input = "";
    this.signals = [];
    this.exited = false;
    this.stdin.on("data", (chunk) => { this.input += chunk.toString(); });
  }

  kill(signal) {
    this.signals.push(signal);
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }

  output(value, ending = "\n") {
    this.stdout.write(`${JSON.stringify(value)}${ending}`);
  }
}

async function fixture(t, customConfig = config(), options = {}) {
  const children = [];
  const spawns = [];
  const spawn = (file, args, spawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    spawns.push({ file, args, options: spawnOptions });
    options.onSpawn?.(child, args);
    return child;
  };
  const runtime = createRuntime(customConfig, {
    spawn,
    now: options.now,
    randomUUID: options.randomUUID,
    realpath: options.realpath ?? (() => "/nix/store/00000000000000000000000000000000-pi/bin/pi"),
    signalProcessGroup: options.signalProcessGroup,
  });
  const address = await runtime.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => runtime.close());
  return { runtime, children, spawns, baseUrl };
}

test("list metadata tracks all sessions without per-session RPC or SSE subscriptions", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const create = () => request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } });
  const first = (await create()).body.session;
  const second = (await create()).body.session;
  const activity = async (id = first.id) => (await request(baseUrl, "/v1/sessions")).body.sessions.find((session) => session.id === id)?.activity;
  const completion = async () => (await request(baseUrl, "/v1/sessions")).body.sessions.find((session) => session.id === first.id).settledEventId;
  assert.equal(await completion(), null, "a fresh idle process is not a finished run");
  assert.equal(await activity(), "starting");
  children[0].output({ type: "agent_start" });
  assert.equal(await activity(), "running");
  assert.equal(await activity(second.id), "starting");
  children[0].output({ type: "extension_ui_request", id: "reply", method: "input", title: "Answer?" });
  assert.equal(await activity(), "waiting_reply");
  children[0].output({ type: "extension_ui_request", id: "approval", method: "confirm", title: "Allow?" });
  assert.equal(await activity(), "waiting_action");
  await request(baseUrl, `/v1/sessions/${first.id}/ui`, { method: "POST", body: { id: "approval", confirmed: false } });
  assert.equal(await activity(), "waiting_reply");
  await request(baseUrl, `/v1/sessions/${first.id}/ui`, { method: "POST", body: { id: "reply", value: "yes" } });
  children[0].output({ type: "agent_end" });
  assert.equal(await activity(), "running", "a low-level run end can still continue automatically");
  assert.equal(await completion(), null, "agent_end is not full completion");
  children[0].output({ type: "agent_settled" });
  assert.equal(await activity(), "idle");
  const firstCompletion = await completion();
  assert.ok(firstCompletion > 0);
  for (let i = 0; i < 12; i++) children[0].output({ type: "extension_ui_request", method: "notify", message: "hello" });
  assert.equal(await completion(), firstCompletion, "completion survives replay eviction and unrelated events");
  children[0].output({ type: "agent_start" });
  children[0].output({ type: "agent_settled" });
  assert.ok(await completion() > firstCompletion, "short runs between list requests retain distinct completion IDs");
  children[0].output({ type: "compaction_start", reason: "manual" });
  assert.equal(await activity(), "running");
  children[0].output({ type: "compaction_end", reason: "manual" });
  assert.equal(await activity(), "idle");
  const deleted = await request(baseUrl, `/v1/sessions/${first.id}`, { method: "DELETE" });
  assert.equal(deleted.response.status, 204);
  assert.equal(await activity(), undefined);
  assert.equal(await activity(second.id), "starting");
});

async function request(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.auth !== false) headers.set("Authorization", `Bearer ${options.token ?? TOKEN}`);
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function createSession(baseUrl, body = { profile: "default" }) {
  const result = await request(baseUrl, "/v1/sessions", { method: "POST", body });
  assert.equal(result.response.status, 201);
  return result.body.session.id;
}

function waitForInput(child, pattern) {
  if (pattern.test(child.input)) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (pattern.test(child.input)) {
        child.stdin.off("data", listener);
        resolve();
      }
    };
    child.stdin.on("data", listener);
  });
}

async function conversationFixture(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-conversation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = config({ allowedCommands: ["prompt", "get_state", "get_entries", "abort"],
    profiles: { default: { cwd: "/workspace", sessionDir: root } }, limits: { maxRecordBytes: 64 * 1024 }, ...overrides });
  const f = await fixture(t, cfg, { onSpawn(child, args) {
    const path = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
    const records = path ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse) : [];
    child.nativeId = records[0]?.id ?? args[args.indexOf("--session-id") + 1];
    child.entries = records.slice(1);
    child.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "test", id: "model" },
      thinkingLevel: "off", autoCompactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" };
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const command = JSON.parse(line);
        if (["set_model", "set_thinking_level", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode"].includes(command.type)) {
          const values = { set_model: ["model", { provider: command.provider, id: command.modelId }], set_thinking_level: ["thinkingLevel", command.level],
            set_auto_compaction: ["autoCompactionEnabled", command.enabled], set_steering_mode: ["steeringMode", command.mode], set_follow_up_mode: ["followUpMode", command.mode] };
          const [key, value] = values[command.type];
          if (!child.ignoreSettings) child.state[key] = value;
          setImmediate(() => child.output({ type: "response", id: command.id, command: command.type, success: !child.rejectSettings }));
          continue;
        }
        if (!["get_state", "get_entries"].includes(command.type)) continue;
        const respond = () => {
          options.beforeRead?.(child, command, f);
          const data = command.type === "get_state" ? { sessionId: child.nativeId, ...child.state }
            : { entries: child.entries, leafId: child.leafId === undefined ? child.entries.at(-1)?.id ?? null : child.leafId };
          child.output({ id: command.id, type: "response", command: command.type, success: true, data });
        };
        if (child.holdReads) child.releaseRead = respond;
        else setImmediate(respond);
      }
    });
    options.onSpawn?.(child, args);
  } });
  const id = await createSession(f.baseUrl);
  const source = f.children[0];
  f.source = source;
  const entry = (id, parentId, type, rest) => ({ id, parentId, type, timestamp: "2026-09-10T00:00:00.000Z", ...rest });
  source.entries = [
    entry("model", null, "model_change", { provider: "test", modelId: "model" }),
    entry("u1", "model", "message", { message: { role: "user", content: "same", timestamp: 1 } }),
    entry("a1", "u1", "message", { message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 } }),
    entry("offbranch", "a1", "message", { message: { role: "user", content: "not active", timestamp: 3 } }),
    entry("u2", "a1", "message", { message: { role: "user", content: [{ type: "text", text: "same" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 4 } }),
    entry("a2", "u2", "message", { message: { role: "assistant", content: [], timestamp: 5 } }),
  ];
  const path = join(root, `source_${source.nativeId}.jsonl`);
  const persist = () => writeFile(path, [JSON.stringify({ type: "session", version: 3, id: source.nativeId, cwd: "/workspace", timestamp: "2026-09-10T00:00:00.000Z" }), ...source.entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  await persist();
  const route = `/v1/sessions/${id}/conversation`;
  const body = { action: "fork", entryId: "u2", expectedNativeSessionId: source.nativeId, expectedLeafId: "a2" };
  return { ...f, id, source, root, path, persist, route, body,
    act: (changes = {}, requestOptions = {}) => request(f.baseUrl, route, { method: "POST", body: { ...body, ...changes }, ...requestOptions }) };
}

test("conversation GET returns authoritative active-branch message IDs", async (t) => {
  const f = await conversationFixture(t);
  const result = await request(f.baseUrl, f.route);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.nativeSessionId, f.source.nativeId);
  assert.equal(result.body.leafId, "a2");
  assert.deepEqual(result.body.messages.map((m) => m.entryId), ["u1", "a1", "u2", "a2"]);
  assert.equal(result.body.messages[2].parentId, "a1");
  assert.deepEqual(result.body.messages[2].message, f.source.entries[4].message);
});

test("conversation restores current settings rather than prefix defaults, without exposing internal setters", async (t) => {
  const f = await conversationFixture(t);
  Object.assign(f.source.state, { model: { provider: "other", id: "current" }, thinkingLevel: "high", autoCompactionEnabled: false, steeringMode: "all", followUpMode: "all" });
  const source = f.runtime.sessions.get(f.id), stop = source.stop;
  source.stop = function () {
    assert.deepEqual(f.children[1].state, f.source.state);
    return stop.call(this);
  };
  assert.equal((await f.act({ action: "revert", entryId: "u1" })).response.status, 200);
  assert.deepEqual(f.children[1].state, f.source.state);
  for (const type of ["set_thinking_level", "fork"]) {
    assert.equal((await request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type, level: "high" } })).response.status, 403);
  }
});

test("settings restoration rejection or mismatch never stops the source", async (t) => {
  for (const flag of ["rejectSettings", "ignoreSettings"]) {
    const f = await conversationFixture(t, {}, { onSpawn(child) { child[flag] = true; } });
    f.source.state.thinkingLevel = "high";
    assert.equal((await f.act({ action: "revert" })).body.error.code, "settings_restore_failed");
    assert.equal(f.source.exited, false);
    assert.equal(f.children[1].exited, true);
  }
});

test("native header rejects stale RPC/UI writes while preserving optional-header compatibility", async (t) => {
  const f = await conversationFixture(t);
  const reverted = await f.act({ action: "revert" });
  const rpc = `/v1/sessions/${f.id}/rpc`, ui = `/v1/sessions/${f.id}/ui`;
  const child = f.children[1];
  child.output({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  const before = child.input;
  for (const [path, body] of [[rpc, { type: "prompt", message: "stale" }], [ui, { id: "dialog", confirmed: true }]]) {
    assert.equal((await request(f.baseUrl, path, { method: "POST", body, headers: { "X-Pi-Session-Id": f.source.nativeId } })).body.error.code, "conversation_stale");
    assert.equal((await request(f.baseUrl, path, { method: "POST", body, headers: { "X-Pi-Session-Id": "invalid" } })).response.status, 400);
  }
  assert.equal(child.input, before);
  assert.equal((await request(f.baseUrl, ui, { method: "POST", body: { id: "dialog", confirmed: true }, headers: { "X-Pi-Session-Id": reverted.body.session.nativeSessionId } })).response.status, 202);
  for (const headers of [{}, { "X-Pi-Session-Id": reverted.body.session.nativeSessionId }]) {
    const writing = request(f.baseUrl, rpc, { method: "POST", body: { type: "prompt", id: "write", message: "accepted" }, headers });
    await new Promise((resolve) => {
      child.stdin.once("data", () => { child.output({ type: "response", id: "write", command: "prompt", success: true }); resolve(); });
    });
    assert.equal((await writing).response.status, 200);
  }
  const preflight = await request(f.baseUrl, rpc, { method: "OPTIONS", headers: { Origin: "https://client.example" } });
  assert.match(preflight.response.headers.get("access-control-allow-headers"), /x-pi-session-id/);
});

test("replacement announces a nonterminal source exit and exposes switching metadata until commit", async (t) => {
  const f = await conversationFixture(t);
  const session = f.runtime.sessions.get(f.id), events = [];
  const publish = session.publish;
  session.publish = function (event) { events.push(event); return publish.call(this, event); };
  const stop = session.stop;
  let release, stopping;
  const stopped = new Promise((resolve) => { stopping = resolve; });
  session.stop = async function () {
    await stop.call(this);
    stopping();
    await new Promise((resolve) => { release = resolve; });
  };
  const stream = await fetch(`${f.baseUrl}/v1/sessions/${f.id}/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const streamText = stream.text();
  const action = f.act({ action: "revert" });
  await stopped;
  const replay = await streamText;
  assert.match(replay, /"event":"conversation_replacing"/);
  assert.match(replay, /"event":"conversation_source_exited"/);
  assert.doesNotMatch(replay, /"event":"child_exit"/);
  const metadata = await request(f.baseUrl, `/v1/sessions/${f.id}`);
  assert.equal(metadata.body.session.conversationReplacing, true);
  assert.equal((await request(f.baseUrl, f.route)).body.error.code, "conversation_locked");
  assert.ok(events.findIndex((e) => e.event === "conversation_replacing") < events.findIndex((e) => e.event === "conversation_source_exited"));
  assert.equal(events.some((e) => e.event === "child_exit"), false);
  release();
  assert.equal((await action).body.session.conversationReplacing, false);
});

test("late abandoned child exit releases native reservation and capacity", async (t) => {
  const f = await conversationFixture(t, { limits: { maxSessions: 2, maxRecordBytes: 64 * 1024 } }, { beforeRead(child, command, f) {
    if (child !== f.source) {
      child.ignoreSettings = true;
      child.kill = () => true; // Simulate SIGKILL not yet confirmed by an exit event.
    }
  } });
  f.source.state.thinkingLevel = "high";
  assert.equal((await f.act()).body.error.code, "settings_restore_failed");
  const abandoned = f.children[1];
  const resume = () => request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: abandoned.nativeId } });
  assert.equal((await resume()).body.error.code, "resume_in_use");
  assert.equal((await f.act()).body.error.code, "session_limit");
  abandoned.exited = true;
  abandoned.emit("exit", null, "SIGKILL");
  assert.equal((await resume()).response.status, 201);
});

test("fork creates a separate child with only the pre-target branch; source and files are unchanged", async (t) => {
  const f = await conversationFixture(t);
  const before = await readFile(f.path, "utf8");
  const result = await f.act();
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.session.id, f.id);
  assert.notEqual(result.body.session.nativeSessionId, f.source.nativeId);
  assert.deepEqual(result.body.draft, { text: "same", images: [{ type: "image", data: "YWJj", mimeType: "image/png" }] });
  assert.deepEqual(f.children[1].entries.map((e) => e.id), ["model", "u1", "a1"]);
  assert.equal(f.source.exited, false);
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.equal(f.runtime.sessions.size, 2);
  assert.equal(f.children.some((child) => /"type":"fork"/.test(child.input)), false);
  const history = await request(f.baseUrl, "/v1/history?profile=default");
  assert.equal(history.body.sessions.length, 2);
});

test("revert fork-and-switches the same supervisor slot and retains original native history", async (t) => {
  const f = await conversationFixture(t);
  const original = f.runtime.sessions.get(f.id);
  const before = await readFile(f.path, "utf8");
  const result = await f.act({ action: "revert", entryId: "u1" });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.session.id, f.id);
  assert.notEqual(result.body.session.nativeSessionId, f.source.nativeId);
  assert.equal(f.source.exited, true);
  assert.deepEqual(f.children[1].entries.map((e) => e.id), ["model"]);
  assert.equal(f.runtime.sessions.size, 1);
  assert.equal(await readFile(f.path, "utf8"), before);
  const current = f.runtime.sessions.get(f.id);
  assert.notEqual(current.events, original.events);
  assert.ok(current.events.records[0].id >= original.events.nextId);
  assert.equal(current.events.records.some((event) => JSON.parse(event.data).event === "child_exit"), false);
  assert.equal(JSON.parse(current.events.records.at(-1).data).event, "conversation_changed");
  assert.equal((await f.act()).body.error.code, "conversation_stale");
  const resumed = await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: f.source.nativeId } });
  assert.equal(resumed.response.status, 201);
});

test("conversation rejects stale identity, off-branch/non-user targets and client paths", async (t) => {
  const f = await conversationFixture(t);
  for (const [changes, code] of [
    [{ expectedNativeSessionId: RESUME_ID }, "conversation_stale"], [{ expectedLeafId: "u1" }, "conversation_stale"],
    [{ entryId: "offbranch" }, "invalid_entry"], [{ entryId: "a1" }, "invalid_entry"],
    [{ entryId: "/etc/passwd" }, "invalid_conversation"], [{ sessionPath: f.path }, "invalid_conversation"],
    [{ expectedLeafId: undefined }, "invalid_conversation"], [{ action: "delete" }, "invalid_conversation"],
  ]) assert.equal((await f.act(changes)).body.error.code, code);
  assert.equal(f.children.length, 1);
});

test("conversation requires read/write scopes, create only for fork, and allowed commands", async (t) => {
  const f = await conversationFixture(t);
  const token = f.runtime.config.tokens[0];
  for (const scopes of [["sessions:write", "sessions:create"], ["sessions:read", "sessions:create"], ["sessions:read", "sessions:write"]]) {
    token.scopes = new Set(scopes);
    assert.equal((await f.act()).response.status, 403);
  }
  assert.equal((await f.act({ action: "revert" })).response.status, 200);
  token.scopes = new Set(ALL_SCOPES);
  const current = f.runtime.sessions.get(f.id);
  current.profile.allowedCommands.delete("prompt");
  assert.equal((await f.act()).body.error.code, "command_forbidden");
  current.profile.allowedCommands.delete("get_entries");
  assert.equal((await request(f.baseUrl, f.route)).response.status, 403);
  assert.equal((await request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "fork", entryId: "u1" } })).response.status, 403);
});

test("conversation rejects streaming, compaction, queued messages, pending UI and uncertain writes", async (t) => {
  const f = await conversationFixture(t);
  for (const state of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }]) {
    const previous = { ...f.source.state };
    Object.assign(f.source.state, state);
    assert.equal((await f.act()).body.error.code, "conversation_busy");
    f.source.state = previous;
  }
  const session = f.runtime.sessions.get(f.id);
  session.uncertainWrite = true;
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  session.uncertainWrite = false;
  f.source.output({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  assert.equal(f.children.length, 1);
});

test("conversation lock rejects prompts, UI replies, delete, and competing actions while snapshot is pending", async (t) => {
  const f = await conversationFixture(t);
  f.source.holdReads = true;
  const action = f.act();
  await waitForInput(f.source, /"type":"get_state"/);
  for (const [path, opts] of [
    [f.route, { method: "POST", body: f.body }],
    [`/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "prompt", message: "racing" } }],
    [`/v1/sessions/${f.id}/ui`, { method: "POST", body: { id: "dialog", cancelled: true } }],
    [`/v1/sessions/${f.id}`, { method: "DELETE" }],
  ]) assert.equal((await request(f.baseUrl, path, opts)).body.error.code, "conversation_locked");
  f.source.holdReads = false;
  f.source.releaseRead();
  assert.equal((await action).response.status, 200);
  assert.doesNotMatch(f.source.input, /racing/);
});

test("a pending write excludes conversation changes, including after write timeout", async (t) => {
  const f = await conversationFixture(t, { limits: { maxRecordBytes: 64 * 1024, commandTimeoutMs: 50 } });
  const prompt = request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "prompt", message: "hello" } });
  await waitForInput(f.source, /"type":"prompt"/);
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  assert.equal((await prompt).response.status, 504);
  assert.equal((await f.act()).body.error.code, "conversation_busy");
});

test("unpersisted history and capacity limits fail without stopping the source", async (t) => {
  const f = await conversationFixture(t);
  await writeFile(f.path, "corrupt\n");
  assert.equal((await f.act({ action: "revert" })).body.error.code, "history_unavailable");
  await f.persist();
  f.runtime.config.limits.maxSessions = 1;
  assert.equal((await f.act({ action: "revert" })).body.error.code, "session_limit");
  assert.equal(f.source.exited, false);
  assert.equal(f.children.length, 1);
});

test("failed child verification keeps source active and releases the lock", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_state") child.nativeId = RESUME_ID;
  } });
  const result = await f.act({ action: "revert" });
  assert.equal(result.body.error.code, "conversation_changed");
  assert.equal(f.children[1].exited, true);
  assert.equal(f.source.exited, false);
  assert.equal(f.runtime.sessions.size, 1);
  assert.equal(f.runtime.sessions.get(f.id).conversationLocked, false);
});

test("source changes during child preparation are detected before revert stops it", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_entries") f.source.entries[4].message.content = "changed";
  } });
  assert.equal((await f.act({ action: "revert" })).body.error.code, "conversation_changed");
  assert.equal(f.source.exited, false);
  assert.equal(f.children[1].exited, true);
});

test("revert requires confirmed source exit and keeps native ownership after a failed stop", async (t) => {
  const f = await conversationFixture(t);
  const source = f.runtime.sessions.get(f.id), stop = source.stop;
  source.stop = async () => { source.status = "stopping"; };
  try {
    assert.equal((await f.act({ action: "revert" })).body.error.code, "stop_failed");
    assert.equal(source.conversationReplacing, false);
    assert.equal(JSON.parse(source.events.records.at(-1).data).event, "conversation_replace_failed");
    assert.equal(f.runtime.sessions.get(f.id), source);
    assert.equal(f.children[1].exited, true);
    const resume = await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: f.source.nativeId } });
    assert.equal(resume.body.error.code, "resume_in_use");
    const removed = await request(f.baseUrl, `/v1/sessions/${f.id}`, { method: "DELETE" });
    assert.equal(removed.body.error.code, "stop_failed");
    assert.equal(f.runtime.sessions.get(f.id), source);
  } finally { source.stop = stop; }
});

test("child startup dialogs reject revert without stopping the source", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_state") child.output({ type: "extension_ui_request", id: "startup", method: "confirm" });
  } });
  assert.equal((await f.act({ action: "revert" })).body.error.code, "conversation_busy");
  assert.equal(f.source.exited, false);
  assert.equal(f.children[1].exited, true);
});

test("configuration requires hashed tokens and prevents command/profile escape", () => {
  assert.throws(() => normalizeConfig({ piRpcApi: { auth: { tokens: [] }, profiles: {} } }), /non-empty array/);
  assert.throws(() => normalizeConfig(config({ auth: { tokens: [{ sha256: "plaintext", scopes: ["*"] }] } })), /SHA-256/);
  assert.throws(() => normalizeConfig(config({ allowedCommands: ["prompt", "switch_session"] })), /forbidden command/);
  assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "relative" } } })), /absolute path/);
  for (const argument of [
    "--continue", "-c", "--fork", "--mode=rpc", "--name", "-n", "--no-session",
    "--resume", "-r", "--session=other", "--session-id", "--session-id=other", "--session-dir=/tmp",
  ]) {
    assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "/workspace", args: [argument] } } })), /supervisor-owned/);
  }
  const referenced = config({
    auth: { tokens: [{ sha256Env: "PI_RPC_TOKEN_SHA256", scopes: ["sessions:read"] }] },
    profiles: { default: { cwd: "/workspace", envReferences: { API_TOKEN: "PROFILE_API_TOKEN" } } },
  });
  const normalized = normalizeConfig(referenced, {
    PI_RPC_TOKEN_SHA256: TOKEN_HASH,
    PROFILE_API_TOKEN: "runtime-secret",
  });
  assert.equal(normalized.tokens[0].digest.toString("hex"), TOKEN_HASH);
  assert.equal(normalized.profiles.get("default").env.API_TOKEN, "runtime-secret");
  assert.equal(JSON.stringify(referenced).includes("runtime-secret"), false);
  assert.throws(() => normalizeConfig(referenced, {}), /requires environment variable PI_RPC_TOKEN_SHA256/);
  assert.throws(() => normalizeConfig(config({
    auth: { tokens: [{ sha256Env: "PI_RPC_TOKEN_SHA256", scopes: ["sessions:read"] }] },
    profiles: { default: { cwd: "/workspace", envReferences: { LEAK: "PI_RPC_TOKEN_SHA256" } } },
  }), { PI_RPC_TOKEN_SHA256: TOKEN_HASH }), /must not expose an RPC authentication variable/);
});

test("configuration rejects unknown keys, scopes, and overlapping profile session directories", () => {
  const cases = [
    [() => { const value = config(); value.unknown = true; return value; }, /runtime config contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.unknown = true; return value; }, /piRpcApi contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.auth.unknown = true; return value; }, /piRpcApi.auth contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.auth.tokens[0].unknown = true; return value; }, /tokens\[0\] contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.profiles.default.unknown = true; return value; }, /profiles.default contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.limits.unknown = 1; return value; }, /limits contains unknown key unknown/],
  ];
  for (const [makeConfig, pattern] of cases) assert.throws(() => normalizeConfig(makeConfig()), pattern);
  assert.throws(() => normalizeConfig(config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["unknown"] }] } })), /unknown scope/);
  assert.throws(() => normalizeConfig(config({
    profiles: {
      first: { cwd: "/workspace", sessionDir: "/sessions" },
      second: { cwd: "/workspace", sessionDir: "/sessions/nested" },
    },
  })), /must not overlap/);
  assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "/workspace", sessionDir: "/sessions/../other" } } })), /must be normalized/);
});

test("raw token environment references are hashed and cannot leak to Pi children", () => {
  const cfg = config({ auth: { tokens: [{ tokenEnv: "WEB_PASSWORD", scopes: ALL_SCOPES }] } });
  const normalized = normalizeConfig(cfg, { WEB_PASSWORD: TOKEN });
  assert.equal(normalized.tokens[0].digest.toString("hex"), TOKEN_HASH);
  assert.equal(JSON.stringify(normalized).includes(TOKEN), false);
  assert.throws(() => normalizeConfig(cfg, {}), /requires a non-empty printable token/);
  assert.throws(() => normalizeConfig(cfg, { WEB_PASSWORD: "has spaces" }), /without whitespace/);
  cfg.piRpcApi.auth.tokens[0].sha256Env = "HASH";
  assert.throws(() => normalizeConfig(cfg), /exactly one/);
  delete cfg.piRpcApi.auth.tokens[0].sha256Env;
  cfg.piRpcApi.profiles.default.envReferences = { LEAK: "WEB_PASSWORD" };
  assert.throws(() => normalizeConfig(cfg, { WEB_PASSWORD: TOKEN }), /must not expose an RPC authentication variable/);
});

test("web assets are public and allowlisted without weakening API authentication or CSP", async (t) => {
  const { baseUrl } = await fixture(t);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Pi agent/);
  for (const asset of ["app.mjs", "transport.mjs", "markdown.mjs", "subagents.mjs", "sidebar.mjs", "attention.mjs", "tool-display.mjs", "styles.css", "icon.svg"]) {
    const response = await fetch(`${baseUrl}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    await response.arrayBuffer();
  }
  const head = await fetch(baseUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/runtime.mjs", "/history.mjs", "/web/README.md", "/browser-smoke.mjs", "/%2e%2e%2fruntime.mjs"]) {
    assert.equal((await request(baseUrl, path, { auth: false })).response.status, 404);
  }
  const api = await request(baseUrl, "/v1/sessions", { auth: false });
  assert.equal(api.response.status, 401);
  assert.equal(api.response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  const crossOrigin = await fetch(baseUrl, { headers: { Origin: "https://untrusted.example" } });
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.arrayBuffer();
});

test("history is scoped and restricted to a configured profile", async (t) => {
  const { baseUrl } = await fixture(t);
  assert.equal((await request(baseUrl, "/v1/history?profile=default", { auth: false })).response.status, 401);
  assert.equal((await request(baseUrl, "/v1/history?profile=../../etc")).response.status, 400);
  const result = await request(baseUrl, "/v1/history?profile=default");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { sessions: [], truncated: false });
  const limited = await fixture(t, config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["sessions:write"] }] } }));
  assert.equal((await request(limited.baseUrl, "/v1/history?profile=default")).response.status, 403);
});

test("new sessions own a native ID immediately and cannot be resumed concurrently", async (t) => {
  const { baseUrl, spawns, children } = await fixture(t, config({ profiles: {
    default: { cwd: "/workspace", sessionDir: "/sessions" },
    other: { cwd: "/workspace", sessionDir: "/other-sessions" },
  } }));
  const id = await createSession(baseUrl, { profile: "default", name: "UI session" });
  const meta = (await request(baseUrl, `/v1/sessions/${id}`)).body.session;
  assert.equal(meta.nativeSessionId, id);
  assert.equal(meta.name, "UI session");
  assert.equal(meta.cwd, "/workspace");
  assert.equal(meta.latestEventId, 1);
  assert.ok(spawns[0].args.includes("--session-id"));
  assert.equal(spawns[0].args[spawns[0].args.indexOf("--session-id") + 1], id);
  const duplicate = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: id } });
  assert.equal(duplicate.response.status, 409);
  const crossProfile = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "other", resume: id } });
  assert.equal(crossProfile.response.status, 409);
  children[0].output({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Approve?" });
  const answered = await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "confirm-1", confirmed: false } });
  assert.equal(answered.response.status, 202);
  const after = (await request(baseUrl, `/v1/sessions/${id}`)).body.session;
  assert.equal(after.latestEventId, 3);
  assert.deepEqual(after.pendingUi, []);
});

test("runtime resolves the configured executable to the immutable Nix store", () => {
  assert.throws(() => normalizeConfig(config({ executable: "pi" })), /absolute path/);
  assert.throws(() => createRuntime(config(), { spawn() {}, realpath: () => "/tmp/pi" }), /immutable Nix store path/);
  assert.throws(() => createRuntime(config(), { spawn() {}, realpath: () => { throw new Error("missing"); } }), /could not be resolved: missing/);
});

test("liveness and readiness are public and all responses receive security headers", async (t) => {
  const { baseUrl } = await fixture(t);
  const live = await request(baseUrl, "/health/live", { auth: false });
  assert.equal(live.response.status, 200);
  assert.deepEqual(live.body, { status: "alive" });
  const ready = await request(baseUrl, "/health/ready", { auth: false });
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body, { status: "ready" });
  assert.equal(ready.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ready.response.headers.get("x-frame-options"), "DENY");
  assert.equal(ready.response.headers.get("cache-control"), "no-store");
  const obsolete = await request(baseUrl, "/health", { auth: false });
  assert.equal(obsolete.response.status, 404);

  const missing = await request(baseUrl, "/v1/profiles", { auth: false });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.response.headers.get("www-authenticate"), 'Bearer realm="pi-rpc-runtime"');
  const wrong = await request(baseUrl, "/v1/profiles", { token: "wrong" });
  assert.equal(wrong.response.status, 401);
});

test("scopes and browser origins are enforced", async (t) => {
  const limited = "write-token";
  const cfg = config({
    auth: { tokens: [{ sha256: createHash("sha256").update(limited).digest("hex"), scopes: ["sessions:write"] }] },
  });
  const { baseUrl } = await fixture(t, cfg);
  const denied = await request(baseUrl, "/v1/profiles", { token: limited });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, "insufficient_scope");

  const originDenied = await request(baseUrl, "/health/ready", { auth: false, headers: { Origin: "https://evil.example" } });
  assert.equal(originDenied.response.status, 403);
  const originAllowed = await request(baseUrl, "/health/ready", { auth: false, headers: { Origin: "https://client.example" } });
  assert.equal(originAllowed.response.headers.get("access-control-allow-origin"), "https://client.example");
});

test("session creation uses an isolated environment and exact profile-owned resume IDs", async (t) => {
  process.env.RUNTIME_SECRET_LEAK = "must-not-reach-child";
  t.after(() => { delete process.env.RUNTIME_SECRET_LEAK; });
  const directory = await mkdtemp(join(tmpdir(), "pi-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, `2026-09-09_${RESUME_ID}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "session", id: RESUME_ID, cwd: "/workspace" })}\n`);
  const { baseUrl, spawns } = await fixture(t, config({ profiles: { default: {
    cwd: "/workspace", sessionDir: directory, args: ["--approve"], env: { PROFILE_VALUE: "yes" },
  } } }));
  const invalid = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: "../../secret" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(spawns.length, 0);

  const partial = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: "abc-123" },
  });
  assert.equal(partial.response.status, 400);

  const id = await createSession(baseUrl, { profile: "default", resume: RESUME_ID, name: "Review" });
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, "/nix/store/00000000000000000000000000000000-pi/bin/pi");
  assert.deepEqual(spawns[0].args, [
    "--mode", "rpc", "--session-dir", directory, "--session", file, "--name", "Review", "--approve",
  ]);
  assert.equal(spawns[0].options.cwd, "/workspace");
  assert.deepEqual(spawns[0].options.env, {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    XDG_CACHE_HOME: "/home/agent/.cache",
    USER: "agent",
    LOGNAME: "agent",
    SHELL: "/bin/bash",
    PATH: "/run/wrappers/bin:/home/agent/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/home/agent/.local/bin:/home/agent/.bun/bin:/home/agent/.cargo/bin:/bin:/usr/bin:/usr/local/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/tmp",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    PROFILE_VALUE: "yes",
  });
  assert.deepEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawns[0].options.detached, process.platform !== "win32");

  const duplicate = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: RESUME_ID },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(spawns.length, 1);
});

test("unknown resume IDs fail before spawning and concurrent resumes are reserved", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-resume-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { baseUrl, spawns } = await fixture(t, config({ profiles: { default: { cwd: "/workspace", sessionDir: directory } } }));
  const options = { method: "POST", body: { profile: "default", resume: RESUME_ID } };
  assert.equal((await request(baseUrl, "/v1/sessions", options)).response.status, 404);
  assert.equal(spawns.length, 0);
  await writeFile(join(directory, `${RESUME_ID}.jsonl`), `${JSON.stringify({ type: "session", id: RESUME_ID, cwd: "/workspace" })}\n`);
  const results = await Promise.all([request(baseUrl, "/v1/sessions", options), request(baseUrl, "/v1/sessions", options)]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
  assert.equal(spawns.length, 1);
});

test("large read snapshots stay out of SSE replay even when larger than the ring", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({
    allowedCommands: ["get_messages"], limits: { maxRecordBytes: 256 * 1024, maxEventBytes: 1024 },
  }));
  const id = await createSession(baseUrl);
  const reading = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "snapshot" } });
  await waitForInput(children[0], /snapshot/);
  children[0].output({ id: "snapshot", type: "response", command: "get_messages", success: true, data: { messages: [{ role: "user", content: "x".repeat(128 * 1024) }] } });
  assert.equal((await reading).response.status, 200);
  const session = runtime.sessions.get(id);
  assert.equal(session.events.nextId, 2);
  assert.equal(session.events.records.length, 1);
  assert.equal(session.events.records[0].id, 1);
});

test("oversized correlated reads drain without killing Pi and subsequent RPC still works", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({ allowedCommands: ["get_messages", "get_state"] }));
  const id = await createSession(baseUrl);
  const child = children[0];
  const reading = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "oversized" } });
  await waitForInput(child, /oversized/);
  child.stdout.write('{"id":"oversized","type":"response","command":"get_messages","success":true,"data":{"messages":["');
  child.stdout.write("x".repeat(2048));
  const result = await reading;
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "snapshot_too_large");
  child.stdout.write("x".repeat(8192));
  child.stdout.write('"]}}\n');
  assert.equal(runtime.sessions.get(id).status, "running");
  assert.deepEqual(child.signals, []);
  const state = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state", id: "after-large" } });
  await waitForInput(child, /after-large/);
  child.output({ id: "after-large", type: "response", command: "get_state", success: true, data: {} });
  assert.equal((await state).response.status, 200);
});

test("timed-out oversized reads retain bounded correlation and do not kill Pi", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({
    allowedCommands: ["get_messages", "get_state", "abort"],
    limits: { maxPendingCommands: 1, commandTimeoutMs: 30 },
  }));
  const id = await createSession(baseUrl), child = children[0];
  const result = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "late" } });
  assert.equal(result.response.status, 504);
  assert.equal(runtime.sessions.get(id).lateReads.size, 1);
  const more = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state" } });
  assert.equal(more.response.status, 429);
  child.stdout.write(`{"id":"late","type":"response","command":"get_messages","success":true,"data":{"messages":["${"x".repeat(4096)}"]}}\n`);
  assert.equal(runtime.sessions.get(id).status, "running");
  assert.equal(runtime.sessions.get(id).lateReads.size, 0);
  const state = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state", id: "recovered" } });
  await waitForInput(child, /recovered/);
  child.output({ id: "recovered", type: "response", command: "get_state", success: true, data: {} });
  assert.equal((await state).response.status, 200);
  assert.deepEqual(child.signals, []);
});

test("shutdown detaches backpressured streams before Pi emits its final events", async (t) => {
  const { baseUrl, runtime } = await fixture(t);
  const id = await createSession(baseUrl), session = runtime.sessions.get(id);
  const client = new EventEmitter();
  client.writableLength = 100;
  client.writableEnded = false;
  client.destroyed = false;
  client.write = () => { assert.equal(client.writableEnded, false); return false; };
  client.end = () => { client.writableEnded = true; client.emit("finish"); };
  client.destroy = () => { client.destroyed = true; client.emit("close"); };
  session.addSseClient(client, 0);
  await runtime.close();
  assert.equal(client.writableEnded, true);
  assert.equal(session.clients.size, 0);
  assert.equal(session.writeSse(client, ": cannot write after end\n\n"), false);
});

test("idle SSE subscriptions send body bytes immediately without advancing the replay cursor", async (t) => {
  const { baseUrl, runtime } = await fixture(t, config({ limits: { sseHeartbeatMs: 60_000 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  const cursor = session.metadata().latestEventId;
  assert.equal(cursor, 1);
  // There is nothing to replay. Both initial attachment and reconnection must
  // yield a body without waiting for Pi activity or the periodic heartbeat.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${baseUrl}/v1/sessions/${id}/events?after=${cursor}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), ": connected\n\n");
      assert.equal(session.metadata().latestEventId, cursor);
      assert.equal(session.events.records.length, 1);
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
});

test("SSE tolerates ordinary write backpressure and bounds a stalled client's buffer", async (t) => {
  const { baseUrl, runtime } = await fixture(t, config({ limits: { maxRecordBytes: 256 * 1024, maxEventBytes: 256 * 1024 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  session.publish({ type: "message_end", message: { content: "x".repeat(128 * 1024) } });
  const client = new EventEmitter();
  client.writableLength = 0;
  client.destroyed = false;
  client.end = () => { throw new Error("backpressure must not end the stream"); };
  client.destroy = () => { client.destroyed = true; client.emit("close"); };
  const frames = [];
  client.write = (data) => { frames.push(data); client.writableLength += Buffer.byteLength(data); return false; };
  session.addSseClient(client, 0);
  assert.equal(session.clients.has(client), true);
  assert.equal(client.destroyed, false);
  assert.equal(frames[0], ": connected\n\n");
  assert.equal(frames.length, 3);
  // Model a drain, then verify live delivery remains connected.
  client.writableLength = 0;
  session.publish({ type: "agent_end" });
  assert.equal(frames.length, 4);
  assert.equal(client.destroyed, false);
  client.writableLength = 512 * 1024;
  session.publish({ type: "agent_start" });
  assert.equal(client.destroyed, true);
  assert.equal(session.clients.has(client), false);
});

test("resume is disabled without a profile-owned session directory", async (t) => {
  const cfg = config({ profiles: { default: { cwd: "/workspace" } } });
  const { baseUrl, spawns } = await fixture(t, cfg);
  const result = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: RESUME_ID },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "invalid_resume");
  assert.equal(spawns.length, 0);
});

test("read RPC commands require read scope and mutating commands require write scope", async (t) => {
  const readToken = "read-token";
  const writeToken = "write-token";
  const cfg = config({
    auth: {
      tokens: [
        { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
        { sha256: createHash("sha256").update(readToken).digest("hex"), scopes: ["sessions:read"] },
        { sha256: createHash("sha256").update(writeToken).digest("hex"), scopes: ["sessions:write"] },
      ],
    },
  });
  const { baseUrl, children } = await fixture(t, cfg);
  const id = await createSession(baseUrl);

  const writeRead = await request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: writeToken, body: { type: "get_state" },
  });
  assert.equal(writeRead.response.status, 403);
  assert.equal(children[0].input, "");

  const readPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: readToken, body: { type: "get_state" },
  });
  await waitForInput(children[0], /"type":"get_state"/);
  const readCommand = JSON.parse(children[0].input.trim());
  children[0].output({ type: "response", id: readCommand.id, command: "get_state", success: true });
  assert.equal((await readPromise).response.status, 200);

  const readWrite = await request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: readToken, body: { type: "prompt", message: "hello" },
  });
  assert.equal(readWrite.response.status, 403);
});

test("allowed commands use LF JSON framing and correlated responses", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  const responsePromise = request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST",
    body: { id: "client-1", type: "get_state" },
  });
  await waitForInput(children[0], /\n$/);
  assert.equal(children[0].input, '{"id":"client-1","type":"get_state"}\n');
  children[0].stdout.write('{"type":"response","id":"client-1","command":"get_state",');
  children[0].stdout.write('"success":true}\n');
  const result = await responsePromise;
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { type: "response", id: "client-1", command: "get_state", success: true });

  const generatedPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "abort" } });
  await waitForInput(children[0], /"type":"abort","id":"runtime-/);
  const generated = JSON.parse(children[0].input.trim().split("\n").at(-1));
  children[0].output({ type: "response", id: generated.id, command: "abort", success: true });
  const generatedResult = await generatedPromise;
  assert.equal("id" in generatedResult.body, false);
});

test("forbidden and unknown commands never reach Pi", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  const before = children[0].input;
  for (const type of ["bash", "switch_session", "not_a_command"]) {
    const result = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type } });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "command_forbidden");
  }
  assert.equal(children[0].input, before);
});

test("strict LF records preserve Unicode separators and protocol faults kill the child", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  children[0].output({ type: "notice", text: "one\u2028two\u2029three" }, "\r\n");
  await new Promise((resolve) => setImmediate(resolve));
  const details = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(details.body.session.status, "running");

  children[0].stdout.write("not-json\n");
  await once(children[0], "exit");
  assert.deepEqual(children[0].signals, ["SIGKILL"]);
  const failed = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(failed.body.session.status, "failed");
  assert.ok(failed.body.session.exit);
});

test("stderr and event history are bounded and SSE reports replay gaps", async (t) => {
  const cfg = config({ limits: { maxEvents: 2, maxEventBytes: 1024, maxStderrBytes: 1024 } });
  const { baseUrl, children } = await fixture(t, cfg);
  const id = await createSession(baseUrl);
  children[0].stderr.write(`discard-${"x".repeat(1100)}-tail`);
  children[0].output({ type: "event", n: 1 });
  children[0].output({ type: "event", n: 2 });
  children[0].output({ type: "event", n: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  const details = await request(baseUrl, `/v1/sessions/${id}`);
  assert.ok(Buffer.byteLength(details.body.session.stderr) <= 1024 + 3);
  assert.match(details.body.session.stderr, /-tail$/);

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/v1/sessions/${id}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const { value } = await stream.body.getReader().read();
  const replay = new TextDecoder().decode(value);
  assert.match(replay, /event: reset/);
  assert.match(replay, /oldestEventId/);
  assert.match(replay, /"n":3/);
  assert.doesNotMatch(replay, /"n":1/);
  controller.abort();
});

test("extension dialogs only accept method-correct, single-use responses", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  children[0].output({ type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A", "B"] });
  await new Promise((resolve) => setImmediate(resolve));

  const invalid = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "C" },
  });
  assert.equal(invalid.response.status, 400);
  const ambiguous = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "B", confirmed: true },
  });
  assert.equal(ambiguous.response.status, 400);
  const accepted = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "B" },
  });
  assert.equal(accepted.response.status, 202);
  assert.match(children[0].input, /{"type":"extension_ui_response","id":"select-1","value":"B"}\n$/);
  const replay = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "A" },
  });
  assert.equal(replay.response.status, 404);

  children[0].output({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Wait", timeout: 20 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expired = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "confirm-1", confirmed: true },
  });
  assert.equal(expired.response.status, 404);
});

test("child approvals show parent-owned identity and route single-use responses", async (t) => {
  const { baseUrl, children, runtime } = await fixture(t);
  const id = await createSession(baseUrl);
  const owner = { version: 1, toolCallId: "task-call", taskId: "pi-workflow-child", role: "scout", requestId: "approval-id" };
  children[0].output({ type: "extension_ui_request", id: "child-dialog", method: "select", title: `Pi child approval ${JSON.stringify(owner)}\nread: README.md`, options: ["Allow once", "Deny"], timeout: 1000 });
  const { body } = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(body.session.pendingUi[0].title, "Approve subagent scout?");
  assert.equal(body.session.pendingUi[0].message, "pi-workflow-child\nread: README.md");
  assert.equal(body.session.pendingUi[0].timeout, 1000);
  const accepted = await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "child-dialog", value: "Allow once" } });
  assert.equal(accepted.response.status, 202);
  assert.match(children[0].input, /"id":"child-dialog","value":"Allow once"/);
  assert.equal(runtime.sessions.get(id).pendingUi.size, 0);
  assert.equal((await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "child-dialog", value: "Allow once" } })).response.status, 404);
});

test("child approval cancellation and task completion expire only matching dialogs", async (t) => {
  const { baseUrl, children, runtime } = await fixture(t, config({ limits: { maxPendingUi: 4 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  for (const [dialog, toolCallId, taskId] of [["a", "parent-a", "child-a"], ["b", "parent-a", "child-b"], ["c", "parent-b", "child-a"]]) {
    const owner = { version: 1, toolCallId, taskId, role: "scout", requestId: `request-${dialog}` };
    children[0].output({ type: "extension_ui_request", id: dialog, method: "select", title: `Pi child approval ${JSON.stringify(owner)}\nread: README.md`, options: ["Allow once", "Deny"], timeout: 60_000 });
  }
  children[0].output({ type: "extension_ui_request", id: "ordinary", method: "select", title: "Choose", options: ["Allow once", "Deny"] });
  children[0].output({ type: "tool_execution_update", toolCallId: "parent-a", partialResult: { details: { jobs: [{ taskId: "child-a", approvalClosed: "request-c" }] } } });
  assert.equal(session.pendingUi.size, 4, "a wrong request ID never cancels another child");
  children[0].output({ type: "tool_execution_update", toolCallId: "parent-a", partialResult: { details: { jobs: [{ taskId: "child-a", approvalClosed: "request-a" }] } } });
  assert.deepEqual([...session.pendingUi.keys()], ["b", "c", "ordinary"]);
  assert.equal((await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "a", value: "Allow once" } })).response.status, 404);
  children[0].output({ type: "tool_execution_end", toolCallId: "parent-a" });
  assert.deepEqual([...session.pendingUi.keys()], ["c", "ordinary"]);
  const expired = session.events.records.map((event) => JSON.parse(event.data)).filter((event) => event.event === "extension_ui_expired");
  assert.deepEqual(expired.map((event) => event.id), ["a", "b"]);
});

test("body, session, pending-command, and timeout limits are enforced", async (t) => {
  const cfg = config({
    limits: { maxSessions: 1, maxBodyBytes: 1024, maxPendingCommands: 1, commandTimeoutMs: 30 },
  });
  const { baseUrl } = await fixture(t, cfg);
  const oversized = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: `{"profile":"default","padding":"${"x".repeat(1100)}"}`,
  });
  assert.equal(oversized.response.status, 413);
  const id = await createSession(baseUrl);
  const second = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } });
  assert.equal(second.response.status, 429);

  const firstPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { id: "wait", type: "get_state" } });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { id: "other", type: "get_state" } });
  assert.equal(pending.response.status, 429);
  const timedOut = await firstPromise;
  assert.equal(timedOut.response.status, 504);
});

test("exited sessions do not consume the active session quota", async (t) => {
  const cfg = config({ limits: { maxSessions: 1 } });
  const { baseUrl, children, spawns } = await fixture(t, cfg);
  await createSession(baseUrl);
  children[0].exited = true;
  children[0].emit("exit", 0, null);
  await createSession(baseUrl);
  assert.equal(spawns.length, 2);
});

test("termination signals the detached child process group when available", async (t) => {
  const groupSignals = [];
  let child;
  const { baseUrl, children } = await fixture(t, config(), {
    signalProcessGroup(pid, signal) {
      groupSignals.push({ pid, signal });
      child.kill(signal);
    },
  });
  const id = await createSession(baseUrl);
  child = children[0];
  child.pid = 4242;
  await request(baseUrl, `/v1/sessions/${id}`, { method: "DELETE" });
  assert.deepEqual(groupSignals, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("runtime supervisor bounds logs and stops a crash loop", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rpc-supervisor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimePath = join(directory, "runtime.sh");
  const countPath = join(directory, "count");
  const logPath = join(directory, "runtime.log");
  const bash = process.env.TEST_BASH ?? "/bin/bash";
  await writeFile(runtimePath, `#!${bash}\nprintf x >> ${JSON.stringify(countPath)}\nprintf '%s\\n' '${"x".repeat(2048)}'\nexit 7\n`);
  await chmod(runtimePath, 0o755);
  const result = spawnSync(bash, [new URL("../supervise.sh", import.meta.url).pathname], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PI_RPC_RUNTIME_EXECUTABLE: runtimePath,
      PI_RPC_LOG_FILE: logPath,
      PI_RPC_MAX_LOG_BYTES: "1024",
      PI_RPC_MAX_CRASHES: "3",
      PI_RPC_STABLE_SECONDS: "60",
      PI_RPC_INITIAL_BACKOFF_SECONDS: "0",
      PI_RPC_MAX_BACKOFF_SECONDS: "0",
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(await readFile(countPath, "utf8"), "xxx");
  assert.ok((await stat(logPath)).size <= 1024);
  assert.match(await readFile(logPath, "utf8"), /giving up$/m);
});

test("idle cleanup and graceful close terminate every child", async (t) => {
  let currentTime = 1_000;
  const cfg = config({
    limits: { idleTimeoutMs: 100, cleanupIntervalMs: 50, shutdownGraceMs: 10, killGraceMs: 10 },
  });
  const { runtime, baseUrl, children } = await fixture(t, cfg, { now: () => currentTime });
  await createSession(baseUrl);
  currentTime = 2_000;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runtime.sessions.size, 0);
  assert.match(children[0].input, /{"type":"abort"}\n/);

  await createSession(baseUrl);
  await runtime.close();
  assert.equal(runtime.sessions.size, 0);
  assert.equal(children.every((child) => child.exited), true);
});

test("LF parser rejects overlong unterminated records", async () => {
  const stream = new PassThrough();
  const errors = [];
  internals.attachLfJsonReader(stream, 8, () => assert.fail("record should not parse"), (error) => errors.push(error));
  stream.write("123456789");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unterminated record/);
});
